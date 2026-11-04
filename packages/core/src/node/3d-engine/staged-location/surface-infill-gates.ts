/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The seam gate of the surface infill (surface-infill.ts): every fill is measured against the real texels around it
 * before it is written, and a fill that fails falls to the next rung with its reason.
 *
 * - **Rim:** CIEDE2000 between the fill and the real texels beside it, each side's own texels only (a 5 x 5 window on
 *   either side of every rim pair), median and 90th percentile. The bar is the surface's own: the same statistic read
 *   across a virtual seam inside the real texels (a few texels out from the fill), so a grainy or striped surface is not
 *   held to a smooth one's join.
 * - **Gradient and structure continuity:** mean gradient energy of the fill against the ring's (the band of real texels
 *   around it); where the ring shows an orientation (coherent structure tensor), the fill must run the same way with
 *   comparable coherence.
 * - **No smear:** a sharpness floor (high-frequency energy, the texel's difference from its 3 x 3 mean, against the
 *   ring's) and no one-way stretch (the fill's structure-tensor anisotropy no more than a few times the ring's).
 * - **No visible repeat:** the fill's high-pass autocorrelation (masked, through an FFT) away from zero shift and away
 *   from the shifts the real texture itself repeats at (its measured line or lattice), against the ring's own peak.
 *
 * Measures only: no surface is named, every bar is a continuous quantity.
 */

import { ProColorGradeMatchingService as Colour } from '../../image/ProColorGradeMatchingService';

export const SEAM_GATE = {
    /** Rim window half-size (texels): 5 x 5. */
    rimHalf: 2,
    /** The virtual seam the surface's own bar is read across: this many texels out from the fill. */
    naturalAtPx: 5,
    /** Rim CIEDE2000 bars: median at most max(abs, natural median * scale + add); p90 likewise. */
    rimMedianAbs: 3.5, rimMedianScale: 1.5, rimMedianAdd: 1.0,
    rimP90Abs: 8, rimP90Scale: 1.5, rimP90Add: 2.0,
    /** At most this many rim pairs are read (evenly strided). */
    maxRimPairs: 6000,
    /** The ring band the fill's texture is compared with (m); with a measured direction, strip by strip this wide (m) across it. */
    bandM: 1.5, stripM: 0.15,
    /** Gradient energy: fill / ring within [lo, hi]. */
    gradientLo: 0.55, gradientHi: 1.8,
    /** Sharpness floor: high-frequency energy fill / ring at least this (and at most hfHi). */
    hfLo: 0.5, hfHi: 2.2,
    /** Orientation: read when the ring's coherence is at least this; the fill within maxAngleDeg and at least coherenceShare of the ring's coherence. */
    ringCoherenceMin: 0.3, maxAngleDeg: 20, coherenceShare: 0.5,
    /** One-way stretch: the fill's anisotropy at most this many times the ring's. */
    stretchMax: 3,
    /** Repeat: the fill's autocorrelation peak at most max(abs, ring peak + add), read past this shift (m, and at least minShiftPx). */
    repeatAbs: 0.5, repeatAdd: 0.2, repeatMinShiftM: 0.25, repeatMinShiftPx: 4,
    /** The repeat test needs this many fill texels and this span (texels) each way. */
    repeatMinTexels: 600, repeatMinSpanPx: 24,
    /** The texture tests need this many fill texels with a full 3 x 3 inside the fill. */
    textureMinTexels: 48,
    /** The rim test needs this many pairs. */
    rimMinPairs: 8
};
export type SeamGateParams = typeof SEAM_GATE;

export interface SeamGateMetrics {
    rim: { median: number; p90: number; pairs: number } | null;
    natural: { median: number; p90: number; pairs: number } | null;
    gradientRatio: number | null;
    hfRatio: number | null;
    orientation: { ringDeg: number; fillDeg: number; ringCoherence: number; fillCoherence: number; diffDeg: number } | null;
    stretch: number | null;
    repeat: { fillPeak: number; ringPeak: number | null; shiftPx: [number, number] } | null;
}

export interface SeamGateResult {
    pass: boolean;
    /** One line per failed bar, with the numbers. */
    failures: string[];
    metrics: SeamGateMetrics;
    /** Sum of the failed bars' relative excess (0 when it passes): to keep the least bad of several failed attempts. */
    excess: number;
}

export interface SeamGateInput {
    width: number; height: number; texelM: number;
    /** sRGB 0..255, 3 per texel: the raster with the attempt written into it. */
    rgb: Float32Array;
    /** 1: this attempt's texels. */
    fill: Uint8Array;
    /** 1: the real (or already accepted) texels the fill must meet. */
    ref: Uint8Array;
    /** Shifts (texels) the real texture itself repeats at (its measured line, its measured lattice): not counted as a repeat. */
    admitted?: (dx: number, dy: number) => boolean;
    /**
     * The surface's measured direction (unit, texel space), when it has one: the texture is then compared strip by strip
     * across it (each strip of the fill against the same strip's real texels along the line), so a fill holding more of a
     * line than the ring does is not read as busier than the surface.
     */
    along?: [number, number];
}

const luma = (rgb: Float32Array, p: number) => 0.299 * rgb[p * 3] + 0.587 * rgb[p * 3 + 1] + 0.114 * rgb[p * 3 + 2];
const lab = (r: number, g: number, b: number) => Colour.srgbToLab(Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));
const quantile = (a: number[], q: number) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** 4-neighbour steps from the nearest texel of `seed`, up to `maxD` (beyond: maxD + 1). */
export function distanceFrom(seed: Uint8Array, W: number, H: number, maxD: number): Uint16Array {
    const d = new Uint16Array(W * H).fill(maxD + 1);
    let frontier: number[] = [];
    for (let p = 0; p < W * H; p++) if (seed[p]) { d[p] = 0; frontier.push(p); }
    for (let s = 1; s <= maxD && frontier.length; s++) {
        const next: number[] = [];
        for (const p of frontier) {
            const i = p % W;
            if (i > 0 && d[p - 1] > s) { d[p - 1] = s; next.push(p - 1); }
            if (i < W - 1 && d[p + 1] > s) { d[p + 1] = s; next.push(p + 1); }
            if (p >= W && d[p - W] > s) { d[p - W] = s; next.push(p - W); }
            if (p < W * (H - 1) && d[p + W] > s) { d[p + W] = s; next.push(p + W); }
        }
        frontier = next;
    }
    return d;
}

/** Mean sRGB over the texels of `mask` within `half` of p. */
function maskedMean(rgb: Float32Array, mask: (q: number) => boolean, W: number, H: number, p: number, half: number, out: number[]): number {
    const i = p % W, k = (p - i) / W;
    let n = 0; out[0] = out[1] = out[2] = 0;
    for (let kk = Math.max(0, k - half); kk <= Math.min(H - 1, k + half); kk++) for (let ii = Math.max(0, i - half); ii <= Math.min(W - 1, i + half); ii++) {
        const q = kk * W + ii;
        if (!mask(q)) continue;
        n++; out[0] += rgb[q * 3]; out[1] += rgb[q * 3 + 1]; out[2] += rgb[q * 3 + 2];
    }
    if (n) { out[0] /= n; out[1] /= n; out[2] /= n; }
    return n;
}

/** CIEDE2000 across every pair (p in sideA, q its 4-neighbour in sideB), each side's own texels averaged. */
function seamDeltaE(rgb: Float32Array, W: number, H: number, sideA: (p: number) => boolean, sideB: (p: number) => boolean, starts: number[], half: number, maxPairs: number): number[] {
    const out: number[] = [];
    const stride = Math.max(1, Math.ceil(starts.length / maxPairs));
    const ma = [0, 0, 0], mb = [0, 0, 0];
    for (let s = 0; s < starts.length; s += stride) {
        const p = starts[s], i = p % W;
        let q = -1;
        if (i > 0 && sideB(p - 1)) q = p - 1; else if (i < W - 1 && sideB(p + 1)) q = p + 1; else if (p >= W && sideB(p - W)) q = p - W; else if (p < W * (H - 1) && sideB(p + W)) q = p + W;
        if (q < 0) continue;
        if (maskedMean(rgb, sideA, W, H, p, half, ma) < 3 || maskedMean(rgb, sideB, W, H, q, half, mb) < 3) continue;
        out.push(Colour.calculateDeltaE00(lab(ma[0], ma[1], ma[2]), lab(mb[0], mb[1], mb[2])));
    }
    return out;
}

interface TextureStats { gradient: number; hf: number; jxx: number; jyy: number; jxy: number; n: number }

/** Per-texel gradient magnitude and high-frequency energy of `set` texels whose 3 x 3 lies in it (NaN elsewhere). */
function texelEnergies(L: Float32Array, W: number, H: number, set: (p: number) => boolean, g: Float32Array, hf: Float32Array): void {
    for (let k = 1; k < H - 1; k++) for (let i = 1; i < W - 1; i++) {
        const p = k * W + i;
        if (!set(p) || !set(p - 1) || !set(p + 1) || !set(p - W) || !set(p + W) || !set(p - W - 1) || !set(p - W + 1) || !set(p + W - 1) || !set(p + W + 1)) continue;
        const gx = (3 * (L[p - W + 1] - L[p - W - 1]) + 10 * (L[p + 1] - L[p - 1]) + 3 * (L[p + W + 1] - L[p + W - 1])) / 32;
        const gy = (3 * (L[p + W - 1] - L[p - W - 1]) + 10 * (L[p + W] - L[p - W]) + 3 * (L[p + W + 1] - L[p - W + 1])) / 32;
        const mean = (L[p - W - 1] + L[p - W] + L[p - W + 1] + L[p - 1] + L[p] + L[p + 1] + L[p + W - 1] + L[p + W] + L[p + W + 1]) / 9;
        g[p] = Math.hypot(gx, gy); hf[p] = Math.abs(L[p] - mean);
    }
}

/**
 * The fill's gradient and high-frequency energy over the ring's, strip by strip across `along` (stripPx wide): each strip's
 * fill mean against the same strip's ring mean, weighted by the fill's texels in it; strips the ring does not reach left out.
 */
function stratifiedRatios(L: Float32Array, W: number, H: number, fill: (p: number) => boolean, ring: (p: number) => boolean, along: [number, number], stripPx: number): { gradient: number; hf: number; fillTexels: number } | null {
    const gF = new Float32Array(W * H).fill(NaN), hF = new Float32Array(W * H).fill(NaN), gR = new Float32Array(W * H).fill(NaN), hR = new Float32Array(W * H).fill(NaN);
    texelEnergies(L, W, H, fill, gF, hF); texelEnergies(L, W, H, ring, gR, hR);
    const px = -along[1], py = along[0];
    const strips = new Map<number, number[]>();
    const at = (p: number) => { const i = p % W, k = (p - i) / W; return Math.floor((i * px + k * py) / stripPx); };
    for (let p = 0; p < W * H; p++) {
        const f = gF[p] === gF[p], r = gR[p] === gR[p];
        if (!f && !r) continue;
        const s = at(p);
        let a = strips.get(s);
        if (!a) strips.set(s, a = [0, 0, 0, 0, 0, 0]);
        if (f) { a[0] += gF[p]; a[1] += hF[p]; a[2]++; } else { a[3] += gR[p]; a[4] += hR[p]; a[5]++; }
    }
    let fg = 0, fh = 0, rg = 0, rh = 0, n = 0;
    for (const a of strips.values()) {
        if (a[2] < 4 || a[5] < 10) continue;
        fg += a[0]; fh += a[1];
        rg += a[2] * (a[3] / a[5]); rh += a[2] * (a[4] / a[5]);
        n += a[2];
    }
    if (n < 16 || rg <= 0) return null;
    return { gradient: fg / rg, hf: rh > 0 ? fh / rh : NaN, fillTexels: n };
}

/** Scharr gradient energy, high-frequency energy and the structure tensor over the texels of `set` whose 3 x 3 lies in it. */
function textureStats(L: Float32Array, W: number, H: number, set: (p: number) => boolean): TextureStats {
    let g = 0, hf = 0, jxx = 0, jyy = 0, jxy = 0, n = 0;
    for (let k = 1; k < H - 1; k++) for (let i = 1; i < W - 1; i++) {
        const p = k * W + i;
        if (!set(p) || !set(p - 1) || !set(p + 1) || !set(p - W) || !set(p + W) || !set(p - W - 1) || !set(p - W + 1) || !set(p + W - 1) || !set(p + W + 1)) continue;
        const gx = (3 * (L[p - W + 1] - L[p - W - 1]) + 10 * (L[p + 1] - L[p - 1]) + 3 * (L[p + W + 1] - L[p + W - 1])) / 32;
        const gy = (3 * (L[p + W - 1] - L[p - W - 1]) + 10 * (L[p + W] - L[p - W]) + 3 * (L[p + W + 1] - L[p - W + 1])) / 32;
        const mean = (L[p - W - 1] + L[p - W] + L[p - W + 1] + L[p - 1] + L[p] + L[p + 1] + L[p + W - 1] + L[p + W] + L[p + W + 1]) / 9;
        g += Math.hypot(gx, gy); hf += Math.abs(L[p] - mean);
        jxx += gx * gx; jyy += gy * gy; jxy += gx * gy; n++;
    }
    return { gradient: n ? g / n : 0, hf: n ? hf / n : 0, jxx, jyy, jxy, n };
}

function tensorReading(s: TextureStats): { deg: number; coherence: number; aniso: number } {
    const tr = s.jxx + s.jyy;
    const root = Math.sqrt((s.jxx - s.jyy) ** 2 + 4 * s.jxy * s.jxy);
    const l1 = (tr + root) / 2, l2 = Math.max(0, (tr - root) / 2);
    // the direction the texture runs along: across its strongest gradient
    const across = 0.5 * Math.atan2(2 * s.jxy, s.jxx - s.jyy);
    const deg = ((across * 180) / Math.PI + 90 + 180) % 180;
    return { deg, coherence: tr > 0 ? root / tr : 0, aniso: (l1 + 1e-6 * (tr + 1)) / (l2 + 1e-6 * (tr + 1)) };
}

// ------------------------------------------------------------------------------------------------ autocorrelation

function fft1(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (2 * Math.PI) / len * (inverse ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len / 2; j++) {
                const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** 2D FFT in place (N x N, N a power of two). */
function fft2(re: Float64Array, im: Float64Array, N: number, inverse: boolean): void {
    const r = new Float64Array(N), i = new Float64Array(N);
    for (let y = 0; y < N; y++) { for (let x = 0; x < N; x++) { r[x] = re[y * N + x]; i[x] = im[y * N + x]; } fft1(r, i, inverse); for (let x = 0; x < N; x++) { re[y * N + x] = r[x]; im[y * N + x] = i[x]; } }
    for (let x = 0; x < N; x++) { for (let y = 0; y < N; y++) { r[y] = re[y * N + x]; i[y] = im[y * N + x]; } fft1(r, i, inverse); for (let y = 0; y < N; y++) { re[y * N + x] = r[y]; im[y * N + x] = i[y]; } }
}

/**
 * The masked, normalised autocorrelation of a high-pass field over `mask` (texels), its highest value at a shift of at
 * least `minShift` texels (and with at least a quarter of the mask overlapping) that `admitted` does not take. The field is
 * box-averaged down so its longer side fits 128 before the FFT.
 */
export function autocorrelationPeak(hp: Float32Array, mask: Uint8Array, W: number, H: number, minShift: number, admitted?: (dx: number, dy: number) => boolean): { peak: number; shift: [number, number] } | null {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let p = 0; p < W * H; p++) if (mask[p]) { const i = p % W, k = (p - i) / W; x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, k); y1 = Math.max(y1, k); }
    if (x1 < 0) return null;
    const f = Math.max(1, Math.ceil(Math.max(x1 - x0 + 1, y1 - y0 + 1) / 128));
    const w = Math.ceil((x1 - x0 + 1) / f), h = Math.ceil((y1 - y0 + 1) / f);
    let N = 1;
    while (N < 2 * Math.max(w, h)) N <<= 1;
    const fr = new Float64Array(N * N), fi = new Float64Array(N * N), mr = new Float64Array(N * N), mi = new Float64Array(N * N);
    const cnt = new Float64Array(w * h);
    for (let k = y0; k <= y1; k++) for (let i = x0; i <= x1; i++) {
        const p = k * W + i;
        if (!mask[p]) continue;
        const q = Math.floor((k - y0) / f) * w + Math.floor((i - x0) / f);
        fr[Math.floor((k - y0) / f) * N + Math.floor((i - x0) / f)] += hp[p];
        cnt[q]++;
    }
    let mean = 0, nCells = 0;
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) { const c = cnt[k * w + i]; if (c >= (f * f) / 2) { fr[k * N + i] /= c; mr[k * N + i] = 1; mean += fr[k * N + i]; nCells++; } else fr[k * N + i] = 0; }
    if (nCells < 16) return null;
    mean /= nCells;
    let v = 0;
    for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) if (mr[k * N + i]) { fr[k * N + i] -= mean; v += fr[k * N + i] ** 2; }
    v /= nCells;
    if (!(v > 1e-9)) return null;
    fft2(fr, fi, N, false); fft2(mr, mi, N, false);
    for (let q = 0; q < N * N; q++) { fr[q] = fr[q] * fr[q] + fi[q] * fi[q]; fi[q] = 0; mr[q] = mr[q] * mr[q] + mi[q] * mi[q]; mi[q] = 0; }
    fft2(fr, fi, N, true); fft2(mr, mi, N, true);
    let peak = -Infinity, shift: [number, number] = [0, 0];
    const minOverlap = Math.max(16, nCells / 4);
    for (let dy = -(h - 1); dy <= h - 1; dy++) for (let dx = -(w - 1); dx <= w - 1; dx++) {
        if (dx < 0 || (dx === 0 && dy <= 0)) continue; // symmetric: half the plane
        const sx = dx * f, sy = dy * f;
        if (Math.hypot(sx, sy) < minShift) continue;
        if (admitted && (admitted(sx, sy) || admitted(-sx, -sy))) continue;
        const q = ((dy + N) % N) * N + ((dx + N) % N);
        const overlap = mr[q];
        if (overlap < minOverlap) continue;
        const r = fr[q] / (overlap * v);
        if (r > peak) { peak = r; shift = [sx, sy]; }
    }
    return peak === -Infinity ? null : { peak, shift };
}

/** The seam gate (see the file comment). */
export function seamGate(input: SeamGateInput, P: SeamGateParams = SEAM_GATE): SeamGateResult {
    const { width: W, height: H, rgb, fill, ref } = input;
    const bandPx = Math.max(3, Math.round(P.bandM / input.texelM));
    const dFill = distanceFrom(fill, W, H, Math.max(bandPx, P.naturalAtPx + P.rimHalf + 2));
    const failures: string[] = [];
    let excess = 0;
    const fail = (msg: string, rel: number) => { failures.push(msg); excess += Math.max(0.05, rel); };
    // ---- rim
    const rimStarts: number[] = [];
    let fillCount = 0;
    for (let p = 0; p < W * H; p++) {
        if (!fill[p]) continue;
        fillCount++;
        const i = p % W;
        if ((i > 0 && ref[p - 1]) || (i < W - 1 && ref[p + 1]) || (p >= W && ref[p - W]) || (p < W * (H - 1) && ref[p + W])) rimStarts.push(p);
    }
    const rimDe = seamDeltaE(rgb, W, H, q => fill[q] === 1, q => ref[q] === 1 && !fill[q], rimStarts, P.rimHalf, P.maxRimPairs);
    const D = P.naturalAtPx;
    const natStarts: number[] = [];
    for (let p = 0; p < W * H; p++) if (ref[p] && !fill[p] && dFill[p] === D) natStarts.push(p);
    const natDe = seamDeltaE(rgb, W, H, q => ref[q] === 1 && !fill[q] && dFill[q] <= D, q => ref[q] === 1 && !fill[q] && dFill[q] > D, natStarts, P.rimHalf, P.maxRimPairs);
    const rim = rimDe.length >= P.rimMinPairs ? { median: quantile(rimDe, 0.5), p90: quantile(rimDe, 0.9), pairs: rimDe.length } : null;
    const natural = natDe.length >= P.rimMinPairs ? { median: quantile(natDe, 0.5), p90: quantile(natDe, 0.9), pairs: natDe.length } : null;
    if (rim) {
        const medBar = Math.max(P.rimMedianAbs, natural ? natural.median * P.rimMedianScale + P.rimMedianAdd : P.rimMedianAbs);
        const p90Bar = Math.max(P.rimP90Abs, natural ? natural.p90 * P.rimP90Scale + P.rimP90Add : P.rimP90Abs);
        if (rim.median > medBar) fail(`the join shows: rim CIEDE2000 median ${rim.median.toFixed(1)} > ${medBar.toFixed(1)} (the surface's own across a virtual seam: ${natural ? natural.median.toFixed(1) : 'n/a'})`, rim.median / medBar - 1);
        if (rim.p90 > p90Bar) fail(`the join shows in places: rim CIEDE2000 p90 ${rim.p90.toFixed(1)} > ${p90Bar.toFixed(1)}`, rim.p90 / p90Bar - 1);
    }
    // ---- texture: the fill against the ring band
    const L = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) L[p] = luma(rgb, p);
    const inBand = (q: number) => ref[q] === 1 && !fill[q] && dFill[q] <= bandPx;
    const fs = textureStats(L, W, H, q => fill[q] === 1);
    const rs = textureStats(L, W, H, inBand);
    let gradientRatio: number | null = null, hfRatio: number | null = null, orientation: SeamGateMetrics['orientation'] = null, stretch: number | null = null;
    if (fs.n >= P.textureMinTexels && rs.n >= P.textureMinTexels && rs.gradient > 0.5) {
        gradientRatio = fs.gradient / rs.gradient;
        hfRatio = rs.hf > 0.05 ? fs.hf / rs.hf : null;
        // a surface with a direction: strip by strip across it (the fill against its own strips along the line)
        const st = input.along ? stratifiedRatios(L, W, H, q => fill[q] === 1, inBand, input.along, Math.max(3, Math.round(P.stripM / input.texelM))) : null;
        if (st) { gradientRatio = st.gradient; hfRatio = st.hf === st.hf ? st.hf : hfRatio; }
        if (gradientRatio < P.gradientLo) fail(`the fill is flatter than the surface: gradient energy ${gradientRatio.toFixed(2)} of the ring's (< ${P.gradientLo})`, P.gradientLo / Math.max(gradientRatio, 1e-3) - 1);
        if (gradientRatio > P.gradientHi) fail(`the fill is busier than the surface: gradient energy ${gradientRatio.toFixed(2)} of the ring's (> ${P.gradientHi})`, gradientRatio / P.gradientHi - 1);
        if (hfRatio !== null && hfRatio < P.hfLo) fail(`smeared: fine detail ${hfRatio.toFixed(2)} of the ring's (sharpness floor ${P.hfLo})`, P.hfLo / Math.max(hfRatio, 1e-3) - 1);
        if (hfRatio !== null && hfRatio > P.hfHi) fail(`noisier than the surface: fine detail ${hfRatio.toFixed(2)} of the ring's (> ${P.hfHi})`, hfRatio / P.hfHi - 1);
        const ft = tensorReading(fs), rt = tensorReading(rs);
        stretch = ft.aniso / rt.aniso;
        if (rt.coherence >= P.ringCoherenceMin) {
            const diff = Math.min(Math.abs(ft.deg - rt.deg), 180 - Math.abs(ft.deg - rt.deg));
            orientation = { ringDeg: rt.deg, fillDeg: ft.deg, ringCoherence: rt.coherence, fillCoherence: ft.coherence, diffDeg: diff };
            if (diff > P.maxAngleDeg) fail(`the structure turns: the fill runs ${diff.toFixed(0)}° off the surface's measured orientation (> ${P.maxAngleDeg}°)`, diff / P.maxAngleDeg - 1);
            if (ft.coherence < P.coherenceShare * rt.coherence) fail(`the structure fades: fill coherence ${ft.coherence.toFixed(2)} against the ring's ${rt.coherence.toFixed(2)}`, (P.coherenceShare * rt.coherence) / Math.max(ft.coherence, 1e-3) - 1);
        } else if (stretch > P.stretchMax) fail(`stretched one way: anisotropy ${stretch.toFixed(1)} times the ring's (> ${P.stretchMax})`, stretch / P.stretchMax - 1);
    }
    // ---- repeat
    let repeat: SeamGateMetrics['repeat'] = null;
    let span = { x0: W, x1: -1, y0: H, y1: -1 };
    for (let p = 0; p < W * H; p++) if (fill[p]) { const i = p % W, k = (p - i) / W; span = { x0: Math.min(span.x0, i), x1: Math.max(span.x1, i), y0: Math.min(span.y0, k), y1: Math.max(span.y1, k) }; }
    if (fillCount >= P.repeatMinTexels && span.x1 - span.x0 + 1 >= P.repeatMinSpanPx && span.y1 - span.y0 + 1 >= P.repeatMinSpanPx) {
        const hp = new Float32Array(W * H);
        const box = (mask: (q: number) => boolean, p: number) => { const i = p % W, k = (p - i) / W; let s = 0, n = 0; for (let kk = Math.max(0, k - 2); kk <= Math.min(H - 1, k + 2); kk++) for (let ii = Math.max(0, i - 2); ii <= Math.min(W - 1, i + 2); ii++) { const q = kk * W + ii; if (mask(q)) { s += L[q]; n++; } } return n ? s / n : L[p]; };
        const fillMask = new Uint8Array(W * H), bandMask = new Uint8Array(W * H);
        for (let p = 0; p < W * H; p++) { if (fill[p]) { fillMask[p] = 1; hp[p] = L[p] - box(q => fill[q] === 1, p); } else if (inBand(p)) { bandMask[p] = 1; hp[p] = L[p] - box(inBand, p); } }
        const minShift = Math.max(P.repeatMinShiftPx, P.repeatMinShiftM / input.texelM);
        const fa = autocorrelationPeak(hp, fillMask, W, H, minShift, input.admitted);
        const ra = autocorrelationPeak(hp, bandMask, W, H, minShift, input.admitted);
        if (fa) {
            repeat = { fillPeak: fa.peak, ringPeak: ra ? ra.peak : null, shiftPx: fa.shift };
            const bar = Math.max(P.repeatAbs, (ra?.peak ?? 0) + P.repeatAdd);
            if (fa.peak > bar) fail(`a visible repeat: the fill correlates ${fa.peak.toFixed(2)} with itself ${(Math.hypot(fa.shift[0], fa.shift[1]) * input.texelM).toFixed(2)} m away (> ${bar.toFixed(2)}; the surface's own ${ra ? ra.peak.toFixed(2) : 'n/a'})`, fa.peak / bar - 1);
        }
    }
    return { pass: failures.length === 0, failures, metrics: { rim, natural, gradientRatio, hfRatio, orientation, stretch, repeat }, excess };
}
