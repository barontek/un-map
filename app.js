/* UN map — Leaflet app
 *
 * Coordinate space: the PNG (2753x1399) is the map. GeoJSON country
 * coordinates are in PNG pixel units [x, y] via Leaflet CRS.Simple.
 *
 * IMG_W/IMG_H, STATUS_META, STATUS_ORDER, MEMBER_STATUSES and TINY_AREA all
 * come from config.js, which editor.js shares.
 */

/* ---------------------------------------------------------------- map ---- */

const map = L.map('map', {
  crs: L.Util.extend({}, L.CRS.Simple, {
    // CRS.Simple's default transformation is (1, 0, -1, 0) which flips y and
    // renders the image upside down. Use (1, 0, 1, 0) so image y=0 is the top.
    transformation: new L.Transformation(1, 0, 1, 0),
  }),
  // Negative zoom is required: at zoom 0 one image pixel is one screen pixel,
  // so a 2753px-wide map only fits on a 2753px-wide window. Without this the
  // world can never be seen in full on an ordinary screen.
  minZoom: -2.5,
  maxZoom: 5,
  zoomControl: true,
  attributionControl: false,
  // No maxBounds: when the viewport is taller than the bounds (any phone in
  // portrait, since the map is 2:1) Leaflet force-centres on them and ignores
  // the padding offset, parking half the map behind the bottom sheet. The
  // computed minZoom floor already stops anyone zooming out into empty space,
  // and Reset re-frames the world.
  // Free zoom, so "fit the world" lands on the exact scale that fills the
  // window instead of snapping a quarter-step further out and leaving a wide
  // empty margin. zoomDelta keeps the +/- buttons stepping sensibly.
  zoomSnap: 0,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 90,
}).setView([IMG_H / 2, IMG_W / 2], 0);

const WORLD = [[0, 0], [IMG_H, IMG_W]];

// How far out "the whole world" sits depends on the window, so the zoom-out
// floor has to be computed rather than hardcoded — otherwise you can either
// never fit the map in, or zoom out into empty space around it.
// Keep the world clear of the chrome: a left rail on desktop, a bottom sheet
// on mobile. Without this the map centres behind them and you lose a third of
// it. The map is much wider than it is tall, so the extra bottom padding on
// mobile only re-centres it rather than shrinking it.
function worldPadding() {
  const size = map.getSize();
  const narrow = window.innerWidth <= 860;
  if (!size.x || !size.y) return { tl: L.point(40, 40), br: L.point(40, 40) };
  if (narrow) {
    const sheet = rail ? Math.min(rail.getBoundingClientRect().height, size.y * 0.62) : 0;
    return { tl: L.point(20, 58), br: L.point(20, Math.max(20, sheet)) };
  }
  return { tl: L.point(Math.min(360, size.x * 0.45), 70), br: L.point(40, 40) };
}

function worldZoom() {
  // getBoundsZoom clamps its result to the CURRENT minZoom, so it can never
  // report a zoom below the existing floor. Drop the floor first, or resizing
  // to a narrower window leaves you unable to zoom out far enough to see the
  // whole map.
  map.setMinZoom(-8);
  const p = worldPadding();
  return map.getBoundsZoom(WORLD, false, p.tl.add(p.br));
}

function updateMinZoom() {
  map.setMinZoom(worldZoom() - 0.5);   // a little slack below the world view
}

function fitWorld(animate) {
  updateMinZoom();
  const p = worldPadding();
  const size = map.getSize();
  const zoom = map.getBoundsZoom(WORLD, false, p.tl.add(p.br));

  // Leaflet's own padding offset assumes north is up. This CRS flips y
  // (transformation 1,0,1,0), so fitBounds shifts the map the wrong way and
  // parks a third of it behind the rail. Place the centre explicitly instead:
  // work out which view centre puts the map's middle at the middle of the
  // area that is actually visible.
  const target = L.point(p.tl.x + (size.x - p.tl.x - p.br.x) / 2,
                         p.tl.y + (size.y - p.tl.y - p.br.y) / 2);
  const projected = map.project(L.latLng(IMG_H / 2, IMG_W / 2), zoom);
  const centre = map.unproject(projected.add(size.divideBy(2)).subtract(target), zoom);

  if (animate && shouldAnimate()) map.flyTo(centre, zoom, { duration: 0.6 });
  else map.setView(centre, zoom, { animate: false });
}

map.on('resize', updateMinZoom);

// The artwork is a base map, so it needs its own pane below the vector pane
// (overlayPane is z-index 400). Left in the default pane it is appended after
// the country SVG and paints over it, hiding every hover and selection
// highlight in Classic mode.
map.createPane('artwork');
map.getPane('artwork').style.zIndex = 350;
map.getPane('artwork').style.pointerEvents = 'none';

const pngOverlay = L.imageOverlay('map.png', WORLD, {
  className: 'map-img',
  pane: 'artwork',
});

/* -------------------------------------------------------------- state ---- */

// One 3-state mode, not three independent booleans (the old PNG/Countries/Pixel
// toggles could all be off at once, leaving a blank screen).
let viewMode = 'vector';        // 'vector' | 'pixel' | 'classic'
let activeStatus = null;        // legend filter
let selectedId = null;          // feature id, survives view switches

let countryLayer = null;        // whichever vector layer is currently live
let smoothLayer = null;
let pixelLayer = null;
let tinyMarkers = null;

const countryIndex = {};        // id and name -> feature
const layerIndex = { smooth: {}, pixel: {} };   // id -> layer, built once
const tinyIndex = {};           // id -> { feature, marker }
let groupData = { countries: {}, dependencies: {}, organizations: [] };
let searchEntries = [];
let statusCounts = {};

const $ = (id) => document.getElementById(id);
const rail = $('rail');
const loadingEl = $('loading');

/* ------------------------------------------------------------- helpers --- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function flagEmoji(iso2) {
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) return '';
  return iso2.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Windows ships no flag glyphs, so a regional-indicator pair degrades to the
// bare letters ("SM", "VA") and the map looks broken. Detect it by measuring:
// an unsupported pair is twice the width of a single indicator, a real flag
// is about the same width.
const FLAGS_OK = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '24px sans-serif';
    const pair = ctx.measureText(flagEmoji('US')).width;
    const one = ctx.measureText(flagEmoji('UU')[0] + flagEmoji('UU')[1]).width;
    return one > 0 && pair < one * 1.5;
  } catch (e) {
    return false;
  }
})();

// Emoji where supported, otherwise a deliberate-looking ISO code chip rather
// than a broken-looking letter pair.
function flagHtml(feature) {
  const p = feature.properties;
  if (!isMember(p.status) || !p.iso2) return '';
  if (FLAGS_OK) return '<span class="flag">' + esc(flagEmoji(p.iso2)) + '</span>';
  return '<span class="iso">' + esc(p.iso2.toUpperCase()) + '</span>';
}

const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
const shouldAnimate = () => !document.hidden && !(reduceMotion && reduceMotion.matches);

const isMember = (status) => MEMBER_STATUSES.indexOf(status) !== -1;
const metaFor = (status) => STATUS_META[status] || STATUS_META.unknown;

/* -------------------------------------------------------------- styles --- */

function styleFor(props, opts) {
  opts = opts || {};
  const meta = metaFor(props.status);

  // Selection wins over dimming: searching for a country while a filter is
  // active used to open its panel while the country stayed greyed out on the
  // map, so there was nothing to look at.
  if (opts.selected) {
    return {
      fillColor: meta.color,
      fillOpacity: viewMode === 'classic' ? 0.5 : 1,
      color: '#ffffff',
      weight: 2,
    };
  }
  if (opts.dim) {
    return { fillColor: '#131C2C', fillOpacity: 0.8, color: '#0A1526', weight: 0.5 };
  }
  if (viewMode === 'classic') {
    // Sits on top of the raster artwork, so stay translucent.
    return { fillColor: meta.color, fillOpacity: 0.18, color: 'rgba(0,0,0,0)', weight: 1 };
  }
  if (viewMode === 'pixel') {
    return { fillColor: meta.color, fillOpacity: 0.92, color: '#ffffff', weight: 1 };
  }
  return { fillColor: meta.color, fillOpacity: 0.88, color: '#0A1526', weight: 0.6 };
}

const isDimmed = (status) => activeStatus !== null && status !== activeStatus;

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

/* --------------------------------------------------------- tiny nations --- */

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
    // Non-member micro-states had no flag and fell back to a bare dot, which
    // told you nothing. Show the ISO code instead when there is one.
    const badge = flagHtml(f) ||
      `<span class="iso muted">${esc((f.properties.iso2 || '•').toUpperCase())}</span>`;
    // A dot is rendered alongside; CSS swaps between the two by zoom, because
    // 32 constant-size labels bury the map at world zoom (the Pacific becomes
    // a wall of chips) while being genuinely useful once zoomed in.
    const dot = `<span class="tiny-dot" style="--c:${metaFor(f.properties.status).color}"></span>`;
    const icon = L.divIcon({
      className: 'tiny-marker',
      html: dot + badge,
      iconSize: [24, 16],
      iconAnchor: [12, 8],
    });
    const m = L.marker([y, x], { icon, bubblingMouseEvents: false });
    m.bindTooltip(tooltipHtml(f), { className: 'country-label', sticky: true });
    m.on('click', () => select(f.properties.id));
    layer.addLayer(m);
    tinyIndex[f.properties.id] = { feature: f, marker: m, anchor: [y, x] };
    countryIndex[f.properties.id] = f;
    countryIndex[f.properties.name] = f;
  });
  return layer;
}

/* ------------------------------------------------------------- tooltip --- */

function tooltipHtml(feature) {
  const p = feature.properties;
  const meta = metaFor(p.status);
  return `<span class="dot" style="--c:${meta.color}"></span>${flagHtml(feature)}${esc(p.name)}`;
}

/* -------------------------------------------------------------- layers --- */

function onEachFeature(which) {
  return function (feature, layer) {
    const p = feature.properties;
    countryIndex[p.id] = feature;
    countryIndex[p.name] = feature;
    layerIndex[which][p.id] = layer;

    layer.bindTooltip(tooltipHtml(feature), { className: 'country-label', sticky: true });
    layer.on({
      click: () => select(p.id),
      mouseover: () => {
        if (selectedId !== p.id && !isDimmed(p.status)) {
          layer.setStyle({ fillOpacity: viewMode === 'classic' ? 0.45 : 1, weight: 1.4, color: '#fff' });
        }
        layer.bringToFront();
      },
      mouseout: () => {
        if (selectedId !== p.id) restyle(layer);
      },
    });
  };
}

function restyle(layer) {
  const p = layer.feature.properties;
  layer.setStyle(styleFor(p, { dim: isDimmed(p.status), selected: selectedId === p.id }));
  const el = layer.getElement && layer.getElement();
  if (el) el.classList.toggle('is-selected', selectedId === p.id);
}

function restyleTiny() {
  Object.keys(tinyIndex).forEach((id) => {
    const { feature, marker } = tinyIndex[id];
    const selected = selectedId === id;
    marker.setOpacity(!selected && isDimmed(feature.properties.status) ? 0.2 : 1);
    // Tiny nations are markers, so setStyle/`is-selected` never reached them —
    // selecting one gave no feedback at all on the map.
    const el = marker.getElement && marker.getElement();
    if (el) el.classList.toggle('is-selected', selected);
  });
}

function reloadStyles() {
  if (countryLayer) countryLayer.eachLayer(restyle);
  restyleTiny();
}

/* ---------------------------------------------------------- view modes --- */

function applyView() {
  document.body.dataset.view = viewMode;

  const wantPng = viewMode === 'classic';
  if (wantPng && !map.hasLayer(pngOverlay)) pngOverlay.addTo(map);
  if (!wantPng && map.hasLayer(pngOverlay)) map.removeLayer(pngOverlay);

  const wantPixel = viewMode === 'pixel';
  const next = wantPixel ? pixelLayer : smoothLayer;
  const other = wantPixel ? smoothLayer : pixelLayer;
  if (other && map.hasLayer(other)) map.removeLayer(other);
  if (next && !map.hasLayer(next)) next.addTo(map);
  countryLayer = next;

  // Selection survives a mode switch — it used to be cleared on every toggle.
  reloadStyles();
  if (selectedId) bringSelectedToFront();

  Array.prototype.forEach.call($('segmented').children, (b) => {
    b.setAttribute('aria-selected', String(b.dataset.view === viewMode));
  });
}

function bringSelectedToFront() {
  const l = currentLayerFor(selectedId);
  if (l && l.bringToFront) l.bringToFront();
}

const currentLayerFor = (id) => layerIndex[viewMode === 'pixel' ? 'pixel' : 'smooth'][id];

// Micro-state labels collapse to dots when zoomed out. Threshold chosen so the
// whole-world and continent views stay readable.
const LABEL_ZOOM = 0.5;
function syncZoomClass() {
  document.body.dataset.zoom = map.getZoom() < LABEL_ZOOM ? 'far' : 'near';
}
map.on('zoomend', syncZoomClass);

/* ----------------------------------------------------------- selection --- */

// merges.json folds dependencies into their parent, so France carries French
// Polynesia and the USA carries Guam. Their bounding box is then mostly empty
// ocean, and flying to it just zooms all the way out. In that case frame the
// largest landmass instead (metropolitan France, mainland US).
//
// Two conditions, because neither alone separates the cases. Measured over the
// real data: the merged parents fill 0.27-4.6% of their box (NL .27, FR .29,
// UK .32, NZ .66, US 4.6), but genuine archipelagos sit right among them
// (Solomon Is. 1.6, Bahamas 1.7, Vanuatu 3.8) — what sets those apart is that
// their box is 15-75px wide where the merged parents span 589-2630px.
// Russia (41%) and Indonesia (11%) are excluded by the ratio alone.

function select(id) {
  const feature = countryIndex[id];
  if (!feature) return;
  const prev = selectedId;
  selectedId = feature.properties.id;

  if (prev && prev !== selectedId) {
    const pl = currentLayerFor(prev);
    if (pl) restyle(pl);
  }
  const layer = currentLayerFor(selectedId);
  if (layer) { restyle(layer); layer.bringToFront(); }
  restyleTiny();

  showNation(feature);
  updateUrl();
}

function deselect() {
  const prev = selectedId;
  selectedId = null;
  if (prev) {
    const l = currentLayerFor(prev);
    if (l) restyle(l);
  }
  restyleTiny();
  rail.dataset.state = 'browse';
  updateUrl();
}

/* ------------------------------------------------------------- the URL --- */

// Everything uses replaceState, so setting the URL never re-fires hashchange
// and never re-enters the selection path (the old code looped through it).
//
// Coalesced on a timer: browsers rate-limit history updates and silently drop
// the excess, which leaves the address bar stale and out of step with what is
// actually selected. Only the final state of a burst needs to reach the URL.
function currentPath() {
  const q = activeStatus ? '?status=' + encodeURIComponent(activeStatus) : '';
  const h = selectedId ? '#' + encodeURIComponent(selectedId) : '';
  return location.pathname + q + h;
}

let urlTimer = null;
function updateUrl() {
  if (urlTimer) clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    urlTimer = null;
    try {
      history.replaceState(null, '', currentPath());
    } catch (e) {
      /* hitting the history rate limit must never break selection */
    }
  }, 120);
}

// Built from state, not read off location.href, which the timer above can
// leave briefly stale.
const shareUrl = () => location.origin + currentPath();

function readUrl() {
  const params = new URLSearchParams(location.search);
  const st = params.get('status');
  if (st && STATUS_META[st]) {
    activeStatus = st;
    syncLegend();
    reloadStyles();
  }
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && countryIndex[h]) select(countryIndex[h].properties.id);
}

/* ---------------------------------------------------------- nation view --- */

function groupCardHtml(g) {
  const url = 'https://www.roblox.com/groups/' + encodeURIComponent(g.groupId);
  const icon = g.icon
    ? `<img class="group-icon" src="${esc(g.icon)}" alt="" loading="lazy">`
    : `<div class="group-icon placeholder"><span class="iso muted">ORG</span></div>`;

  const sub = [];
  if (g.memberCount != null) sub.push(fmtNum(g.memberCount) + ' members');
  if (g.owner) sub.push('Owner ' + esc(g.owner.displayName));

  return `<a class="group-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer">
    <div class="group-top">
      ${icon}
      <div class="group-meta">
        <div class="group-name">${esc(g.robloxName || g.groupName)}</div>
        <div class="group-sub">${sub.join(' · ') || 'Roblox group #' + esc(g.groupId)}</div>
      </div>
    </div>
    <div class="group-cta"><span>View on Roblox</span><span>&#8599;</span></div>
  </a>`;
}

function shoutHtml(s) {
  let when = '';
  if (s.updated) {
    const d = new Date(s.updated);
    if (!isNaN(d.getTime())) when = d.toLocaleDateString();   // else "Invalid Date"
  }
  const who = [s.poster && ('@' + s.poster), when].filter(Boolean).join(' · ');
  return `<div class="shout">
    <div class="eyebrow">Group shout</div>
    <p>${esc(s.body)}</p>
    ${who ? `<div class="who">${esc(who)}</div>` : ''}
  </div>`;
}

function showNation(feature) {
  const p = feature.properties;
  const meta = metaFor(p.status);
  const g = groupData.countries[p.id];
  const deps = groupData.dependencies[p.id] || [];

  $('nation-name').innerHTML = flagHtml(feature) + esc(p.name);
  const badge = $('nation-badge');
  badge.textContent = meta.label;
  badge.style.setProperty('--c', meta.color);

  let html = '';
  if (g) {
    html += groupCardHtml(g);
    if (g.shout) html += shoutHtml(g.shout);
    if (g.description) {
      html += `<div class="desc" id="desc">${esc(g.description)}</div>
               <button class="desc-more" id="desc-more">Show more</button>`;
    }
  } else {
    html += `<div class="empty-note">No Roblox group registered</div>`;
  }

  if (deps.length) {
    html += `<div class="section-head" style="padding-left:0;padding-right:0">
               <span class="eyebrow">Dependencies</span></div><div class="deps">`;
    deps.forEach((d) => {
      html += `<a class="dep" href="https://www.roblox.com/groups/${esc(d.groupId)}"
                 target="_blank" rel="noopener noreferrer">${esc(d.name)}</a>`;
    });
    html += `</div>`;
  }

  html += `<button id="copy-link">Copy link</button>`;
  $('nation-body').innerHTML = html;
  $('nation-body').scrollTop = 0;
  rail.dataset.state = 'nation';
  setSheet(true);   // no-op on desktop; on mobile the sheet may be collapsed

  const more = $('desc-more');
  if (more) {
    const desc = $('desc');
    // Only offer the toggle when the text is actually clipped.
    if (desc.scrollHeight <= desc.clientHeight + 2) more.remove();
    else more.addEventListener('click', () => {
      desc.classList.toggle('open');
      more.textContent = desc.classList.contains('open') ? 'Show less' : 'Show more';
    });
  }

  const copy = $('copy-link');
  copy.addEventListener('click', () => {
    const flash = (msg, ok) => {
      copy.textContent = msg;
      copy.classList.toggle('done', ok);
      copy.classList.toggle('failed', !ok);
      setTimeout(() => {
        copy.textContent = 'Copy link';
        copy.classList.remove('done', 'failed');
      }, 1800);
    };
    const url = shareUrl();
    // navigator.clipboard needs a secure context; fall back to execCommand and,
    // failing that, say so rather than claiming a copy that never happened.
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        flash(ok ? 'Link copied' : 'Press Ctrl+C to copy', ok);
      } catch (e) {
        flash('Copy not supported', false);
      }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => flash('Link copied', true), legacy);
    } else {
      legacy();
    }
  });
}

/* -------------------------------------------------------------- legend --- */

function syncLegend() {
  Array.prototype.forEach.call($('legend').children, (el) => {
    const on = el.dataset.status === activeStatus;
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
  });
  const comp = $('composition');
  comp.classList.toggle('filtered', activeStatus !== null);
  Array.prototype.forEach.call(comp.children, (el) => {
    el.classList.toggle('on', el.dataset.status === activeStatus);
  });
}

function buildLegend() {
  const legend = $('legend');
  const comp = $('composition');
  legend.innerHTML = '';
  comp.innerHTML = '';

  STATUS_ORDER.forEach((st) => {
    const n = statusCounts[st] || 0;
    if (!n) return;
    const meta = metaFor(st);

    // A real <button>, not a div, so the filters are keyboard reachable.
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'legend-item';
    row.dataset.status = st;
    row.setAttribute('aria-pressed', 'false');
    row.innerHTML = `<span class="swatch" style="--c:${meta.color}"></span>
                     <span class="l-name">${esc(meta.label)}</span>
                     <span class="l-count">${n}</span>`;
    row.addEventListener('click', () => {
      activeStatus = activeStatus === st ? null : st;
      syncLegend();
      reloadStyles();
      updateUrl();
    });
    legend.appendChild(row);

    const seg = document.createElement('span');
    seg.dataset.status = st;
    seg.style.flex = String(n);
    seg.style.background = meta.color;
    seg.title = meta.label + ' — ' + n;
    comp.appendChild(seg);
  });

  const total = Object.keys(statusCounts).reduce((s, k) => s + statusCounts[k], 0);
  $('total-count').textContent = total + ' territories';
}

function buildOrgs() {
  const orgs = groupData.organizations || [];
  $('orgs-count').textContent = orgs.length;
  const box = $('orgs');
  box.innerHTML = orgs.map((o) => {
    const sub = o.memberCount != null ? fmtNum(o.memberCount) + ' members' : 'Roblox group';
    const icon = o.icon
      ? `<img class="group-icon" style="width:22px;height:22px;border-radius:5px" src="${esc(o.icon)}" alt="">`
      : `<span class="iso muted">ORG</span>`;
    return `<a class="result" href="https://www.roblox.com/groups/${esc(o.groupId)}"
              target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit">
        ${icon}
        <span class="r-name">${esc(o.name)}</span>
        <span class="r-meta">${esc(sub)}</span>
      </a>`;
  }).join('');

  const head = $('orgs-head');
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', String(!open));
    box.hidden = open;
  });
}

/* -------------------------------------------------------------- search --- */

// "North Atlantic Treaty Organization" -> "nato", "United States of America"
// -> "usa". An MUN community types acronyms, and none of them are substrings
// of the official names, so without this NATO/OIC/DPRK find nothing.
const ACRONYM_SKIP = ['of', 'and', 'the', 'for', 'de', 'del', 'la', 'el'];
function acronym(name) {
  // Split on whitespace/hyphens only. Splitting on apostrophes too would turn
  // "People's" into "People"+"s" and yield DPSRK instead of DPRK.
  const words = String(name).split(/[\s\-–—]+/)
    .map((w) => w.replace(/^[^A-Za-z]+/, ''))
    .filter(Boolean);
  if (words.length < 2) return '';
  return words
    .filter((w) => ACRONYM_SKIP.indexOf(w.toLowerCase().replace(/[^a-z]/g, '')) === -1)
    .map((w) => w[0])
    .join('')
    .toLowerCase();
}

function buildSearchIndex(features) {
  searchEntries = features.map((f) => {
    const p = f.properties;
    const g = groupData.countries[p.id];
    return {
      kind: 'country',
      id: p.id,
      name: p.name,
      flag: flagHtml(f),
      meta: metaFor(p.status).label,
      hay: [p.name, p.iso2, acronym(p.name), g && g.groupName, g && g.robloxName]
        .filter(Boolean).join(' ').toLowerCase(),
    };
  });
  (groupData.organizations || []).forEach((o) => {
    searchEntries.push({
      kind: 'org',
      id: o.groupId,
      name: o.name,
      flag: '<span class="iso muted">ORG</span>',
      meta: 'Organization',
      url: 'https://www.roblox.com/groups/' + o.groupId,
      hay: [o.name, acronym(o.name), o.robloxName].filter(Boolean).join(' ').toLowerCase(),
    });
  });
  searchEntries.sort((a, b) => a.name.localeCompare(b.name));
}

let cursor = -1;
let matches = [];

function runSearch(q) {
  const results = $('results');
  const term = q.trim().toLowerCase();
  $('browse-default').hidden = term.length > 0;

  if (!term) { results.innerHTML = ''; matches = []; cursor = -1; return; }

  const hits = searchEntries
    .filter((e) => e.hay.indexOf(term) !== -1)
    .sort((a, b) => {
      // Prefix matches first, then alphabetical.
      const ap = a.name.toLowerCase().indexOf(term) === 0 ? 0 : 1;
      const bp = b.name.toLowerCase().indexOf(term) === 0 ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
  const LIMIT = 40;
  matches = hits.slice(0, LIMIT);
  cursor = matches.length ? 0 : -1;

  if (!matches.length) {
    results.innerHTML = `<div class="no-results">No match for &ldquo;${esc(q)}&rdquo;</div>`;
    return;
  }
  results.innerHTML = matches.map((m, i) => `
    <div class="result${i === cursor ? ' cursor' : ''}" data-i="${i}" role="option">
      ${m.flag /* already-escaped markup from flagHtml */}
      <span class="r-name">${esc(m.name)}</span>
      <span class="r-meta">${esc(m.meta)}</span>
    </div>`).join('') +
    // Otherwise a capped list silently looks like the whole answer.
    (hits.length > LIMIT
      ? `<div class="result-more">Showing ${LIMIT} of ${hits.length} matches</div>`
      : '');

  Array.prototype.forEach.call(results.children, (el) => {
    if (!el.dataset.i) return;
    el.addEventListener('click', () => choose(Number(el.dataset.i)));
  });
}

function moveCursor(d) {
  if (!matches.length) return;
  cursor = (cursor + d + matches.length) % matches.length;
  const results = $('results');
  Array.prototype.forEach.call(results.children, (el, i) => {
    el.classList.toggle('cursor', i === cursor);
  });
  const el = results.children[cursor];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const m = matches[i];
  if (!m) return;
  if (m.kind === 'org') { window.open(m.url, '_blank', 'noopener'); return; }
  $('search').value = '';
  runSearch('');
  $('search').blur();
  select(m.id);
}

/* --------------------------------------------------------------- boot ---- */

// The simplified build is generated at deploy time; fall back to the source
// file so a plain checkout still works.
function loadCountries() {
  // Check r.ok explicitly: calling .json() on a 404 page yields a confusing
  // "Unexpected token '<'" instead of naming the missing file.
  const get = (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(url + ' — HTTP ' + r.status);
    return r.json();
  });
  return get('data/countries.min.geojson').catch(() => get('data/countries.geojson'));
}

Promise.all([
  loadCountries(),
  fetch('data/country_groups.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
]).then(([data, groups]) => {
  groupData = {
    countries: (groups && groups.countries) || {},
    dependencies: (groups && groups.dependencies) || {},
    organizations: (groups && groups.organizations) || [],
  };

  statusCounts = {};
  data.features.forEach((f) => {
    const st = f.properties.status || 'unknown';
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  });

  const tinyFeatures = [];
  const polyFeatures = [];
  data.features.forEach((f) => {
    (geomArea(f.geometry) < TINY_AREA ? tinyFeatures : polyFeatures).push(f);
  });

  smoothLayer = L.geoJSON({ ...data, features: polyFeatures }, {
    style: (f) => styleFor(f.properties),
    onEachFeature: onEachFeature('smooth'),
    // Paths bubble mouse events to the map by default, so a country click
    // would reach the map handler below and instantly deselect itself.
    bubblingMouseEvents: false,
  });
  pixelLayer = L.geoJSON({
    ...data,
    features: polyFeatures.map((f) => ({ ...f, geometry: snapGeom(f.geometry, 1) })),
  }, {
    style: (f) => styleFor(f.properties),
    onEachFeature: onEachFeature('pixel'),
    bubblingMouseEvents: false,
  });
  tinyMarkers = buildTinyMarkers(tinyFeatures).addTo(map);

  buildLegend();
  buildOrgs();
  buildSearchIndex(data.features);
  applyView();
  fitWorld(false);
  syncZoomClass();

  document.body.classList.add('ready');
  loadingEl.classList.add('hidden');
  readUrl();    // frame an initial deep link
}).catch((err) => {
  // Without this the loader spins forever with no explanation. Re-show it in
  // case the failure happened after it was already dismissed.
  loadingEl.classList.remove('hidden');
  loadingEl.innerHTML =
    '<div class="load-error"><div class="eyebrow">Could not load the map</div>' +
    '<p>' + esc(err && err.message ? err.message : err) + '</p>' +
    '<button onclick="location.reload()">Retry</button></div>';
});

/* ------------------------------------------------------------- controls --- */

$('segmented').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn || btn.dataset.view === viewMode) return;
  viewMode = btn.dataset.view;
  applyView();
});

$('btn-reset').addEventListener('click', () => {
  activeStatus = null;
  syncLegend();
  deselect();
  reloadStyles();
  fitWorld(true);
});

$('back').addEventListener('click', deselect);

// Mobile bottom sheet. Selecting a country always re-opens it, otherwise the
// panel you just asked for would stay hidden behind the grip.
const grip = $('sheet-grip');
function setSheet(open) {
  rail.dataset.sheet = open ? 'open' : 'peek';
  grip.setAttribute('aria-expanded', String(open));
  grip.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
}
grip.addEventListener('click', () => setSheet(rail.dataset.sheet !== 'open'));

// editor.html is deliberately not deployed (see the Pages workflow), so a link
// to it would 404 for every visitor. Show it only when developing locally.
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  const a = document.createElement('a');
  a.href = 'editor.html';
  a.className = 'icon-btn';
  a.title = 'Edit borders & statuses';
  a.setAttribute('aria-label', 'Open editor');
  a.textContent = '✎';
  $('viewmodes').appendChild(a);
}

const searchEl = $('search');
searchEl.addEventListener('input', () => runSearch(searchEl.value));
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
  else if (e.key === 'Escape') { searchEl.value = ''; runSearch(''); searchEl.blur(); }
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    rail.dataset.state = 'browse';
    searchEl.focus();
  } else if (e.key === 'Escape' && !typing) {
    deselect();
  }
});

// Only fires for genuine external navigation now (a pasted link, or the user
// editing the hash) because every internal update uses replaceState.
window.addEventListener('hashchange', () => readUrl());

map.on('click', (e) => {
  // Only a click on empty ocean should clear the selection.
  const t = e.originalEvent && e.originalEvent.target;
  if (t && t.closest && t.closest('.leaflet-interactive, .tiny-marker')) return;
  deselect();
});

/* ------------------------------------------------------------- markers --- */

fetch('data/markers.json')
  .then((r) => r.json())
  .then((data) => {
    if (!data.features || !data.features.length) return;
    const icon = L.divIcon({ className: 'marker-dot', html: '<div class="dot"></div>', iconSize: [10, 10] });
    L.geoJSON(data, {
      pointToLayer: (f, latlng) => L.marker(latlng, { icon }),
      onEachFeature: (f, l) => {
        const p = f.properties || {};
        l.bindPopup(`<b>${esc(p.title || 'Marker')}</b>${p.description ? '<br>' + esc(p.description) : ''}`);
      },
    }).addTo(map);
  })
  .catch(() => {});
