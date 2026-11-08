/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** A set's maps without their tile-scale modes (pipeline-k/material-tile-filter.ts). */

import { describe, expect, it } from 'vitest';
import { filterHeight, filterNormal, filterOrm, removeTileModes, tileFilterCycles } from '../src/node/3d-engine/staged-location/pipeline-k/material-tile-filter';

const W = 64;
/** A channel as a field: a one-cycle wave across the tile (the checker) plus a fine eight-cycle grain. */
function tile(fill: (x: number, y: number) => [number, number, number]): { width: number; height: number; rgba: Uint8Array } {
    const rgba = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fill(x, y); rgba.set([r, g, b, 255], (y * W + x) * 4); }
    return { width: W, height: W, rgba };
}
const slow = (x: number, y: number) => 40 * Math.cos((2 * Math.PI * x) / W) * Math.cos((2 * Math.PI * y) / W);
const fine = (x: number, y: number) => 20 * Math.sin((2 * Math.PI * 8 * x) / W);
const rms = (img: { rgba: Uint8Array }, ch: number, f: (x: number, y: number) => number) => { let s = 0; for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const d = img.rgba[(y * W + x) * 4 + ch] - f(x, y); s += d * d; } return Math.sqrt(s / (W * W)); };

describe('pipeline K tile filter', () => {
    it('removes the cycles of the tile and longer and keeps the grain, around the mean', () => {
        const img = tile((x, y) => [128 + slow(x, y) + fine(x, y), 0, 0]);
        const out = removeTileModes(img, 0, 2);
        // what is left is the grain around 128: within a count or so of rounding
        expect(rms(out, 0, (x, y) => 128 + fine(x, y))).toBeLessThan(1.5);
        // before: the slow wave is in it
        expect(rms(img, 0, (x, y) => 128 + fine(x, y))).toBeGreaterThan(15);
        // nothing removed for a tile too short to carry such a wavelength
        expect(removeTileModes(img, 0, 0)).toBe(img);
        expect(tileFilterCycles([1.2, 1.2])).toBe(2);
        expect(tileFilterCycles([0.4, 0.4])).toBe(0);
        expect(tileFilterCycles([2, 1])).toBe(4);
    });

    it("recentres a normal map's x and y on flat and recomputes z; keeps a roughness's and a height's mean", () => {
        const normal = tile((x, y) => [148 + slow(x, y) + fine(x, y), 118 + slow(y, x), 200]);
        const n = filterNormal(normal, [1.2, 1.2]);
        let mx = 0, my = 0;
        for (let k = 0; k < W * W; k++) { mx += n.rgba[k * 4]; my += n.rgba[k * 4 + 1]; }
        expect(Math.abs(mx / (W * W) - 128)).toBeLessThan(1);
        expect(Math.abs(my / (W * W) - 128)).toBeLessThan(1);
        for (let k = 0; k < W * W; k += 97) {
            const x = n.rgba[k * 4] / 127.5 - 1, y = n.rgba[k * 4 + 1] / 127.5 - 1, z = n.rgba[k * 4 + 2] / 127.5 - 1;
            expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(0.02);
        }
        const orm = tile((x, y) => [255, 180 + slow(x, y) + fine(x, y), 0]);
        const o = filterOrm(orm, [1.2, 1.2]);
        let g = 0; for (let k = 0; k < W * W; k++) g += o.rgba[k * 4 + 1];
        expect(Math.abs(g / (W * W) - 180)).toBeLessThan(1);
        expect(rms(o, 1, (x, y) => 180 + fine(x, y))).toBeLessThan(1.5);
        expect(o.rgba[0]).toBe(255);
        const h = filterHeight(tile((x, y) => [100 + slow(x, y) + fine(x, y), 0, 0]), [2, 2]);
        expect(rms(h, 0, (x, y) => 100 + fine(x, y))).toBeLessThan(1.5);
        // a short tile keeps its maps as they are
        expect(filterNormal(normal, [0.3, 0.3])).toBe(normal);
    });
});
