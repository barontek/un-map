#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Shrink data/countries.geojson for the web viewer.

The source file stores coordinates at 6 decimal places in PNG *pixel* units --
sub-nanometre precision on a 2753px-wide image. Rounding to 1dp is visually
lossless and roughly halves the file on its own; a sub-pixel Douglas-Peucker
pass takes off most of the rest. The default viewer layer snaps every vertex to
an integer grid anyway (snapGeom in app.js), so tolerance below 1px is free.

Douglas-Peucker is implemented here rather than pulled from shapely so the
script runs anywhere with a bare Python (2.7 or 3.x) and CI needs no pip install.

The source file stays the single source of truth -- the editor keeps editing it
at full precision. This writes a separate derived file, intended to be built at
deploy time rather than committed.

Usage:
    python scripts/simplify_geojson.py [--tolerance 0.5] [--precision 1]
                                       [--in data/countries.geojson]
                                       [--out data/countries.min.geojson]
"""

from __future__ import print_function

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Matches TINY_AREA in config.js: below this, a country renders as a flag
# marker rather than a polygon, and simplifying it risks collapsing islands.
TINY_AREA = 10.0


def ring_area(ring):
    a = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def geom_area(geom):
    if geom['type'] == 'Polygon':
        rings = [geom['coordinates'][0]]
    elif geom['type'] == 'MultiPolygon':
        rings = [p[0] for p in geom['coordinates']]
    else:
        return 0.0
    return sum(ring_area(r) for r in rings)


def _seg_dist_sq(p, a, b):
    """Squared perpendicular distance from p to segment a-b."""
    px, py = p
    ax, ay = a
    bx, by = b
    dx = bx - ax
    dy = by - ay
    if dx == 0 and dy == 0:
        return (px - ax) ** 2 + (py - ay) ** 2
    # float() so integer coordinates cannot trigger Python 2 integer division
    # and make this script produce different output locally than in CI.
    t = ((px - ax) * dx + (py - ay) * dy) / float(dx * dx + dy * dy)
    if t < 0:
        t = 0.0
    elif t > 1:
        t = 1.0
    qx = ax + t * dx
    qy = ay + t * dy
    return (px - qx) ** 2 + (py - qy) ** 2


def douglas_peucker(points, tol_sq):
    """Iterative (not recursive) so huge coastlines cannot blow the stack."""
    n = len(points)
    if n < 3:
        return list(points)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        max_d = -1.0
        idx = -1
        a = points[first]
        b = points[last]
        for i in range(first + 1, last):
            d = _seg_dist_sq(points[i], a, b)
            if d > max_d:
                max_d = d
                idx = i
        if max_d > tol_sq:
            keep[idx] = True
            stack.append((first, idx))
            stack.append((idx, last))
    return [p for i, p in enumerate(points) if keep[i]]


def simplify_ring(ring, tol_sq):
    """Rings are closed (first point == last). Simplify the open path, then
    re-close. A ring that would collapse below a triangle is left alone."""
    closed = len(ring) > 1 and ring[0] == ring[-1]
    pts = ring[:-1] if closed else ring[:]
    if len(pts) <= 4:
        return ring
    out = douglas_peucker(pts, tol_sq)
    if len(out) < 3:
        return ring
    if closed:
        out = out + [out[0]]
    return out


def round_ring(ring, nd):
    return [[round(x, nd), round(y, nd)] for x, y in ring]


def process_geom(geom, tol_sq, nd, simplify):
    def do(ring):
        r = simplify_ring(ring, tol_sq) if simplify else ring
        return round_ring(r, nd)

    if geom['type'] == 'Polygon':
        rings = [do(r) for r in geom['coordinates']]
        return {'type': 'Polygon', 'coordinates': rings}
    if geom['type'] == 'MultiPolygon':
        polys = [[do(r) for r in poly] for poly in geom['coordinates']]
        return {'type': 'MultiPolygon', 'coordinates': polys}
    return geom


def count_points(geom):
    if geom['type'] == 'Polygon':
        return sum(len(r) for r in geom['coordinates'])
    if geom['type'] == 'MultiPolygon':
        return sum(len(r) for poly in geom['coordinates'] for r in poly)
    return 0


def arg(argv, name, default, cast):
    if name in argv:
        return cast(argv[argv.index(name) + 1])
    return default


def main(argv):
    tol = arg(argv, '--tolerance', 0.5, float)
    nd = arg(argv, '--precision', 1, int)
    src = arg(argv, '--in', os.path.join(ROOT, 'data', 'countries.geojson'), str)
    dst = arg(argv, '--out', os.path.join(ROOT, 'data', 'countries.min.geojson'), str)

    with open(src, 'rb') as fh:
        data = json.loads(fh.read().decode('utf-8'))

    before_pts = 0
    after_pts = 0
    skipped = 0
    for f in data['features']:
        geom = f['geometry']
        before_pts += count_points(geom)
        # Tiny island nations render as markers; simplifying them can erase
        # whole islands, so only round their coordinates.
        small = geom_area(geom) < TINY_AREA
        if small:
            skipped += 1
        f['geometry'] = process_geom(geom, tol * tol, nd, simplify=not small)
        after_pts += count_points(f['geometry'])

    blob = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    if not isinstance(blob, bytes):
        blob = blob.encode('utf-8')
    with open(dst, 'wb') as fh:
        fh.write(blob)

    src_kb = os.path.getsize(src) / 1024.0
    dst_kb = os.path.getsize(dst) / 1024.0
    print('features   : %d (%d tiny, rounded only)' % (len(data['features']), skipped))
    print('vertices   : %d -> %d (%.1f%%)'
          % (before_pts, after_pts, 100.0 * after_pts / max(before_pts, 1)))
    print('size       : %.0f KB -> %.0f KB (%.1f%%, %.1fx smaller)'
          % (src_kb, dst_kb, 100.0 * dst_kb / src_kb, src_kb / max(dst_kb, 0.001)))
    print('wrote      : %s' % dst)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
