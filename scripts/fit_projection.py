import numpy as np
from PIL import Image
from scipy import ndimage
import shapefile
from shapely.geometry import shape, Point, box
from pyproj import CRS, Transformer
import sys

# ---------- PNG component extraction (pixel space) ----------
im = np.array(Image.open('/home/barontek/un-map/map.png').convert('RGB')).astype(int)
h, w, _ = im.shape
palette = {
    'normal': (65, 143, 222), 'sc': (1, 86, 166), 'p5': (0, 39, 137),
    'nogroup': (173, 173, 173), 'disputed': (200, 9, 21),
    'suspended': (35, 35, 35), 'observer': (34, 177, 76),
}
m = np.zeros((h, w), bool)
for c in palette.values():
    m |= (np.abs(im - np.array(c)).sum(axis=2) <= 12)
lbl, n = ndimage.label(m)
sizes = ndimage.sum(m, lbl, range(1, n + 1))
comps = []
for i in range(1, n + 1):
    if sizes[i - 1] < 100:
        continue
    ys, xs = np.where(lbl == i)
    comps.append((int(xs.mean()), int(ys.mean()), int(sizes[i - 1])))
print("components:", len(comps))

# ---------- Natural Earth ----------
sf = shapefile.Reader('/tmp/opencode/ne/ne_110m_admin_0_countries')
fields = [f[0] for f in sf.fields[1:]]
ne = []
for r, s in zip(sf.records(), sf.shapes()):
    name = r[fields.index('NAME')]
    geom = shape(s.__geo_interface__)
    if geom.is_valid:
        ne.append((name, geom))
print("NE countries:", len(ne))

def score(proj_name):
    if proj_name == 'platte':
        crs = CRS.from_proj4("+proj=longlat +datum=WGS84")
        tr_geo2proj = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
        def to_proj(lon, lat):
            return tr_geo2proj.transform(lon, lat)
    elif proj_name == 'mercator':
        crs = CRS.from_proj4("+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0")
        tr = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
        def to_proj(lon, lat):
            return tr.transform(lon, lat)
    elif proj_name == 'miller':
        crs = CRS.from_proj4("+proj=mill +R=6378137")
        tr = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
        def to_proj(lon, lat):
            return tr.transform(lon, lat)
    elif proj_name == 'robinson':
        crs = CRS.from_proj4("+proj=robin +R=6378137")
        tr = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
        def to_proj(lon, lat):
            return tr.transform(lon, lat)
    else:
        raise ValueError(proj_name)

    # project NE country polygons -> (X,Y) meters, plus centroids
    proj_polys = []
    for name, geom in ne:
        if geom.geom_type == 'Polygon':
            coords = [to_proj(lon, lat) for lon, lat in geom.exterior.coords]
            proj_polys.append((name, coords))
        elif geom.geom_type == 'MultiPolygon':
            coords = []
            for p in geom.geoms:
                coords.extend([to_proj(lon, lat) for lon, lat in p.exterior.coords])
            proj_polys.append((name, coords))
    allx = [c[0] for _, c in proj_polys for c in c]
    ally = [c[1] for _, c in proj_polys for c in c]
    minx, maxx = min(allx), max(allx)
    miny, maxy = min(ally), max(ally)

    # try a few horizontal shifts to handle center-lon ambiguity
    best = -1
    best_shift = None
    for shift in np.arange(-20, 21, 5):
        lon0 = shift  # central meridian offset in degrees
        # x scale uses full width
        sx = w / (maxx - minx)
        tx = -sx * minx
        sy = h / (maxy - miny)
        ty = -sy * miny
        # for shift, adjust: x = sx*(X - X(shift)) ... approximate by just trying
        # Here we incorporate shift by recomputing projected X with lon_0=shift
        if proj_name == 'platte':
            # lon->x linear regardless; shift means x0 center at lon=shift
            pass
        # build lookup: for each component pixel centroid, invert to lon/lat
        def px2ll(x, y):
            X = (x - tx) / sx
            Y = -(y - ty) / sy
            return X, Y
        # invert projection px2ll via transformer reverse
        tr_proj2geo = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
        matches = 0
        total = 0
        for (cx, cy, sz) in comps:
            X, Y = px2ll(cx, cy)
            try:
                lon, lat = tr_proj2geo.transform(X, Y)
            except Exception:
                continue
            pt = Point(lon, lat)
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                continue
            total += 1
            # find containing NE country (use shapely prepared? just iterate first)
            for name, geom in ne:
                if geom.contains(pt) or geom.covers(pt):
                    matches += 1
                    break
        if total > 0:
            rate = matches / total
            if rate > best:
                best = rate
                best_shift = shift
    return best, best_shift

for p in ['platte', 'mercator', 'miller', 'robinson']:
    r, s = score(p)
    print(f"{p:10s} match rate = {r:.3f} (shift={s})")
