/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window depth read from Street View (reveal-depth.ts): a wall facing +z with 1.2 x 2 m windows every 3 m along it and
 * every 4 m up it, the glass set back d behind stone jambs, photographed (ray-cast) from a street-level camera off to one
 * side looking up. The reading finds d from how the glass narrows with the view's angle; a flat wall (d = 0) reads near 0.
 * Also the wall-coverage gate (facade-lattice.ts) and the lattice taking a read depth.
 */

import { describe, expect, it } from 'vitest';
import { measureRevealDepth, trustedReveal, type RevealFacade, type RevealView } from '../src/node/3d-engine/staged-location/reveal-depth';
import { facadeEligible, wallCoverage } from '../src/node/3d-engine/staged-location/facade-lattice';
import { frameCamera, ZERO_CORRECTION } from '../src/node/spatial/StreetViewPoseRegistrar';
import { streetViewClayScore } from '../src/node/3d-engine/staged-location/streetview-clay-score';

const facade = (d: number): RevealFacade & { depth: number } => {
    const windows: Array<[number, number, number, number]> = [];
    for (let s = 0.9; s < 30; s += 3) for (let t = 4.8; t < 40; t += 4) windows.push([s, t, s + 1.2, t + 2]);
    return { facadeId: 1, centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], windows, depth: d };
};

/** The wall photographed: stone on the wall plane and on the jambs, dark glass d behind the plane. */
function photograph(f: RevealFacade & { depth: number }, eye: [number, number, number], headingDeg: number, pitchDeg: number): RevealView {
    const W = 1200, H = 900;
    const camera = frameCamera(eye, headingDeg, pitchDeg, 70, W, H, ZERO_CORRECTION, headingDeg);
    const rgba = new Uint8Array(W * H * 4);
    const inWin = (s: number, t: number) => f.windows.some(w => s > w[0] && s < w[2] && t > w[1] && t < w[3]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xc = (x + 0.5 - camera.cx) / camera.fx, yc = -(y + 0.5 - camera.cy) / camera.fy;
        const dir = [0, 1, 2].map(k => camera.right[k] * xc + camera.up[k] * yc + camera.fwd[k]);
        let c = [120, 160, 220]; // sky
        if (dir[2] < 0) {
            const k0 = -eye[2] / dir[2], p = [eye[0] + dir[0] * k0, eye[1] + dir[1] * k0];
            if (p[1] < 0) c = [90, 90, 90];
            else if (!inWin(p[0], p[1])) c = [200, 190, 175];
            else {
                // through the opening to the glass d behind; the jambs where the ray leaves the opening before it
                const k1 = (-f.depth - eye[2]) / dir[2], q = [eye[0] + dir[0] * k1, eye[1] + dir[1] * k1];
                const w = f.windows.find(r => p[0] > r[0] && p[0] < r[2] && p[1] > r[1] && p[1] < r[3])!;
                c = q[0] > w[0] && q[0] < w[2] && q[1] > w[1] && q[1] < w[3] ? [35, 45, 60] : [175, 165, 150];
            }
        }
        rgba.set([...c, 255], (y * W + x) * 4);
    }
    return { id: `h${headingDeg}`, camera, rgba, width: W, height: H };
}

describe('window depth from Street View', () => {
    it('reads the reveal depth from how the glass narrows with the view angle', () => {
        const f = facade(0.3);
        // street level, 25 m in front of the wall, off to its left; looking up at it
        const views = [photograph(f, [-6, 1.8, 25], 40, 30), photograph(f, [36, 1.8, 22], 316, 32)];
        const r = measureRevealDepth([f], views);
        const got = r.facades['1'];
        expect(got.from).toBe('own');
        expect(got.label).toBe('photo-inferred');
        expect(got.depthM).toBeGreaterThan(0.22);
        expect(got.depthM).toBeLessThan(0.38);
    });

    it('reads a flat wall (glass on the wall plane) as near zero', () => {
        const f = facade(0.0);
        const r = measureRevealDepth([f], [photograph(f, [-6, 1.8, 25], 40, 30), photograph(f, [36, 1.8, 22], 316, 32)]);
        expect(r.facades['1'].depthM).toBeLessThan(0.06);
    });

    it('reads nothing where something stands in front of the wall (the tile mesh nearer than the window)', () => {
        const f = facade(0.3);
        const views = [photograph(f, [-6, 1.8, 25], 40, 30), photograph(f, [36, 1.8, 22], 316, 32)];
        for (const v of views) v.depth = new Float32Array(v.width * v.height).fill(8);
        const r = measureRevealDepth([f], views);
        expect(r.pairs).toBe(0);
        expect(r.facades['1']).toBeUndefined();
    });

    it("gives a facade with no reading of its own the building's pooled depth, and says so", () => {
        const f = facade(0.3), other: RevealFacade = { ...facade(0.3), facadeId: 2, centroid: [0, 0, -500] };
        const r = measureRevealDepth([f, other], [photograph(f, [-6, 1.8, 25], 40, 30), photograph(f, [36, 1.8, 22], 316, 32)]);
        expect(r.facades['2'].from).toBe('building');
        expect(r.facades['2'].depthM).toBe(r.facades['1'].depthM);
    });
});

describe('which reveal readings replace the contrast rule', () => {
    it('trusts a deep, tight reading and refuses one within its noise of flush (ESB: 0.008 +- 0.038 m)', () => {
        expect(trustedReveal({ depthM: 0.3, seM: 0.03 })).toBe(true);
        expect(trustedReveal({ depthM: 0.008, seM: 0.038 })).toBe(false);
        expect(trustedReveal({ depthM: 0.3, seM: 0.08 })).toBe(false);
        expect(trustedReveal(undefined)).toBe(false);
    });
});

describe('the wall-coverage gate', () => {
    it("measures a stepped face's coverage over its own outline, not its rectangle, and keeps slivers out", () => {
        // a 100 x 200 px ortho: the lower half full width, the upper half a 40 px wide tower; the rest the uncovered grey
        const W = 100, H = 200, rgba = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set(y >= 100 || (x >= 30 && x < 70) ? [180, 170, 160, 255] : [128, 128, 128, 255], (y * W + x) * 4);
        const w = wallCoverage({ rgba, width: W, height: H }, 0.1);
        expect(w.wallCoverage).toBeCloseTo(1, 6);
        expect(w.wallAreaM2).toBeCloseTo((100 * 100 + 100 * 40) * 0.01, 6);
        // the rectangle's share would have shut it out
        expect(facadeEligible({ coverage: 0.5, ...w })).toBe(true);
        expect(facadeEligible({ coverage: 0.5 })).toBe(false);
        expect(facadeEligible({ coverage: 0.5, wallCoverage: 1, wallAreaM2: 5 })).toBe(false);
    });
});

/** The wall as a mesh: its face around the windows, and each window recessed d with its four jambs (d = 0: one flat face). */
function wallMesh(f: RevealFacade, d: number): { vertices: number[]; indices: number[] } {
    const v: number[] = [], idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], e: number[]) => { const k = v.length / 3; v.push(...a, ...b, ...c, ...e); idx.push(k, k + 1, k + 2, k, k + 2, k + 3); };
    // the face: cells of a grid on the window edges, those outside every window at z = 0
    const xs = [...new Set([0, 30, ...f.windows.flatMap(w => [w[0], w[2]])])].sort((a, b) => a - b), ys = [...new Set([0, 44, ...f.windows.flatMap(w => [w[1], w[3]])])].sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
        const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2, inside = f.windows.some(w => cx > w[0] && cx < w[2] && cy > w[1] && cy < w[3]);
        const z = inside ? -d : 0;
        quad([xs[i], ys[j], z], [xs[i + 1], ys[j], z], [xs[i + 1], ys[j + 1], z], [xs[i], ys[j + 1], z]);
    }
    if (d > 0) for (const [x0, y0, x1, y1] of f.windows) {
        quad([x0, y0, 0], [x0, y1, 0], [x0, y1, -d], [x0, y0, -d]); quad([x1, y0, 0], [x1, y0, -d], [x1, y1, -d], [x1, y1, 0]);
        quad([x0, y0, 0], [x0, y0, -d], [x1, y0, -d], [x1, y0, 0]); quad([x0, y1, 0], [x1, y1, 0], [x1, y1, -d], [x0, y1, -d]);
    }
    return { vertices: v, indices: idx };
}

describe('the clay scored against Street View', () => {
    it('scores the relief the photo shows better than a flat wall', () => {
        const f = facade(0.3);
        const views = [photograph(f, [-6, 1.8, 25], 40, 30), photograph(f, [36, 1.8, 22], 316, 32)];
        const flat = streetViewClayScore(wallMesh(f, 0), views), recessed = streetViewClayScore(wallMesh(f, 0.3), views);
        expect(recessed.photoToModelPx).not.toBeNull();
        expect(flat.photoToModelPx === null || recessed.photoToModelPx! < flat.photoToModelPx).toBe(true);
    });
});
