/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade texture builder's quality score: how good a redrawn wall texture is in itself, beside the identity gate's
 * fidelity to its input (chamfer and lost edges measure how closely a redraw copies its plate, not whether the plate was
 * good: a redraw that faithfully keeps a smeared, seamed or grey input scores well on fidelity). Measured over the wall's own
 * texels (`inside`, else the whole frame), in metres where it matters:
 *
 *   - empty share: texels left flat mid-grey (the unseen fill) or near-black and flat, inside the wall;
 *   - seams: a row (or column) where the wall's structure across it (piers and jambs across a row, bands and sills across a
 *     column) jumps sideways: the band just above matches the band just below best at a shift of SEAM_MIN_SHIFT_M or more,
 *     and poorly in place. A real string course or cornice line keeps the piers in line across it, so it is not a seam;
 *   - smear: runs of rows (or columns) longer than SMEAR_RUN_M that differ from each other by under SMEAR_STEP_SHARE of the
 *     wall's ordinary step (a stretched or repeated strip);
 *   - flat blocks: a region inside the frame (not touching its edge: the sky a redraw adds above a cornice does) flatter than
 *     FLAT_STD_LUMA over 5 x 5 and larger than FLAT_MAX_M2 (a plain slab the model kept from a flat input);
 *   - sharpness: the mean luminance gradient, reported (scale-dependent, not gated).
 */

/** Inside the wall, at most this share flat grey or empty. */
export const MAX_EMPTY_SHARE = 0.08;
/** The bands compared either side of a candidate seam, metres tall. */
export const SEAM_BAND_M = 0.4;
/** A sideways jump of the structure across a line at least this long, metres, makes it a seam. */
export const SEAM_MIN_SHIFT_M = 0.15;
/** The largest jump searched, metres. */
export const SEAM_MAX_SHIFT_M = 1.5;
/**
 * The bands must match at least this well somewhere (NCC), and in place at most SEAM_IN_PLACE of that. A seam is the same
 * content shifted, so it matches strongly; a change of rhythm between two real storeys (an entablature's brackets over an
 * arcade's capitals: 0.53 at 0.2 m on the Haughwout's Broome St redraw) matches weakly and is not one.
 */
export const SEAM_MIN_NCC = 0.7;
export const SEAM_IN_PLACE = 0.5;
/** Rows (or columns) whose step to the next is under this share of the wall's median step count as repeating. */
export const SMEAR_STEP_SHARE = 0.2;
/** A wall whose median step is under this (luminance) has too little texture to tell a smear from plain paint. */
export const SMEAR_MIN_TEXTURE = 0.25;
/** A repeating run longer than this, metres, is a smear. */
export const SMEAR_RUN_M = 0.6;
/** At most this share of the wall's rows plus columns in smeared runs. */
export const MAX_SMEAR_SHARE = 0.06;
/**
 * A region inside the frame flatter than FLAT_STD_LUMA (5 x 5 standard deviation) and larger than FLAT_MAX_M2 is a flat
 * block. Calibrated on the Haughwout's redraws (2026-10-22): five good ones' largest interior flat region 0.4-3.8 m2, the one
 * that kept a flat painted fill 91 m2.
 */
export const FLAT_STD_LUMA = 1.5;
export const FLAT_MAX_M2 = 8;

export interface FacadeQuality {
    passed: boolean;
    emptyShare: number;
    seams: { rows: number[]; cols: number[] };
    smearShare: number;
    /** The interior flat blocks over FLAT_MAX_M2, square metres, largest first. */
    flatBlocksM2: number[];
    /** Mean luminance gradient per texel over the wall (0..255 per texel). */
    sharpness: number;
    why: string;
    /** Where the faults are (1), W x H: the empty texels, a band of SEAM_BAND_M either side of each seam, the smeared runs. */
    faultMask: Uint8Array;
}

const luma = (rgba: Uint8Array, i: number) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

/** Per line (row when `rows`, else column): the mean absolute luminance step to the next line, over the wall's texels. */
function lineSteps(L: Float32Array, W: number, H: number, inside: Uint8Array | undefined, rows: boolean): { step: Float64Array; n: Float64Array } {
    const lines = rows ? H : W, along = rows ? W : H;
    const step = new Float64Array(lines), n = new Float64Array(lines);
    for (let a = 0; a + 1 < lines; a++) {
        let s = 0, c = 0;
        for (let b = 0; b < along; b++) {
            const i = rows ? a * W + b : b * W + a, j = rows ? (a + 1) * W + b : b * W + a + 1;
            if (inside && (!inside[i] || !inside[j])) continue;
            s += Math.abs(L[i] - L[j]); c++;
        }
        step[a] = c ? s / c : 0; n[a] = c;
    }
    return { step, n };
}

/**
 * The structure profile of a band of lines [a0, a1): along the lines, the mean luminance gradient across the line direction's
 * perpendicular (for rows: d/dx, the vertical edges of piers and jambs), zero-mean.
 */
function bandProfile(L: Float32Array, W: number, H: number, a0: number, a1: number, rows: boolean): Float64Array {
    const along = rows ? W : H;
    const p = new Float64Array(along);
    for (let a = a0; a < a1; a++) for (let b = 0; b + 1 < along; b++) {
        const i = rows ? a * W + b : b * W + a, j = rows ? a * W + b + 1 : (b + 1) * W + a;
        p[b] += L[j] - L[i];
    }
    let m = 0;
    for (let b = 0; b < along; b++) m += p[b];
    m /= along;
    for (let b = 0; b < along; b++) p[b] -= m;
    return p;
}

/** NCC of profile `u` against `v` shifted by `d` (over their overlap). */
function nccAt(u: Float64Array, v: Float64Array, d: number): number {
    let uv = 0, uu = 0, vv = 0;
    for (let b = Math.max(0, -d); b < u.length && b + d < v.length; b++) { uv += u[b] * v[b + d]; uu += u[b] * u[b]; vv += v[b + d] * v[b + d]; }
    return uu > 0 && vv > 0 ? uv / Math.sqrt(uu * vv) : 0;
}

/** The lines (rows when `rows`) across which the structure jumps sideways. */
function seamLines(L: Float32Array, W: number, H: number, pixelM: number, rows: boolean): number[] {
    const lines = rows ? H : W;
    const k = Math.max(2, Math.round(SEAM_BAND_M / pixelM)), minShift = Math.max(2, Math.round(SEAM_MIN_SHIFT_M / pixelM)), maxShift = Math.max(minShift + 1, Math.round(SEAM_MAX_SHIFT_M / pixelM));
    const out: number[] = [];
    for (let a = k; a + k <= lines; a++) {
        const above = bandProfile(L, W, H, a - k, a, rows), below = bandProfile(L, W, H, a, a + k, rows);
        const inPlace = nccAt(above, below, 0);
        let best = -1, at = 0;
        for (let d = -maxShift; d <= maxShift; d++) { const v = nccAt(above, below, d); if (v > best) { best = v; at = d; } }
        if (best >= SEAM_MIN_NCC && Math.abs(at) >= minShift && inPlace <= SEAM_IN_PLACE * best) out.push(a);
    }
    return out;
}

const medianOf = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** The quality of a wall texture W x H (RGBA), `pixelM` metres per texel, over `inside` (the wall's polygon) when given. */
export function facadeQuality(rgba: Uint8Array, W: number, H: number, pixelM: number, inside?: Uint8Array): FacadeQuality {
    const N = W * H;
    const L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = luma(rgba, i);
    // empty: flat mid-grey, or dark and flat with its neighbours (an unfilled hole), inside the wall
    let n = 0, empty = 0, grad = 0, gn = 0;
    const emptyAt = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (inside && !inside[i]) continue;
        n++;
        const grey = Math.abs(rgba[i * 4] - 128) <= 4 && Math.abs(rgba[i * 4 + 1] - 128) <= 4 && Math.abs(rgba[i * 4 + 2] - 128) <= 4;
        const gx = x + 1 < W ? Math.abs(L[i + 1] - L[i]) : 0, gy = y + 1 < H ? Math.abs(L[i + W] - L[i]) : 0;
        const flatDark = L[i] < 6 && gx < 1 && gy < 1;
        if (grey || flatDark) { empty++; emptyAt[i] = 1; }
        grad += gx + gy; gn++;
    }
    const emptyShare = n ? empty / n : 0;
    const sharpness = gn ? grad / gn : 0;
    // seams, along rows then columns, then smear
    const seams = { rows: seamLines(L, W, H, pixelM, true), cols: seamLines(L, W, H, pixelM, false) };
    let smearLines = 0;
    const smearRuns: Array<{ rows: boolean; a0: number; a1: number }> = [];
    const runMin = Math.max(2, Math.round(SMEAR_RUN_M / pixelM));
    for (const rows of [true, false]) {
        const { step, n: cnt } = lineSteps(L, W, H, inside, rows);
        const lines = rows ? H : W;
        const typical = medianOf(Array.from(step.subarray(0, lines - 1)).filter((_, a) => cnt[a] > 0));
        // a run of near-identical lines on a wall that otherwise has texture
        if (typical > SMEAR_MIN_TEXTURE) {
            let run = 0;
            for (let a = 0; a < lines; a++) {
                const flat = a + 1 < lines && cnt[a] > 0 && step[a] < SMEAR_STEP_SHARE * typical;
                if (flat) run++;
                if (!flat || a + 1 === lines) { if (run >= runMin) { smearLines += run; smearRuns.push({ rows, a0: a - run, a1: a + 1 }); } run = 0; }
            }
        }
    }
    // seams next to each other are one seam (a step drawn over two texels)
    const merge = (xs: number[]) => xs.filter((v, k) => k === 0 || v - xs[k - 1] > Math.round(SEAM_BAND_M / pixelM));
    seams.rows = merge(seams.rows); seams.cols = merge(seams.cols);
    const smearShare = smearLines / Math.max(1, W + H);
    // flat blocks: 4-connected regions of very flat texels that do not touch the frame's edge
    const flat = new Uint8Array(N);
    for (let y = 2; y + 2 < H; y++) for (let x = 2; x + 2 < W; x++) {
        let s = 0, s2 = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = L[(y + dy) * W + x + dx]; s += v; s2 += v * v; }
        const m = s / 25;
        if (s2 / 25 - m * m < FLAT_STD_LUMA * FLAT_STD_LUMA) flat[y * W + x] = 1;
    }
    const blockMask = new Uint8Array(N), flatBlocksM2: number[] = [], seenF = new Uint8Array(N), maxPx = FLAT_MAX_M2 / (pixelM * pixelM);
    for (let s = 0; s < N; s++) {
        if (!flat[s] || seenF[s]) continue;
        const region: number[] = [], stack = [s];
        seenF[s] = 1;
        let edge = false;
        while (stack.length) {
            const i = stack.pop()!;
            region.push(i);
            const x = i % W, y = (i - x) / W;
            if (x <= 2 || y <= 2 || x >= W - 3 || y >= H - 3) edge = true;
            for (const j of [i - 1, i + 1, i - W, i + W]) {
                if (j < 0 || j >= N || Math.abs((j % W) - x) > 1 || seenF[j] || !flat[j]) continue;
                seenF[j] = 1; stack.push(j);
            }
        }
        if (edge || region.length <= maxPx) continue;
        flatBlocksM2.push(Math.round(region.length * pixelM * pixelM * 10) / 10);
        for (const i of region) blockMask[i] = 1;
    }
    flatBlocksM2.sort((a, b) => b - a);
    const fails: string[] = [];
    if (emptyShare > MAX_EMPTY_SHARE) fails.push(`${(100 * emptyShare).toFixed(0)}% of the wall left flat grey or empty (more than ${100 * MAX_EMPTY_SHARE}%)`);
    if (seams.rows.length || seams.cols.length) fails.push(`${seams.rows.length + seams.cols.length} seam${seams.rows.length + seams.cols.length === 1 ? '' : 's'} across the wall (${[...seams.rows.map(r => `row ${r}`), ...seams.cols.map(c => `column ${c}`)].slice(0, 4).join(', ')})`);
    if (flatBlocksM2.length) fails.push(`${flatBlocksM2.length} flat block${flatBlocksM2.length === 1 ? '' : 's'} inside the wall (${flatBlocksM2.slice(0, 3).join(', ')} m2; over ${FLAT_MAX_M2} m2)`);
    if (smearShare > MAX_SMEAR_SHARE) fails.push(`${(100 * smearShare).toFixed(0)}% of its rows and columns in smeared runs over ${SMEAR_RUN_M} m (more than ${100 * MAX_SMEAR_SHARE}%)`);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const faultMask = emptyShare > MAX_EMPTY_SHARE ? emptyAt.slice() : new Uint8Array(N);
    const band = Math.max(1, Math.round(SEAM_BAND_M / pixelM));
    const mark = (rows: boolean, a0: number, a1: number) => {
        for (let a = Math.max(0, a0); a < Math.min(rows ? H : W, a1); a++) for (let b = 0; b < (rows ? W : H); b++) faultMask[rows ? a * W + b : b * W + a] = 1;
    };
    for (const r of seams.rows) mark(true, r - band, r + band);
    for (const c of seams.cols) mark(false, c - band, c + band);
    if (smearShare > MAX_SMEAR_SHARE) for (const r of smearRuns) mark(r.rows, r.a0, r.a1);
    for (let i = 0; i < N; i++) if (blockMask[i]) faultMask[i] = 1;
    if (inside) for (let i = 0; i < N; i++) if (!inside[i]) faultMask[i] = 0;
    return {
        passed: fails.length === 0, emptyShare: r3(emptyShare), seams, smearShare: r3(smearShare), flatBlocksM2, sharpness: Math.round(sharpness * 100) / 100, faultMask,
        why: fails.length ? `quality: ${fails.join('; ')}` : `quality: ${(100 * emptyShare).toFixed(0)}% empty, no seam, ${(100 * smearShare).toFixed(0)}% smeared, sharpness ${sharpness.toFixed(1)}`
    };
}

/**
 * What the survey saw through (the plate's holes: openings whose recess lies beyond the plate's slab) must still read as
 * openings in the redraw: differ from the wall around them in luminance by OPENING_MIN_CONTRAST, or be at least
 * OPENING_MIN_SMOOTH_RATIO times as smooth (glazing). Calibrated on the Haughwout (2026-10-22): four good redraws 24-59 levels
 * from the wall and 2.1-5.8 times as smooth; the one that painted grey plaster over them 4 levels, 0.65 times.
 */
export const OPENING_MIN_CONTRAST = 12;
export const OPENING_MIN_SMOOTH_RATIO = 1.5;

export interface OpeningsKept { passed: boolean; contrast: number; smoothRatio: number; holeShare: number; why: string }

/** Whether the redraw still shows openings where the survey saw through (`holes`, 1); the wall is everything else. */
export function openingsKept(rgba: Uint8Array, W: number, H: number, holes: Uint8Array): OpeningsKept {
    const N = W * H, L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = luma(rgba, i);
    // local smoothness: the standard deviation of luminance over 5 x 5
    const smooth = new Uint8Array(N);
    for (let y = 2; y + 2 < H; y++) for (let x = 2; x + 2 < W; x++) {
        let s = 0, s2 = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = L[(y + dy) * W + x + dx]; s += v; s2 += v * v; }
        const m = s / 25;
        smooth[y * W + x] = s2 / 25 - m * m < 25 ? 1 : 0;
    }
    // the inside of each side, 2 texels in from the boundary (no edge texels on either side)
    const inner = (want: number) => {
        const m = new Uint8Array(N);
        for (let y = 2; y + 2 < H; y++) for (let x = 2; x + 2 < W; x++) {
            let ok = true;
            for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) if ((holes[(y + dy) * W + x + dx] ? 1 : 0) !== want) ok = false;
            m[y * W + x] = ok ? 1 : 0;
        }
        return m;
    };
    const hin = inner(1), win = inner(0);
    let hn = 0, hl = 0, hs = 0, wn = 0, wl = 0, ws = 0;
    for (let i = 0; i < N; i++) {
        if (hin[i]) { hn++; hl += L[i]; hs += smooth[i]; }
        if (win[i]) { wn++; wl += L[i]; ws += smooth[i]; }
    }
    const holeShare = hn / N;
    if (hn < 0.01 * N || !wn) return { passed: true, contrast: 0, smoothRatio: 1, holeShare: Math.round(holeShare * 1000) / 1000, why: 'openings: too few seen-through texels to check' };
    const contrast = Math.abs(hl / hn - wl / wn), smoothRatio = (hs / hn) / Math.max(1e-3, ws / wn);
    const passed = contrast >= OPENING_MIN_CONTRAST || smoothRatio >= OPENING_MIN_SMOOTH_RATIO;
    return {
        passed, contrast: Math.round(contrast * 10) / 10, smoothRatio: Math.round(smoothRatio * 100) / 100, holeShare: Math.round(holeShare * 1000) / 1000,
        why: passed ? `openings kept where the survey saw through (${contrast.toFixed(0)} levels from the wall, ${smoothRatio.toFixed(1)} times as smooth)`
            : `where the survey saw through the wall (openings) the redraw shows wall (${contrast.toFixed(0)} levels from it, ${smoothRatio.toFixed(1)} times as smooth): it painted over the openings`
    };
}
