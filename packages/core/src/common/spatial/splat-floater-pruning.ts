/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Statistical floater pruning for baked splat sets (k-nearest-neighbour outlier removal).
 *
 * For each splat i, d̄ᵢ is the mean distance to its k nearest neighbours (exact, via a k-d tree). The test statistic is
 * scale-free by default: rᵢ = d̄ᵢ / min{d̄ⱼ : j ∈ kNN(i)}, the splat's isolation relative to the densest neighbour it
 * reaches (the minimum, not the median, so a floater whose neighbourhood is partly other floaters still meets the surface).
 * A splat is dropped when rᵢ > τ, τ = max(mean(r) + λ·std(r), minRatio).
 *
 * Why relative: depth bakes sample the surface at a spacing proportional to depth (and stretched at grazing angles), so
 * the absolute d̄ of a correctly placed far-field or ground splat is many times the near-field mean; a global
 * mean + λ·std on absolute d̄ removes the background. A floater sits away from the surface it was sampled near, so its d̄
 * is large while its neighbours' are not. `normalize: false` gives the plain absolute test.
 * minRatio keeps image-border and silhouette splats (k = 16 on a regular grid: corner ≈ 1.5) when the surface is clean
 * enough that std(r) is tiny.
 *
 * The test is repeated on the survivors (up to `passes`) so a floater whose neighbours were all floaters is tested again
 * once they are gone.
 *
 * Deterministic: decisions depend only on the point set (kNN distance sets are unique) and sums run in index order.
 */

export interface FloaterPruningOptions {
    /** Neighbours per splat (default 16, capped at count - 1). */
    k?: number;
    /** Threshold in standard deviations above the mean statistic (default 3). */
    lambda?: number;
    /** Lower bound on the relative threshold (default 2). Ignored when normalize is false. */
    minRatio?: number;
    /** Use the neighbourhood-relative statistic (default true). */
    normalize?: boolean;
    /** Maximum prune passes over the survivors (default 3). */
    passes?: number;
}

export interface FloaterPruningReport {
    input: number;
    kept: number;
    pruned: number;
    k: number;
    lambda: number;
    normalized: boolean;
    statMean: number;
    statStd: number;
    threshold: number;
    ms: number;
}

export const FLOATER_PRUNING_DEFAULTS = { k: 16, lambda: 3, minRatio: 2, normalize: true, passes: 3 } as const;

const LEAF = 8;

class KdTree {
    readonly perm: Int32Array;
    private readonly axis: Uint8Array;
    private readonly stack = new Float64Array(3 * 2 * 64);

    private readonly n: number;

    /** Tree over the points `ids` (indices into the xyz array `p`). */
    constructor(private readonly p: ArrayLike<number>, ids: Int32Array) {
        this.n = ids.length;
        this.perm = Int32Array.from(ids);
        this.axis = new Uint8Array(this.n);
        this.build(0, this.n);
    }

    private build(lo: number, hi: number): void {
        while (hi - lo > LEAF) {
            const { p, perm } = this;
            let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
            for (let i = lo; i < hi; i++) {
                const b = perm[i] * 3, x = p[b], y = p[b + 1], z = p[b + 2];
                if (x < mnx) mnx = x; if (x > mxx) mxx = x;
                if (y < mny) mny = y; if (y > mxy) mxy = y;
                if (z < mnz) mnz = z; if (z > mxz) mxz = z;
            }
            const ex = mxx - mnx, ey = mxy - mny, ez = mxz - mnz;
            const ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
            const mid = (lo + hi) >> 1;
            this.select(lo, hi - 1, mid, ax);
            this.axis[mid] = ax;
            this.build(lo, mid);
            lo = mid + 1;
        }
    }

    /** Quickselect (Hoare partition, middle pivot): perm[k] gets the k-th smallest coordinate on `ax`. */
    private select(l: number, r: number, k: number, ax: number): void {
        const { p, perm } = this;
        while (r > l) {
            const pivot = p[perm[(l + r) >> 1] * 3 + ax];
            let i = l, j = r;
            while (i <= j) {
                while (p[perm[i] * 3 + ax] < pivot) i++;
                while (p[perm[j] * 3 + ax] > pivot) j--;
                if (i <= j) { const t = perm[i]; perm[i] = perm[j]; perm[j] = t; i++; j--; }
            }
            if (k <= j) r = j; else if (k >= i) l = i; else return;
        }
    }

    /** k nearest neighbours of point q (excluding q): squared distances ascending into d2, indices into idx. */
    knn(q: number, k: number, d2: Float64Array, idx: Int32Array): void {
        d2.fill(Infinity, 0, k);
        idx.fill(-1, 0, k);
        const { p, perm, axis, stack } = this;
        const qb = q * 3;
        const qx = p[qb], qy = p[qb + 1], qz = p[qb + 2];
        let worst = Infinity;
        // Explicit stack of [lo, hi, minimum squared distance to the range's half-space].
        let sp = 0;
        stack[sp++] = 0; stack[sp++] = this.n; stack[sp++] = 0;
        while (sp > 0) {
            const bound = stack[--sp], hi = stack[--sp], lo = stack[--sp];
            if (bound >= worst) continue;
            if (hi - lo <= LEAF) {
                for (let i = lo; i < hi; i++) {
                    const j = perm[i];
                    if (j === q) continue;
                    const b = j * 3, dx = p[b] - qx, dy = p[b + 1] - qy, dz = p[b + 2] - qz;
                    const dd = dx * dx + dy * dy + dz * dz;
                    if (dd >= worst) continue;
                    let s = k - 1;
                    while (s > 0 && d2[s - 1] > dd) { d2[s] = d2[s - 1]; idx[s] = idx[s - 1]; s--; }
                    d2[s] = dd; idx[s] = j; worst = d2[k - 1];
                }
                continue;
            }
            const mid = (lo + hi) >> 1, j = perm[mid], ax = axis[mid], b = j * 3;
            if (j !== q) {
                const dx = p[b] - qx, dy = p[b + 1] - qy, dz = p[b + 2] - qz;
                const dd = dx * dx + dy * dy + dz * dz;
                if (dd < worst) {
                    let s = k - 1;
                    while (s > 0 && d2[s - 1] > dd) { d2[s] = d2[s - 1]; idx[s] = idx[s - 1]; s--; }
                    d2[s] = dd; idx[s] = j; worst = d2[k - 1];
                }
            }
            const diff = (ax === 0 ? qx : ax === 1 ? qy : qz) - p[b + ax];
            const far = diff * diff;
            // Push the far side first so the near side is searched first.
            if (diff < 0) {
                stack[sp++] = mid + 1; stack[sp++] = hi; stack[sp++] = far;
                stack[sp++] = lo; stack[sp++] = mid; stack[sp++] = bound;
            } else {
                stack[sp++] = lo; stack[sp++] = mid; stack[sp++] = far;
                stack[sp++] = mid + 1; stack[sp++] = hi; stack[sp++] = bound;
            }
        }
    }
}

/** Computes the keep mask for `count` points stored as xyz triples. */
export function computeFloaterKeepMask(
    positions: ArrayLike<number>,
    count: number,
    options: FloaterPruningOptions = {}
): { keep: Uint8Array; report: FloaterPruningReport } {
    const t0 = Date.now();
    const lambda = options.lambda ?? FLOATER_PRUNING_DEFAULTS.lambda;
    const normalize = options.normalize ?? FLOATER_PRUNING_DEFAULTS.normalize;
    const minRatio = options.minRatio ?? FLOATER_PRUNING_DEFAULTS.minRatio;
    const passes = Math.max(1, options.passes ?? FLOATER_PRUNING_DEFAULTS.passes);
    const k = Math.max(1, Math.min(options.k ?? FLOATER_PRUNING_DEFAULTS.k, count - 1));
    const keep = new Uint8Array(count).fill(1);
    const report: FloaterPruningReport = { input: count, kept: count, pruned: 0, k, lambda, normalized: normalize, statMean: 0, statStd: 0, threshold: Infinity, ms: 0 };
    if (count < k + 2 || count < 4) { report.ms = Date.now() - t0; return { keep, report }; }

    const d2 = new Float64Array(k), idx = new Int32Array(k);
    const meanDist = new Float64Array(count);
    const stat = new Float64Array(count);
    const nbrs = new Int32Array(count * k);
    const queryMeanDist = (tree: KdTree, ids: ArrayLike<number>) => {
        for (let t = 0; t < ids.length; t++) {
            const i = ids[t];
            tree.knn(i, k, d2, idx);
            let s = 0;
            for (let j = 0; j < k; j++) s += Math.sqrt(d2[j]);
            meanDist[i] = s / k;
            nbrs.set(idx, i * k);
        }
    };
    const computeStat = (ids: ArrayLike<number>) => {
        for (let t = 0; t < ids.length; t++) {
            const i = ids[t];
            if (!normalize) { stat[i] = meanDist[i]; continue; }
            let ref = Infinity;
            for (let j = 0; j < k; j++) { const v = meanDist[nbrs[i * k + j]]; if (v < ref) ref = v; }
            stat[i] = ref > 0 ? meanDist[i] / ref : (meanDist[i] > 0 ? Infinity : 1);
        }
    };

    // Pass 1 over everything.
    const all = Int32Array.from({ length: count }, (_, i) => i);
    queryMeanDist(new KdTree(positions, all), all);
    computeStat(all);

    // τ = mean + λ·std, with the mean and std re-estimated over the splats under the current τ (sigma clipping) so the
    // floaters being tested do not inflate the std that is meant to describe the surface.
    let mean = 0, std = 0, threshold = Infinity;
    for (let iter = 0; iter < 20; iter++) {
        let sum = 0, n = 0;
        for (let i = 0; i < count; i++) { const v = stat[i]; if (v <= threshold) { sum += v; n++; } }
        if (n === 0) break;
        mean = sum / n;
        let v2 = 0;
        for (let i = 0; i < count; i++) { const v = stat[i]; if (v <= threshold) { const d = v - mean; v2 += d * d; } }
        std = Math.sqrt(v2 / n);
        const next = normalize ? Math.max(mean + lambda * std, minRatio) : mean + lambda * std;
        if (next === threshold) break;
        threshold = next;
    }
    let prunedNow: number[] = [];
    for (let i = 0; i < count; i++) if (stat[i] > threshold) { keep[i] = 0; prunedNow.push(i); }

    // Later passes re-test, against the same τ, only the survivors that had a pruned splat among their neighbours: a
    // floater whose neighbourhood was other floaters now reaches the surface.
    for (let pass = 1; pass < passes && prunedNow.length > 0; pass++) {
        const affected: number[] = [];
        for (let i = 0; i < count; i++) {
            if (!keep[i]) continue;
            for (let j = 0; j < k; j++) if (!keep[nbrs[i * k + j]]) { affected.push(i); break; }
        }
        if (affected.length === 0) break;
        const alive: number[] = [];
        for (let i = 0; i < count; i++) if (keep[i]) alive.push(i);
        queryMeanDist(new KdTree(positions, Int32Array.from(alive)), affected);
        computeStat(affected);
        prunedNow = [];
        for (const i of affected) if (stat[i] > threshold) { keep[i] = 0; prunedNow.push(i); }
    }

    let kept = 0;
    for (let i = 0; i < count; i++) kept += keep[i];
    Object.assign(report, { kept, pruned: count - kept, statMean: mean, statStd: std, threshold, ms: Date.now() - t0 });
    return { keep, report };
}

/** Drops floaters from an array of splats with a `position` triple; order of the kept splats is preserved. */
export function pruneSplatFloaters<T extends { position: ArrayLike<number> }>(
    splats: T[],
    options: FloaterPruningOptions = {}
): { splats: T[]; report: FloaterPruningReport } {
    const pos = new Float64Array(splats.length * 3);
    for (let i = 0; i < splats.length; i++) {
        const p = splats[i].position;
        pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
    }
    const { keep, report } = computeFloaterKeepMask(pos, splats.length, options);
    return { splats: report.pruned ? splats.filter((_, i) => keep[i] === 1) : splats, report };
}
