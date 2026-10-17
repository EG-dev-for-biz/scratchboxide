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
 *    (occlusion). A texel the block's view does not see takes its own best view. The data cost also penalises a view
 *    that is in cast shadow on the block (well below the other views' luminance there after the gains, or facing away
 *    from its sun when its capture time is known). The block boundaries are then refined texel by texel so they run
 *    along image edges (refineBoundariesAlongEdges).
 *  - poissonBlendRegions: the chosen views blended in the gradient domain (screened Poisson per chart), so a step
 *    between two views is spread over the regions instead of shown at the cut.
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
    /**
     * Shadow-aware data cost: a view whose block luminance is more than `shadowThreshold` (natural log) below the median of
     * the views that see the block (after the exposure gains, so a view lit differently overall is not penalised) is in a
     * cast shadow there; it pays `shadowCost` per threshold unit beyond, capped at two units. Default 1.5 and 0.3; 0 disables.
     */
    shadowCost?: number;
    shadowThreshold?: number;
    /** Known solar shading (capture time known): true where the view saw the texel facing away from the sun. Costs shadowCost x the share. */
    sunShaded?: (view: number, texel: number) => boolean;
    /**
     * Texel-level refinement of the block boundaries so they follow image edges: texels within `refineBandTexels` of a
     * boundary may take a neighbour's view, minimising the two views' disagreement on the cut, divided by the local image
     * gradient (a cut along an edge is cheap). Default 8 texels, 8 sweeps; 0 disables.
     */
    refineBandTexels?: number;
    refineSweeps?: number;
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
export function selectViewsPerRegion(atlas: UvAtlas, samples: ViewSamples[], index: TexelSampleIndex, opts: RegionSelectOptions = {}): { label: Int32Array; blocks: number; changes: number; refined: number; shadowedBlocks: number } {
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
    interface Cand { k: number; cov: number; w: number; lab: [number, number, number]; shadow: number; dark?: boolean }
    const shadowCost = opts.shadowCost ?? 1.5, shadowTau = opts.shadowThreshold ?? 0.3;
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
        const acc = new Map<number, { c: number; w: number; rgb: [number, number, number]; sun: number }>();
        for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) {
            const t = y * W + x;
            if (mapIndex[t] !== m) continue;
            for (let p = index.start[t]; p < index.start[t + 1]; p++) {
                const k = index.view[p], q = index.sample[p] * 3, rgb = samples[k].rgb;
                let a = acc.get(k);
                if (!a) { a = { c: 0, w: 0, rgb: [0, 0, 0], sun: 0 }; acc.set(k, a); }
                if (opts.sunShaded?.(k, t)) a.sun++;
                a.c++; a.w += index.weight[p]; a.rgb[0] += rgb[q]; a.rgb[1] += rgb[q + 1]; a.rgb[2] += rgb[q + 2];
            }
        }
        const list: Cand[] = [];
        for (const [k, a] of acc) {
            const cov = a.c / total;
            if (cov < 0.5) continue;
            list.push({ k, cov, w: a.w / a.c, lab: linearToLab(a.rgb[0] / a.c, a.rgb[1] / a.c, a.rgb[2] / a.c) as [number, number, number], shadow: shadowCost * (a.sun / a.c) });
        }
        if (!list.length) continue;
        if (list.length >= 2) {
            // cast shadow: well below the block's median luminance across the views that see it (L* -> log luminance)
            const logY = list.map(c => Math.log(Math.max(1e-4, ((c.lab[0] + 16) / 116) ** 3)));
            // the upper median: with two views, the darker is measured against the brighter
            const med = [...logY].sort((a, b) => a - b)[logY.length >> 1];
            list.forEach((c, i) => {
                // reported as in shadow past a fixed 0.2 (18% darker), whatever the cost's threshold
                if (med - logY[i] > 0.2) c.dark = true;
                const d = med - logY[i] - shadowTau;
                if (d > 0) c.shadow += shadowCost * Math.min(2, d / shadowTau);
            });
        }
        const bi = by * BW + bx;
        cands[bi] = list;
        blockMap[bi] = m;
    }
    const data = (c: Cand) => -Math.log(c.w + 1e-3) + covPen * (1 - c.cov) + c.shadow;
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
    // blocks left on a view in shadow there while another view that sees the block is not
    let shadowedBlocks = 0;
    for (let bi = 0; bi < BW * BH; bi++) {
        const c = cands[bi];
        if (!c || blockLabel[bi] < 0) continue;
        if (c.find(q => q.k === blockLabel[bi])?.dark && c.some(q => !q.dark)) shadowedBlocks++;
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
    const refined = (opts.refineBandTexels ?? 8) > 0 ? refineBoundariesAlongEdges(atlas, samples, index, label, cands, BW, B, data, opts) : 0;
    let changes = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) {
        const t = y * W + x;
        if (label[t] >= 0 && label[t + 1] >= 0 && label[t] !== label[t + 1] && mapIndex[t] === mapIndex[t + 1]) changes++;
    }
    return { label, blocks, changes, refined, shadowedBlocks };
}

/**
 * Moves the block MRF's boundaries onto image edges, texel by texel (iterated conditional modes inside a band around the
 * current boundaries). A texel may take the view of a 4-neighbour that sees it. Cut cost between texels p and q with views
 * a != b: (dE(a, b at p) + dE(a, b at q)) / (1 + edge), where dE is CIE76 between the two views' colours and edge the
 * strongest L* step between p and q in either view, over `edgeScale`: two views that disagree are cut where the image
 * itself changes, so the step hides in an edge. Data: the texel's block data cost of the view, over the block area
 * (a view the block did not list pays the coverage penalty). Returns the texels whose view changed.
 */
function refineBoundariesAlongEdges(atlas: UvAtlas, samples: ViewSamples[], index: TexelSampleIndex, label: Int32Array,
    cands: Array<Array<{ k: number; cov: number; w: number; lab: [number, number, number]; shadow: number; dark?: boolean }> | undefined>, BW: number, B: number,
    data: (c: { k: number; cov: number; w: number; lab: [number, number, number]; shadow: number; dark?: boolean }) => number, opts: RegionSelectOptions): number {
    const W = atlas.width, H = atlas.height, n = W * H;
    const { mapIndex } = atlas.texels;
    const band = opts.refineBandTexels ?? 8, sweeps = opts.refineSweeps ?? 8;
    const covPen = opts.coveragePenalty ?? 3;
    const cutBase = 0.5, edgeScale = 6, missing = 40;
    // L*a*b* of every sample, once
    const labOfSample = samples.map(s => {
        const out = new Float32Array(s.texel.length * 3);
        for (let i = 0; i < s.texel.length; i++) { const l = linearToLab(s.rgb[i * 3], s.rgb[i * 3 + 1], s.rgb[i * 3 + 2]); out[i * 3] = l[0]; out[i * 3 + 1] = l[1]; out[i * 3 + 2] = l[2]; }
        return out;
    });
    const sampleOf = (k: number, t: number): number => {
        for (let p = index.start[t]; p < index.start[t + 1]; p++) if (index.view[p] === k) return index.sample[p];
        return -1;
    };
    const labAt = (k: number, t: number, out: Float64Array): boolean => {
        const i = sampleOf(k, t);
        if (i < 0) return false;
        const L = labOfSample[k];
        out[0] = L[i * 3]; out[1] = L[i * 3 + 1]; out[2] = L[i * 3 + 2];
        return true;
    };
    const A = new Float64Array(3), Bv = new Float64Array(3), C = new Float64Array(3), D = new Float64Array(3);
    /** Cost of a cut between texel p with view a and texel q with view b. */
    const cut = (p: number, a: number, q: number, b: number): number => {
        if (a === b) return 0;
        const ap = labAt(a, p, A), bp = labAt(b, p, Bv), aq = labAt(a, q, C), bq = labAt(b, q, D);
        if (!ap || !bp || !aq || !bq) return missing;
        const dis = Math.hypot(A[0] - Bv[0], A[1] - Bv[1], A[2] - Bv[2]) + Math.hypot(C[0] - D[0], C[1] - D[1], C[2] - D[2]);
        const edge = Math.max(Math.abs(A[0] - C[0]), Math.abs(Bv[0] - D[0]));
        return cutBase + dis / (1 + edge / edgeScale);
    };
    const dataOf = (t: number, k: number): number => {
        const x = t % W, y = (t - x) / W;
        const c = cands[Math.floor(y / B) * BW + Math.floor(x / B)]?.find(q => q.k === k);
        return (c ? data(c) : covPen + 3) / B;
    };
    // the band: texels within `band` of a boundary between two labelled texels of one map
    const dist = new Int32Array(n).fill(band + 1);
    const queue: number[] = [];
    for (let t = 0; t < n; t++) {
        if (label[t] < 0) continue;
        const x = t % W;
        for (const u of [x + 1 < W ? t + 1 : -1, t + W < n ? t + W : -1]) {
            if (u < 0 || label[u] < 0 || label[u] === label[t] || mapIndex[u] !== mapIndex[t]) continue;
            if (dist[t]) { dist[t] = 0; queue.push(t); }
            if (dist[u]) { dist[u] = 0; queue.push(u); }
        }
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const t = queue[qi], x = t % W;
        if (dist[t] >= band) continue;
        for (const u of [x > 0 ? t - 1 : -1, x + 1 < W ? t + 1 : -1, t - W, t + W]) {
            if (u < 0 || u >= n || label[u] < 0 || mapIndex[u] !== mapIndex[t] || dist[u] <= dist[t] + 1) continue;
            dist[u] = dist[t] + 1; queue.push(u);
        }
    }
    const bandTexels = queue.filter(t => dist[t] <= band);
    let changed = 0;
    const nb = (t: number): number[] => {
        const x = t % W, out: number[] = [];
        if (x > 0) out.push(t - 1);
        if (x + 1 < W) out.push(t + 1);
        if (t - W >= 0) out.push(t - W);
        if (t + W < n) out.push(t + W);
        return out.filter(u => label[u] >= 0 && mapIndex[u] === mapIndex[t]);
    };
    for (let s = 0; s < sweeps; s++) {
        let moved = 0;
        for (const t of bandTexels) {
            const ns = nb(t);
            const options = new Set<number>([label[t]]);
            for (const u of ns) if (sampleOf(label[u], t) >= 0) options.add(label[u]);
            if (options.size < 2) continue;
            let best = label[t], bestCost = Infinity;
            for (const k of options) {
                let c = dataOf(t, k);
                for (const u of ns) c += cut(t, k, u, label[u]);
                if (c < bestCost - 1e-9) { bestCost = c; best = k; }
            }
            if (best !== label[t]) { label[t] = best; moved++; }
        }
        changed += moved;
        if (!moved) break;
    }
    return changed;
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

export interface PoissonBlendOptions {
    /**
     * Screening weight of the data term (pull toward the chosen view's own colour). A step at a boundary is spread over
     * about 1 / sqrt(lambda) texels on either side. Default 1e-2 (~10 texels; measured on the live arch replays: 2e-3 let
     * misregistered views on the small scan islands float, 1e-2 kept their low-frequency step at the interior contrast).
     */
    lambda?: number;
    maxIterations?: number;
    /** Relative residual at which the conjugate gradient stops. Default 1e-4. */
    tolerance?: number;
    signal?: AbortSignal;
}

export interface PoissonBlendReport { texels: number; edges: number; boundaryEdges: number; iterations: number; relResidual: number; ms: number }

/**
 * Gradient-domain (screened Poisson) blend of the region selection, per atlas chart. Unknown: the linear RGB of every
 * texel some view sees. Each edge between two such texels of one chart asks the output to change as the chosen view
 * changes there: inside a region that view's own step; across a boundary between views a and b the mean of a's step and
 * b's step (each where that view sees both texels), or no step when neither does, so a colour or exposure step between
 * views is not reproduced but spread smoothly into both regions. A weak screening term (lambda) keeps every texel near
 * its chosen view's colour, so the levels stay the photos' and only the boundary steps move. Edges never cross charts or
 * enter texels no view sees (gutters, other rungs): Neumann there. Solved for all charts at once (the system is block
 * diagonal per chart) by Jacobi-preconditioned conjugate gradients, the three channels together.
 * Returns the blended colour for the domain texels (others untouched in `out`).
 */
export function poissonBlendRegions(atlas: UvAtlas, samples: ViewSamples[], index: TexelSampleIndex, label: Int32Array, out: Float64Array, opts: PoissonBlendOptions = {}): PoissonBlendReport {
    const t0 = Date.now();
    const W = atlas.width, n = W * atlas.height;
    const { mapIndex } = atlas.texels;
    const lambda = opts.lambda ?? 1e-2, maxIt = opts.maxIterations ?? 600, tol = opts.tolerance ?? 1e-4;
    const sampleOf = (k: number, t: number): number => {
        if (k < 0) return -1;
        for (let p = index.start[t]; p < index.start[t + 1]; p++) if (index.view[p] === k) return index.sample[p];
        return -1;
    };
    // domain
    const local = new Int32Array(n).fill(-1);
    const texels: number[] = [];
    for (let t = 0; t < n; t++) if (label[t] >= 0 && sampleOf(label[t], t) >= 0) { local[t] = texels.length; texels.push(t); }
    const N = texels.length;
    if (!N) return { texels: 0, edges: 0, boundaryEdges: 0, iterations: 0, relResidual: 0, ms: 0 };
    const d = new Float64Array(N * 3);
    texels.forEach((t, i) => { const q = sampleOf(label[t], t) * 3, rgb = samples[label[t]].rgb; d[i * 3] = rgb[q]; d[i * 3 + 1] = rgb[q + 1]; d[i * 3 + 2] = rgb[q + 2]; });
    // edges (right, down) and the right-hand side: lambda d + div g
    const ea: number[] = [], eb: number[] = [];
    const b = new Float64Array(N * 3);
    for (let i = 0; i < N * 3; i++) b[i] = lambda * d[i];
    const deg = new Float64Array(N);
    let boundaryEdges = 0;
    const g = new Float64Array(3);
    for (let i = 0; i < N; i++) {
        const t = texels[i], x = t % W;
        for (const u of [x + 1 < W ? t + 1 : -1, t + W < n ? t + W : -1]) {
            if (u < 0) continue;
            const j = local[u];
            if (j < 0 || mapIndex[u] !== mapIndex[t]) continue;
            const la = label[t], lb = label[u];
            if (la === lb) {
                for (let c = 0; c < 3; c++) g[c] = d[j * 3 + c] - d[i * 3 + c];
            } else {
                boundaryEdges++;
                g.fill(0);
                const au = sampleOf(la, u), bt = sampleOf(lb, t);
                // each view's own step from t to u; where both have one, the smaller (zero when they disagree in sign), so a
                // step one view shows because it is misregistered there is not carried across the boundary
                for (let c = 0; c < 3; c++) {
                    const sa = au >= 0 ? samples[la].rgb[au * 3 + c] - d[i * 3 + c] : NaN;
                    const sb = bt >= 0 ? d[j * 3 + c] - samples[lb].rgb[bt * 3 + c] : NaN;
                    if (Number.isNaN(sa)) g[c] = Number.isNaN(sb) ? 0 : sb;
                    else if (Number.isNaN(sb)) g[c] = sa;
                    else g[c] = sa * sb <= 0 ? 0 : Math.abs(sa) < Math.abs(sb) ? sa : sb;
                }
            }
            ea.push(i); eb.push(j);
            deg[i]++; deg[j]++;
            for (let c = 0; c < 3; c++) { b[i * 3 + c] -= g[c]; b[j * 3 + c] += g[c]; }
        }
    }
    const E = ea.length;
    const EA = Int32Array.from(ea), EB = Int32Array.from(eb);
    const apply = (v: Float64Array, res: Float64Array): void => {
        for (let i = 0; i < N; i++) { const s = deg[i] + lambda; res[i * 3] = s * v[i * 3]; res[i * 3 + 1] = s * v[i * 3 + 1]; res[i * 3 + 2] = s * v[i * 3 + 2]; }
        for (let e = 0; e < E; e++) {
            const i = EA[e] * 3, j = EB[e] * 3;
            res[i] -= v[j]; res[i + 1] -= v[j + 1]; res[i + 2] -= v[j + 2];
            res[j] -= v[i]; res[j + 1] -= v[i + 1]; res[j + 2] -= v[i + 2];
        }
    };
    // CG from x = d, the three channels as one vector (independent systems with the same matrix: one dot product is fine
    // for convergence since the matrix is the same block for each channel)
    const x = Float64Array.from(d);
    const r = new Float64Array(N * 3), z = new Float64Array(N * 3), p = new Float64Array(N * 3), Ap = new Float64Array(N * 3);
    apply(x, Ap);
    let bn = 0;
    for (let i = 0; i < N * 3; i++) { r[i] = b[i] - Ap[i]; bn += b[i] * b[i]; }
    bn = Math.sqrt(bn) || 1;
    const prec = (src: Float64Array, dst: Float64Array) => { for (let i = 0; i < N; i++) { const s = 1 / (deg[i] + lambda); dst[i * 3] = src[i * 3] * s; dst[i * 3 + 1] = src[i * 3 + 1] * s; dst[i * 3 + 2] = src[i * 3 + 2] * s; } };
    prec(r, z);
    p.set(z);
    let rz = 0;
    for (let i = 0; i < N * 3; i++) rz += r[i] * z[i];
    let it = 0, rel = 0;
    for (; it < maxIt; it++) {
        if ((it & 31) === 0 && opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('poisson blend aborted');
        apply(p, Ap);
        let pAp = 0;
        for (let i = 0; i < N * 3; i++) pAp += p[i] * Ap[i];
        if (!(pAp > 0)) break;
        const alpha = rz / pAp;
        let rr = 0;
        for (let i = 0; i < N * 3; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rr += r[i] * r[i]; }
        rel = Math.sqrt(rr) / bn;
        if (rel < tol) { it++; break; }
        prec(r, z);
        let rz1 = 0;
        for (let i = 0; i < N * 3; i++) rz1 += r[i] * z[i];
        const beta = rz1 / rz;
        rz = rz1;
        for (let i = 0; i < N * 3; i++) p[i] = z[i] + beta * p[i];
    }
    texels.forEach((t, i) => { out[t * 3] = Math.max(0, x[i * 3]); out[t * 3 + 1] = Math.max(0, x[i * 3 + 1]); out[t * 3 + 2] = Math.max(0, x[i * 3 + 2]); });
    return { texels: N, edges: E, boundaryEdges, iterations: it, relResidual: rel, ms: Date.now() - t0 };
}
