/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K: a facade orthophoto straightened and its smears levelled, before the facade is rebuilt on it.
 *
 * The photogrammetric texture of a 3D tile is stitched from several views onto wobbly geometry, so in a facade's ortho
 * a pier edge that is straight on the building bends along its height, by a different amount at every storey. One shift
 * per line (pipeline-e/straighten.ts) cannot undo that. Here:
 *
 *  1. Lines: column and row edge-energy peaks of the ortho (as facade-lattice.ts), each with its edge polarity.
 *  2. Curves: each line traced along its length by dynamic programming (Viterbi over the offsets within maxShiftM, the
 *     signed gradient of its own polarity as the reward, a cost per pixel of bend), so the trace follows the edge as it
 *     wanders and does not jump to the opposite edge of a pier. Samples with a weak edge carry no weight. Where a trace
 *     loses its edge for longer than segmentGapM, it splits: each segment is straightened to its own weighted median, so a
 *     real offset between tiers is never forced into one line.
 *  3. Warp: a content-preserving mesh warp (Liu et al. 2009; the line terms of Li et al. 2017, "Image stitching by
 *     line-guided local warping with global similarity constraint"; TwinTex, 2023, uses the same three terms for facade
 *     photos). A grid in the output holds, per vertex, where in the source it samples. Energy, all quadratic:
 *       line term       every traced sample lands on its straight line (axis-aligned, so its distance to the line is one
 *                       coordinate of a bilinear blend of four vertices);
 *       similarity term every grid triangle stays a similarity transform of itself (V1 = V2 + mu (V3 - V2) + nu R90 (V3 - V2));
 *       anchor term     vertices stay where they were, weakly (unconstrained regions do not move);
 *       border term     the ortho's outline stays put, so the facade still meets its neighbours at the corners.
 *     Solved by preconditioned conjugate gradients on the normal equations. A warp that would fold (a source triangle
 *     shrinking below minJacobian of its area, or flipping) is scaled back toward the identity until it does not.
 *  4. Smears: the facade's horizontal repeat (the bay pitch: the first strong peak of the column profile's
 *     autocorrelation, as Liu, Psarakis and Stamos 2013 estimate a facade's periods) gives each pixel its repeats in the
 *     same row; their per-pixel median is the clean pattern (the median that model uses against occlusion and shadow).
 *     A smear is a low-frequency, vertically elongated darkening or brightening against that median (an anisotropic blur
 *     of the log ratio), well outside its spread; there the pixel's gain is levelled toward the median, bounded. The
 *     pixel's own detail is kept: only its brightness is corrected.
 *
 * Verified, per facade: the warp is kept only when the traced lines' mean distance from straight falls by at least
 * minGain and the lattice homogeneity (the median per-pixel spread across horizontal repeats, the localisation score of
 * Liu et al. 2015, "PatchMatch-based automatic lattice detection") does not get worse. Uncovered pixels (exact grey
 * 128) stay uncovered and are never sampled. Everything here reads the ortho's own pixels; nothing is drawn.
 */

import { medianOf } from '../pipeline-e/image-ops';

export const ORTHO_RECTIFY_VERSION = 'ortho-rectify/1';

export const ORTHO_RECTIFY_PARAMS = {
    /** A line is an edge-energy peak above mean + k sd of its profile (facade-lattice.ts). */
    peakK: 1.0,
    /** Lines closer than this merge (m). */
    minLineGapM: 0.4,
    /** A trace stays within this of its line's mean position (m). */
    maxShiftM: 0.35,
    /** The trace is sampled this often along its line (m). */
    trackStepM: 0.25,
    /** Viterbi cost per pixel of change between neighbouring samples, in units of the line's typical edge strength. */
    bendCost: 0.25,
    /** A sample is used when its edge is at least this share of the line's typical edge strength. */
    minEdge: 0.35,
    /** A segment needs at least this share of its samples on an edge, and this length (m). */
    minSupport: 0.5, minSegmentM: 3,
    /** A trace splits where its edge is lost for longer than this (m). */
    segmentGapM: 4,
    /** Which lines are traced: piers and jambs ('v'), storey lines ('h'). */
    traceVertical: true, traceHorizontal: true,
    /** Mesh spacing (m); weights of the line, similarity, anchor and border terms. */
    gridM: 0.75, wLine: 1, wSimilarity: 0.08, wAnchor: 0.001, wBorder: 1,
    /** Conjugate-gradient iterations and tolerance (relative residual). */
    cgIterations: 600, cgTolerance: 1e-6,
    /** No source triangle may shrink below this share of its output area. */
    minJacobian: 0.35,
    /** The warp is kept when the lines' distance from straight falls by at least this share. */
    minGain: 0.2,
    /** Horizontal repeat search range (m), and the autocorrelation its peak must reach. */
    periodMinM: 1.2, periodMaxM: 10, minPeriodNcc: 0.35,
    /** Repeats each side of a pixel used for its median, and how many must be covered (lattice homogeneity). */
    repeats: 3, minRepeats: 3,
    /** Smears: a repeat counts when its neighbourhood (half a pitch wide, this half-height in m) matches at this local NCC; this many must. */
    repeatWindowM: 1.5, minRepeatNcc: 0.75, minSmearRepeats: 2, smearRepeats: 2, phaseSearchPx: 2,
    /** The smear low-pass: half-height and half-width of its box (m; the width is also capped at a third of the pitch). */
    smearRadiusYM: 2.5, smearRadiusXM: 0.6,
    /** A smear is a low-passed log ratio beyond k robust sd and beyond minLog; its correction is capped at maxLog. */
    smearK: 3, smearMinLog: 0.12, smearMaxLog: Math.log(1.8)
};
export type OrthoRectifyParams = typeof ORTHO_RECTIFY_PARAMS;

export interface Rgba { width: number; height: number; rgba: Uint8Array }

/** A traced line: its axis ('v' runs top to bottom at an x, 'h' left to right at a y), its samples and its segments. */
export interface TracedLine {
    axis: 'v' | 'h';
    /** Peak position (px) the trace started from. */
    at: number;
    /** Sample positions along the line (px) and the traced position across it (px). */
    along: number[]; across: number[];
    /** Per sample: its weight (0 = no edge) and the straight position it belongs to (NaN when in no segment). */
    weight: number[]; straight: number[];
    segments: number;
}

export interface OrthoRectifyReport {
    width: number; height: number; pixelM: number;
    lines: { vertical: number; horizontal: number; segments: number; samples: number };
    /** Mean weighted distance of the traced lines from straight (px), before and after the warp; gain = 1 - after / before. */
    straightnessPx: { before: number; after: number; gain: number };
    /** Median per-pixel luma spread across horizontal repeats, before and after (lower is a more regular lattice). */
    homogeneity?: { before: number; after: number };
    periodM?: number; periodNcc?: number;
    warp: { kept: boolean; why: string; maxShiftPx: number; meanShiftPx: number; foldScale: number; cgIterations: number };
    smear: { applied: boolean; why: string; texels: number; share: number; meanAbsLog: number };
    ms: number;
}

export interface OrthoRectifyResult { image: Rgba; report: OrthoRectifyReport }

const UNCOVERED = 128;
const isUncovered = (rgba: Uint8Array, i: number) => rgba[i * 4] === UNCOVERED && rgba[i * 4 + 1] === UNCOVERED && rgba[i * 4 + 2] === UNCOVERED;

/** Covered mask and luma of an ortho. */
function planes(img: Rgba): { valid: Uint8Array; L: Float32Array } {
    const N = img.width * img.height, valid = new Uint8Array(N), L = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        if (img.rgba[i * 4 + 3] === 0 || isUncovered(img.rgba, i)) continue;
        valid[i] = 1;
        L[i] = 0.299 * img.rgba[i * 4] + 0.587 * img.rgba[i * 4 + 1] + 0.114 * img.rgba[i * 4 + 2];
    }
    return { valid, L };
}

/** Signed central-difference gradients, zero where either neighbour is uncovered. */
function gradients(L: Float32Array, valid: Uint8Array, W: number, H: number): { gx: Float32Array; gy: Float32Array } {
    const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (valid[i - 1] && valid[i + 1]) gx[i] = L[i + 1] - L[i - 1];
        if (valid[i - W] && valid[i + W]) gy[i] = L[i + W] - L[i - W];
    }
    return { gx, gy };
}

/** Peaks of a profile above mean + k sd, at least sep apart (strongest first), sorted by position (facade-lattice.ts). */
export function profilePeaks(p: Float64Array, k: number, sep: number): number[] {
    const n = p.length;
    if (n < 3) return [];
    const m = p.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(p.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    const c: number[] = [];
    for (let i = 1; i < n - 1; i++) if (p[i] > m + k * sd && p[i] >= p[i - 1] && p[i] >= p[i + 1]) c.push(i);
    c.sort((a, b) => p[b] - p[a]);
    const keep: number[] = [];
    for (const i of c) if (keep.every(j => Math.abs(j - i) >= sep)) keep.push(i);
    return keep.sort((a, b) => a - b);
}

/** Weighted median of values (weights > 0 only). */
function weightedMedian(v: number[], w: number[]): number {
    const idx = v.map((_, i) => i).filter(i => w[i] > 0).sort((a, b) => v[a] - v[b]);
    if (!idx.length) return NaN;
    const total = idx.reduce((a, i) => a + w[i], 0);
    let acc = 0;
    for (const i of idx) { acc += w[i]; if (acc >= total / 2) return v[i]; }
    return v[idx[idx.length - 1]];
}

/**
 * Traces the lines of one axis. For 'v' lines the gradient across is gx and samples run down the rows; for 'h' lines the
 * same with the image transposed. `g` is the signed gradient across the line, indexed (along, across) through `at`.
 */
function traceAxis(axis: 'v' | 'h', g: Float32Array, W: number, H: number, pixelM: number, P: OrthoRectifyParams): TracedLine[] {
    const nAcross = axis === 'v' ? W : H, nAlong = axis === 'v' ? H : W;
    const at = (along: number, across: number) => (axis === 'v' ? along * W + across : across * W + along);
    const profile = new Float64Array(nAcross);
    for (let a = 0; a < nAlong; a++) for (let c = 0; c < nAcross; c++) profile[c] += Math.abs(g[at(a, c)]);
    const sep = Math.max(2, Math.round(P.minLineGapM / pixelM));
    const R = Math.max(1, Math.round(P.maxShiftM / pixelM)), S = Math.max(1, Math.round(P.trackStepM / pixelM));
    const nS = Math.floor(nAlong / S);
    const lines: TracedLine[] = [];
    for (const c0 of profilePeaks(profile, P.peakK, sep)) {
        if (c0 - R < 1 || c0 + R > nAcross - 2) continue;
        // the line's polarity: the sign of its summed signed gradient
        let signed = 0;
        for (let a = 0; a < nAlong; a++) signed += g[at(a, c0)];
        const pol = signed >= 0 ? 1 : -1;
        const nD = 2 * R + 1;
        // reward per sample and offset: the edge of the line's polarity summed over the sample's rows
        const e = new Float64Array(nS * nD);
        const best = new Float64Array(nS);
        for (let s = 0; s < nS; s++) {
            let m = 0;
            for (let d = 0; d < nD; d++) {
                let acc = 0;
                for (let a = s * S; a < (s + 1) * S; a++) acc += pol * g[at(a, c0 - R + d)];
                e[s * nD + d] = acc / S;
                if (acc / S > m) m = acc / S;
            }
            best[s] = m;
        }
        const norm = medianOf(Array.from(best).filter(v => v > 0));
        if (!(norm > 0)) continue;
        // Viterbi: cost = -reward / norm + bendCost * |d - d'|
        const cost = new Float64Array(nS * nD), back = new Int16Array(nS * nD);
        for (let d = 0; d < nD; d++) cost[d] = -e[d] / norm;
        for (let s = 1; s < nS; s++) {
            for (let d = 0; d < nD; d++) {
                let bc = Infinity, bd = 0;
                for (let q = 0; q < nD; q++) { const v = cost[(s - 1) * nD + q] + P.bendCost * Math.abs(d - q); if (v < bc) { bc = v; bd = q; } }
                cost[s * nD + d] = bc - e[s * nD + d] / norm;
                back[s * nD + d] = bd;
            }
        }
        const path = new Int16Array(nS);
        let bd = 0;
        for (let d = 1; d < nD; d++) if (cost[(nS - 1) * nD + d] < cost[(nS - 1) * nD + bd]) bd = d;
        for (let s = nS - 1; s >= 0; s--) { path[s] = bd; if (s > 0) bd = back[s * nD + bd]; }
        const along: number[] = [], across: number[] = [], weight: number[] = [];
        for (let s = 0; s < nS; s++) {
            along.push((s + 0.5) * S - 0.5);
            // sub-pixel: the vertex of the parabola through the reward at the chosen offset and its two neighbours
            const d = path[s], rm = d > 0 ? e[s * nD + d - 1] : NaN, r0 = e[s * nD + d], rp = d < nD - 1 ? e[s * nD + d + 1] : NaN, den = rm - 2 * r0 + rp;
            across.push(c0 - R + d + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (rm - rp) / den)) : 0));
            const r = e[s * nD + path[s]] / norm;
            // an offset at the edge of the search window is not trusted: the edge may lie beyond it
            weight.push(r >= P.minEdge && path[s] > 0 && path[s] < nD - 1 ? Math.min(1, r) : 0);
        }
        // segments: runs of samples broken where the edge is lost for longer than segmentGapM
        const gapS = Math.max(1, Math.round(P.segmentGapM / (S * pixelM)));
        const straight = new Array<number>(nS).fill(NaN);
        let segs = 0, s = 0;
        while (s < nS) {
            while (s < nS && weight[s] === 0) s++;
            if (s >= nS) break;
            let end = s, lost = 0;
            for (let k = s; k < nS; k++) { if (weight[k] > 0) { end = k; lost = 0; } else if (++lost > gapS) break; }
            const idx: number[] = [];
            for (let k = s; k <= end; k++) idx.push(k);
            const supported = idx.filter(k => weight[k] > 0).length;
            if (supported >= P.minSupport * idx.length && (end - s + 1) * S * pixelM >= P.minSegmentM) {
                const med = weightedMedian(idx.map(k => across[k]), idx.map(k => weight[k]));
                for (const k of idx) straight[k] = med;
                segs++;
            }
            s = end + 1;
        }
        if (segs) lines.push({ axis, at: c0, along, across, weight: weight.map((w, k) => (Number.isFinite(straight[k]) ? w : 0)), straight, segments: segs });
    }
    return lines;
}

/** The lines of an ortho, traced. */
export function traceLines(img: Rgba, pixelM: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS): TracedLine[] {
    const { valid, L } = planes(img);
    const { gx, gy } = gradients(L, valid, img.width, img.height);
    return [...(P.traceVertical ? traceAxis('v', gx, img.width, img.height, pixelM, P) : []), ...(P.traceHorizontal ? traceAxis('h', gy, img.width, img.height, pixelM, P) : [])];
}

/** Weighted mean distance of traced samples from their straight positions (px). */
export function straightness(lines: TracedLine[]): number {
    let acc = 0, w = 0;
    for (const l of lines) for (let k = 0; k < l.across.length; k++) if (l.weight[k] > 0) { acc += l.weight[k] * Math.abs(l.across[k] - l.straight[k]); w += l.weight[k]; }
    return w > 0 ? acc / w : 0;
}

/** Sparse rows of a linear least-squares system: each row is sqrt(weight) * (sum c_k u_{i_k} - b). */
class Rows {
    idx: number[] = []; val: number[] = []; start: number[] = [0]; rhs: number[] = [];
    add(cols: number[], coefs: number[], b: number, w: number): void {
        const s = Math.sqrt(w);
        for (let k = 0; k < cols.length; k++) if (coefs[k] !== 0) { this.idx.push(cols[k]); this.val.push(coefs[k] * s); }
        this.start.push(this.idx.length);
        this.rhs.push(b * s);
    }
}

/** Solves min |A u - b|^2 by Jacobi-preconditioned conjugate gradients on A^T A u = A^T b, from u0. */
function solveLeastSquares(rows: Rows, n: number, u0: Float64Array, iterations: number, tol: number): { u: Float64Array; iterations: number } {
    const nr = rows.rhs.length, idx = Int32Array.from(rows.idx), val = Float64Array.from(rows.val), start = Int32Array.from(rows.start), rhs = Float64Array.from(rows.rhs);
    const tmp = new Float64Array(nr);
    const AtA = (x: Float64Array, out: Float64Array) => {
        for (let r = 0; r < nr; r++) { let a = 0; for (let k = start[r]; k < start[r + 1]; k++) a += val[k] * x[idx[k]]; tmp[r] = a; }
        out.fill(0);
        for (let r = 0; r < nr; r++) { const t = tmp[r]; for (let k = start[r]; k < start[r + 1]; k++) out[idx[k]] += val[k] * t; }
    };
    const diag = new Float64Array(n), b = new Float64Array(n);
    for (let r = 0; r < nr; r++) for (let k = start[r]; k < start[r + 1]; k++) { diag[idx[k]] += val[k] * val[k]; b[idx[k]] += val[k] * rhs[r]; }
    const u = Float64Array.from(u0), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    AtA(u, Ap);
    for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; p[i] = z[i]; }
    // convergence is measured against the starting residual: b holds absolute pixel positions (the anchor terms), against
    // which the displacements' residual is tiny from the first step
    let rz = 0, bn = 0;
    for (let i = 0; i < n; i++) { rz += r[i] * z[i]; bn += r[i] * r[i]; }
    bn = Math.sqrt(bn) || 1;
    let it = 0;
    for (; it < iterations; it++) {
        AtA(p, Ap);
        let pAp = 0;
        for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
        if (!(pAp > 0)) break;
        const alpha = rz / pAp;
        let rn = 0;
        for (let i = 0; i < n; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rn += r[i] * r[i]; }
        if (Math.sqrt(rn) / bn < tol) { it++; break; }
        let rz2 = 0;
        for (let i = 0; i < n; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; rz2 += r[i] * z[i]; }
        const beta = rz2 / rz;
        rz = rz2;
        for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    return { u, iterations: it };
}

/** A warp: per vertex of a regular grid over the output (spacing G px), the source position it samples (px). */
export interface MeshWarp { G: number; nx: number; ny: number; sx: Float64Array; sy: Float64Array }

/** Bilinear weights of an output point (px) in the warp's grid: the four vertex indices and weights. */
function cellWeights(w: MeshWarp, x: number, y: number): [number[], number[]] {
    const fx = Math.min(w.nx - 1 - 1e-9, Math.max(0, x / w.G)), fy = Math.min(w.ny - 1 - 1e-9, Math.max(0, y / w.G));
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    const v = (ii: number, jj: number) => jj * w.nx + ii;
    return [[v(i, j), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1)], [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b]];
}

/**
 * The content-preserving warp that takes every traced sample onto its straight line. Unknowns are interleaved
 * [sx0, sy0, sx1, sy1, ...] over the grid's vertices; the identity is the start.
 */
export function solveWarp(lines: TracedLine[], W: number, H: number, pixelM: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS): { warp: MeshWarp; iterations: number } {
    const G = Math.max(4, Math.round(P.gridM / pixelM));
    const nx = Math.ceil((W - 1) / G) + 1, ny = Math.ceil((H - 1) / G) + 1, nv = nx * ny;
    const id = (i: number, j: number) => j * nx + i;
    const X = (v: number) => 2 * v, Y = (v: number) => 2 * v + 1;
    const rows = new Rows();
    const shell: MeshWarp = { G, nx, ny, sx: new Float64Array(nv), sy: new Float64Array(nv) };
    // line term: the output point on the straight line samples the traced point in the source
    for (const l of lines) for (let k = 0; k < l.across.length; k++) {
        if (!(l.weight[k] > 0)) continue;
        const [ox, oy] = l.axis === 'v' ? [l.straight[k], l.along[k]] : [l.along[k], l.straight[k]];
        const [vs, ws] = cellWeights(shell, ox, oy);
        if (l.axis === 'v') rows.add(vs.map(X), ws, l.across[k], P.wLine * l.weight[k]);
        else rows.add(vs.map(Y), ws, l.across[k], P.wLine * l.weight[k]);
    }
    // similarity term: per grid quad, each corner against the other two of its triangle (Liu et al. 2009, eq. 10 of Li et al. 2017)
    const tri = (a: number, b: number, c: number, pa: [number, number], pb: [number, number], pc: [number, number]) => {
        const ex = pc[0] - pb[0], ey = pc[1] - pb[1], e2 = ex * ex + ey * ey;
        const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
        // R90 e = (ey, -ex)
        const mu = (dx * ex + dy * ey) / e2, nu = (dx * ey - dy * ex) / e2;
        // x: Ua.x - Ub.x - mu (Uc.x - Ub.x) - nu (Uc.y - Ub.y) = 0
        rows.add([X(a), X(b), X(c), Y(c), Y(b)], [1, -1 + mu, -mu, -nu, nu], 0, P.wSimilarity);
        // y: Ua.y - Ub.y - mu (Uc.y - Ub.y) + nu (Uc.x - Ub.x) = 0
        rows.add([Y(a), Y(b), Y(c), X(c), X(b)], [1, -1 + mu, -mu, nu, -nu], 0, P.wSimilarity);
    };
    const pos = (i: number, j: number): [number, number] => [Math.min(W - 1, i * G), Math.min(H - 1, j * G)];
    for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
        const v00 = id(i, j), v10 = id(i + 1, j), v01 = id(i, j + 1), v11 = id(i + 1, j + 1);
        const p00 = pos(i, j), p10 = pos(i + 1, j), p01 = pos(i, j + 1), p11 = pos(i + 1, j + 1);
        tri(v00, v10, v01, p00, p10, p01);
        tri(v10, v11, v00, p10, p11, p00);
        tri(v11, v01, v10, p11, p01, p10);
        tri(v01, v00, v11, p01, p00, p11);
    }
    // anchor and border terms
    const u0 = new Float64Array(2 * nv);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const v = id(i, j), [px, py] = pos(i, j);
        u0[X(v)] = px; u0[Y(v)] = py;
        rows.add([X(v)], [1], px, P.wAnchor);
        rows.add([Y(v)], [1], py, P.wAnchor);
        if (i === 0 || i === nx - 1) rows.add([X(v)], [1], px, P.wBorder);
        if (j === 0 || j === ny - 1) rows.add([Y(v)], [1], py, P.wBorder);
    }
    const sol = solveLeastSquares(rows, 2 * nv, u0, P.cgIterations, P.cgTolerance);
    for (let v = 0; v < nv; v++) { shell.sx[v] = sol.u[X(v)]; shell.sy[v] = sol.u[Y(v)]; }
    return { warp: shell, iterations: sol.iterations };
}

/** The largest scale s in (0, 1] of the warp's displacement under which no source triangle shrinks below minJacobian. */
export function foldScale(w: MeshWarp, W: number, H: number, minJacobian: number): number {
    const ok = (s: number) => {
        const px = (v: number, i: number) => Math.min(W - 1, i * w.G) + s * (w.sx[v] - Math.min(W - 1, i * w.G));
        const py = (v: number, j: number) => Math.min(H - 1, j * w.G) + s * (w.sy[v] - Math.min(H - 1, j * w.G));
        for (let j = 0; j + 1 < w.ny; j++) for (let i = 0; i + 1 < w.nx; i++) {
            const v = [j * w.nx + i, j * w.nx + i + 1, (j + 1) * w.nx + i, (j + 1) * w.nx + i + 1];
            const ci = [i, i + 1, i, i + 1], cj = [j, j, j + 1, j + 1];
            const P0 = (k: number): [number, number] => [px(v[k], ci[k]), py(v[k], cj[k])];
            const O = (k: number): [number, number] => [Math.min(W - 1, ci[k] * w.G), Math.min(H - 1, cj[k] * w.G)];
            for (const [a, b, c] of [[0, 1, 2], [1, 3, 2]]) {
                const area = (p: (k: number) => [number, number]) => { const A = p(a), B = p(b), C = p(c); return (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]); };
                const ao = area(O);
                if (ao > 0 && area(P0) < minJacobian * ao) return false;
            }
        }
        return true;
    };
    if (ok(1)) return 1;
    let lo = 0, hi = 1;
    for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    return lo;
}

/** The ortho resampled through the warp (bilinear; uncovered stays uncovered and is never blended in). */
export function applyWarp(img: Rgba, w: MeshWarp, scale = 1): Rgba {
    const { width: W, height: H, rgba } = img;
    const out = new Uint8Array(rgba.length);
    const valid = planes(img).valid;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [vs, ws] = cellWeights(w, x, y);
        let sx = 0, sy = 0;
        for (let k = 0; k < 4; k++) {
            const i = vs[k] % w.nx, j = Math.floor(vs[k] / w.nx);
            sx += ws[k] * (Math.min(W - 1, i * w.G) + scale * (w.sx[vs[k]] - Math.min(W - 1, i * w.G)));
            sy += ws[k] * (Math.min(H - 1, j * w.G) + scale * (w.sy[vs[k]] - Math.min(H - 1, j * w.G)));
        }
        sx = Math.min(W - 1, Math.max(0, sx)); sy = Math.min(H - 1, Math.max(0, sy));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), a = sx - x0, b = sy - y0;
        const o = (y * W + x) * 4;
        const corners = [[y0 * W + x0, (1 - a) * (1 - b)], [y0 * W + x1, a * (1 - b)], [y1 * W + x0, (1 - a) * b], [y1 * W + x1, a * b]] as const;
        let wsum = 0;
        const acc = [0, 0, 0, 0];
        for (const [i, wt] of corners) if (valid[i] && wt > 0) { wsum += wt; for (let c = 0; c < 4; c++) acc[c] += wt * rgba[i * 4 + c]; }
        // the nearest source pixel decides coverage
        const near = Math.round(sy) * W + Math.round(sx);
        if (!valid[near] || wsum <= 0) { out[o] = out[o + 1] = out[o + 2] = UNCOVERED; out[o + 3] = rgba[near * 4 + 3]; continue; }
        for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / wsum);
        // a blend can land exactly on the uncovered grey: nudge it so it still reads as covered
        if (out[o] === UNCOVERED && out[o + 1] === UNCOVERED && out[o + 2] === UNCOVERED) out[o + 2] = UNCOVERED + 1;
    }
    return { width: W, height: H, rgba: out };
}

/** The horizontal repeat (px) of an ortho: the first strong peak of its column luma profile's autocorrelation. */
export function horizontalPeriod(img: Rgba, pixelM: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS): { periodPx: number; ncc: number } | undefined {
    const { valid, L } = planes(img), W = img.width, H = img.height;
    const prof = new Float64Array(W), cnt = new Float64Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (valid[i]) { prof[x] += L[i]; cnt[x]++; } }
    const used = Array.from(cnt).map(c => c > 0.1 * H);
    for (let x = 0; x < W; x++) prof[x] = used[x] ? prof[x] / cnt[x] : NaN;
    const lo = Math.max(2, Math.round(P.periodMinM / pixelM)), hi = Math.min(Math.floor(W / 2), Math.round(P.periodMaxM / pixelM));
    const nccAt = (lag: number) => {
        let n = 0, sa = 0, sb = 0, ab = 0, aa = 0, bb = 0;
        for (let x = 0; x + lag < W; x++) { const a = prof[x], b = prof[x + lag]; if (Number.isFinite(a) && Number.isFinite(b)) { n++; sa += a; sb += b; ab += a * b; aa += a * a; bb += b * b; } }
        if (n < 8) return -1;
        const va = aa - sa * sa / n, vb = bb - sb * sb / n;
        return va > 0 && vb > 0 ? (ab - sa * sb / n) / Math.sqrt(va * vb) : -1;
    };
    const c: number[] = [];
    for (let lag = lo - 1; lag <= hi + 1; lag++) c.push(nccAt(lag));
    // the first local maximum that reaches the threshold (a multiple of the period scores about as high, so the first wins)
    for (let k = 1; k + 1 < c.length; k++) if (c[k] >= P.minPeriodNcc && c[k] >= c[k - 1] && c[k] >= c[k + 1]) {
        const lag = lo - 1 + k;
        // sub-pixel by the parabola through the peak
        const d = c[k - 1] - 2 * c[k] + c[k + 1];
        return { periodPx: lag + (d < 0 ? 0.5 * (c[k - 1] - c[k + 1]) / d : 0), ncc: c[k] };
    }
    return undefined;
}

/** Per pixel: the luma of its covered horizontal repeats at +-k*period (k = 1..repeats), in a flat array of `repeats * 2` slots (NaN when not covered). */
function repeatSamples(L: Float32Array, valid: Uint8Array, W: number, H: number, period: number, repeats: number): (x: number, y: number, out: number[]) => number {
    return (x, y, out) => {
        let n = 0;
        for (let k = -repeats; k <= repeats; k++) {
            if (k === 0) continue;
            const sx = x + k * period, x0 = Math.floor(sx), a = sx - x0;
            if (x0 < 0 || x0 + 1 >= W) continue;
            const i = y * W + x0;
            if (!valid[i] || !valid[i + 1]) continue;
            out[n++] = (1 - a) * L[i] + a * L[i + 1];
        }
        return n;
    };
}

/** Lattice homogeneity: the median over covered pixels of the luma spread across a pixel and its horizontal repeats. */
export function homogeneity(img: Rgba, periodPx: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS): number {
    const { valid, L } = planes(img), W = img.width, H = img.height;
    const rep = repeatSamples(L, valid, W, H, periodPx, P.repeats);
    const buf = new Array<number>(2 * P.repeats), sds: number[] = [];
    // a sparse sample keeps this cheap on tall orthos
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const i = y * W + x;
        if (!valid[i]) continue;
        const n = rep(x, y, buf);
        if (n < P.minRepeats) continue;
        let m = L[i];
        for (let k = 0; k < n; k++) m += buf[k];
        m /= n + 1;
        let v = (L[i] - m) ** 2;
        for (let k = 0; k < n; k++) v += (buf[k] - m) ** 2;
        sds.push(Math.sqrt(v / (n + 1)));
    }
    return sds.length ? medianOf(sds) : NaN;
}

/** Separable box mean with different half-widths along x and y over the pixels `use` marks (NaN where none). */
function boxMean(v: Float32Array, use: Uint8Array, W: number, H: number, rx: number, ry: number): Float32Array {
    const pass = (a: Float32Array, horizontal: boolean, r: number): Float32Array => {
        const out = new Float32Array(a.length), n = horizontal ? W : H, m = horizontal ? H : W;
        for (let j = 0; j < m; j++) {
            const at = (k: number) => (horizontal ? j * W + k : k * W + j);
            let acc = 0;
            for (let k = 0; k <= Math.min(r, n - 1); k++) acc += a[at(k)];
            for (let k = 0; k < n; k++) {
                out[at(k)] = acc;
                if (k + r + 1 < n) acc += a[at(k + r + 1)];
                if (k - r >= 0) acc -= a[at(k - r)];
            }
        }
        return out;
    };
    const val = new Float32Array(v.length), wt = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) if (use[i]) { val[i] = v[i]; wt[i] = 1; }
    const sv = pass(pass(val, true, rx), false, ry), sw = pass(pass(wt, true, rx), false, ry);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = sw[i] > 0.5 ? sv[i] / sw[i] : NaN;
    return out;
}

/**
 * Local zero-mean NCC of the luma against itself shifted s pixels along x, over a box of half-widths (rx, ry): NaN where
 * the two windows share too few covered pixels or either is flat. NCC ignores gain and offset, so a smear still matches
 * its repeats while a different structure (a setback wall, a terrace) does not.
 */
function shiftedNcc(L: Float32Array, valid: Uint8Array, W: number, H: number, s: number, rx: number, ry: number): Float32Array {
    const N = W * H, both = new Uint8Array(N), a = new Float32Array(N), b = new Float32Array(N), ab = new Float32Array(N), aa = new Float32Array(N), bb = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const x = i % W, xs = x + s;
        if (xs < 0 || xs >= W || !valid[i] || !valid[i + s]) continue;
        both[i] = 1;
        a[i] = L[i]; b[i] = L[i + s]; ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i];
    }
    const ma = boxMean(a, both, W, H, rx, ry), mb = boxMean(b, both, W, H, rx, ry), mab = boxMean(ab, both, W, H, rx, ry), maa = boxMean(aa, both, W, H, rx, ry), mbb = boxMean(bb, both, W, H, rx, ry);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const va = maa[i] - ma[i] * ma[i], vb = mbb[i] - mb[i] * mb[i];
        out[i] = va > 4 && vb > 4 ? (mab[i] - ma[i] * mb[i]) / Math.sqrt(va * vb) : NaN;
    }
    return out;
}

/**
 * Smears levelled against the facade's horizontal repeats: each pixel's repeats that match its neighbourhood (local NCC
 * at least minRepeatNcc) give a median; where the low-passed log ratio of the pixel to that median is far outside its
 * spread, the pixel's gain is corrected toward the median (bounded; detail kept). Pixels with too few matching repeats
 * (non-repeating structure) are left as they are.
 */
export function levelSmears(img: Rgba, periodPx: number, pixelM: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS): { image: Rgba; texels: number; covered: number; meanAbsLog: number } {
    const { valid, L } = planes(img), W = img.width, H = img.height, N = W * H;
    const nrx = Math.max(2, Math.round(periodPx / 2)), nry = Math.max(2, Math.round(P.repeatWindowM / pixelM));
    // per repeat, the best-matching shift within +-phaseSearchPx of k * period at each pixel (the pitch of a real facade
    // drifts a little from bay to bay; a repeat taken at the wrong phase would read a pier as a smeared window)
    const shifts: Array<{ s: Int16Array; ncc: Float32Array }> = [];
    for (let k = -P.smearRepeats; k <= P.smearRepeats; k++) {
        if (!k) continue;
        const s0 = Math.round(k * periodPx), best = new Float32Array(N).fill(NaN), at = new Int16Array(N);
        for (let d = -P.phaseSearchPx; d <= P.phaseSearchPx; d++) {
            const ncc = shiftedNcc(L, valid, W, H, s0 + d, nrx, nry);
            for (let i = 0; i < N; i++) if (ncc[i] > best[i] || (!(best[i] >= -1) && ncc[i] >= -1)) { best[i] = ncc[i]; at[i] = s0 + d; }
        }
        shifts.push({ s: at, ncc: best });
    }
    const buf: number[] = [];
    const ratio = new Float32Array(N), has = new Uint8Array(N);
    let covered = 0;
    for (let i = 0; i < N; i++) {
        if (!valid[i]) continue;
        covered++;
        buf.length = 0;
        for (const { s, ncc } of shifts) if (ncc[i] >= P.minRepeatNcc && valid[i + s[i]]) buf.push(L[i + s[i]]);
        if (buf.length < P.minSmearRepeats) continue;
        ratio[i] = Math.log((L[i] + 8) / (medianOf(buf) + 8));
        has[i] = 1;
    }
    const rx = Math.max(1, Math.min(Math.round(P.smearRadiusXM / pixelM), Math.round(periodPx / 3))), ry = Math.max(1, Math.round(P.smearRadiusYM / pixelM));
    const low = boxMean(ratio, has, W, H, rx, ry);
    const vals: number[] = [];
    for (let i = 0; i < N; i += 3) if (has[i] && Number.isFinite(low[i])) vals.push(low[i]);
    const med = medianOf(vals), mad = medianOf(vals.map(v => Math.abs(v - med)));
    const sd = 1.4826 * (mad || 1e-3);
    const thr = Math.max(P.smearMinLog, P.smearK * sd);
    const out = new Uint8Array(img.rgba);
    let texels = 0, sumAbs = 0;
    for (let i = 0; i < N; i++) {
        if (!valid[i] || !Number.isFinite(low[i])) continue;
        const r = low[i] - med, a = Math.abs(r);
        if (a <= thr) continue;
        // a soft ramp from the threshold to 1.5x it, then the whole low-frequency excess, capped
        const ramp = Math.min(1, (a - thr) / (0.5 * thr));
        const corr = Math.sign(r) * Math.min(P.smearMaxLog, ramp * a);
        const gain = Math.exp(-corr);
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(img.rgba[i * 4 + c] * gain)));
        if (out[i * 4] === UNCOVERED && out[i * 4 + 1] === UNCOVERED && out[i * 4 + 2] === UNCOVERED) out[i * 4 + 2] = UNCOVERED + 1;
        texels++; sumAbs += Math.abs(corr);
    }
    return { image: { width: W, height: H, rgba: out }, texels, covered, meanAbsLog: texels ? sumAbs / texels : 0 };
}

/** One facade ortho straightened (verified) and its smears levelled. */
export function rectifyOrtho(img: Rgba, pixelM: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS): OrthoRectifyResult {
    const t0 = Date.now();
    const W = img.width, H = img.height;
    const lines = traceLines(img, pixelM, P);
    const before = straightness(lines);
    const period = horizontalPeriod(img, pixelM, P);
    const report: OrthoRectifyReport = {
        width: W, height: H, pixelM,
        lines: { vertical: lines.filter(l => l.axis === 'v').length, horizontal: lines.filter(l => l.axis === 'h').length, segments: lines.reduce((a, l) => a + l.segments, 0), samples: lines.reduce((a, l) => a + l.weight.filter(w => w > 0).length, 0) },
        straightnessPx: { before: round(before, 3), after: round(before, 3), gain: 0 },
        ...(period ? { periodM: round(period.periodPx * pixelM, 3), periodNcc: round(period.ncc, 3) } : {}),
        warp: { kept: false, why: '', maxShiftPx: 0, meanShiftPx: 0, foldScale: 1, cgIterations: 0 },
        smear: { applied: false, why: '', texels: 0, share: 0, meanAbsLog: 0 },
        ms: 0
    };
    let image = img;
    if (!report.lines.samples) report.warp.why = 'no line of the ortho could be traced';
    else if (before < 0.25) report.warp.why = `the lines are already straight (${round(before, 2)} px mean distance)`;
    else {
        const { warp, iterations } = solveWarp(lines, W, H, pixelM, P);
        const scale = foldScale(warp, W, H, P.minJacobian);
        const warped = applyWarp(img, warp, scale);
        // the lines measured again on the warped ortho, from their straight positions
        const after = straightness(retrace(warped, lines, pixelM, P));
        const gain = before > 0 ? 1 - after / before : 0;
        let maxShift = 0, sumShift = 0;
        for (let v = 0; v < warp.sx.length; v++) {
            const i = v % warp.nx, j = Math.floor(v / warp.nx);
            const d = scale * Math.hypot(warp.sx[v] - Math.min(W - 1, i * warp.G), warp.sy[v] - Math.min(H - 1, j * warp.G));
            maxShift = Math.max(maxShift, d); sumShift += d;
        }
        const hBefore = period ? homogeneity(img, period.periodPx, P) : NaN, hAfter = period ? homogeneity(warped, period.periodPx, P) : NaN;
        if (period) report.homogeneity = { before: round(hBefore, 3), after: round(hAfter, 3) };
        report.straightnessPx = { before: round(before, 3), after: round(after, 3), gain: round(gain, 3) };
        report.warp = { ...report.warp, maxShiftPx: round(maxShift, 2), meanShiftPx: round(sumShift / warp.sx.length, 3), foldScale: round(scale, 3), cgIterations: iterations };
        const regular = !period || !(hAfter > hBefore * 1.02);
        if (gain >= P.minGain && regular) { image = warped; report.warp.kept = true; report.warp.why = `lines ${round(before, 2)} -> ${round(after, 2)} px from straight (${Math.round(gain * 100)}% straighter)${period ? `, lattice spread ${round(hBefore, 2)} -> ${round(hAfter, 2)}` : ''}`; }
        else report.warp.why = gain < P.minGain ? `the warp straightened the lines by only ${Math.round(gain * 100)}% (at least ${Math.round(P.minGain * 100)}% needed)` : `the warp made the lattice less regular (spread ${round(hBefore, 2)} -> ${round(hAfter, 2)})`;
    }
    if (!period) report.smear.why = 'no horizontal repeat in the ortho to level smears against';
    else {
        const s = levelSmears(image, period.periodPx, pixelM, P);
        image = s.image;
        report.smear = { applied: s.texels > 0, why: s.texels ? `${s.texels} texels levelled against their repeats at a ${round(period.periodPx * pixelM, 2)} m pitch` : 'no smear stood out from the repeats', texels: s.texels, share: round(s.covered ? s.texels / s.covered : 0, 4), meanAbsLog: round(s.meanAbsLog, 3) };
    }
    report.ms = Date.now() - t0;
    return { image, report };
}

/** The given lines traced again on another image, each sample searched about its straight position (for the after measure). */
function retrace(img: Rgba, lines: TracedLine[], pixelM: number, P: OrthoRectifyParams): TracedLine[] {
    const { valid, L } = planes(img);
    const { gx, gy } = gradients(L, valid, img.width, img.height);
    const W = img.width;
    const R = Math.max(1, Math.round(P.maxShiftM / pixelM)), S = Math.max(1, Math.round(P.trackStepM / pixelM));
    return lines.map(l => {
        const g = l.axis === 'v' ? gx : gy;
        const at = (along: number, across: number) => (l.axis === 'v' ? along * W + across : across * W + along);
        const nAcross = l.axis === 'v' ? img.width : img.height;
        let signed = 0;
        for (let k = 0; k < l.along.length; k++) if (l.weight[k] > 0) signed += g[at(Math.round(l.along[k]), Math.round(l.across[k]))];
        const pol = signed >= 0 ? 1 : -1;
        const across = l.across.map((_, k) => {
            if (!(l.weight[k] > 0)) return NaN;
            const c0 = Math.round(l.straight[k]);
            let best = -Infinity, bd = 0;
            for (let d = -R; d <= R; d++) {
                const c = c0 + d;
                if (c < 1 || c >= nAcross - 1) continue;
                let acc = 0;
                const a0 = Math.round(l.along[k] - (S - 1) / 2);
                for (let a = a0; a < a0 + S; a++) acc += pol * g[at(a, c)];
                // ties go to the smaller shift
                if (acc > best + 1e-9 || (Math.abs(acc - best) <= 1e-9 && Math.abs(d) < Math.abs(bd))) { best = acc; bd = d; }
            }
            // sub-pixel as in the trace
            const r = (d: number) => { let acc = 0; const a0 = Math.round(l.along[k] - (S - 1) / 2); for (let a = a0; a < a0 + S; a++) acc += pol * g[at(a, c0 + d)]; return acc; };
            const c = c0 + bd;
            if (c - 1 < 1 || c + 1 >= nAcross - 1) return c;
            const rm = r(bd - 1), rp = r(bd + 1), den = rm - 2 * best + rp;
            return c + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (rm - rp) / den)) : 0);
        });
        return { ...l, across };
    });
}

const round = (v: number, d: number) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
