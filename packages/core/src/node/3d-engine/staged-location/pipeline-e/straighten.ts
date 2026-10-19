/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E inference (e): a straightened texture. The grammar lattice's lines (each opening column's left and right edge,
 * each tier's top and bottom) say where the facade's edges should run; the tile photo's edges wander a little (the
 * photogrammetric texture is stitched from several views). For every lattice line, the strongest edge of the photo within
 * MAX_SHIFT_M is found (a peak of the summed gradient across the line's own span); the displacement between them becomes a
 * knot of a gentle, separable, monotone warp (s and t independently, piecewise linear between knots, smoothed), so detected
 * edges land on the lattice lines.
 *
 * Verified: the warp is kept only when, measured again after warping, the mean distance from the lattice lines to the
 * photo's edges falls by at least MIN_GAIN of what it was; it never folds (the mapping stays monotone).
 */

import { lumaPlane } from './image-ops';
import type { FaceTexture } from './massing-glb';

export const MAX_SHIFT_M = 0.35;
export const MIN_GAIN = 0.2;

export interface LatticeLines { xs: Array<{ at: number; y0: number; y1: number }>; ys: Array<{ at: number; x0: number; x1: number }> }

/** Gradient magnitudes along x and y (central differences of luma). */
function grads(t: FaceTexture): { gx: Float32Array; gy: Float32Array } {
    const W = t.width, H = t.height, L = lumaPlane(t.rgba, W, H);
    const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        gx[i] = Math.abs(L[i + 1] - L[i - 1]);
        gy[i] = Math.abs(L[i + W] - L[i - W]);
    }
    return { gx, gy };
}

/** For each line, the offset (px) of the strongest edge within +-r of it, and that edge's mean distance. */
export function detectOffsets(t: FaceTexture, lines: LatticeLines, r: number): { dx: number[]; dy: number[]; meanDist: number } {
    const W = t.width, H = t.height;
    const { gx, gy } = grads(t);
    const dist: number[] = [];
    const dx = lines.xs.map(l => {
        let best = 0, bv = -1;
        for (let o = -r; o <= r; o++) {
            const x = Math.round(l.at + o);
            if (x < 1 || x >= W - 1) continue;
            let s = 0;
            for (let y = Math.max(1, Math.round(l.y0)); y < Math.min(H - 1, Math.round(l.y1)); y++) s += gx[y * W + x];
            // ties go to the smaller shift
            const v = s * (1 - 0.002 * Math.abs(o));
            if (v > bv) { bv = v; best = o; }
        }
        dist.push(Math.abs(best));
        return best;
    });
    const dy = lines.ys.map(l => {
        let best = 0, bv = -1;
        for (let o = -r; o <= r; o++) {
            const y = Math.round(l.at + o);
            if (y < 1 || y >= H - 1) continue;
            let s = 0;
            for (let x = Math.max(1, Math.round(l.x0)); x < Math.min(W - 1, Math.round(l.x1)); x++) s += gy[y * W + x];
            const v = s * (1 - 0.002 * Math.abs(o));
            if (v > bv) { bv = v; best = o; }
        }
        dist.push(Math.abs(best));
        return best;
    });
    return { dx, dy, meanDist: dist.length ? dist.reduce((a, b) => a + b, 0) / dist.length : 0 };
}

/**
 * A monotone 1D map out -> in over [0, n): knots at `at` with source offsets `off` (the photo's edge sits at at + off, so
 * out(at) samples in(at + off)), smoothed by averaging knots closer than `merge` px, ends anchored at 0 shift.
 */
export function warpMap(n: number, at: number[], off: number[], merge: number): Float32Array {
    const pts = at.map((a, i) => [a, off[i]] as [number, number]).sort((p, q) => p[0] - q[0]);
    const knots: Array<[number, number]> = [[0, 0]];
    for (let i = 0; i < pts.length;) {
        let j = i, sa = 0, so = 0;
        while (j < pts.length && pts[j][0] - pts[i][0] <= merge) { sa += pts[j][0]; so += pts[j][1]; j++; }
        knots.push([sa / (j - i), so / (j - i)]);
        i = j;
    }
    knots.push([n - 1, 0]);
    const m = new Float32Array(n);
    let k = 0;
    for (let x = 0; x < n; x++) {
        while (k + 1 < knots.length - 1 && knots[k + 1][0] <= x) k++;
        const [a0, o0] = knots[k], [a1, o1] = knots[Math.min(k + 1, knots.length - 1)];
        const u = a1 > a0 ? (x - a0) / (a1 - a0) : 0;
        m[x] = x + o0 + u * (o1 - o0);
    }
    // monotone: never fold
    for (let x = 1; x < n; x++) if (m[x] < m[x - 1] + 0.2) m[x] = m[x - 1] + 0.2;
    return m;
}

/** Resamples `t` by the separable maps (bilinear). Returns a new RGBA and source. */
export function applyWarp(t: FaceTexture, mx: Float32Array, my: Float32Array): FaceTexture {
    const W = t.width, H = t.height, rgba = new Uint8Array(W * H * 4), source = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const sy = Math.min(H - 1, Math.max(0, my[y])), y0 = Math.floor(sy), y1 = Math.min(H - 1, y0 + 1), fy = sy - y0;
        for (let x = 0; x < W; x++) {
            const sx = Math.min(W - 1, Math.max(0, mx[x])), x0 = Math.floor(sx), x1 = Math.min(W - 1, x0 + 1), fx = sx - x0;
            const i = y * W + x;
            for (let c = 0; c < 4; c++) {
                const v = (1 - fx) * (1 - fy) * t.rgba[(y0 * W + x0) * 4 + c] + fx * (1 - fy) * t.rgba[(y0 * W + x1) * 4 + c] + (1 - fx) * fy * t.rgba[(y1 * W + x0) * 4 + c] + fx * fy * t.rgba[(y1 * W + x1) * 4 + c];
                rgba[i * 4 + c] = Math.round(v);
            }
            source[i] = t.source[Math.round(sy) * W + Math.round(sx)];
        }
    }
    return { width: W, height: H, rgba, source };
}

export interface StraightenResult { accepted: boolean; before: number; after: number; lines: number; why: string; texture?: FaceTexture }

/** Detect, warp, measure again; the warped texture only when it brings the photo's edges onto the lines. */
export function straighten(t: FaceTexture, lines: LatticeLines, pixelM: number): StraightenResult {
    const r = Math.max(2, Math.round(MAX_SHIFT_M / pixelM));
    if (lines.xs.length + lines.ys.length < 4) return { accepted: false, before: 0, after: 0, lines: lines.xs.length + lines.ys.length, why: 'fewer than 4 lattice lines' };
    const det = detectOffsets(t, lines, r);
    if (det.meanDist < 0.75) return { accepted: false, before: det.meanDist, after: det.meanDist, lines: lines.xs.length + lines.ys.length, why: `the photo's edges already sit on the lattice (mean ${det.meanDist.toFixed(2)} px)` };
    const mx = warpMap(t.width, lines.xs.map(l => l.at), det.dx, r);
    const my = warpMap(t.height, lines.ys.map(l => l.at), det.dy, r);
    const warped = applyWarp(t, mx, my);
    const after = detectOffsets(warped, lines, r).meanDist;
    const accepted = after <= det.meanDist * (1 - MIN_GAIN);
    return { accepted, before: det.meanDist, after, lines: lines.xs.length + lines.ys.length, why: `edge to lattice ${det.meanDist.toFixed(2)} -> ${after.toFixed(2)} px (needs ${Math.round(MIN_GAIN * 100)}% less)`, ...(accepted ? { texture: warped } : {}) };
}
