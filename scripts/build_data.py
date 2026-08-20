"""Build data/countries.geojson from SVG geometry.
Country status comes from the Roblox ally group list (data/groups.json): every
grouped nation is a member state (normal) unless it is P5/SC (status_overrides),
while organizations (data/organizations.json) are excluded.
Coordinates are in PNG pixel space: [x, y] (Leaflet CRS.Simple uses [lng=x, lat=y]).
"""
import json, os, sys, unicodedata
import xml.etree.ElementTree as ET
import svgpathtools
from PIL import Image
from shapely.geometry import Polygon, MultiPolygon, mapping
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = '/tmp/opencode/blankmap.svg'
PNG_PATH = os.path.join(ROOT, 'map.png')
OUT = os.path.join(ROOT, 'data', 'countries.geojson')
OVERRIDES_PATH = os.path.join(ROOT, 'data', 'status_overrides.json')
MERGES_PATH = os.path.join(ROOT, 'data', 'merges.json')
GROUPS_PATH = os.path.join(ROOT, 'data', 'groups.json')
ORGS_PATH = os.path.join(ROOT, 'data', 'organizations.json')

# data/countries.geojson is the LIVE data (edited via editor.html -> export).
# This script is only for regenerating it from source; refuse to clobber manual
# edits unless --force is passed.
if os.path.exists(OUT) and '--force' not in sys.argv:
    print('NOT overwriting existing data/countries.geojson (it is the live source of truth).')
    print('Pass --force to regenerate from the source SVG/configs and overwrite it.')
    sys.exit(0)

ns = 'http://www.w3.org/2000/svg'
P = '{' + ns + '}'
root = ET.parse(SVG_PATH).getroot()
SW = float(root.get('width'))
SH = float(root.get('height'))

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

# Build one feature per SVG entry; only merge true duplicates (same normalized
# name AND overlapping by area), so e.g. North/South Korea and the two Congos
# stay separate while "China" / "China, People's Republic of" merge together.
geoms = {}   # key -> {'geom':..., 'names':[...]}
order = []
for name, rings in countries.items():
    g = unary_union(rings)
    if g is None or g.is_empty:
        continue
    nkey = norm_name(name)
    merged_into = None
    for key in order:
        if norm_name(key) == nkey:
            a, b = geoms[key]['geom'], g
            ov = a.intersection(b).area
            if ov > 0.5 * min(a.area, b.area):  # true duplicate (e.g. China vs China PRC)
                merged_into = key
                break
    if merged_into is not None:
        geoms[merged_into]['geom'] = unary_union([geoms[merged_into]['geom'], g])
        geoms[merged_into]['names'].append(name)
    else:
        geoms[name] = {'geom': g, 'names': [name]}
        order.append(name)

def preferred_name(names):
    return min(names, key=lambda n: len(n))

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

# ---- Separate overlapping territories (China/Taiwan, Russia/Crimea, ...) ----
# When one country's polygon fully covers another (e.g. China claims Taiwan,
# Russia draws Crimea inside itself), subtract the covered country from the
# container so both render as distinct territories regardless of z-order.
names = list(geoms.keys())
for na in names:
    if na not in geoms:
        continue
    for nb in names:
        if na == nb or nb not in geoms:
            continue
        A = geoms[na]['geom']
        B = geoms[nb]['geom']
        try:
            inter = A.intersection(B).area
        except Exception:
            continue
        if B.area > 0 and inter > 0.9 * B.area:
            geoms[na]['geom'] = A.difference(B)

# ---------- Scale SVG polygons to PNG coords ----------
with Image.open(PNG_PATH) as _im:
    pw, ph = _im.size
sx, sy = pw / SW, ph / SH

def scale_geom(geom):
    if geom.geom_type == 'Polygon':
        return Polygon([(x * sx, y * sy) for x, y in geom.exterior.coords],
                       [[(x * sx, y * sy) for x, y in ring.coords] for ring in geom.interiors])
    if geom.geom_type == 'MultiPolygon':
        return MultiPolygon([scale_geom(p) for p in geom.geoms])
    return geom

def norm_caseless(name):
    return unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()

# ---- Status from the Roblox ally group list ----
with open(GROUPS_PATH) as f:
    groups = json.load(f)            # id -> readable name
with open(ORGS_PATH) as f:
    organizations = set(json.load(f))
with open(OVERRIDES_PATH) as f:
    overrides = json.load(f)
norm_overrides = {norm_caseless(k): v for k, v in overrides.items()}
norm_orgs = {norm_caseless(n) for n in organizations}
grouped_names = {norm_caseless(n) for n in groups.values() if norm_caseless(n) not in norm_orgs}
print("grouped (non-org) nations in ally list:", len(grouped_names))

# which ally groups map to a dataset country?
dataset_names = {norm_caseless(info['names'][0]) for info in geoms.values()}
unmatched_groups = sorted(grouped_names - dataset_names)
print("ally nations with no dataset match:", len(unmatched_groups), unmatched_groups)

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
SIMPLIFY_TOL = 0.8
for key, info in geoms.items():
    g_png = scale_geom(info['geom'])
    g_out = clean_geom(g_png.simplify(SIMPLIFY_TOL, preserve_topology=True))
    if g_out is None:
        continue
    name = preferred_name(info['names'])
    st = norm_overrides.get(norm_caseless(name))
    if st is None:
        st = norm_overrides.get(norm_caseless(key))
    if st is None:
        st = 'normal' if norm_caseless(name) in grouped_names else 'nogroup'
    status_hist[st] = status_hist.get(st, 0) + 1
    props = {
        'id': key,
        'name': name,
        'status': st,
    }
    features.append({
        'type': 'Feature',
        'properties': props,
        'geometry': mapping(g_out),
    })

print("status histogram:", status_hist)

out = {'type': 'FeatureCollection', 'crs': {'type': 'name', 'properties': {'name': 'urn:unmap:image-pixels'}}, 'features': features}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(out, f)
print("wrote", OUT, "features:", len(features))
