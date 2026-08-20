/* UN RP map - Leaflet app
 * Coordinate space: the PNG (2753x1399) is the map. GeoJSON country coordinates
 * are in PNG pixel units [x, y] via Leaflet CRS.Simple.
 */

const IMG_W = 2753;
const IMG_H = 1399;

const STATUS_META = {
  p5:        { label: 'Permanent 5', color: '#00278b' },
  sc:        { label: 'Security Council', color: '#0156a6' },
  normal:    { label: 'Member State', color: '#4190de' },
  observer:  { label: 'Observer', color: '#22b14c' },
  disputed:  { label: 'Disputed', color: '#c80915' },
  suspended: { label: 'Suspended', color: '#232323' },
  nogroup:   { label: 'No Roblox Group', color: '#adadad' },
  unknown:   { label: 'Not on map', color: '#d8dde4' },
};

const map = L.map('map', {
  crs: L.Util.extend({}, L.CRS.Simple, {
    // CRS.Simple's default transformation is (1, 0, -1, 0) which flips y and
    // renders the image upside down. Use (1, 0, 1, 0) so image y=0 is the top.
    transformation: new L.Transformation(1, 0, 1, 0),
  }),
  minZoom: 0,
  maxZoom: 5,
  zoomControl: true,
  attributionControl: false,
  maxBounds: [[-50, -50], [IMG_H + 50, IMG_W + 50]],
}).setView([IMG_H / 2, IMG_W / 2], 0);

// Fit image with a little padding so world edges aren't glued to viewport edge
map.fitBounds([[0, 0], [IMG_H, IMG_W]], { padding: [40, 40] });

const pngOverlay = L.imageOverlay('map.png', [[0, 0], [IMG_H, IMG_W]], {
  className: 'map-img',
}).addTo(map);

let countryLayer = null;
let countryIndex = {}; // id/name -> feature
let activeStatus = null;
let selectedLayer = null;
let pngVisible = true;
let smoothOn = true;
let pixelOn = false;

let rawData = null;
let smoothLayer = null;
let pixelLayer = null;

const panel = document.getElementById('panel');
const loadingEl = document.getElementById('loading');
const statsEl = document.getElementById('stats');

function styleFor(status, dim) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  if (dim) {
    return { fillColor: '#222', fillOpacity: 0.35, color: '#444', weight: 0.5 };
  }
  return {
    fillColor: meta.color,
    fillOpacity: pngVisible ? 0.18 : 0.6,
    color: 'rgba(0,0,0,0)',
    weight: 1,
  };
}

// Pixelated look: solid fill + white 1px borders, matching the raster PNG.
function pixelStyle(status, dim) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  if (dim) {
    return { fillColor: '#222', fillOpacity: 0.3, color: '#444', weight: 0.5 };
  }
  return { fillColor: meta.color, fillOpacity: 0.92, color: '#ffffff', weight: 1 };
}

function layerStyle(props, dim) {
  return pixelOn ? pixelStyle(props.status, dim) : styleFor(props.status, dim);
}

// Snap every vertex to an integer pixel grid so borders become blocky like the
// PNG. If a ring would collapse (thin islands), keep its original coordinates.
function snapGeom(geom, grid) {
  const snap = (v) => Math.round(v / grid) * grid;
  const snapRing = (ring) => {
    const snapped = ring.map(([x, y]) => [snap(x), snap(y)]);
    const uniq = new Set(snapped.map(([x, y]) => x + ',' + y));
    return uniq.size >= 3 ? snapped : ring;
  };
  if (geom.type === 'Polygon') {
    return { ...geom, coordinates: geom.coordinates.map(snapRing) };
  }
  if (geom.type === 'MultiPolygon') {
    return { ...geom, coordinates: geom.coordinates.map((poly) => poly.map(snapRing)) };
  }
  return geom;
}

function onEachFeature(feature, layer) {
  const p = feature.properties;
  countryIndex[p.id] = feature;
  countryIndex[p.name] = feature;
  layer.on({
    click: () => selectCountry(layer, feature),
    mouseover: () => {
      if (selectedLayer !== layer) {
        layer.setStyle({ fillOpacity: 0.45, color: '#ffffff', weight: 1.5 });
        layer.bringToFront();
      }
      layer.bindTooltip(p.name, { className: 'country-label', sticky: true }).openTooltip();
    },
    mouseout: () => {
      layer.closeTooltip();
      if (selectedLayer !== layer) layer.setStyle(layerStyle(p, dimmed(p.status)));
    },
  });
}

function dimmed(status) {
  return activeStatus !== null && status !== activeStatus;
}

function clearSelection() {
  if (selectedLayer) {
    selectedLayer.setStyle(layerStyle(selectedLayer.feature.properties, false));
    selectedLayer = null;
  }
  panel.classList.remove('open');
}

function reloadStyles() {
  if (!countryLayer) return;
  countryLayer.eachLayer((l) => {
    const st = l.feature.properties.status;
    if (l !== selectedLayer) l.setStyle(layerStyle(l.feature.properties, dimmed(st)));
  });
}

function applyView() {
  const showPng = pngVisible && !pixelOn;
  if (showPng && !map.hasLayer(pngOverlay)) map.addLayer(pngOverlay);
  if (!showPng && map.hasLayer(pngOverlay)) map.removeLayer(pngOverlay);

  const showSmooth = smoothOn && !pixelOn;
  if (smoothLayer) {
    if (showSmooth && !map.hasLayer(smoothLayer)) map.addLayer(smoothLayer);
    if (!showSmooth && map.hasLayer(smoothLayer)) map.removeLayer(smoothLayer);
  }
  if (pixelLayer) {
    if (pixelOn && !map.hasLayer(pixelLayer)) map.addLayer(pixelLayer);
    if (!pixelOn && map.hasLayer(pixelLayer)) map.removeLayer(pixelLayer);
  }
  countryLayer = pixelOn ? pixelLayer : smoothLayer;
  clearSelection();
  reloadStyles();
  document.getElementById('toggle-png').classList.toggle('active', pngVisible && !pixelOn);
  document.getElementById('toggle-svg').classList.toggle('active', smoothOn && !pixelOn);
  document.getElementById('toggle-pixel').classList.toggle('active', pixelOn);
}

function selectCountry(layer, feature) {
  if (selectedLayer) selectedLayer.setStyle(layerStyle(selectedLayer.feature.properties, false));
  selectedLayer = layer;
  layer.setStyle({ fillColor: STATUS_META[feature.properties.status]?.color || '#888', fillOpacity: 0.55, color: '#fff', weight: 2 });
  layer.bringToFront();
  showPanel(feature);
  location.hash = '#' + encodeURIComponent(feature.properties.id);
}

function showPanel(feature) {
  const p = feature.properties;
  const meta = STATUS_META[p.status] || STATUS_META.unknown;
  panel.classList.add('open');
  document.getElementById('panel-title').textContent = p.name;
  document.getElementById('panel-body').innerHTML =
    `<span class="badge" style="background:${meta.color}">${meta.label}</span>` +
    `<div>Status: <b>${p.status}</b></div>`;
  document.getElementById('panel-id').textContent = 'id: ' + p.id;
}

document.getElementById('panel-close').addEventListener('click', () => {
  panel.classList.remove('open');
  if (selectedLayer) {
    selectedLayer.setStyle(layerStyle(selectedLayer.feature.properties, false));
    selectedLayer = null;
  }
});

// Legend filter
document.querySelectorAll('.legend-item').forEach((el) => {
  el.addEventListener('click', () => {
    const st = el.dataset.status;
    activeStatus = activeStatus === st ? null : st;
    document.querySelectorAll('.legend-item').forEach((i) => i.classList.toggle('active', i.dataset.status === activeStatus));
    reloadStyles();
  });
});

// Search
const search = document.getElementById('search');
fetch('data/countries.geojson')
  .then((r) => r.json())
  .then((data) => {
    // stats summary
    const counts = {};
    data.features.forEach((f) => {
      const st = f.properties.status || 'unknown';
      counts[st] = (counts[st] || 0) + 1;
    });
    statsEl.textContent = [
      `P5 ${counts.p5 || 0}`,
      `SC ${counts.sc || 0}`,
      `Members ${counts.normal || 0}`,
      `No group ${counts.nogroup || 0}`,
    ].join(' · ');

    const names = data.features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b));
    names.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      search.appendChild(opt);
    });
    countryLayer = smoothLayer = L.geoJSON(data, { style: (f) => styleFor(f.properties.status, false), onEachFeature }).addTo(map);
    const pixData = { ...data, features: data.features.map((f) => ({ ...f, geometry: snapGeom(f.geometry, 1) })) };
    pixelLayer = L.geoJSON(pixData, { style: (f) => pixelStyle(f.properties.status), onEachFeature });
    applyView();
    loadingEl.classList.add('hidden');
  });

search.addEventListener('change', () => {
  const n = search.value;
  search.value = '';
  if (!n) return;
  const f = countryIndex[n];
  if (!f) return;
  const layer = findLayer(f.properties.id);
  if (layer) {
    map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 3 });
    selectCountry(layer, f);
  }
});

function findLayer(id) {
  let out = null;
  countryLayer.eachLayer((l) => {
    if (l.feature.properties.id === id) out = l;
  });
  return out;
}

// Reset view
document.getElementById('btn-reset').addEventListener('click', () => {
  map.fitBounds([[0, 0], [IMG_H, IMG_W]], { padding: [40, 40] });
});

// PNG background toggle
document.getElementById('toggle-png').addEventListener('click', () => {
  pngVisible = !pngVisible;
  applyView();
});

// Countries (smooth SVG data) toggle
document.getElementById('toggle-svg').addEventListener('click', () => {
  smoothOn = !smoothOn;
  applyView();
});

// Pixelated vector mode (looks like the PNG, no PNG needed)
document.getElementById('toggle-pixel').addEventListener('click', () => {
  pixelOn = !pixelOn;
  applyView();
});

// Esc closes panel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    panel.classList.remove('open');
    if (selectedLayer) {
      selectedLayer.setStyle(layerStyle(selectedLayer.feature.properties, false));
      selectedLayer = null;
    }
  }
});

// Markers
fetch('data/markers.json')
  .then((r) => r.json())
  .then((data) => {
    const icon = L.divIcon({ className: 'marker-dot', html: '<div class="dot"></div>', iconSize: [10, 10] });
    L.geoJSON(data, {
      pointToLayer: (f, latlng) => L.marker(latlng, { icon }),
      onEachFeature: (f, l) => {
        const p = f.properties || {};
        l.bindPopup(`<b>${p.title || 'Marker'}</b>${p.description ? '<br>' + p.description : ''}`);
      },
    }).addTo(map);
  })
  .catch(() => {});

// Deep link
function handleHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h || !countryLayer) return;
  const f = countryIndex[h];
  if (!f) return;
  const layer = findLayer(f.properties.id);
  if (layer) {
    map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 3 });
    selectCountry(layer, f);
  }
}
window.addEventListener('hashchange', handleHash);
setInterval(() => { if (countryLayer) handleHash(); }, 300);
