/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Rung 2 of the surface infill (surface-infill.ts): continuation from the same surface's own clear texels, chosen by
 * what the surface measures.
 *
 * 1. **The reading** (`readStructure`): over the clear texels around the region, the colour structure tensor (the
 *    direction the surface varies least along, and how coherently: lane lines, kerbs, gutters, courses, a path's edge) and
 *    the repeat along and across that direction (texture-repeat.ts's gates: lagged NCC, repeats, phase contrast against
 *    the noise), giving each measured period and its phase.
 * 2. **The fill** (`synthesize`): exemplar synthesis whose sources are constrained by the reading. Every target texel takes
 *    the clear texel at some offset from it; the rung fixes which offsets are admissible:
 *    - directional: along the measured direction only (the source on the same line: a line or a kerb continues, the
 *      texel's grain comes with it), at whole multiples of the measured period along it when one is measured (dashes),
 *      and of the period across it (crossing bars);
 *    - periodic: whole multiples of the measured lattice (a pattern continues in phase);
 *    - stochastic: any clear texel (paving, gravel, grass, tarmac grain).
 *    Texels are taken from the region's edge inward (onion peel), each choosing among its neighbours' offsets (coherence:
 *    a copied patch stays whole) and fresh admissible ones by the 7 x 7 neighbourhood match (a sparse 25-sample stencil),
 *    a source used again costing a little more (no visible copy). A second pass re-chooses each texel with its whole
 *    neighbourhood filled.
 * 3. **The join** (`correctToRim`): the mismatch between the fill and the texels around it, read at the rim from each
 *    side's own 5 x 5 mean, carried across the fill as a smooth field (push-pull), so the join has no step and the grain
 *    is kept.
 */

import { MAX_PERIOD_M, MIN_PERIOD_M, MIN_REPEATS, NCC_GATE, K_SIGMA, MIN_BIN_SAMPLES, TRIM } from './texture-repeat';

export const INFILL_SYNTHESIS_PARAMS = {
    /** The clear texels read for the structure: within this of the region (m), nearer counting more (sigma, m). */
    readM: 4, readSigmaM: 1.5,
    /** Directional when the structure tensor's coherence is at least this. */
    coherenceMin: 0.25,
    /** A repeat along the direction is also read strip by strip, this wide (m); a strip whose luma spreads less than stripMinSpread is skipped. */
    stripM: 0.3, stripMinSpread: 12,
    /** Admissible offsets along the line: at least this (texels, so a patch never overlaps its own source), at most searchM. */
    minOffsetPx: 4, searchM: 14,
    /** Fresh candidates a texel tries per pass (the first, then each refinement). */
    freshFirst: 10, freshRefine: 4,
    /** Refinement passes after the first. */
    refinePasses: 2,
    /** A neighbourhood match needs at least this many samples compared. */
    minSamples: 5,
    /** A sample of the target's window whose source texel is not clear costs this (squared sRGB units, per channel). */
    missingCost: 2500,
    /** Each further use of a source texel costs this (squared sRGB units): keeps copies from repeating. */
    reuseCost: 60,
    /**
     * A fresh candidate (not continuing a neighbour's copy) costs this many times its match plus freshCost (squared sRGB
     * units): copies stay whole unless a fresh source matches clearly better, so a soft photo is not cut into texel noise.
     */
    freshFactor: 1.5, freshCost: 40,
    /** Periodic lattice multiples tried (each way). */
    latticeReach: 6,
    /** The join: rim mismatch capped at this a channel. */
    rimCap: 45,
    /** Seed of the random generator (reproducible fills). */
    seed: 0x5eed
};
export type InfillSynthesisParams = typeof INFILL_SYNTHESIS_PARAMS;

/** Fills the unknown entries of a `c`-channel field from the known ones (push-pull over a pyramid). */
export function pushPull(values: Float32Array, known: Float32Array, w: number, h: number, c: number): Float32Array {
    if (w <= 1 && h <= 1) return values.slice();
    const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
    const cv = new Float32Array(cw * ch * c), ck = new Float32Array(cw * ch);
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) {
        const wt = known[k * w + i];
        if (!(wt > 0)) continue;
        const q = (k >> 1) * cw + (i >> 1);
        ck[q] += wt;
        for (let j = 0; j < c; j++) cv[q * c + j] += wt * values[(k * w + i) * c + j];
    }
    for (let q = 0; q < cw * ch; q++) if (ck[q] > 0) { for (let j = 0; j < c; j++) cv[q * c + j] /= ck[q]; ck[q] = Math.min(1, ck[q]); }
    const coarse = ck.some(v => v > 0) ? pushPull(cv, ck, cw, ch, c) : cv;
    const out = new Float32Array(w * h * c);
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) {
        // bilinear from the coarse level (its texel centres at (2i + 0.5) of this level)
        const fx = Math.max(0, Math.min(cw - 1, (i - 0.5) / 2)), fz = Math.max(0, Math.min(ch - 1, (k - 0.5) / 2));
        const i0 = Math.floor(fx), k0 = Math.floor(fz), i1 = Math.min(cw - 1, i0 + 1), k1 = Math.min(ch - 1, k0 + 1);
        const ax = fx - i0, az = fz - k0;
        const wt = Math.min(1, known[k * w + i] || 0);
        for (let j = 0; j < c; j++) {
            const up = (1 - az) * ((1 - ax) * coarse[(k0 * cw + i0) * c + j] + ax * coarse[(k0 * cw + i1) * c + j]) + az * ((1 - ax) * coarse[(k1 * cw + i0) * c + j] + ax * coarse[(k1 * cw + i1) * c + j]);
            out[(k * w + i) * c + j] = wt * values[(k * w + i) * c + j] + (1 - wt) * up;
        }
    }
    return out;
}

/** A small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface MeasuredPeriod {
    /** Along which unit direction (texel space). */
    axis: [number, number];
    pitchPx: number; pitchM: number; ncc: number; repeats: number;
    /** The phase (texels, 0..pitchPx) of the profile's darkest bin: where the pattern stands. */
    phasePx: number;
}

export interface StructureReading {
    /** The direction (unit, texel space: +i, +k) the clear texels vary least along, and the structure tensor's coherence. */
    dir: [number, number];
    coherence: number;
    angleDeg: number;
    /** The periods measured along and across `dir`. */
    along?: MeasuredPeriod;
    across?: MeasuredPeriod;
    /** Why a direction or a period was not taken. */
    refusals: string[];
    /** Clear texels read. */
    texels: number;
}

const luma = (rgb: Float32Array, p: number) => 0.299 * rgb[p * 3] + 0.587 * rgb[p * 3 + 1] + 0.114 * rgb[p * 3 + 2];

function trimmed(values: number[]): { mean: number; se: number; n: number } {
    const s = values.slice().sort((a, b) => a - b);
    const cut = Math.floor(s.length * TRIM);
    const k = s.slice(cut, s.length - cut);
    const n = k.length;
    if (!n) return { mean: NaN, se: NaN, n: 0 };
    const mean = k.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(k.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    return { mean, se: sd / Math.sqrt(n), n: values.length };
}

/** The profile along `axis` of the luma of the `use` texels, a bin per texel; its pitch when it passes texture-repeat's gates. */
export function periodAlong(rgb: Float32Array, use: number[], W: number, axis: [number, number], texelM: number, label: string): MeasuredPeriod | string {
    let lo = Infinity, hi = -Infinity;
    const proj = use.map(p => { const i = p % W, k = (p - i) / W; const s = Math.round(i * axis[0] + k * axis[1]); lo = Math.min(lo, s); hi = Math.max(hi, s); return s; });
    if (!use.length) return `no clear texels to read a period ${label}`;
    const n = hi - lo + 1;
    const vals: number[][] = Array.from({ length: n }, () => []);
    use.forEach((p, j) => vals[proj[j] - lo].push(luma(rgb, p)));
    const bins = vals.map(v => (v.length >= MIN_BIN_SAMPLES ? trimmed(v) : { mean: NaN, se: NaN, n: 0 }));
    const valid = bins.filter(b => b.n >= MIN_BIN_SAMPLES).length;
    if (valid < MIN_BIN_SAMPLES * MIN_REPEATS) return `too few clear texels ${label} to read a period (${valid} profile bins)`;
    const minLag = Math.max(2, Math.round(MIN_PERIOD_M / texelM)), maxLag = Math.min(Math.floor(n / MIN_REPEATS), Math.round(MAX_PERIOD_M / texelM));
    if (maxLag <= minLag) return `the clear surface is too short ${label} for ${MIN_REPEATS} repeats`;
    const nccAt = (lag: number): number | undefined => {
        let sa = 0, sb = 0, m = 0;
        for (let k = 0; k + lag < n; k++) if (bins[k].n && bins[k + lag].n) { sa += bins[k].mean; sb += bins[k + lag].mean; m++; }
        if (m < MIN_BIN_SAMPLES) return undefined;
        const ma = sa / m, mb = sb / m;
        let num = 0, da = 0, db = 0;
        for (let k = 0; k + lag < n; k++) if (bins[k].n && bins[k + lag].n) { const x = bins[k].mean - ma, y = bins[k + lag].mean - mb; num += x * y; da += x * x; db += y * y; }
        return da * db > 1e-9 ? num / Math.sqrt(da * db) : 0;
    };
    const curve: Array<number | undefined> = [];
    let top = -Infinity;
    for (let lag = 0; lag <= maxLag; lag++) { const c = lag >= minLag ? nccAt(lag) : undefined; curve.push(c); if (c !== undefined && c > top) top = c; }
    if (!(top >= NCC_GATE)) return `no period ${label} between ${MIN_PERIOD_M} and ${MAX_PERIOD_M} m correlates at ${NCC_GATE} (best ${top > -Infinity ? top.toFixed(2) : 'n/a'})`;
    // the fundamental: the shortest local peak within 0.05 of the best (its multiples correlate as well)
    let best: { lag: number; ncc: number } | undefined;
    for (let lag = minLag; lag <= maxLag && !best; lag++) {
        const c = curve[lag];
        if (c === undefined || c < top - 0.05) continue;
        if ((curve[lag - 1] ?? -Infinity) <= c && (curve[lag + 1] ?? -Infinity) <= c) best = { lag, ncc: c };
    }
    if (!best) return `no clean peak of the correlation ${label}`;
    // a repeat decorrelates between its copies (a smooth trend or a single edge does not), and is seen a third time
    const half = nccAt(Math.max(1, Math.round(best.lag / 2)));
    if (half !== undefined && half > best.ncc - 0.2) return `the profile ${label} does not fall between its ${(best.lag * texelM).toFixed(2)} m copies (NCC ${half.toFixed(2)} at half): a trend or a single edge, not a repeat`;
    const twice = 2 * best.lag <= n - MIN_BIN_SAMPLES ? nccAt(2 * best.lag) : undefined;
    if (twice === undefined || twice < NCC_GATE - 0.1) return `the ${(best.lag * texelM).toFixed(2)} m pattern ${label} is not seen a third time (NCC ${twice === undefined ? 'n/a' : twice.toFixed(2)} at twice the pitch): two features, not a repeat`;
    // phase contrast against the noise: the spread of the profile between its repeats at the same phase (robust), not
    // the spread within a bin (a strip's bin mixes the rows across it)
    const phases: number[][] = Array.from({ length: best.lag }, () => []);
    bins.forEach((b, k) => { if (b.n) phases[k % best!.lag].push(b.mean); });
    const phaseMean = phases.map(p => (p.length ? trimmed(p).mean : NaN));
    const means = phaseMean.filter(v => v === v);
    const resid: number[] = [];
    bins.forEach((b, k) => { const m = phaseMean[k % best!.lag]; if (b.n && m === m && phases[k % best!.lag].length > 1) resid.push(Math.abs(b.mean - m)); });
    resid.sort((a, b) => a - b);
    const noise = 1.4826 * (resid[resid.length >> 1] ?? 0) || 1e-6;
    const amp = Math.max(...means) - Math.min(...means);
    if (amp < K_SIGMA * noise) return `the repeat ${label} is too faint to trust (phase contrast ${amp.toFixed(1)} < ${K_SIGMA} x noise ${noise.toFixed(1)})`;
    let darkest = 0, dv = Infinity;
    phases.forEach((p, k) => { if (p.length) { const m = trimmed(p).mean; if (m < dv) { dv = m; darkest = k; } } });
    return { axis, pitchPx: best.lag, pitchM: best.lag * texelM, ncc: Math.round(best.ncc * 1000) / 1000, repeats: Math.floor(n / best.lag), phasePx: (((darkest + lo) % best.lag) + best.lag) % best.lag };
}

/**
 * The structure of the clear texels `source` within `readM` of the `target` texels: direction, coherence and periods (see
 * the file comment).
 */
export function readStructure(rgb: Float32Array, source: Uint8Array, target: Uint8Array, W: number, H: number, texelM: number, P: InfillSynthesisParams = INFILL_SYNTHESIS_PARAMS): StructureReading {
    const readPx = Math.max(3, Math.round(P.readM / texelM));
    // distance from the target (4-neighbour steps)
    const dist = new Int32Array(W * H).fill(-1);
    let frontier: number[] = [];
    for (let p = 0; p < W * H; p++) if (target[p]) { dist[p] = 0; frontier.push(p); }
    for (let s = 1; s <= readPx && frontier.length; s++) {
        const next: number[] = [];
        for (const p of frontier) {
            const i = p % W;
            for (const q of [i > 0 ? p - 1 : -1, i < W - 1 ? p + 1 : -1, p - W, p + W]) if (q >= 0 && q < W * H && dist[q] < 0) { dist[q] = s; next.push(q); }
        }
        frontier = next;
    }
    const use: number[] = [];
    for (let p = 0; p < W * H; p++) if (source[p] && dist[p] > 0) use.push(p);
    let jxx = 0, jzz = 0, jxz = 0;
    // the gradient-orientation histogram (mod 180 degrees, energy-weighted): its peak gives the axes, which the tensor's
    // mean angle does not when two orientations hold (a square grid of joints reads diagonal there)
    const BINS = 90, hist = new Float64Array(BINS);
    const s2 = 2 * P.readSigmaM * P.readSigmaM;
    const ok = (q: number) => source[q] === 1;
    for (const p of use) {
        const i = p % W, k = (p - i) / W;
        if (i < 1 || k < 1 || i >= W - 1 || k >= H - 1) continue;
        if (!ok(p - W - 1) || !ok(p - W) || !ok(p - W + 1) || !ok(p - 1) || !ok(p + 1) || !ok(p + W - 1) || !ok(p + W) || !ok(p + W + 1)) continue;
        const w = Math.exp(-((dist[p] * texelM) ** 2) / s2);
        for (let j = 0; j < 3; j++) {
            const v = (q: number) => rgb[q * 3 + j];
            const gx = (3 * (v(p - W + 1) - v(p - W - 1)) + 10 * (v(p + 1) - v(p - 1)) + 3 * (v(p + W + 1) - v(p + W - 1))) / 32;
            const gz = (3 * (v(p + W - 1) - v(p - W - 1)) + 10 * (v(p + W) - v(p - W)) + 3 * (v(p + W + 1) - v(p - W + 1))) / 32;
            jxx += w * gx * gx; jzz += w * gz * gz; jxz += w * gx * gz;
            const e = gx * gx + gz * gz;
            if (e > 0) hist[Math.floor((((Math.atan2(gz, gx) + Math.PI) % Math.PI) / Math.PI) * BINS) % BINS] += w * e;
        }
    }
    const coherence = jxx + jzz > 0 ? Math.sqrt((jxx - jzz) ** 2 + 4 * jxz * jxz) / (jxx + jzz) : 0;
    let peak = 0, peakV = -1;
    for (let b = 0; b < BINS; b++) { const v = hist[(b + BINS - 1) % BINS] + 2 * hist[b] + hist[(b + 1) % BINS]; if (v > peakV) { peakV = v; peak = b; } }
    // the peak's centre, refined by the parabola through it and its neighbours
    const sm = (b: number) => hist[(b + BINS - 1) % BINS] + 2 * hist[b % BINS] + hist[(b + 1) % BINS];
    const y0 = sm(peak + BINS - 1), y1 = sm(peak), y2 = sm(peak + 1), den = y0 - 2 * y1 + y2;
    const off = Math.abs(den) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const across = coherence >= P.coherenceMin ? 0.5 * Math.atan2(2 * jxz, jxx - jzz) : ((peak + 0.5 + off) / BINS) * Math.PI;
    const dir: [number, number] = [-Math.sin(across), Math.cos(across)];
    const refusals: string[] = [];
    if (coherence < P.coherenceMin) refusals.push(`no measured direction: the clear texels' coherence is ${coherence.toFixed(2)} (< ${P.coherenceMin})`);
    // along the direction a repeat may hold in one strip only (a dashed line beside plain lanes): read strip by strip
    // (stripM wide, half overlapping), the strongest strip that passes kept
    let along: MeasuredPeriod | string = periodAlong(rgb, use, W, dir, texelM, 'along the surface\'s direction');
    if (typeof along === 'string' && coherence >= P.coherenceMin) {
        const px = Math.cos(across), py = Math.sin(across), widthPx = Math.max(4, Math.round(P.stripM / texelM));
        const strips = new Map<number, number[]>();
        for (const p of use) {
            const i = p % W, k = (p - i) / W, c = (i * px + k * py) / (widthPx / 2);
            for (const s of [Math.floor(c), Math.floor(c) - 1]) { let l = strips.get(s); if (!l) strips.set(s, l = []); l.push(p); }
        }
        let bestStrip: MeasuredPeriod | undefined;
        for (const l of strips.values()) {
            // a strip whose profile barely varies holds no repeat: skipped before the lag search
            let s1 = 0, s2 = 0;
            for (const p of l) { const y = luma(rgb, p); s1 += y; s2 += y * y; }
            const sdv = Math.sqrt(Math.max(0, s2 / l.length - (s1 / l.length) ** 2));
            if (l.length < 40 * MIN_BIN_SAMPLES || sdv < P.stripMinSpread) continue;
            const r = periodAlong(rgb, l, W, dir, texelM, 'along a strip of the surface');
            if (typeof r !== 'string' && (!bestStrip || r.ncc > bestStrip.ncc)) bestStrip = r;
        }
        if (bestStrip) along = bestStrip;
    }
    const acrossP = periodAlong(rgb, use, W, [Math.cos(across), Math.sin(across)], texelM, 'across it');
    if (typeof along === 'string') refusals.push(along);
    if (typeof acrossP === 'string') refusals.push(acrossP);
    const angleDeg = ((Math.atan2(dir[1], dir[0]) * 180) / Math.PI + 360) % 180;
    return { dir, coherence, angleDeg, ...(typeof along === 'string' ? {} : { along }), ...(typeof acrossP === 'string' ? {} : { across: acrossP }), refusals, texels: use.length };
}

// ------------------------------------------------------------------------------------------------ the fill

/** Which offsets (texels) a rung may copy from: a sampler of fresh ones, and whether one is admissible. */
export interface OffsetRule {
    name: string;
    sample(r: () => number, t: number): [number, number] | undefined;
    admits(dx: number, dy: number): boolean;
}

/**
 * The neighbourhood match's stencil, as dx, dy pairs: the dense 5 x 5 (so a seam between two copies, even a texel wide,
 * costs) and eight points at 3 texels on the axes and diagonals (the reach of a 7 x 7).
 */
const STENCIL: Int8Array = (() => {
    const out: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) out.push(dx, dy);
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, 3], [3, -3], [-3, -3]]) out.push(dx, dy);
    return Int8Array.from(out);
})();

/** Offsets along `dir` (both ways), at whole multiples of the along period when there is one, plus whole multiples of the across period. */
export function directionalRule(reading: StructureReading, texelM: number, P: InfillSynthesisParams = INFILL_SYNTHESIS_PARAMS): OffsetRule {
    const [ax, ay] = reading.dir, px = -ay, py = ax;
    const maxPx = Math.max(P.minOffsetPx + 1, P.searchM / texelM);
    const al = reading.along, ac = reading.across;
    return {
        name: 'directional',
        sample(r) {
            const s = r() < 0.5 ? -1 : 1;
            let lam = P.minOffsetPx + (maxPx - P.minOffsetPx) * r() * r();
            if (al) lam = Math.max(1, Math.round(lam / al.pitchPx)) * al.pitchPx;
            let dx = s * lam * ax, dy = s * lam * ay;
            if (ac && r() < 0.5) { const m = Math.round((r() - 0.5) * 4); dx += m * ac.pitchPx * px; dy += m * ac.pitchPx * py; }
            return [Math.round(dx), Math.round(dy)];
        },
        admits(dx, dy) {
            // the offset's part across the direction: on the line (within a texel), or on a whole multiple of the across period
            let c = dx * px + dy * py;
            if (ac) c -= Math.round(c / ac.pitchPx) * ac.pitchPx;
            if (Math.abs(c) > 1.5) return false;
            const along = dx * ax + dy * ay;
            if (al) { const f = along / al.pitchPx; return Math.abs(f - Math.round(f)) * al.pitchPx <= Math.max(1.5, 0.03 * Math.abs(along)) && Math.round(f) !== 0; }
            return Math.abs(along) >= P.minOffsetPx - 1;
        }
    };
}

/** Shifts along the measured line (any length; within 2 texels or 6 % of the shift across it): what a surface with a direction repeats at by itself. */
export function onTheLine(reading: StructureReading): (dx: number, dy: number) => boolean {
    const [ax, ay] = reading.dir, px = -ay, py = ax;
    return (dx, dy) => Math.abs(dx * px + dy * py) <= Math.max(2, 0.06 * Math.hypot(dx, dy));
}

/** Whole multiples of the measured periods (one or two axes). */
export function latticeRule(periods: MeasuredPeriod[], P: InfillSynthesisParams = INFILL_SYNTHESIS_PARAMS): OffsetRule {
    return {
        name: 'periodic',
        sample(r) {
            let dx = 0, dy = 0;
            for (let tries = 0; tries < 8 && dx === 0 && dy === 0; tries++) {
                dx = 0; dy = 0;
                for (const p of periods) { const m = Math.round((r() * 2 - 1) * P.latticeReach); dx += m * p.pitchPx * p.axis[0]; dy += m * p.pitchPx * p.axis[1]; }
            }
            return dx === 0 && dy === 0 ? undefined : [Math.round(dx), Math.round(dy)];
        },
        admits(dx, dy) {
            if (dx === 0 && dy === 0) return false;
            if (periods.length === 1) {
                const p = periods[0], along = dx * p.axis[0] + dy * p.axis[1], across = -dx * p.axis[1] + dy * p.axis[0];
                const f = along / p.pitchPx;
                return Math.abs(across) <= 1.5 && Math.abs(f - Math.round(f)) * p.pitchPx <= 1.5;
            }
            // two axes: solve for the lattice coordinates
            const [p, q] = periods, a = [p.axis[0] * p.pitchPx, p.axis[1] * p.pitchPx], b = [q.axis[0] * q.pitchPx, q.axis[1] * q.pitchPx];
            const det = a[0] * b[1] - a[1] * b[0];
            if (Math.abs(det) < 1e-9) return false;
            const m = (dx * b[1] - dy * b[0]) / det, n = (a[0] * dy - a[1] * dx) / det;
            const rx = dx - Math.round(m) * a[0] - Math.round(n) * b[0], ry = dy - Math.round(m) * a[1] - Math.round(n) * b[1];
            return Math.hypot(rx, ry) <= 1.5;
        }
    };
}

/** Any clear texel. */
export function stochasticRule(sources: number[], W: number): OffsetRule {
    return {
        name: 'stochastic',
        sample(r, t) {
            if (!sources.length) return undefined;
            const s = sources[Math.floor(r() * sources.length)];
            const si = s % W, sk = (s - si) / W, ti = t % W, tk = (t - ti) / W;
            return [si - ti, sk - tk];
        },
        admits: () => true
    };
}

export interface SynthesisResult {
    /** Texels of `target` that were filled (the others found no admissible source). */
    filled: Uint8Array;
    count: number;
    /** Per texel, the source texel it copies (-1 none). */
    from: Int32Array;
}

/**
 * Fills `target` texels of `rgb` (sRGB 0..255, written in place) from `source` texels by the offset rule (see the file
 * comment). `context` texels (real or already accepted) inform the neighbourhood match but are never written.
 */
export function synthesize(rgb: Float32Array, W: number, H: number, source: Uint8Array, context: Uint8Array, target: Uint8Array, rule: OffsetRule, P: InfillSynthesisParams = INFILL_SYNTHESIS_PARAMS, extra?: (t: number) => Array<[number, number]>): SynthesisResult {
    const r = rng(P.seed);
    const N = W * H;
    const from = new Int32Array(N).fill(-1);
    const valid = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (context[p] || source[p]) valid[p] = 1;
    const uses = new Uint16Array(N);
    // the order: onion peel from the target's edge inward, shuffled within each layer
    const layers: number[][] = [];
    {
        const d = new Int32Array(N).fill(-1);
        let frontier: number[] = [];
        for (let p = 0; p < N; p++) {
            if (!target[p]) continue;
            const i = p % W;
            const edge = (i > 0 && valid[p - 1]) || (i < W - 1 && valid[p + 1]) || (p >= W && valid[p - W]) || (p < N - W && valid[p + W]);
            if (edge) { d[p] = 0; frontier.push(p); }
        }
        while (frontier.length) {
            layers.push(frontier);
            const next: number[] = [];
            for (const p of frontier) {
                const i = p % W;
                for (const q of [i > 0 ? p - 1 : -1, i < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < N - W ? p + W : -1]) if (q >= 0 && target[q] && d[q] < 0) { d[q] = d[p] + 1; next.push(q); }
            }
            frontier = next;
        }
        // target texels unreachable from any valid texel: one more layer in raster order
        const rest: number[] = [];
        for (let p = 0; p < N; p++) if (target[p] && d[p] < 0) rest.push(p);
        if (rest.length) layers.push(rest);
        for (const l of layers) for (let k = l.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); const t = l[k]; l[k] = l[j]; l[j] = t; }
    }
    const cost = (t: number, s: number, refine: boolean): number => {
        const ti = t % W, tk = (t - ti) / W, si = s % W, sk = (s - si) / W;
        let c = 0, n = 0, miss = 0;
        for (let e = 0; e < STENCIL.length; e += 2) {
            const dx = STENCIL[e], dy = STENCIL[e + 1];
            const ai = ti + dx, ak = tk + dy;
            if (ai < 0 || ak < 0 || ai >= W || ak >= H) continue;
            const a = ak * W + ai;
            if (a === t && !refine) continue;
            if (!valid[a]) continue;
            const bi = si + dx, bk = sk + dy;
            if (bi < 0 || bk < 0 || bi >= W || bk >= H) { miss++; continue; }
            const b = bk * W + bi;
            if (!source[b]) { miss++; continue; }
            const d0 = rgb[a * 3] - rgb[b * 3], d1 = rgb[a * 3 + 1] - rgb[b * 3 + 1], d2 = rgb[a * 3 + 2] - rgb[b * 3 + 2];
            c += d0 * d0 + d1 * d1 + d2 * d2; n++;
        }
        if (n + miss === 0) return 1e12;
        if (n < Math.min(P.minSamples, n + miss)) return 1e11;
        return (c + miss * P.missingCost * 3) / (n + miss) + P.reuseCost * uses[s];
    };
    const candidateOk = (t: number, dx: number, dy: number): number => {
        const ti = t % W, tk = (t - ti) / W, si = ti + dx, sk = tk + dy;
        if (si < 0 || sk < 0 || si >= W || sk >= H) return -1;
        const s = sk * W + si;
        return source[s] ? s : -1;
    };
    const tried = new Int32Array(64);
    const choose = (t: number, refine: boolean, fresh: number): number => {
        const ti = t % W, tk = (t - ti) / W;
        let nTried = 0;
        let best = -1, bestC = Infinity;
        const tryOff = (dx: number, dy: number, fresh = false) => {
            const s = candidateOk(t, dx, dy);
            if (s < 0) return;
            for (let j = 0; j < nTried; j++) if (tried[j] === s) return;
            if (nTried < tried.length) tried[nTried++] = s;
            let c = cost(t, s, refine);
            if (fresh) c = c * P.freshFactor + P.freshCost;
            if (c < bestC) { bestC = c; best = s; }
        };
        // coherence: the offsets of filled neighbours (a copied patch stays whole)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const ni = ti + dx, nk = tk + dy;
            if (ni < 0 || nk < 0 || ni >= W || nk >= H) continue;
            const q = nk * W + ni, f = from[q];
            if (f < 0) continue;
            const fi = f % W, fk = (f - fi) / W;
            tryOff(fi - ni, fk - nk);
        }
        if (refine && from[t] >= 0) { const f = from[t], fi = f % W; tryOff(fi - ti, (f - fi) / W - tk); }
        for (const [dx, dy] of extra?.(t) ?? []) tryOff(dx, dy, true);
        for (let k = 0; k < fresh; k++) { const o = rule.sample(r, t); if (o && rule.admits(o[0], o[1])) tryOff(o[0], o[1], true); }
        return best;
    };
    const put = (t: number, s: number) => {
        if (from[t] >= 0) uses[from[t]] = Math.max(0, uses[from[t]] - 1);
        from[t] = s; uses[s]++;
        rgb[t * 3] = rgb[s * 3]; rgb[t * 3 + 1] = rgb[s * 3 + 1]; rgb[t * 3 + 2] = rgb[s * 3 + 2];
    };
    for (const layer of layers) for (const t of layer) {
        const s = choose(t, false, P.freshFirst);
        if (s >= 0) { put(t, s); valid[t] = 1; }
    }
    // refinement: every filled texel chooses again with its whole neighbourhood in place
    const order: number[] = [];
    for (let p = 0; p < N; p++) if (from[p] >= 0) order.push(p);
    for (let pass = 0; pass < P.refinePasses; pass++) {
        for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); const t = order[k]; order[k] = order[j]; order[j] = t; }
        for (const t of order) { const s = choose(t, true, P.freshRefine); if (s >= 0 && s !== from[t]) put(t, s); }
    }
    const filled = new Uint8Array(N);
    let count = 0;
    for (let p = 0; p < N; p++) if (from[p] >= 0) { filled[p] = 1; count++; }
    return { filled, count, from };
}

/**
 * The join: the mismatch between `fill` texels and the `anchor` texels beside them (each side's own 5 x 5 mean at every rim
 * texel, capped at `rimCap` a channel), carried across the fill by push-pull and added to it in place.
 */
export function correctToRim(rgb: Float32Array, W: number, H: number, fill: Uint8Array, anchor: Uint8Array, P: InfillSynthesisParams = INFILL_SYNTHESIS_PARAMS): { rimTexels: number; meanShift: number } {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let p = 0; p < W * H; p++) if (fill[p]) { const i = p % W, k = (p - i) / W; x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, k); y1 = Math.max(y1, k); }
    if (x1 < 0) return { rimTexels: 0, meanShift: 0 };
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(W - 1, x1 + 1); y1 = Math.min(H - 1, y1 + 1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const vals = new Float32Array(w * h * 3), known = new Float32Array(w * h);
    const mean = (p: number, mask: Uint8Array, out: number[]) => {
        const i = p % W, k = (p - i) / W;
        let n = 0; out[0] = out[1] = out[2] = 0;
        for (let kk = Math.max(0, k - 2); kk <= Math.min(H - 1, k + 2); kk++) for (let ii = Math.max(0, i - 2); ii <= Math.min(W - 1, i + 2); ii++) {
            const q = kk * W + ii;
            if (!mask[q]) continue;
            n++; out[0] += rgb[q * 3]; out[1] += rgb[q * 3 + 1]; out[2] += rgb[q * 3 + 2];
        }
        if (n) { out[0] /= n; out[1] /= n; out[2] /= n; }
        return n;
    };
    const anchorOnly = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) if (anchor[p] && !fill[p]) anchorOnly[p] = 1;
    const ma = [0, 0, 0], mf = [0, 0, 0];
    let rim = 0;
    for (let k = y0; k <= y1; k++) for (let i = x0; i <= x1; i++) {
        const p = k * W + i;
        if (!fill[p]) continue;
        const touches = (i > 0 && anchorOnly[p - 1]) || (i < W - 1 && anchorOnly[p + 1]) || (k > 0 && anchorOnly[p - W]) || (k < H - 1 && anchorOnly[p + W]);
        if (!touches) continue;
        if (mean(p, anchorOnly, ma) < 3 || mean(p, fill, mf) < 3) continue;
        const q = (k - y0) * w + (i - x0);
        for (let j = 0; j < 3; j++) vals[q * 3 + j] = Math.max(-P.rimCap, Math.min(P.rimCap, ma[j] - mf[j]));
        known[q] = 1;
        rim++;
    }
    if (!rim) return { rimTexels: 0, meanShift: 0 };
    const field = pushPull(vals, known, w, h, 3);
    let shift = 0, n = 0;
    for (let k = y0; k <= y1; k++) for (let i = x0; i <= x1; i++) {
        const p = k * W + i;
        if (!fill[p]) continue;
        const q = (k - y0) * w + (i - x0);
        for (let j = 0; j < 3; j++) rgb[p * 3 + j] = Math.max(0, Math.min(255, rgb[p * 3 + j] + field[q * 3 + j]));
        shift += Math.abs(field[q * 3]) + Math.abs(field[q * 3 + 1]) + Math.abs(field[q * 3 + 2]); n++;
    }
    return { rimTexels: rim, meanShift: n ? shift / (3 * n) : 0 };
}
