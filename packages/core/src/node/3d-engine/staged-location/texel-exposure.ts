/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-view exposure compensation for the Street View projection bake (design section 4, step 5 b and c).
 *
 * (b) Relative gains: for every texel two or more views see, each pair of views should agree after gain. One log-gain
 *     per view and channel is solved by weighted least squares over all those pairs; each connected group of views is
 *     anchored to its view of median luminance (gain 0), so the solve moves nothing when the views already agree.
 * (c) Palette gate: the face's measured FacePalette (Lab) is the one photometric measurement shared by all views. For each
 *     view, its gained samples are assigned to their nearest palette colours; the CIEDE2000 between the mean of the samples
 *     and the mean of their assigned palette colours is the view's gate distance (k-means centres are their cluster's mean,
 *     so the palette's own quantisation averages out). Past the gate (default 6) the view's gain is pulled onto the palette
 *     by the log ratio of those two means, reassigning and repeating until it settles.
 *
 * Plate-level CDF matching (StationRadianceEqualizer) needs whole station plates and their depth warps; the bake holds
 * sparse per-texel samples instead, so the gains here are solved on those samples directly.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { ProColorGradeMatchingService as Colour } from '../../image/ProColorGradeMatchingService';
import { SRGB8_TO_LINEAR as SRGB_TO_LINEAR, linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';

// =============================================================================
// Colour helpers (linear RGB 0..1 <-> sRGB 0..255 <-> Lab)
// =============================================================================

/** sRGB byte -> linear 0..1, and back: the shared helpers of the de-light module. */
export { SRGB_TO_LINEAR, linearToSrgb255 };

/** Linear RGB 0..1 -> CIE Lab (D65). */
export function linearToLab(r: number, g: number, b: number): Vec3 {
    const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
    return Colour.xyzToLab(x, y, z);
}

/** CIE Lab -> linear RGB 0..1 (through 8-bit sRGB, the palette's own precision). */
export function labToLinear(lab: Vec3): Vec3 {
    const s = Colour.labToSrgb(lab[0], lab[1], lab[2]);
    return [SRGB_TO_LINEAR[s[0]], SRGB_TO_LINEAR[s[1]], SRGB_TO_LINEAR[s[2]]];
}

export const deltaE00 = (a: Vec3, b: Vec3): number => Colour.calculateDeltaE00(a, b);

export const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// =============================================================================
// Samples
// =============================================================================

/** One view's samples: texel indices, linear RGB (3 per sample) and the per-texel normalised blend weight. */
export interface ViewSamples {
    texel: Int32Array;
    rgb: Float32Array;
}

/** Per-texel lists of (view, sample) in CSR form. */
export interface TexelSampleIndex {
    start: Int32Array;
    view: Int32Array;
    sample: Int32Array;
    /** Per-entry weight, normalised to sum 1 per texel. */
    weight: Float64Array;
}

const LOG_FLOOR = 1e-4;
/** A pair whose log ratio is past this is an occlusion or registration miss, not exposure: clipped. */
const MAX_PAIR_LOG_RATIO = Math.log(4);

function solveDense(A: Float64Array, b: Float64Array, n: number): Float64Array {
    const M = new Float64Array(n * (n + 1));
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j]; M[i * (n + 1) + n] = b[i]; }
    const w = n + 1;
    for (let i = 0; i < n; i++) {
        let p = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(M[r * w + i]) > Math.abs(M[p * w + i])) p = r;
        if (p !== i) for (let c = 0; c < w; c++) { const t = M[i * w + c]; M[i * w + c] = M[p * w + c]; M[p * w + c] = t; }
        const piv = M[i * w + i] || 1e-12;
        for (let r = i + 1; r < n; r++) {
            const f = M[r * w + i] / piv;
            if (f !== 0) for (let c = i; c < w; c++) M[r * w + c] -= f * M[i * w + c];
        }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = M[i * w + n];
        for (let c = i + 1; c < n; c++) s -= M[i * w + c] * x[c];
        x[i] = s / (M[i * w + i] || 1e-12);
    }
    return x;
}

export interface RelativeGainResult {
    /** log-gain per view, 3 per view (r, g, b). */
    logGain: Float64Array;
    /** Index of the anchor view of each view's connected group (itself when isolated). */
    anchorOf: Int32Array;
    /** Overlap pairs used. */
    pairs: number;
}

/**
 * (b) Relative log-gains by weighted least squares over the overlap pairs. Views with no overlap keep gain 0.
 */
export function solveRelativeGains(views: ViewSamples[], index: TexelSampleIndex, texelCount: number): RelativeGainResult {
    const K = views.length;
    const parent = Int32Array.from({ length: K }, (_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const A = [new Float64Array(K * K), new Float64Array(K * K), new Float64Array(K * K)];
    const b = [new Float64Array(K), new Float64Array(K), new Float64Array(K)];
    let pairs = 0;
    for (let t = 0; t < texelCount; t++) {
        const s0 = index.start[t], s1 = index.start[t + 1];
        if (s1 - s0 < 2) continue;
        for (let i = s0; i < s1; i++) {
            for (let j = i + 1; j < s1; j++) {
                const va = index.view[i], vb = index.view[j];
                const w = Math.sqrt(index.weight[i] * index.weight[j]);
                if (!(w > 0)) continue;
                pairs++;
                const ra = find(va), rb = find(vb);
                if (ra !== rb) parent[ra] = rb;
                const sa = index.sample[i] * 3, sb = index.sample[j] * 3;
                for (let c = 0; c < 3; c++) {
                    let r = Math.log(Math.max(LOG_FLOOR, views[va].rgb[sa + c])) - Math.log(Math.max(LOG_FLOOR, views[vb].rgb[sb + c]));
                    r = Math.max(-MAX_PAIR_LOG_RATIO, Math.min(MAX_PAIR_LOG_RATIO, r));
                    // want (l_a + g_a) - (l_b + g_b) = 0  ->  g_a - g_b = -r
                    A[c][va * K + va] += w; A[c][vb * K + vb] += w; A[c][va * K + vb] -= w; A[c][vb * K + va] -= w;
                    b[c][va] -= w * r; b[c][vb] += w * r;
                }
            }
        }
    }
    // anchor: per connected group, the view whose mean luminance is the median of the group
    const meanLum = views.map((v) => {
        let s = 0;
        const n = v.texel.length;
        for (let i = 0; i < n; i++) s += luminance(v.rgb[i * 3], v.rgb[i * 3 + 1], v.rgb[i * 3 + 2]);
        return n ? s / n : 0;
    });
    const groups = new Map<number, number[]>();
    for (let k = 0; k < K; k++) { const r = find(k); const g = groups.get(r) ?? []; g.push(k); groups.set(r, g); }
    const anchorOf = new Int32Array(K);
    let scale = 1;
    for (let k = 0; k < K; k++) scale = Math.max(scale, A[0][k * K + k], A[1][k * K + k], A[2][k * K + k]);
    for (const members of groups.values()) {
        const sorted = [...members].sort((x, y) => meanLum[x] - meanLum[y] || x - y);
        const anchor = sorted[(sorted.length - 1) >> 1];
        for (const m of members) anchorOf[m] = anchor;
        for (let c = 0; c < 3; c++) A[c][anchor * K + anchor] += scale * 1e6;
    }
    const logGain = new Float64Array(K * 3);
    for (let c = 0; c < 3; c++) {
        for (let k = 0; k < K; k++) A[c][k * K + k] += 1e-9 * scale;
        const g = solveDense(A[c], b[c], K);
        for (let k = 0; k < K; k++) logGain[k * 3 + c] = g[k];
    }
    return { logGain, anchorOf, pairs };
}

export interface PaletteGateReport {
    /** CIEDE2000 between the view's mean sample and the mean of its assigned palette colours, before the gate acted. */
    deltaEBefore: number;
    /** The same after any pull (equal to deltaEBefore when the gate did not trigger). */
    deltaEAfter: number;
    triggered: boolean;
    /** log-gain added per channel by the gate. */
    pull: Vec3;
}

/**
 * (c) Palette gate for one view. `gain` is the view's current linear gain per channel (applied to `rgb` before measuring).
 * Returns the gate report; `pull` is to be added to the view's log-gain.
 */
export function paletteGate(
    rgb: Float32Array, gain: Vec3, palette: Array<{ lab: Vec3; share: number }>, gateDeltaE = 6, maxSamples = 4000
): PaletteGateReport {
    const n = rgb.length / 3;
    const none: PaletteGateReport = { deltaEBefore: 0, deltaEAfter: 0, triggered: false, pull: [0, 0, 0] };
    if (!n || !palette.length) return none;
    const palLin = palette.map((p) => labToLinear(p.lab));
    const stride = Math.max(1, Math.floor(n / maxSamples));
    const pull: Vec3 = [0, 0, 0];
    const measure = (): { dE: number; ratio: Vec3 } => {
        const g: Vec3 = [gain[0] * Math.exp(pull[0]), gain[1] * Math.exp(pull[1]), gain[2] * Math.exp(pull[2])];
        const ms: Vec3 = [0, 0, 0], mp: Vec3 = [0, 0, 0];
        let m = 0;
        for (let i = 0; i < n; i += stride) {
            const r = rgb[i * 3] * g[0], gg = rgb[i * 3 + 1] * g[1], bb = rgb[i * 3 + 2] * g[2];
            const lab = linearToLab(r, gg, bb);
            let best = 0, bd = Infinity;
            for (let p = 0; p < palette.length; p++) {
                const q = palette[p].lab;
                const d = (lab[0] - q[0]) ** 2 + (lab[1] - q[1]) ** 2 + (lab[2] - q[2]) ** 2;
                if (d < bd) { bd = d; best = p; }
            }
            ms[0] += r; ms[1] += gg; ms[2] += bb;
            mp[0] += palLin[best][0]; mp[1] += palLin[best][1]; mp[2] += palLin[best][2];
            m++;
        }
        for (let c = 0; c < 3; c++) { ms[c] /= m; mp[c] /= m; }
        return {
            dE: deltaE00(linearToLab(ms[0], ms[1], ms[2]), linearToLab(mp[0], mp[1], mp[2])),
            ratio: [Math.log(Math.max(LOG_FLOOR, mp[0]) / Math.max(LOG_FLOOR, ms[0])), Math.log(Math.max(LOG_FLOOR, mp[1]) / Math.max(LOG_FLOOR, ms[1])), Math.log(Math.max(LOG_FLOOR, mp[2]) / Math.max(LOG_FLOOR, ms[2]))]
        };
    };
    let cur = measure();
    const deltaEBefore = cur.dE;
    if (deltaEBefore <= gateDeltaE) return { ...none, deltaEBefore, deltaEAfter: deltaEBefore };
    for (let it = 0; it < 8; it++) {
        for (let c = 0; c < 3; c++) pull[c] += cur.ratio[c];
        const next = measure();
        const step = Math.max(Math.abs(next.ratio[0]), Math.abs(next.ratio[1]), Math.abs(next.ratio[2]));
        cur = next;
        if (step < 1e-3) break;
    }
    return { deltaEBefore, deltaEAfter: cur.dE, triggered: true, pull };
}
