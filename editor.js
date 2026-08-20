/* UN RP map editor - Leaflet + Leaflet.draw
 * Same coordinate space as the main site: PNG pixel units [x, y], CRS.Simple no-y-flip.
 *
 * UX: click a country to select it - only that country's geometry is shown and
 * editable. MultiPolygons are split into individual Polygon layers (grouped by
 * _groupKey) because Leaflet.draw can't edit MultiPolygons; export recombines them.
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

const pngOverlay = L.imageOverlay('map.png', [[0, 0], [IMG_H, IMG_W]]).addTo(map);

document.getElementById('btn-png').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const mapEl = document.getElementById('map');
  if (map.hasLayer(pngOverlay)) {
    map.removeLayer(pngOverlay);
    btn.classList.remove('active');
    mapEl.style.background = '#ffffff';
  } else {
    map.addLayer(pngOverlay);
    btn.classList.add('active');
    mapEl.style.background = '#123';
  }
});

const editableLayers = new L.FeatureGroup();
map.addLayer(editableLayers);

// Only the draw-polygon tool is built in; editing is per-country on click.
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
  edit: false,
});
map.addControl(drawControl);

function styleFor(status) {
  const meta = STATUS_META[status] || STATUS_META.unknown;
  return { fillColor: meta.color, color: '#333', weight: 1.2, fillOpacity: 0.45 };
}

let selectedGroup = [];   // array of layers for the selected country

function groupFor(layer) {
  const key = layer._groupKey;
  const out = [];
  editableLayers.eachLayer((l) => { if (l._groupKey === key) out.push(l); });
  return out;
}

function clearSelection() {
  selectedGroup.forEach((l) => {
    if (l.editing) { try { l.editing.disable(); } catch (e) {} }
    l.setStyle(styleFor(l.feature.properties.status));
  });
  selectedGroup = [];
  window._selected = null;
  document.getElementById('props').classList.remove('open');
}

function selectCountryGroup(layer) {
  clearSelection();
  const group = groupFor(layer);
  selectedGroup = group;
  window._selected = group[0];
  group.forEach((l) => {
    if (!l.editing) l.editing = new L.Edit.Poly(l);
    try { l.editing.enable(); } catch (e) { console.warn('edit failed', l.feature.properties.name, e); }
    l.setStyle({ color: '#ffd700', weight: 3, fillOpacity: 0.55 });
    l.bringToFront();
  });
  setPropsUI(group[0]);
  document.getElementById('props').classList.add('open');
}

function setPropsUI(layer) {
  const p = layer.feature.properties;
  document.getElementById('prop-name').value = p.name || '';
  document.getElementById('prop-status').value = p.status || 'normal';
  const meta = STATUS_META[p.status] || STATUS_META.unknown;
  document.getElementById('status-note').textContent = meta.label;
}

document.getElementById('prop-save').addEventListener('click', () => {
  const l = window._selected;
  if (!l) return;
  l.feature.properties.name = document.getElementById('prop-name').value.trim();
  l.feature.properties.status = document.getElementById('prop-status').value;
  selectedGroup.forEach((x) => x.setStyle(styleFor(x.feature.properties.status)));
});

document.getElementById('prop-clear').addEventListener('click', clearSelection);

document.getElementById('btn-delete').addEventListener('click', () => {
  const toRemove = selectedGroup.slice();
  clearSelection();
  toRemove.forEach((l) => editableLayers.removeLayer(l));
});

// Status select options
const statusSel = document.getElementById('prop-status');
Object.entries(STATUS_META).forEach(([k, v]) => {
  const o = document.createElement('option');
  o.value = k;
  o.textContent = v.label;
  statusSel.appendChild(o);
});

let drawnCounter = 0;

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const props = { name: '', status: 'normal' };
  layer.feature = { type: 'Feature', properties: props };
  layer._groupKey = 'drawn_' + (drawnCounter++);
  layer.on('click', () => selectCountryGroup(layer));
  editableLayers.addLayer(layer);
  selectCountryGroup(layer);
});

const toLatLngs = (ring) => ring.map(([x, y]) => [y, x]);

function makeLayerFromFeature(f) {
  const g = f.geometry;
  const key = f.properties.id || 'drawn_' + (drawnCounter++);
  const props = { ...f.properties };
  const layers = [];
  const attach = (poly) => {
    poly.feature = { type: 'Feature', properties: props };   // shared so edits apply to all parts
    poly._groupKey = key;
    poly.on('click', () => selectCountryGroup(poly));
    layers.push(poly);
  };
  if (g.type === 'Polygon') {
    attach(L.polygon(g.coordinates.map(toLatLngs)));
  } else if (g.type === 'MultiPolygon') {
    g.coordinates.forEach((part) => attach(L.polygon(part.map(toLatLngs))));
  }
  return layers;
}

function loadData(data) {
  editableLayers.clearLayers();
  clearSelection();
  let loaded = 0;
  data.features.forEach((f) => {
    try {
      makeLayerFromFeature(f).forEach((l) => {
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
  const groups = {};
  editableLayers.eachLayer((l) => {
    let g;
    try { g = l.toGeoJSON().geometry; } catch (err) { return; }
    const key = l._groupKey || l.feature.properties.id || 'drawn';
    if (!groups[key]) {
      groups[key] = {
        properties: l.feature ? { ...l.feature.properties } : { name: '', status: 'normal' },
        parts: [],
      };
      delete groups[key].properties.id;
    }
    groups[key].parts.push(g.coordinates);
  });
  const features = Object.entries(groups).map(([key, grp]) => {
    const geometry = grp.parts.length === 1
      ? { type: 'Polygon', coordinates: grp.parts[0] }
      : { type: 'MultiPolygon', coordinates: grp.parts };
    return { type: 'Feature', properties: { ...grp.properties, id: key }, geometry };
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
