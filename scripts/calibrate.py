"""Compute a sub-pixel affine calibration between the PNG and the SVG geometry.

Fits:  png_x = ax * svg_x + bx
       png_y = ay * svg_y + by

by matching PNG colored-region centroids to the SVG country polygons that
contain them. Writes data/calibration.json for use by build_data.py.
"""
import json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import Point

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PNG_PATH = os.path.join(ROOT, 'map.png')
OUT = os.path.join(ROOT, 'data', 'calibration.json')

# geometry building from build_data.py (stops before scaling); run in its own
# namespace so it can't clobber this script's variables (e.g. OUT)
sys.argv = ['x', '--force']
_bd = {'__file__': os.path.join(ROOT, 'scripts', 'build_data.py')}
src = open(os.path.join(ROOT, 'scripts', 'build_data.py')).read().split('# ---------- Scale SVG polygons')[0]
exec(src, _bd)
geoms = _bd['geoms']
SW = _bd['SW']
SH = _bd['SH']

im = np.array(Image.open(PNG_PATH).convert('RGB')).astype(int)
ph, pw, _ = im.shape
PALETTE = {
    'normal': (65, 143, 222), 'sc': (1, 86, 166), 'p5': (0, 39, 137),
    'nogroup': (173, 173, 173), 'disputed': (200, 9, 21),
    'suspended': (35, 35, 35), 'observer': (34, 177, 76),
}
m = np.zeros((ph, pw), bool)
for c in PALETTE.values():
    m |= (np.abs(im - np.array(c)).sum(axis=2) <= 30)

lbl, n = ndimage.label(m)
sizes = ndimage.sum(m, lbl, range(1, n + 1))

sx, sy = pw / SW, ph / SH
pairs = []  # (svg_x, svg_y, png_x, png_y)
geom_list = list(geoms.values())
pairs = []  # (svg_x, svg_y, png_x, png_y)
for i in range(1, n + 1):
    if sizes[i - 1] < 800:   # small components are too noisy for centroid matching
        continue
    ys, xs = np.where(lbl == i)
    pcx, pcy = xs.mean(), ys.mean()
    scx, scy = pcx / sx, pcy / sy
    pt = Point(scx, scy)
    hit = None
    for info in geom_list:
        if info['geom'].covers(pt):
            hit = info
            break
    if hit is None:
        continue
    c = hit['geom'].centroid
    if not c.is_valid:
        c = hit['geom'].representative_point()
    pairs.append((c.x, c.y, pcx, pcy))

pairs = np.array(pairs)
print("matched pairs:", len(pairs))

X, Y, PX, PY = pairs[:, 0], pairs[:, 1], pairs[:, 2], pairs[:, 3]

def fit(src, dst):
    a = np.polyfit(src, dst, 1)
    return a[0], a[1]

# robust fit with outlier rejection
def robust_fit(src, dst, iters=6):
    mask = np.ones(len(src), bool)
    for _ in range(iters):
        if mask.sum() < 5:
            break
        s, d = src[mask], dst[mask]
        a, b = np.polyfit(s, d, 1)
        res = (a * src + b) - dst
        std = res[mask].std()
        mask = (np.abs(res) < 3 * std)
    s, d = src[mask], dst[mask]
    a, b = np.polyfit(s, d, 1)
    res = (a * src + b) - dst
    return a, b, mask, res

ax, bx, maskx, resx = robust_fit(X, PX)
ay, by, masky, resy = robust_fit(Y, PY)
inliers = maskx & masky
print(f"x: png_x = {ax:.5f} * svg_x + {bx:.3f}   inliers {maskx.sum()}/{len(X)} resid std {resx[maskx].std():.3f}px max {abs(resx[maskx]).max():.3f}")
print(f"y: png_y = {ay:.5f} * svg_y + {by:.3f}   inliers {masky.sum()}/{len(Y)} resid std {resy[masky].std():.3f}px max {abs(resy[masky]).max():.3f}")
print(f"naive x scale: {sx:.5f}, y scale: {sy:.5f}")

cal = {
    'ax': float(ax), 'bx': float(bx),
    'ay': float(ay), 'by': float(by),
    'note': 'png = a*svg + b  (per axis)',
}
with open(OUT, 'w') as f:
    json.dump(cal, f, indent=2)
print("wrote", OUT)
