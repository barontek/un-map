/* UN RP map editor - Leaflet + Leaflet.draw
 * Same coordinate space as the main site: PNG pixel units [x, y], CRS.Simple no-y-flip.
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
  crs: L.Util.extend({}, L.CRS.Simple, { transformation: new L.Transformation(1, 0, 1, 0) }),
  minZoom: 0,
  maxZoom: 5,
  zoomControl: true,
  attributionControl: false,
});
map.setView([IMG_H / 2, IMG_W / 2], 0);
map.fitBounds([[0, 0], [IMG_H, IMG_W]], { padding: [40, 40] });

L.imageOverlay('map.png', [[0, 0], [IMG_H, IMG_W]]).addTo(map);

const editableLayers = new L.FeatureGroup();
map.addLayer(editableLayers);

const drawControl = new L.Control.Draw({
  position: 'topright',
  draw: {
    polygon: { shapeOptions: { color: '#1f6feb', weight: 2, fillOpacity: 0.25 } },
    polyline: false,
    rectangle: false,
    circle: false,
    marker: false,
    circlemarker: false,
  },
  edit: {
    featureGroup: editableLayers,
    edit: { remove: true },
  },
});
map.addControl(drawControl);

function styleFor(status) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  return { fillColor: meta.color, color: '#333', weight: 1.2, fillOpacity: 0.45 };
}

function setPropsUI(layer) {
  const p = layer.feature.properties;
  const box = document.getElementById('props');
  box.classList.add('open');
  document.getElementById('prop-name').value = p.name || '';
  document.getElementById('prop-status').value = p.status || 'normal';
  const meta = STATUS_META[p.status] || STATUS_META.unknown;
  document.getElementById('status-note').textContent = meta.label;
}

function selectLayer(layer) {
  editableLayers.eachLayer((l) => l.setStyle(styleFor(l.feature.properties.status)));
  layer.setStyle({ color: '#ffd700', weight: 3, fillOpacity: 0.55 });
  setPropsUI(layer);
  window._selected = layer;
}

document.getElementById('prop-save').addEventListener('click', () => {
  const l = window._selected;
  if (!l) return;
  l.feature.properties.name = document.getElementById('prop-name').value.trim();
  l.feature.properties.status = document.getElementById('prop-status').value;
  l.setStyle(styleFor(l.feature.properties.status));
});

document.getElementById('prop-clear').addEventListener('click', () => {
  editableLayers.eachLayer((l) => l.setStyle(styleFor(l.feature.properties.status)));
  window._selected = null;
  document.getElementById('props').classList.remove('open');
});

// Status select options
const statusSel = document.getElementById('prop-status');
Object.entries(STATUS_META).forEach(([k, v]) => {
  const o = document.createElement('option');
  o.value = k;
  o.textContent = v.label;
  statusSel.appendChild(o);
});

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  layer.feature = { type: 'Feature', properties: { name: '', status: 'normal' } };
  layer.on('click', () => selectLayer(layer));
  editableLayers.addLayer(layer);
  selectLayer(layer);
});

map.on(L.Draw.Event.EDITED, (e) => {
  e.layers.eachLayer((l) => l.setStyle(styleFor(l.feature.properties.status)));
});

map.on(L.Draw.Event.DELETED, (e) => {
  if (window._selected && e.layers.hasLayer(window._selected)) {
    window._selected = null;
    document.getElementById('props').classList.remove('open');
  }
});

function loadData(data) {
  editableLayers.clearLayers();
  let loaded = 0;
  data.features.forEach((f) => {
    try {
      const gj = L.geoJSON({ type: 'FeatureCollection', features: [f] }, {
        style: (ff) => styleFor(ff.properties.status),
      });
      gj.eachLayer((l) => {
        l.on('click', () => selectLayer(l));
        editableLayers.addLayer(l);
        loaded++;
      });
    } catch (err) {
      console.warn('Skipping feature:', f.properties.name, err);
    }
  });
  document.title = `UN RP Map Editor (${loaded}/${data.features.length} features)`;
}

function exportGeoJSON() {
  const features = [];
  editableLayers.eachLayer((l) => {
    let g;
    try { g = l.toGeoJSON(); } catch (err) { return; }
    g.properties = l.feature ? { ...l.feature.properties } : { name: '', status: 'normal' };
    features.push(g);
  });
  const out = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:unmap:image-pixels' } },
    features,
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'countries.geojson';
  a.click();
  URL.revokeObjectURL(a.href);
  return out;
}

document.getElementById('btn-export').addEventListener('click', exportGeoJSON);
document.getElementById('btn-reset').addEventListener('click', () => {
  map.fitBounds([[0, 0], [IMG_H, IMG_W]], { padding: [40, 40] });
});

fetch('data/countries.geojson').then((r) => r.json()).then(loadData).catch((e) => alert('Could not load data/countries.geojson\n\n' + e));
