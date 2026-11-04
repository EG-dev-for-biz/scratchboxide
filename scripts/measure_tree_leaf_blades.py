#!/usr/bin/env python3
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
"""
Measures each leaf atlas of the tree texture library (assets/textures/trees/index.json) for the width of its flat parts,
leaf.bladeWidthM: twice the opaque area over the outline's length, over the atlas's cells (median). A broad leaf's is a
few centimetres, a needle spray's (its branchlets and scale leaves) a few millimetres. The native leaf choice
(scratchbox_tree_textures.hpp) compares it with the same measure of the species' leaf (an ellipse of its length and width),
so a tree the species library matches to needles or scales draws a needle spray and a broadleaf draws leaves.

From the repository root: python3 scripts/measure_tree_leaf_blades.py   (rewrites index.json in place)
"""
import json
import math
import os

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'textures', 'trees')
INDEX = os.path.join(ROOT, 'index.json')
# counting the pixel edges of a digitised outline overstates its length by 4/pi on average over orientations
EDGE_TO_LENGTH = math.pi / 4.0


def cell_blade_width(alpha, cell):
    """2 x area / outline length of the opaque leaf in one cell, metres."""
    h, w = alpha.shape
    o = np.array(cell['origin'], float)
    a = np.array(cell['along'], float)
    c = np.array(cell['across'], float)
    # the cell's parallelogram in pixels (x right, y down; the index's v runs up)
    to_px = lambda uv: np.array([uv[0] * w, (1.0 - uv[1]) * h])
    corners = [to_px(o + t * a + s * c) for s in (0, 1) for t in (0, 1)]
    x0, y0 = np.floor(np.min(corners, axis=0)).astype(int)
    x1, y1 = np.ceil(np.max(corners, axis=0)).astype(int)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    ys, xs = np.mgrid[y0:y1, x0:x1]
    u = (xs + 0.5) / w
    v = 1.0 - (ys + 0.5) / h
    m = np.array([[a[0], c[0]], [a[1], c[1]]])
    inv = np.linalg.inv(m)
    du, dv = u - o[0], v - o[1]
    t = inv[0, 0] * du + inv[0, 1] * dv
    s = inv[1, 0] * du + inv[1, 1] * dv
    inside = (t >= 0) & (t <= 1) & (s >= 0) & (s <= 1)
    opaque = (alpha[y0:y1, x0:x1] >= 0.5) & inside
    area_px = int(opaque.sum())
    if area_px == 0:
        return None
    # outline: opaque pixels' edges to a pixel that is not opaque
    padded = np.pad(opaque, 1)
    core = padded[1:-1, 1:-1]
    edges = sum(int((core & ~padded[1 + dy:padded.shape[0] - 1 + dy, 1 + dx:padded.shape[1] - 1 + dx]).sum())
                for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)))
    metres_per_px = cell['lengthM'] / math.hypot(a[0] * w, a[1] * h)
    return 2.0 * area_px * metres_per_px ** 2 / (edges * EDGE_TO_LENGTH * metres_per_px)


def main():
    index = json.load(open(INDEX))
    for e in index['leaves']:
        alpha = np.asarray(Image.open(os.path.join(ROOT, e['maps']['opacity'])).convert('L'), np.float32) / 255.0
        widths = [b for b in (cell_blade_width(alpha, c) for c in e['atlas']['cells']) if b]
        e['leaf']['bladeWidthM'] = round(float(np.median(widths)), 5)
        print(f"{e['id']}: bladeWidthM {e['leaf']['bladeWidthM']} over {len(widths)} cells "
              f"(leaf {e['leaf']['lengthM']} x {e['leaf']['widthM']} m)")
    index['conventions']['bladeWidth'] = (
        'leaf.bladeWidthM: the width of the leaf\'s flat parts, twice its opaque area over its outline\'s length (the outline '
        'counted in pixel edges times pi / 4), the median over the atlas cells: a broad leaf\'s blade, a needle spray\'s '
        'branchlets and scale leaves. Measured by scripts/measure_tree_leaf_blades.py.')
    with open(INDEX, 'w') as f:
        json.dump(index, f, indent=1, ensure_ascii=False)
        f.write('\n')


if __name__ == '__main__':
    main()
