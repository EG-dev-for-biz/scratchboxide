/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The geometry half of the surface infill (surface-infill.ts): the surface under a removed region rebuilt from the measured
 * ring around it, never a lump or a hole.
 *
 * 1. The chart: a local frame on the surface (origin, u, v in the surface, n out of it) fitted to the ring. A surface
 *    within `levelCos` of level is charted from straight above in plan (u = +x, v = +z, n = up), so a plan grid and the
 *    chart are one grid; a wall or a slope gets its own plane (u level along it).
 * 2. The surface model: heights along n as a function of (a, b) in the chart. The ring's points are joined into
 *    levels wherever neighbours differ by less than a smooth surface's rise, so a grade or a camber stays one level and a
 *    step cuts it (a kerb, a stair, a plinth: the nearest points across differ by the step, not by a smooth slope); each
 *    level is its own surface: a moving local quadric through that level's ring points (Gaussian weights, the reach
 *    growing to its k-th nearest point; the curvature held by a light ridge where the ring does not surround the point),
 *    so grade and camber are kept from the measured ring and its continuation. A point takes the level of the side of the
 *    breakline it stands on: a straight line when the levels' ring points separate on one (Fisher's discriminant), else
 *    its nearest ring points' vote. The step stays sharp; a height never leaves its level's ring range.
 * 3. Two uses: `resurfacePoint` moves a vertex along n onto the model (the mesh keeps its topology, its texture keeps its
 *    plan place), and `closeLoop` closes an open loop: ear clipping in the chart, interior points on a grid inserted by
 *    triangle split, Lawson flips on interior edges only, so the patch's boundary edges are exactly the loop's edges
 *    (watertight against the rim) and the rim keeps its measured heights.
 *
 * Nothing here knows what the surface is: a ring of measured points, a normal and continuous tolerances.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';

export const INFILL_GEOMETRY_PARAMS = {
    /** A ring whose fitted normal is within this cosine of up is charted from straight above in plan. */
    levelCos: 0.85,
    /** Levels: residuals split where the nearest cross-level ring points differ by at least this (m): a kerb's rise is 0.1-0.2 m. */
    stepMinM: 0.06,
    /** A level needs at least this many ring points and this share of them. */
    levelMinPoints: 6, levelMinShare: 0.08,
    /** At most this many levels. */
    maxLevels: 3,
    /** The cross-level pairs read for the step test (the closest in plan). */
    stepPairs: 12,
    /** A straight breakline when Fisher's line separates at least this share of the two levels' ring points. */
    breaklineAccuracy: 0.92,
    /** Nearest ring points voting for a point's level (no straight breakline). */
    levelVoteK: 5,
    /** The local quadrics: Gaussian sigma at least this (m), growing to the distance of the k-th nearest ring point of the level. */
    sigmaMinM: 1.0, sigmaK: 12, surroundReach: 1.5,
    /** Past deepFromM from the nearest ring point the fit blends into the ring's weighted mean, wholly by deepToM (m). */
    deepFromM: 3, deepToM: 7,
    /** A grid node's quadric reads at most this many of its level's nearest ring points (a thin ring alone does not pin a curvature down). */
    fitPoints: 160,
    /** Past the ring a height may leave the ring's range by this slope times its distance from the nearest ring point. */
    extrapolateSlope: 0.15,
    /** Ridge on the local quadric's curvature terms (share of the weight): small, so a surrounded point keeps its curvature. */
    curvatureRidge: 1e-3,
    /**
     * The curvature is used only where the quadric's weighted residual is under curvatureGain of the plane's, and it moves
     * the plane by at most curvatureMinM or curvatureSlope times the reach (a street's crown: 2 % over the half-width), so
     * the ring's noise never sags a wide region into a bowl.
     */
    curvatureGain: 0.7, curvatureMinM: 0.08, curvatureSlope: 0.04,
    /** The model is evaluated on a grid of this cell (m) per level and read bilinearly. */
    gridCellM: 0.25,
    /** A height never leaves its level's ring range by more than this (m): no bulge, no pit. */
    rangeSlackM: 0.05,
    /** Two ring points within the link reach (at least linkM, m) are one surface when they differ by less than stepMinM / 2 or smoothSlope times their distance. */
    linkM: 0.6, smoothSlope: 0.12
};
export type InfillGeometryParams = typeof INFILL_GEOMETRY_PARAMS;

/** A local frame on a surface: world p = origin + a u + b v + w n; texel (i, k) is centred at a = (i + 0.5) texelM, b = (k + 0.5) texelM. */
export interface InfillChart {
    origin: Vec3; u: Vec3; v: Vec3; n: Vec3;
    texelM: number; width: number; height: number;
    /** True when charted from straight above in plan (u = +x, v = +z, n = +y). */
    plan: boolean;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** World point -> chart (a, b in metres along u, v; w along n). */
export function toChart(c: InfillChart, x: number, y: number, z: number): [number, number, number] {
    const dx = x - c.origin[0], dy = y - c.origin[1], dz = z - c.origin[2];
    return [dx * c.u[0] + dy * c.u[1] + dz * c.u[2], dx * c.v[0] + dy * c.v[1] + dz * c.v[2], dx * c.n[0] + dy * c.n[1] + dz * c.n[2]];
}

/** Chart (a, b, w) -> world point. */
export function fromChart(c: InfillChart, a: number, b: number, w: number): Vec3 {
    return [c.origin[0] + a * c.u[0] + b * c.v[0] + w * c.n[0], c.origin[1] + a * c.u[1] + b * c.v[1] + w * c.n[1], c.origin[2] + a * c.u[2] + b * c.v[2] + w * c.n[2]];
}

/** The normal of a point set: the smallest-eigenvalue direction of its covariance (power iteration on the shifted matrix). */
export function fitNormal(points: Float32Array | number[], hint: Vec3 = [0, 1, 0]): { n: Vec3; centroid: Vec3; flatness: number } {
    const m = points.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < m; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2]; }
    cx /= m || 1; cy /= m || 1; cz /= m || 1;
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < m; i++) {
        const d = [points[i * 3] - cx, points[i * 3 + 1] - cy, points[i * 3 + 2] - cz];
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r * 3 + s] += d[r] * d[s];
    }
    // the largest eigenvalue by power iteration, then the smallest of (tr I - C)'s complement: iterate on (sI - C)
    const mul = (M: number[], x: number[]) => [M[0] * x[0] + M[1] * x[1] + M[2] * x[2], M[3] * x[0] + M[4] * x[1] + M[5] * x[2], M[6] * x[0] + M[7] * x[1] + M[8] * x[2]];
    const tr = C[0] + C[4] + C[8] || 1;
    const S = C.map((v, i) => (i % 4 === 0 ? tr - v : -v));
    let x = [hint[0] + 1e-3, hint[1] + 2e-3, hint[2] + 3e-3];
    for (let it = 0; it < 64; it++) { const y = mul(S, x); const l = Math.hypot(y[0], y[1], y[2]) || 1; x = [y[0] / l, y[1] / l, y[2] / l]; }
    let n = norm(x as Vec3);
    if (dot(n, hint) < 0) n = [-n[0], -n[1], -n[2]];
    const lam = dot(n, mul(C, n)) / (m || 1);
    return { n, centroid: [cx, cy, cz], flatness: Math.sqrt(Math.max(0, lam)) };
}

/**
 * The chart for a region: its normal from the ring (or `normal`), level surfaces in plan, the extent the hole's points
 * plus `marginM`, the texel grown so neither side passes `maxSide`.
 */
export function fitChart(input: { ring: Float32Array; hole: Float32Array; texelM: number; marginM: number; maxSide?: number; normalHint?: Vec3; normal?: Vec3 }, P: InfillGeometryParams = INFILL_GEOMETRY_PARAMS): InfillChart {
    const pts = input.ring.length >= 9 ? input.ring : input.hole;
    const fit = input.normal ? { n: norm(input.normal) } : fitNormal(pts, input.normalHint ?? [0, 1, 0]);
    let n = fit.n;
    let u: Vec3, v: Vec3, plan = false;
    if (Math.abs(n[1]) >= P.levelCos && (input.normalHint ?? [0, 1, 0])[1] >= 0) { u = [1, 0, 0]; v = [0, 0, 1]; n = [0, 1, 0]; plan = true; }
    else {
        const ref: Vec3 = Math.abs(n[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
        u = norm(cross(ref, n));
        v = norm(cross(n, u));
    }
    let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
    const ext = input.hole.length >= 3 ? input.hole : pts;
    for (let i = 0; i + 2 < ext.length; i += 3) {
        const a = ext[i] * u[0] + ext[i + 1] * u[1] + ext[i + 2] * u[2], b = ext[i] * v[0] + ext[i + 1] * v[1] + ext[i + 2] * v[2];
        a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    a0 -= input.marginM; b0 -= input.marginM; a1 += input.marginM; b1 += input.marginM;
    // the origin's height along n: the ring's mean (so w is small and readable)
    let wSum = 0, wN = 0;
    for (let i = 0; i + 2 < pts.length; i += 3) { wSum += pts[i] * n[0] + pts[i + 1] * n[1] + pts[i + 2] * n[2]; wN++; }
    const w0 = wN ? wSum / wN : 0;
    const maxSide = input.maxSide ?? 2048;
    const texelM = Math.max(input.texelM, (a1 - a0) / maxSide, (b1 - b0) / maxSide);
    const origin: Vec3 = [a0 * u[0] + b0 * v[0] + w0 * n[0], a0 * u[1] + b0 * v[1] + w0 * n[1], a0 * u[2] + b0 * v[2] + w0 * n[2]];
    return { origin, u, v, n, texelM, width: Math.max(1, Math.ceil((a1 - a0) / texelM)), height: Math.max(1, Math.ceil((b1 - b0) / texelM)), plan };
}

// ------------------------------------------------------------------------------------------------ the surface model

export interface SurfaceModel {
    chart: InfillChart;
    /** How it was fitted: one surface, or levels split by a step. */
    kind: 'surface' | 'stepped';
    levels: Array<{ points: number; meanW: number; loW: number; hiW: number }>;
    /** The straight breakline between two levels (a a + b b + c >= 0: level 1), with the share of ring points it separates. */
    breakline?: { na: number; nb: number; c: number; accuracy: number };
    /** RMS of the ring's heights against the model (m). */
    ringRmsM: number;
    /** Ring points it was fitted to. */
    ringPoints: number;
    levelAt(a: number, b: number): number;
    heightAt(a: number, b: number): number;
    /** Why the model is what it is (for the provenance reason). */
    note: string;
}

/** Solves the n x n system M x = r (row-major) by elimination with partial pivoting; undefined when singular. */
function solveN(M0: Float64Array, r0: Float64Array, n: number): Float64Array | undefined {
    const M = Float64Array.from(M0), r = Float64Array.from(r0);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let k = c + 1; k < n; k++) if (Math.abs(M[k * n + c]) > Math.abs(M[p * n + c])) p = k;
        if (Math.abs(M[p * n + c]) < 1e-12) return undefined;
        if (p !== c) { for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; } const t = r[c]; r[c] = r[p]; r[p] = t; }
        for (let k = c + 1; k < n; k++) {
            const f = M[k * n + c] / M[c * n + c];
            if (!f) continue;
            for (let j = c; j < n; j++) M[k * n + j] -= f * M[c * n + j];
            r[k] -= f * r[c];
        }
    }
    const x = new Float64Array(n);
    for (let c = n - 1; c >= 0; c--) { let v = r[c]; for (let j = c + 1; j < n; j++) v -= M[c * n + j] * x[j]; x[c] = v / M[c * n + c]; }
    return x;
}

/**
 * The ring's levels: its points joined wherever two within the link reach differ by less than a smooth surface's rise
 * (stepMinM / 2, or smoothSlope times their distance), so a grade or a camber stays one level and a kerb, a stair or a
 * plinth cuts it; pieces whose closest points meet without a step (a gap in the sampling, a steeper patch) joined again.
 * The largest pieces are the levels (at most maxLevels); a small piece joins the level it meets without a step, else its
 * points are left out of the fit (a kerb's own face, scan noise).
 */
function smoothLevels(A: Float64Array, B: Float64Array, W: Float64Array, P: InfillGeometryParams): number[][] {
    const m = A.length;
    // the link reach: at least linkM, and 2.5 times the typical nearest-neighbour spacing
    const cell0 = Math.max(P.linkM, 0.25);
    const key = (a: number, b: number, c: number) => `${Math.floor(a / c)},${Math.floor(b / c)}`;
    const bucket = (c: number) => { const g = new Map<string, number[]>(); for (let i = 0; i < m; i++) { const k = key(A[i], B[i], c); let l = g.get(k); if (!l) g.set(k, l = []); l.push(i); } return g; };
    let grid = bucket(cell0);
    const nn: number[] = [];
    for (let i = 0; i < m; i += Math.max(1, Math.floor(m / 400))) {
        let best = Infinity;
        const ci = Math.floor(A[i] / cell0), cj = Math.floor(B[i] / cell0);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const j of grid.get(`${ci + di},${cj + dj}`) ?? []) if (j !== i) best = Math.min(best, (A[i] - A[j]) ** 2 + (B[i] - B[j]) ** 2);
        if (best < Infinity) nn.push(Math.sqrt(best));
    }
    nn.sort((x, y) => x - y);
    const link = Math.max(P.linkM, 2.5 * (nn[nn.length >> 1] ?? P.linkM));
    if (link > cell0) grid = bucket(link);
    const cell = Math.max(cell0, link);
    const parent = Int32Array.from({ length: m }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const smooth = (i: number, j: number, d: number) => Math.abs(W[i] - W[j]) <= Math.max(P.stepMinM / 2, P.smoothSlope * d);
    for (let i = 0; i < m; i++) {
        const ci = Math.floor(A[i] / cell), cj = Math.floor(B[i] / cell);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const j of grid.get(`${ci + di},${cj + dj}`) ?? []) {
            if (j <= i) continue;
            const d = Math.hypot(A[i] - A[j], B[i] - B[j]);
            if (d <= link && smooth(i, j, d)) parent[find(i)] = find(j);
        }
    }
    const pieces = (): number[][] => { const by = new Map<number, number[]>(); for (let i = 0; i < m; i++) { const r = find(i); let l = by.get(r); if (!l) by.set(r, l = []); l.push(i); } return [...by.values()].sort((x, y) => y.length - x.length); };
    // pieces that meet without a step are one level: the closest cross pairs' rise, less a smooth surface's, under the step
    // a step is one side consistently higher: the signed rise of the closest cross pairs (q over p), less a smooth
    // surface's over their distance; noise between two pieces of one surface scatters both ways and medians out near zero
    const meetsSmoothly = (p: number[], q: number[]) => {
        const pairs: Array<{ d: number; rise: number }> = [];
        for (const i of p) for (const j of q) {
            const d = Math.hypot(A[i] - A[j], B[i] - B[j]);
            if (pairs.length < P.stepPairs || d < pairs[pairs.length - 1].d) {
                pairs.push({ d, rise: W[j] - W[i] });
                pairs.sort((x, y) => x.d - y.d);
                if (pairs.length > P.stepPairs) pairs.pop();
            }
        }
        if (!pairs.length) return false;
        const r = pairs.map(x => x.rise).sort((x, y) => x - y), d = pairs.map(x => x.d).sort((x, y) => x - y);
        return Math.abs(r[r.length >> 1]) - P.smoothSlope * d[d.length >> 1] < 0.7 * P.stepMinM;
    };
    let ps = pieces();
    for (let changed = true; changed && ps.length > 1;) {
        changed = false;
        outer: for (let x = 0; x < ps.length; x++) for (let y = x + 1; y < ps.length; y++) {
            if (meetsSmoothly(ps[x], ps[y])) { parent[find(ps[y][0])] = find(ps[x][0]); ps = pieces(); changed = true; break outer; }
        }
    }
    const minN = Math.max(P.levelMinPoints, Math.ceil(P.levelMinShare * m));
    const major = ps.filter(p => p.length >= minN).slice(0, P.maxLevels);
    if (major.length <= 1) return [Array.from({ length: m }, (_, i) => i)];
    // the small pieces: into the level they meet without a step, else out of the fit
    const groups = major.map(p => p.slice());
    for (const p of ps) {
        if (major.includes(p)) continue;
        const into = major.findIndex(q => meetsSmoothly(p, q));
        if (into >= 0) groups[into].push(...p);
    }
    return groups;
}

/** Fisher's discriminant line between two point sets in plan: classifies (a, b) as set 1 when na a + nb b + c >= 0. */
function fisherLine(A: Float64Array, B: Float64Array, s0: number[], s1: number[]): { na: number; nb: number; c: number; accuracy: number } {
    const mean = (s: number[]) => { let a = 0, b = 0; for (const i of s) { a += A[i]; b += B[i]; } return [a / s.length, b / s.length]; };
    const [a0, b0] = mean(s0), [a1, b1] = mean(s1);
    let saa = 1e-6, sab = 0, sbb = 1e-6;
    for (const [s, ma, mb] of [[s0, a0, b0], [s1, a1, b1]] as Array<[number[], number, number]>) for (const i of s) { const da = A[i] - ma, db = B[i] - mb; saa += da * da; sab += da * db; sbb += db * db; }
    const det = saa * sbb - sab * sab;
    const da = a1 - a0, db = b1 - b0;
    let na = (sbb * da - sab * db) / det, nb = (-sab * da + saa * db) / det;
    const l = Math.hypot(na, nb) || 1;
    na /= l; nb /= l;
    // the threshold that separates best along the line (sorted projections)
    const proj = [...s0.map(i => ({ p: na * A[i] + nb * B[i], c: 0 })), ...s1.map(i => ({ p: na * A[i] + nb * B[i], c: 1 }))].sort((x, y) => x.p - y.p);
    let right1 = s1.length, left0 = 0, bestOk = -1, bestT = 0;
    for (let k = 0; k <= proj.length; k++) {
        const ok = left0 + right1;
        if (ok > bestOk) { bestOk = ok; bestT = k === 0 ? proj[0].p - 1e-3 : k === proj.length ? proj[k - 1].p + 1e-3 : (proj[k - 1].p + proj[k].p) / 2; }
        if (k < proj.length) { if (proj[k].c === 0) left0++; else right1--; }
    }
    return { na, nb, c: -bestT, accuracy: bestOk / proj.length };
}

/**
 * The surface model of a region from its measured ring (world points). Heights are along the chart's normal; see the file
 * comment for the levels, the breakline and the local quadrics.
 */
export function fitSurfaceModel(ring: Float32Array, chart: InfillChart, P: InfillGeometryParams = INFILL_GEOMETRY_PARAMS): SurfaceModel {
    const m = Math.floor(ring.length / 3);
    const A = new Float64Array(m), B = new Float64Array(m), W = new Float64Array(m);
    for (let i = 0; i < m; i++) { const c = toChart(chart, ring[i * 3], ring[i * 3 + 1], ring[i * 3 + 2]); A[i] = c[0]; B[i] = c[1]; W[i] = c[2]; }
    if (m < 3) {
        const w = m ? W.reduce((s, x) => s + x, 0) / m : 0;
        return { chart, kind: 'surface', levels: [{ points: m, meanW: w, loW: w, hiW: w }], ringRmsM: 0, ringPoints: m, levelAt: () => 0, heightAt: () => w, note: m ? `only ${m} measured point${m === 1 ? '' : 's'} around it: a level surface at their height` : 'no measured point around it: the chart plane itself' };
    }
    const res = W;
    const groups = smoothLevels(A, B, W, P);
    // order the levels low to high
    groups.sort((x, y) => x.reduce((s, i) => s + res[i], 0) / x.length - y.reduce((s, i) => s + res[i], 0) / y.length);
    // points in no level (a kerb's own face, noise) stay out of the fit
    const level = new Int32Array(m).fill(-1);
    groups.forEach((g, l) => { for (const i of g) level[i] = l; });
    let breakline: SurfaceModel['breakline'];
    if (groups.length === 2) {
        const f = fisherLine(A, B, groups[0], groups[1]);
        if (f.accuracy >= P.breaklineAccuracy) breakline = f;
    }
    // a plan index of the ring points (for the level vote and the local sigma)
    const cell = Math.max(0.5, P.gridCellM * 4);
    let bi0 = Infinity, bi1 = -Infinity, bj0 = Infinity, bj1 = -Infinity;
    for (let i = 0; i < m; i++) { const ci = Math.floor(A[i] / cell), cj = Math.floor(B[i] / cell); bi0 = Math.min(bi0, ci); bi1 = Math.max(bi1, ci); bj0 = Math.min(bj0, cj); bj1 = Math.max(bj1, cj); }
    // dense buckets over the ring's cells
    const bw = bi1 - bi0 + 1, bh = bj1 - bj0 + 1;
    const buckets: number[][] = Array.from({ length: bw * bh }, () => []);
    for (let i = 0; i < m; i++) buckets[(Math.floor(B[i] / cell) - bj0) * bw + (Math.floor(A[i] / cell) - bi0)].push(i);
    const nearest = (a: number, b: number, k: number, filter?: (i: number) => boolean): Array<{ i: number; d2: number }> => {
        const ci = Math.floor(a / cell), cj = Math.floor(b / cell);
        const out: Array<{ i: number; d2: number }> = [];
        // past this ring every bucket has been searched
        const rMax = Math.max(Math.abs(ci - bi0), Math.abs(ci - bi1), Math.abs(cj - bj0), Math.abs(cj - bj1));
        const visit = (x: number, y: number) => {
            if (x < bi0 || x > bi1 || y < bj0 || y > bj1) return;
            for (const i of buckets[(y - bj0) * bw + (x - bi0)]) if (!filter || filter(i)) out.push({ i, d2: (A[i] - a) ** 2 + (B[i] - b) ** 2 });
        };
        for (let r = 0; r <= rMax; r++) {
            if (r === 0) visit(ci, cj);
            else for (let d = -r; d <= r; d++) { visit(ci + d, cj - r); visit(ci + d, cj + r); if (d > -r && d < r) { visit(ci - r, cj + d); visit(ci + r, cj + d); } }
            // ring r is searched; anything beyond it is at least r * cell away
            if (out.length >= k) { out.sort((x, y) => x.d2 - y.d2); if (out[k - 1].d2 <= (r * cell) ** 2) return out.slice(0, k); }
        }
        out.sort((x, y) => x.d2 - y.d2);
        return out.slice(0, k);
    };
    const levelAt = (a: number, b: number): number => {
        if (groups.length === 1) return 0;
        if (breakline) return breakline.na * a + breakline.nb * b + breakline.c >= 0 ? 1 : 0;
        const votes = new Float64Array(groups.length);
        for (const { i, d2 } of nearest(a, b, P.levelVoteK, i => level[i] >= 0)) votes[level[i]] += 1 / (Math.sqrt(d2) + 0.05);
        let best = 0;
        for (let l = 1; l < votes.length; l++) if (votes[l] > votes[best]) best = l;
        return best;
    };
    // each level's local quadrics on a grid over the chart
    const gc = Math.max(P.gridCellM, chart.texelM);
    const extentA = chart.width * chart.texelM, extentB = chart.height * chart.texelM;
    const gw = Math.max(2, Math.ceil(extentA / gc) + 2), gh = Math.max(2, Math.ceil(extentB / gc) + 2);
    const grids: Float32Array[] = [];
    const ranges = groups.map(g => { let lo = Infinity, hi = -Infinity; for (const i of g) { lo = Math.min(lo, W[i]); hi = Math.max(hi, W[i]); } return [lo - P.rangeSlackM, hi + P.rangeSlackM]; });
    groups.forEach((g, l) => {
        const grid = new Float32Array(gw * gh);
        const inLevel = (i: number) => level[i] === l;
        const k = Math.min(P.sigmaK, g.length);
        for (let gk = 0; gk < gh; gk++) for (let gi = 0; gi < gw; gi++) {
            const a = (gi - 0.5) * gc, b = (gk - 0.5) * gc;
            // the level's nearest points (enough for the quadric's reach); sigma from the k-th of them
            let near = nearest(a, b, Math.min(g.length, P.fitPoints), inLevel);
            const d1 = Math.sqrt(near[0]?.d2 ?? 0), dk = Math.sqrt(near[Math.min(k, near.length) - 1]?.d2 ?? 0);
            // surrounded: the ring has points on at least three sides within 2.5 times the nearest (inside the region,
            // not out past the ring where the scan itself is the surface)
            const quads = new Uint8Array(4);
            for (const { i, d2 } of near) if (d2 <= (2.5 * d1 + gc) ** 2) quads[(A[i] >= a ? 1 : 0) + (B[i] >= b ? 2 : 0)] = 1;
            const surrounded = quads[0] + quads[1] + quads[2] + quads[3] >= 3;
            // deep inside a wide region the reach passes the nearest points read: the whole level is read instead
            if (surrounded && near.length < g.length && P.surroundReach * d1 > Math.sqrt(near[near.length - 1].d2) / 2) near = g.map(i => ({ i, d2: (A[i] - a) ** 2 + (B[i] - b) ** 2 }));
            // the reach: at least the k-th nearest point, and surroundReach times the nearest, so deep inside a wide region
            // the ring's far side weighs in too (no slope of the near side extrapolated across it)
            const sigma = Math.max(P.sigmaMinM, dk, surrounded ? P.surroundReach * d1 : 0);
            const s2 = 2 * sigma * sigma;
            // the local quadric through the level's points within 3 sigma (all of them when few), in sigma-scaled
            // coordinates: a camber's curvature is kept inside the ring; the curvature terms are held to zero by a light
            // ridge where the ring does not surround the point (one side only), so it falls back to a plane, then a mean
            const M = new Float64Array(36), r = new Float64Array(6);
            let wsum = 0, wy = 0;
            const x = new Float64Array(6);
            for (const { i, d2 } of near) {
                const q = Math.exp(-d2 / s2);
                const u = (A[i] - a) / sigma, v = (B[i] - b) / sigma;
                x[0] = 1; x[1] = u; x[2] = v; x[3] = u * u; x[4] = u * v; x[5] = v * v;
                for (let s = 0; s < 6; s++) { r[s] += q * x[s] * W[i]; for (let t = 0; t < 6; t++) M[s * 6 + t] += q * x[s] * x[t]; }
                wsum += q; wy += q * W[i];
            }
            for (let s = 0; s < 6; s++) M[s * 7] += (s >= 3 ? P.curvatureRidge : 1e-6) * wsum;
            // the plane alone (the quadric's first three terms), and the quadric only where its curvature is real: it fits
            // the ring clearly better than the plane, and it moves the plane by no more than a street's crown over the reach
            const M3 = new Float64Array(9), r3 = new Float64Array(3);
            for (let s2 = 0; s2 < 3; s2++) { r3[s2] = r[s2]; for (let t = 0; t < 3; t++) M3[s2 * 3 + t] = M[s2 * 6 + t]; }
            const sol3 = wsum > 1e-9 ? solveN(M3, r3, 3) : undefined;
            const sol = wsum > 1e-9 ? solveN(M, r, 6) : undefined;
            const planeH = sol3 && Number.isFinite(sol3[0]) ? sol3[0] : wsum > 0 ? wy / wsum : 0;
            let h = planeH;
            if (sol && Number.isFinite(sol[0]) && sol3) {
                let e3 = 0, e6 = 0;
                for (const { i, d2 } of near) {
                    const q = Math.exp(-d2 / s2), u = (A[i] - a) / sigma, v = (B[i] - b) / sigma;
                    e3 += q * (W[i] - (sol3[0] + sol3[1] * u + sol3[2] * v)) ** 2;
                    e6 += q * (W[i] - (sol[0] + sol[1] * u + sol[2] * v + sol[3] * u * u + sol[4] * u * v + sol[5] * v * v)) ** 2;
                }
                if (e6 < P.curvatureGain * e3) {
                    const dev = Math.max(P.curvatureMinM, P.curvatureSlope * sigma);
                    h = planeH + Math.max(-dev, Math.min(dev, sol[0] - planeH));
                }
            }
            // deep inside a wide region (deepFromM..deepToM from the ring) the fit's slope would be carried across metres
            // of unmeasured ground: it blends into the ring's weighted mean there (the plane's own value at the middle of a
            // ring around it, and never further than the ring's heights)
            const deep = surrounded ? Math.max(0, Math.min(1, (d1 - P.deepFromM) / (P.deepToM - P.deepFromM))) : 0;
            if (deep > 0 && wsum > 0) h = (1 - deep) * h + deep * (wy / wsum);
            // within the ring's range, widening outward at a steep street's grade (no bulge inside, extrapolation outside)
            const reach = P.extrapolateSlope * d1;
            h = Math.max(ranges[l][0] - reach, Math.min(ranges[l][1] + reach, h));
            grid[gk * gw + gi] = h;
        }
        grids.push(grid);
    });
    const heightOn = (l: number, a: number, b: number): number => {
        const fx = Math.max(0, Math.min(gw - 1.0001, a / gc + 0.5)), fz = Math.max(0, Math.min(gh - 1.0001, b / gc + 0.5));
        const i0 = Math.floor(fx), k0 = Math.floor(fz), ax = fx - i0, az = fz - k0, g = grids[l];
        return (1 - az) * ((1 - ax) * g[k0 * gw + i0] + ax * g[k0 * gw + i0 + 1]) + az * ((1 - ax) * g[(k0 + 1) * gw + i0] + ax * g[(k0 + 1) * gw + i0 + 1]);
    };
    const heightAt = (a: number, b: number) => heightOn(levelAt(a, b), a, b);
    let se = 0, used = 0;
    for (let i = 0; i < m; i++) if (level[i] >= 0) { se += (W[i] - heightOn(level[i], A[i], B[i])) ** 2; used++; }
    const ringRmsM = Math.sqrt(se / Math.max(1, used));
    const levels = groups.map((g, l) => ({ points: g.length, meanW: g.reduce((s, i) => s + W[i], 0) / g.length, loW: ranges[l][0] + P.rangeSlackM, hiW: ranges[l][1] - P.rangeSlackM }));
    const stepM = groups.length > 1 ? levels[levels.length - 1].meanW - levels[0].meanW : 0;
    const note = groups.length > 1
        ? `${groups.length} levels in the measured ring (a step of ${stepM.toFixed(2)} m), each rebuilt as its own surface from its ${groups.map(g => g.length).join(' / ')} ring points; ${breakline ? `a straight breakline between them (separates ${Math.round(breakline.accuracy * 100)} % of the ring)` : "each point on its nearest ring points' level"}; ring RMS ${(ringRmsM * 100).toFixed(1)} cm`
        : `one surface through ${m} measured ring points (local quadrics: grade and camber kept); ring RMS ${(ringRmsM * 100).toFixed(1)} cm`;
    return { chart, kind: groups.length > 1 ? 'stepped' : 'surface', levels, ...(breakline ? { breakline } : {}), ringRmsM, ringPoints: m, levelAt, heightAt, note };
}

/** A world point moved along the chart's normal onto the model (its plan place, its texture, kept). */
export function resurfacePoint(model: SurfaceModel, x: number, y: number, z: number): Vec3 {
    const [a, b] = toChart(model.chart, x, y, z);
    return fromChart(model.chart, a, b, model.heightAt(a, b));
}

// ------------------------------------------------------------------------------------------------ closing a loop

export interface ClosedLoop {
    /** World positions: the loop's own vertices first (in its order, unmoved), then the interior points. */
    positions: Float32Array;
    indices: Uint32Array;
    loopVertices: number;
    interiorVertices: number;
    /** Loop edges used once each and interior edges twice: the patch meets its rim exactly. */
    watertight: boolean;
    flips: number;
}

/**
 * Closes an open loop (world points, in order) with a patch on the model: ear clipping in the chart, interior points every
 * `spacingM` (kept `spacingM / 2` off the loop) inserted by triangle split, Lawson flips on interior edges only. The loop's
 * vertices keep their measured positions; interior points stand on the model. Undefined when the loop is not a simple
 * polygon in the chart (it folds over itself seen along the normal).
 */
export function closeLoop(loop: Float32Array, model: SurfaceModel, spacingM: number): ClosedLoop | undefined {
    const c = model.chart;
    const nL = Math.floor(loop.length / 3);
    if (nL < 3) return undefined;
    const pa: number[] = [], pb: number[] = [];
    for (let i = 0; i < nL; i++) { const q = toChart(c, loop[i * 3], loop[i * 3 + 1], loop[i * 3 + 2]); pa.push(q[0]); pb.push(q[1]); }
    let area = 0;
    for (let i = 0; i < nL; i++) { const j = (i + 1) % nL; area += pa[i] * pb[j] - pa[j] * pb[i]; }
    if (Math.abs(area) < 1e-9) return undefined;
    const ccw = area > 0;
    const orient = (i: number, j: number, k: number) => (pa[j] - pa[i]) * (pb[k] - pb[i]) - (pa[k] - pa[i]) * (pb[j] - pb[i]);
    const inTri = (px: number, py: number, i: number, j: number, k: number) => {
        const d1 = (pa[j] - pa[i]) * (py - pb[i]) - (px - pa[i]) * (pb[j] - pb[i]);
        const d2 = (pa[k] - pa[j]) * (py - pb[j]) - (px - pa[j]) * (pb[k] - pb[j]);
        const d3 = (pa[i] - pa[k]) * (py - pb[k]) - (px - pa[k]) * (pb[i] - pb[k]);
        return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
    };
    // ear clipping (counter-clockwise working order)
    const ring = Array.from({ length: nL }, (_, i) => (ccw ? i : nL - 1 - i));
    const tris: number[][] = [];
    let guard = 0;
    while (ring.length > 3 && guard++ < nL * nL) {
        let bestK = -1, bestLen = Infinity;
        for (let k = 0; k < ring.length; k++) {
            const i = ring[(k + ring.length - 1) % ring.length], j = ring[k], l = ring[(k + 1) % ring.length];
            if (orient(i, j, l) <= 1e-12) continue;
            let empty = true;
            for (const q of ring) { if (q === i || q === j || q === l) continue; if (inTri(pa[q], pb[q], i, j, l)) { empty = false; break; } }
            if (!empty) continue;
            const len = Math.hypot(pa[l] - pa[i], pb[l] - pb[i]);
            if (len < bestLen) { bestLen = len; bestK = k; }
        }
        if (bestK < 0) return undefined;
        const i = ring[(bestK + ring.length - 1) % ring.length], j = ring[bestK], l = ring[(bestK + 1) % ring.length];
        tris.push([i, j, l]);
        ring.splice(bestK, 1);
    }
    if (ring.length === 3) { if (orient(ring[0], ring[1], ring[2]) <= 1e-12) return undefined; tris.push([ring[0], ring[1], ring[2]]); }
    const loopEdge = new Set<string>();
    for (let i = 0; i < nL; i++) { const j = (i + 1) % nL; loopEdge.add(i < j ? `${i},${j}` : `${j},${i}`); }
    // interior points on a grid, away from the loop
    const segDist2 = (px: number, py: number) => {
        let best = Infinity;
        for (let i = 0; i < nL; i++) {
            const j = (i + 1) % nL, ex = pa[j] - pa[i], ey = pb[j] - pb[i], L2 = ex * ex + ey * ey || 1e-12;
            const t = Math.max(0, Math.min(1, ((px - pa[i]) * ex + (py - pb[i]) * ey) / L2));
            best = Math.min(best, (px - pa[i] - t * ex) ** 2 + (py - pb[i] - t * ey) ** 2);
        }
        return best;
    };
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < nL; i++) { a0 = Math.min(a0, pa[i]); a1 = Math.max(a1, pa[i]); b0 = Math.min(b0, pb[i]); b1 = Math.max(b1, pb[i]); }
    const s = Math.max(1e-3, spacingM);
    const inPoly = (px: number, py: number) => {
        let inside = false;
        for (let i = 0, j = nL - 1; i < nL; j = i++) if ((pb[i] > py) !== (pb[j] > py) && px < ((pa[j] - pa[i]) * (py - pb[i])) / (pb[j] - pb[i]) + pa[i]) inside = !inside;
        return inside;
    };
    for (let y = b0 + s / 2; y < b1; y += s) for (let x = a0 + s / 2; x < a1; x += s) {
        if (!inPoly(x, y) || segDist2(x, y) < (s / 2) ** 2) continue;
        // insert: split the triangle that holds it
        const t = tris.findIndex(([i, j, k]) => inTri(x, y, i, j, k));
        if (t < 0) continue;
        const q = pa.length;
        pa.push(x); pb.push(y);
        const [i, j, k] = tris[t];
        tris.splice(t, 1, [i, j, q], [j, k, q], [k, i, q]);
    }
    // Lawson flips on interior edges (never a loop edge)
    let flips = 0;
    const inCircle = (i: number, j: number, k: number, p: number) => {
        const ax = pa[i] - pa[p], ay = pb[i] - pb[p], bx = pa[j] - pa[p], by = pb[j] - pb[p], cx = pa[k] - pa[p], cy = pb[k] - pb[p];
        return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 1e-12;
    };
    for (let pass = 0; pass < 64; pass++) {
        const edges = new Map<string, Array<{ t: number; opp: number }>>();
        tris.forEach((tr, t) => { for (let e = 0; e < 3; e++) { const u = tr[e], v = tr[(e + 1) % 3]; const key = u < v ? `${u},${v}` : `${v},${u}`; let l = edges.get(key); if (!l) edges.set(key, l = []); l.push({ t, opp: tr[(e + 2) % 3] }); } });
        let changed = 0;
        const touched = new Set<number>();
        for (const [key, l] of edges) {
            if (l.length !== 2 || loopEdge.has(key)) continue;
            const [e0, e1] = l;
            if (touched.has(e0.t) || touched.has(e1.t)) continue;
            const [u, v] = key.split(',').map(Number);
            const t0 = tris[e0.t];
            // t0 holds u -> v in its winding (or v -> u); keep counter-clockwise triangles after the flip
            const iu = t0.indexOf(u), uvForward = t0[(iu + 1) % 3] === v;
            const [p, q] = uvForward ? [u, v] : [v, u];
            const a = e0.opp, b = e1.opp;
            if (!inCircle(p, q, a, b)) continue;
            // the quad a-p-b-q must be convex to flip
            if (orient(a, p, b) <= 1e-12 || orient(b, q, a) <= 1e-12) continue;
            tris[e0.t] = [a, p, b];
            tris[e1.t] = [b, q, a];
            touched.add(e0.t); touched.add(e1.t);
            changed++;
        }
        flips += changed;
        if (!changed) break;
    }
    // the world positions: the loop's own, then interior points on the model
    const positions = new Float32Array(pa.length * 3);
    for (let i = 0; i < nL; i++) { positions[i * 3] = loop[i * 3]; positions[i * 3 + 1] = loop[i * 3 + 1]; positions[i * 3 + 2] = loop[i * 3 + 2]; }
    for (let i = nL; i < pa.length; i++) { const p = fromChart(c, pa[i], pb[i], model.heightAt(pa[i], pb[i])); positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2]; }
    // the winding faces the chart's normal (n = u x v when the chart is right-handed; plan charts have u x v = -n)
    const flip = (dot(cross(c.u, c.v), c.n) > 0) !== true;
    const indices = new Uint32Array(tris.length * 3);
    tris.forEach((t, k) => { indices[k * 3] = t[0]; indices[k * 3 + 1] = flip ? t[2] : t[1]; indices[k * 3 + 2] = flip ? t[1] : t[2]; });
    const count = new Map<string, number>();
    for (const t of tris) for (let e = 0; e < 3; e++) { const u = t[e], v = t[(e + 1) % 3]; const key = u < v ? `${u},${v}` : `${v},${u}`; count.set(key, (count.get(key) ?? 0) + 1); }
    let watertight = true;
    for (const [key, k] of count) if ((loopEdge.has(key) && k !== 1) || (!loopEdge.has(key) && k !== 2)) { watertight = false; break; }
    for (const key of loopEdge) if (count.get(key) !== 1) { watertight = false; break; }
    return { positions, indices, loopVertices: nL, interiorVertices: pa.length - nL, watertight, flips };
}
