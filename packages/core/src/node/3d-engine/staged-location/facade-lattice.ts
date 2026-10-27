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
 * 3. repeats averaged: in each row the cells split into the photo's darker and lighter class (openings and wall), and
 *    each class takes its median depth, so repeated windows get one recess measured from all of them;
 * 4. the facade rebuilt: one face per cell at its depth, step faces between cells (reveals, sills, cornices), replacing the
 *    scan's facade triangles; textured with the facade's own orthophoto (planar UVs in the plane's frame). Only cells the
 *    photo covers are rebuilt: an uncovered cell keeps its scan triangles, never a face painted the uncovered grey.
 * Lines are photo-inferred; depths are measured (averaged); the rebuilt faces are labelled so in the GLB extras.
 */

import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';
import { decodePng } from '../../texture-processing';
import { cutScanToLattice, stitchLattice, watertightLatticeMesh, type CutReport, type StitchReport } from './pipeline-k/lattice-stitch';
import * as fs from 'fs';
import * as path from 'path';

export const FACADE_LATTICE_VERSION = 'facade-lattice/4';

export const FACADE_LATTICE_PARAMS = {
    /** Facades tile_refine rectified with at least this share of their ortho covered. */
    minCoverage: 0.6,
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
    /** A facade is rebuilt only when its cells cover at least this share of its lattice with measurements. */
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
    auditPixelM: 0.2, tearDepthM: 0.5
};

/**
 * What the tear audit found: torn pixels in the first pass, scan triangles put back over them, facades left unrebuilt because a
 * tear stayed after that, and torn pixels left at the end (0 unless the scan itself lacked surface there).
 */
export interface TearReport { found: number; restoredTriangles: number; droppedFacades: number[]; left: number }

export interface ReliefFacade {
    facadeId: number; image: string; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[];
    sMin: number; sMax: number; tMin: number; tMax: number; pixel: number; width: number; height: number; orthoSMin: number; orthoTMax: number; coverage: number;
    /** A mask beside the image (one channel, 255 = the photo did not reach) when the image's holes were filled (pipeline K). */
    uncoveredMask?: string;
    /** How the image's holes were filled, carried into the rebuilt facade's provenance. */
    textureFill?: { label: string; texels: number; share: number; method: string };
}

export interface FacadeLatticeResult {
    facadeId: number; s: number[]; t: number[]; cells: number; measuredShare: number;
    depth: number[][];
    /** Per cell (row-major, t then s): 1 when it was rebuilt, 0 when the photo does not cover it and the scan stays. */
    built: Uint8Array; positions: Float32Array; normals: Float32Array; uv: Float32Array; indices: Uint32Array;
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
export function latticeFacade(f: ReliefFacade, img: { rgba: Uint8Array; width: number; height: number }, samples: Float64Array, P = FACADE_LATTICE_PARAMS, uncovered?: Uint8Array): FacadeLatticeResult | undefined {
    const { s, t } = photoLattice(img, f, P);
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
    const measured = raw.filter(Number.isFinite).length;
    if (measured / (ns * nt) < P.minMeasuredShare) return undefined;
    // repeats averaged: per row, the darker and lighter class each take their median depth
    const depth: number[][] = [];
    for (let b = 0; b < nt; b++) {
        const cells = Array.from({ length: ns }, (_, a) => b * ns + a);
        const ls = cells.map(k => lum[k]).filter(Number.isFinite);
        const split = ls.length ? (Math.min(...ls) + Math.max(...ls)) / 2 : 0;
        const dark = cells.filter(k => lum[k] < split), light = cells.filter(k => !(lum[k] < split));
        const dm = median(dark.map(k => raw[k]).filter(Number.isFinite)), lm = median(light.map(k => raw[k]).filter(Number.isFinite));
        const rowMed = median(cells.map(k => raw[k]).filter(Number.isFinite));
        const clamp = (v: number) => Math.min(P.maxDepthM, Math.max(P.minDepthM, v));
        depth.push(cells.map(k => clamp(Number.isFinite(lum[k] < split ? dm : lm) ? (lum[k] < split ? dm : lm) : Number.isFinite(rowMed) ? rowMed : 0)));
    }
    // the surface: one face per cell, step faces between cells
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    const W = img.width * f.pixel, H = img.height * f.pixel;
    const world = (sv: number, tv: number, d: number) => [0, 1, 2].map(k => f.centroid[k] + sv * f.axisS[k] + tv * f.axisT[k] + d * f.normal[k]);
    const quad = (pts: Array<[number, number, number]>, n: number[]) => {
        const base = pos.length / 3;
        for (const [sv, tv, d] of pts) { pos.push(...world(sv, tv, d)); nrm.push(...n); uv.push((sv - f.orthoSMin) / W, (f.orthoTMax - tv) / H); }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const N = f.normal, S = f.axisS, T = f.axisT, neg = (v: number[]) => v.map(x => -x);
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        // a cell the photo does not cover keeps the scan; no step face is drawn against it
        if (!built[b * ns + a]) continue;
        const d = depth[b][a];
        // counter-clockwise seen from outside (along +normal): s right, t up
        quad([[s[a], t[b], d], [s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a], t[b + 1], d]], N);
        if (a + 1 < ns && built[b * ns + a + 1]) { const e = depth[b][a + 1]; if (Math.abs(e - d) > P.stepM) quad(d > e ? [[s[a + 1], t[b], e], [s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a + 1], t[b + 1], e]] : [[s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a + 1], t[b + 1], e], [s[a + 1], t[b], e]], d > e ? S : neg(S)); }
        if (b + 1 < nt && built[(b + 1) * ns + a]) { const e = depth[b + 1][a]; if (Math.abs(e - d) > P.stepM) quad(d > e ? [[s[a], t[b + 1], e], [s[a], t[b + 1], d], [s[a + 1], t[b + 1], d], [s[a + 1], t[b + 1], e]].reverse() as Array<[number, number, number]> : [[s[a], t[b + 1], d], [s[a], t[b + 1], e], [s[a + 1], t[b + 1], e], [s[a + 1], t[b + 1], d]].reverse() as Array<[number, number, number]>, d > e ? T : neg(T)); }
    }
    if (!built.some(v => v)) return undefined;
    return { facadeId: f.facadeId, s, t, cells: built.reduce((x, v) => x + v, 0), measuredShare: Math.round((measured / (ns * nt)) * 1000) / 1000, depth, built, positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

// ---------------------------------------------------------------------------------------------------------------
// GLB editing: the facade's scan triangles made degenerate, the rebuilt facade appended
// ---------------------------------------------------------------------------------------------------------------

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
    const audit = (count: boolean): Array<{ fi: number; pix: number[]; grid: ReturnType<typeof outermostDepth> }> => {
        const { soup: rs, live } = resultSoup();
        const torn: Array<{ fi: number; pix: number[]; grid: ReturnType<typeof outermostDepth> }> = [];
        facadesIn.forEach((x, fi) => {
            const before = outermostDepth(soup, x.f, x.r, P.auditPixelM, undefined, P.depthBandM), after = outermostDepth(rs, x.f, x.r, P.auditPixelM, live);
            const pix = tearPixels(before, after, P);
            if (pix.length) torn.push({ fi, pix, grid: before });
            if (count) tears.found += pix.length;
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
            for (const o of pix) { const x = o % grid.W, y = Math.floor(o / grid.W); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < grid.W && yy < grid.H) mark[yy * grid.W + xx] = 1; } }
            for (let k = 0; k < nTri; k++) {
                if (claim[k] < 0) continue;
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, near = false;
                for (let j = 0; j < 3; j++) {
                    const m = [soup[k * 9 + 3 * j] - f.centroid[0], soup[k * 9 + 3 * j + 1] - f.centroid[1], soup[k * 9 + 3 * j + 2] - f.centroid[2]];
                    if (Math.abs(dot(m, f.normal)) <= P.depthBandM + P.tearDepthM) near = true;
                    const x = (dot(m, f.axisS) - grid.s0) / P.auditPixelM, y = (dot(m, f.axisT) - grid.t0) / P.auditPixelM;
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
    // still torn: the facades whose own removals lie under a torn pixel are not rebuilt, and the removals are decided again
    for (let round = 0; torn.length && round < 4; round++) {
        for (const { fi } of torn) if (!dropped.has(fi)) { dropped.add(fi); tears.droppedFacades.push(facadesIn[fi].f.facadeId); }
        decide();
        torn = audit(false);
        if (torn.length) { tears.restoredTriangles += restore(torn); torn = audit(false); }
    }
    tears.left = torn.reduce((a, x) => a + x.pix.length, 0);
    // the last resort: anything still torn means no facade is rebuilt (the scan is shown whole, as it came)
    if (tears.left) { facadesIn.forEach((x, fi) => { if (!dropped.has(fi)) { dropped.add(fi); tears.droppedFacades.push(x.f.facadeId); } }); decide(); tears.left = audit(false).reduce((a, x) => a + x.pix.length, 0); }
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
        json.nodes.push({ name: `FacadeLattice_${f.facadeId}`, mesh: json.meshes.length - 1, extras: { sbFacadeLattice: { version: FACADE_LATTICE_VERSION, facadeId: f.facadeId, provenance: { lines: 'photo-inferred', depth: 'measured (median per cell, averaged along the row\'s repeats)', texture: f.textureFill ? { photo: 'tile photo', holes: f.textureFill } : 'tile photo' }, cells: r.cells, measuredShare: r.measuredShare, sLines: r.s.length, tLines: r.t.length } } });
        scene?.nodes?.push(json.nodes.length - 1);
    }
    bin.align4();
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: bin.length }];
    return { glb: assembleGlb(json, bin.bytes()), removed, tears };
}

/** Rebuilds a remesh's rectified facades on their photo lattices: the clay and (when given) its textured twin. */
export function rebuildFacadesOnLattice(clayBytes: Uint8Array, texturedBytes: Uint8Array | undefined, orthosDir: string, P: typeof FACADE_LATTICE_PARAMS = FACADE_LATTICE_PARAMS, skip: Set<number> = new Set(), opts: { /** Pipeline K: the scan cut exactly to the rebuilt cells and stitched to them (pipeline-k/lattice-stitch.ts), instead of whole triangles removed. */ stitch?: boolean } = {}): { clay: Buffer; textured?: Buffer; stats: { facades: number; rebuilt: number; cells: number; removedTriangles: number; tears: TearReport; stitch?: { cut: CutReport; strips: StitchReport }; perFacade: Array<{ id: number; cells: number; measuredShare: number; lines: [number, number] }> } } {
    const facades = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as ReliefFacade[];
    const soup = glbSoup(parseGlbBytes(clayBytes));
    const done: Array<{ f: ReliefFacade; r: FacadeLatticeResult; png: Uint8Array }> = [];
    for (const f of facades.filter(x => x.coverage >= P.minCoverage && !skip.has(x.facadeId))) {
        const file = path.join(orthosDir, f.image);
        if (!fs.existsSync(file)) continue;
        const png = fs.readFileSync(file);
        const img = decodePng(png);
        // a filled image's coverage is read from its mask: a cell the photo never reached is not rebuilt, however it was filled
        const maskFile = f.uncoveredMask ? path.join(orthosDir, f.uncoveredMask) : undefined;
        const mask = maskFile && fs.existsSync(maskFile) ? (() => { const m = decodePng(fs.readFileSync(maskFile)); return Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] > 127 ? 1 : 0)); })() : undefined;
        const r = latticeFacade(f, { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height }, facadeSamples(soup, f, P), P, mask);
        if (r) done.push({ f, r, png });
    }
    if (opts.stitch && done.length) {
        // the scan cut to the rebuilt cells (the same cut on the twin: the same triangles), the walls appended, the seams stitched
        // each rebuilt facade watertight inside itself (every step, corners shared), only its outline left for the stitch
        const sealed = done.map(d => ({ ...d, r: { ...d.r, ...watertightLatticeMesh(d.f, d.r) } }));
        const cutClay = cutScanToLattice(clayBytes, sealed), cutTex = texturedBytes ? cutScanToLattice(texturedBytes, sealed) : undefined;
        const wClay = applyFacadeLattices(cutClay.glb, sealed, false, P, { removeScan: false }), wTex = cutTex ? applyFacadeLattices(cutTex.glb, sealed, true, P, { removeScan: false }) : undefined;
        const st = stitchLattice(wClay.glb, wTex ? [wTex.glb] : [], sealed);
        return {
            clay: st.clay, ...(wTex ? { textured: st.others[0] } : {}),
            stats: { facades: facades.length, rebuilt: done.length, cells: done.reduce((a, d) => a + d.r.cells, 0), removedTriangles: cutClay.report.cutTriangles, tears: { found: 0, restoredTriangles: 0, droppedFacades: [], left: 0 }, stitch: { cut: cutClay.report, strips: st.report }, perFacade: done.map(d => ({ id: d.f.facadeId, cells: d.r.cells, measuredShare: d.r.measuredShare, lines: [d.r.s.length, d.r.t.length] as [number, number] })) }
        };
    }
    const clay = applyFacadeLattices(clayBytes, done, false, P);
    const kept = done.filter(d => !clay.tears.droppedFacades.includes(d.f.facadeId));
    // the twin rebuilds what the clay kept (its own audit still runs over its own triangles)
    const tex = texturedBytes ? applyFacadeLattices(texturedBytes, kept, true, P) : undefined;
    return {
        clay: clay.glb, ...(tex ? { textured: tex.glb } : {}),
        stats: { facades: facades.length, rebuilt: kept.length, cells: kept.reduce((a, d) => a + d.r.cells, 0), removedTriangles: clay.removed, tears: clay.tears, perFacade: kept.map(d => ({ id: d.f.facadeId, cells: d.r.cells, measuredShare: d.r.measuredShare, lines: [d.r.s.length, d.r.t.length] as [number, number] })) }
    };
}
