/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facades rebuilt on the lines their photo shows (the default staged path, after the remesh cleanup). The remeshed scan
 * creases only where the depth changes a lot; the textured tile photo shows the architecture's lines: on Place des
 * Victoires (2026-10-22) the facade orthophotos held 7-9 horizontal and 15-38 vertical lines (storey bands, sills and
 * heads, jambs, piers, cornice) against the geometry's 3-4 and 2-13 creases, and most photo lines had no crease.
 *
 * Per facade tile_refine rectified (its relief orthophoto and plane frame, relief_orthos/facades.json):
 * 1. the lattice: straight lines in the photo, as the peaks of its edge energy along rows (t) and columns (s);
 * 2. each cell's depth: the median distance of the scan's surface from the facade plane within the cell (the scan sampled
 *    over its triangles, facade-facing triangles only);
 * 3. repeats averaged: the windows are read in rows and columns (windowGrid: a darker column crossing a darker row, the
 *    cell darker than the wall); in each row the windows and the wall each take their median depth, so repeated windows
 *    get one recess measured from all of them;
 * 4. the facade rebuilt: one face per cell at its depth, step faces between cells (reveals, sills, cornices), replacing the
 *    scan's facade triangles; textured with the facade's own orthophoto (planar UVs in the plane's frame). Only cells the
 *    photo covers are rebuilt: an uncovered cell keeps its scan triangles, never a face painted the uncovered grey. Pipeline
 *    K rebuilds whole walls instead (wall-sheets.ts): a wall of several facades is one sheet with one photo, rebuilt in place
 *    of them, and a cell the photo missed is rebuilt too where the scan measures the wall inside its outline (its texture
 *    the fill, generated), so rebuilt cells and scan no longer alternate across one wall.
 * Lines are photo-inferred; depths are measured (averaged); the rebuilt faces are labelled so in the GLB extras.
 */

import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';
import { decodePng } from '../../texture-processing';
import { cutScanToLattice, stitchLattice, watertightLatticeMesh, type CutReport, type StitchReport } from './pipeline-k/lattice-stitch';
import { fittedGeneratedUvs, fittedPaneUvs, fittedWindowRects, fittedWindowUvs, WINDOW_FIT_VERSION, type WindowFitFile, type WindowRect } from './window-fit';
import { trustedReveal, type RevealDepthFile } from './reveal-depth';
import { grammarBays, type WallGrammarFile } from './wall-grammar';
import type { WallSheet, WallSheetsFile } from './wall-sheets';
import { repeatTexture, type RepeatTextureReport } from './facade-repeat-texture';
import { encodePng } from './png-encode';
import * as fs from 'fs';
import * as path from 'path';

export const FACADE_LATTICE_VERSION = 'facade-lattice/19';

export const FACADE_LATTICE_PARAMS = {
    /**
     * Facades tile_refine rectified with at least this share covered: of the wall's own outline when it was measured
     * (wallCoverage, pipeline K), else of the ortho's rectangle. A stepped face's rectangle holds the air beside its setbacks.
     */
    minCoverage: 0.6,
    /** A facade's wall (wallAreaM2, when measured) must span at least this (m²): slivers of a plane are not facades. */
    minWallM2: 20,
    /** A line is an edge-energy peak above mean + k sd. */
    peakK: 1.0,
    /** Lines closer than this merge (m). */
    minLineGapM: 0.4,
    /** The scan within this of the facade plane belongs to it (m), on triangles facing within this cosine of its normal. */
    depthBandM: 2.0, facingCos: 0.6,
    /** Sample spacing over the scan's triangles (m). */
    sampleM: 0.15,
    /** A cell is measured with at least this many samples. */
    minSamples: 4,
    /** Depths are clamped to this range from the plane (m): recesses deeper, projections further are scan noise. */
    minDepthM: -1.2, maxDepthM: 0.8,
    /** A step face is drawn where neighbouring cells differ by more than this (m). */
    stepM: 0.03,
    /** A facade is rebuilt only when its measured cells cover at least this share of its outline's area (each row from its first to its last photographed texel). */
    minMeasuredShare: 0.5,
    /**
     * A cell is rebuilt only when at least this share of its ortho is covered by the photo (uncovered is exact grey 128 or
     * transparent): elsewhere the scan's own triangles stay, rather than a face textured with the uncovered grey.
     */
    minCellPhotoShare: 0.5,
    /**
     * The tear audit: each facade seen straight on at this pixel (m); a tear is a pixel where the scan had surface within the
     * depth band and the result has nothing in front of the band's back plus this (m).
     */
    auditPixelM: 0.2, tearDepthM: 0.5,
    /**
     * The audit also looks at each facade from these angles (deg off its normal: to each side about its up axis, then up and
     * down about its along axis): a slit at a recess side or a facade's edge shows only at an angle (0.81% of the ESB was seen
     * through such holes while the straight-on audit found none).
     */
    auditYawDeg: 45, auditPitchDeg: 35
};

/**
 * What the tear audit found: torn pixels in the first pass, scan triangles put back over them, facades left unrebuilt because a
 * tear stayed after that, and torn pixels left at the end (0 unless the scan itself lacked surface there).
 */
export interface TearReport { found: number; restoredTriangles: number; droppedFacades: number[]; left: number; /** Of `found`, torn pixels seen only from an angle; and those left after restoring (the rebuilt geometry's own slits). */ oblique?: number; obliqueLeft?: number }

export interface ReliefFacade {
    facadeId: number; image: string; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[];
    sMin: number; sMax: number; tMin: number; tMax: number; pixel: number; width: number; height: number; orthoSMin: number; orthoTMax: number; coverage: number;
    /** A mask beside the image (one channel, 255 = the photo did not reach) when the image's holes were filled (pipeline K). */
    uncoveredMask?: string;
    /** How the image's holes were filled, carried into the rebuilt facade's provenance. */
    textureFill?: { label: string; texels: number; share: number; method: string };
    /** The share of the wall's own outline (each row from its first to its last covered pixel) the photo covers, and that outline's area (wallCoverage). */
    wallCoverage?: number; wallAreaM2?: number;
}

/**
 * How much of a facade's wall its ortho covers: each row's span from its first to its last covered pixel is the wall's
 * outline there (a stepped face narrows at each setback, the air beside it outside every span), and covered pixels are those
 * the facade's own triangles reached (not transparent, not the uncovered grey 128).
 */
export function wallCoverage(img: { rgba: ArrayLike<number>; width: number; height: number }, pixel: number): { wallCoverage: number; wallAreaM2: number } {
    const { width: W, height: H, rgba } = img;
    const covered = (k: number) => rgba[k * 4 + 3] > 0 && !(rgba[k * 4] === 128 && rgba[k * 4 + 1] === 128 && rgba[k * 4 + 2] === 128);
    let inside = 0, hit = 0;
    for (let y = 0; y < H; y++) {
        let a = -1, b = -1, n = 0;
        for (let x = 0; x < W; x++) if (covered(y * W + x)) { if (a < 0) a = x; b = x; n++; }
        if (a >= 0) { inside += b - a + 1; hit += n; }
    }
    return { wallCoverage: inside ? hit / inside : 0, wallAreaM2: inside * pixel * pixel };
}

/** A facade the lattice (and the window fit) works on: covered enough over its wall (or its rectangle) and not a sliver. */
export function facadeEligible(f: Pick<ReliefFacade, 'coverage' | 'wallCoverage' | 'wallAreaM2'>, P: Pick<typeof FACADE_LATTICE_PARAMS, 'minCoverage' | 'minWallM2'> = FACADE_LATTICE_PARAMS): boolean {
    return (f.wallCoverage ?? f.coverage) >= P.minCoverage && (f.wallAreaM2 ?? Infinity) >= P.minWallM2;
}

/**
 * Window recesses read from the photo (pipeline K, whose scan tile_refine leaves uncarved): the photometric relief's rule
 * (scratchbox_photometric_relief.hpp reliefDepthFor), applied to a row's repeated openings on the straightened photo. A
 * row's openings recess when at least minRepeats of them are darker than its wall by contrastLo (1 - opening / wall
 * luminance), recessMin at contrastLo up to recessMax at contrastHi (smoothstep), never shallower than the scan measures.
 */
export const PHOTO_RECESS = { contrastLo: 0.10, contrastHi: 0.35, recessMin: 0.15, recessMax: 0.25, minRepeats: 2 };

/**
 * The windows of a facade's cell lattice, read in rows and columns: punched windows sit where a darker column of cells
 * crosses a darker row of cells (each at least lineContrast darker than the facade's wall level: its brighter quarter of
 * columns or rows, since windows may be the majority of either), and the cell
 * itself is at least cellContrast darker than the wall (the cells outside those crossings), repeated at least minRepeats
 * times in its row. A row of weathered stone or a pier of shadow is darker along one direction only, so it is no window.
 */
export const WINDOW_GRID = { lineContrast: 0.05, cellContrast: 0.3, minRepeats: 2 };

export function windowGrid(lum: ArrayLike<number>, ns: number, nt: number, R = WINDOW_GRID): Uint8Array {
    const col = new Float64Array(ns).fill(NaN), row = new Float64Array(nt).fill(NaN);
    for (let a = 0; a < ns; a++) { let s = 0, n = 0; for (let b = 0; b < nt; b++) { const v = lum[b * ns + a]; if (Number.isFinite(v)) { s += v; n++; } } if (n) col[a] = s / n; }
    for (let b = 0; b < nt; b++) { let s = 0, n = 0; for (let a = 0; a < ns; a++) { const v = lum[b * ns + a]; if (Number.isFinite(v)) { s += v; n++; } } if (n) row[b] = s / n; }
    // the wall's level: the brighter quarter of the columns and rows (windows may be the majority of either)
    const upper = (v: Float64Array) => { const f = Array.from(v).filter(Number.isFinite).sort((x, y) => x - y); return f.length ? f[Math.floor(0.75 * (f.length - 1))] : NaN; };
    const mc = upper(col), mr = upper(row);
    const darkCol = Array.from(col, v => v < mc * (1 - R.lineContrast)), darkRow = Array.from(row, v => v < mr * (1 - R.lineContrast));
    const wallLum = median(Array.from({ length: ns * nt }, (_, k) => k).filter(k => !(darkCol[k % ns] && darkRow[Math.floor(k / ns)])).map(k => lum[k]).filter(Number.isFinite));
    const out = new Uint8Array(ns * nt);
    if (!(wallLum > 0)) return out;
    for (let b = 0; b < nt; b++) {
        if (!darkRow[b]) continue;
        const cells: number[] = [];
        for (let a = 0; a < ns; a++) { const k = b * ns + a, v = lum[k]; if (darkCol[a] && Number.isFinite(v) && v <= wallLum * (1 - R.cellContrast)) cells.push(k); }
        if (cells.length >= R.minRepeats) for (const k of cells) out[k] = 1;
    }
    return out;
}

/**
 * Window strips (pipeline K with a window fit): the fitted windows grouped into columns (windows whose spans along s overlap by
 * at least `overlap` of the narrower), each column split where its windows stand more than `maxGapM` apart up the wall (a
 * band, a setback), and every run of at least `minWindows` windows, or one at least `minStripM` tall (a fit that reads the column as one
 * opening), drawn as one strip from its lowest window's sill to its
 * highest window's head, at the column's median edges. Then bays: side by side (overlapping up the wall by half), two strips
 * are one bay when the gap between them is under `mullionRatio` of the gaps beside it in their row (the narrower of the two
 * neighbours: a mullion stands between two piers, a pier between two mullions, and a wide gap at a corner or a setback
 * makes no pier a mullion); a row of equal gaps stays one strip per column. The bay is recessed whole (its
 * spandrels and mullions with it) between the piers that stay on the wall (the structure, STRUCTURE), and its windows a
 * further `windowInsetM`. Photo-inferred, read from the facade's own fit.
 */
export const WINDOW_STRIPS = { overlap: 0.5, maxGapM: 2.5, minWindows: 2, minStripM: 5, mullionRatio: 0.6, windowInsetM: 0.05 };

/**
 * The structure (pipeline K with window strips): a facade's cells outside its bays and windows (piers, bands, parapets: the
 * masonry frame the bays sit in) stand proud of the bays by the scan's measured pier-to-bay depth when it resolves one (the
 * difference of the two medians at least minReliefM and two standard errors), else the depth the photo's recess rule (or
 * Street View's reveals) gives, else defaultReliefM (generated); the front edge of every step at least twice chamferM deep
 * is chamfered by chamferM at 45 degrees, so the stone's arrises catch the light. Written into the facade's extras
 * (sbFacadeLattice.structure) so the material regions put the stone's relief on the structure alone.
 */
export const STRUCTURE = { chamferM: 0.05, minReliefM: 0.03, defaultReliefM: 0.10 };

export function windowStrips(windows: Array<[number, number, number, number]>, R = WINDOW_STRIPS): Array<[number, number, number, number]> {
    const n = windows.length, parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = windows[i], b = windows[j], ov = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        if (ov >= R.overlap * Math.min(a[2] - a[0], b[2] - b[0])) parent[find(i)] = find(j);
    }
    const cols = new Map<number, Array<[number, number, number, number]>>();
    windows.forEach((w, i) => { const r = find(i); cols.set(r, [...(cols.get(r) ?? []), w]); });
    const out: Array<[number, number, number, number]> = [];
    for (const col of cols.values()) {
        col.sort((a, b) => a[1] - b[1]);
        let run: Array<[number, number, number, number]> = [];
        const close = () => {
            if (run.length >= R.minWindows || (run.length && Math.max(...run.map(w => w[3])) - Math.min(...run.map(w => w[1])) >= R.minStripM)) out.push([median(run.map(w => w[0])), Math.min(...run.map(w => w[1])), median(run.map(w => w[2])), Math.max(...run.map(w => w[3]))]);
            run = [];
        };
        for (const w of col) {
            if (run.length && w[1] - Math.max(...run.map(x => x[3])) > R.maxGapM) close();
            run.push(w);
        }
        close();
    }
    return windowBays(out.sort((a, b) => a[0] - b[0] || a[1] - b[1]), R);
}

/** Strips side by side joined into bays across their mullions (WINDOW_STRIPS.mullionRatio); see windowStrips. */
export function windowBays(strips: Array<[number, number, number, number]>, R = WINDOW_STRIPS): Array<[number, number, number, number]> {
    const tOverlap = (a: number[], b: number[]) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]) >= R.overlap * Math.min(a[3] - a[1], b[3] - b[1]);
    const out: Array<[number, number, number, number]> = [];
    const used = new Set<number>();
    for (let i = 0; i < strips.length; i++) {
        if (used.has(i)) continue;
        // the row: every strip standing beside this one up the wall, left to right
        const row = strips.map((x, k) => [x, k] as const).filter(([x, k]) => !used.has(k) && tOverlap(x, strips[i])).sort((a, b) => a[0][0] - b[0][0]);
        row.forEach(([, k]) => used.add(k));
        const gaps = row.slice(1).map(([x], j) => x[0] - row[j][0][2]);
        // a gap against the narrower of its neighbours (none: it stays)
        const beside = (j: number) => Math.min(j > 0 ? gaps[j - 1] : Infinity, j + 1 < gaps.length ? gaps[j + 1] : Infinity);
        let bay: [number, number, number, number] = [...row[0][0]];
        row.slice(1).forEach(([x], j) => {
            if (Number.isFinite(beside(j)) && gaps[j] < R.mullionRatio * beside(j)) bay = [bay[0], Math.min(bay[1], x[1]), x[2], Math.max(bay[3], x[3])];
            else { out.push(bay); bay = [...x]; }
        });
        out.push(bay);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** The cells whose centre lies in one of the fitted windows ([s0, t0, s1, t1] in the plane's frame). */
export function fittedCells(s: number[], t: number[], windows: Array<[number, number, number, number]>): Uint8Array {
    const ns = s.length - 1, nt = t.length - 1, out = new Uint8Array(ns * nt);
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        const cs = (s[a] + s[a + 1]) / 2, ct = (t[b] + t[b + 1]) / 2;
        if (windows.some(w => cs > w[0] && cs < w[2] && ct > w[1] && ct < w[3])) out[b * ns + a] = 1;
    }
    return out;
}

export function photoRecessDepth(contrast: number, R = PHOTO_RECESS): number | undefined {
    if (!(contrast >= R.contrastLo)) return undefined;
    const x = Math.min(1, Math.max(0, (contrast - R.contrastLo) / (R.contrastHi - R.contrastLo)));
    return R.recessMin + (R.recessMax - R.recessMin) * x * x * (3 - 2 * x);
}

export interface FacadeLatticeResult {
    facadeId: number; s: number[]; t: number[]; cells: number; measuredShare: number;
    depth: number[][];
    /** Cells whose depth is the photo's window recess (photoRecess), not the scan's: photo-inferred. */
    photoRecessCells?: number;
    /** Where that recess's depth came from: Street View's reveals (reveal-depth.ts) or the contrast rule. */
    recessFrom?: string;
    /** The window strips (WINDOW_STRIPS) recessed whole, [s0, t0, s1, t1] each, and their rebuilt cells: photo-inferred. */
    strips?: Array<[number, number, number, number]>; stripCells?: number;
    /** The structure (STRUCTURE): per cell 1 for a rebuilt cell outside the bays and windows; its relief over the bays and where that came from. */
    structure?: { cells: Uint8Array; reliefM: number; reliefFrom: 'measured' | 'photo-inferred' | 'generated'; reason: string };
    /** The facade photo redrawn from its own repeats (facade-repeat-texture.ts): generated. */
    repeatTexture?: RepeatTextureReport;
    /** Per cell (row-major, t then s): 1 when it was rebuilt, 0 when the photo does not cover it and the scan stays. */
    built: Uint8Array;
    /**
     * Per cell: 1 for a window, a rebuilt cell of windowGrid's (a darker column crossing a darker row, darker than the
     * wall, repeated along its row; photo-inferred). With the cell lines in
     * the facade photo's UVs (u along s, v down from the top), so a later pass can find each window in the texture.
     */
    windows: Uint8Array; cellU: number[]; cellV: number[];
    /** The window fit's windows on this facade (window-fit.ts), u0 v0 u1 v1 per window in the photo's UVs: photo-inferred. */
    fittedWindows?: number[];
    /** The glass in those windows (window-fit.ts panes), u0 v0 u1 v1 each: photo-inferred. */
    fittedPanes?: number[];
    /** Of the fitted windows, those continued into parts the photo never reached (window-fit.ts completeLattice), u0 v0 u1 v1 each: generated. */
    generatedWindows?: number[];
    positions: Float32Array; normals: Float32Array; uv: Float32Array; indices: Uint32Array;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function peaks(p: Float64Array, k: number, sep: number): number[] {
    const n = p.length, m = p.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(p.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    const c: number[] = [];
    for (let i = 1; i < n - 1; i++) if (p[i] > m + k * sd && p[i] >= p[i - 1] && p[i] >= p[i + 1]) c.push(i);
    c.sort((a, b) => p[b] - p[a]);
    const keep: number[] = [];
    for (const i of c) if (keep.every(j => Math.abs(j - i) >= sep)) keep.push(i);
    return keep.sort((a, b) => a - b);
}

/** The facade's lattice lines in its plane's frame (metres): s from left to right, t from bottom to top, bounds included. */
export function photoLattice(img: { rgba: Uint8Array; width: number; height: number }, f: ReliefFacade, P = FACADE_LATTICE_PARAMS): { s: number[]; t: number[] } {
    const { width: w, height: h } = img, px = f.pixel;
    const L = (x: number, y: number) => { const i = (y * w + x) * 4; return img.rgba[i + 3] ? 0.3 * img.rgba[i] + 0.59 * img.rgba[i + 1] + 0.11 * img.rgba[i + 2] : NaN; };
    const rowE = new Float64Array(h), colE = new Float64Array(w);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const gy = Math.abs(L(x, y + 1) - L(x, y - 1)), gx = Math.abs(L(x + 1, y) - L(x - 1, y));
        if (Number.isFinite(gy)) rowE[y] += gy;
        if (Number.isFinite(gx)) colE[x] += gx;
    }
    const sep = Math.max(2, Math.round(P.minLineGapM / px));
    const sOf = (x: number) => f.orthoSMin + x * px, tOf = (y: number) => f.orthoTMax - y * px;
    const s = [f.sMin, ...peaks(colE, P.peakK, sep).map(sOf).filter(v => v > f.sMin + P.minLineGapM && v < f.sMax - P.minLineGapM), f.sMax];
    const t = [f.tMin, ...peaks(rowE, P.peakK, sep).map(tOf).filter(v => v > f.tMin + P.minLineGapM && v < f.tMax - P.minLineGapM).sort((a, b) => a - b), f.tMax];
    return { s, t };
}

/**
 * The lattice on the window fit's windows (pipeline K): each fitted window's edges are lines, and the photo's own lines are
 * kept where no window edge lies within minLineGapM of them (cornices, setbacks, storey bands the fit does not draw).
 * Windows are [s0, t0, s1, t1] in the plane's frame (metres).
 */
export function fittedLattice(photo: { s: number[]; t: number[] }, windows: Array<[number, number, number, number]>, f: ReliefFacade, P = FACADE_LATTICE_PARAMS): { s: number[]; t: number[] } {
    const merge = (fromPhoto: number[], fromFit: number[], lo: number, hi: number) => {
        const fit = [...new Set(fromFit.map(v => Math.min(hi, Math.max(lo, v))))].filter(v => v > lo + 1e-6 && v < hi - 1e-6);
        const keep = fromPhoto.filter(v => v > lo && v < hi && fit.every(e => Math.abs(e - v) >= P.minLineGapM));
        return [lo, ...[...fit, ...keep].sort((a, b) => a - b), hi];
    };
    return { s: merge(photo.s, windows.flatMap(w => [w[0], w[2]]), f.sMin, f.sMax), t: merge(photo.t, windows.flatMap(w => [w[1], w[3]]), f.tMin, f.tMax) };
}

/** Depth samples of the scan (triangle soup, nine floats a triangle) in the facade's frame: [s, t, d] triples. */
export function facadeSamples(soup: Float32Array, f: ReliefFacade, P = FACADE_LATTICE_PARAMS): Float64Array {
    const out: number[] = [];
    for (let i = 0; i + 8 < soup.length; i += 9) {
        const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1], uz = soup[i + 5] - soup[i + 2], vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1], vz = soup[i + 8] - soup[i + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
        if (!(nl > 0) || Math.abs(dot([nx / nl, ny / nl, nz / nl], f.normal)) < P.facingCos) continue;
        const rel = (k: number) => [soup[i + k] - f.centroid[0], soup[i + k + 1] - f.centroid[1], soup[i + k + 2] - f.centroid[2]];
        const a = rel(0), b = rel(3), c = rel(6);
        const da = dot(a, f.normal), db = dot(b, f.normal), dc = dot(c, f.normal);
        if (Math.min(da, db, dc) > P.depthBandM || Math.max(da, db, dc) < -P.depthBandM) continue;
        const sa = dot(a, f.axisS), sb = dot(b, f.axisS), sc = dot(c, f.axisS), ta = dot(a, f.axisT), tb = dot(b, f.axisT), tc = dot(c, f.axisT);
        if (Math.max(sa, sb, sc) < f.sMin || Math.min(sa, sb, sc) > f.sMax || Math.max(ta, tb, tc) < f.tMin || Math.min(ta, tb, tc) > f.tMax) continue;
        const steps = Math.min(30, Math.max(1, Math.ceil(Math.max(Math.hypot(sb - sa, tb - ta), Math.hypot(sc - sa, tc - ta)) / P.sampleM)));
        for (let p = 0; p <= steps; p++) for (let q = 0; p + q <= steps; q++) {
            const u = p / steps, v = q / steps, d = da + (db - da) * u + (dc - da) * v;
            if (Math.abs(d) <= P.depthBandM) out.push(sa + (sb - sa) * u + (sc - sa) * v, ta + (tb - ta) * u + (tc - ta) * v, d);
        }
    }
    return Float64Array.from(out);
}

const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** The facade on its lattice: cell depths (measured, averaged along repeats) and the rebuilt surface in world space. */
export function latticeFacade(f: ReliefFacade, img: { rgba: Uint8Array; width: number; height: number }, samples: Float64Array, P = FACADE_LATTICE_PARAMS, uncovered?: Uint8Array, photoRecess = false, fitted?: Array<[number, number, number, number]>, recessM?: number, bays?: Array<[number, number, number, number]>, reliefSamples?: Float64Array, buildWhereMeasured = false): FacadeLatticeResult | undefined {
    // pipeline K with a window fit: the lattice is drawn on the fitted windows, which are its window cells, and with the photo's
    // recess on, on their strips too (each window column recessed whole between its piers): the wall grammar's bays when it
    // read this facade's wall (wall-grammar.ts), else the strips of its own windows
    const strips = photoRecess ? (bays ?? (fitted?.length ? windowStrips(fitted) : [])) : [];
    const lines = [...(fitted ?? []), ...strips];
    const { s, t } = lines.length ? fittedLattice(photoLattice(img, f, P), lines, f, P) : photoLattice(img, f, P);
    const ns = s.length - 1, nt = t.length - 1;
    if (ns < 1 || nt < 1) return undefined;
    const cellOf = (v: number, edges: number[]) => { let lo = 0, hi = edges.length - 1; if (v < edges[0] || v > edges[hi]) return -1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (edges[m] <= v) lo = m; else hi = m; } return lo; };
    const bucket: number[][] = Array.from({ length: ns * nt }, () => []);
    for (let i = 0; i < samples.length; i += 3) { const a = cellOf(samples[i], s), b = cellOf(samples[i + 1], t); if (a >= 0 && b >= 0) bucket[b * ns + a].push(samples[i + 2]); }
    // the photo's mean luminance per cell (openings read darker than wall)
    const lum = new Float64Array(ns * nt).fill(NaN);
    const built = new Uint8Array(ns * nt);
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        let sum = 0, n = 0, all = 0;
        const x0 = Math.max(0, Math.floor((s[a] - f.orthoSMin) / f.pixel)), x1 = Math.min(img.width, Math.ceil((s[a + 1] - f.orthoSMin) / f.pixel));
        const y0 = Math.max(0, Math.floor((f.orthoTMax - t[b + 1]) / f.pixel)), y1 = Math.min(img.height, Math.ceil((f.orthoTMax - t[b]) / f.pixel));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * img.width + x) * 4;
            all++;
            if (img.rgba[i + 3] && !(uncovered ? uncovered[i >> 2] : img.rgba[i] === 128 && img.rgba[i + 1] === 128 && img.rgba[i + 2] === 128)) { sum += 0.3 * img.rgba[i] + 0.59 * img.rgba[i + 1] + 0.11 * img.rgba[i + 2]; n++; }
        }
        if (n) lum[b * ns + a] = sum / n;
        if (all && n >= P.minCellPhotoShare * all) built[b * ns + a] = 1;
    }
    const raw = bucket.map(b => (b.length >= P.minSamples ? median(b) : NaN));
    // the wall's outline: each row from its first to its last texel the photo reached (the whole rectangle without a mask); a stepped
    // wall's rectangle holds the air beside its setbacks
    const rowSpan = Array.from({ length: img.height }, (_, y) => {
        if (!uncovered) return [0, img.width - 1];
        let a = -1, b = -1;
        for (let x = 0; x < img.width; x++) if (!uncovered[y * img.width + x] && img.rgba[(y * img.width + x) * 4 + 3]) { if (a < 0) a = x; b = x; }
        return [a, b];
    });
    const inOutline = (a: number, b: number) => {
        const cx = Math.floor(((s[a] + s[a + 1]) / 2 - f.orthoSMin) / f.pixel), cy = Math.floor((f.orthoTMax - (t[b] + t[b + 1]) / 2) / f.pixel);
        const span = rowSpan[Math.min(img.height - 1, Math.max(0, cy))];
        return span[0] >= 0 && cx >= span[0] && cx <= span[1];
    };
    // the share of the outline's area the scan measures (by area, not by cell count: the lines a bay grammar draws make thin
    // cells, and their number says nothing of how much of the wall is measured)
    let measuredArea = 0, outlineArea = 0;
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        if (!inOutline(a, b)) continue;
        const A = (s[a + 1] - s[a]) * (t[b + 1] - t[b]);
        outlineArea += A;
        if (Number.isFinite(raw[b * ns + a])) measuredArea += A;
    }
    const measured = outlineArea > 0 ? measuredArea / outlineArea : 0;
    if (!(measured >= P.minMeasuredShare)) return undefined;
    // the whole wall (pipeline K): a cell the photo did not reach is rebuilt too where the scan measures the wall there and the cell
    // lies inside the wall's outline (each row from its first to its last texel the photo reached), its texture the facade's own
    // fill (generated); where the scan has no wall near the plane (a recess, another wall behind) nothing is built
    if (buildWhereMeasured && uncovered) for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        const k = b * ns + a;
        if (!built[k] && Number.isFinite(raw[k]) && inOutline(a, b)) built[k] = 1;
    }
    // a cell whose scan lies further behind the plane than any recess (minDepthM) is another surface: the wall behind a setback,
    // or the air beside it with the tower behind seen through it. Rebuilt, it became a box minDepthM deep wearing the photo of
    // what lies behind; it keeps the scan instead
    for (let k = 0; k < ns * nt; k++) if (built[k] && Number.isFinite(raw[k]) && raw[k] < P.minDepthM) built[k] = 0;
    // repeats averaged: per row, the windows (read in rows and columns) and the wall each take their median depth
    const win = fitted?.length ? fittedCells(s, t, fitted) : windowGrid(lum, ns, nt);
    const strip = strips.length ? fittedCells(s, t, strips) : undefined;
    const depth: number[][] = [];
    const rowMeds: number[] = [];
    let photoRecessCells = 0, stripCells = 0;
    const windows = new Uint8Array(ns * nt);
    const clamp = (v: number) => Math.min(P.maxDepthM, Math.max(P.minDepthM, v));
    // strips: one recess for the facade, from its windows' contrast against the wall outside every strip (a row of spandrels
    // has no window of its own to read it from)
    let stripR: number | undefined;
    if (strip) {
        const all = Array.from({ length: ns * nt }, (_, k) => k);
        const wallLum = median(all.filter(k => !strip[k] && !win[k]).map(k => lum[k]).filter(Number.isFinite));
        const openLum = median(all.filter(k => win[k]).map(k => lum[k]).filter(Number.isFinite));
        stripR = wallLum > 0 && Number.isFinite(openLum) ? (recessM !== undefined ? recessM : photoRecessDepth(1 - openLum / wallLum)) : undefined;
    }
    // the structure's relief over the bays: the scan's, when it resolves one, else the recess the photo (or Street View) gives,
    // else a plausible one
    let structure: FacadeLatticeResult['structure'];
    if (strip) {
        const cells = Uint8Array.from({ length: ns * nt }, (_, k) => (built[k] && !strip[k] && !win[k] ? 1 : 0));
        // measured on the scan before its walls were flattened (reliefSamples) when given: the flattened scan has no relief left
        const rawR = reliefSamples ? (() => { const bk: number[][] = Array.from({ length: ns * nt }, () => []); for (let i = 0; i < reliefSamples.length; i += 3) { const a = cellOf(reliefSamples[i], s), b = cellOf(reliefSamples[i + 1], t); if (a >= 0 && b >= 0) bk[b * ns + a].push(reliefSamples[i + 2]); } return bk.map(v => (v.length >= P.minSamples ? median(v) : NaN)); })() : raw;
        const stat = (keep: (k: number) => boolean) => {
            const v = rawR.filter((x, k) => keep(k) && Number.isFinite(x));
            if (v.length < P.minSamples) return undefined;
            const m = median(v), mad = median(v.map(x => Math.abs(x - m)));
            return { m, se: (1.4826 * mad) / Math.sqrt(v.length) };
        };
        const pier = stat(k => !strip[k] && !win[k]), bay = stat(k => !!strip[k] && !win[k]);
        const diff = pier && bay ? pier.m - bay.m : NaN, se = pier && bay ? Math.hypot(pier.se, bay.se) : NaN;
        if (diff >= STRUCTURE.minReliefM && diff >= 2 * se) structure = { cells, reliefM: diff, reliefFrom: 'measured', reason: `the scan's piers ${Math.round(diff * 100)} cm proud of its bays (median of each, +-${Math.round(se * 100)} cm)` };
        else if (stripR !== undefined) structure = { cells, reliefM: stripR, reliefFrom: 'photo-inferred', reason: `the scan resolves no pier-to-bay depth (${Number.isFinite(diff) ? `${Math.round(diff * 100)} +- ${Math.round(se * 100)} cm` : 'too few samples'}); ${recessM !== undefined ? "Street View's window reveals" : "the photometric relief's contrast rule"} gives ${Math.round(stripR * 100)} cm` };
        else structure = { cells, reliefM: STRUCTURE.defaultReliefM, reliefFrom: 'generated', reason: `neither the scan (${Number.isFinite(diff) ? `${Math.round(diff * 100)} +- ${Math.round(se * 100)} cm` : 'too few samples'}) nor the photo's contrast gives a pier-to-bay depth; a plausible ${STRUCTURE.defaultReliefM * 100} cm` };
        stripR = structure.reliefM;
    }
    for (let b = 0; b < nt; b++) {
        if (strip) {
            const cells = Array.from({ length: ns }, (_, a) => b * ns + a);
            const rowMed = median(cells.map(k => raw[k]).filter(Number.isFinite));
            rowMeds.push(rowMed);
            const wall0 = median(cells.filter(k => !strip[k] && !win[k]).map(k => raw[k]).filter(Number.isFinite));
            const wall = Number.isFinite(wall0) ? wall0 : Number.isFinite(rowMed) ? rowMed : 0;
            for (const k of cells) if (win[k] && built[k]) windows[k] = 1;
            depth.push(cells.map(k => {
                if (stripR === undefined || !(strip[k] || win[k])) return clamp(wall);
                if (built[k]) { stripCells++; if (win[k]) photoRecessCells++; }
                // a window never shallower than the scan measures it
                return clamp(win[k] ? Math.min(wall - stripR - WINDOW_STRIPS.windowInsetM, Number.isFinite(raw[k]) ? raw[k] : Infinity) : wall - stripR);
            }));
            continue;
        }
        const cells = Array.from({ length: ns }, (_, a) => b * ns + a);
        const dark = cells.filter(k => win[k]), light = cells.filter(k => !win[k]);
        let dm = median(dark.map(k => raw[k]).filter(Number.isFinite));
        const lm = median(light.map(k => raw[k]).filter(Number.isFinite));
        const rowMed = median(cells.map(k => raw[k]).filter(Number.isFinite));
        rowMeds.push(rowMed);
        // pipeline K: the row's repeated openings recessed as the photo shows them, unless the scan measures them deeper
        let recessed = false;
        if (dark.length >= PHOTO_RECESS.minRepeats) {
            const wall = Number.isFinite(lm) ? lm : rowMed, wallLum = median(light.map(k => lum[k]).filter(Number.isFinite));
            const contrast = wallLum > 0 ? 1 - median(dark.map(k => lum[k])) / wallLum : 0;
            for (const k of dark) if (built[k]) windows[k] = 1;
            // the depth read from Street View (reveal-depth.ts) where there is one, else the photo's contrast rule
            const r = photoRecess && wallLum > 0 && Number.isFinite(wall) ? (recessM !== undefined ? recessM : photoRecessDepth(contrast)) : undefined;
            if (r !== undefined && !(dm <= wall - r)) { dm = wall - r; recessed = true; }
        }
        depth.push(cells.map(k => clamp(Number.isFinite(win[k] ? dm : lm) ? (win[k] ? dm : lm) : Number.isFinite(rowMed) ? rowMed : 0)));
        if (recessed) photoRecessCells += dark.filter(k => built[k]).length;
    }
    // the surface: one face per cell, step faces between cells
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    const W = img.width * f.pixel, H = img.height * f.pixel;
    const world = (sv: number, tv: number, d: number) => [0, 1, 2].map(k => f.centroid[k] + sv * f.axisS[k] + tv * f.axisT[k] + d * f.normal[k]);
    // texels by the plane's frame; a side face passes where its points read the photo (unfolded), else it would take one texel line
    const quad = (pts: Array<[number, number, number]>, n: number[], at: (sv: number, tv: number, d: number) => [number, number] = (sv, tv) => [sv, tv]) => {
        const base = pos.length / 3;
        for (const [sv, tv, d] of pts) { const [us, ut] = at(sv, tv, d); pos.push(...world(sv, tv, d)); nrm.push(...n); uv.push((us - f.orthoSMin) / W, (f.orthoTMax - ut) / H); }
        // wound counter-clockwise seen from the side n points to
        const p = (i: number) => pos.slice((base + i) * 3, (base + i) * 3 + 3), o = p(0), e1 = p(1).map((x, k) => x - o[k]), e2 = p(2).map((x, k) => x - o[k]);
        const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (dot(g, n) < 0) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
        else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const N = f.normal, S = f.axisS, T = f.axisT, neg = (v: number[]) => v.map(x => -x);
    // a side face on line s = sv between depth L (the smaller-s side) and R, wound to face the side it shows to (S x T = N); its
    // texels unfold into the recessed side's photo, from the edge (the front depth) inward as far as the face is deep, so a
    // reveal shows the photo beside the opening rather than one column of texels drawn across it
    // with the structure, a step at least twice chamferM deep has its front edge chamfered at 45 degrees: the chamfer leans over
    // the recessed side by c and the side face below it starts c into it, so the stone's arris catches the light (STRUCTURE)
    const bevelOf = (L: number, R: number) => (structure && Math.abs(L - R) >= 2 * STRUCTURE.chamferM ? STRUCTURE.chamferM : 0);
    const unit = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]); return v.map(x => x / l); };
    const sideS = (sv: number, t0: number, t1: number, L: number, R: number) => {
        if (!(Math.abs(L - R) > P.stepM)) return;
        const front = Math.max(L, R), back = Math.min(L, R), into = L < R ? -1 : 1, c = bevelOf(L, R), sb = sv + into * c;
        const at = (sx: number, tv: number, d: number): [number, number] => [sx + into * (front - d), tv];
        if (c) {
            // the bevel, facing out and over the recess (N + into S)
            if (L > R) quad([[sv, t0, front], [sb, t0, front - c], [sb, t1, front - c], [sv, t1, front]], unit(N.map((x, k) => x + into * S[k])), at);
            else quad([[sv, t0, front], [sv, t1, front], [sb, t1, front - c], [sb, t0, front - c]], unit(N.map((x, k) => x + into * S[k])), at);
        }
        const top = front - c;
        if (L > R) quad([[sb, t0, back], [sb, t1, back], [sb, t1, top], [sb, t0, top]], S, at);
        else quad([[sb, t0, top], [sb, t0, back], [sb, t1, back], [sb, t1, top]], neg(S), at);
    };
    // on line t = tv between depth B (the smaller-t side, below) and A
    const sideT = (tv: number, s0: number, s1: number, B: number, A: number) => {
        if (!(Math.abs(B - A) > P.stepM)) return;
        const front = Math.max(B, A), back = Math.min(B, A), into = B < A ? -1 : 1, c = bevelOf(B, A), tb = tv + into * c;
        const at = (sv: number, ty: number, d: number): [number, number] => [sv, ty + into * (front - d)];
        if (c) {
            if (B > A) quad([[s0, tv, front], [s1, tv, front], [s1, tb, front - c], [s0, tb, front - c]], unit(N.map((x, k) => x + into * T[k])), at);
            else quad([[s0, tv, front], [s0, tb, front - c], [s1, tb, front - c], [s1, tv, front]], unit(N.map((x, k) => x + into * T[k])), at);
        }
        const top = front - c;
        if (B > A) quad([[s0, tb, back], [s0, tb, top], [s1, tb, top], [s1, tb, back]], T, at);
        else quad([[s0, tb, top], [s1, tb, top], [s1, tb, back], [s0, tb, back]], neg(T), at);
    };
    // where the scan stands beside a rebuilt cell (a neighbour left as scan): its measured depth, else its row's; NaN when the
    // scan measures nothing there, or another surface further behind than any recess (no face is drawn). Past the lattice's outer edge nothing is drawn: the neighbouring facade or
    // the scan closes the corner, and a face back to the edge cell's own depth would lie on that facade's plane, over its pier
    const scanDepthAt = (a: number, b: number) => { const v = raw[b * ns + a]; return Number.isFinite(v) ? (v < P.minDepthM ? NaN : clamp(v)) : Number.isFinite(rowMeds[b]) ? clamp(rowMeds[b]) : NaN; };
    const isBuilt = (a: number, b: number) => a >= 0 && b >= 0 && a < ns && b < nt && !!built[b * ns + a];
    const beside = (na: number, nb: number) => isBuilt(na, nb) ? depth[nb][na] : na >= 0 && nb >= 0 && na < ns && nb < nt ? scanDepthAt(na, nb) : NaN;
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        // a cell the photo does not cover keeps the scan
        if (!built[b * ns + a]) continue;
        const d = depth[b][a];
        // counter-clockwise seen from outside (along +normal): s right, t up
        quad([[s[a], t[b], d], [s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a], t[b + 1], d]], N);
        // reveals: to every side, toward a rebuilt cell (drawn once, from its smaller-s or smaller-t side) or toward the scan
        sideS(s[a + 1], t[b], t[b + 1], d, beside(a + 1, b));
        if (!isBuilt(a - 1, b)) sideS(s[a], t[b], t[b + 1], beside(a - 1, b), d);
        sideT(t[b + 1], s[a], s[a + 1], d, beside(a, b + 1));
        if (!isBuilt(a, b - 1)) sideT(t[b], s[a], s[a + 1], beside(a, b - 1), d);
    }
    if (!built.some(v => v)) return undefined;
    return { facadeId: f.facadeId, s, t, cells: built.reduce((x, v) => x + v, 0), measuredShare: Math.round(measured * 1000) / 1000, depth, ...(photoRecess ? { photoRecessCells } : {}), ...(strips.length ? { strips, stripCells } : {}), ...(structure ? { structure } : {}), built, windows, cellU: s.map(v => (v - f.orthoSMin) / (img.width * f.pixel)), cellV: t.map(v => (f.orthoTMax - v) / (img.height * f.pixel)), positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

// ---------------------------------------------------------------------------------------------------------------
// GLB editing: the facade's scan triangles made degenerate, the rebuilt facade appended
// ---------------------------------------------------------------------------------------------------------------

/**
 * The structure for the GLB extras (sbFacadeLattice.structure): its cells as runs along each row, u0 v0 u1 v1 in the photo's
 * UVs (v down from the top), the bays it frames (the window strips) in the same UVs, with its relief, where that came from, and the chamfer; the outline photo-inferred (read from
 * the window fit's bays).
 */
export function structureExtras(r: FacadeLatticeResult): { uv: number[]; bays: number[]; reliefM: number; reliefFrom: string; reason: string; chamferM: number; label: string } | undefined {
    if (!r.structure) return undefined;
    const ns = r.s.length - 1, nt = r.t.length - 1, uv: number[] = [];
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        if (!r.structure.cells[b * ns + a] || (a > 0 && r.structure.cells[b * ns + a - 1])) continue;
        let e = a;
        while (e + 1 < ns && r.structure.cells[b * ns + e + 1]) e++;
        uv.push(r.cellU[a], r.cellV[b + 1], r.cellU[e + 1], r.cellV[b]);
    }
    // the bays it frames (the window strips, [s0, t0, s1, t1] in the plane's frame) in the same UVs: u and v run linearly with s and t
    const sN = r.s.length - 1, tN = r.t.length - 1;
    const uOf = (sv: number) => r.cellU[0] + ((sv - r.s[0]) / (r.s[sN] - r.s[0])) * (r.cellU[sN] - r.cellU[0]);
    const vOf = (tv: number) => r.cellV[0] + ((tv - r.t[0]) / (r.t[tN] - r.t[0])) * (r.cellV[tN] - r.cellV[0]);
    const bays = (r.strips ?? []).flatMap(([s0, t0, s1, t1]) => [uOf(s0), vOf(t1), uOf(s1), vOf(t0)]);
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    return { uv: uv.map(r4), bays: bays.map(r4), reliefM: Math.round(r.structure.reliefM * 1000) / 1000, reliefFrom: r.structure.reliefFrom, reason: r.structure.reason, chamferM: STRUCTURE.chamferM, label: 'photo-inferred' };
}

/**
 * The lattice's window cells for the GLB extras (sbFacadeLattice.windowCells): its cell lines in the photo's UVs and the
 * window cells' indices (row-major, row b from the bottom, column a), labelled photo-inferred.
 */
export interface WindowCellsExtras { u: number[]; v: number[]; cells: number[]; label: 'photo-inferred'; source: string }
export function windowCellsExtras(r: Pick<FacadeLatticeResult, 'windows' | 'cellU' | 'cellV'>): WindowCellsExtras {
    const cells: number[] = [];
    for (let k = 0; k < r.windows.length; k++) if (r.windows[k]) cells.push(k);
    const q = (v: number) => Math.round(v * 1e5) / 1e5;
    return { u: r.cellU.map(q), v: r.cellV.map(q), cells, label: 'photo-inferred', source: 'the straightened photo read in rows and columns: a darker column crossing a darker row, the cell darker than the wall' };
}

/** Triangle soup (world) of every triangle primitive of a GLB without node transforms (tile_refine writes none). */
export function glbSoup(glb: ParsedGlb): Float32Array {
    const prims: Array<{ P: ArrayLike<number>; I: ArrayLike<number> | undefined; n: number }> = [];
    for (const m of glb.json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
        const P = readAccessor(glb, p.attributes.POSITION).data, I = p.indices !== undefined ? readAccessor(glb, p.indices).data : undefined;
        prims.push({ P, I, n: Math.floor((I ? I.length : P.length / 3) / 3) * 3 });
    }
    // sized up front: a district's soup outgrows a plain array
    const out = new Float32Array(prims.reduce((a, q) => a + q.n * 3, 0));
    let o = 0;
    for (const { P, I, n } of prims) for (let j = 0; j < n; j++) { const v = I ? I[j] : j; out[o++] = P[v * 3]; out[o++] = P[v * 3 + 1]; out[o++] = P[v * 3 + 2]; }
    return out;
}

/** Is a triangle (world corners) a candidate of facade f's rebuilt region: facing it (or a sliver), its centre within the depth band. */
function facesFacade(a: number[], b: number[], c: number[], f: ReliefFacade, P = FACADE_LATTICE_PARAMS): boolean {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
    const m = [(a[0] + b[0] + c[0]) / 3 - f.centroid[0], (a[1] + b[1] + c[1]) / 3 - f.centroid[1], (a[2] + b[2] + c[2]) / 3 - f.centroid[2]];
    if (Math.abs(dot(m, f.normal)) > P.depthBandM) return false;
    // a facing triangle, or a sliver (the reveals of the scan's lumps): both are the facade's
    return !(nl > 0) || Math.abs(dot([nx / nl, ny / nl, nz / nl], f.normal)) >= 0.3;
}

/** Does a triangle's centre fall inside a facade's lattice rectangle (in its plane's s and t). */
function centreInRect(a: number[], b: number[], c: number[], x: { f: ReliefFacade; r: FacadeLatticeResult }): boolean {
    const m = [(a[0] + b[0] + c[0]) / 3 - x.f.centroid[0], (a[1] + b[1] + c[1]) / 3 - x.f.centroid[1], (a[2] + b[2] + c[2]) / 3 - x.f.centroid[2]];
    const sv = dot(m, x.f.axisS), tv = dot(m, x.f.axisT);
    return sv >= x.r.s[0] && sv <= x.r.s[x.r.s.length - 1] && tv >= x.r.t[0] && tv <= x.r.t[x.r.t.length - 1];
}

const cellIndex = (v: number, edges: number[]) => { let lo = 0, hi = edges.length - 1; while (hi - lo > 1) { const k = (lo + hi) >> 1; if (edges[k] <= v) lo = k; else hi = k; } return lo; };

/** Does a rebuilt cell of facade (f, r) stand in front of or behind a world point: the point over a built cell, within the depth band. */
function overBuilt(x: number, y: number, z: number, f: ReliefFacade, r: FacadeLatticeResult, P = FACADE_LATTICE_PARAMS): boolean {
    const m = [x - f.centroid[0], y - f.centroid[1], z - f.centroid[2]];
    const d = dot(m, f.normal), sv = dot(m, f.axisS), tv = dot(m, f.axisT), eps = 1e-4;
    if (Math.abs(d) > P.depthBandM || sv < r.s[0] - eps || sv > r.s[r.s.length - 1] + eps || tv < r.t[0] - eps || tv > r.t[r.t.length - 1] + eps) return false;
    return !!r.built[cellIndex(tv, r.t) * (r.s.length - 1) + cellIndex(sv, r.s)];
}

/**
 * Is the whole of a triangle covered by rebuilt cells (of any facade): sampled at most every sampleM over its area, every
 * sample over a built cell. A triangle only partly over the rebuilt surface is kept, so removing it never opens a tear.
 */
function coveredByRebuild(a: number[], b: number[], c: number[], facades: Array<{ f: ReliefFacade; r: FacadeLatticeResult }>, P = FACADE_LATTICE_PARAMS): boolean {
    const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2])) / P.sampleM)));
    for (let p = 0; p <= steps; p++) for (let q = 0; p + q <= steps; q++) {
        const u = p / steps, v = q / steps;
        const x = a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, y = a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, z = a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v;
        if (!facades.some(e => overBuilt(x, y, z, e.f, e.r, P))) return false;
    }
    return true;
}

/**
 * The outermost surface of a triangle soup seen straight on along facade f's normal, over the facade's lattice rectangle at
 * `px`: per pixel the largest depth d (toward the outside, at most maxDepth) of any triangle covering it, -Infinity where none
 * does. `live` leaves out triangles (by soup index) when given.
 */
function outermostDepth(soup: Float32Array, f: ReliefFacade, r: Pick<FacadeLatticeResult, 's' | 't'>, px: number, live?: Uint8Array, maxDepth = Infinity): { W: number; H: number; s0: number; t0: number; depth: Float32Array } {
    const s0 = r.s[0], t0 = r.t[0], W = Math.max(1, Math.ceil((r.s[r.s.length - 1] - s0) / px)), H = Math.max(1, Math.ceil((r.t[r.t.length - 1] - t0) / px));
    const depth = new Float32Array(W * H).fill(-Infinity);
    // the facade's world box (its lattice rectangle, the depth band and a metre either side): a district soup is mostly elsewhere
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], reach = FACADE_LATTICE_PARAMS.depthBandM + 1;
    for (const sv of [s0, r.s[r.s.length - 1]]) for (const tv of [t0, r.t[r.t.length - 1]]) for (const dv of [-reach, reach]) for (let k = 0; k < 3; k++) {
        const w = f.centroid[k] + sv * f.axisS[k] + tv * f.axisT[k] + dv * f.normal[k];
        lo[k] = Math.min(lo[k], w - 0.01); hi[k] = Math.max(hi[k], w + 0.01);
    }
    for (let i = 0, k = 0; i + 8 < soup.length; i += 9, k++) {
        if (live && !live[k]) continue;
        let outside = false;
        for (let a = 0; a < 3 && !outside; a++) outside = Math.max(soup[i + a], soup[i + 3 + a], soup[i + 6 + a]) < lo[a] || Math.min(soup[i + a], soup[i + 3 + a], soup[i + 6 + a]) > hi[a];
        if (outside) continue;
        const S = [0, 0, 0], T = [0, 0, 0], D = [0, 0, 0];
        for (let j = 0; j < 3; j++) {
            const m = [soup[i + 3 * j] - f.centroid[0], soup[i + 3 * j + 1] - f.centroid[1], soup[i + 3 * j + 2] - f.centroid[2]];
            S[j] = (dot(m, f.axisS) - s0) / px - 0.5; T[j] = (dot(m, f.axisT) - t0) / px - 0.5; D[j] = dot(m, f.normal);
        }
        const area = (S[1] - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (T[1] - T[0]);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.ceil(Math.min(...S))), x1 = Math.min(W - 1, Math.floor(Math.max(...S))), y0 = Math.max(0, Math.ceil(Math.min(...T))), y1 = Math.min(H - 1, Math.floor(Math.max(...T)));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const w1 = ((x - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (y - T[0])) / area, w2 = ((S[1] - S[0]) * (y - T[0]) - (x - S[0]) * (T[1] - T[0])) / area, w0 = 1 - w1 - w2;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const d = w0 * D[0] + w1 * D[1] + w2 * D[2], o = y * W + x;
            if (d > depth[o] && d <= maxDepth) depth[o] = d;
        }
    }
    return { W, H, s0, t0, depth };
}

/** A view of a facade's lattice from an angle: the facade's frame turned by yaw about its up axis, then pitch about its along axis. */
interface AuditView { c: number[]; S: number[]; T: number[]; N: number[]; s0: number; s1: number; t0: number; t1: number }
function obliqueViews(f: ReliefFacade, r: Pick<FacadeLatticeResult, 's' | 't'>, P = FACADE_LATTICE_PARAMS): AuditView[] {
    const turn = (a: number[], b: number[], deg: number) => { const c = Math.cos((deg * Math.PI) / 180), si = Math.sin((deg * Math.PI) / 180); return [a.map((v, k) => c * v + si * b[k]), b.map((v, k) => c * v - si * a[k])]; };
    const out: AuditView[] = [];
    const box: number[][] = [];
    for (const sv of [r.s[0], r.s[r.s.length - 1]]) for (const tv of [r.t[0], r.t[r.t.length - 1]]) for (const dv of [-P.depthBandM, P.depthBandM]) box.push([0, 1, 2].map(k => sv * f.axisS[k] + tv * f.axisT[k] + dv * f.normal[k]));
    for (const [yaw, pitch] of [[P.auditYawDeg, 0], [-P.auditYawDeg, 0], [0, P.auditPitchDeg], [0, -P.auditPitchDeg]]) {
        // yaw: normal toward +S; pitch: normal toward +T
        let N = f.normal, S = f.axisS, T = f.axisT;
        if (yaw) [N, S] = turn(N, S, yaw);
        if (pitch) [N, T] = turn(N, T, pitch);
        const ss = box.map(q => dot(q, S)), ts = box.map(q => dot(q, T));
        out.push({ c: f.centroid, S, T, N, s0: Math.min(...ss), s1: Math.max(...ss), t0: Math.min(...ts), t1: Math.max(...ts) });
    }
    return out;
}

/**
 * The outermost surface seen from an angled view (depth along the view's normal), and where that surface lies against the
 * facade's own plane (its distance along the facade normal), over the facade's world box.
 */
function obliqueDepth(soup: Float32Array, f: ReliefFacade, v: AuditView, px: number, live?: Uint8Array): { W: number; H: number; s0: number; t0: number; depth: Float32Array; onPlane: Float32Array; view: AuditView } {
    const W = Math.max(1, Math.ceil((v.s1 - v.s0) / px)), H = Math.max(1, Math.ceil((v.t1 - v.t0) / px));
    const depth = new Float32Array(W * H).fill(-Infinity), onPlane = new Float32Array(W * H).fill(NaN);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], reach = FACADE_LATTICE_PARAMS.depthBandM + 1;
    for (const sv of [v.s0, v.s1]) for (const tv of [v.t0, v.t1]) for (const dv of [-reach, reach]) for (let k = 0; k < 3; k++) {
        const w = v.c[k] + sv * v.S[k] + tv * v.T[k] + dv * v.N[k];
        lo[k] = Math.min(lo[k], w - 0.01); hi[k] = Math.max(hi[k], w + 0.01);
    }
    for (let i = 0, k = 0; i + 8 < soup.length; i += 9, k++) {
        if (live && !live[k]) continue;
        let outside = false;
        for (let a = 0; a < 3 && !outside; a++) outside = Math.max(soup[i + a], soup[i + 3 + a], soup[i + 6 + a]) < lo[a] || Math.min(soup[i + a], soup[i + 3 + a], soup[i + 6 + a]) > hi[a];
        if (outside) continue;
        const S = [0, 0, 0], T = [0, 0, 0], D = [0, 0, 0], F = [0, 0, 0];
        for (let j = 0; j < 3; j++) {
            const m = [soup[i + 3 * j] - v.c[0], soup[i + 3 * j + 1] - v.c[1], soup[i + 3 * j + 2] - v.c[2]];
            S[j] = (dot(m, v.S) - v.s0) / px - 0.5; T[j] = (dot(m, v.T) - v.t0) / px - 0.5; D[j] = dot(m, v.N); F[j] = dot(m, f.normal);
        }
        const area = (S[1] - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (T[1] - T[0]);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.ceil(Math.min(...S))), x1 = Math.min(W - 1, Math.floor(Math.max(...S))), y0 = Math.max(0, Math.ceil(Math.min(...T))), y1 = Math.min(H - 1, Math.floor(Math.max(...T)));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const w1 = ((x - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (y - T[0])) / area, w2 = ((S[1] - S[0]) * (y - T[0]) - (x - S[0]) * (T[1] - T[0])) / area, w0 = 1 - w1 - w2;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const d = w0 * D[0] + w1 * D[1] + w2 * D[2], o = y * W + x;
            if (d > depth[o]) { depth[o] = d; onPlane[o] = w0 * F[0] + w1 * F[1] + w2 * F[2]; }
        }
    }
    return { W, H, s0: v.s0, t0: v.t0, depth, onPlane, view: v };
}

/** Tears seen from an angle: the scan's outermost surface there lies on the facade (within its depth band) and the result shows something farther back. */
function obliqueTearPixels(before: ReturnType<typeof obliqueDepth>, after: ReturnType<typeof obliqueDepth>, P = FACADE_LATTICE_PARAMS): number[] {
    const out: number[] = [];
    for (let o = 0; o < before.depth.length; o++) if (Number.isFinite(before.depth[o]) && Math.abs(before.onPlane[o]) <= P.depthBandM && !(after.depth[o] >= before.depth[o] - P.tearDepthM)) out.push(o);
    return out;
}

/**
 * Tears a rebuild opened in facade f: pixels (seen straight on, over its lattice) where the scan had surface within the
 * depth band (`before` is capped at the band: a wall far in front belongs to another facade) and the result has none in front of the band's back (only the inside of the building, or nothing, shows through).
 */
function tearPixels(before: ReturnType<typeof outermostDepth>, after: ReturnType<typeof outermostDepth>, P = FACADE_LATTICE_PARAMS): number[] {
    const out: number[] = [];
    for (let o = 0; o < before.depth.length; o++) if (before.depth[o] >= -P.depthBandM && !(after.depth[o] >= -P.depthBandM - P.tearDepthM)) out.push(o);
    return out;
}

/** The GLB's binary chunk grown by appending chunks: byte for byte in a plain array, a district's remesh outgrows V8's array limit (~134 M elements). */
class BinBuilder {
    readonly chunks: Uint8Array[] = [];
    length = 0;
    push(bytes: Uint8Array): number { const off = this.length; this.chunks.push(bytes); this.length += bytes.length; return off; }
    align4(): void { if (this.length % 4) this.push(new Uint8Array(4 - (this.length % 4))); }
    bytes(): Uint8Array { const out = new Uint8Array(this.length); let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length; } return out; }
}

/**
 * Edits a GLB of the remesh: the facades' scan triangles degenerate, each rebuilt facade appended as a node (`textured`:
 * an unlit material with the facade's orthophoto, as tile_refine's twin is; otherwise the GLB's first material, its clay).
 */
export function applyFacadeLattices(bytes: Uint8Array, facadesIn: Array<{ f: ReliefFacade; r: FacadeLatticeResult; png?: Uint8Array }>, textured: boolean, P = FACADE_LATTICE_PARAMS, opts: { /** false: the scan was already cut to the lattice (pipeline-k/lattice-stitch.ts); only append the rebuilt facades. */ removeScan?: boolean } = {}): { glb: Buffer; removed: number; tears: TearReport } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    // every triangle of the scan, with where its indices live
    const prims: Array<{ I: ArrayLike<number>; base: number; stride: number; size: number; first: number }> = [];
    const pts: number[] = [];
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) continue;
        const Pp = readAccessor(glb, p.attributes.POSITION).data, I = readAccessor(glb, p.indices).data;
        const li = accessorLayout(json, p.indices);
        prims.push({ I, base: li.base, stride: li.stride, size: li.componentType === 5125 ? 4 : li.componentType === 5123 ? 2 : 1, first: pts.length / 9 });
        for (let t = 0; t + 2 < I.length; t += 3) for (let k = 0; k < 3; k++) pts.push(Pp[I[t + k] * 3], Pp[I[t + k] * 3 + 1], Pp[I[t + k] * 3 + 2]);
    }
    const soup = Float32Array.from(pts), nTri = soup.length / 9;
    const corner = (k: number, j: number) => [soup[k * 9 + 3 * j], soup[k * 9 + 3 * j + 1], soup[k * 9 + 3 * j + 2]];
    // 1. removed: a triangle facing a rebuilt facade whose whole area lies over that facade's own rebuilt cells (a parallel plane
    // of another tier never vouches for it); the facade that covers it claims it
    const claim = new Int32Array(nTri).fill(-1);
    const dropped = new Set<number>();
    const decide = () => {
        claim.fill(-1);
        for (let k = 0; k < nTri; k++) {
            const a = corner(k, 0), b = corner(k, 1), c = corner(k, 2);
            // every rebuilt facade the triangle faces, inside that facade's rectangle, must cover it (a corner triangle facing two walls
            // is removed only when both are rebuilt over it: seen from the other wall, one wall's rebuild is edge-on)
            let first = -1, ok = true;
            for (let fi = 0; fi < facadesIn.length && ok; fi++) {
                if (dropped.has(fi) || !facesFacade(a, b, c, facadesIn[fi].f, P) || !centreInRect(a, b, c, facadesIn[fi])) continue;
                if (coveredByRebuild(a, b, c, [facadesIn[fi]], P)) { if (first < 0) first = fi; } else ok = false;
            }
            if (ok && first >= 0) claim[k] = first;
        }
    };
    const keepScan = opts.removeScan === false;
    if (!keepScan) decide();
    // 2. the tear audit, per facade: the scan seen straight on against the result; a tear restores the removed triangles over it
    // (at that facade's depth), and a facade still torn after that is not rebuilt at all (its scan stays whole, the removals are
    // decided again without it), until nothing is torn
    const tears: TearReport = { found: 0, restoredTriangles: 0, droppedFacades: [], left: 0 };
    const resultSoup = (): { soup: Float32Array; live: Uint8Array } => {
        const extra: number[] = [];
        facadesIn.forEach((x, i) => { if (dropped.has(i)) return; for (let q = 0; q < x.r.indices.length; q++) { const v = x.r.indices[q]; extra.push(x.r.positions[v * 3], x.r.positions[v * 3 + 1], x.r.positions[v * 3 + 2]); } });
        const all = new Float32Array(soup.length + extra.length);
        all.set(soup); all.set(extra, soup.length);
        const live = new Uint8Array(all.length / 9).fill(1);
        for (let k = 0; k < nTri; k++) if (claim[k] >= 0) live[k] = 0;
        return { soup: all, live };
    };
    type AuditGrid = { W: number; H: number; s0: number; t0: number; view?: AuditView };
    const audit = (count: boolean): Array<{ fi: number; pix: number[]; grid: AuditGrid; oblique?: boolean }> => {
        const { soup: rs, live } = resultSoup();
        const torn: Array<{ fi: number; pix: number[]; grid: AuditGrid; oblique?: boolean }> = [];
        facadesIn.forEach((x, fi) => {
            const before = outermostDepth(soup, x.f, x.r, P.auditPixelM, undefined, P.depthBandM), after = outermostDepth(rs, x.f, x.r, P.auditPixelM, live);
            const pix = tearPixels(before, after, P);
            if (pix.length) torn.push({ fi, pix, grid: before });
            if (count) tears.found += pix.length;
            // the same facade from four angles: slits at recess sides and edges show only obliquely
            if (dropped.has(fi)) return;
            for (const v of obliqueViews(x.f, x.r, P)) {
                const b = obliqueDepth(soup, x.f, v, P.auditPixelM), a = obliqueDepth(rs, x.f, v, P.auditPixelM, live);
                const op = obliqueTearPixels(b, a, P);
                if (op.length) torn.push({ fi, pix: op, grid: b, oblique: true });
                if (count) { tears.found += op.length; tears.oblique = (tears.oblique ?? 0) + op.length; }
            }
        });
        return torn;
    };
    let torn = keepScan ? [] : audit(true);
    // restore: every removed triangle whose footprint (seen straight on, at that facade's depth) touches a torn pixel or its
    // neighbours, up to three rounds; then a facade whose own frame is still torn by its own removals is not rebuilt
    const restore = (list: typeof torn): number => {
        let n = 0;
        for (const { fi, pix, grid } of list) {
            const f = facadesIn[fi].f, mark = new Uint8Array(grid.W * grid.H);
            // the frame the torn pixels were seen in: the facade straight on, or one of its angled views
            const fc = grid.view?.c ?? f.centroid, fS = grid.view?.S ?? f.axisS, fT = grid.view?.T ?? f.axisT;
            for (const o of pix) { const x = o % grid.W, y = Math.floor(o / grid.W); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < grid.W && yy < grid.H) mark[yy * grid.W + xx] = 1; } }
            for (let k = 0; k < nTri; k++) {
                if (claim[k] < 0) continue;
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, near = false;
                for (let j = 0; j < 3; j++) {
                    const m = [soup[k * 9 + 3 * j] - fc[0], soup[k * 9 + 3 * j + 1] - fc[1], soup[k * 9 + 3 * j + 2] - fc[2]];
                    if (Math.abs(dot(m, f.normal)) <= P.depthBandM + P.tearDepthM) near = true;
                    const x = (dot(m, fS) - grid.s0) / P.auditPixelM, y = (dot(m, fT) - grid.t0) / P.auditPixelM;
                    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                }
                if (!near || x1 < 0 || y1 < 0 || x0 >= grid.W || y0 >= grid.H) continue;
                let hit = false;
                for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(grid.H - 1, Math.floor(y1)) && !hit; y++) for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(grid.W - 1, Math.floor(x1)) && !hit; x++) if (mark[y * grid.W + x]) hit = true;
                if (hit) { claim[k] = -1; n++; }
            }
        }
        return n;
    };
    for (let round = 0; torn.length && round < 3; round++) {
        tears.restoredTriangles += restore(torn);
        torn = audit(false);
    }
    // still torn straight on: the facades whose own removals lie under a torn pixel are not rebuilt, and the removals are decided
    // again. A tear seen only from an angle restores the scan behind it but drops no facade: some angled slits are the rebuilt
    // geometry's own (a recess side drawn only toward built cells), which no scan triangle closes
    const straight = (list: typeof torn) => list.filter(x => !x.oblique);
    for (let round = 0; straight(torn).length && round < 4; round++) {
        for (const { fi } of straight(torn)) if (!dropped.has(fi)) { dropped.add(fi); tears.droppedFacades.push(facadesIn[fi].f.facadeId); }
        decide();
        torn = audit(false);
        if (torn.length) { tears.restoredTriangles += restore(torn); torn = audit(false); }
    }
    tears.left = straight(torn).reduce((a, x) => a + x.pix.length, 0);
    tears.obliqueLeft = torn.filter(x => x.oblique).reduce((a, x) => a + x.pix.length, 0);
    // the last resort: anything still torn straight on means no facade is rebuilt (the scan is shown whole, as it came)
    if (tears.left) { facadesIn.forEach((x, fi) => { if (!dropped.has(fi)) { dropped.add(fi); tears.droppedFacades.push(x.f.facadeId); } }); decide(); tears.left = straight(audit(false)).reduce((a, x) => a + x.pix.length, 0); }
    // 3. the removals written: a removed triangle made degenerate in place
    let removed = 0;
    for (const pr of prims) for (let t = 0; t + 2 < pr.I.length; t += 3) {
        if (claim[pr.first + t / 3] < 0) continue;
        for (const e of [t + 1, t + 2]) { const o = pr.base + e * pr.stride; if (pr.size === 4) dv.setUint32(o, pr.I[t], true); else if (pr.size === 2) dv.setUint16(o, pr.I[t], true); else dv.setUint8(o, pr.I[t]); }
        removed++;
    }
    const facades = facadesIn.filter((_, i) => !dropped.has(i));
    // the edited bytes (edited in place through dv) first, the rebuilt facades appended after them
    const bin = new BinBuilder();
    bin.push(glb.bin);
    json.bufferViews ??= []; json.accessors ??= []; json.meshes ??= []; json.nodes ??= []; json.materials ??= [];
    const view = (bytesArr: Uint8Array, target?: number) => { bin.align4(); const off = bin.push(Uint8Array.from(bytesArr)); json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: bytesArr.length, ...(target ? { target } : {}) }); return json.bufferViews.length - 1; };
    const f32 = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const scene = json.scenes?.[json.scene ?? 0];
    for (const { f, r, png } of facades) {
        const acc = (bv: number, count: number, type: string, componentType: number, minmax?: { min: number[]; max: number[] }) => { json.accessors.push({ bufferView: bv, componentType, count, type, ...(minmax ?? {}) }); return json.accessors.length - 1; };
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < r.positions.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], r.positions[v + k]); max[k] = Math.max(max[k], r.positions[v + k]); }
        const attributes: Record<string, number> = {
            POSITION: acc(view(f32(r.positions), 34962), r.positions.length / 3, 'VEC3', 5126, { min, max }),
            NORMAL: acc(view(f32(r.normals), 34962), r.normals.length / 3, 'VEC3', 5126)
        };
        let material = 0;
        if (textured && png) {
            attributes.TEXCOORD_0 = acc(view(f32(r.uv), 34962), r.uv.length / 2, 'VEC2', 5126);
            json.images ??= []; json.textures ??= []; json.samplers ??= [];
            json.images.push({ bufferView: view(png), mimeType: 'image/png' });
            json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
            json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1 });
            json.materials.push({ name: `FacadeLattice_${f.facadeId}`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, baseColorTexture: { index: json.textures.length - 1 } }, extensions: { KHR_materials_unlit: {} } });
            material = json.materials.length - 1;
            json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed ?? []), 'KHR_materials_unlit']));
        }
        const indices = acc(view(new Uint8Array(r.indices.buffer, r.indices.byteOffset, r.indices.byteLength), 34963), r.indices.length, 'SCALAR', 5125);
        json.meshes.push({ name: `facade_lattice_${f.facadeId}`, primitives: [{ attributes, indices, material, mode: 4 }] });
        json.nodes.push({ name: `FacadeLattice_${f.facadeId}`, mesh: json.meshes.length - 1, extras: { sbFacadeLattice: { version: FACADE_LATTICE_VERSION, facadeId: f.facadeId, provenance: { lines: 'photo-inferred', depth: r.photoRecessCells ? `measured (median per cell, averaged along the row's repeats); ${r.photoRecessCells} window cells recessed as the straightened photo shows them (photo-inferred, ${r.recessFrom ?? "the photometric relief's contrast rule"})` : 'measured (median per cell, averaged along the row\'s repeats)', texture: f.textureFill || r.repeatTexture ? { photo: 'tile photo', ...(f.textureFill ? { holes: f.textureFill } : {}), ...(r.repeatTexture ? { repeats: r.repeatTexture } : {}) } : 'tile photo' }, cells: r.cells, measuredShare: r.measuredShare, sLines: r.s.length, tLines: r.t.length, ...(r.windows ? { windowCells: windowCellsExtras(r) } : {}), ...(r.fittedWindows ? { windows: { uv: r.fittedWindows, ...(r.fittedPanes ? { panes: r.fittedPanes } : {}), label: 'photo-inferred', source: WINDOW_FIT_VERSION, ...(r.generatedWindows ? { generated: { uv: r.generatedWindows, label: 'generated', source: "the window grid continued into parts the photo never reached (its texture filled from the facade's own repeats)" } } : {}) } } : {}), ...(r.structure ? { structure: structureExtras(r) } : {}) } } });
        scene?.nodes?.push(json.nodes.length - 1);
    }
    bin.align4();
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: bin.length }];
    return { glb: assembleGlb(json, bin.bytes()), removed, tears };
}

/** Rebuilds a remesh's rectified facades on their photo lattices: the clay and (when given) its textured twin. */
/** Cut-and-stitch rounds at most: each leaves as scan the rebuilt cells beside outline edges the stitch could join to nothing. */
const STITCH_ROUNDS = 4;

export function rebuildFacadesOnLattice(clayBytes: Uint8Array, texturedBytes: Uint8Array | undefined, orthosDir: string, P: typeof FACADE_LATTICE_PARAMS = FACADE_LATTICE_PARAMS, skip: Set<number> = new Set(), opts: { /** Pipeline K: the scan cut exactly to the rebuilt cells and stitched to them (pipeline-k/lattice-stitch.ts), instead of whole triangles removed. */ stitch?: boolean; /** Pipeline K: window recesses read from the straightened photo (PHOTO_RECESS), the scan being uncarved. */ photoRecess?: boolean; /** window_fit.json (window-fit.ts): each facade's fitted windows written into its extras. */ windowFit?: string; /** reveal_depth.json (reveal-depth.ts): each facade's window depth read from Street View. */ revealDepth?: string; /** wall_grammar.json (wall-grammar.ts): each facade's bays read per wall. */ wallGrammar?: string; /** The isolated scan before its walls were flattened: where the structure's relief is measured. */ rawScan?: string; /** walls.json (wall-sheets.ts): each multi-facade wall rebuilt once, as one sheet, in place of its facades; and every facade rebuilt whole, where the scan has its wall. */ walls?: string } = {}): { clay: Buffer; textured?: Buffer; stats: { facades: number; rebuilt: number; cells: number; removedTriangles: number; tears: TearReport; stitch?: { cut: CutReport; strips: StitchReport; /** Per round: outline edges joined to nothing, and the cells beside them left as scan for the next round. */ rounds?: Array<{ unjoined: number; cellsLeftAsScan: number }> }; photoRecessCells?: number; perFacade: Array<{ id: number; cells: number; measuredShare: number; lines: [number, number]; photoRecessCells?: number }> } } {
    const facades = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as ReliefFacade[];
    const soup = glbSoup(parseGlbBytes(clayBytes));
    const done: Array<{ f: ReliefFacade; r: FacadeLatticeResult; png: Uint8Array }> = [];
    const fit = opts.windowFit && fs.existsSync(opts.windowFit) ? JSON.parse(fs.readFileSync(opts.windowFit, 'utf8')) as WindowFitFile : undefined;
    const reveal = opts.revealDepth && fs.existsSync(opts.revealDepth) ? JSON.parse(fs.readFileSync(opts.revealDepth, 'utf8')) as RevealDepthFile : undefined;
    const grammar = opts.wallGrammar && fs.existsSync(opts.wallGrammar) ? JSON.parse(fs.readFileSync(opts.wallGrammar, 'utf8')) as WallGrammarFile : undefined;
    const rawSoup = opts.rawScan && fs.existsSync(opts.rawScan) ? glbSoup(parseGlbBytes(fs.readFileSync(opts.rawScan))) : undefined;
    // the whole-wall rebuild: a wall's sheet in place of its facades (when the sheet itself qualifies), every facade built where the scan has its wall
    const sheetsFile = opts.walls && fs.existsSync(opts.walls) ? JSON.parse(fs.readFileSync(opts.walls, 'utf8')) as WallSheetsFile : undefined;
    const sheets = (sheetsFile?.sheets ?? []).filter(sh => facadeEligible(sh.facade, P) && fs.existsSync(path.join(orthosDir, sh.facade.image)));
    const sheetOf = new Map<number, WallSheet>(sheets.map(sh => [sh.facade.facadeId, sh]));
    const replaced = new Set(sheets.flatMap(sh => sh.members));
    const whole = !!sheetsFile;
    const list = [...facades.filter(x => facadeEligible(x, P) && !skip.has(x.facadeId) && !replaced.has(x.facadeId)), ...sheets.map(sh => sh.facade)];
    for (const f of list) {
        const sheet = sheetOf.get(f.facadeId);
        const file = path.join(orthosDir, f.image);
        if (!fs.existsSync(file)) continue;
        const png = fs.readFileSync(file);
        const img = decodePng(png);
        // a filled image's coverage is read from its mask: a cell the photo never reached is not rebuilt, however it was filled
        const maskFile = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
        const mask = maskFile && fs.existsSync(maskFile) ? (() => { const m = decodePng(fs.readFileSync(maskFile)); return Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] > 127 ? 1 : 0)); })() : undefined;
        // the window fit's windows in the plane's frame: the lattice is drawn on them and they are its window cells
        const rects = sheet ? (sheet.windows.length ? sheet.windows : undefined) : fit ? fittedWindowRects(fit, f.facadeId) : undefined;
        const planeRects = rects?.map(([x0, y0, x1, y1]) => [f.orthoSMin + x0 * f.pixel, f.orthoTMax - y1 * f.pixel, f.orthoSMin + x1 * f.pixel, f.orthoTMax - y0 * f.pixel] as [number, number, number, number]);
        // a depth read from Street View is used only when it is confident and resolved from flush; else the contrast rule
        const read = planeRects?.length ? reveal?.facades[String(f.facadeId)] : undefined;
        const depth = trustedReveal(read, reveal?.params) ? read : undefined;
        const r0 = latticeFacade(f, { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height }, facadeSamples(soup, f, P), P, mask, opts.photoRecess === true, planeRects, depth?.depthM, sheet ? sheet.bays : grammarBays(grammar, f.facadeId), rawSoup ? facadeSamples(rawSoup, f, P) : undefined, whole);
        // with window strips, the facade's photo redrawn from its own repeats (generated): sharper, evener, its holes filled
        let r = r0, tex: Uint8Array = png;
        if (r0?.strips?.length && rects?.length) {
            const toPx = (st: [number, number, number, number]): [number, number, number, number] => [(st[0] - f.orthoSMin) / f.pixel, (f.orthoTMax - st[3]) / f.pixel, (st[2] - f.orthoSMin) / f.pixel, (f.orthoTMax - st[1]) / f.pixel];
            const rt = repeatTexture({ rgba: new Uint8Array(img.rgba), width: img.width, height: img.height }, f.pixel, rects, r0.strips.map(toPx), mask);
            if (rt.report.texels) { tex = encodePng(img.width, img.height, rt.rgba, 4); r = { ...r0, repeatTexture: rt.report }; }
        }
        const uvOf = (rs: WindowRect[]) => (rs.length ? rs.flatMap(([x0, y0, x1, y1]) => [x0 / img.width, y0 / img.height, x1 / img.width, y1 / img.height]) : undefined);
        if (r) { const w = sheet ? uvOf(sheet.windows) : fit ? fittedWindowUvs(fit, f.facadeId) : undefined, pw = sheet ? uvOf(sheet.panes) : w && fit ? fittedPaneUvs(fit, f.facadeId) : undefined, gw = !sheet && w && fit ? fittedGeneratedUvs(fit, f.facadeId) : undefined; done.push({ f, r: { ...r, ...(w ? { fittedWindows: w } : {}), ...(pw ? { fittedPanes: pw } : {}), ...(gw ? { generatedWindows: gw } : {}), ...(depth && r.photoRecessCells ? { recessFrom: `${depth.depthM} m read from Street View's window reveals, ${depth.reason}` } : {}) }, png: tex }); }
    }
    if (opts.stitch && done.length) {
        // the scan cut to the rebuilt cells (the same cut on the twin: the same triangles), the walls appended, the seams stitched.
        // Cut and stitch hold together: a rebuilt cell whose outline edge the stitch joins to nothing (no scan cut along it, no
        // corner) would leave a hole only a cap could close, so that cell is left as scan and the cut and stitch run again
        let live = done.map(d => ({ ...d, r: { ...d.r, built: Uint8Array.from(d.r.built) } }));
        const rounds: Array<{ unjoined: number; cellsLeftAsScan: number }> = [];
        for (let round = 1; ; round++) {
            // each rebuilt facade watertight inside itself (every step, corners shared), only its outline left for the stitch
            const sealed = live.map(d => ({ ...d, r: { ...d.r, ...watertightLatticeMesh(d.f, d.r) } }));
            // the cut edits the bytes it is given (removed triangles made degenerate in place): each round cuts a fresh copy
            const cutClay = cutScanToLattice(Uint8Array.from(clayBytes), sealed), cutTex = texturedBytes ? cutScanToLattice(Uint8Array.from(texturedBytes), sealed) : undefined;
            const wClay = applyFacadeLattices(cutClay.glb, sealed, false, P, { removeScan: false }), wTex = cutTex ? applyFacadeLattices(cutTex.glb, sealed, true, P, { removeScan: false }) : undefined;
            const st = stitchLattice(wClay.glb, wTex ? [wTex.glb] : [], sealed);
            let unbuilt = 0;
            if (st.report.unjoined && round < STITCH_ROUNDS) {
                for (const d of live) {
                    const ns = d.r.s.length - 1;
                    for (const [a, b] of st.unjoinedCells.get(d.f.facadeId) ?? []) if (d.r.built[b * ns + a]) { d.r.built[b * ns + a] = 0; d.r.cells--; unbuilt++; }
                }
            }
            rounds.push({ unjoined: st.report.unjoined, cellsLeftAsScan: unbuilt });
            if (unbuilt) {
                live = live.filter(d => d.r.cells > 0);
                if (live.length) continue;
                // no facade left to rebuild: the scan stands as it came
                return { clay: Buffer.from(clayBytes), ...(texturedBytes ? { textured: Buffer.from(texturedBytes) } : {}), stats: { facades: facades.length, rebuilt: 0, cells: 0, removedTriangles: 0, tears: { found: 0, restoredTriangles: 0, droppedFacades: [], left: 0 }, stitch: { cut: { cutTriangles: 0, removedPieces: 0, keptPieces: 0 }, strips: st.report, rounds }, perFacade: [] } };
            }
            return {
                clay: st.clay, ...(wTex ? { textured: st.others[0] } : {}),
                stats: { facades: facades.length, rebuilt: live.length, cells: live.reduce((a, d) => a + d.r.cells, 0), removedTriangles: cutClay.report.cutTriangles, tears: { found: 0, restoredTriangles: 0, droppedFacades: [], left: 0 }, stitch: { cut: cutClay.report, strips: st.report, rounds }, ...(opts.photoRecess ? { photoRecessCells: live.reduce((a, d) => a + (d.r.photoRecessCells ?? 0), 0) } : {}), perFacade: live.map(d => ({ id: d.f.facadeId, cells: d.r.cells, measuredShare: d.r.measuredShare, lines: [d.r.s.length, d.r.t.length] as [number, number], ...(d.r.photoRecessCells !== undefined ? { photoRecessCells: d.r.photoRecessCells } : {}) })) }
            };
        }
    }
    const clay = applyFacadeLattices(clayBytes, done, false, P);
    const kept = done.filter(d => !clay.tears.droppedFacades.includes(d.f.facadeId));
    // the twin rebuilds what the clay kept (its own audit still runs over its own triangles)
    const tex = texturedBytes ? applyFacadeLattices(texturedBytes, kept, true, P) : undefined;
    return {
        clay: clay.glb, ...(tex ? { textured: tex.glb } : {}),
        stats: { facades: facades.length, rebuilt: kept.length, cells: kept.reduce((a, d) => a + d.r.cells, 0), removedTriangles: clay.removed, tears: clay.tears, ...(opts.photoRecess ? { photoRecessCells: kept.reduce((a, d) => a + (d.r.photoRecessCells ?? 0), 0) } : {}), perFacade: kept.map(d => ({ id: d.f.facadeId, cells: d.r.cells, measuredShare: d.r.measuredShare, lines: [d.r.s.length, d.r.t.length] as [number, number], ...(d.r.photoRecessCells !== undefined ? { photoRecessCells: d.r.photoRecessCells } : {}) })) }
    };
}
