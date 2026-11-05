#!/usr/bin/env python3
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.
"""Footprint from the photo tiles: a small U-Net reads a 64 m top-down window of the tiles (height above ground and
photo colour, 0.25 m cells, centred on the query point) and returns the outline of the building the point is in.

Trained on 11,102 NYC buildings from 20 neighbourhoods (NYC Building Footprints) and fine-tuned with 1,340 Amsterdam
buildings (BAG); measured
on unseen buildings by scripts/benchmarks/nyc-truth (docs/processes/nyc_truth_benchmark_2026-10-31.md). Its outline is
photo-inferred: a learned reading of measured tiles, never a measurement.

Input: the window the native topdown_window tool writes (height.f32, colour.rgb, window.json: tile frame x east,
z south, metres; rows are z). Output JSON: the outline ring (x, z in the tile frame), its area, the model's mean
probability inside it and at the point, and the walls' direction it was straightened on.

usage: footprint_model.py --window <dir> --x <x> --z <z> --weights <unet.pt> --out <result.json>
Needs numpy, torch and opencv (the project .venv). Runs on the Apple GPU when there is one.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
import torch
import torch.nn as nn

K = 256          # crop cells
CELL = 0.25      # metres per cell
MODEL_VERSION = 'unet-footprint/2026-11-02-nyc+ams'


def block(i, o):
    return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
                         nn.Conv2d(o, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(inplace=True))


class UNet(nn.Module):
    """The architecture the weights were trained with (scripts/benchmarks/nyc-truth/unet_footprint.py)."""

    def __init__(self, ch=(24, 48, 96, 192, 256)):
        super().__init__()
        self.down = nn.ModuleList(); prev = 5
        for c in ch:
            self.down.append(block(prev, c)); prev = c
        self.up = nn.ModuleList(); self.dec = nn.ModuleList()
        for c in reversed(ch[:-1]):
            self.up.append(nn.ConvTranspose2d(prev, c, 2, stride=2)); self.dec.append(block(2 * c, c)); prev = c
        self.head = nn.Conv2d(prev, 1, 1)
        self.pool = nn.MaxPool2d(2)

    def forward(self, x):
        skips = []
        for i, d in enumerate(self.down):
            x = d(x)
            if i < len(self.down) - 1:
                skips.append(x); x = self.pool(x)
        for u, dec in zip(self.up, self.dec):
            x = u(x); x = dec(torch.cat([x, skips.pop()], 1))
        return self.head(x)


def srgb_to_lab(rgb):
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def fill_nearest(h):
    """Unseen cells (NaN) take the value of their nearest seen cell."""
    bad = ~np.isfinite(h)
    if not bad.any():
        return h
    src = (~bad).astype(np.uint8)
    _, labels = cv2.distanceTransformWithLabels(1 - src, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(src)
    lut = np.zeros(labels.max() + 1, dtype=np.int64)
    lut[labels[ys, xs]] = ys * h.shape[1] + xs
    return h.ravel()[lut[labels]].reshape(h.shape)


def load_window(d):
    meta = json.load(open(os.path.join(d, 'window.json')))
    W, R = meta['width'], meta['rows']
    h = np.fromfile(os.path.join(d, meta['height']), dtype='<f4').reshape(R, W)
    rgb = np.fromfile(os.path.join(d, meta['colour']), dtype=np.uint8).reshape(R, W, 3)
    return meta, h, rgb


def crop(meta, h, rgb, x, z):
    """The 64 m crop around (x, z), indexed [x, z] like the training crops, with its world origin."""
    if not np.isfinite(h).any():
        raise ValueError('the window holds no tile surface')
    ground = float(np.nanpercentile(h, 3))
    hf = fill_nearest(h)
    lab = srgb_to_lab(rgb.astype(np.float64) / 255.0)
    col = int(np.floor((x - meta['x0']) / CELL)) - K // 2
    row = int(np.floor((z - meta['z0']) / CELL)) - K // 2
    if col < 0 or row < 0 or col + K > meta['width'] or row + K > meta['rows']:
        raise ValueError('the window does not hold the 64 m crop around the point')
    a = (hf[row:row + K, col:col + K] - ground).T  # rows are z: transpose to [x, z]
    c = lab[row:row + K, col:col + K].transpose(1, 0, 2)
    origin = (meta['x0'] + col * CELL, meta['z0'] + row * CELL)
    return a.astype(np.float32), c.astype(np.float32), origin, ground


def inputs(a, c):
    gi, gj = np.mgrid[0:K, 0:K]
    mark = np.exp(-(((gi - K / 2) ** 2 + (gj - K / 2) ** 2) * CELL ** 2) / (2 * 1.5 ** 2)).astype(np.float32)
    return np.stack([np.clip(a, -5, 120) / 30.0, c[..., 0] / 100.0, c[..., 1] / 50.0, c[..., 2] / 50.0, mark], 0)[None]


_NETS = {}  # weights path -> loaded model: a persistent worker (worker_host.py) keeps it between calls


def predict(x, weights):
    dev = 'mps' if torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')
    net = _NETS.get(weights)
    if net is None:
        net = UNet().to(dev)
        net.load_state_dict(torch.load(weights, map_location=dev))
        net.eval()
        _NETS[weights] = net
    with torch.no_grad():
        xb = torch.from_numpy(x).to(dev)
        p = sum(torch.rot90(torch.sigmoid(net(torch.rot90(xb, k, (2, 3)))), -k, (2, 3)) for k in range(4)) / 4
    return p[0, 0].cpu().numpy()


def outline(prob, origin, angle, open_m=1.0):
    """The component holding the centre, holes filled, then straightened: resampled on a grid turned to the walls'
    direction, jags under open_m opened away, traced. Returns (ring in world x, z; region mask)."""
    m = (prob > 0.5).astype(np.uint8)
    n, lab = cv2.connectedComponents(m, connectivity=4)
    c = K // 2
    k = lab[c, c]
    if k == 0:
        ys, xs = np.nonzero(lab)
        if not len(ys):
            return None, None
        d = np.hypot(ys - c, xs - c); j = int(np.argmin(d))
        if d[j] * CELL > 3.0:
            return None, None
        k = lab[ys[j], xs[j]]
    reg = (lab == k).astype(np.uint8)
    flood = reg.copy(); mask = np.zeros((K + 2, K + 2), np.uint8)
    cv2.floodFill(flood, mask, (0, 0), 1)
    reg = reg | (1 - flood)  # holes filled
    # world coordinates of the region's cells ([i, j] = [x, z])
    ii, jj = np.nonzero(reg)
    px = origin[0] + (ii + 0.5) * CELL; pz = origin[1] + (jj + 0.5) * CELL
    ca, sa = np.cos(angle), np.sin(angle)
    q = np.c_[px * ca + pz * sa, -px * sa + pz * ca]  # world -> wall grid
    s = 2 * max(1, int(round(open_m / CELL))) + 1
    pad = s + 2  # OpenCV erodes as if the image border were building: keep the region well clear of it
    qlo = q.min(0) - pad * CELL
    shape = (np.ceil((q.max(0) - qlo) / CELL).astype(int) + pad + 1)
    G = np.zeros(shape, np.uint8)
    gi = np.floor((q - qlo) / CELL).astype(int)
    G[gi[:, 0], gi[:, 1]] = 1
    G = cv2.morphologyEx(G, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3)))
    st = np.ones((s, s), np.uint8)
    G = cv2.morphologyEx(cv2.morphologyEx(G, cv2.MORPH_OPEN, st), cv2.MORPH_CLOSE, st)
    n2, lab2, stats, _ = cv2.connectedComponentsWithStats(G, connectivity=4)
    if n2 < 2:
        return None, reg
    G = (lab2 == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    # contours run through boundary pixel centres, half a pixel inside the cells' edges: trace on a grid UP times finer
    # and push each vertex back out by that half pixel, so walls sit on the cell edges; points are (col, row) = (j, i)
    UP = 8
    big = cv2.resize(G, (G.shape[1] * UP, G.shape[0] * UP), interpolation=cv2.INTER_NEAREST)
    cs, _ = cv2.findContours(big, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnt = max(cs, key=cv2.contourArea)[:, 0, :].astype(np.float64)
    cen = cnt.mean(0)
    cnt = cnt + 0.5 + 0.5 * np.sign(cnt - cen)  # pixel centre -> outer pixel edge
    gx = qlo[0] + cnt[:, 1] * CELL / UP; gz = qlo[1] + cnt[:, 0] * CELL / UP
    wx = gx * ca - gz * sa; wz = gx * sa + gz * ca  # wall grid -> world
    return np.c_[wx, wz], reg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', required=True); ap.add_argument('--x', type=float, required=True); ap.add_argument('--z', type=float, required=True)
    ap.add_argument('--weights', required=True); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    if not os.path.exists(a.weights):
        raise SystemExit(f'footprint model weights not found: {a.weights}')
    meta, h, rgb = load_window(a.window)
    A, C, origin, ground = crop(meta, h, rgb, a.x, a.z)
    prob = predict(inputs(A, C), a.weights)
    angle = float(meta.get('wallAngleRad', 0.0))
    ring, reg = outline(prob, origin, angle)
    res = dict(ok=ring is not None, model=MODEL_VERSION, groundY=ground, wallAngleDeg=float(np.degrees(angle)),
               probAtPoint=float(prob[K // 2, K // 2]))
    if ring is not None:
        x, z = ring[:, 0], ring[:, 1]
        res.update(ring=[[float(u), float(v)] for u, v in ring], areaM2=float(0.5 * abs(np.dot(x, np.roll(z, 1)) - np.dot(z, np.roll(x, 1)))),
                   meanProbInside=float(prob[reg > 0].mean()), cells=int(reg.sum()))
    else:
        res['reason'] = 'the model found no building under the point'
    json.dump(res, open(a.out, 'w'))
    print(json.dumps({k: v for k, v in res.items() if k != 'ring'}))


if __name__ == '__main__':
    sys.exit(main())
