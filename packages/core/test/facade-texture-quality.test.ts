/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade texture builder's quality score on synthetic walls: a clean facade with piers, windows and a full-width string
 * course passes (a real band is not a seam); a wall whose lower half jumps sideways has a seam; a stretched strip is a smear;
 * a grey hole inside the wall is empty, and grey outside the wall's polygon is not.
 */

import { describe, expect, it } from 'vitest';
import { facadeQuality } from '../src/node/3d-engine/staged-location/facade-texture/quality';

const PX = 0.05, W = 200, H = 160;

/** A 10 m x 8 m brick facade: smooth noise, a dark pier every 2 m, a window per bay per storey, a pale string course at 4 m. */
function facade(seed = 7): Uint8Array {
    let r = seed;
    const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    const G = 8, gw = Math.ceil(W / G) + 2, gh = Math.ceil(H / G) + 2;
    const grid = Array.from({ length: gw * gh }, rnd);
    const noise = (x: number, y: number) => {
        const gx = x / G, gy = y / G, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        const v = (i: number, j: number) => grid[j * gw + i];
        return (1 - fx) * (1 - fy) * v(x0, y0) + fx * (1 - fy) * v(x0 + 1, y0) + (1 - fx) * fy * v(x0, y0 + 1) + fx * fy * v(x0 + 1, y0 + 1);
    };
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = x * PX, t = (H - 1 - y) * PX;
        let c: [number, number, number] = [150 + 30 * noise(x, y), 70 + 20 * noise(x + 50, y), 60 + 15 * noise(x, y + 50)];
        const bay = s % 2;
        if (bay < 0.3) c = [110 + 20 * noise(x, y), 50, 45];                                         // pier
        else if (bay > 0.7 && bay < 1.6 && (t % 2.6) > 0.6 && (t % 2.6) < 2.0) c = [40, 45, 55];     // window
        if (t > 4 && t < 4.3) c = [205, 195, 175];                                                    // string course
        out.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], (y * W + x) * 4);
    }
    return out;
}

describe('facade texture quality', () => {
    it('passes a clean facade, its full-width string course not taken for a seam', () => {
        const q = facadeQuality(facade(), W, H, PX);
        expect(q.faultMask.every(v => v === 0)).toBe(true);
        expect(q.seams.rows).toEqual([]);
        expect(q.seams.cols).toEqual([]);
        expect(q.emptyShare).toBe(0);
        expect(q.passed).toBe(true);
    });

    it('finds the seam where the lower half of the wall jumps 0.6 m sideways', () => {
        const a = facade(), b = a.slice();
        const shift = Math.round(0.6 / PX);
        for (let y = 100; y < H; y++) for (let x = 0; x < W; x++) b.set(a.subarray((y * W + ((x + shift) % W)) * 4, (y * W + ((x + shift) % W)) * 4 + 4), (y * W + x) * 4);
        const q = facadeQuality(b, W, H, PX);
        expect(q.passed).toBe(false);
        expect(q.seams.rows.length).toBe(1);
        expect(Math.abs(q.seams.rows[0] - 100)).toBeLessThanOrEqual(2);
        expect(q.why).toMatch(/seam/);
        // the fault mask: the band either side of the seam, nothing far from it
        const band = Math.round(0.4 / PX);
        expect(q.faultMask[(q.seams.rows[0]) * W + 50]).toBe(1);
        expect(q.faultMask[(q.seams.rows[0] - band + 1) * W + 50]).toBe(1);
        expect(q.faultMask[20 * W + 50]).toBe(0);
    });

    it('finds a stretched strip: one row repeated over 2 m', () => {
        const a = facade();
        for (let y = 40; y < 80; y++) a.copyWithin(y * W * 4, 39 * W * 4, 40 * W * 4);
        const q = facadeQuality(a, W, H, PX);
        expect(q.smearShare).toBeGreaterThan(0.06);
        expect(q.passed).toBe(false);
        expect(q.why).toMatch(/smeared/);
    });

    it('counts a grey hole inside the wall as empty, and grey outside the wall polygon not at all', () => {
        const a = facade();
        for (let y = 0; y < 50; y++) for (let x = 0; x < 70; x++) a.set([128, 128, 128, 255], (y * W + x) * 4);
        const q = facadeQuality(a, W, H, PX);
        expect(q.emptyShare).toBeCloseTo((50 * 70) / (W * H), 2);
        expect(q.passed).toBe(false);
        // the fault mask is the hole
        expect(q.faultMask[10 * W + 10]).toBe(1);
        expect(q.faultMask[100 * W + 150]).toBe(0);
        // the same grey corner outside the wall's polygon (a stepped top): not the wall, not counted
        const inside = new Uint8Array(W * H).fill(1);
        for (let y = 0; y < 50; y++) for (let x = 0; x < 70; x++) inside[y * W + x] = 0;
        const qi = facadeQuality(a, W, H, PX, inside);
        expect(qi.emptyShare).toBe(0);
        expect(qi.passed).toBe(true);
    });
});
