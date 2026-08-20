import json, re
import xml.etree.ElementTree as ET
import svgpathtools
from shapely.geometry import Polygon, MultiPolygon, Point
from shapely.ops import unary_union
import numpy as np
from PIL import Image
from scipy import ndimage

SVG_PATH = '/tmp/opencode/blankmap.svg'
PNG_PATH = '/home/barontek/un-map/map.png'

ns = 'http://www.w3.org/2000/svg'
P = '{' + ns + '}'
tree = ET.parse(SVG_PATH)
root = tree.getroot()
SW = float(root.get('width'))
SH = float(root.get('height'))

def seg_points(seg, n=14):
    if isinstance(seg, svgpathtools.Line):
        return [seg.start, seg.end]
    if isinstance(seg, (svgpathtools.CubicBezier, svgpathtools.QuadraticBezier, svgpathtools.Arc)):
        return [seg.point(t / n) for t in range(0, n + 1)]
    return [seg.start, seg.end]

def ring_from_d(d):
    """Split a path 'd' into subpath rings. svgpathtools absorbs Move into the next
    segment; a new subpath is detected when a segment's start != previous segment's end."""
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
            else:
                fixed = poly.buffer(0)
                if fixed.is_valid and fixed.area >= 0.2:
                    rings.append(fixed)
        cur = []
    prev_end = None
    for seg in path:
        sp = (seg.start.real, seg.start.imag)
        ep = (seg.end.real, seg.end.imag)
        if prev_end is not None and abs(sp[0] - prev_end[0]) > 1e-6 and abs(sp[1] - prev_end[1]) > 1e-6:
            flush()
            cur = [sp]
        elif not cur:
            cur = [sp]
        for p in seg_points(seg):
            cur.append((p.real, p.imag))
        prev_end = ep
    flush()
    return rings

def build_geometry(rings):
    """Given a list of ring polygons, assemble into a proper (Multi)Polygon with holes."""
    if not rings:
        return None
    rings = [r for r in rings if r is not None]
    if not rings:
        return None
    # Determine containment depth (even-odd)
    try:
        union = unary_union(rings)
    except Exception:
        return None
    return union

def geojson_from_geom(g):
    return g.__geo_interface__

countries = {}   # name -> list of ring polys
for g in root.iter(P + 'g'):
    t = g.find(P + 'title')
    if t is not None and t.text:
        name = t.text
        for p in g.iter(P + 'path'):
            countries.setdefault(name, []).extend(ring_from_d(p.get('d')))
for p in root.iter(P + 'path'):
    t = p.find(P + 'title')
    if t is not None and t.text:
        countries.setdefault(t.text, []).extend(ring_from_d(p.get('d')))

geoms = {}
for name, rings in countries.items():
    g = build_geometry(rings)
    if g is not None and not g.is_empty:
        geoms[name] = g
print("countries with valid geometry:", len(geoms))

# ---------- Validate against PNG ----------
im = np.array(Image.open(PNG_PATH).convert('RGB')).astype(int)
ph, pw, _ = im.shape
palette = {
    'normal': (65, 143, 222), 'sc': (1, 86, 166), 'p5': (0, 39, 137),
    'nogroup': (173, 173, 173), 'disputed': (200, 9, 21),
    'suspended': (35, 35, 35), 'observer': (34, 177, 76),
}
m = np.zeros((ph, pw), bool)
for c in palette.values():
    m |= (np.abs(im - np.array(c)).sum(axis=2) <= 12)
lbl, n = ndimage.label(m)
sizes = ndimage.sum(m, lbl, range(1, n + 1))

sx = pw / SW
sy = ph / SH
matched = 0
unmatched = []
for i in range(1, n + 1):
    if sizes[i - 1] < 100:
        continue
    ys, xs = np.where(lbl == i)
    cx, cy = xs.mean() / sx, ys.mean() / sy
    pt = Point(cx, cy)
    hit = None
    for name, geom in geoms.items():
        if geom.covers(pt):
            hit = name
            break
    if hit:
        matched += 1
    else:
        unmatched.append((i, int(sizes[i - 1]), (int(cx), int(cy))))
total = sum(1 for i in range(1, n + 1) if sizes[i - 1] >= 100)
print(f"PNG components matched to SVG country: {matched} / {total}")
print("unmatched:", len(unmatched))
for u in unmatched[:20]:
    print("   comp", u)
