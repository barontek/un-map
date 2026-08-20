/* UN map - Leaflet app
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
  nogroup:   { label: 'Non-Member State', color: '#adadad' },
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

function flagEmoji(iso2) {
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) return '';
  return iso2.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Only member states get flag emojis; others (nogroup, disputed, ...) don't.
const MEMBER_STATUSES = ['p5', 'sc', 'normal', 'observer'];
const isMember = (status) => MEMBER_STATUSES.includes(status);
const flagFor = (feature) => (isMember(feature.properties.status) ? flagEmoji(feature.properties.iso2) : '');

// ---- Tiny countries (sub-pixel polygons) render as clickable flag markers ----
const TINY_AREA = 10;
let tinyMarkers = null;
const tinyIndex = {};   // id -> { feature, marker }

function ringAreaOf(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function geomArea(geom) {
  const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  return rings.reduce((s, r) => s + ringAreaOf(r), 0);
}

function geomCentroid(geom) {
  let sx = 0, sy = 0, n = 0;
  const push = (ring) => ring.forEach(([x, y]) => { sx += x; sy += y; n++; });
  if (geom.type === 'Polygon') geom.coordinates.forEach(push);
  else geom.coordinates.forEach((p) => p.forEach(push));
  return n ? [sx / n, sy / n] : [IMG_W / 2, IMG_H / 2];
}

// Anchor point for a tiny country's marker. For a MultiPolygon spread across
// the map (e.g. Kiribati), a plain centroid lands in the wrong ocean/country,
// so anchor on the centroid of the largest polygon part instead.
function geomAnchor(geom) {
  if (geom.type !== 'MultiPolygon') return geomCentroid(geom);
  let best = null, bestArea = -1;
  geom.coordinates.forEach((poly) => {
    const a = ringAreaOf(poly[0]);
    if (a > bestArea) { bestArea = a; best = poly[0]; }
  });
  if (best) {
    let sx = 0, sy = 0;
    best.forEach(([x, y]) => { sx += x; sy += y; });
    return [sx / best.length, sy / best.length];
  }
  return geomCentroid(geom);
}

function buildTinyMarkers(features) {
  const layer = L.layerGroup();
  features.forEach((f) => {
    const [x, y] = geomAnchor(f.geometry);
    const flag = flagFor(f);
    const icon = L.divIcon({
      className: 'tiny-marker',
      html: `<span>${flag || '•'}</span>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const m = L.marker([y, x], { icon });
    m.bindTooltip(`${flag ? flag + ' ' : ''}${f.properties.name}`, { className: 'country-label', sticky: true });
    m.on('click', () => selectTiny(f, m));
    layer.addLayer(m);
    tinyIndex[f.properties.id] = { feature: f, marker: m };
    countryIndex[f.properties.id] = f;
    countryIndex[f.properties.name] = f;
  });
  return layer;
}

function selectTiny(feature) {
  clearSelection();
  showPanel(feature);
  location.hash = '#' + encodeURIComponent(feature.properties.id);
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
      layer.bindTooltip(`${flagFor(feature)} ${p.name}`.trim(), { className: 'country-label', sticky: true }).openTooltip();
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
    const d = dimmed(st);
    if (l === selectedLayer) {
      // dim the selected country too when it doesn't match the filter
      if (d) l.setStyle(layerStyle(l.feature.properties, true));
      else l.setStyle({ fillColor: STATUS_META[st]?.color || '#888', fillOpacity: 0.55, color: '#fff', weight: 2 });
    } else {
      l.setStyle(layerStyle(l.feature.properties, d));
    }
  });
  Object.values(tinyIndex).forEach(({ feature, marker }) => {
    marker.setOpacity(dimmed(feature.properties.status) ? 0.25 : 1);
  });
}

function applyView() {
  const showPng = pngVisible && !pixelOn;
  const mapEl = document.getElementById('map');
  mapEl.style.background = showPng ? '#123' : '#ffffff';   // white ocean in SVG view
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
  const title = document.getElementById('panel-title');
  if (title) {
    title.textContent = '';
    const flag = flagFor(feature);
    title.appendChild(document.createTextNode(flag ? flag + ' ' : ''));
    title.appendChild(document.createTextNode(p.name));
  }
  const body = document.getElementById('panel-body');
  if (body) body.innerHTML = `<span class="badge" style="background:${meta.color}">${meta.label}</span>`;
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
    const tinyFeatures = [];
    const polyFeatures = [];
    data.features.forEach((f) => {
      if (geomArea(f.geometry) < TINY_AREA) tinyFeatures.push(f);
      else polyFeatures.push(f);
    });
    const polyData = { ...data, features: polyFeatures };
    countryLayer = smoothLayer = L.geoJSON(polyData, { style: (f) => styleFor(f.properties.status, false), onEachFeature }).addTo(map);
    const pixData = { ...polyData, features: polyFeatures.map((f) => ({ ...f, geometry: snapGeom(f.geometry, 1) })) };
    pixelLayer = L.geoJSON(pixData, { style: (f) => pixelStyle(f.properties.status), onEachFeature });
    tinyMarkers = buildTinyMarkers(tinyFeatures).addTo(map);
    applyView();
    loadingEl.classList.add('hidden');
    handleHash();   // honor an initial #/country deep link once
  });

search.addEventListener('change', () => {
  const n = search.value;
  search.value = '';
  if (!n) return;
  const f = countryIndex[n];
  if (!f) return;
  const layer = findLayer(f.properties.id);
  if (layer) {
    selectCountry(layer, f);
  } else if (tinyIndex[f.properties.id]) {
    selectTiny(f);
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
    selectCountry(layer, f);
  } else if (tinyIndex[f.properties.id]) {
    selectTiny(f);
  }
}
window.addEventListener('hashchange', handleHash);
