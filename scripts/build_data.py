"""Build data/countries.geojson from SVG geometry + PNG status colors.
Coordinates are in PNG pixel space: [x, y] (Leaflet CRS.Simple uses [lng=x, lat=y]).
"""
import json, re, os, unicodedata
import xml.etree.ElementTree as ET
import svgpathtools
import numpy as np
from PIL import Image
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import unary_union
import rasterio.features

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = '/tmp/opencode/blankmap.svg'
PNG_PATH = os.path.join(ROOT, 'map.png')
OUT = os.path.join(ROOT, 'data', 'countries.geojson')
OVERRIDES_PATH = os.path.join(ROOT, 'data', 'status_overrides.json')
MERGES_PATH = os.path.join(ROOT, 'data', 'merges.json')

ns = 'http://www.w3.org/2000/svg'
P = '{' + ns + '}'
root = ET.parse(SVG_PATH).getroot()
SW = float(root.get('width'))
SH = float(root.get('height'))

PALETTE = {
    'normal':    (65, 143, 222),
    'sc':        (1, 86, 166),
    'p5':        (0, 39, 137),
    'nogroup':   (173, 173, 173),
    'disputed':  (200, 9, 21),
    'suspended': (35, 35, 35),
    'observer':  (34, 177, 76),
}

def seg_points(seg, n=16):
    if isinstance(seg, svgpathtools.Line):
        return [seg.start, seg.end]
    if isinstance(seg, (svgpathtools.CubicBezier, svgpathtools.QuadraticBezier, svgpathtools.Arc)):
        return [seg.point(t / n) for t in range(0, n + 1)]
    return [seg.start, seg.end]

def ring_from_d(d):
    try:
        path = svgpathtools.parse_path(d)
    except Exception:
        return []
    rings = []
    cur = []
    def flush():
        nonlocal cur
        if len(cur) >= 4:
            poly = Polygon(cur)
            if poly.is_valid and poly.area >= 0.2:
                rings.append(poly)
            elif poly.buffer(0).is_valid and poly.buffer(0).area >= 0.2:
                rings.append(poly.buffer(0))
        cur = []
    prev_end = None
    for seg in path:
        sp = (seg.start.real, seg.start.imag)
        ep = (seg.end.real, seg.end.imag)
        if prev_end is not None and (abs(sp[0] - prev_end[0]) > 1e-6 or abs(sp[1] - prev_end[1]) > 1e-6):
            flush()
            cur = [sp]
        elif not cur:
            cur = [sp]
        for p in seg_points(seg):
            cur.append((p.real, p.imag))
        prev_end = ep
    flush()
    return rings

countries = {}
for g in root.iter(P + 'g'):
    t = g.find(P + 'title')
    if t is not None and t.text:
        for p in g.iter(P + 'path'):
            countries.setdefault(t.text, []).extend(ring_from_d(p.get('d')))
for p in root.iter(P + 'path'):
    t = p.find(P + 'title')
    if t is not None and t.text:
        countries.setdefault(t.text, []).extend(ring_from_d(p.get('d')))

def norm_name(name):
    n = name.lower().strip()
    for suf in [', republic of the', ', people\'s republic of', ', plurinational state of',
                ', federated states of', ', socialist republic of', ', united republic of',
                ', democratic people\'s republic of', ', democratic republic of', ', republic of',
                ', republic', ' republic of', ' islands', ', the republic of the']:
        if n.endswith(suf):
            n = n[: -len(suf)]
    return n.strip()

# Merge duplicates by normalized name
merged = {}
for name, rings in countries.items():
    key = norm_name(name)
    merged.setdefault(key, {'names': [], 'rings': []})
    merged[key]['names'].append(name)
    merged[key]['rings'].extend(rings)

geoms = {}
for key, info in merged.items():
    g = unary_union(info['rings'])
    if g is not None and not g.is_empty:
        geoms[key] = {'geom': g, 'names': info['names']}
print("countries after dedupe:", len(geoms))

def norm_match(name):
    n = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    for suf in [', republic of the', ', people\'s republic of', ', plurinational state of',
                ', federated states of', ', socialist republic of', ', united republic of',
                ', democratic people\'s republic of', ', democratic republic of', ', republic of',
                ', republic', ' republic of', ' islands', ', the republic of the',
                ', federated states of']:
        if n.endswith(suf):
            n = n[: -len(suf)]
    return n.strip()

# ---- Merge island territories into parent countries ----
merges = {}
if os.path.exists(MERGES_PATH):
    with open(MERGES_PATH) as f:
        merges = json.load(f)

# build name->key lookup (normalized)
norm_to_key = {}
for key in geoms:
    for n in geoms[key]['names']:
        norm_to_key[norm_match(n)] = key

merged_out = {}
for parent_key, children in merges.items():
    pk = norm_to_key.get(norm_match(parent_key))
    if pk is None:
        print("  WARN: parent not found:", parent_key)
        continue
    pieces = [geoms[pk]['geom']]
    for child in children:
        ck = norm_to_key.get(norm_match(child))
        if ck is None or ck == pk:
            print("  WARN: child not found:", child)
            continue
        pieces.append(geoms[ck]['geom'])
        geoms.pop(ck, None)
    geoms[pk]['geom'] = unary_union(pieces)
    geoms[pk]['names'].append(parent_key)
print("countries after merges:", len(geoms))

# ---------- PNG status classification ----------
im = np.array(Image.open(PNG_PATH).convert('RGB')).astype(int)
ph, pw, _ = im.shape
sx, sy = pw / SW, ph / SH

# class per pixel: 0 = bg, 1..7 = palette
cls = np.zeros((ph, pw), np.int8)
for i, (k, c) in enumerate(PALETTE.items(), start=1):
    cls[(np.abs(im - np.array(c)).sum(axis=2) <= 30)] = i

# Scale SVG polygons to PNG coords
def to_png(geom):
    return geom.__class__ if False else None

def scale_geom(geom):
    if geom.geom_type == 'Polygon':
        return Polygon([(x * sx, y * sy) for x, y in geom.exterior.coords],
                       [[(x * sx, y * sy) for x, y in ring.coords] for ring in geom.interiors])
    if geom.geom_type == 'MultiPolygon':
        return MultiPolygon([scale_geom(p) for p in geom.geoms])
    return geom

def dominant_status(geom):
    """Rasterize polygon over its bbox, tally pixel status classes.
    Falls back to a small window around the representative point for tiny polygons."""
    x0, y0, x1, y1 = map(int, geom.bounds)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(pw - 1, x1), min(ph - 1, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    transform = rasterio.transform.from_bounds(x0, y0, x1 + 1, y1 + 1, x1 - x0 + 1, y1 - y0 + 1)
    mask = rasterio.features.rasterize([(geom, 1)], out_shape=(y1 - y0 + 1, x1 - x0 + 1), transform=transform)
    sub = cls[y0:y1 + 1, x0:x1 + 1][mask == 1]
    if sub.size < 6:
        # tiny polygon: sample a window around representative point
        c = geom.representative_point()
        cx, cy = int(c.x), int(c.y)
        r = 10
        vals = []
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                xx, yy = cx + dx, cy + dy
                if 0 <= xx < pw and 0 <= yy < ph and cls[yy, xx] > 0:
                    vals.append(cls[yy, xx])
        if not vals:
            return None
        vals = np.array(vals)
        vv, cc = np.unique(vals, return_counts=True)
        return list(PALETTE.keys())[vv[np.argmax(cc)] - 1]
    if sub.size == 0:
        return None
    vals, counts = np.unique(sub[sub > 0], return_counts=True)
    if vals.size == 0:
        return None
    return list(PALETTE.keys())[vals[np.argmax(counts)] - 1]

def ring_ok(ring):
    coords = list(ring.coords)
    if len(coords) < 3:
        return False
    uniq = set((round(x, 1), round(y, 1)) for x, y in coords)
    if len(uniq) < 3:
        return False
    area = abs(Polygon(coords).area)
    return area > 1e-4

def clean_geom(geom):
    """Drop rings that collapsed to a point (tiny islands crushed by simplify)."""
    if geom.geom_type == 'Polygon':
        if not ring_ok(geom.exterior):
            return None
        interiors = [r for r in geom.interiors if ring_ok(r)]
        return Polygon(geom.exterior.coords, interiors)
    if geom.geom_type == 'MultiPolygon':
        polys = [clean_geom(p) for p in geom.geoms]
        polys = [p for p in polys if p is not None and not p.is_empty]
        if not polys:
            return None
        if len(polys) == 1:
            return polys[0]
        return MultiPolygon(polys)
    return geom

features = []
status_hist = {}
overrides = {}
if os.path.exists(OVERRIDES_PATH):
    with open(OVERRIDES_PATH) as f:
        overrides = json.load(f)
SIMPLIFY_TOL = 0.8
# accent/case-insensitive overrides lookup
norm_overrides = {norm_match(k): v for k, v in overrides.items()}
for key, info in geoms.items():
    g_png = scale_geom(info['geom'])
    st = dominant_status(g_png)
    g_out = clean_geom(g_png.simplify(SIMPLIFY_TOL, preserve_topology=True))
    if g_out is None:
        continue
    name = info['names'][0]
    ov = norm_overrides.get(norm_match(name))
    if ov is None:
        ov = norm_overrides.get(norm_match(key))
    if ov is not None:
        st = ov
    status_hist[st] = status_hist.get(st, 0) + 1
    props = {
        'id': key,
        'name': name,
        'status': st or 'unknown',
    }
    features.append({
        'type': 'Feature',
        'properties': props,
        'geometry': mapping(g_out),
    })

print("status histogram:", status_hist)
print("unknown status:", [f['properties']['name'] for f in features if f['properties']['status'] == 'unknown'])

out = {'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:unmap:image-pixels'}}, 'features': features}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(out, f)
print("wrote", OUT, "features:", len(features))
