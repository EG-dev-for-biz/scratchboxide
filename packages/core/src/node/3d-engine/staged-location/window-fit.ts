/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window fit (SB-Fenestra, docs/research/2026-10-27-sb-fenestra-window-fit-design.md section 11): where a straightened
 * facade photo has windows, as rectangles in the photo, read by composing the photometric relief's grid with tests on the
 * photo's darkness. Per facade:
 * 1. bands: change points of the darkness along the wall, then up it within each (a wing of another rhythm, a base);
 * 2. the relief's grid (scratchbox_photometric_relief.hpp, through scripts/relief_band.cpp) on the whole facade and on each
 *    band (a band where neither reads borrows the grid of the facade's nearest band that has one), and again with alternate stripes along the wall and bands up it hidden (the held-out folds);
 * 3. six readings per band: cells or strips, each on the relief's one pitch, on a nested grid (bay pitch, then panes) or on
 *    the bays as their piers stand; every reading measured up and along the wall (an opening's dark run, darker than the
 *    piers beside it; storeys that agree in height, far shorter ones dropped); the facade's grid first, the band's own where
 *    it reads clearly better; the reading with the best evidence (darker than the wall beside it along its row) chosen;
 * 4. the gate: a band of one storey gets nothing; the chosen reading must beat itself shifted half a pitch on the folds'
 *    hidden parts, summed (a band too small to be judged on two folds: on its own fold and the facade's bands pooled); a
 *    face too narrow for a grid along the wall is read as one window column from its storey rhythm (storeyColumn);
 * 5. strip bays split at the window-column rhythm inside them, when most of the band's bays find it;
 * 6. the band's lattice completed from its own repeats (completeLattice): a site of its windows' grid inside the lattice is a
 *    window unless the photo there is the piers' stone, so a lit or dark pane on the grid is not dropped; where the photo
 *    never reached, a site flanked on both axes continues the grid (generated);
 * 7. a strip's panes from the band's folded unit cell (panesOfUnitCell: its strips of one width folded up the wall at the
 *    storey pitch and across their width; glass rows by colour, glass columns between the mullions), none where it cannot
 *    read them; every pane kept only where it reads unlike the stone beside its window (panesUnlikeWall).
 * The windows are photo-inferred. Facades are fitted in parallel, before the lattice reads them (window_fit.json beside the
 * orthos).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodePng } from '../../texture-processing';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import { encodePng } from './png-encode';

export const WINDOW_FIT_VERSION = 'window-fit/8';

export const WINDOW_FIT_PARAMS = {
    /** A cell's darkness above its surround's: the cell is present. */
    present: 0.06,
    /** The held-out stripe and band width (m). */
    heldOutSpanM: 8.0,
    /** A dark run at least this share of the longest is an opening column or row. */
    runShare: 0.5,
    /** A band spans at least this along the wall (about three bays) and this up it (two or three storeys) (m). */
    minBandSM: 20.0, minBandTM: 10.0,
    /** A band's binary split must remove at least this share of its spread. */
    splitGain: 0.12,
    /** A storey row whose profile along the wall correlates less than this with the band's typical storey gets no openings. */
    rowNcc: 0.3,
    /** A lattice needs at least this many storeys to repeat in. */
    storeysMin: 2,
    /** A band's own grid replaces the facade's only when its score is this much higher. */
    clearlyBetter: 1.2,
    /** A strip's row is a bay where it is this much darker than the piers beside it, on this share of a storey's rows. */
    stripMargin: 0.03, stripDarkShare: 0.8,
    /** A cell's dark run up the wall, against its storey's median opening height. */
    heightBand: [0.65, 1.5] as [number, number],
    /** A storey is kept when its openings agree in height (median absolute deviation / median). */
    storeySpread: 0.25,
    /** A storey whose median opening is under this share of the band's tallest storey's is a grille or sill line. */
    shortStorey: 0.4,
    /** Opening evidence: darker than its row's local mean along the wall over this (m). */
    latWindowM: 6.0,
    /** A re-phased column's width, against the grid's. */
    rephaseWidth: [0.6, 1.6] as [number, number],
    /** A light run inside a bay is a mullion when it rises this share of the way from the bay's darkness to the pier's. */
    mullion: 0.8,
    /** A light run of the column profile is a pier at this share of the fold's pier width; a bay is this range of pitches. */
    pierMinShare: 0.5, bayRange: [0.4, 2.5] as [number, number],
    /** The bay's window-column rhythm: an autocorrelation peak this strong, found on this share of the band's bays. */
    subAc: 0.3, subMajority: 0.6,
    /** A band reading's evidence score must exceed this to be accepted. */
    minScore: 0.12,
    /** A strip splits into panes when its storey's two colour runs differ by at least this (RGB distance, 0-255) and the glass run is this share of the storey. */
    paneContrast: 18, paneShare: [0.2, 0.8] as [number, number],
    /**
     * Lattice completion: the accepted bands' windows grouped into columns and rows (spans overlapping by `overlap` of the
     * wider); a site of that grid with no window, flanked on one axis (on an axis with at least minAxis groups) and with
     * a window beside it on the other, is a window unless its look (mean CIELAB and the spread of its lightness) is nearer
     * the wall just beside it than its column's and row's windows (stone), less than minValid of it has photo, or more than clearShare of it is already a
     * window.
     */
    complete: { overlap: 0.5, minAxis: 3, minValid: 0.5, clearShare: 0.2 },
    /**
     * A band no wider than maxWidthM with no grid along the wall (one window column across) is read from its storey rhythm
     * (storeyColumn): its dark run across the width (at least minColumnShare of it) is the column, its rows folded at the
     * storey pitch give each storey's window (the dark run, minContrast deep, a share of the storey within runShare), and a
     * storey whose rows correlate under minStoreyNcc with the fold is left out; at least minStoreys storeys kept.
     */
    narrow: { maxWidthM: 8.0, minColumnShare: 0.3, minContrast: 0.06, runShare: [0.2, 0.85] as [number, number], minStoreyNcc: 0.5, minStoreys: 3 },
    /** A pane is glass only when its mean colour lies at least this far (CIELAB) from the wall beside its window (panesUnlikeWall). */
    glassDeltaE: 12,
    /** Column pitch search range for the band split's smoothing (m), and the running-mean window it detrends with (m). */
    pitchS: [1.5, 9.0] as [number, number], meanWindowM: 12.0
};
export type WindowFitParams = typeof WINDOW_FIT_PARAMS;

/** The relief's grid, as scripts/relief_band.cpp prints it (plane s/t metres). */
export interface ReliefGrid {
    band: [number, number, number, number];
    periodS: { found: boolean; pitch: number }; periodT: { found: boolean; pitch: number };
    cell: { foundS: boolean; foundT: boolean; runsS: Array<[number, number]>; runsT: Array<[number, number]> };
}
/** The relief read on bands of the photo, with alternate stripes (s) or bands (t) of `span` pixels of `parity` hidden. */
export type ReliefRunner = (hide: '-' | 's' | 't', span: number, parity: number, bands: Array<[number, number, number, number]>) => Promise<ReliefGrid[]>;

/** The facade's plane frame, as relief_orthos/facades.json gives it. */
export interface FitFrame { pixel: number; orthoSMin: number; orthoTMax: number; texel: number }

/** A window: [x0, y0, x1, y1] in photo pixels (x along s, y down from the top). */
export type WindowRect = [number, number, number, number];

export interface WindowFitBand {
    band: [number, number, number, number]; accepted: boolean; why?: string; grid?: 'facade' | 'band' | 'column'; kind?: Kind;
    /** The band whose own grid this band read with (neither the facade's nor its own read), by index. */
    borrowedFrom?: number;
    /** A narrow face read as one window column (storeyColumn): storeys kept of storeys read. */
    storeys?: string;
    scores?: Record<string, number>; droppedRows?: number; heldOut?: string; margin?: number; subPitch?: string; panes?: string;
    /** Windows added by the lattice completion (completeLattice), and sites it left as stone; of the added, those continued into parts the photo never reached (generated). */
    completed?: number; stone?: number; generated?: number;
    /** Panes dropped because they read like the stone beside their window (panesUnlikeWall). */
    panesDropped?: number;
}
/**
 * `rects` are the openings (a punched window, or a strip of windows and spandrels storey on storey); `panes` the glass in
 * them: each punched window, and the panes a strip's colours split it into at its storey pitch.
 */
export interface WindowFit {
    rects: WindowRect[]; panes: WindowRect[]; bands: WindowFitBand[];
    /** Of `rects`, the windows the lattice completion continued into parts the photo never reached: generated, not photo-inferred. */
    generated?: WindowRect[];
}

type Kind = 'cells' | 'strips' | 'nested-cells' | 'nested-strips' | 'pier-cells' | 'pier-strips';
const KINDS: Kind[] = ['cells', 'strips', 'nested-cells', 'nested-strips', 'pier-cells', 'pier-strips'];

// ------------------------------------------------------------------------------------------------ small numerics (numpy's)

const finite = (a: ArrayLike<number>) => Array.from(a).filter(Number.isFinite);
const mean = (a: ArrayLike<number>) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { s += a[i]; n++; } return n ? s / n : NaN; };
/** numpy's linear-interpolated percentile over the finite values (NaN when none). */
function percentile(a: ArrayLike<number>, q: number): number {
    const v = finite(a).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const r = (q / 100) * (v.length - 1), lo = Math.floor(r), hi = Math.ceil(r);
    return v[lo] + (v[hi] - v[lo]) * (r - lo);
}
const median = (a: ArrayLike<number>) => percentile(a, 50);
/** Python's round(): halves to even. */
const pyRound = (x: number) => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1; };
const boxesIou = (a: WindowRect, b: WindowRect) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])), i = ix * iy;
    const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
    return u ? i / u : 0;
};
const cmpRect = (a: WindowRect, b: WindowRect) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
const ncc = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    const d = Math.sqrt(aa * bb);
    return d > 0 ? ab / d : 0;
};

/** The photo's darkness: 1 - luminance / (1.15 x its local mean over about 4 m), clipped to [0, 1]; NaN off the photo. */
export class Darkness {
    readonly D: Float64Array;
    constructor(readonly W: number, readonly H: number, D: Float64Array) { this.D = D; }
    static of(img: { rgba: ArrayLike<number>; width: number; height: number }, uncovered: ArrayLike<number> | undefined, pixel: number): { dk: Darkness; valid: Uint8Array } {
        const W = img.width, H = img.height, N = W * H;
        const valid = new Uint8Array(N), lum = new Float64Array(N);
        for (let k = 0; k < N; k++) {
            valid[k] = img.rgba[k * 4 + 3] > 0 && !(uncovered && uncovered[k]) ? 1 : 0;
            lum[k] = 0.2126 * img.rgba[k * 4] + 0.7152 * img.rgba[k * 4 + 1] + 0.0722 * img.rgba[k * 4 + 2];
        }
        const n = Math.max(3, Math.trunc(4.0 / pixel)) | 1, h = n >> 1;
        const integ = (f: (k: number) => number) => {
            const c = new Float64Array((W + 1) * (H + 1));
            for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += f(y * W + x); c[(y + 1) * (W + 1) + x + 1] = c[y * (W + 1) + x + 1] + row; } }
            return c;
        };
        const cl = integ(k => (valid[k] ? lum[k] : 0)), cv = integ(k => valid[k]);
        const D = new Float64Array(N);
        for (let y = 0; y < H; y++) {
            const y0 = Math.max(0, y - h), y1 = Math.min(H, y + h + 1);
            for (let x = 0; x < W; x++) {
                const k = y * W + x;
                if (!valid[k]) { D[k] = NaN; continue; }
                const x0 = Math.max(0, x - h), x1 = Math.min(W, x + h + 1);
                const box = (c: Float64Array) => c[y1 * (W + 1) + x1] - c[y0 * (W + 1) + x1] - c[y1 * (W + 1) + x0] + c[y0 * (W + 1) + x0];
                const wall = Math.max((box(cl) / Math.max(box(cv), 1)) * 1.15, 1);
                D[k] = Math.min(1, Math.max(0, (wall - lum[k]) / wall));
            }
        }
        return { dk: new Darkness(W, H, D), valid };
    }
    at(x: number, y: number) { return this.D[y * this.W + x]; }
    /** Per column x0..x1 the mean over rows y0..y1 (NaN where none). */
    colMeans(x0: number, x1: number, y0: number, y1: number): Float64Array {
        const out = new Float64Array(Math.max(0, x1 - x0));
        for (let x = x0; x < x1; x++) { let s = 0, n = 0; for (let y = y0; y < y1; y++) { const v = this.D[y * this.W + x]; if (v === v) { s += v; n++; } } out[x - x0] = n ? s / n : NaN; }
        return out;
    }
    /** Per row y0..y1 the mean over columns x0..x1 (NaN where none). */
    rowMeans(x0: number, x1: number, y0: number, y1: number): Float64Array {
        const out = new Float64Array(Math.max(0, y1 - y0));
        for (let y = y0; y < y1; y++) { let s = 0, n = 0; for (let x = x0; x < x1; x++) { const v = this.D[y * this.W + x]; if (v === v) { s += v; n++; } } out[y - y0] = n ? s / n : NaN; }
        return out;
    }
    /** Mean over a box, optionally excluding an inner box (NaN where none). */
    boxMean(x0: number, x1: number, y0: number, y1: number, hole?: [number, number, number, number]): number {
        let s = 0, n = 0;
        for (let y = Math.max(0, y0); y < Math.min(this.H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(this.W, x1); x++) {
            if (hole && x >= hole[0] && x < hole[1] && y >= hole[2] && y < hole[3]) continue;
            const v = this.D[y * this.W + x]; if (v === v) { s += v; n++; }
        }
        return n ? s / n : NaN;
    }
    finiteShare(x0: number, x1: number, y0: number, y1: number): number {
        let n = 0, all = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { all++; if (this.D[y * this.W + x] === this.D[y * this.W + x]) n++; }
        return all ? n / all : 0;
    }
}

/** Otsu's threshold of the darkness (64 bins over [0, 1]): the darker class. */
function otsuMask(dk: Darkness, valid: Uint8Array): Uint8Array {
    const hist = new Float64Array(64);
    for (let k = 0; k < dk.D.length; k++) if (valid[k] && dk.D[k] === dk.D[k]) hist[Math.min(63, Math.floor(dk.D[k] * 64))]++;
    const total = hist.reduce((a, b) => a + b, 0);
    let w0 = 0, mu = 0, muAll = 0;
    for (let i = 0; i < 64; i++) muAll += hist[i] * (i + 0.5) / 64;
    let best = -1, at = 0;
    for (let i = 0; i < 64; i++) {
        w0 += hist[i]; mu += hist[i] * (i + 0.5) / 64;
        const w1 = total - w0, b = (muAll * w0 / Math.max(total, 1) - mu) ** 2 / Math.max(w0 * w1, 1);
        if (b > best) { best = b; at = i; }
    }
    const thr = at / 64, out = new Uint8Array(dk.D.length);
    for (let k = 0; k < out.length; k++) out[k] = valid[k] && dk.D[k] > thr ? 1 : 0;
    return out;
}

/** numpy's reflect index (d c b a | a b c d is scipy's 'reflect'; numpy's pad 'reflect' excludes the edge). */
const reflectScipy = (i: number, n: number) => { while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; };
const reflectNumpy = (i: number, n: number) => { if (n === 1) return 0; while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i; return i; };

/** Opening evidence also darker than its row's local mean along the wall (a wall-to-wall dark storey is no evidence). */
function lateralEvidence(dk: Darkness, valid: Uint8Array, dark: Uint8Array, pixel: number, P: WindowFitParams): void {
    const { W, H, D } = dk, k = Math.max(3, pyRound(P.latWindowM / pixel)), lo = k >> 1;
    const s = new Float64Array(W + 1), v = new Float64Array(W + 1);
    for (let y = 0; y < H; y++) {
        // scipy uniform_filter1d (mode reflect): window [x - k//2, x - k//2 + k)
        const pre = (x: number) => { const j = reflectScipy(x, W), kk = y * W + j; return [valid[kk] && D[kk] === D[kk] ? D[kk] : 0, valid[kk]]; };
        let a = 0, b = 0;
        for (let x = -lo; x < -lo + k; x++) { const [d, w] = pre(x); a += d * w; b += w; }
        for (let x = 0; x < W; x++) {
            s[x] = a; v[x] = b;
            const [d0, w0] = pre(x - lo), [d1, w1] = pre(x - lo + k);
            a += d1 * w1 - d0 * w0; b += w1 - w0;
        }
        for (let x = 0; x < W; x++) {
            const kk = y * W + x, local = s[x] / Math.max(v[x], 1e-6), dz = D[kk] === D[kk] ? D[kk] : 0;
            if (!(dz > local + P.stripMargin)) dark[kk] = 0;
        }
    }
}

/** The best repeat lag (m) of a profile: detrended by a running mean, normalised, the strongest positive autocorrelation. */
function autocorrPitch(profile: Float64Array, px: number, lo: number, hi: number, P: WindowFitParams): number {
    const n = profile.length, m = mean(profile);
    const v = Float64Array.from(profile, x => (Number.isFinite(x) ? x : Number.isFinite(m) ? m : 0));
    const w = Math.max(3, Math.trunc(P.meanWindowM / px)) | 1, h = w >> 1;
    const rm = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = i - h; j <= i + h; j++) s += v[reflectNumpy(j, n)]; rm[i] = s / w; }
    for (let i = 0; i < n; i++) v[i] -= rm[i];
    const mu = v.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / n);
    for (let i = 0; i < n; i++) v[i] = (v[i] - mu) / (sd + 1e-9);
    let best = 0, lag = 0;
    for (let k = Math.max(2, Math.trunc(lo / px)); k <= Math.min(Math.floor(n / 2), Math.trunc(hi / px)); k++) {
        let c = 0; for (let i = 0; i + k < n; i++) c += v[i] * v[i + k];
        c /= n - k;
        if (c > best) { best = c; lag = k; }
    }
    return lag * px;
}

/** A moving average of length n along a sequence of vectors (edge-padded), as the prototype's smooth_along. */
function smoothAlong(rows: Float64Array[], n: number): Float64Array[] {
    n = Math.max(1, Math.trunc(n));
    const L = rows.length, h = n >> 1;
    return rows.map((_, i) => {
        const out = new Float64Array(rows[0].length);
        for (let j = i - h; j < i - h + n; j++) { const r = rows[Math.min(L - 1, Math.max(0, j))]; for (let d = 0; d < out.length; d++) out[d] += r[d] / n; }
        return out;
    });
}

/** Binary segmentation of a sequence of vectors by their spread around the segment mean. */
function segments(vec: Float64Array[], minLen: number, gain: number, depth = 0): Array<[number, number]> {
    const n = vec.length;
    if (n < 2 * minLen || depth > 4 || minLen < 1) return [[0, n]];
    const d = vec[0].length;
    const S1: Float64Array[] = [new Float64Array(d)], S2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const p = Float64Array.from(S1[i]); let q = 0; for (let j = 0; j < d; j++) { p[j] += vec[i][j]; q += vec[i][j] ** 2; } S1.push(p); S2[i + 1] = S2[i] + q; }
    const cost = (a: number, b: number) => { let s = 0; for (let j = 0; j < d; j++) s += (S1[b][j] - S1[a][j]) ** 2; return S2[b] - S2[a] - s / Math.max(1, b - a); };
    const whole = cost(0, n);
    let best = 0, at = -1;
    for (let k = minLen; k <= n - minLen; k++) { const g = whole - cost(0, k) - cost(k, n); if (g > best) { best = g; at = k; } }
    if (at < 0 || best < gain * whole) return [[0, n]];
    return [...segments(vec.slice(0, at), minLen, gain, depth + 1), ...segments(vec.slice(at), minLen, gain, depth + 1).map(([a, b]) => [a + at, b + at] as [number, number])];
}

// ------------------------------------------------------------------------------------------------ the readings

interface Ctx { f: FitFrame; dk: Darkness; P: WindowFitParams }
type Band = [number, number, number, number];

function toPx(f: FitFrame, s0: number, s1: number, t0: number, t1: number): [number, number, number, number] {
    const px = f.pixel;
    return [Math.floor((Math.min(s0, s1) - f.orthoSMin) / px), Math.ceil((Math.max(s0, s1) - f.orthoSMin) / px), Math.floor((f.orthoTMax - Math.max(t0, t1)) / px), Math.ceil((f.orthoTMax - Math.min(t0, t1)) / px)];
}

/** A cell is present when it is darker than its surround (half its size around it) by `present`. */
function presentCell(c: Ctx, xa: number, ya: number, xb: number, yb: number): boolean {
    const { dk } = c;
    if (c.dk.finiteShare(xa, xb, ya, yb) < 0.5) return false;
    const my = Math.max(2, (yb - ya) >> 1), mx = Math.max(2, (xb - xa) >> 1);
    const inside = dk.boxMean(xa, xb, ya, yb), around = dk.boxMean(xa - mx, xb + mx, ya - my, yb + my, [xa, xb, ya, yb]);
    return inside - (Number.isFinite(around) ? around : 0) > c.P.present;
}

function runs(a: Array<[number, number]>, share: number) { const m = Math.max(...a.map(r => r[1])); return a.filter(r => r[1] >= share * m); }

interface Nested { ps: number; cols: Array<[number, number]>; lightThr: number; pw: number; pier: number }
/** The band's columns as a nested grid: folded at the bay pitch, the pier the fold's lightest run, panes split at mullions. */
function nestedColumns(c: Ctx, g: ReliefGrid, band: Band): Nested | undefined {
    const [x0, x1, y0, y1] = band, px = c.f.pixel, ps = g.periodS.found ? g.periodS.pitch : 0;
    if (!(ps > 0)) return undefined;
    const col = c.dk.colMeans(x0, x1, y0, y1);
    if (!col.some(Number.isFinite)) return undefined;
    const tw = Math.max(4, Math.ceil(ps / px));
    const sum = new Float64Array(tw), cnt = new Float64Array(tw);
    for (let x = x0; x < x1; x++) { const b = Math.min(tw - 1, Math.max(0, Math.trunc((((x - x0) * px) % ps) / px))), v = col[x - x0]; if (Number.isFinite(v)) { sum[b] += v; cnt[b]++; } }
    let fold = Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : NaN));
    if (!fold.some(Number.isFinite)) return undefined;
    const fmin = Math.min(...finite(fold)); fold = fold.map(v => (Number.isFinite(v) ? v : fmin));
    const lo = Math.min(...fold), hi = Math.max(...fold), lightThr = lo + (hi - lo) / 3;
    const light = fold.map(v => v < lightThr);
    let best: [number, number] = [0, 0], run = 0;
    for (let i = 0; i < 2 * tw; i++) { run = light[i % tw] ? run + 1 : 0; if (run > best[0] && run < tw) best = [run, i - run + 1]; }
    const [pw, pa] = best;
    if (pw < 1 || tw - pw < 2) return undefined;
    const start = (pa + pw) % tw;
    const bay = Array.from({ length: tw - pw }, (_, i) => fold[(start + i) % tw]);
    const pier = mean(fold.filter((_, i) => light[i]));
    const panes = splitPanes(bay, pier, c.P);
    if (!panes.length) return undefined;
    const s0 = c.f.orthoSMin + x0 * px;
    return { ps, cols: panes.map(([a, b]) => [s0 + (start + a) * px, (b - a) * px]), lightThr, pw, pier };
}

/** Runs of a bay's profile darker than its mullion level (MULLION of the way from the bay's 75th percentile to the pier). */
function splitPanes(bay: number[], pier: number, P: WindowFitParams, minW = 0): Array<[number, number]> {
    const dark = percentile(bay, 75), split = dark - P.mullion * (dark - pier);
    const panes: Array<[number, number]> = [];
    for (let i = 0; i < bay.length;) {
        if (bay[i] > split) { let j = i; while (j + 1 < bay.length && bay[j + 1] > split) j++; panes.push([i, j + 1]); i = j + 1; } else i++;
    }
    if (!panes.length) return panes;
    const longest = Math.max(...panes.map(([a, b]) => b - a));
    return panes.filter(([a, b]) => b - a >= P.runShare * longest && b - a >= minW);
}

/** Bays as their piers stand: each run as light as the fold's pier is a pier, each span between two a bay, split at mullions. */
function pierColumns(c: Ctx, g: ReliefGrid, band: Band): Array<[number, number]> {
    const [x0, x1, y0, y1] = band, n = nestedColumns(c, g, band);
    if (!n) return [];
    const raw = c.dk.colMeans(x0, x1, y0, y1);
    if (!raw.some(Number.isFinite)) return [];
    const col = Array.from(raw, v => (Number.isFinite(v) ? v : n.pier));
    const piers: Array<[number, number]> = [];
    for (let i = 0; i < col.length;) {
        if (col[i] < n.lightThr) { let j = i; while (j + 1 < col.length && col[j + 1] < n.lightThr) j++; if (j + 1 - i >= Math.max(1, c.P.pierMinShare * n.pw)) piers.push([i, j + 1]); i = j + 1; } else i++;
    }
    const tw = n.ps / c.f.pixel, spans: Array<[number, number]> = [];
    for (let k = 0; k + 1 < piers.length; k++) {
        const a1 = piers[k][1], b0 = piers[k + 1][0];
        if (!(c.P.bayRange[0] * tw <= b0 - a1 && b0 - a1 <= c.P.bayRange[1] * tw)) continue;
        for (const [p, q] of splitPanes(col.slice(a1, b0), n.pier, c.P, 2)) spans.push([x0 + a1 + p, x0 + a1 + q]);
    }
    return spans;
}

/** The relief's rows (its dark runs up the wall) laid at its storey pitch over the band. */
function rowSpans(c: Ctx, g: ReliefGrid, band: Band): Array<[number, number]> {
    const [, , y0, y1] = band, px = c.f.pixel, pt = g.periodT.pitch;
    const tHi = c.f.orthoTMax - y0 * px, tLo = c.f.orthoTMax - y1 * px, out: Array<[number, number]> = [];
    for (const [rt, rh] of runs(g.cell.runsT, c.P.runShare)) {
        for (let j = Math.floor((tLo - rt) / pt) - 1; j < Math.ceil((tHi - rt) / pt) + 1; j++) {
            const b = rt + j * pt, [, , ya, yb] = toPx(c.f, 0, 0, b, b + rh);
            const a = Math.max(y0, ya), e = Math.min(y1, yb);
            if (e - a >= 2) out.push([a, e]);
        }
    }
    return out;
}

function cellsLayout(c: Ctx, g: ReliefGrid, band: Band, nested: boolean): WindowRect[] {
    const [x0, x1, y0, y1] = band, px = c.f.pixel, cl = g.cell;
    if (!(g.periodS.found && g.periodT.found && cl.foundS && cl.foundT && cl.runsS.length && cl.runsT.length)) return [];
    let ps = g.periodS.pitch, cols = runs(cl.runsS, c.P.runShare);
    if (nested) { const n = nestedColumns(c, g, band); if (n) { ps = n.ps; cols = n.cols; } }
    const sLo = c.f.orthoSMin + x0 * px, sHi = c.f.orthoSMin + x1 * px, rows = rowSpans(c, g, band), out: WindowRect[] = [];
    for (const [cs, cw] of cols) for (let k = Math.floor((sLo - cs) / ps) - 1; k < Math.ceil((sHi - cs) / ps) + 1; k++) {
        const [xa0, xb0] = toPx(c.f, cs + k * ps, cs + k * ps + cw, 0, 0), xa = Math.max(x0, xa0), xb = Math.min(x1, xb0);
        if (xb - xa < 2) continue;
        for (const [ya, yb] of rows) if (presentCell(c, xa, ya, xb, yb)) out.push([xa, ya, xb, yb]);
    }
    return out;
}

function pierCellsLayout(c: Ctx, g: ReliefGrid, band: Band): WindowRect[] {
    if (!(g.periodT.found && g.cell.foundT && g.cell.runsT.length)) return [];
    const rows = rowSpans(c, g, band), out: WindowRect[] = [];
    for (const [xa, xb] of pierColumns(c, g, band)) for (const [ya, yb] of rows) if (presentCell(c, xa, ya, xb, yb)) out.push([xa, ya, xb, yb]);
    return out;
}

function stripsLayout(c: Ctx, g: ReliefGrid, band: Band, nested: boolean): WindowRect[] {
    const [x0, x1, y0, y1] = band, px = c.f.pixel;
    if (nested) {
        const n = nestedColumns(c, g, band);
        if (!n) return [];
        const sLo = c.f.orthoSMin + x0 * px, sHi = c.f.orthoSMin + x1 * px, out: WindowRect[] = [];
        for (const [cs, cw] of n.cols) for (let k = Math.floor((sLo - cs) / n.ps) - 1; k < Math.ceil((sHi - cs) / n.ps) + 1; k++) {
            const [a, b] = toPx(c.f, cs + k * n.ps, cs + k * n.ps + cw, 0, 0), xa = Math.max(x0, a), xb = Math.min(x1, b);
            if (xb - xa >= 2) out.push([xa, y0, xb, y1]);
        }
        return out;
    }
    const ps = g.periodS.found ? g.periodS.pitch : 0;
    if (!(ps > 0)) return [];
    const col = c.dk.colMeans(x0, x1, y0, y1);
    if (!col.some(Number.isFinite)) return [];
    const tw = Math.max(4, pyRound(ps / px));
    const fold = Array.from({ length: tw }, (_, i) => mean(Array.from(col).filter((_, x) => x % tw === i)));
    if (!fold.some(Number.isFinite)) return [];
    const fv = finite(fold), lo = Math.min(...fv), hi = Math.max(...fv), light = fold.map(v => v < lo + (hi - lo) / 3);
    let best: [number, number] = [0, 0], run = 0;
    for (let i = 0; i < 2 * tw; i++) { run = light[i % tw] ? run + 1 : 0; if (run > best[0] && run < tw) best = [run, i - run + 1]; }
    const [pw, pa] = best;
    if (pw < 1 || tw - pw < 2) return [];
    const a = (pa + pw) % tw, w = tw - pw, out: WindowRect[] = [];
    for (let k = -1; k < Math.floor((x1 - x0) / tw) + 2; k++) {
        const xa = Math.max(x0, x0 + a + k * tw), xb = Math.min(x1, x0 + a + k * tw + w);
        if (xb - xa >= 2) out.push([xa, y0, xb, y1]);
    }
    return out;
}

/** The band's storey slabs from its top at the storey pitch; those whose profile along the wall repeats the band's. */
function repeatingSlabs(c: Ctx, band: Band, ptPx: number): { slabs: Array<[number, number]>; keep: Set<string> } {
    const [x0, x1, y0, y1] = band;
    const slabs: Array<[number, number]> = ptPx < 4 ? [[y0, y1]] : [];
    if (ptPx >= 4) for (let y = y0; y < y1; y += ptPx) if (Math.min(y1, y + ptPx) - y >= ptPx >> 1) slabs.push([y, Math.min(y1, y + ptPx)]);
    const key = (s: [number, number]) => `${s[0]},${s[1]}`;
    if (slabs.length < 3) return { slabs, keep: new Set(slabs.map(key)) };
    const prof = slabs.map(s => Array.from(c.dk.colMeans(x0, x1, s[0], s[1]), v => (Number.isFinite(v) ? v : 0)));
    const med = prof[0].map((_, i) => median(prof.map(p => p[i])));
    return { slabs, keep: new Set(slabs.filter((_, i) => ncc(prof[i], med) >= c.P.rowNcc).map(key)) };
}

/** Each strip kept over the storeys where it is darker than the piers beside it and the storey repeats the band's. */
function refineStrips(c: Ctx, rects: WindowRect[], band: Band, ptPx: number): WindowRect[] {
    if (!rects.length) return rects;
    const { dk, P } = c, W = dk.W;
    const xs = [...rects].sort(cmpRect);
    const gaps = xs.slice(0, -1).map((r, i) => xs[i + 1][0] - r[2]).filter(g => g > 0);
    const pw = gaps.length ? Math.trunc(median(gaps)) : Math.max(2, Math.trunc((xs[0][2] - xs[0][0]) / 3));
    const { slabs, keep } = repeatingSlabs(c, band, ptPx);
    const out: WindowRect[] = [];
    for (const [xa, ya, xb, yb] of rects) {
        const l0 = Math.max(0, xa - pw), r1 = Math.min(W, xb + pw);
        for (const s of slabs) {
            if (!keep.has(`${s[0]},${s[1]}`)) continue;
            const a = Math.max(ya, s[0]), b = Math.min(yb, s[1]);
            if (b - a < 2) continue;
            const strip = dk.rowMeans(xa, xb, a, b);
            let ok = 0, darkRows = 0;
            for (let i = 0; i < b - a; i++) {
                // the pier's mean over both sides' columns, as one block
                let ps = 0, pn = 0;
                for (let x = l0; x < xa; x++) { const v = dk.at(x, a + i); if (v === v) { ps += v; pn++; } }
                for (let x = xb; x < r1; x++) { const v = dk.at(x, a + i); if (v === v) { ps += v; pn++; } }
                const pier = l0 < xa || xb < r1 ? (pn ? ps / pn : NaN) : 0;
                if (!(Number.isFinite(strip[i]) && Number.isFinite(pier))) continue;
                ok++;
                if (strip[i] - pier > P.stripMargin) darkRows++;
            }
            if (ok / (b - a) < 0.5) continue;
            if (darkRows / ok >= P.stripDarkShare) out.push([xa, a, xb, b]);
        }
    }
    out.sort(cmpRect);
    const merged: WindowRect[] = [];
    for (const r of out) { const m = merged[merged.length - 1]; if (m && m[0] === r[0] && m[2] === r[2] && m[3] === r[1]) m[3] = r[3]; else merged.push([...r] as WindowRect); }
    return merged;
}

/** Each column measured along the wall: moved to the darkest point near it and given the dark run there. */
function rephaseColumns(c: Ctx, rects: WindowRect[], band: Band): WindowRect[] {
    if (!rects.length) return rects;
    const { dk, P } = c, [x0, x1] = band, out: WindowRect[] = [];
    for (const [xa, ya, xb, yb] of rects) {
        const w = xb - xa, lo = Math.max(x0, xa - (w >> 1)), hi = Math.min(x1, xb + (w >> 1));
        const raw = yb > ya && hi > lo ? dk.colMeans(lo, hi, ya, yb) : new Float64Array(0);
        if (!raw.length || !raw.some(Number.isFinite)) { out.push([xa, ya, xb, yb]); continue; }
        const pier = percentile(raw, 15), q = Array.from(raw, v => (Number.isFinite(v) ? v : pier)), n = q.length;
        const k = Math.max(1, w >> 2), sm = q.map((_, i) => { let s = 0; for (let j = i - (k >> 1); j <= i + ((k - 1) >> 1); j++) if (j >= 0 && j < n) s += q[j]; return s / k; });
        const c0 = xa - lo, c1 = xb - lo;
        let mid = (c0 + c1) >> 1;
        if (c1 > c0) { mid = c0; for (let i = c0; i < c1; i++) if (sm[i] > sm[mid]) mid = i; }
        const lv = q.slice(Math.max(0, mid - (k >> 1)), mid + (k >> 1) + 1), level = lv.reduce((a, b) => a + b, 0) / lv.length, thr = (level + pier) / 2;
        if (q[mid] <= thr || level - pier < P.stripMargin) { out.push([xa, ya, xb, yb]); continue; }
        const grow = (i: number, d: number) => { for (;;) { let moved = false; for (const g of [1, 2, 3, 4]) { const nx = i + d * g; if (nx >= 0 && nx < n && q[nx] > thr) { i = nx; moved = true; break; } } if (!moved) return i; } };
        const a = grow(mid, -1), b = grow(mid, 1), nw = b + 1 - a;
        if (!(P.rephaseWidth[0] * w <= nw && nw <= P.rephaseWidth[1] * w)) { out.push([xa, ya, xb, yb]); continue; }
        const na = lo + a, nb = lo + b + 1, pw = Math.max(2, (nb - na) >> 1);
        // still an opening where it moved: darker than the piers beside it
        let ss = 0, sn = 0;
        for (let y = ya; y < yb; y++) { for (let x = Math.max(x0, na - pw); x < na; x++) { const v = dk.at(x, y); if (v === v) { ss += v; sn++; } } for (let x = nb; x < Math.min(x1, nb + pw); x++) { const v = dk.at(x, y); if (v === v) { ss += v; sn++; } } }
        if (sn && dk.boxMean(na, nb, ya, yb) - ss / sn < P.stripMargin) continue;
        out.push([na, ya, nb, yb]);
    }
    const keep: WindowRect[] = [];
    for (const r of out.sort(cmpRect)) if (!keep.some(o => boxesIou(r, o) > 0.5)) keep.push(r);
    return keep;
}

/** Each cell measured up the wall (its dark run, darker than the piers beside it); storeys that agree in height kept. */
function refineCells(c: Ctx, rects: WindowRect[], band: Band): WindowRect[] {
    if (!rects.length) return rects;
    const { dk, P } = c, [x0, x1, y0, y1] = band;
    const bandVals: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = dk.at(x, y); if (v === v) bandVals.push(v); }
    const wall = bandVals.length ? percentile(bandVals, 30) : 0;
    const measured: Array<{ key: string; r: WindowRect }> = [];
    for (const [xa, ya, xb, yb] of rects) {
        const pRaw = dk.rowMeans(xa, xb, y0, y1);
        if (!pRaw.some(Number.isFinite)) continue;
        const w = Math.max(2, (xb - xa) >> 1), l0 = Math.max(x0, xa - w), r1 = Math.min(x1, xb + w);
        const hasSide = l0 < xa || xb < r1;
        const lat = Array.from(pRaw, (v, i) => {
            const y = y0 + i;
            let ps = 0, pn = 0;
            for (let x = l0; x < xa; x++) { const d = dk.at(x, y); if (d === d) { ps += d; pn++; } }
            for (let x = xb; x < r1; x++) { const d = dk.at(x, y); if (d === d) { ps += d; pn++; } }
            const pier = hasSide && pn ? ps / pn : wall;
            return (Number.isFinite(v) ? v : wall) - pier;
        });
        const c0 = ya - y0, c1 = yb - y0, mid = (c0 + c1) >> 1, n = lat.length;
        if (!(mid >= 0 && mid < n)) continue;
        const inner = c1 > c0 ? lat.slice(c0, c1).reduce((a, b) => a + b, 0) / lat.slice(c0, c1).length : lat[mid], thr = inner / 2;
        if (inner < P.stripMargin || lat[mid] <= thr) continue;
        const grow = (i: number, d: number) => { for (;;) { let moved = false; for (const g of [1, 2, 3]) { const nx = i + d * g; if (nx >= 0 && nx < n && lat[nx] > thr) { i = nx; moved = true; break; } } if (!moved) return i; } };
        measured.push({ key: `${ya},${yb}`, r: [xa, y0 + grow(mid, -1), xb, y0 + grow(mid, 1) + 1] });
    }
    if (!measured.length) return [];
    const storeys = new Map<string, WindowRect[]>();
    for (const m of measured) { const l = storeys.get(m.key); if (l) l.push(m.r); else storeys.set(m.key, [m.r]); }
    const tallest = Math.max(...[...storeys.values()].map(rs => median(rs.map(r => r[3] - r[1]))));
    const out: WindowRect[] = [];
    const order = [...storeys.keys()].sort((a, b) => { const [a0, a1] = a.split(',').map(Number), [b0, b1] = b.split(',').map(Number); return a0 - b0 || a1 - b1; });
    for (const key of order) {
        const rs = storeys.get(key)!, hs = rs.map(r => r[3] - r[1]), med = median(hs);
        if (storeys.size > 1 && med < P.shortStorey * tallest) continue;
        if (rs.length < 2 || median(hs.map(h => Math.abs(h - med))) > P.storeySpread * med) continue;
        for (const r of [...rs].sort(cmpRect)) {
            const h = r[3] - r[1];
            if (!(P.heightBand[0] * med <= h && h <= P.heightBand[1] * med)) continue;
            if (out.some(o => boxesIou(r, o) > 0.5)) continue;
            out.push(r);
        }
    }
    return out;
}

/** A bay's window columns, from the rhythm of its per-column variation up the wall (high on columns, low on mullions). */
function bayColumns(c: Ctx, xa: number, ya: number, xb: number, yb: number): Array<[number, number]> | undefined {
    const W = xb - xa;
    if (W < 16 || yb - ya < 4) return undefined;
    const p = new Float64Array(W);
    for (let x = xa; x < xb; x++) {
        let s = 0, s2 = 0, n = 0;
        for (let y = ya; y < yb; y++) { const v = c.dk.at(x, y); if (v === v) { s += v; s2 += v * v; n++; } }
        p[x - xa] = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
    }
    const pm = p.reduce((a, b) => a + b, 0) / W, q = Array.from(p, v => v - pm), den = q.reduce((a, b) => a + b * b, 0);
    if (!(den > 0)) return undefined;
    const ac = Array.from({ length: W }, (_, L) => { let s = 0; for (let i = 0; i + L < W; i++) s += q[i] * q[i + L]; return s / den; });
    const lo = Math.max(6, Math.trunc(0.25 * W)), hi = Math.trunc(0.6 * W);
    let L = -1;
    for (let l = lo; l <= Math.min(hi, W - 2); l++) if (ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1] && ac[l] >= c.P.subAc && (L < 0 || ac[l] > ac[L])) L = l;
    if (L < 0) return undefined;
    const n = pyRound(W / L);
    if (n < 2) return undefined;
    const sm = Array.from(p, (_, i) => ((i > 0 ? p[i - 1] : 0) + p[i] + (i < W - 1 ? p[i + 1] : 0)) / 3);
    const argmin = (a: number, b: number) => { let m = a; for (let i = a; i < b; i++) if (sm[i] < sm[m]) m = i; return m; };
    const divs: number[] = [];
    for (let k = 1; k < n; k++) { const cc = pyRound((k * W) / n); divs.push(argmin(Math.max(1, cc - Math.trunc(L / 3)), Math.min(W - 1, cc + Math.trunc(L / 3) + 1))); }
    const smMed = median(sm), thr = (d: number) => (sm[d] + smMed) / 2;
    const edge = Math.max(1, Math.trunc(L / 3));
    const leftEdge = argmin(0, edge);
    let rightEdge = W - 1; for (let i = W - 1; i >= W - edge; i--) if (sm[i] < sm[rightEdge]) rightEdge = i;
    const bounds = [0, ...divs, W], cols: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
        const a = bounds[i], b = bounds[i + 1];
        const t = Math.max(i > 0 ? thr(divs[i - 1]) : thr(leftEdge), i < n - 1 ? thr(divs[i]) : thr(rightEdge));
        let first = -1, last = -1;
        for (let x = a; x < b; x++) if (sm[x] > t) { if (first < 0) first = x; last = x; }
        if (first >= 0 && last + 1 - first >= 0.4 * L) cols.push([xa + first, xa + last + 1]);
    }
    return cols.length >= 2 ? cols : undefined;
}

/** Strips split at the window-column rhythm inside each bay, when most of the band's bays find it. */
function splitBays(c: Ctx, rects: WindowRect[]): { rects: WindowRect[]; found: number; bays: number } {
    if (!rects.length) return { rects, found: 0, bays: 0 };
    const bays = new Map<string, WindowRect[]>();
    for (const r of rects) { const k = `${r[0]},${r[2]}`, l = bays.get(k); if (l) l.push(r); else bays.set(k, [r]); }
    const found = new Map<string, Array<[number, number]> | undefined>();
    for (const [k, rs] of bays) found.set(k, bayColumns(c, rs[0][0], Math.min(...rs.map(r => r[1])), rs[0][2], Math.max(...rs.map(r => r[3]))));
    const nf = [...found.values()].filter(Boolean).length;
    if (nf / bays.size < c.P.subMajority) return { rects, found: nf, bays: bays.size };
    const out: WindowRect[] = [];
    for (const [k, rs] of bays) { const cols = found.get(k); for (const r of rs) if (cols) for (const [a, b] of cols) out.push([a, r[1], b, r[3]]); else out.push(r); }
    return { rects: out, found: nf, bays: bays.size };
}

/**
 * A strip's panes: storey on storey a strip alternates glass and spandrel. Its rows (the middle 60% of its width) are folded at
 * the storey pitch (fractional, so the phase holds over the whole height) and their colours split in two (2-means). The glass
 * run is the one nearer the sky's colour: the bluer of the two, the lighter on a tie (glass reflects the sky; a spandrel is
 * metal or stone). No split (undefined) when the two runs barely differ or the glass is not a real share of the storey.
 */
export function panesOfStrip(img: { rgba: ArrayLike<number>; width: number; height: number }, valid: Uint8Array, r: WindowRect, pitchPx: number, P: WindowFitParams): WindowRect[] | undefined {
    const [xa, ya, xb, yb] = r, w = xb - xa, W = img.width;
    if (!(pitchPx >= 6) || yb - ya < 1.6 * pitchPx || w < 3) return undefined;
    const nb = Math.max(6, Math.round(pitchPx)), sum = Array.from({ length: nb }, () => [0, 0, 0, 0]);
    const ca = xa + Math.floor(w * 0.2), cb = Math.max(ca + 1, xb - Math.floor(w * 0.2));
    for (let y = ya; y < yb; y++) {
        const bin = Math.min(nb - 1, Math.floor((((y - ya) % pitchPx) / pitchPx) * nb));
        for (let x = ca; x < cb; x++) { const k = y * W + x; if (!valid[k]) continue; for (let c = 0; c < 3; c++) sum[bin][c] += img.rgba[k * 4 + c]; sum[bin][3]++; }
    }
    if (sum.some(b => b[3] === 0)) return undefined;
    const fold = sum.map(b => [b[0] / b[3], b[1] / b[3], b[2] / b[3]]);
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // 2-means, from the darkest and the lightest bins
    let A = fold.reduce((m, c) => (lum(c) < lum(m) ? c : m)), B = fold.reduce((m, c) => (lum(c) > lum(m) ? c : m));
    let side = fold.map(() => 0);
    for (let it = 0; it < 10; it++) {
        side = fold.map(c => (Math.hypot(c[0] - A[0], c[1] - A[1], c[2] - A[2]) <= Math.hypot(c[0] - B[0], c[1] - B[1], c[2] - B[2]) ? 0 : 1));
        const mean = (s: number) => { const m = [0, 0, 0]; let n = 0; fold.forEach((c, i) => { if (side[i] === s) { for (let k = 0; k < 3; k++) m[k] += c[k]; n++; } }); return n ? m.map(v => v / n) : undefined; };
        const a = mean(0), b = mean(1);
        if (!a || !b) return undefined;
        A = a; B = b;
    }
    if (Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) < P.paneContrast) return undefined;
    const blue = (c: number[]) => c[2] / Math.max(1, c[0] + c[1] + c[2]);
    const glassSide = Math.abs(blue(A) - blue(B)) > 0.01 ? (blue(A) > blue(B) ? 0 : 1) : lum(A) > lum(B) ? 0 : 1;
    const share = side.filter(s => s === glassSide).length / nb;
    if (share < P.paneShare[0] || share > P.paneShare[1]) return undefined;
    // the glass run: the longest run of glass bins, round the storey
    let best: [number, number] = [0, 0];
    for (let i = 0; i < nb; i++) {
        if (side[i] !== glassSide || side[(i - 1 + nb) % nb] === glassSide) continue;
        let n = 0; while (n < nb && side[(i + n) % nb] === glassSide) n++;
        if (n > best[1]) best = [i, n];
    }
    if (!best[1]) return undefined;
    const out: WindowRect[] = [];
    for (let k = -1; ya + k * pitchPx < yb; k++) {
        const y0 = Math.max(ya, Math.round(ya + k * pitchPx + (best[0] / nb) * pitchPx)), y1 = Math.min(yb, Math.round(ya + k * pitchPx + ((best[0] + best[1]) / nb) * pitchPx));
        if (y1 - y0 >= 2) out.push([xa, y0, xb, y1]);
    }
    return out.length ? out : undefined;
}

/** sRGB 8-bit to CIELAB (D65). */
function labOf8(r: number, g: number, b: number): [number, number, number] {
    const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * Spans grouped where they overlap by `overlap` of the wider (so a bay-wide strip never joins the window columns inside it):
 * each group's median span and its members' indices.
 */
function spanGroups(spans: Array<[number, number]>, overlap: number): Array<{ lo: number; hi: number; members: number[] }> {
    const order = spans.map((_, i) => i).sort((a, b) => spans[a][0] - spans[b][0]);
    const groups: Array<{ lo: number; hi: number; members: number[] }> = [];
    for (const i of order) {
        const [a, b] = spans[i];
        const g = groups.find(x => Math.min(b, x.hi) - Math.max(a, x.lo) >= overlap * Math.max(b - a, x.hi - x.lo));
        if (g) g.members.push(i); else groups.push({ lo: a, hi: b, members: [i] });
        const h = g ?? groups[groups.length - 1];
        h.lo = median(h.members.map(k => spans[k][0])); h.hi = median(h.members.map(k => spans[k][1]));
    }
    return groups.sort((x, y) => x.lo - y.lo);
}

/**
 * A region's look over its valid texels, leaving out `skip`'s: its mean colour (CIELAB) and the spread of its lightness (a
 * window's frame against its glass varies where plain stone stays even), as [L, a, b, sdL]; and its valid share.
 */
function regionLook(img: { rgba: ArrayLike<number>; width: number; height: number }, valid: Uint8Array, r: WindowRect, skip?: WindowRect[]): { lab?: number[]; validShare: number } {
    const W = img.width, m = [0, 0, 0];
    let n = 0, all = 0, l2 = 0;
    for (let y = Math.max(0, r[1]); y < Math.min(img.height, r[3]); y++) for (let x = Math.max(0, r[0]); x < Math.min(W, r[2]); x++) {
        if (skip?.some(q => x >= q[0] && x < q[2] && y >= q[1] && y < q[3])) continue;
        all++;
        const k = y * W + x;
        if (!valid[k]) continue;
        const l = labOf8(img.rgba[k * 4], img.rgba[k * 4 + 1], img.rgba[k * 4 + 2]);
        m[0] += l[0]; m[1] += l[1]; m[2] += l[2]; l2 += l[0] * l[0]; n++;
    }
    return { lab: n ? [...m.map(v => v / n), Math.sqrt(Math.max(0, l2 / n - (m[0] / n) ** 2))] : undefined, validShare: all ? n / all : 0 };
}

/**
 * The panes that read as glass: each pane against the wall just beside its window (left and right of the window, over the
 * pane's rows, outside every window; else the band's wall outside every window), kept only when its mean colour lies at
 * least glassDeltaE (CIELAB) from that wall's. A "pane" the colour of the stone around it (a carved panel, a pier the fit
 * reached across, a smear) is dropped: no glass is better than glass on stone.
 */
export function panesUnlikeWall(img: { rgba: ArrayLike<number>; width: number; height: number }, valid: Uint8Array, panes: WindowRect[], windows: WindowRect[], band: Band, P: WindowFitParams = WINDOW_FIT_PARAMS): { panes: WindowRect[]; dropped: number } {
    if (!panes.length) return { panes, dropped: 0 };
    const bandWall = regionLook(img, valid, [band[0], band[2], band[1], band[3]], windows).lab;
    const keep: WindowRect[] = [];
    for (const p of panes) {
        const w = windows.find(q => p[0] >= q[0] - 1 && p[2] <= q[2] + 1 && p[1] >= q[1] - 1 && p[3] <= q[3] + 1) ?? p;
        const sw = Math.max(2, Math.round((w[2] - w[0]) * 0.3));
        const sides = [regionLook(img, valid, [w[0] - sw, p[1], w[0], p[3]], windows), regionLook(img, valid, [w[2], p[1], w[2] + sw, p[3]], windows)].filter(x => x.lab && x.validShare > 0.3).map(x => x.lab!);
        const wall = sides.length ? [0, 1, 2].map(j => sides.reduce((t, l) => t + l[j], 0) / sides.length) : bandWall;
        const look = regionLook(img, valid, p).lab;
        if (!look || !wall) continue;
        if (Math.hypot(look[0] - wall[0], look[1] - wall[1], look[2] - wall[2]) >= P.glassDeltaE) keep.push(p);
    }
    return { panes: keep, dropped: panes.length - keep.length };
}

/**
 * A narrow face's windows from its storey rhythm (WINDOW_FIT_PARAMS.narrow): the band's column darkness split at its midpoint,
 * the longest dark run across the width the window column; its rows folded at the storey pitch (phase from the band's top),
 * the fold's longest dark run round the storey the window; each storey kept where its rows correlate with the fold.
 * Undefined when the column, the fold or the storeys do not read clearly. Photo-inferred.
 */
export function storeyColumn(c: Ctx, band: Band, tPitchM: number): { rects: WindowRect[]; storeys: number } | undefined {
    const { dk, P, f } = c, N = P.narrow, [x0, x1, y0, y1] = band, pitch = tPitchM / f.pixel;
    if (!(pitch >= 6) || (y1 - y0) < N.minStoreys * pitch) return undefined;
    // the column: the longest run of columns darker than the profile's midpoint
    const col = dk.colMeans(x0, x1, y0, y1), cf = finite(col);
    if (cf.length < 3) return undefined;
    const cLo = Math.min(...cf), cHi = Math.max(...cf);
    if (cHi - cLo < N.minContrast) return undefined;
    let best: [number, number] = [0, 0];
    for (let i = 0; i < col.length;) {
        if (!(col[i] > (cLo + cHi) / 2)) { i++; continue; }
        let j = i; while (j < col.length && col[j] > (cLo + cHi) / 2) j++;
        if (j - i > best[1] - best[0]) best = [i, j];
        i = j;
    }
    if (best[1] - best[0] < N.minColumnShare * (x1 - x0)) return undefined;
    const ca = x0 + best[0], cb = x0 + best[1];
    // the storey: the column's rows folded at the storey pitch
    const rows = dk.rowMeans(ca, cb, y0, y1), nb = Math.max(6, Math.round(pitch));
    const sum = new Float64Array(nb), cnt = new Float64Array(nb);
    for (let i = 0; i < rows.length; i++) { if (!Number.isFinite(rows[i])) continue; const b = Math.min(nb - 1, Math.floor(((i % pitch) / pitch) * nb)); sum[b] += rows[i]; cnt[b]++; }
    if (cnt.some(v => !v)) return undefined;
    const fold = Array.from(sum, (v, i) => v / cnt[i]), fLo = Math.min(...fold), fHi = Math.max(...fold);
    if (fHi - fLo < N.minContrast) return undefined;
    const darkBin = fold.map(v => v > (fLo + fHi) / 2);
    let run: [number, number] = [0, 0];
    for (let i = 0; i < nb; i++) {
        if (!darkBin[i] || darkBin[(i - 1 + nb) % nb]) continue;
        let n = 0; while (n < nb && darkBin[(i + n) % nb]) n++;
        if (n > run[1]) run = [i, n];
    }
    const share = run[1] / nb;
    if (!run[1] || share < N.runShare[0] || share > N.runShare[1]) return undefined;
    // each storey: kept where its rows correlate with the fold
    const out: WindowRect[] = [];
    let storeys = 0;
    for (let k = 0; y0 + k * pitch < y1; k++) {
        const s0 = Math.round(k * pitch), s1 = Math.min(rows.length, Math.round((k + 1) * pitch));
        if (s1 - s0 < 0.9 * pitch) continue;
        storeys++;
        const seg = Array.from({ length: s1 - s0 }, (_, i) => rows[s0 + i]), ref = seg.map((_, i) => fold[Math.min(nb - 1, Math.floor(((i % pitch) / pitch) * nb))]);
        if (seg.some(v => !Number.isFinite(v)) || ncc(seg, ref) < N.minStoreyNcc) continue;
        const ya = Math.round(y0 + k * pitch + (run[0] / nb) * pitch), yb = Math.min(y1, Math.round(y0 + k * pitch + ((run[0] + run[1]) / nb) * pitch));
        if (yb - ya >= 2) out.push([ca, ya, cb, yb]);
    }
    return out.length >= N.minStoreys ? { rects: out, storeys } : undefined;
}

/**
 * An accepted band's window lattice completed from the facade's repeats (WINDOW_FIT_PARAMS.complete): the columns and rows
 * of `grid` (every accepted band's windows, so a column runs on across the bands' edges) are the lattice; a site of this
 * band with no window, flanked on one axis (windows on both sides of it, on an axis with at least minAxis of them) and with
 * a window beside it on the other, becomes a window unless its colour is nearer the wall beside it than its column's and
 * row's windows (the photo shows stone there). Where the photo never reached (its hole filled from the facade's own repeats,
 * generated), a site flanked on both axes continues the grid as a window, generated like the texture under it. A window
 * that reads lighter than its piers (glass mirroring the sky) or dark at random (blinds, an open sash) still sits on the
 * grid. Photo-inferred.
 */
export function completeLattice(img: { rgba: ArrayLike<number>; width: number; height: number }, valid: Uint8Array, rects: WindowRect[], band: Band, P: WindowFitParams = WINDOW_FIT_PARAMS, grid: WindowRect[] = rects): { rects: WindowRect[]; added: number; stone: number; generated: WindowRect[] } {
    const C = P.complete;
    if (grid.length < 4) return { rects, added: 0, stone: 0, generated: [] };
    const cols = spanGroups(grid.map(r => [r[0], r[2]]), C.overlap), rows = spanGroups(grid.map(r => [r[1], r[3]]), C.overlap);
    if (cols.length < C.minAxis && rows.length < C.minAxis) return { rects, added: 0, stone: 0, generated: [] };
    const colOf = new Int32Array(grid.length), rowOf = new Int32Array(grid.length);
    cols.forEach((g, ci) => g.members.forEach(k => { colOf[k] = ci; }));
    rows.forEach((g, ri) => g.members.forEach(k => { rowOf[k] = ri; }));
    const has = new Uint8Array(cols.length * rows.length);
    grid.forEach((_, k) => { has[rowOf[k] * cols.length + colOf[k]] = 1; });
    const meanLab = (r: WindowRect, skip?: WindowRect[]) => regionLook(img, valid, r, skip);
    const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2], p[3] - q[3]);
    // each grid window's colour, for the windows of a site's column and row
    // the wall just beside a region (left and right of it, outside every window), and each grid window's look
    const wallBeside = (r: WindowRect) => {
        const sw = Math.max(2, Math.round((r[2] - r[0]) * 0.4));
        const walls = [meanLab([r[0] - sw, r[1], r[0], r[3]], grid).lab, meanLab([r[2], r[1], r[2] + sw, r[3]], grid).lab].filter((v): v is number[] => !!v);
        return walls.length ? [0, 1, 2, 3].map(j => walls.reduce((t, l) => t + l[j], 0) / walls.length) : undefined;
    };
    const winLab = grid.map(r => meanLab(r).lab);
    const out = [...rects];
    let added = 0, stone = 0;
    const generated: WindowRect[] = [];
    for (let ri = 0; ri < rows.length; ri++) for (let ci = 0; ci < cols.length; ci++) {
        if (has[ri * cols.length + ci]) continue;
        const r: WindowRect = [Math.round(cols[ci].lo), Math.round(rows[ri].lo), Math.round(cols[ci].hi), Math.round(rows[ri].hi)];
        // only this band's sites, and only where no window already stands (a strip's column and the window columns inside it
        // are groups of their own)
        const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
        if (cx < band[0] || cx >= band[1] || cy < band[2] || cy >= band[3]) continue;
        const area = (r[2] - r[0]) * (r[3] - r[1]);
        const covered = (q: WindowRect) => Math.max(0, Math.min(q[2], r[2]) - Math.max(q[0], r[0])) * Math.max(0, Math.min(q[3], r[3]) - Math.max(q[1], r[1]));
        if (!(area > 0) || grid.some(q => covered(q) > C.clearShare * area) || out.some(q => covered(q) > C.clearShare * area)) continue;
        let left = false, right = false, above = false, below = false;
        for (let c2 = 0; c2 < cols.length; c2++) if (has[ri * cols.length + c2]) { if (c2 < ci) left = true; else right = true; }
        for (let r2 = 0; r2 < rows.length; r2++) if (has[r2 * cols.length + ci]) { if (r2 < ri) above = true; else below = true; }
        // flanked on one axis (on an axis with enough of them), and a window beside it on the other
        const flankedRow = cols.length >= C.minAxis && left && right, flankedCol = rows.length >= C.minAxis && above && below;
        if (!((flankedRow && (above || below || rows.length < C.minAxis)) || (flankedCol && (left || right || cols.length < C.minAxis)))) continue;
        // the site against its column's and row's windows and the wall just beside it (left and right, outside every window):
        // a window when it reads nearer the windows, stone when nearer the wall
        const site = meanLab(r);
        // where the photo never reached (its hole filled from the facade's own repeats, generated), the grid continues
        // there when the site is flanked on both axes: a window, generated like the texture under it
        if (!site.lab || site.validShare < C.minValid) {
            if (left && right && above && below) { out.push(r); generated.push(r); added++; }
            continue;
        }
        const peers = grid.map((_, k) => k).filter(k => (colOf[k] === ci || rowOf[k] === ri) && winLab[k]).map(k => winLab[k]!);
        if (!peers.length) continue;
        const peer = [0, 1, 2, 3].map(j => peers.reduce((t, l) => t + l[j], 0) / peers.length);
        const wall = wallBeside(r);
        if (wall && dist(site.lab, wall) <= dist(site.lab, peer)) { stone++; continue; }
        out.push(r); added++;
    }
    return { rects: out.sort(cmpRect), added, stone, generated };
}

/** The fold's two colours (2-means from its darkest and lightest bins) and the glass side: the bluer, the lighter on a tie. */
function glassSplit(fold: number[][], P: WindowFitParams): { side: number[]; glass: number[]; other: number[] } | undefined {
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let A = fold.reduce((m, c) => (lum(c) < lum(m) ? c : m)), B = fold.reduce((m, c) => (lum(c) > lum(m) ? c : m));
    let side = fold.map(() => 0);
    for (let it = 0; it < 10; it++) {
        side = fold.map(c => (Math.hypot(c[0] - A[0], c[1] - A[1], c[2] - A[2]) <= Math.hypot(c[0] - B[0], c[1] - B[1], c[2] - B[2]) ? 0 : 1));
        const mean = (sd: number) => { const m = [0, 0, 0]; let n = 0; fold.forEach((c, i) => { if (side[i] === sd) { for (let k = 0; k < 3; k++) m[k] += c[k]; n++; } }); return n ? m.map(v => v / n) : undefined; };
        const a = mean(0), b = mean(1);
        if (!a || !b) return undefined;
        A = a; B = b;
    }
    if (Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) < P.paneContrast) return undefined;
    const blue = (c: number[]) => c[2] / Math.max(1, c[0] + c[1] + c[2]);
    const g = Math.abs(blue(A) - blue(B)) > 0.01 ? (blue(A) > blue(B) ? 0 : 1) : lum(A) > lum(B) ? 0 : 1;
    return { side: side.map(v => (v === g ? 1 : 0)), glass: g === 0 ? A : B, other: g === 0 ? B : A };
}

/**
 * A band's strips' panes from their folded unit cell: the strips of one width (within 15%) folded together, up the wall at
 * the storey pitch (phase from the band's top, so every bay's storeys line up) and across at their width (each column a
 * share of its strip). The glass rows: the fold's rows split in two by colour (glassSplit), the one run of glass round the
 * storey (two or more runs, glass and a panel of a like colour, cannot be told apart: that group gets no panes). Across those rows the glass columns: the bins nearer the glass colour than the other, in runs (a mullion or a
 * jamb between them is frame). Every strip of the group takes those panes, storey by storey; a group the fold cannot read
 * leaves its strips undefined. Photo-inferred.
 */
export function panesOfUnitCell(img: { rgba: ArrayLike<number>; width: number; height: number }, valid: Uint8Array, strips: WindowRect[], band: Band, pitchPx: number, P: WindowFitParams = WINDOW_FIT_PARAMS): { perStrip: Array<WindowRect[] | undefined>; groups: number } {
    const perStrip: Array<WindowRect[] | undefined> = strips.map(() => undefined);
    if (!(pitchPx >= 6)) return { perStrip, groups: 0 };
    const W = img.width, nT = Math.max(6, Math.round(pitchPx)), y0 = band[2];
    // strips of one width
    const groups: number[][] = [];
    strips.map((r, i) => i).sort((a, b) => (strips[a][2] - strips[a][0]) - (strips[b][2] - strips[b][0])).forEach(i => {
        const w = strips[i][2] - strips[i][0], g = groups.find(x => Math.abs(w / (strips[x[0]][2] - strips[x[0]][0]) - 1) <= 0.15);
        if (g) g.push(i); else groups.push([i]);
    });
    let read = 0;
    for (const g of groups) {
        const nS = Math.min(64, Math.max(6, Math.round(median(g.map(i => strips[i][2] - strips[i][0])))));
        const sum = Array.from({ length: nT * nS }, () => [0, 0, 0, 0]);
        for (const i of g) {
            const [xa, ya, xb, yb] = strips[i];
            if (yb - ya < 1.6 * pitchPx || xb - xa < 3) continue;
            for (let y = ya; y < yb; y++) {
                const bt = Math.min(nT - 1, Math.floor(((((y - y0) % pitchPx) + pitchPx) % pitchPx) / pitchPx * nT));
                for (let x = xa; x < xb; x++) {
                    const k = y * W + x;
                    if (!valid[k]) continue;
                    const bs = Math.min(nS - 1, Math.floor(((x - xa) / (xb - xa)) * nS)), cell = sum[bt * nS + bs];
                    for (let c = 0; c < 3; c++) cell[c] += img.rgba[k * 4 + c];
                    cell[3]++;
                }
            }
        }
        // the rows over the middle 60% of the width
        const rowsFold: number[][] = [];
        for (let t = 0; t < nT; t++) {
            const m = [0, 0, 0, 0];
            for (let b = Math.floor(nS * 0.2); b < Math.ceil(nS * 0.8); b++) for (let c = 0; c < 4; c++) m[c] += sum[t * nS + b][c];
            if (!m[3]) break;
            rowsFold.push([m[0] / m[3], m[1] / m[3], m[2] / m[3]]);
        }
        if (rowsFold.length < nT) continue;
        const split = glassSplit(rowsFold, P);
        if (!split) continue;
        const share = split.side.reduce((a, b) => a + b, 0) / nT;
        if (share < P.paneShare[0] || share > P.paneShare[1]) continue;
        // the glass run round the storey; two or more (glass and a panel of a like colour) cannot be told apart: no panes
        let best: [number, number] = [0, 0], runs = 0;
        for (let i = 0; i < nT; i++) {
            if (!split.side[i] || split.side[(i - 1 + nT) % nT]) continue;
            let n = 0; while (n < nT && split.side[(i + n) % nT]) n++;
            if (n >= 2) runs++;
            if (n > best[1]) best = [i, n];
        }
        if (!best[1] || runs > 1) continue;
        // across the glass rows: each bin nearer the glass colour than the other is glass
        const glassCols: Array<[number, number]> = [];
        let run = -1;
        for (let b = 0; b <= nS; b++) {
            let isGlass = false;
            if (b < nS) {
                const m = [0, 0, 0, 0];
                for (let t = 0; t < best[1]; t++) for (let c = 0; c < 4; c++) m[c] += sum[((best[0] + t) % nT) * nS + b][c];
                if (m[3]) { const col = [m[0] / m[3], m[1] / m[3], m[2] / m[3]], d = (q: number[]) => Math.hypot(col[0] - q[0], col[1] - q[1], col[2] - q[2]); isGlass = d(split.glass) <= d(split.other); }
            }
            if (isGlass && run < 0) run = b;
            if (!isGlass && run >= 0) { if (b - run >= 2) glassCols.push([run, b]); run = -1; }
        }
        if (!glassCols.length) continue;
        read++;
        for (const i of g) {
            const [xa, ya, xb, yb] = strips[i], out: WindowRect[] = [];
            const kFirst = Math.floor((ya - y0) / pitchPx) - 1;
            for (let k = kFirst; y0 + k * pitchPx < yb; k++) {
                const ty0 = Math.max(ya, Math.round(y0 + k * pitchPx + (best[0] / nT) * pitchPx)), ty1 = Math.min(yb, Math.round(y0 + k * pitchPx + ((best[0] + best[1]) / nT) * pitchPx));
                if (ty1 - ty0 < 2) continue;
                for (const [a, b] of glassCols) out.push([Math.round(xa + (a / nS) * (xb - xa)), ty0, Math.round(xa + (b / nS) * (xb - xa)), ty1]);
            }
            if (out.length) perStrip[i] = out;
        }
    }
    return { perStrip, groups: read };
}

// ------------------------------------------------------------------------------------------------ the fit

/** IoU of a rect set's mask (all inside `band`) against `ref`, counted where `where` holds within the band (`shift` rolls the set). */
function maskIou(rects: WindowRect[], band: Band, W: number, H: number, ref: Uint8Array, where: (k: number) => boolean, shift?: { axis: 0 | 1; by: number }): number {
    const [x0, x1, y0, y1] = band, bw = x1 - x0;
    const m = new Uint8Array(bw * (y1 - y0));
    for (const [xa, ya, xb, yb] of rects) for (let y = Math.max(y0, ya); y < Math.min(y1, yb); y++) m.fill(1, (y - y0) * bw + Math.max(0, xa - x0), (y - y0) * bw + Math.max(0, Math.min(x1, xb) - x0));
    const at = (x: number, y: number) => {
        if (shift) { if (shift.axis === 1) x = (((x - shift.by) % W) + W) % W; else y = (((y - shift.by) % H) + H) % H; }
        return x >= x0 && x < x1 && y >= y0 && y < y1 ? m[(y - y0) * bw + x - x0] : 0;
    };
    let i = 0, u = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const k = y * W + x;
        if (!where(k)) continue;
        const a = at(x, y), b = ref[k];
        if (a || b) u++;
        if (a && b) i++;
    }
    return u ? i / u : 0;
}

const usable = (g: ReliefGrid | undefined): g is ReliefGrid => !!g && g.periodS.found && g.periodT.found && g.cell.foundS && g.cell.foundT;

/** Fits one facade's windows from its straightened photo (rgba), its uncovered mask (1 = the photo did not reach) and frame. */
export async function fitFacadeWindows(img: { rgba: ArrayLike<number>; width: number; height: number }, uncovered: ArrayLike<number> | undefined, f: FitFrame, relief: ReliefRunner, P: WindowFitParams = WINDOW_FIT_PARAMS): Promise<WindowFit> {
    const W = img.width, H = img.height, px = f.pixel;
    const { dk, valid } = Darkness.of(img, uncovered, px);
    const c: Ctx = { f, dk, P };
    const dark = otsuMask(dk, valid);
    lateralEvidence(dk, valid, dark, px, P);
    // bands: change points of the darkness along the wall (columns as vectors of 1 m row sums), then up it within each
    const colMean = dk.colMeans(0, W, 0, H);
    const gps = autocorrPitch(colMean, px, P.pitchS[0], P.pitchS[1], P) || 6.0;
    const rb = Math.max(1, Math.trunc(1.0 / px)), nR = Math.ceil(H / rb);
    const z = (v: number) => (v === v ? v : 0);
    const colvec = Array.from({ length: W }, (_, x) => { const v = new Float64Array(nR); for (let y = 0; y < H; y++) v[Math.floor(y / rb)] += z(dk.at(x, y)) / rb; return v; });
    const bands: Band[] = [];
    for (const [a0, a1] of segments(smoothAlong(colvec, gps / px), Math.trunc(P.minBandSM / px), P.splitGain)) {
        const nC = Math.ceil((a1 - a0) / rb);
        const rowvec = Array.from({ length: H }, (_, y) => { const v = new Float64Array(nC); for (let x = a0; x < a1; x++) v[Math.floor((x - a0) / rb)] += z(dk.at(x, y)) / rb; return v; });
        for (const [b0, b1] of segments(smoothAlong(rowvec, 4.0 / px), Math.trunc(P.minBandTM / px), P.splitGain)) {
            let n = 0; for (let y = b0; y < b1; y++) for (let x = a0; x < a1; x++) n += valid[y * W + x];
            if (n / ((b1 - b0) * (a1 - a0)) >= 0.3) bands.push([a0, a1, b0, b1]);
        }
    }
    if (!bands.length) return { rects: [], panes: [], bands: [] };
    // the relief: the whole facade and each band, then the same with each held-out half hidden
    const span = Math.max(4, Math.trunc(P.heldOutSpanM / px));
    const foldSpecs: Array<{ name: string; hide: 's' | 't'; parity: number }> = [{ name: 'stripes-a', hide: 's', parity: 0 }, { name: 'stripes-b', hide: 's', parity: 1 }, { name: 'bands-a', hide: 't', parity: 0 }, { name: 'bands-b', hide: 't', parity: 1 }];
    const [all, ...foldRes] = await Promise.all([relief('-', span, 0, [[0, W, 0, H], ...bands]), ...foldSpecs.map(s => relief(s.hide, span, s.parity, [[0, W, 0, H], ...bands]))]);
    const whole = all[0], grids = all.slice(1);
    const hiddenOf = (s: { hide: 's' | 't'; parity: number }) => (k: number) => (s.hide === 's' ? Math.floor((k % W) / span) % 2 === s.parity : Math.floor(Math.floor(k / W) / span) % 2 === s.parity);
    const build = (kind: Kind, g: ReliefGrid, band: Band): WindowRect[] => {
        const ptPx = g.periodT.found ? pyRound(g.periodT.pitch / px) : 0;
        if (kind === 'pier-cells') return refineCells(c, pierCellsLayout(c, g, band), band);
        if (kind === 'pier-strips') return refineStrips(c, pierColumns(c, g, band).map(([a, b]) => [a, band[2], b, band[3]] as WindowRect), band, ptPx);
        if (kind.endsWith('cells')) return rephaseColumns(c, refineCells(c, cellsLayout(c, g, band, kind.startsWith('nested')), band), band);
        return refineStrips(c, rephaseColumns(c, stripsLayout(c, g, band, kind.startsWith('nested')), band), band, ptPx);
    };
    const rects: WindowRect[] = [], panes: WindowRect[] = [], report: WindowFitBand[] = [];
    const accepted: Array<{ band: Band; kind: Kind; chosen: WindowRect[]; g: ReliefGrid; info: WindowFitBand }> = [];
    const pending: typeof accepted = [], pool = { judged: 0, margin: 0 };
    const generatedRects: WindowRect[] = [];
    for (let bi = 0; bi < bands.length; bi++) {
        const band = bands[bi], own = grids[bi];
        const inBand = (k: number) => !!valid[k];
        const bestOf = (g: ReliefGrid | undefined) => {
            if (!usable(g)) return undefined;
            const cand = new Map(KINDS.map(k => [k, build(k, g, band)] as const));
            const sc = Object.fromEntries(KINDS.map(k => [k, maskIou(cand.get(k)!, band, W, H, dark, inBand)])) as Record<Kind, number>;
            let kind = KINDS[0]; for (const k of KINDS) if (sc[k] > sc[kind]) kind = k;
            return { kind, rects: cand.get(kind)!, sc };
        };
        const fw = bestOf(whole), bo = bestOf(own);
        let src: 'facade' | 'band' = fw ? 'facade' : 'band', pick = fw ?? bo, gi = bi;
        if (fw && bo && Math.max(...Object.values(bo.sc)) > P.clearlyBetter * Math.max(...Object.values(fw.sc))) { src = 'band'; pick = bo; }
        const info: WindowFitBand = { band, accepted: false };
        report.push(info);
        // neither the facade's grid nor the band's own reads: the grid of the nearest band of the facade that has one of its
        // own (a facade's bands share their bays), judged on this band's photo like any other
        if (!pick) {
            const mid = (band[2] + band[3]) / 2;
            const order = bands.map((b, j) => j).filter(j => j !== bi && usable(grids[j])).sort((a, b2) => Math.abs((bands[a][2] + bands[a][3]) / 2 - mid) - Math.abs((bands[b2][2] + bands[b2][3]) / 2 - mid));
            for (const j of order) { const bb = bestOf(grids[j]); if (bb) { pick = bb; src = 'band'; gi = j; info.borrowedFrom = j; break; } }
        }
        if (!pick) {
            // a face too narrow to repeat along the wall (one window column across): read from its storey rhythm alone
            const tPitch = own?.periodT.found ? own.periodT.pitch : whole?.periodT.found ? whole.periodT.pitch : 0;
            const col = (band[1] - band[0]) * px <= P.narrow.maxWidthM && tPitch > 0 ? storeyColumn(c, band, tPitch) : undefined;
            if (!col) { info.why = 'no grid'; continue; }
            Object.assign(info, { accepted: true, grid: 'column', kind: 'cells', storeys: `${col.rects.length}/${col.storeys}` });
            const gCol: ReliefGrid = { band, periodS: { found: false, pitch: 0 }, periodT: { found: true, pitch: tPitch }, cell: { foundS: false, foundT: true, runsS: [], runsT: [] } };
            accepted.push({ band, kind: 'cells', chosen: col.rects, g: gCol, info });
            continue;
        }
        let { rects: chosen } = pick;
        const { kind, sc } = pick;
        // a storey that does not repeat the band's storeys (a ground floor, a shopfront, signage) gets no openings
        let droppedRows = 0;
        if (kind.endsWith('cells') && chosen.length) {
            const rows = [...new Set(chosen.map(r => `${r[1]},${r[3]}`))].map(s => s.split(',').map(Number) as [number, number]);
            if (rows.length >= 3) {
                const prof = rows.map(rw => Array.from(dk.colMeans(band[0], band[1], rw[0], rw[1]), v => (Number.isFinite(v) ? v : 0)));
                const med = prof[0].map((_, i) => median(prof.map(p => p[i])));
                const keep = new Set(rows.filter((_, i) => ncc(prof[i], med) >= P.rowNcc).map(r => `${r[0]},${r[1]}`));
                droppedRows = rows.length - keep.size;
                chosen = chosen.filter(r => keep.has(`${r[1]},${r[3]}`));
            }
        }
        const g = src === 'facade' ? whole : grids[gi]!;
        Object.assign(info, { grid: src, kind, droppedRows, scores: Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) });
        // a band of one storey has nothing to repeat in up the wall
        if ((band[3] - band[2]) * px < P.storeysMin * g.periodT.pitch * 0.9) { info.why = 'one storey: no lattice to repeat'; continue; }
        // the gate: the reading on each fold beats itself shifted half a pitch on the fold's hidden part, summed over the folds
        let wins = 0, judged = 0, margin = 0;
        let bandValid = 0; for (let y = band[2]; y < band[3]; y++) for (let x = band[0]; x < band[1]; x++) bandValid += valid[y * W + x];
        for (let fi = 0; fi < foldSpecs.length; fi++) {
            const spec = foldSpecs[fi], g2 = src === 'facade' ? foldRes[fi][0] : foldRes[fi][1 + gi];
            if (!usable(g2)) continue;
            const hid = hiddenOf(spec), where = (k: number) => !!valid[k] && hid(k);
            let hv = 0; for (let y = band[2]; y < band[3]; y++) for (let x = band[0]; x < band[1]; x++) if (where(y * W + x)) hv++;
            if (hv < 0.2 * bandValid) continue;
            const pred = build(kind, g2, band);
            const by = spec.hide === 's' ? pyRound(g2.periodS.pitch / px / 2) : pyRound(g2.periodT.pitch / px / 2);
            const ip = maskIou(pred, band, W, H, dark, where), ic = maskIou(pred, band, W, H, dark, where, { axis: spec.hide === 's' ? 1 : 0, by });
            judged++; if (ip > ic) wins++; margin += ip - ic;
        }
        info.heldOut = `${wins}/${judged}`; info.margin = Math.round(margin * 1000) / 1000;
        const scored = Math.max(...Object.values(sc)) > P.minScore;
        if (src === 'facade') { pool.judged += judged; pool.margin += margin; }
        info.accepted = scored && judged >= 2 && margin > 0;
        if (kind.endsWith('strips')) { const s = splitBays(c, chosen); chosen = s.rects; info.subPitch = `${s.found}/${s.bays}`; }
        if (!info.accepted) {
            info.why = 'held-out folds';
            // a band too small to be judged on two folds waits for the facade's bands pooled
            if (scored && src === 'facade' && judged >= 1 && judged < 2 && margin > 0) pending.push({ band, kind, chosen, g, info });
            continue;
        }
        accepted.push({ band, kind, chosen, g, info });
    }
    // the bands too small to be judged alone: accepted when the facade's bands read on its grid pass together
    if (pool.judged >= 2 && pool.margin > 0) for (const p of pending) { p.info.accepted = true; delete p.info.why; p.info.heldOut += ` (pooled ${pool.judged} folds, margin ${Math.round(pool.margin * 1000) / 1000})`; accepted.push(p); }
    // the lattice completed from the facade's repeats (every accepted band's windows the grid): a site inside it is a window
    // unless the photo shows stone
    const grid = accepted.flatMap(a => a.chosen);
    for (const { band, kind, g, info, chosen: own } of accepted) {
        const done = completeLattice(img, valid, own, band, P, grid);
        const chosen = done.rects;
        info.completed = done.added; info.stone = done.stone;
        if (done.generated.length) { info.generated = done.generated.length; generatedRects.push(...done.generated); }
        rects.push(...chosen);
        // the glass in them: a punched window is its own pane; a band's strips (window over spandrel, storey on storey) take
        // their panes from their folded unit cell, a strip the fold could not read from its own colours
        // the glass in them, kept only where it reads unlike the stone beside it (no glass is better than glass on stone): a
        // punched window is its own pane; a band's strips (window over spandrel, storey on storey) take their panes from
        // their folded unit cell, a strip it cannot read none (its colours alone drew panes across the mullions)
        let cand: WindowRect[] = [];
        if (!kind.endsWith('strips')) cand = chosen;
        else {
            const pitchPx = g.periodT.found ? g.periodT.pitch / px : 0;
            const unit = panesOfUnitCell(img, valid, chosen, band, pitchPx, P);
            cand = unit.perStrip.flatMap(ps => ps ?? []);
            info.panes = `${unit.perStrip.filter(Boolean).length}/${chosen.length} strips (${unit.groups} unit cells)`;
        }
        const glass = panesUnlikeWall(img, valid, cand, [...grid, ...chosen], band, P);
        panes.push(...glass.panes);
        info.panesDropped = glass.dropped;
    }
    return { rects: joinAcrossBands(rects, bands), panes, bands: report, ...(generatedRects.length ? { generated: generatedRects } : {}) };
}

/** A window cut by a band's edge (the bands' change points fall where they fall) joined again: two windows meeting at a band edge, on the same columns. */
export function joinAcrossBands(rects: WindowRect[], bands: Array<[number, number, number, number]>): WindowRect[] {
    const edges = new Set(bands.flatMap(b => [b[2], b[3]]));
    const out = rects.map(r => [...r] as WindowRect).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (let i = 0; i < out.length; i++) {
        const a = out[i];
        if (!a) continue;
        for (let j = 0; j < out.length; j++) {
            const b = out[j];
            if (!b || j === i || b[1] !== a[3] || !edges.has(a[3]) || Math.abs(a[0] - b[0]) > 2 || Math.abs(a[2] - b[2]) > 2) continue;
            out[i] = [Math.min(a[0], b[0]), a[1], Math.max(a[2], b[2]), b[3]];
            out[j] = undefined as unknown as WindowRect;
            i--; break;
        }
    }
    return out.filter(Boolean);
}

// ------------------------------------------------------------------------------------------------ the native relief, and the orthos

const CLI_SOURCE = path.join('scripts', 'relief_band.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'relief_band');
let building: Promise<string> | undefined;

export function ensureReliefBandBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_RELIEF_BAND_BIN) return Promise.resolve(process.env.SCRATCHBOX_RELIEF_BAND_BIN);
    building ??= (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: ['-lz'], name: 'relief_band', timeoutMs: 600_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new Error(`could not build relief_band: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** The relief read by the native driver on one photo. */
export function nativeRelief(bin: string, png: string, mask: string | undefined, f: FitFrame, signal?: AbortSignal): ReliefRunner {
    return (hide, span, parity, bands) => new Promise((resolve, reject) => {
        const args = [png, mask ?? '-', String(f.pixel), String(f.orthoSMin), String(f.orthoTMax), String(f.texel), hide, String(span), String(parity), ...bands.flatMap(b => b.map(String))];
        execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 600_000, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`relief_band failed on ${path.basename(png)}: ${stderr || err.message}`));
            try { resolve(stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as ReliefGrid)); } catch (e) { reject(e); }
        });
    });
}

/** window_fit.json beside the orthos: per facade its windows in photo pixels and UVs, and its bands' decisions. */
export interface WindowFitFile {
    version: string; params: WindowFitParams; ms: number;
    facades: Array<{ facadeId: number; width: number; height: number; rects: WindowRect[]; panes?: WindowRect[]; /** Windows continued into parts the photo never reached: generated. */ generated?: WindowRect[]; bands: WindowFitBand[]; ms: number } | { facadeId: number; error: string }>;
}
export const WINDOW_FIT_FILE = 'window_fit.json';

/**
 * Fits the windows of every facade plane in an orthos directory (relief_orthos/facades.json), whatever its photo's
 * coverage (the fit reads only covered texels: a plane the rebuild leaves as scan still has its windows drawn on the scan),
 * several at a time; writes window_fit.json. A plane with no uncovered mask beside it (one pipeline K did not straighten)
 * has it read from its ortho: the texels the photo never reached are exact grey 128 or transparent.
 */
export async function fitWindowsForOrthos(orthosDir: string, opts: { concurrency?: number; signal?: AbortSignal; params?: WindowFitParams } = {}): Promise<{ file: string; fit: WindowFitFile; cached: boolean }> {
    const file = path.join(orthosDir, WINDOW_FIT_FILE), P = opts.params ?? WINDOW_FIT_PARAMS;
    if (fs.existsSync(file)) {
        const prior = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowFitFile;
        if (prior.version === WINDOW_FIT_VERSION && JSON.stringify(prior.params) === JSON.stringify(P)) return { file, fit: prior, cached: true };
    }
    const t0 = Date.now();
    const bin = await ensureReliefBandBinary();
    const facades = (JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as Array<FitFrame & { facadeId: number; image: string; coverage: number; wallCoverage?: number; wallAreaM2?: number; uncoveredMask?: string }>)
        .filter(f => fs.existsSync(path.join(orthosDir, f.image)));
    const out: WindowFitFile['facades'] = [];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'window-fit-'));
    let next = 0;
    const worker = async () => {
        for (;;) {
            const f = facades[next++];
            if (!f) return;
            if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
            const t = Date.now(), png = path.join(orthosDir, f.image);
            let maskFile = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
            try {
                const img = decodePng(fs.readFileSync(png));
                let mask: Uint8Array;
                if (maskFile && fs.existsSync(maskFile)) { const m = decodePng(fs.readFileSync(maskFile)); mask = Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] >= 128 ? 1 : 0)); }
                else {
                    mask = Uint8Array.from({ length: img.width * img.height }, (_, k) => (img.rgba[k * 4 + 3] === 0 || (img.rgba[k * 4] === 128 && img.rgba[k * 4 + 1] === 128 && img.rgba[k * 4 + 2] === 128) ? 1 : 0));
                    maskFile = path.join(scratch, `${f.facadeId}_uncovered.png`);
                    fs.writeFileSync(maskFile, encodePng(img.width, img.height, Buffer.from(mask.map(v => (v ? 255 : 0))), 1));
                }
                const fit = await fitFacadeWindows({ rgba: img.rgba, width: img.width, height: img.height }, mask, f, nativeRelief(bin, png, maskFile, f, opts.signal), P);
                out.push({ facadeId: f.facadeId, width: img.width, height: img.height, rects: fit.rects, panes: fit.panes, ...(fit.generated ? { generated: fit.generated } : {}), bands: fit.bands, ms: Date.now() - t });
            } catch (err) {
                if (opts.signal?.aborted) throw err;
                out.push({ facadeId: f.facadeId, error: err instanceof Error ? err.message : String(err) });
            }
        }
    };
    try { await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? Math.max(1, Math.min(8, os.cpus().length - 1))) }, worker)); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    out.sort((a, b) => a.facadeId - b.facadeId);
    const fit: WindowFitFile = { version: WINDOW_FIT_VERSION, params: P, ms: Date.now() - t0, facades: out };
    fs.writeFileSync(file, JSON.stringify(fit));
    return { file, fit, cached: false };
}

function fittedEntry(fit: WindowFitFile, facadeId: number) {
    const e = fit.facades.find(x => x.facadeId === facadeId);
    return !e || 'error' in e || !e.rects.length ? undefined : e;
}

/** A facade's windows the lattice completion continued into parts its photo never reached (generated), in the photo's UVs, u0 v0 u1 v1 each. */
export function fittedGeneratedUvs(fit: WindowFitFile, facadeId: number): number[] | undefined {
    const e = fittedEntry(fit, facadeId);
    if (!e || !e.generated?.length) return undefined;
    return e.generated.flatMap(([x0, y0, x1, y1]) => [x0 / e.width, y0 / e.height, x1 / e.width, y1 / e.height]);
}

/** A facade's panes (the glass in its fitted windows) in the photo's UVs, u0 v0 u1 v1 each; none when the fit gave no windows or no panes. */
export function fittedPaneUvs(fit: WindowFitFile, facadeId: number): number[] | undefined {
    const e = fittedEntry(fit, facadeId);
    if (!e || !e.panes?.length) return undefined;
    return e.panes.flatMap(([x0, y0, x1, y1]) => [x0 / e.width, y0 / e.height, x1 / e.width, y1 / e.height]);
}

/** A facade's fitted windows from window_fit.json in photo pixels, or none (as fittedWindowUvs). */
export function fittedWindowRects(fit: WindowFitFile, facadeId: number): WindowRect[] | undefined {
    return fittedEntry(fit, facadeId)?.rects;
}

/**
 * A facade's fitted windows from window_fit.json, in the photo's UVs (u along s, v down from the top): u0 v0 u1 v1 per window.
 * None when the fit placed none: a facade too narrow for the relief to read two bays (most of the ESB's tower returns) shows
 * no grid, which says nothing about its windows, so its other evidence (its wall face's bay rhythm) decides instead.
 */
export function fittedWindowUvs(fit: WindowFitFile, facadeId: number): number[] | undefined {
    const e = fittedEntry(fit, facadeId);
    if (!e) return undefined;
    return e.rects.flatMap(([x0, y0, x1, y1]) => [x0 / e.width, y0 / e.height, x1 / e.width, y1 / e.height]);
}

/** A facade plane's fitted windows in its ortho's frame (relief_orthos/facades.json): world = centroid + s axisS + t axisT, pixel x at s = orthoSMin + x pixel, y at t = orthoTMax - y pixel. */
export interface FittedPlane {
    facadeId: number; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[];
    orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number;
    /** The fitted windows and their panes, photo-pixel rects [x0, y0, x1, y1]. */
    windows: WindowRect[]; panes: WindowRect[];
    /** The plane's bays read per wall (wall-grammar.ts), photo-pixel rects, when the wall grammar read it. */
    bays?: WindowRect[];
}

/** Every plane with fitted windows or wall-grammar bays in an orthos directory (facades.json and window_fit.json beside it, wall_grammar.json when read); none when either of the first two is missing. */
export function fittedPlanesOf(orthosDir: string): FittedPlane[] {
    const ff = path.join(orthosDir, 'facades.json'), wf = path.join(orthosDir, WINDOW_FIT_FILE);
    if (!fs.existsSync(ff) || !fs.existsSync(wf)) return [];
    const frames = JSON.parse(fs.readFileSync(ff, 'utf8')).facades as Array<Omit<FittedPlane, 'windows' | 'panes'>>;
    const fit = JSON.parse(fs.readFileSync(wf, 'utf8')) as WindowFitFile;
    const gf = path.join(orthosDir, 'wall_grammar.json');
    const grammar = fs.existsSync(gf) ? JSON.parse(fs.readFileSync(gf, 'utf8')) as { facades: Record<string, Array<[number, number, number, number, number]>> } : undefined;
    return frames.flatMap(f => {
        const e = fittedEntry(fit, f.facadeId), gb = grammar?.facades[String(f.facadeId)];
        if (e && (e.width !== f.width || e.height !== f.height)) return [];
        if (!e && !gb?.length) return [];
        const bays = gb?.map(([s0, t0, s1, t1]) => [(s0 - f.orthoSMin) / f.pixel, (f.orthoTMax - t1) / f.pixel, (s1 - f.orthoSMin) / f.pixel, (f.orthoTMax - t0) / f.pixel] as WindowRect);
        return [{ facadeId: f.facadeId, centroid: f.centroid, normal: f.normal, axisS: f.axisS, axisT: f.axisT, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax, pixel: f.pixel, width: f.width, height: f.height, windows: e?.rects ?? [], panes: e?.panes ?? [], ...(bays ? { bays } : {}) }];
    });
}
