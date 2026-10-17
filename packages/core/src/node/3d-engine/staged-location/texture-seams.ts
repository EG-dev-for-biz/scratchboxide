/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Seam handling for the Street View projection bake (design section 4 step 5): instead of averaging the views a texel
 * sees (which draws a figure twice wherever the poses disagree), every region takes ONE view, and the views meet at
 * boundaries chosen where they agree, blended band by band.
 *
 *  - chartLocalGains: per (chart, view) exposure gain on top of the per-view gains: the median per-channel log ratio of
 *    the view to the weighted mean over the chart's multi-view texels, clamped. A view lit differently on one face than
 *    on another (a sunlit and a shaded face in the same photo) is matched face by face.
 *  - selectViewsPerRegion: a Markov random field over blocks of B x B texels per chart, solved by iterated conditional
 *    modes from the best-weight start. Data cost: -ln(mean normalised weight) plus a penalty for the share of the block
 *    the view does not see; smoothness: a constant per label change plus the colour disagreement (CIE76 of block means)
 *    of the two views on both blocks. Boundaries therefore run where the views agree and where they change anyway
 *    (occlusion). A texel the block's view does not see takes its own best view.
 *  - blurWithinMaps: Gaussian blur restricted to each atlas map and to a rectangle, for the band blend.
 */

import type { UvAtlas } from '../../../common/spatial/texture-pass-contracts';
import type { TexelSampleIndex, ViewSamples } from './texel-exposure';
import { linearToLab } from './texel-exposure';

export interface RegionSelectOptions {
    /** Block side in texels. Default 8. */
    blockTexels?: number;
    /** Cost of a label change between neighbouring blocks, and per CIE76 unit of disagreement. Defaults 0.4 and 0.08. */
    changeCost?: number;
    disagreementCost?: number;
    /** Penalty per unit of the block a view does not see. Default 3. */
    coveragePenalty?: number;
    sweeps?: number;
}

/** Per (map, view) gains, applied to the samples in place; returns how many (map, view) pairs got one and the mean |log gain|. */
export function chartLocalGains(atlas: UvAtlas, samples: ViewSamples[], index: TexelSampleIndex, mean: Float64Array, maxLogGain = 0.4): { pairs: number; meanAbsLogGain: number } {
    const n = atlas.width * atlas.height;
    const { mapIndex } = atlas.texels;
    // per (map, view): log ratios per channel at texels with >= 2 views
    const ratios = new Map<string, number[][]>();
    for (let t = 0; t < n; t++) {
        const a = index.start[t], b = index.start[t + 1];
        if (b - a < 2) continue;
        const m = mapIndex[t];
        for (let p = a; p < b; p++) {
            const k = index.view[p], q = index.sample[p] * 3, rgb = samples[k].rgb;
            const key = `${m}:${k}`;
            let r = ratios.get(key);
            if (!r) { r = [[], [], []]; ratios.set(key, r); }
            for (let c = 0; c < 3; c++) if (rgb[q + c] > 2e-3 && mean[t * 3 + c] > 2e-3) r[c].push(Math.log(rgb[q + c] / mean[t * 3 + c]));
        }
    }
    const gain = new Map<string, [number, number, number]>();
    let sum = 0, cnt = 0;
    for (const [key, r] of ratios) {
        if (r[0].length < 64) continue;
        const g = r.map(v => { const s = [...v].sort((x, y) => x - y); return Math.max(-maxLogGain, Math.min(maxLogGain, -s[s.length >> 1])); }) as [number, number, number];
        gain.set(key, g);
        sum += (Math.abs(g[0]) + Math.abs(g[1]) + Math.abs(g[2])) / 3; cnt++;
    }
    if (!gain.size) return { pairs: 0, meanAbsLogGain: 0 };
    samples.forEach((s, k) => {
        for (let i = 0; i < s.texel.length; i++) {
            const g = gain.get(`${mapIndex[s.texel[i]]}:${k}`);
            if (!g) continue;
            for (let c = 0; c < 3; c++) s.rgb[i * 3 + c] *= Math.exp(g[c]);
        }
    });
    return { pairs: gain.size, meanAbsLogGain: sum / cnt };
}

/** One view per texel (-1 where none): see the file comment. */
export function selectViewsPerRegion(atlas: UvAtlas, samples: ViewSamples[], index: TexelSampleIndex, opts: RegionSelectOptions = {}): { label: Int32Array; blocks: number; changes: number } {
    const B = opts.blockTexels ?? 8, lam0 = opts.changeCost ?? 0.4, lam1 = opts.disagreementCost ?? 0.08, covPen = opts.coveragePenalty ?? 3, sweeps = opts.sweeps ?? 6;
    const W = atlas.width, H = atlas.height, n = W * H;
    const { mapIndex } = atlas.texels;
    const label = new Int32Array(n).fill(-1);
    // best view per texel by normalised weight
    for (let t = 0; t < n; t++) {
        let best = -1, bw = -1;
        for (let p = index.start[t]; p < index.start[t + 1]; p++) if (index.weight[p] > bw) { bw = index.weight[p]; best = index.view[p]; }
        label[t] = best;
    }
    // blocks: per block, per candidate view, coverage, mean weight and mean Lab colour
    const BW = Math.ceil(W / B), BH = Math.ceil(H / B);
    interface Cand { k: number; cov: number; w: number; lab: [number, number, number] }
    const cands: Array<Cand[] | undefined> = new Array(BW * BH);
    const blockMap = new Int32Array(BW * BH).fill(-1);
    for (let by = 0; by < BH; by++) for (let bx = 0; bx < BW; bx++) {
        // a block belongs to one map: the most common one among its baked texels (texels of other maps keep their best view)
        const counts = new Map<number, number>();
        for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) {
            const t = y * W + x;
            if (index.start[t + 1] > index.start[t]) counts.set(mapIndex[t], (counts.get(mapIndex[t]) ?? 0) + 1);
        }
        if (!counts.size) continue;
        const m = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const total = counts.get(m)!;
        const acc = new Map<number, { c: number; w: number; rgb: [number, number, number] }>();
        for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) {
            const t = y * W + x;
            if (mapIndex[t] !== m) continue;
            for (let p = index.start[t]; p < index.start[t + 1]; p++) {
                const k = index.view[p], q = index.sample[p] * 3, rgb = samples[k].rgb;
                let a = acc.get(k);
                if (!a) { a = { c: 0, w: 0, rgb: [0, 0, 0] }; acc.set(k, a); }
                a.c++; a.w += index.weight[p]; a.rgb[0] += rgb[q]; a.rgb[1] += rgb[q + 1]; a.rgb[2] += rgb[q + 2];
            }
        }
        const list: Cand[] = [];
        for (const [k, a] of acc) {
            const cov = a.c / total;
            if (cov < 0.5) continue;
            list.push({ k, cov, w: a.w / a.c, lab: linearToLab(a.rgb[0] / a.c, a.rgb[1] / a.c, a.rgb[2] / a.c) as [number, number, number] });
        }
        if (!list.length) continue;
        const bi = by * BW + bx;
        cands[bi] = list;
        blockMap[bi] = m;
    }
    const data = (c: Cand) => -Math.log(c.w + 1e-3) + covPen * (1 - c.cov);
    const labOf = (bi: number, k: number) => cands[bi]?.find(c => c.k === k)?.lab;
    const disagree = (bi: number, a: number, b: number): number => {
        const la = labOf(bi, a), lb = labOf(bi, b);
        return la && lb ? Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]) : 30;
    };
    const blockLabel = new Int32Array(BW * BH).fill(-1);
    for (let bi = 0; bi < BW * BH; bi++) {
        const c = cands[bi];
        if (!c) continue;
        let best = c[0];
        for (const x of c) if (data(x) < data(best)) best = x;
        blockLabel[bi] = best.k;
    }
    const nbrs = (bi: number): number[] => {
        const bx = bi % BW, by = (bi - bx) / BW;
        const out: number[] = [];
        if (bx > 0) out.push(bi - 1);
        if (bx + 1 < BW) out.push(bi + 1);
        if (by > 0) out.push(bi - BW);
        if (by + 1 < BH) out.push(bi + BW);
        return out.filter(j => blockMap[j] === blockMap[bi] && blockLabel[j] >= 0);
    };
    for (let s = 0; s < sweeps; s++) {
        let changed = 0;
        for (let bi = 0; bi < BW * BH; bi++) {
            const c = cands[bi];
            if (!c || c.length < 2) continue;
            const nb = nbrs(bi);
            let best = blockLabel[bi], bestCost = Infinity;
            for (const x of c) {
                let cost = data(x);
                for (const j of nb) {
                    const lj = blockLabel[j];
                    if (lj === x.k) continue;
                    cost += lam0 + lam1 * 0.5 * (disagree(bi, x.k, lj) + disagree(j, x.k, lj));
                }
                if (cost < bestCost - 1e-9) { bestCost = cost; best = x.k; }
            }
            if (best !== blockLabel[bi]) { blockLabel[bi] = best; changed++; }
        }
        if (!changed) break;
    }
    // texels: the block's view where it sees the texel
    let blocks = 0;
    for (let bi = 0; bi < BW * BH; bi++) {
        const k = blockLabel[bi];
        if (k < 0) continue;
        blocks++;
        const bx = bi % BW, by = (bi - bx) / BW;
        for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) {
            const t = y * W + x;
            if (mapIndex[t] !== blockMap[bi]) continue;
            for (let p = index.start[t]; p < index.start[t + 1]; p++) if (index.view[p] === k) { label[t] = k; break; }
        }
    }
    let changes = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) {
        const t = y * W + x;
        if (label[t] >= 0 && label[t + 1] >= 0 && label[t] !== label[t + 1] && mapIndex[t] === mapIndex[t + 1]) changes++;
    }
    return { label, blocks, changes };
}

/**
 * Separable Gaussian of `fields` weighted by `mask`, never mixing texels of different atlas maps, computed inside the
 * rectangle [x0, x1) x [y0, y1) only (texels outside it are 0). Returns blurred fields and the blurred mask.
 */
export function blurWithinMaps(fields: Float64Array[], mask: Float64Array, sigma: number, W: number, H: number, mapIndex: Uint16Array, covered: Uint8Array,
    rect: [number, number, number, number] = [0, 0, W, H]): { f: Float64Array[]; m: Float64Array } {
    const n = W * H, nf = fields.length;
    const [x0, y0, x1, y1] = rect;
    if (sigma >= 2) return boxBlurWithinMaps(fields, mask, sigma, W, mapIndex, covered, rect);
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float64Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    const pass = (src: Float64Array[], srcM: Float64Array, horizontal: boolean): { f: Float64Array[]; m: Float64Array } => {
        const f = src.map(() => new Float64Array(n));
        const m = new Float64Array(n);
        const acc = new Float64Array(nf);
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = y * W + x;
                if (!covered[i]) continue;
                const mi = mapIndex[i];
                let sm = 0;
                acc.fill(0);
                const lo = Math.max(-r, horizontal ? x0 - x : y0 - y), hi = Math.min(r, horizontal ? x1 - 1 - x : y1 - 1 - y);
                for (let d = lo; d <= hi; d++) {
                    const j = horizontal ? i + d : i + d * W;
                    if (!covered[j] || mapIndex[j] !== mi) continue;
                    const w = k[d + r];
                    const mj = srcM[j];
                    sm += w * mj;
                    for (let c = 0; c < nf; c++) acc[c] += w * src[c][j];
                }
                m[i] = sm;
                for (let c = 0; c < nf; c++) f[c][i] = acc[c];
            }
        }
        return { f, m };
    };
    const pre = fields.map((fl) => { const o = new Float64Array(n); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * W + x; o[i] = fl[i] * mask[i]; } return o; });
    const h = pass(pre, mask, true);
    return pass(h.f, h.m, false);
}

/**
 * The same blur for large sigmas, as three box passes per axis (variance 3 ((2 rb + 1)^2 - 1) / 12 = sigma^2) over runs of
 * texels of one map, with running sums: O(1) per texel whatever the sigma. Runs break where the map changes or a texel is
 * not covered.
 */
function boxBlurWithinMaps(fields: Float64Array[], mask: Float64Array, sigma: number, W: number, mapIndex: Uint16Array, covered: Uint8Array,
    rect: [number, number, number, number]): { f: Float64Array[]; m: Float64Array } {
    const [x0, y0, x1, y1] = rect;
    const n = mapIndex.length;
    const rb = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const chans = [...fields.map(fl => { const o = new Float64Array(n); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * W + x; o[i] = fl[i] * mask[i]; } return o; })];
    const m = new Float64Array(n);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * W + x; m[i] = mask[i]; }
    chans.push(m);
    const len = Math.max(x1 - x0, y1 - y0);
    const buf = new Float64Array(len), pre = new Float64Array(len + 1);
    const runPass = (arr: Float64Array, idx: (j: number) => number, count: number): void => {
        // runs of covered texels of one map along the line
        let a = 0;
        while (a < count) {
            const ia = idx(a);
            if (!covered[ia]) { a++; continue; }
            const mi = mapIndex[ia];
            let b = a + 1;
            while (b < count) { const ib = idx(b); if (!covered[ib] || mapIndex[ib] !== mi) break; b++; }
            const L = b - a;
            for (let j = 0; j < L; j++) buf[j] = arr[idx(a + j)];
            for (let pass = 0; pass < 3; pass++) {
                pre[0] = 0;
                for (let j = 0; j < L; j++) pre[j + 1] = pre[j] + buf[j];
                for (let j = 0; j < L; j++) buf[j] = pre[Math.min(L, j + rb + 1)] - pre[Math.max(0, j - rb)];
            }
            for (let j = 0; j < L; j++) arr[idx(a + j)] = buf[j];
            a = b;
        }
    };
    for (const arr of chans) {
        for (let y = y0; y < y1; y++) runPass(arr, j => y * W + x0 + j, x1 - x0);
        for (let x = x0; x < x1; x++) runPass(arr, j => (y0 + j) * W + x, y1 - y0);
    }
    const mOut = chans.pop()!;
    return { f: chans, m: mOut };
}
