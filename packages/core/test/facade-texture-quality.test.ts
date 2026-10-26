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
import { facadeQuality, openingsKept } from '../src/node/3d-engine/staged-location/facade-texture/quality';
import { bayStack, BAY_SPREAD_ZERO_CONFIDENCE, featheredFill, repeatFill, stackedWall } from '../src/node/3d-engine/staged-location/facade-texture/facade-texture';
import { buildTexturePlatePrompt } from '../src/browser/generative-canvas/services/location-beautify-service';

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

    it('keeps openings where the survey saw through: windows pass, wall painted over them fails', () => {
        const good = facade();
        // the seen-through holes: the windows
        const holes = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = x * PX, t = (H - 1 - y) * PX, bay = s % 2;
            if (bay > 0.7 && bay < 1.6 && (t % 2.6) > 0.6 && (t % 2.6) < 2.0 && !(t > 4 && t < 4.3)) holes[y * W + x] = 1;
        }
        expect(openingsKept(good, W, H, holes).passed).toBe(true);
        // the redraw painted the wall's brick over every window
        const bad = good.slice();
        // (each pane takes the wall 1 m to its left: brick, the same tone and texture as the wall around it)
        for (let i = 0; i < W * H; i++) if (holes[i]) bad.set(good.subarray((i - 20) * 4, (i - 20) * 4 + 4), i * 4);
        const r = openingsKept(bad, W, H, holes);
        expect({ passed: r.passed, contrast: r.contrast, smooth: r.smoothRatio }).toMatchObject({ passed: false });
        expect(r.why).toMatch(/painted over the openings/);
    });

    it('sends unseen texels as a fill blended into the seen ones: nothing grey, no hard outline', () => {
        const rgba = facade(), fill = new Uint8Array(W * H * 4), use = new Uint8Array(W * H).fill(1);
        for (let i = 0; i < W * H; i++) fill.set([40, 45, 55, 255], i * 4);
        for (let y = 60; y < 100; y++) for (let x = 60; x < 120; x++) { use[y * W + x] = 0; rgba.set([128, 128, 128, 255], (y * W + x) * 4); }
        const sent = featheredFill(rgba, fill, use, W, H);
        let grey = 0;
        for (let i = 0; i < W * H; i++) if (sent[i * 4] === 128 && sent[i * 4 + 1] === 128 && sent[i * 4 + 2] === 128) grey++;
        expect(grey).toBe(0);
        // deep inside the hole: the fill; on its edge: blended between fill and wall
        expect(Array.from(sent.subarray((80 * W + 90) * 4, (80 * W + 90) * 4 + 3))).toEqual([40, 45, 55]);
        const e = (60 * W + 90) * 4;
        expect(sent[e]).toBeGreaterThan(40);
        expect(sent[e]).toBeLessThan(rgba[(57 * W + 90) * 4] + 1);
    });

    it('finds a flat block inside the wall, and not the flat sky strip along the frame\'s edge', () => {
        const a = facade();
        // a 3 x 4 m slab of one flat colour in the middle of the wall
        for (let y = 40; y < 120; y++) for (let x = 60; x < 120; x++) a.set([120, 120, 125, 255], (y * W + x) * 4);
        const q = facadeQuality(a, W, H, PX);
        expect(q.passed).toBe(false);
        expect(q.flatBlocksM2[0]).toBeGreaterThan(8);
        expect(q.faultMask[80 * W + 90]).toBe(1);
        // the same flat colour as a strip along the top edge (sky above a cornice): not a block
        const b = facade();
        for (let y = 0; y < 40; y++) for (let x = 0; x < W; x++) b.set([200, 205, 210, 255], (y * W + x) * 4);
        expect(facadeQuality(b, W, H, PX).flatBlocksM2).toEqual([]);
    });

    it('fills along the storey from the median of its bays: a one-off is outvoted, nothing comes from a storey up or down', () => {
        const truth = facade(), rgba = truth.slice(), use = new Uint8Array(W * H).fill(1), base = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) base.set([10, 10, 10, 255], i * 4);
        // a one-off: a bright clock in one bay (x 4.9-5.5 m, 3-3.6 m up), then the bay beside it unseen at the same height
        const clock = (x: number, y: number) => x >= 98 && x < 110 && y >= 88 && y < 100;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (clock(x, y)) rgba.set([240, 240, 230, 255], (y * W + x) * 4);
        for (let y = 80; y < 110; y++) for (let x = 138; x < 152; x++) use[y * W + x] = 0;
        // the top 1 m of the wall unseen across its whole width (a cornice strip no station saw)
        for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++) use[y * W + x] = 0;
        const fill = repeatFill(rgba, use, W, H, PX, base);
        // the unseen bay beside the clock: the bays' median, i.e. the wall, not the clock
        const at = (x: number, y: number) => Array.from(fill.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
        expect(at(140, 94)).not.toEqual([240, 240, 230]);
        expect(at(140, 94)).toEqual(Array.from(truth.subarray((94 * W + 140) * 4, (94 * W + 140) * 4 + 3)));
        // the unseen top strip: no bay of its rows was seen, and no storey is copied up: the base
        expect(at(50, 10)).toEqual([10, 10, 10]);
    });

    it('stacks every bay onto one: a car in one bay is voted out, and the bays\' disagreement there is the confidence', () => {
        const truth = facade(), rgba = truth.slice(), use = new Uint8Array(W * H).fill(1);
        // a red car across one bay's lowest metre (x 2.4-3.6 m), seen: a stack of five bays outvotes it
        const car = (x: number, y: number) => x >= 48 && x < 72 && y >= H - 20;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (car(x, y)) rgba.set([220, 20, 20, 255], (y * W + x) * 4);
        const st = bayStack(rgba, use, W, H, PX);
        expect(st.bayM).toBeCloseTo(2, 1);
        expect(st.bays).toBe(5);
        expect(st.votedShare).toBe(1);
        // the stack under the car is wall, not red: a car is never in the stacked wall
        const wall = stackedWall(st, W, H, new Uint8Array(W * H * 4));
        const k = ((H - 10) * W + 60) * 4;
        expect(wall[k]).toBeLessThan(200);
        expect(wall[k + 1]).toBeGreaterThan(40);
        // a clean bay agrees with its siblings almost exactly; one bay in five a car still leaves the median's MAD small
        expect(st.meanConfidence).toBeGreaterThan(0.8);
        // a row where every bay differs wildly has low confidence
        const noisy = truth.slice();
        for (let x = 0; x < W; x++) { const v = Math.floor(x / st.bay) * 60; noisy.set([v, v, v, 255], (50 * W + x) * 4); }
        const sn = bayStack(noisy, use, W, H, PX, undefined);
        const row = Array.from(sn.confidence.subarray(50 * sn.bay, 51 * sn.bay));
        expect(Math.max(...row)).toBeLessThan(1 - 30 / BAY_SPREAD_ZERO_CONFIDENCE);
        // unseen bays do not vote: with only two bays of a row seen there is no stack there
        const few = new Uint8Array(W * H).fill(1);
        for (let x = 80; x < W; x++) few[30 * W + x] = 0;
        expect(bayStack(truth, few, W, H, PX).votes[30 * 40 + 10]).toBeLessThan(3);
    });

    it('describes a bay-stack reference as this wall, not the adjacent one', () => {
        const base = { locationName: 'X', widthM: 10, heightM: 8, widthPx: 512, heightPx: 400, preserveClause: '', withReference: true };
        expect(buildTexturePlatePrompt({ ...base, referenceIsBayStack: true })).toContain('median of all its bays');
        expect(buildTexturePlatePrompt(base)).toContain('adjacent wall');
        expect(buildTexturePlatePrompt(base)).not.toContain('median of all its bays');
    });
});
