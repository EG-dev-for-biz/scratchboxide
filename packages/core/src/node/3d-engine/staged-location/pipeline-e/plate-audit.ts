/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, enhanced mode: the invention and erasure check of a redrawn wall plate, framed by identity.
 *
 * The alignment gate (enhance.ts) only asks whether the input's edges are still where they were. A plate can pass it and
 * still paint a distinct element over (a dark fire-escape bay turned into wall and windows), replace one (a stone base or a
 * storefront redrawn as something else) or change a block's colour. Under the realism-first directive finer detail drawn
 * over ordinary wall is the point of the redraw and stays; what the check reverts is a region that erases, replaces or
 * recolours what makes the wall recognisable. It compares the plate with its input region by region, with nothing known
 * about what the regions are:
 *
 *   - tone: both images low-passed (about TONE_BLUR_M) in CIELAB, the plate first mapped onto the input's colour with one
 *     robust affine map per channel (a global relight is no change of identity); per cell (AUDIT_CELL_M) the mean colour
 *     distance, lightness weighted down (an even relight takes baked sun and shade off; repainting moves chroma);
 *   - structure: the band-pass of the lightness (BAND_FINE_M .. BAND_COARSE_M, the scale of openings, piers and bays) in a
 *     window of 3 x 3 cells round each cell: its contrast in each image and their normalised cross-correlation;
 *   - distinctness: how far the input's cell stands from the wall's median colour, or how strong its structure is;
 *   - per cell: the plate's unsupported structure where the input is distinct is "replaced", flattened distinct structure
 *     "erased", a changed colour "retoned"; unsupported structure over ordinary wall is "invented-detail" and kept;
 *   - the flagged cells are grouped into 8-connected regions, and only regions of at least MIN_REGION_M2 count.
 *
 * A flagged region goes back to the input's texels, blended over FEATHER_M (revertRegions); the rest of the plate stays.
 * When the flagged regions cover more than MAX_FLAGGED_SHARE of the wall's covered texels the whole wall is rejected. The
 * street-level Street View photo (plate-streetview.ts) is the identity anchor for the lower storeys: what it shows the
 * plate drawing is kept even when the tile flagged it, and what contradicts it is reverted.
 */

import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearToLab } from '../texel-exposure';
import { maskedBlur } from './image-ops';

/** Side of an audit cell, metres. */
export const AUDIT_CELL_M = 0.5;
/** Low-pass radius of the tone comparison, metres. */
export const TONE_BLUR_M = 0.4;
/** The structure band: lightness blurred at BAND_FINE_M minus blurred at BAND_COARSE_M (radii, metres). */
export const BAND_FINE_M = 0.08;
export const BAND_COARSE_M = 0.8;
/** A cell's tone is changed when its mean CIELAB distance (after the global colour map) exceeds this. */
export const MAX_TONE_DE = 14;
/**
 * Weight of lightness in that distance (chroma counts in full). A redraw lit evenly takes baked sun and shade off the scan's
 * photo, which moves lightness locally; painting a surface over moves its chroma too.
 */
export const LIGHTNESS_WEIGHT = 0.6;
/** Band contrast (standard deviation of the band, L* units) a window needs before its structure counts. */
export const MIN_CONTRAST_L = 4;
/** Structure the plate shows with less correlation than this with the input is unsupported. */
export const MIN_SUPPORT_NCC = 0.2;
/** The plate keeps less than this share of the input's band contrast: the input's structure was erased. */
export const ERASE_CONTRAST_RATIO = 0.4;
/** Blur radius of the input's colour when telling a distinct element from ordinary wall, metres. */
export const DISTINCT_BLUR_M = 1;
/** A cell whose input colour stands this far (CIELAB, lightness weighted) from the wall's median is a distinct element. */
export const DISTINCT_DE = 15;
/** ... or whose input band contrast is at least this (openings, signage, a fire escape's bars). */
export const DISTINCT_CONTRAST_L = 9;
/**
 * A cell within this many cells of a distinct one counts as distinct too: an element is rarely distinct in every cell (a
 * fire-escape bay the scan saw through gaps, with the occluder fill between), and redrawing round its pieces still erases it.
 */
export const DISTINCT_REACH_CELLS = 2;
/** Smallest flagged region that counts, square metres. */
export const MIN_REGION_M2 = 3;
/** Blend width of a reverted region's edge, metres. */
export const FEATHER_M = 0.5;
/** More of the wall's covered area flagged than this, and the whole wall keeps its input. */
export const MAX_FLAGGED_SHARE = 0.35;

/** Open labels: diagnostic only, never branched on. */
export type FlagKind = 'replaced' | 'erased' | 'retoned' | 'contradicts-photo' | 'invented-detail' | (string & {});

export interface FlaggedRegion {
    kind: FlagKind;
    cells: number;
    areaM2: number;
    /** Pixel box in the wall's texture [x0, y0, x1, y1). */
    box: [number, number, number, number];
    /** Mean tone distance and structure correlation over the region's cells (NaN where not measured). */
    meanToneDe: number;
    meanNcc: number;
}

export interface CellGrid {
    cw: number; ch: number; cellPx: number;
    /** Per cell: share of covered texels. */
    cover: Float32Array;
}

export interface CellFeatures extends CellGrid {
    toneDe: Float32Array;
    /** Per cell: how far the input's low-passed colour stands from the wall's median colour (CIELAB). */
    distinctDe: Float32Array;
    nccIn: Float32Array;
    contrastIn: Float32Array;
    contrastOut: Float32Array;
}

export interface PlateAudit {
    grid: CellGrid;
    /** Per cell: 0 kept, 1 flagged (counted regions only). */
    flagged: Uint8Array;
    regions: FlaggedRegion[];
    flaggedAreaM2: number;
    coveredAreaM2: number;
    flaggedShare: number;
    reject: boolean;
    why: string;
}

const LAB_CACHE = new Map<number, [number, number, number]>();
function labOf(r: number, g: number, b: number): [number, number, number] {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = LAB_CACHE.get(key);
    if (!v) {
        const l = linearToLab(SRGB8_TO_LINEAR[(r >> 2) * 4 + 2], SRGB8_TO_LINEAR[(g >> 2) * 4 + 2], SRGB8_TO_LINEAR[(b >> 2) * 4 + 2]);
        v = [l[0], l[1], l[2]];
        LAB_CACHE.set(key, v);
    }
    return v;
}

/** CIELAB planes of an RGBA8 sRGB image. */
export function labPlanes(rgba: Uint8Array, n: number): [Float32Array, Float32Array, Float32Array] {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = labOf(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]); L[i] = v[0]; A[i] = v[1]; B[i] = v[2]; }
    return [L, A, B];
}

function quantile(vals: number[], q: number): number {
    if (!vals.length) return 0;
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

/** Robust affine map y ≈ a x + b (median and 10-90 % spread), over the pixels `use` marks. */
export function robustAffine(x: Float32Array, y: Float32Array, use: Uint8Array): { a: number; b: number } {
    const xs: number[] = [], ys: number[] = [];
    const step = Math.max(1, Math.floor(x.length / 40000));
    for (let i = 0; i < x.length; i += step) if (use[i] && Number.isFinite(x[i]) && Number.isFinite(y[i])) { xs.push(x[i]); ys.push(y[i]); }
    if (xs.length < 16) return { a: 1, b: 0 };
    const sx = quantile(xs, 0.9) - quantile(xs, 0.1), sy = quantile(ys, 0.9) - quantile(ys, 0.1);
    const a = sx > 1e-3 ? Math.max(0.5, Math.min(2, sy / sx)) : 1;
    return { a, b: quantile(ys, 0.5) - a * quantile(xs, 0.5) };
}

/** Summed-area table of v (W x H) masked by m: S[(y+1)*(W+1)+(x+1)]. */
function integral(v: Float32Array | null, m: Uint8Array, W: number, H: number, f: (i: number) => number): Float64Array {
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
        let row = 0;
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (m[i] && (!v || Number.isFinite(v[i]))) row += f(i);
            S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
        }
    }
    return S;
}
const boxSum = (S: Float64Array, W: number, x0: number, y0: number, x1: number, y1: number) => S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];

/** The band-pass (fine minus coarse blur) of a plane over the pixels `use` marks. */
export function bandPass(L: Float32Array, use: Uint8Array, W: number, H: number, pixelM: number): Float32Array {
    const f = maskedBlur(L, use, W, H, Math.max(1, Math.round(BAND_FINE_M / pixelM)), 1);
    const c = maskedBlur(L, use, W, H, Math.max(2, Math.round(BAND_COARSE_M / pixelM)));
    const out = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) out[i] = f[i] - c[i];
    return out;
}

export function cellGrid(W: number, H: number, use: Uint8Array, pixelM: number, cellM = AUDIT_CELL_M): CellGrid {
    const cellPx = Math.max(2, Math.round(cellM / pixelM));
    const cw = Math.ceil(W / cellPx), ch = Math.ceil(H / cellPx);
    const cover = new Float32Array(cw * ch);
    const S = integral(null, use, W, H, () => 1);
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        const x0 = cx * cellPx, y0 = cy * cellPx, x1 = Math.min(W, x0 + cellPx), y1 = Math.min(H, y0 + cellPx);
        cover[cy * cw + cx] = boxSum(S, W, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
    }
    return { cw, ch, cellPx, cover };
}

/**
 * Per-cell structure statistics of two band-passed planes over `use`: each one's contrast (standard deviation) and their
 * normalised cross-correlation, in a window of (2 * halo + 1) cells round each cell.
 */
export function windowStructure(a: Float32Array, b: Float32Array, use: Uint8Array, W: number, H: number, g: CellGrid, halo = 1): { contrastA: Float32Array; contrastB: Float32Array; ncc: Float32Array } {
    const n = integral(a, use, W, H, () => 1);
    const sa = integral(a, use, W, H, i => a[i]), sb = integral(b, use, W, H, i => b[i]);
    const saa = integral(a, use, W, H, i => a[i] * a[i]), sbb = integral(b, use, W, H, i => b[i] * b[i]), sab = integral(a, use, W, H, i => a[i] * b[i]);
    const N = g.cw * g.ch;
    const contrastA = new Float32Array(N), contrastB = new Float32Array(N), ncc = new Float32Array(N).fill(NaN);
    for (let cy = 0; cy < g.ch; cy++) for (let cx = 0; cx < g.cw; cx++) {
        const x0 = Math.max(0, (cx - halo) * g.cellPx), y0 = Math.max(0, (cy - halo) * g.cellPx);
        const x1 = Math.min(W, (cx + halo + 1) * g.cellPx), y1 = Math.min(H, (cy + halo + 1) * g.cellPx);
        const k = cy * g.cw + cx, m = boxSum(n, W, x0, y0, x1, y1);
        if (m < 16) continue;
        const ma = boxSum(sa, W, x0, y0, x1, y1) / m, mb = boxSum(sb, W, x0, y0, x1, y1) / m;
        const va = Math.max(0, boxSum(saa, W, x0, y0, x1, y1) / m - ma * ma), vb = Math.max(0, boxSum(sbb, W, x0, y0, x1, y1) / m - mb * mb);
        const cab = boxSum(sab, W, x0, y0, x1, y1) / m - ma * mb;
        contrastA[k] = Math.sqrt(va); contrastB[k] = Math.sqrt(vb);
        if (va > 1e-6 && vb > 1e-6) ncc[k] = cab / Math.sqrt(va * vb);
    }
    return { contrastA, contrastB, ncc };
}

/** The per-cell features of a plate against its input (see the file comment). */
export function plateFeatures(input: Uint8Array, plate: Uint8Array, W: number, H: number, use: Uint8Array, pixelM: number): CellFeatures {
    const g = cellGrid(W, H, use, pixelM);
    const [Li, Ai, Bi] = labPlanes(input, W * H), [Lo, Ao, Bo] = labPlanes(plate, W * H);
    const r = Math.max(2, Math.round(TONE_BLUR_M / pixelM));
    const lp = (v: Float32Array) => maskedBlur(v, use, W, H, r);
    const inLp = [lp(Li), lp(Ai), lp(Bi)], outLp = [lp(Lo), lp(Ao), lp(Bo)];
    const maps = [0, 1, 2].map(c => robustAffine(outLp[c], inLp[c], use));
    const de = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        let s = 0;
        for (let c = 0; c < 3; c++) { const d = (maps[c].a * outLp[c][i] + maps[c].b - inLp[c][i]) * (c ? 1 : LIGHTNESS_WEIGHT); s += d * d; }
        de[i] = Math.sqrt(s);
    }
    const S = integral(de, use, W, H, i => de[i]), Sn = integral(de, use, W, H, () => 1);
    const toneDe = new Float32Array(g.cw * g.ch).fill(NaN);
    for (let cy = 0; cy < g.ch; cy++) for (let cx = 0; cx < g.cw; cx++) {
        const x0 = cx * g.cellPx, y0 = cy * g.cellPx, x1 = Math.min(W, x0 + g.cellPx), y1 = Math.min(H, y0 + g.cellPx);
        const m = boxSum(Sn, W, x0, y0, x1, y1);
        if (m > 0) toneDe[cy * g.cw + cx] = boxSum(S, W, x0, y0, x1, y1) / m;
    }
    const st = windowStructure(bandPass(Li, use, W, H, pixelM), bandPass(Lo, use, W, H, pixelM), use, W, H, g);
    // how far each cell of the input stands out from the wall as a whole (a dark bay, a storefront, a stone base)
    const rd = Math.max(2, Math.round(DISTINCT_BLUR_M / pixelM));
    const inD = [maskedBlur(Li, use, W, H, rd), maskedBlur(Ai, use, W, H, rd), maskedBlur(Bi, use, W, H, rd)];
    const med = inD.map(p => { const v: number[] = []; const step = Math.max(1, Math.floor(p.length / 40000)); for (let i = 0; i < p.length; i += step) if (use[i] && Number.isFinite(p[i])) v.push(p[i]); return quantile(v, 0.5); });
    const dd = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { let q = 0; for (let c = 0; c < 3; c++) { const x = (inD[c][i] - med[c]) * (c ? 1 : LIGHTNESS_WEIGHT); q += x * x; } dd[i] = Math.sqrt(q); }
    const Sd = integral(dd, use, W, H, i => dd[i]);
    const distinctDe = new Float32Array(g.cw * g.ch).fill(NaN);
    for (let cy = 0; cy < g.ch; cy++) for (let cx = 0; cx < g.cw; cx++) {
        const x0 = cx * g.cellPx, y0 = cy * g.cellPx, x1 = Math.min(W, x0 + g.cellPx), y1 = Math.min(H, y0 + g.cellPx);
        const m = boxSum(Sn, W, x0, y0, x1, y1);
        if (m > 0) distinctDe[cy * g.cw + cx] = boxSum(Sd, W, x0, y0, x1, y1) / m;
    }
    return { ...g, toneDe, distinctDe, nccIn: st.ncc, contrastIn: st.contrastA, contrastOut: st.contrastB };
}

/**
 * Per cell: the kind of disagreement, or '' (cells less than half covered are never flagged). Under the realism-first
 * directive, inventing finer detail is the point of a redraw; what is reverted is a plate that erases or contradicts what
 * makes the input this wall. So structure the plate adds where the input is ordinary wall (its colour near the wall's median
 * and its contrast low) is "invented-detail" and kept; the same where the input stands out (distinct colour or strong
 * structure: a dark bay, a storefront, signage, a tower's openings) is "replaced"; flattening such structure is "erased";
 * a changed colour is "retoned".
 */
export function distinctCells(f: CellFeatures): Uint8Array {
    const own = new Uint8Array(f.cw * f.ch);
    for (let k = 0; k < own.length; k++) own[k] = f.cover[k] >= 0.5 && (f.distinctDe[k] >= DISTINCT_DE || f.contrastIn[k] >= DISTINCT_CONTRAST_L) ? 1 : 0;
    const out = new Uint8Array(own.length), R = DISTINCT_REACH_CELLS;
    for (let y = 0; y < f.ch; y++) for (let x = 0; x < f.cw; x++) {
        let hit = 0;
        for (let dy = -R; dy <= R && !hit; dy++) for (let dx = -R; dx <= R && !hit; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < f.cw && yy < f.ch && own[yy * f.cw + xx]) hit = 1;
        }
        out[y * f.cw + x] = hit;
    }
    return out;
}

export function classifyCells(f: CellFeatures): string[] {
    const out: string[] = new Array(f.cw * f.ch).fill('');
    const near = distinctCells(f);
    for (let k = 0; k < out.length; k++) {
        if (f.cover[k] < 0.5) continue;
        const ci = f.contrastIn[k], co = f.contrastOut[k], r = f.nccIn[k];
        const supported = Number.isFinite(r) && r >= MIN_SUPPORT_NCC;
        const distinct = near[k] === 1;
        if (distinct && ci >= MIN_CONTRAST_L && co < ERASE_CONTRAST_RATIO * ci) out[k] = 'erased';
        else if (co >= MIN_CONTRAST_L && !supported) out[k] = distinct ? (co >= ci ? 'replaced' : 'erased') : 'invented-detail';
        else if (f.toneDe[k] > MAX_TONE_DE) out[k] = 'retoned';
    }
    return out;
}

/** Labels of cells that are kept even though the plate differs there (reported, not reverted). */
export const KEPT_KINDS: ReadonlySet<string> = new Set(['invented-detail']);

/** 8-connected regions of the cells `on` marks, each with its cells; the kind is the most common label among them. */
export function cellRegions(on: (k: number) => boolean, cw: number, ch: number): number[][] {
    const seen = new Uint8Array(cw * ch), regions: number[][] = [];
    for (let s = 0; s < cw * ch; s++) {
        if (seen[s] || !on(s)) continue;
        const stack = [s], cells: number[] = [];
        seen[s] = 1;
        while (stack.length) {
            const k = stack.pop()!;
            cells.push(k);
            const x = k % cw, y = (k - x) / cw;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
                const j = ny * cw + nx;
                if (!seen[j] && on(j)) { seen[j] = 1; stack.push(j); }
            }
        }
        regions.push(cells);
    }
    return regions;
}

/** Regions of labelled cells of at least `minAreaM2`, described. */
export function describeRegions(labels: string[], g: CellGrid, pixelM: number, W: number, H: number, extra: { toneDe?: Float32Array; ncc?: Float32Array } = {}, minAreaM2 = MIN_REGION_M2): { regions: FlaggedRegion[]; flagged: Uint8Array } {
    const flagged = new Uint8Array(g.cw * g.ch);
    const regions: FlaggedRegion[] = [];
    const cellM2 = (g.cellPx * pixelM) ** 2;
    for (const cells of cellRegions(k => labels[k] !== '', g.cw, g.ch)) {
        const area = cells.reduce((s, k) => s + g.cover[k], 0) * cellM2;
        if (area < minAreaM2) continue;
        const count = new Map<string, number>();
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, tone = 0, nt = 0, ncc = 0, nn = 0;
        for (const k of cells) {
            flagged[k] = 1;
            count.set(labels[k], (count.get(labels[k]) ?? 0) + 1);
            const cx = k % g.cw, cy = (k - cx) / g.cw;
            x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx + 1); y1 = Math.max(y1, cy + 1);
            if (extra.toneDe && Number.isFinite(extra.toneDe[k])) { tone += extra.toneDe[k]; nt++; }
            if (extra.ncc && Number.isFinite(extra.ncc[k])) { ncc += extra.ncc[k]; nn++; }
        }
        const kind = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
        regions.push({
            kind, cells: cells.length, areaM2: Math.round(area * 10) / 10,
            box: [x0 * g.cellPx, y0 * g.cellPx, Math.min(W, x1 * g.cellPx), Math.min(H, y1 * g.cellPx)],
            meanToneDe: nt ? Math.round((tone / nt) * 10) / 10 : NaN, meanNcc: nn ? Math.round((ncc / nn) * 100) / 100 : NaN
        });
    }
    return { regions: regions.sort((a, b) => b.areaM2 - a.areaM2), flagged };
}

/** The invention and erasure check of `plate` (aligned to `input`, both W x H RGBA8) over the texels `use` marks. */
export function auditPlate(input: Uint8Array, plate: Uint8Array, W: number, H: number, use: Uint8Array, pixelM: number): PlateAudit & { features: CellFeatures; labels: string[]; inventedDetailM2: number } {
    const features = plateFeatures(input, plate, W, H, use, pixelM);
    const labels = classifyCells(features);
    const { regions, flagged } = describeRegions(labels.map(l => (KEPT_KINDS.has(l) ? '' : l)), features, pixelM, W, H, { toneDe: features.toneDe, ncc: features.nccIn });
    const inventedDetailM2 = Math.round(labels.reduce((t, l, k) => t + (KEPT_KINDS.has(l) ? features.cover[k] : 0), 0) * (features.cellPx * pixelM) ** 2 * 10) / 10;
    const cellM2 = (features.cellPx * pixelM) ** 2;
    const coveredAreaM2 = features.cover.reduce((s, v) => s + v, 0) * cellM2;
    const flaggedAreaM2 = regions.reduce((s, r) => s + r.areaM2, 0);
    const share = coveredAreaM2 > 0 ? flaggedAreaM2 / coveredAreaM2 : 0;
    const reject = share > MAX_FLAGGED_SHARE;
    const byKind = new Map<string, number>();
    for (const r of regions) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.areaM2);
    const kinds = [...byKind.entries()].map(([k, a]) => `${k} ${a.toFixed(1)} m2`).join(', ');
    const why = regions.length
        ? `${regions.length} region${regions.length === 1 ? '' : 's'} the input does not support (${kinds}), ${(100 * share).toFixed(0)}% of the wall's ${coveredAreaM2.toFixed(0)} m2${reject ? ` (more than ${100 * MAX_FLAGGED_SHARE}%: the wall keeps its input)` : ': reverted to the input there'}`
        : 'no region of the plate adds or removes structure the input does not support';
    return { grid: features, flagged, regions, inventedDetailM2, flaggedAreaM2: Math.round(flaggedAreaM2 * 10) / 10, coveredAreaM2: Math.round(coveredAreaM2 * 10) / 10, flaggedShare: Math.round(share * 1000) / 1000, reject, why, features, labels };
}

/** The per-pixel mask of flagged cells. */
export function cellMaskToPixels(flagged: Uint8Array, g: CellGrid, W: number, H: number): Uint8Array {
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (flagged[Math.floor(y / g.cellPx) * g.cw + Math.floor(x / g.cellPx)]) m[y * W + x] = 1;
    return m;
}

/**
 * The plate with the masked pixels taken back from the input, blended over FEATHER_M outside the mask (weight 1 inside the
 * mask falling to 0 a feather width out). Returns the blend and the input's weight per pixel.
 */
export function revertRegions(input: Uint8Array, plate: Uint8Array, W: number, H: number, mask: Uint8Array, pixelM: number): { rgba: Uint8Array; weight: Float32Array } {
    const r = Math.max(1, Math.round(FEATHER_M / pixelM / 2));
    const m = new Float32Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = mask[i] ? 1 : 0;
    // a box blur twice over a mask grown by the feather: 1 inside the mask, falling to 0 over about FEATHER_M outside it
    const grown = new Float32Array(W * H);
    const blurred = maskedBlur(m, undefined, W, H, r);
    for (let i = 0; i < m.length; i++) grown[i] = blurred[i] > 1e-3 ? 1 : 0;
    const soft = maskedBlur(grown, undefined, W, H, r);
    const weight = new Float32Array(W * H);
    const out = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        const w = mask[i] ? 1 : Math.max(0, Math.min(1, soft[i]));
        weight[i] = w;
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(w * input[i * 4 + c] + (1 - w) * plate[i * 4 + c]);
        out[i * 4 + 3] = 255;
    }
    return { rgba: out, weight };
}
