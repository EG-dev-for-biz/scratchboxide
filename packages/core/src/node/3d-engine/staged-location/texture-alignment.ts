/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-view, per-chart image alignment for the Street View projection bake (design section 12, "per-island local
 * refinement"): the registered poses are off by about a metre (1.28 m RMS on the live arch), so two views project the same
 * carved figure a few dozen pixels apart and a blend of them draws it twice. Before blending, every view's projection
 * of every atlas chart is moved by a small image-space shift (dx, dy) that makes its gradients agree with the other views
 * on that chart.
 *
 * Per chart (an atlas map: one fitted surface or one scan island), on a texel grid subsampled to a few thousand points:
 *  - the views are taken in order of their total weight on the chart; the first sets the consensus;
 *  - each next view is shifted to maximise the normalised correlation of its luminance gradients (along the atlas u and
 *    v axes; invariant to exposure gain and offset, so lighting differences between capture dates count little) with the
 *    consensus gradients, searched coarse to fine over a 3-level image pyramid (sigma 6 px, 2 px, then the image at half
 *    pixel steps with a parabolic sub-pixel peak), within +-2 sigma of the view's pose uncertainty at the chart's depth;
 *  - a shift is kept only when it is robust: the peak correlation is at least `minNcc`, beats no shift by `minGain`, and
 *    does not sit on the search window's edge. Otherwise the view's median kept shift (a pose-level correction measured
 *    on the charts that did align) is used when it scores at least as well as no shift; else no shift;
 *  - then a second round re-aligns every view against the consensus of the others, so the first view is not a fixed anchor.
 * Nothing is invented: a shift only chooses where in a real photo a texel reads its colour, bounded by the pose error.
 * The before/after inter-view gradient correlation over every overlapping pair is measured and reported.
 */

import type { ProjectionView, UvAtlas } from '../../../common/spatial/texture-pass-contracts';
import { SRGB_TO_LINEAR } from './texel-exposure';

/** One view's projected samples: texel index, pixel position and log weight per sample. */
export interface AlignSamples { texel: Int32Array; x: Float32Array; y: Float32Array; logW: Float64Array }

export interface AlignmentOptions {
    /** Grid points per chart (texels subsampled on a regular stride). Default 6000. */
    gridPoints?: number;
    /** Fewest shared grid points between a view and the consensus to align. Default 150. */
    minShared?: number;
    /** Robustness: least peak gradient NCC, and least gain over no shift. Defaults 0.2 and 0.03. */
    minNcc?: number;
    minGain?: number;
    /** Search half-width in multiples of the view's pose sigma at the chart's depth, and its clamp (px). Defaults 2, [6, 96]. */
    sigmaWindow?: number;
    minWindowPx?: number;
    maxWindowPx?: number;
    /** Rounds (the second re-aligns every view against the others). Default 2. */
    rounds?: number;
    /** Half-width (px) of the tile refinement the affine shift field is fitted to. Default 3. */
    affineWindowPx?: number;
    /** Correlation a shift of one pose sigma costs in the search (a Gaussian pose prior). Default 0 (measured on the live arch: any prior kept wrong near peaks over right far ones). */
    priorWeight?: number;
    /**
     * A geometry-registered reference: the photo-textured tile's linear RGB at a texel (its own mesh is where the layer is,
     * so it fixes the gauge the views alone leave free). It joins every consensus as one more view with `referenceShare` of
     * the mean view weight, and the first view of a chart aligns to it. Absent: the views align to each other only.
     */
    reference?: (texel: number) => [number, number, number] | undefined;
    referenceShare?: number;
    signal?: AbortSignal;
}

export interface ChartShift {
    view: number; map: number; dx: number; dy: number; ncc: number; ncc0: number; kind: 'aligned' | 'view-shift' | 'none' | (string & {});
    /**
     * Present when the chart's shift varies over it (a pose rotation moves an oblique chart's far side more than its near
     * side): dx = ax[0] + ax[1] nx + ax[2] ny, dy likewise, with (nx, ny) the chart grid position scaled to -1..1.
     */
    affine?: { ax: [number, number, number]; ay: [number, number, number] };
}

export interface AlignmentReport {
    charts: number;
    alignedPairs: number;
    /** Kept chart shifts by kind. */
    kept: Record<string, number>;
    /** Per view: median kept shift (px) and how many charts it was measured on (a pose-level correction, reported). */
    perView: Array<{ panoId: string; medianDx: number; medianDy: number; charts: number; yawDeg: number; pitchDeg: number }>;
    /** Mean inter-view gradient NCC over overlapping view pairs on the same chart (weighted by shared grid points). */
    interViewGradNccBefore: number;
    interViewGradNccAfter: number;
    pairs: number;
    ms: number;
}

export interface AlignmentResult { shifts: ChartShift[]; /** dx, dy per view per sample (0 where unshifted). */ dx: Float32Array[]; dy: Float32Array[]; report: AlignmentReport }

/** Blur sigmas (px) of the pyramid levels; a chart's search uses the three from the first whose sigma is at least 0.4 grid steps. */
const PYRAMID_SIGMAS = [0, 2, 5, 12, 28];

/** Gaussian for small sigmas, three running box passes per axis (same variance) for large ones. */
function blurImage(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
    if (sigma <= 3) return gaussBlur(src, W, H, sigma);
    const rb = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const out = Float32Array.from(src);
    const len = Math.max(W, H);
    const buf = new Float64Array(len), pre = new Float64Array(len + 1);
    const line = (idx: (j: number) => number, L: number) => {
        for (let j = 0; j < L; j++) buf[j] = out[idx(j)];
        for (let pass = 0; pass < 3; pass++) {
            pre[0] = 0;
            for (let j = 0; j < L; j++) pre[j + 1] = pre[j] + buf[j];
            for (let j = 0; j < L; j++) { const a = Math.max(0, j - rb), b = Math.min(L, j + rb + 1); buf[j] = (pre[b] - pre[a]) / (b - a); }
        }
        for (let j = 0; j < L; j++) out[idx(j)] = buf[j];
    };
    for (let y = 0; y < H; y++) line(j => y * W + j, W);
    for (let x = 0; x < W; x++) line(j => j * W + x, H);
    return out;
}

/** Luminance pyramid of one image (sqrt of linear luminance), blurred at PYRAMID_SIGMAS. */
interface Pyramid { W: number; H: number; levels: Float32Array[] }

function gaussBlur(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
    const r = Math.max(1, Math.ceil(2.5 * sigma));
    const k = new Float32Array(2 * r + 1);
    let ks = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let d = -r; d <= r; d++) { const xx = x + d < 0 ? 0 : x + d >= W ? W - 1 : x + d; s += k[d + r] * src[row + xx]; }
            tmp[row + x] = s;
        }
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let d = -r; d <= r; d++) { const yy = y + d < 0 ? 0 : y + d >= H ? H - 1 : y + d; s += k[d + r] * tmp[yy * W + x]; }
            out[y * W + x] = s;
        }
    }
    return out;
}

function pyramidOf(view: ProjectionView): Pyramid {
    const { width: W, height: H, rgba } = view.image;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.2126 * SRGB_TO_LINEAR[rgba[i * 4]] + 0.7152 * SRGB_TO_LINEAR[rgba[i * 4 + 1]] + 0.0722 * SRGB_TO_LINEAR[rgba[i * 4 + 2]];
    // a log-like response, so a bright sky edge does not outweigh the stone's detail
    for (let i = 0; i < L.length; i++) L[i] = Math.sqrt(L[i]);
    return { W, H, levels: PYRAMID_SIGMAS.map(sg => (sg ? blurImage(L, W, H, sg) : L)) };
}

function bilinear(img: Float32Array, W: number, H: number, x: number, y: number): number {
    const fx = Math.min(W - 1, Math.max(0, x - 0.5)), fy = Math.min(H - 1, Math.max(0, y - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    return (img[y0 * W + x0] * (1 - ax) + img[y0 * W + x1] * ax) * (1 - ay) + (img[y1 * W + x0] * (1 - ax) + img[y1 * W + x1] * ax) * ay;
}

/** Normalised correlation of two gradient fields over the grid edges both define. */
function gradNcc(a: Float64Array, b: Float64Array, edges: Int32Array): { ncc: number; n: number } {
    let ab = 0, aa = 0, bb = 0, n = 0;
    for (let e = 0; e < edges.length; e += 2) {
        const i = edges[e], j = edges[e + 1];
        const va = a[j] - a[i], vb = b[j] - b[i];
        if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
        ab += va * vb; aa += va * va; bb += vb * vb; n++;
    }
    return { ncc: aa > 1e-12 && bb > 1e-12 ? ab / Math.sqrt(aa * bb) : 0, n };
}

/** NaN-aware separable Gaussian of a field on a gw x gh grid. */
function blurGrid(f: Float64Array, gw: number, gh: number, sigma: number): Float64Array {
    const r = Math.max(1, Math.ceil(2.5 * sigma));
    const k: number[] = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
    const pass = (src: Float64Array, horizontal: boolean): Float64Array => {
        const out = new Float64Array(src.length).fill(NaN);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
            if (!Number.isFinite(f[y * gw + x])) continue;
            let s = 0, w = 0;
            for (let d = -r; d <= r; d++) {
                const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
                if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
                const v = src[yy * gw + xx];
                if (!Number.isFinite(v)) continue;
                s += k[d + r] * v; w += k[d + r];
            }
            if (w > 0) out[y * gw + x] = s / w;
        }
        return out;
    };
    return pass(pass(f, true), false);
}

const median = (v: number[]): number => { if (!v.length) return 0; const s = [...v].sort((p, q) => p - q); return s[s.length >> 1]; };

/**
 * Aligns every view's projection of every chart to the others (see the file comment). `samples[k]` are view k's
 * samples (from the bake's projection step). Returns per-sample shifts and the report.
 */
export function alignViewsPerChart(atlas: UvAtlas, views: ProjectionView[], samples: AlignSamples[], opts: AlignmentOptions = {}): AlignmentResult {
    const t0 = Date.now();
    const gridTarget = opts.gridPoints ?? 6000, minShared = opts.minShared ?? 150;
    const minNcc = opts.minNcc ?? 0.2, minGain = opts.minGain ?? 0.03;
    const sigmaWindow = opts.sigmaWindow ?? 2, minWin = opts.minWindowPx ?? 6, maxWin = opts.maxWindowPx ?? 160;
    const rounds = Math.max(1, opts.rounds ?? 2);
    const priorWeight = opts.priorWeight ?? 0;
    const affineWin = opts.affineWindowPx ?? 3;
    const W = atlas.width;
    const { mapIndex } = atlas.texels;
    const nMaps = atlas.maps.length;
    const dxOut = samples.map(s => new Float32Array(s.texel.length));
    const dyOut = samples.map(s => new Float32Array(s.texel.length));

    // per map: the samples of each view on it
    const perMap: Array<Map<number, number[]>> = Array.from({ length: nMaps }, () => new Map());
    samples.forEach((s, k) => {
        for (let i = 0; i < s.texel.length; i++) {
            const m = mapIndex[s.texel[i]];
            if (m >= nMaps) continue;
            let list = perMap[m].get(k);
            if (!list) { list = []; perMap[m].set(k, list); }
            list.push(i);
        }
    });

    const pyramids = new Map<number, Pyramid>();
    const pyr = (k: number): Pyramid => { let p = pyramids.get(k); if (!p) { p = pyramidOf(views[k]); pyramids.set(k, p); } return p; };

    const shifts: ChartShift[] = [];
    const pending: Array<{ map: number; views: number[]; edges: Int32Array; win: Map<number, number>; weight: Map<number, number>; baseOf: (k: number) => number; ref?: (k: number, level: number) => Float64Array;
        field: (k: number, level: number, dx: number, dy: number, aff?: ChartShift['affine']) => Float64Array; gridPos: (t: number) => [number, number]; gw: number; gh: number }> = [];
    const refShare = opts.referenceShare ?? 1;
    let nccBeforeSum = 0, nccAfterSum = 0, pairWeight = 0, pairs = 0, alignedPairs = 0;

    for (let m = 0; m < nMaps; m++) {
        if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('alignment aborted');
        const onMap = [...perMap[m].entries()].filter(([, l]) => l.length >= minShared);
        if (onMap.length < 2) continue;
        // the chart's texel grid, subsampled
        const [u0, v0, u1, v1] = atlas.maps[m].atlasRect;
        const H = atlas.height;
        const x0 = Math.max(0, Math.floor(u0 * W)), y0 = Math.max(0, Math.floor(v0 * H)), x1 = Math.min(W, Math.ceil(u1 * W)), y1 = Math.min(H, Math.ceil(v1 * H));
        let count = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (mapIndex[y * W + x] === m) count++;
        const st = Math.max(1, Math.ceil(Math.sqrt(count / gridTarget)));
        const gw = Math.ceil((x1 - x0) / st), gh = Math.ceil((y1 - y0) / st);
        const gridOf = (t: number): number => {
            const tx = t % W, ty = (t - tx) / W;
            if ((tx - x0) % st || (ty - y0) % st) return -1;
            return ((ty - y0) / st) * gw + (tx - x0) / st;
        };
        // per view: sample index at each grid point
        const at = new Map<number, Int32Array>();
        const weight = new Map<number, number>();
        for (const [k, list] of onMap) {
            const g = new Int32Array(gw * gh).fill(-1);
            let w = 0, n = 0;
            for (const i of list) {
                w += Math.exp(samples[k].logW[i]);
                const gi = gridOf(samples[k].texel[i]);
                if (gi >= 0) { g[gi] = i; n++; }
            }
            if (n < Math.min(minShared, 16)) continue;
            at.set(k, g);
            weight.set(k, w);
        }
        if (at.size < 2) continue;
        // grid edges (right and down neighbours inside the grid)
        const e: number[] = [];
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
            const i = gy * gw + gx;
            if (gx + 1 < gw) e.push(i, i + 1);
            if (gy + 1 < gh) e.push(i, i + gw);
        }
        const edges = Int32Array.from(e);
        const gridPx = new Map<number, number>();
        // the pyramid level a view's search starts at on this chart: blurred to at least 0.4 of the grid step in its pixels,
        // so sampling the photo on the (much coarser) texel grid does not alias its fine detail into noise
        const base = new Map<number, number>();
        for (const k of at.keys()) {
            const g = at.get(k)!, s = samples[k];
            const steps: number[] = [];
            for (let q = 0; q + 1 < g.length && steps.length < 400; q += 3) {
                const i = g[q], j = g[q + 1];
                if (i >= 0 && j >= 0 && (q % gw) + 1 < gw) steps.push(Math.hypot(s.x[j] - s.x[i], s.y[j] - s.y[i]));
            }
            const gpx = median(steps);
            let b = 0;
            while (b < PYRAMID_SIGMAS.length - 3 && PYRAMID_SIGMAS[b] < 0.4 * gpx) b++;
            base.set(k, b);
            gridPx.set(k, Math.max(1e-3, gpx));
        }
        const hw = Math.max(1, gw / 2), hh = Math.max(1, gh / 2);
        const field = (k: number, level: number, dx: number, dy: number, aff?: ChartShift['affine']): Float64Array => {
            const g = at.get(k)!, p = pyr(k), img = p.levels[base.get(k)! + level], s = samples[k];
            const f = new Float64Array(g.length).fill(NaN);
            for (let q = 0; q < g.length; q++) {
                const i = g[q];
                if (i < 0) continue;
                if (aff) {
                    const nx = ((q % gw) - hw) / hw, ny = (Math.floor(q / gw) - hh) / hh;
                    f[q] = bilinear(img, p.W, p.H, s.x[i] + aff.ax[0] + aff.ax[1] * nx + aff.ax[2] * ny, s.y[i] + aff.ay[0] + aff.ay[1] * nx + aff.ay[2] * ny);
                } else f[q] = bilinear(img, p.W, p.H, s.x[i] + dx, s.y[i] + dy);
            }
            return f;
        };
        /** A sample's grid position on this chart scaled to -1..1 (for the affine shift). */
        const gridPos = (t: number): [number, number] => { const tx = t % W, ty = (t - tx) / W; return [((tx - x0) / st - hw) / hw, ((ty - y0) / st - hh) / hh]; };
        // search window per view: 2 sigma of its pose error at the chart's median depth
        const win = new Map<number, number>();
        for (const k of at.keys()) {
            const cam = views[k].camera, s = samples[k], g = at.get(k)!;
            const zs: number[] = [];
            for (let q = 0; q < g.length; q += 7) {
                const i = g[q]; if (i < 0) continue;
                const t = s.texel[i] * 3, P = atlas.texels.position;
                zs.push((P[t] - cam.eye[0]) * cam.fwd[0] + (P[t + 1] - cam.eye[1]) * cam.fwd[1] + (P[t + 2] - cam.eye[2]) * cam.fwd[2]);
            }
            const z = Math.max(1, median(zs));
            win.set(k, Math.round(Math.min(maxWin, Math.max(minWin, sigmaWindow * views[k].poseSigmaPx / z))));
        }
        const order = [...at.keys()].sort((a, b) => weight.get(b)! - weight.get(a)!);
        // the reference on the grid (texel positions of the chart's grid points; sqrt luminance like the views)
        let ref: Float64Array | undefined;
        if (opts.reference) {
            ref = new Float64Array(gw * gh).fill(NaN);
            let got = 0;
            for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
                const tx = x0 + gx * st, ty = y0 + gy * st;
                if (tx >= x1 || ty >= y1) continue;
                const t = ty * W + tx;
                if (mapIndex[t] !== m) continue;
                const c = opts.reference(t);
                if (!c) continue;
                ref[gy * gw + gx] = Math.sqrt(Math.max(0, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]));
                got++;
            }
            if (got < minShared) ref = undefined;
        }
                // the reference blurred on the grid to the scale view k's level sees (its level sigma in grid steps), cached
        const refCache = new Map<string, Float64Array>();
        const refAt = ref ? (k: number, level: number): Float64Array => {
            const sg = PYRAMID_SIGMAS[base.get(k)! + level] / gridPx.get(k)!;
            const key = `${k}:${level}`;
            let r = refCache.get(key);
            if (!r) { r = sg > 0.3 ? blurGrid(ref, gw, gh, sg) : ref; refCache.set(key, r); }
            return r;
        } : undefined;
        pending.push({ map: m, views: order, field, edges, win, weight, baseOf: (k: number) => base.get(k)!, gridPos, gw, gh, ...(refAt ? { ref: refAt } : {}) });
    }

    /** Coarse-to-fine search within +-R: the coarse level on a grid of R/8 steps, the middle level at whole pixels, the fine level at half pixels with a parabolic peak; scores minus the prior. */
    const search = (score: (level: number, dx: number, dy: number) => number, prior: (dx: number, dy: number) => number, R: number): { dx: number; dy: number; ncc: number; ncc0: number; onEdge: boolean } => {
        const ncc0 = score(0, 0, 0);
        let bx = 0, by = 0, best = -Infinity;
        const step = Math.max(2, Math.round(R / 8));
        for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
            const v = score(2, dx, dy) - prior(dx, dy);
            if (v > best) { best = v; bx = dx; by = dy; }
        }
        let cx = bx, cy = by;
        best = -Infinity;
        for (let dy = cy - step; dy <= cy + step; dy++) for (let dx = cx - step; dx <= cx + step; dx++) {
            if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
            const v = score(1, dx, dy) - prior(dx, dy);
            if (v > best) { best = v; bx = dx; by = dy; }
        }
        cx = bx; cy = by;
        best = -Infinity;
        const grid = new Map<string, number>();
        for (let dy = cy - 1; dy <= cy + 1 + 1e-9; dy += 0.5) for (let dx = cx - 1; dx <= cx + 1 + 1e-9; dx += 0.5) {
            const v = score(0, dx, dy);
            grid.set(`${dx},${dy}`, v);
            if (v - prior(dx, dy) > best) { best = v - prior(dx, dy); bx = dx; by = dy; }
        }
        const raw = grid.get(`${bx},${by}`)!;
        const sx = [grid.get(`${bx - 0.5},${by}`), raw, grid.get(`${bx + 0.5},${by}`)], sy = [grid.get(`${bx},${by - 0.5}`), raw, grid.get(`${bx},${by + 0.5}`)];
        const vertex = (a?: number, b?: number, c?: number): number => (a === undefined || c === undefined || !(a - 2 * b! + c < -1e-9)) ? 0 : Math.max(-0.5, Math.min(0.5, 0.25 * (a - c) / (a - 2 * b! + c)));
        if (!(raw > ncc0)) return { dx: 0, dy: 0, ncc: ncc0, ncc0, onEdge: false };
        return { dx: bx + vertex(...sx), dy: by + vertex(...sy), ncc: raw, ncc0, onEdge: Math.abs(bx) >= R - 1 || Math.abs(by) >= R - 1 };
    };

    // state per (map, view): the shift in use
    const cur = new Map<string, ChartShift>();
    const key = (m: number, k: number) => `${m}:${k}`;
    for (const p of pending) for (const k of p.views) cur.set(key(p.map, k), { view: k, map: p.map, dx: 0, dy: 0, ncc: 0, ncc0: 0, kind: 'none' });

    const consensusOf = (p: typeof pending[number], exclude: number, include: (k: number) => boolean): Float64Array[] | undefined => {
        const cons: Float64Array[] = [];
        let any = false;
        for (let level = 0; level < 3; level++) {
            let sum: Float64Array | undefined, wsum: Float64Array | undefined;
            for (const k of p.views) {
                if (k === exclude || !include(k)) continue;
                const s = cur.get(key(p.map, k))!;
                const f = p.field(k, level, s.dx, s.dy, s.affine);
                // normalise the view to its own mean so exposure does not bias the consensus
                let mean = 0, n = 0;
                for (const v of f) if (Number.isFinite(v)) { mean += v; n++; }
                mean = n ? mean / n : 1;
                const w = p.weight.get(k)!;
                if (!sum) { sum = new Float64Array(f.length); wsum = new Float64Array(f.length); }
                for (let q = 0; q < f.length; q++) if (Number.isFinite(f[q])) { sum[q] += (w * f[q]) / Math.max(1e-6, mean); wsum![q] += w; }
                any = true;
            }
            if (p.ref) {
                const f = p.ref(exclude, level);
                let mean = 0, nn = 0;
                for (const v of f) if (Number.isFinite(v)) { mean += v; nn++; }
                mean = nn ? mean / nn : 1;
                const ws = [...p.weight.values()];
                const w = refShare * (ws.reduce((a, b) => a + b, 0) / Math.max(1, ws.length));
                if (!sum) { sum = new Float64Array(f.length); wsum = new Float64Array(f.length); }
                for (let q = 0; q < f.length; q++) if (Number.isFinite(f[q])) { sum[q] += (w * f[q]) / Math.max(1e-6, mean); wsum![q] += w; }
                any = true;
            }
            if (!sum) return undefined;
            cons.push(sum.map((v, q) => (wsum![q] > 0 ? v / wsum![q] : NaN)));
        }
        return any ? cons : undefined;
    };

    // per chart, views in order of weight: each is searched coarse to fine against the consensus of the views placed before
    // it (and the reference); a second round re-aligns every view against all the others. A Gaussian pose prior (one pose
    // sigma costs priorWeight of correlation) makes the nearer of two similar peaks win (repeated ashlar courses).
    for (let round = 0; round < rounds; round++) {
        const kept = new Map<number, Array<[number, number]>>();
        for (const p of pending) {
            if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('alignment aborted');
            const placed = new Set<number>();
            for (const k of p.views) {
                // round 0 without a reference: the chart's first view stays where its pose puts it (the gauge)
                if (round === 0 && !p.ref && placed.size === 0) { placed.add(k); continue; }
                const cons = consensusOf(p, k, round === 0 ? (v => placed.has(v)) : (() => true));
                placed.add(k);
                if (!cons) continue;
                const R = p.win.get(k)!;
                const prior = (dx: number, dy: number) => priorWeight * ((dx * dx + dy * dy) / ((R / sigmaWindow) ** 2));
                const score = (level: number, dx: number, dy: number) => gradNcc(p.field(k, level, dx, dy), cons[level], p.edges).ncc;
                const r = search(score, prior, R);
                alignedPairs++;
                const s = cur.get(key(p.map, k))!;
                // a later round replaces a kept shift only with a better one
                const kept0 = s.kind !== 'none' ? score(0, s.dx, s.dy) : -Infinity;
                if (r.ncc - prior(r.dx, r.dy) >= minNcc && r.ncc - prior(r.dx, r.dy) - r.ncc0 >= minGain && !r.onEdge && r.ncc > kept0) {
                    Object.assign(s, { dx: r.dx, dy: r.dy, ncc: r.ncc, ncc0: r.ncc0, kind: 'aligned' });
                    const list = kept.get(k) ?? [];
                    list.push([r.dx, r.dy]);
                    kept.set(k, list);
                } else if (!(kept0 > r.ncc0)) Object.assign(s, { dx: 0, dy: 0, ncc: r.ncc0, ncc0: r.ncc0, kind: 'none' });
            }
        }
        // where a chart's own search was not robust: the view's median kept shift, if it scores no worse than no shift
        for (const p of pending) for (const k of p.views) {
            const s = cur.get(key(p.map, k))!;
            const list = kept.get(k);
            if (s.kind === 'aligned' || !list || list.length < 2) continue;
            const mdx = median(list.map(v => v[0])), mdy = median(list.map(v => v[1]));
            if (Math.abs(mdx) > p.win.get(k)! || Math.abs(mdy) > p.win.get(k)!) continue;
            const cons = consensusOf(p, k, () => true);
            if (!cons) continue;
            const a = gradNcc(p.field(k, 0, mdx, mdy), cons[0], p.edges).ncc, b = gradNcc(p.field(k, 0, 0, 0), cons[0], p.edges).ncc;
            if (s.kind === 'view-shift' && s.ncc >= a) continue;
            if (a >= b) Object.assign(s, { dx: mdx, dy: mdy, ncc: a, ncc0: b, kind: 'view-shift' });
        }
    }

    // the shift as an affine field over the chart: tiles of the grid are refined around the chart shift (+-affineWindowPx at
    // the finest level), an affine is fitted to the tile shifts by weighted least squares (weight: the tile's correlation
    // above 0.1, times its edges), and kept when the chart agrees better with it than with the single shift
    for (const p of pending) {
        const nt = Math.max(2, Math.min(4, Math.round(Math.min(p.gw, p.gh) / 20)));
        if (Math.min(p.gw, p.gh) < 2 * 12) continue;
        for (const k of p.views) {
            const s = cur.get(key(p.map, k))!;
            if (s.kind === 'none') continue;
            const cons = consensusOf(p, k, () => true);
            if (!cons) continue;
            const tiles: Array<{ nx: number; ny: number; dx: number; dy: number; w: number }> = [];
            for (let ty = 0; ty < nt; ty++) for (let tx = 0; tx < nt; tx++) {
                const gx0 = Math.floor((tx * p.gw) / nt), gx1 = Math.floor(((tx + 1) * p.gw) / nt), gy0 = Math.floor((ty * p.gh) / nt), gy1 = Math.floor(((ty + 1) * p.gh) / nt);
                const sub: number[] = [];
                for (let e = 0; e < p.edges.length; e += 2) {
                    const q = p.edges[e], gx = q % p.gw, gy = Math.floor(q / p.gw);
                    if (gx >= gx0 && gx < gx1 && gy >= gy0 && gy < gy1) sub.push(p.edges[e], p.edges[e + 1]);
                }
                if (sub.length < 2 * 60) continue;
                const te = Int32Array.from(sub);
                let bx = s.dx, by = s.dy, best = -Infinity, n = 0;
                for (let dy = -affineWin; dy <= affineWin; dy += 0.5) for (let dx = -affineWin; dx <= affineWin; dx += 0.5) {
                    const g = gradNcc(p.field(k, 0, s.dx + dx, s.dy + dy), cons[0], te);
                    if (g.ncc > best) { best = g.ncc; bx = s.dx + dx; by = s.dy + dy; n = g.n; }
                }
                if (best > 0.1 && Math.abs(bx - s.dx) < affineWin && Math.abs(by - s.dy) < affineWin) {
                    tiles.push({ nx: ((gx0 + gx1) / 2 - p.gw / 2) / (p.gw / 2), ny: ((gy0 + gy1) / 2 - p.gh / 2) / (p.gh / 2), dx: bx, dy: by, w: (best - 0.1) * n });
                }
            }
            if (tiles.length < 4) continue;
            const fit = (val: (t: typeof tiles[number]) => number): [number, number, number] | undefined => {
                const A = new Float64Array(9), b = new Float64Array(3);
                for (const t of tiles) { const r = [1, t.nx, t.ny]; for (let i = 0; i < 3; i++) { b[i] += t.w * r[i] * val(t); for (let j = 0; j < 3; j++) A[i * 3 + j] += t.w * r[i] * r[j]; } }
                // 3 x 3 solve (Cramer)
                const det = (m: Float64Array) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
                const D = det(A);
                if (!(Math.abs(D) > 1e-9)) return undefined;
                const out: number[] = [];
                for (let c = 0; c < 3; c++) { const M = Float64Array.from(A); for (let r = 0; r < 3; r++) M[r * 3 + c] = b[r]; out.push(det(M) / D); }
                return out as [number, number, number];
            };
            const ax = fit(t => t.dx), ay = fit(t => t.dy);
            if (!ax || !ay) continue;
            const aff = { ax, ay };
            const rigid = gradNcc(p.field(k, 0, s.dx, s.dy), cons[0], p.edges).ncc, affine = gradNcc(p.field(k, 0, 0, 0, aff), cons[0], p.edges).ncc;
            if (affine > rigid + 0.01) Object.assign(s, { affine: aff, ncc: affine, dx: ax[0], dy: ay[0] });
        }
    }

    // measure: inter-view gradient NCC per chart, every overlapping pair, before (no shifts) and after
    for (const p of pending) {
        const f0 = new Map<number, Float64Array>(), f1 = new Map<number, Float64Array>();
        for (const k of p.views) { const s = cur.get(key(p.map, k))!; f0.set(k, p.field(k, 0, 0, 0)); f1.set(k, p.field(k, 0, s.dx, s.dy, s.affine)); }
        for (let a = 0; a < p.views.length; a++) for (let b = a + 1; b < p.views.length; b++) {
            const ka = p.views[a], kb = p.views[b];
            const before = gradNcc(f0.get(ka)!, f0.get(kb)!, p.edges), after = gradNcc(f1.get(ka)!, f1.get(kb)!, p.edges);
            if (before.n < minShared) continue;
            nccBeforeSum += before.ncc * before.n; nccAfterSum += after.ncc * before.n; pairWeight += before.n; pairs++;
        }
    }

    // per-sample shifts
    for (const s of cur.values()) shifts.push(s);
    const byKey = cur;
    const gridOfMap = new Map(pending.map(p => [p.map, p.gridPos]));
    samples.forEach((s, k) => {
        for (let i = 0; i < s.texel.length; i++) {
            const m = mapIndex[s.texel[i]];
            const c = byKey.get(key(m, k));
            if (!c) continue;
            if (c.affine) {
                const [nx, ny] = gridOfMap.get(m)!(s.texel[i]);
                dxOut[k][i] = c.affine.ax[0] + c.affine.ax[1] * nx + c.affine.ax[2] * ny;
                dyOut[k][i] = c.affine.ay[0] + c.affine.ay[1] * nx + c.affine.ay[2] * ny;
            } else if (c.dx || c.dy) { dxOut[k][i] = c.dx; dyOut[k][i] = c.dy; }
        }
    });
    const kept: Record<string, number> = {};
    for (const s of shifts) kept[s.kind] = (kept[s.kind] ?? 0) + 1;
    const perView = views.map((v, k) => {
        const mine = shifts.filter(s => s.view === k && s.kind === 'aligned');
        const mdx = median(mine.map(s => s.dx)), mdy = median(mine.map(s => s.dy));
        return { panoId: v.panoId, medianDx: mdx, medianDy: mdy, charts: mine.length, yawDeg: (Math.atan(mdx / v.camera.fx) * 180) / Math.PI, pitchDeg: (-Math.atan(mdy / v.camera.fy) * 180) / Math.PI };
    });
    return {
        shifts, dx: dxOut, dy: dyOut,
        report: {
            charts: pending.length, alignedPairs, kept, perView,
            interViewGradNccBefore: pairWeight ? nccBeforeSum / pairWeight : 0,
            interViewGradNccAfter: pairWeight ? nccAfterSum / pairWeight : 0,
            pairs, ms: Date.now() - t0
        }
    };
}
