/* UN map editor - Leaflet + Leaflet.draw
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
  nogroup:   { label: 'Non-Member State', color: '#adadad' },
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
    if (deleteOnlyMode) hideMiddleMarkersFor(l);
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
  toRemove.forEach((l) => {
    const affected = affectedLayers(l);
    editableLayers.removeLayer(l);
    affected.forEach(recomputeCountry);
  });
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

// --- Delete-nodes-only mode ---
// Hides the edge "middle" markers that insert new vertices when clicked, so
// you can only move/delete existing nodes, never accidentally add new ones.
let deleteOnlyMode = false;

function middleMarkersFor(l) {
  const out = [];
  if (!l.editing || !l.editing._verticesHandlers) return out;
  l.editing._verticesHandlers.forEach((h) => {
    if (!h._markerGroup) return;
    h._markerGroup.eachLayer((m) => {
      if (h._markers.indexOf(m) === -1) out.push(m);   // middle markers aren't vertices
    });
  });
  return out;
}

function hideMiddleMarkersFor(l) {
  middleMarkersFor(l).forEach((m) => { if (m._map) m._map.removeLayer(m); });
}

function showMiddleMarkersFor(l) {
  middleMarkersFor(l).forEach((m) => { if (!m._map) map.addLayer(m); });
}

function applyDeleteOnly() {
  editableLayers.eachLayer((l) => {
    if (deleteOnlyMode) hideMiddleMarkersFor(l);
    else showMiddleMarkersFor(l);
  });
}

document.getElementById('btn-delete-only').addEventListener('change', (e) => {
  deleteOnlyMode = e.target.checked;
  applyDeleteOnly();
});

// --- Enclave support: recompute holes with Turf boolean ops ---
// Every layer keeps a _baseGeom (its shape with no holes carved by others).
// When an enclave is created/moved/deleted, affected countries are rebuilt
// from their base minus all enclaves inside them, so moving an enclave out
// restores the old hole and carves the new location.

function geomToLatLngs(geom) {
  const swap = (ring) => ring.map(([x, y]) => [y, x]);
  if (geom.type === 'Polygon') return geom.coordinates.map(swap);
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((poly) => poly.map(swap));
  return null;
}

function setLayerGeom(layer, geom) {
  const ll = geomToLatLngs(geom);
  if (!ll) return;
  layer.setLatLngs(ll);
  layer.redraw();
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function geomArea(geom) {
  if (!geom) return 0;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.reduce((s, p) => s + ringArea(p[0]), 0);
}

function affectedLayers(poly, prevBounds) {
  const out = new Set();
  const b = poly.getBounds();
  editableLayers.eachLayer((l) => {
    if (l._groupKey === poly._groupKey || !l._baseGeom) return;
    if (l.getBounds().intersects(b) || (prevBounds && l.getBounds().intersects(prevBounds))) {
      out.add(l);
    }
  });
  return out;
}

function recomputeCountry(c) {
  let result = c._baseGeom;
  if (!result) return;
  const cb = c.getBounds();
  editableLayers.eachLayer((o) => {
    if (o === c || o._groupKey === c._groupKey || !o._baseGeom) return;
    if (!o.getBounds().intersects(cb)) return;
    const og = o.toGeoJSON().geometry;
    try {
      const inter = turf.intersect(turf.featureCollection([turf.feature(result), turf.feature(og)]));
      if (inter && inter.geometry && geomArea(inter.geometry) > 0.5 * geomArea(og)) {
        const diff = turf.difference(turf.featureCollection([turf.feature(result), turf.feature(og)]));
        if (diff && diff.geometry && diff.geometry.coordinates) {
          result = diff.geometry;
        }
      }
    } catch (e) { console.warn('recomputeCountry', c.feature && c.feature.properties.name, e); }
  });
  setLayerGeom(c, result);
  c.setStyle(styleFor(c.feature.properties.status));
}

function recomputeFor(poly, prevBounds) {
  if (typeof turf === 'undefined') return;
  affectedLayers(poly, prevBounds).forEach(recomputeCountry);
}

// Countries loaded from data may already have holes carved (Taiwan in China,
// San Marino/Vatican in Italy). Rebuild each country's true base by filling
// every hole with the enclave that sits inside it, so later moves restore
// those holes correctly. (An enclave lies inside a hole, so it doesn't
// intersect the country polygon itself - we match it to the hole instead.)
function computeTrueBases() {
  if (typeof turf === 'undefined') return;
  const layers = [];
  editableLayers.eachLayer((l) => layers.push(l));
  layers.forEach((c) => {
    const holes = [];
    const collect = (g) => {
      if (g.type === 'Polygon') g.coordinates.slice(1).forEach((r) => holes.push(turf.feature({ type: 'Polygon', coordinates: [r] })));
      else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.slice(1).forEach((r) => holes.push(turf.feature({ type: 'Polygon', coordinates: [r] }))));
    };
    collect(c._baseGeom);
    if (!holes.length) return;
    layers.forEach((o) => {
      if (o === c || o._groupKey === c._groupKey || !o._baseGeom) return;
      const og = o.toGeoJSON().geometry;
      try {
        const pt = turf.pointOnFeature(turf.feature(og));
        if (holes.some((h) => turf.booleanPointInPolygon(pt, h))) {
          const u = turf.union(turf.featureCollection([turf.feature(c._baseGeom), turf.feature(og)]));
          if (u && u.geometry) c._baseGeom = u.geometry;
        }
      } catch (e) { /* ignore */ }
    });
  });
}

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const props = { name: '', status: 'normal' };
  layer.feature = { type: 'Feature', properties: props };
  layer._groupKey = 'drawn_' + (drawnCounter++);
  layer._baseGeom = layer.toGeoJSON().geometry;
  layer.on('click', () => selectCountryGroup(layer));
  layer.on('editstart', () => { layer._prevBounds = layer.getBounds(); });
  layer.on('edit', () => {
    recomputeFor(layer, layer._prevBounds);
    if (deleteOnlyMode) hideMiddleMarkersFor(layer);
  });
  editableLayers.addLayer(layer);
  recomputeFor(layer);
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
    poly._baseGeom = poly.toGeoJSON().geometry;
    poly.on('click', () => selectCountryGroup(poly));
    poly.on('editstart', () => { poly._prevBounds = poly.getBounds(); });
    poly.on('edit', () => {
      recomputeFor(poly, poly._prevBounds);
      if (deleteOnlyMode) hideMiddleMarkersFor(poly);
    });
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
  document.title = `UN Map Editor (${loaded}/${data.features.length} features)`;
  computeTrueBases();
}

function buildGeoJSON() {
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
    if (g.type === 'MultiPolygon') {
      g.coordinates.forEach((part) => groups[key].parts.push(part));
    } else {
      groups[key].parts.push(g.coordinates);
    }
  });
  const features = Object.entries(groups).map(([key, grp]) => {
    const geometry = grp.parts.length === 1
      ? { type: 'Polygon', coordinates: grp.parts[0] }
      : { type: 'MultiPolygon', coordinates: grp.parts };
    return { type: 'Feature', properties: { ...grp.properties, id: key }, geometry };
  });
  return {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:unmap:image-pixels' } },
    features,
  };
}

function downloadGeoJSON(out) {
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'countries.geojson';
  a.click();
  URL.revokeObjectURL(a.href);
}

function showSaveMsg(text, isErr) {
  const el = document.getElementById('save-msg');
  el.textContent = text;
  el.className = isErr ? 'save-error' : 'save-ok';
}

async function exportGeoJSON() {
  const out = buildGeoJSON();
  try {
    const res = await fetch('api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error((j && j.error) || 'save failed (' + res.status + ')');
    showSaveMsg('Saved to data/countries.geojson (' + j.features + ' features)', false);
  } catch (err) {
    downloadGeoJSON(out);
    showSaveMsg('Downloaded countries.geojson (no save server) — ' + err.message, true);
  }
  return out;
}

document.getElementById('btn-export').addEventListener('click', exportGeoJSON);
document.getElementById('btn-reset').addEventListener('click', () => {
  map.fitBounds([[0, 0], [IMG_H, IMG_W]], { padding: [40, 40] });
});

fetch('data/countries.geojson').then((r) => r.json()).then(loadData).catch((e) => alert('Could not load data/countries.geojson\n\n' + e));
