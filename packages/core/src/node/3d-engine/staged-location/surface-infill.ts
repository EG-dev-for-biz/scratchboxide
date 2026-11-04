/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One infill for every surface where a staged build removes something (vehicles, the tree strip's cut, K's base
 * cleanup, Street View residue), at any place: the removal step hands over the removed region (its footprint as world
 * triangles and the measured ring around it) and gets back the surface under it, rebuilt and textured, every texel
 * labelled with its provenance and reason.
 *
 * **Geometry** (surface-infill-geometry.ts): a chart fitted to the ring (level surfaces in plan, a wall in its own plane)
 * and the surface model under the region: the measured ring and its continuation, levels split where a step is measured
 * (kerbs, stairs kept sharp on a breakline), local quadrics keeping grade and camber. Vertices are moved onto it
 * (`applyInfillToGlb`) or an open loop is closed on it (`closeLoop`), never a lump or a hole. Labelled generated: nothing
 * was measured under what stood there.
 *
 * **Texture**, on the chart raster: the scan's photo rendered straight along the chart's normal, a texel clear when the
 * first surface it sees lies on the model (so a canopy or an awning over the surface is no source), the region and a
 * guard band around it the target, every other region kept out of the sources. One ladder, each rung chosen by what the
 * surface itself measures, never by what it is called:
 *   1. real views: registered photos that see the surface clear (their occluder masks applied, a depth test against the
 *      scan), gain-matched to the ring: measured;
 *   2. continuation from the same surface's clear texels (surface-infill-synthesis.ts): directional along its measured
 *      orientation (lines, kerbs, gutters continue; dashes and crossing bars at their measured period and phase), periodic
 *      at its measured lattice (photo-inferred), stochastic patch synthesis from its own grain (generated);
 *   3. a library material at real size, chosen by appearance and tinted to the measured colour (generated);
 *   4. detail-locked generative inpaint for what remains (generated).
 * Every attempt passes the seam gate (surface-infill-gates.ts) before it is kept; a rejected attempt falls to the next
 * rung with its reason. When no rung passes, the attempt that failed least is kept, labelled generated, its failures
 * said: the surface stays believable and the record honest.
 *
 * Nothing here knows what was removed or what the surface is: measured quantities and continuous bars only.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { DecodedImage, PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import { linearToSrgb255, SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { ProColorGradeMatchingService as Colour } from '../../image/ProColorGradeMatchingService';
import { assembleGlb, isIdentity, nodeWorldMatrices, parseGlbBytes, transformPoint } from './glb-bytes';
import { decodeImageInMemory, type TileTriangles } from './tile-texture-transfer';
import { encodePng } from './png-encode';
import { fitChart, fitSurfaceModel, fromChart, toChart, INFILL_GEOMETRY_PARAMS, type InfillChart, type InfillGeometryParams, type SurfaceModel } from './surface-infill-geometry';
import { distanceFrom, seamGate, SEAM_GATE, type SeamGateParams, type SeamGateResult } from './surface-infill-gates';
import { correctToRim, directionalRule, latticeRule, readStructure, stochasticRule, synthesize, INFILL_SYNTHESIS_PARAMS, type InfillSynthesisParams, type MeasuredPeriod, type OffsetRule, type StructureReading } from './surface-infill-synthesis';
import { invert, pushPull } from './vehicle-removal';

export const SURFACE_INFILL_VERSION = 'surface-infill/1';

export const SURFACE_INFILL_PARAMS = {
    /** The chart's texel (m); grown so neither side passes maxSide. */
    texelM: 0.05, maxSide: 2048,
    /** The chart reaches this far past the region (m): the clear surface the fill reads and meets. */
    marginM: 6,
    /** Texels this close to the region are filled too (m): the photo there may still show the edge of what was removed. */
    guardM: 0.3,
    /** A texel is a clear source when the first surface it sees stands within this of the model (m) and faces it (|cos| at least facingMin). */
    sourceTolM: 0.15, facingMin: 0.5,
    /** Another region within this of the surface (m, along the normal) is kept out of the sources. */
    excludeBandM: 2,
    /** Rung 1: a view's texel passes the depth test within this (m, plus depthShare of the distance). */
    viewDepthTolM: 0.3, viewDepthShare: 0.02,
    /** Rung 1: the gain matched on at least this many ring texels, each channel held to [gainLo, gainHi]. */
    viewGainMinPairs: 30, viewGainLo: 0.4, viewGainHi: 2.5,
    /** Rung 2: at least this many clear texels to synthesise from. */
    minSources: 200,
    /** Write-back: a texel is painted when it lies within this of the model (m) inside the target. */
    paintTolM: 0.35,
    /** Write-back: a vertex is moved onto the model only when it stands within this of it (m). */
    moveMaxM: 5
};
export type SurfaceInfillParams = typeof SURFACE_INFILL_PARAMS;

/** The rungs, in the order they are tried. */
export const INFILL_RUNGS = ['real view', 'directional continuation', 'periodic continuation', 'stochastic synthesis', 'library material', 'generative inpaint', 'membrane fill'] as const;
export type InfillRungName = typeof INFILL_RUNGS[number];

/** Per-texel provenance codes of the label raster (0: a real texel left as it was). */
export const INFILL_LABEL = { untouched: 0, measured: 1, photoInferred: 2, generated: 3 } as const;
export type InfillLabelName = 'measured' | 'photo-inferred' | 'generated';
const LABEL_NAME: Record<number, InfillLabelName> = { 1: 'measured', 2: 'photo-inferred', 3: 'generated' };
const LABEL_CODE: Record<InfillLabelName, number> = { measured: 1, 'photo-inferred': 2, generated: 3 };

export interface InfillRegionSpec {
    id: number | string;
    /** What was removed, in the removal step's words (for the reason). */
    what: string;
    /** The removed region's footprint on the surface: world triangles, 9 floats each. */
    hole: Float32Array;
    /** Measured points of the surface around it (world xyz): what the geometry is fitted to. */
    ring: Float32Array;
    /** Which way the surface faces (the side its photo was taken from); up when absent. */
    normalHint?: Vec3;
    /** A chart fixed by the caller (else fitted to the ring). */
    chart?: InfillChart;
}

/** A registered photo for rung 1. */
export interface InfillView {
    id: string;
    camera: PinholeCamera;
    image: DecodedImage;
    /** 1 per pixel where the photo shows the surface clear (occluder and ownership masks applied); all usable when absent. */
    usable?: Uint8Array;
    /** Camera depth (m, along fwd) of the first surface per pixel; computed from the scan when absent. */
    depth?: Float32Array;
    /** 0..1: how far the registration is trusted. */
    quality?: number;
}

/** A library material for rung 3 (sRGB8 RGBA colour map, tiling). */
export interface InfillLibraryEntry {
    id: string; width: number; height: number; rgba: Uint8Array;
    realSizeM: [number, number];
    /** Mean CIELAB of the map (computed when absent). */
    meanLab?: Vec3;
}

/** Rung 4: a generative inpainter (detail-locked by its caller, e.g. texture-inpaint.ts's inpaintImage). */
export type InfillInpainter = (crop: { rgba: Uint8Array; width: number; height: number; hole: Uint8Array; keep: Uint8Array; prompt: string; signal?: AbortSignal }) => Promise<{ rgba: Uint8Array; model?: string } | { refused: string }>;

export interface InfillInput {
    /** The kept surfaces with their photos (readTileTriangles): the sources and what the fill must meet. */
    scan: TileTriangles;
    regions: InfillRegionSpec[];
    /** Other removed footprints (world triangles) never read as a source: what the caller removes but does not fill here. */
    exclude?: Float32Array[];
    views?: InfillView[];
    library?: InfillLibraryEntry[];
    inpaint?: InfillInpainter;
    params?: Partial<SurfaceInfillParams>;
    gate?: Partial<SeamGateParams>;
    synthesis?: Partial<InfillSynthesisParams>;
    geometry?: Partial<InfillGeometryParams>;
    /** Keep the chart's photo before the fill (for records and sheets). */
    keepBefore?: boolean;
    signal?: AbortSignal;
    log?: (m: string) => void;
}

export interface RungAttempt {
    rung: InfillRungName;
    label: InfillLabelName;
    /** Texels it filled (0 when it could not run). */
    texels: number;
    accepted: boolean;
    /** Why it was not run, or why it was rejected, or what it did. */
    reason: string;
    gate?: SeamGateResult;
    ms: number;
}

export interface RegionInfill {
    id: number | string;
    what: string;
    chart: InfillChart;
    model: SurfaceModel;
    structure: StructureReading;
    /** sRGB8 RGB over the chart: the photo with the fill written in. */
    rgb: Uint8Array;
    before?: Uint8Array;
    /** 1 for the texels written (the region and its guard band). */
    target: Uint8Array;
    /** 1 for the clear texels of the surface (the sources). */
    source: Uint8Array;
    /** INFILL_LABEL per texel, and the rung (index into INFILL_RUNGS, 255 none). */
    label: Uint8Array;
    rung: Uint8Array;
    attempts: RungAttempt[];
    /** Of the target texels: the share each label holds. */
    shares: Record<InfillLabelName, number>;
    /** True when every target texel's fill passed the seam gate. */
    gatePassed: boolean;
    targetTexels: number;
    reason: string;
    ms: number;
    /** Where the time went (ms): geometry, the photo raster, the structure reading, the rungs. */
    timings: { geometry: number; raster: number; structure: number; rungs: number };
}

// ------------------------------------------------------------------------------------------------ the scan, indexed

interface TriangleGrid { x0: number; z0: number; cell: number; nx: number; nz: number; cells: Map<number, number[]> }

function triangleGrid(t: TileTriangles, cell = 8): TriangleGrid {
    const P = t.positions, n = t.texture.length;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2]); }
    if (!(x1 >= x0)) { x0 = z0 = 0; x1 = z1 = 1; }
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
    const cells = new Map<number, number[]>();
    for (let tr = 0; tr < n; tr++) {
        const o = tr * 9;
        const i0 = Math.floor((Math.min(P[o], P[o + 3], P[o + 6]) - x0) / cell), i1 = Math.floor((Math.max(P[o], P[o + 3], P[o + 6]) - x0) / cell);
        const k0 = Math.floor((Math.min(P[o + 2], P[o + 5], P[o + 8]) - z0) / cell), k1 = Math.floor((Math.max(P[o + 2], P[o + 5], P[o + 8]) - z0) / cell);
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) { const key = k * nx + i; let l = cells.get(key); if (!l) cells.set(key, l = []); l.push(tr); }
    }
    return { x0, z0, cell, nx, nz, cells };
}

/** Triangles whose cells meet the world box (deduplicated). */
function trianglesInBox(g: TriangleGrid, t: TileTriangles, lo: Vec3, hi: Vec3): number[] {
    const out: number[] = [];
    const seen = new Uint8Array(t.texture.length);
    const i0 = Math.max(0, Math.floor((lo[0] - g.x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((hi[0] - g.x0) / g.cell));
    const k0 = Math.max(0, Math.floor((lo[2] - g.z0) / g.cell)), k1 = Math.min(g.nz - 1, Math.floor((hi[2] - g.z0) / g.cell));
    const P = t.positions;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) for (const tr of g.cells.get(k * g.nx + i) ?? []) {
        if (seen[tr]) continue;
        seen[tr] = 1;
        const o = tr * 9;
        if (Math.max(P[o + 1], P[o + 4], P[o + 7]) < lo[1] || Math.min(P[o + 1], P[o + 4], P[o + 7]) > hi[1]) continue;
        out.push(tr);
    }
    return out;
}

/** The world box of a chart between heights w0..w1 along its normal. */
function chartBox(c: InfillChart, w0: number, w1: number): { lo: Vec3; hi: Vec3 } {
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const a of [0, c.width * c.texelM]) for (const b of [0, c.height * c.texelM]) for (const w of [w0, w1]) {
        const p = fromChart(c, a, b, w);
        for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); }
    }
    return { lo, hi };
}

/** Rasterises triangles into the chart: per texel the first surface seen from +n (its height, triangle and barycentrics). */
function rasterizeTriangles(c: InfillChart, positions: Float32Array, list: ArrayLike<number> | undefined, count: number, onTexel: (p: number, tri: number, w: number, l1: number, l2: number, l3: number) => void): void {
    const W = c.width, H = c.height, t = c.texelM;
    for (let j = 0; j < count; j++) {
        const tr = list ? list[j] : j, o = tr * 9;
        const A = toChart(c, positions[o], positions[o + 1], positions[o + 2]), B = toChart(c, positions[o + 3], positions[o + 4], positions[o + 5]), C = toChart(c, positions[o + 6], positions[o + 7], positions[o + 8]);
        const ax = A[0] / t - 0.5, ay = A[1] / t - 0.5, bx = B[0] / t - 0.5, by = B[1] / t - 0.5, cx = C[0] / t - 0.5, cy = C[1] / t - 0.5;
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(det) < 1e-12) continue;
        const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), i1 = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx)));
        const k0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), k1 = Math.min(H - 1, Math.floor(Math.max(ay, by, cy)));
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
            const l1 = ((bx - i) * (cy - k) - (cx - i) * (by - k)) / det;
            const l2 = ((cx - i) * (ay - k) - (ax - i) * (cy - k)) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            onTexel(k * W + i, tr, l1 * A[2] + l2 * B[2] + l3 * C[2], l1, l2, l3);
        }
    }
}

/** A texel's linear colour on a tile triangle at barycentrics (l1, l2, l3). */
function triangleColour(scan: TileTriangles, tr: number, l1: number, l2: number, l3: number, out: number[]): void {
    const ti = scan.texture[tr];
    if (ti < 0) { out[0] = scan.flatLinear[tr * 3]; out[1] = scan.flatLinear[tr * 3 + 1]; out[2] = scan.flatLinear[tr * 3 + 2]; return; }
    const tex = scan.textures[ti], UV = scan.uvs;
    const u = l1 * UV[tr * 6] + l2 * UV[tr * 6 + 2] + l3 * UV[tr * 6 + 4], v = l1 * UV[tr * 6 + 1] + l2 * UV[tr * 6 + 3] + l3 * UV[tr * 6 + 5];
    const wrap = (x: number, n: number, rep: boolean) => (rep ? ((x % n) + n) % n : Math.min(n - 1, Math.max(0, x)));
    const fx = u * tex.width - 0.5, fy = v * tex.height - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const xa = wrap(x0, tex.width, tex.repeatS), xb = wrap(x0 + 1, tex.width, tex.repeatS), ya = wrap(y0, tex.height, tex.repeatT), yb = wrap(y0 + 1, tex.height, tex.repeatT);
    const L = tex.linear, Wt = tex.width;
    for (let k = 0; k < 3; k++) out[k] = (L[(ya * Wt + xa) * 3 + k] * (1 - tx) + L[(ya * Wt + xb) * 3 + k] * tx) * (1 - ty) + (L[(yb * Wt + xa) * 3 + k] * (1 - tx) + L[(yb * Wt + xb) * 3 + k] * tx) * ty;
}

// ------------------------------------------------------------------------------------------------ rungs

const labOf = (r: number, g: number, b: number) => Colour.srgbToLab(Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));

interface Work {
    W: number; H: number; texelM: number;
    rgb: Float32Array;
    /** Clear real texels outside the target (sources). */
    source: Uint8Array;
    /** Texels the fill must meet: sources and accepted fills. */
    ref: Uint8Array;
    /** Target texels still to fill. */
    open: Uint8Array;
    label: Uint8Array; rung: Uint8Array;
}

function snapshot(w: Work, mask: Uint8Array): Float32Array {
    const s = new Float32Array(w.W * w.H * 3);
    for (let p = 0; p < w.W * w.H; p++) if (mask[p]) { s[p * 3] = w.rgb[p * 3]; s[p * 3 + 1] = w.rgb[p * 3 + 1]; s[p * 3 + 2] = w.rgb[p * 3 + 2]; }
    return s;
}

function restore(w: Work, mask: Uint8Array, s: Float32Array): void {
    for (let p = 0; p < w.W * w.H; p++) if (mask[p]) { w.rgb[p * 3] = s[p * 3]; w.rgb[p * 3 + 1] = s[p * 3 + 1]; w.rgb[p * 3 + 2] = s[p * 3 + 2]; }
}

/** Rung 1: each open texel from the best registered photo that sees it clear, gain-matched to the ring. */
function viewFill(w: Work, chart: InfillChart, model: SurfaceModel, views: InfillView[], depthOf: (v: InfillView) => Float32Array, P: SurfaceInfillParams): { fill: Uint8Array; count: number; used: string[]; note: string } {
    const N = w.W * w.H, fill = new Uint8Array(N);
    const score = new Float32Array(N).fill(-1);
    const col = new Float32Array(N * 3);
    const used = new Set<string>();
    const notes: string[] = [];
    const project = (v: InfillView, p: Vec3): { px: number; py: number; z: number } | undefined => {
        const c = v.camera, dx = p[0] - c.eye[0], dy = p[1] - c.eye[1], dz = p[2] - c.eye[2];
        const z = dx * c.fwd[0] + dy * c.fwd[1] + dz * c.fwd[2];
        if (z <= 0.1) return undefined;
        const px = c.cx + (c.fx * (dx * c.right[0] + dy * c.right[1] + dz * c.right[2])) / z, py = c.cy - (c.fy * (dx * c.up[0] + dy * c.up[1] + dz * c.up[2])) / z;
        if (px < 0 || py < 0 || px >= v.image.width - 1 || py >= v.image.height - 1) return undefined;
        return { px, py, z };
    };
    const sample = (v: InfillView, px: number, py: number, out: number[]) => {
        const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0, Wi = v.image.width, I = v.image.rgba;
        for (let k = 0; k < 3; k++) out[k] = (I[(y0 * Wi + x0) * 4 + k] * (1 - tx) + I[(y0 * Wi + x0 + 1) * 4 + k] * tx) * (1 - ty) + (I[((y0 + 1) * Wi + x0) * 4 + k] * (1 - tx) + I[((y0 + 1) * Wi + x0 + 1) * 4 + k] * tx) * ty;
    };
    const sees = (v: InfillView, depth: Float32Array, q: { px: number; py: number; z: number }) => {
        const i = Math.round(q.px), k = Math.round(q.py), pix = k * v.image.width + i;
        if (v.usable && !v.usable[pix]) return false;
        return q.z <= depth[pix] + P.viewDepthTolM + P.viewDepthShare * q.z;
    };
    const c3 = [0, 0, 0];
    for (const v of views) {
        const depth = depthOf(v);
        // the gain: the view against the scan's own photo over the clear ring texels it sees
        const pairs: Array<[number, number, number, number, number, number]> = [];
        for (let p = 0; p < N; p++) {
            if (!w.source[p] || pairs.length > 4000) continue;
            const i = p % w.W, k = (p - i) / w.W;
            const a = (i + 0.5) * w.texelM, b = (k + 0.5) * w.texelM;
            const q = project(v, fromChart(chart, a, b, model.heightAt(a, b)));
            if (!q || !sees(v, depth, q)) continue;
            sample(v, q.px, q.py, c3);
            pairs.push([w.rgb[p * 3], w.rgb[p * 3 + 1], w.rgb[p * 3 + 2], c3[0], c3[1], c3[2]]);
        }
        const gain = [1, 1, 1];
        if (pairs.length >= P.viewGainMinPairs) {
            for (let j = 0; j < 3; j++) {
                const s = pairs.map(x => SRGB8_TO_LINEAR[Math.round(x[j])]).sort((x, y) => x - y), u = pairs.map(x => SRGB8_TO_LINEAR[Math.round(Math.max(0, Math.min(255, x[j + 3])))]).sort((x, y) => x - y);
                const ms = s[s.length >> 1], mu = u[u.length >> 1];
                gain[j] = mu > 1e-4 ? Math.max(P.viewGainLo, Math.min(P.viewGainHi, ms / mu)) : 1;
            }
        } else notes.push(`view ${v.id}: ${pairs.length} ring texels in common, gain not matched`);
        let n = 0;
        for (let p = 0; p < N; p++) {
            if (!w.open[p]) continue;
            const i = p % w.W, k = (p - i) / w.W;
            const a = (i + 0.5) * w.texelM, b = (k + 0.5) * w.texelM;
            const world = fromChart(chart, a, b, model.heightAt(a, b));
            const q = project(v, world);
            if (!q || !sees(v, depth, q)) continue;
            // nearer and more face-on views first
            const c = v.camera, dx = world[0] - c.eye[0], dy = world[1] - c.eye[1], dz = world[2] - c.eye[2], L = Math.hypot(dx, dy, dz) || 1;
            const facing = Math.abs((dx * chart.n[0] + dy * chart.n[1] + dz * chart.n[2]) / L);
            const s = (v.quality ?? 1) * facing / (1 + L / 20);
            if (s <= score[p]) continue;
            score[p] = s;
            sample(v, q.px, q.py, c3);
            for (let j = 0; j < 3; j++) col[p * 3 + j] = linearToSrgb255(Math.min(1, SRGB8_TO_LINEAR[Math.round(Math.max(0, Math.min(255, c3[j])))] * gain[j]));
            fill[p] = 1; n++;
        }
        if (n) used.add(v.id);
    }
    let count = 0;
    for (let p = 0; p < N; p++) if (fill[p]) { w.rgb[p * 3] = col[p * 3]; w.rgb[p * 3 + 1] = col[p * 3 + 1]; w.rgb[p * 3 + 2] = col[p * 3 + 2]; count++; }
    return { fill, count, used: [...used], note: notes.join('; ') };
}

/** Camera depth of the scan's first surface per pixel of a view (z-buffer of the triangles near the eye and the region). */
function viewDepth(v: InfillView, scan: TileTriangles, tris: number[]): Float32Array {
    const c = v.camera, Wi = v.image.width, Hi = v.image.height, P = scan.positions;
    const depth = new Float32Array(Wi * Hi).fill(Infinity);
    for (const tr of tris) {
        const o = tr * 9;
        const pts: Array<[number, number, number]> = [];
        let behind = false;
        for (let k = 0; k < 3; k++) {
            const dx = P[o + k * 3] - c.eye[0], dy = P[o + k * 3 + 1] - c.eye[1], dz = P[o + k * 3 + 2] - c.eye[2];
            const z = dx * c.fwd[0] + dy * c.fwd[1] + dz * c.fwd[2];
            if (z <= 0.1) { behind = true; break; }
            pts.push([c.cx + (c.fx * (dx * c.right[0] + dy * c.right[1] + dz * c.right[2])) / z, c.cy - (c.fy * (dx * c.up[0] + dy * c.up[1] + dz * c.up[2])) / z, z]);
        }
        if (behind) continue;
        const [A, B, C] = pts;
        const det = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
        if (Math.abs(det) < 1e-9) continue;
        const i0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), i1 = Math.min(Wi - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
        const k0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), k1 = Math.min(Hi - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
        if ((i1 - i0 + 1) * (k1 - k0 + 1) > 4_000_000) continue;
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
            const l1 = ((B[0] - i) * (C[1] - k) - (C[0] - i) * (B[1] - k)) / det, l2 = ((C[0] - i) * (A[1] - k) - (A[0] - i) * (C[1] - k)) / det, l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            // perspective-correct depth: 1/z interpolates linearly on screen
            const z = 1 / (l1 / A[2] + l2 / B[2] + l3 / C[2]);
            const p = k * Wi + i;
            if (z < depth[p]) depth[p] = z;
        }
    }
    return depth;
}

/** Rung 3: the library entry nearest the ring's look, at its real size, tinted to the ring's measured colour. */
function libraryFillChart(w: Work, entries: InfillLibraryEntry[]): { fill: Uint8Array; count: number; entry?: string; note: string } {
    const N = w.W * w.H;
    // the ring's look: mean and spread of the clear texels near the open ones
    const near = distanceFrom(w.open, w.W, w.H, Math.round(1.5 / w.texelM));
    const lin = [0, 0, 0], labs: Vec3[] = [];
    let n = 0;
    for (let p = 0; p < N; p++) if (w.source[p] && near[p] > 0 && near[p] <= Math.round(1.5 / w.texelM)) {
        for (let j = 0; j < 3; j++) lin[j] += SRGB8_TO_LINEAR[Math.round(w.rgb[p * 3 + j])];
        if (n % 7 === 0) labs.push(labOf(w.rgb[p * 3], w.rgb[p * 3 + 1], w.rgb[p * 3 + 2]));
        n++;
    }
    if (!n) return { fill: new Uint8Array(N), count: 0, note: 'no clear texel around the region to read a colour from' };
    for (let j = 0; j < 3; j++) lin[j] /= n;
    const ringLab = labOf(linearToSrgb255(lin[0]), linearToSrgb255(lin[1]), linearToSrgb255(lin[2]));
    const spread = Math.sqrt(labs.reduce((s, l) => s + (l[0] - ringLab[0]) ** 2, 0) / Math.max(1, labs.length));
    let best: { e: InfillLibraryEntry; d: number; mean: number[] } | undefined;
    for (const e of entries) {
        const m = [0, 0, 0];
        let sl = 0;
        const step = Math.max(1, Math.floor((e.width * e.height) / 4096));
        let c = 0;
        const ls: number[] = [];
        for (let p = 0; p < e.width * e.height; p += step) { for (let j = 0; j < 3; j++) m[j] += SRGB8_TO_LINEAR[e.rgba[p * 4 + j]]; ls.push(labOf(e.rgba[p * 4], e.rgba[p * 4 + 1], e.rgba[p * 4 + 2])[0]); c++; }
        for (let j = 0; j < 3; j++) m[j] /= c;
        const lab = e.meanLab ?? labOf(linearToSrgb255(m[0]), linearToSrgb255(m[1]), linearToSrgb255(m[2]));
        const lm = ls.reduce((s, x) => s + x, 0) / ls.length;
        sl = Math.sqrt(ls.reduce((s, x) => s + (x - lm) ** 2, 0) / ls.length);
        // appearance: the colour after tinting is matched anyway, so the spread (grain) and chroma lead; then the colour
        const d = Math.abs(sl - spread) + 0.25 * Colour.calculateDeltaE00(lab as [number, number, number], ringLab);
        if (!best || d < best.d) best = { e, d, mean: m };
    }
    if (!best) return { fill: new Uint8Array(N), count: 0, note: 'no library entry given' };
    const e = best.e;
    const tint = best.mean.map((m, j) => Math.max(0.25, Math.min(4, lin[j] / Math.max(m, 1e-4))));
    // the mip level whose pixel matches the texel's footprint
    const footprint = (w.texelM * e.width) / e.realSizeM[0];
    const level = Math.max(0, Math.floor(Math.log2(Math.max(1, footprint))));
    const f = 1 << level;
    const fill = new Uint8Array(N);
    let count = 0;
    for (let p = 0; p < N; p++) {
        if (!w.open[p]) continue;
        const i = p % w.W, k = (p - i) / w.W;
        const a = (i + 0.5) * w.texelM, b = (k + 0.5) * w.texelM;
        const px = (((Math.floor((a / e.realSizeM[0]) * e.width / f) * f) % e.width) + e.width) % e.width, py = (((Math.floor((b / e.realSizeM[1]) * e.height / f) * f) % e.height) + e.height) % e.height;
        const acc = [0, 0, 0];
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const q = (((py + dy) % e.height) * e.width + ((px + dx) % e.width)) * 4; for (let j = 0; j < 3; j++) acc[j] += SRGB8_TO_LINEAR[e.rgba[q + j]]; }
        for (let j = 0; j < 3; j++) w.rgb[p * 3 + j] = linearToSrgb255(Math.min(1, (acc[j] / (f * f)) * tint[j]));
        fill[p] = 1; count++;
    }
    return { fill, count, entry: e.id, note: `library entry ${e.id} at ${e.realSizeM.join(' x ')} m a tile, tinted to the ring's measured colour` };
}

export const INFILL_INPAINT_PROMPT = (w: number, h: number): string =>
    `This ${w} x ${h} image is a piece of a real surface photographed straight on, from a photogrammetry scan. The flat magenta (#FF00FF) region is where something stood on or in front of the surface and was removed, so the surface there was never seen. ` +
    'Replace only the magenta region with the surface that continues from around it: the same material, colour, lighting and grain, with any line, edge, joint or regular pattern carried through at the same scale, position and alignment. ' +
    'Do not change any pixel outside the magenta region, do not add objects, vehicles, people, plants, text or shadows, and leave no magenta. Answer with the full image at the same framing.';

// ------------------------------------------------------------------------------------------------ one region

const RUNG_LABEL: Record<InfillRungName, InfillLabelName> = {
    'real view': 'measured', 'directional continuation': 'photo-inferred', 'periodic continuation': 'photo-inferred',
    'stochastic synthesis': 'generated', 'library material': 'generated', 'generative inpaint': 'generated', 'membrane fill': 'generated'
};

function admittedOf(reading: StructureReading, texelM: number, S: InfillSynthesisParams): ((dx: number, dy: number) => boolean) | undefined {
    const periods = [reading.along, reading.across].filter((p): p is MeasuredPeriod => !!p);
    const rules: OffsetRule[] = [];
    if (reading.coherence >= S.coherenceMin) rules.push(directionalRule(reading, texelM, S));
    if (periods.length) rules.push(latticeRule(periods, S));
    return rules.length ? (dx, dy) => rules.some(r => r.admits(dx, dy)) : undefined;
}

async function infillOne(spec: InfillRegionSpec, scan: TileTriangles, grid: TriangleGrid, others: Float32Array[], input: InfillInput, P: SurfaceInfillParams, G: SeamGateParams, S: InfillSynthesisParams, Gm: InfillGeometryParams): Promise<RegionInfill> {
    const t0 = Date.now();
    const chart = spec.chart ?? fitChart({ ring: spec.ring, hole: spec.hole, texelM: P.texelM, marginM: P.marginM, maxSide: P.maxSide, normalHint: spec.normalHint }, Gm);
    const model = fitSurfaceModel(spec.ring, chart, Gm);
    const tGeometry = Date.now();
    const W = chart.width, H = chart.height, N = W * H;
    // ---- the hole, the target (hole and guard), the other regions
    const hole = new Uint8Array(N);
    rasterizeTriangles(chart, spec.hole, undefined, Math.floor(spec.hole.length / 9), p => { hole[p] = 1; });
    const guardPx = Math.max(0, Math.round(P.guardM / chart.texelM));
    const dHole = distanceFrom(hole, W, H, guardPx);
    const target = new Uint8Array(N);
    let targetTexels = 0;
    for (let p = 0; p < N; p++) if (dHole[p] <= guardPx) { target[p] = 1; targetTexels++; }
    const excluded = new Uint8Array(N);
    let wlo = Infinity, whi = -Infinity;
    for (const l of model.levels) { wlo = Math.min(wlo, l.loW); whi = Math.max(whi, l.hiW); }
    if (!(whi >= wlo)) { wlo = -1; whi = 1; }
    for (const hole2 of others) {
        rasterizeTriangles(chart, hole2, undefined, Math.floor(hole2.length / 9), (p, _t, w) => {
            const i = p % W, k = (p - i) / W;
            if (Math.abs(w - model.heightAt((i + 0.5) * chart.texelM, (k + 0.5) * chart.texelM)) <= P.excludeBandM) excluded[p] = 1;
        });
    }
    const dExcl = distanceFrom(excluded, W, H, guardPx);
    // ---- the scan's photo along the normal: the first surface per texel
    const box = chartBox(chart, wlo - 3, whi + 30);
    const tris = trianglesInBox(grid, scan, box.lo, box.hi);
    const hitW = new Float32Array(N).fill(-Infinity), hitT = new Int32Array(N).fill(-1), bary = new Float32Array(N * 3);
    rasterizeTriangles(chart, scan.positions, tris, tris.length, (p, tr, w, l1, l2, l3) => {
        if (w > hitW[p]) { hitW[p] = w; hitT[p] = tr; bary[p * 3] = l1; bary[p * 3 + 1] = l2; bary[p * 3 + 2] = l3; }
    });
    const rgb = new Float32Array(N * 3), source = new Uint8Array(N), ref = new Uint8Array(N);
    const c3 = [0, 0, 0];
    let sources = 0;
    for (let p = 0; p < N; p++) {
        const tr = hitT[p];
        if (tr < 0) continue;
        triangleColour(scan, tr, bary[p * 3], bary[p * 3 + 1], bary[p * 3 + 2], c3);
        rgb[p * 3] = linearToSrgb255(c3[0]); rgb[p * 3 + 1] = linearToSrgb255(c3[1]); rgb[p * 3 + 2] = linearToSrgb255(c3[2]);
        if (target[p] || dExcl[p] <= guardPx) continue;
        const nn = scan.normals, facing = Math.abs(nn[tr * 3] * chart.n[0] + nn[tr * 3 + 1] * chart.n[1] + nn[tr * 3 + 2] * chart.n[2]);
        const i = p % W, k = (p - i) / W;
        if (facing >= P.facingMin && Math.abs(hitW[p] - model.heightAt((i + 0.5) * chart.texelM, (k + 0.5) * chart.texelM)) <= P.sourceTolM) { source[p] = 1; ref[p] = 1; sources++; }
    }
    const before = input.keepBefore ? Uint8Array.from(rgb, v => Math.round(v)) : undefined;
    const tRaster = Date.now();
    const label = new Uint8Array(N), rung = new Uint8Array(N).fill(255);
    const open = Uint8Array.from(target);
    const work: Work = { W, H, texelM: chart.texelM, rgb, source, ref, open, label, rung };
    const structure = readStructure(rgb, source, target, W, H, chart.texelM, S);
    const admitted = admittedOf(structure, chart.texelM, S);
    const along = structure.coherence >= S.coherenceMin ? structure.dir : undefined;
    const tStructure = Date.now();
    const attempts: RungAttempt[] = [];
    let failedBest: { attempt: RungAttempt; fill: Uint8Array; colours: Float32Array } | undefined;
    const openCount = () => { let n = 0; for (let p = 0; p < N; p++) if (open[p]) n++; return n; };
    /** Gates an attempt's texels (already written into rgb); keeps them or restores what was there. */
    const settle = (name: InfillRungName, fill: Uint8Array, count: number, prior: Float32Array, what: string, rule?: OffsetRule): boolean => {
        const ts = Date.now();
        if (!count) { attempts.push({ rung: name, label: RUNG_LABEL[name], texels: 0, accepted: false, reason: what || 'nothing it could fill', ms: 0 }); return false; }
        correctToRim(rgb, W, H, fill, ref, S);
        const gate = seamGate({ width: W, height: H, texelM: chart.texelM, rgb, fill, ref, admitted: rule ? (dx, dy) => rule.admits(dx, dy) || !!admitted?.(dx, dy) : admitted, ...(along ? { along } : {}) }, G);
        const attempt: RungAttempt = { rung: name, label: RUNG_LABEL[name], texels: count, accepted: gate.pass, reason: gate.pass ? what : `rejected by the seam gate: ${gate.failures.join('; ')}`, gate, ms: Date.now() - ts };
        attempts.push(attempt);
        if (gate.pass) {
            for (let p = 0; p < N; p++) if (fill[p]) { open[p] = 0; ref[p] = 1; label[p] = LABEL_CODE[RUNG_LABEL[name]]; rung[p] = INFILL_RUNGS.indexOf(name); }
            return true;
        }
        // the least bad failure covering every open texel is kept aside, in case nothing passes
        let covers = true;
        for (let p = 0; p < N && covers; p++) if (open[p] && !fill[p]) covers = false;
        if (covers && (!failedBest || gate.excess < (failedBest.attempt.gate?.excess ?? Infinity))) failedBest = { attempt, fill: Uint8Array.from(fill), colours: snapshot(work, fill) };
        restore(work, fill, prior);
        return false;
    };
    // ---- 1. real views
    if (input.views?.length) {
        const ts = Date.now();
        const prior = snapshot(work, open);
        const depths = new Map<InfillView, Float32Array>();
        const depthOf = (v: InfillView) => {
            let d = v.depth ?? depths.get(v);
            if (!d) {
                const lo: Vec3 = [Math.min(box.lo[0], v.camera.eye[0]), Math.min(box.lo[1], v.camera.eye[1]), Math.min(box.lo[2], v.camera.eye[2])];
                const hi: Vec3 = [Math.max(box.hi[0], v.camera.eye[0]), Math.max(box.hi[1], v.camera.eye[1]), Math.max(box.hi[2], v.camera.eye[2])];
                // what was removed is no occluder: the region's own triangles standing on or over the surface are left out
                const occluders = trianglesInBox(grid, scan, lo, hi).filter(tr => {
                    const o = tr * 9, Pp = scan.positions;
                    const [a, b, w] = toChart(chart, (Pp[o] + Pp[o + 3] + Pp[o + 6]) / 3, (Pp[o + 1] + Pp[o + 4] + Pp[o + 7]) / 3, (Pp[o + 2] + Pp[o + 5] + Pp[o + 8]) / 3);
                    const i = Math.floor(a / chart.texelM), k = Math.floor(b / chart.texelM);
                    if (i < 0 || k < 0 || i >= W || k >= H || !target[k * W + i]) return true;
                    return w < model.heightAt(a, b) - P.sourceTolM || w > model.heightAt(a, b) + P.moveMaxM;
                });
                d = viewDepth(v, scan, occluders);
                depths.set(v, d);
            }
            return d;
        };
        const r = viewFill(work, chart, model, input.views, depthOf, P);
        const ok = settle('real view', r.fill, r.count, prior, `seen clear in ${r.used.length} registered photo${r.used.length === 1 ? '' : 's'} (${r.used.join(', ')}), gain-matched to the ring${r.note ? `; ${r.note}` : ''}`);
        if (!r.count) attempts[attempts.length - 1].reason = `no registered photo sees the surface here clear (${input.views.length} given)`;
        attempts[attempts.length - 1].ms = Date.now() - ts;
        void ok;
    } else attempts.push({ rung: 'real view', label: 'measured', texels: 0, accepted: false, reason: 'no registered photo was given for this surface', ms: 0 });
    // ---- 2. continuation from the surface's own clear texels
    const sourceList: number[] = [];
    for (let p = 0; p < N; p++) if (source[p]) sourceList.push(p);
    const continuation = (name: InfillRungName, rule: OffsetRule | undefined, refusal: string | undefined, what: string, extra?: (t: number) => Array<[number, number]>) => {
        if (!openCount()) return;
        if (!rule) { attempts.push({ rung: name, label: RUNG_LABEL[name], texels: 0, accepted: false, reason: refusal ?? 'not applicable', ms: 0 }); return; }
        if (sources < P.minSources) { attempts.push({ rung: name, label: RUNG_LABEL[name], texels: 0, accepted: false, reason: `only ${sources} clear texels of the surface around the region (< ${P.minSources})`, ms: 0 }); return; }
        const ts = Date.now();
        const prior = snapshot(work, open);
        const target2 = Uint8Array.from(open);
        const context = new Uint8Array(N);
        for (let p = 0; p < N; p++) if (ref[p] && !open[p]) context[p] = 1;
        const r = synthesize(rgb, W, H, source, context, target2, rule, S, extra);
        // a structural rule's own offsets are the surface's measured repeat, not a copy; a stochastic fill admits none
        settle(name, r.filled, r.count, prior, what, rule.name === 'stochastic' ? undefined : rule);
        attempts[attempts.length - 1].ms = Date.now() - ts;
    };
    const dirRule = structure.coherence >= S.coherenceMin ? directionalRule(structure, chart.texelM, S) : undefined;
    // the line's own ends: the first clear texel past the region each way along the direction (and a few beyond)
    const endCache = new Map<number, Array<[number, number]>>();
    const ends = dirRule ? (t: number): Array<[number, number]> => {
        const hit = endCache.get(t);
        if (hit) return hit;
        const out: Array<[number, number]> = [];
        endCache.set(t, out);
        const ti = t % W, tk = (t - ti) / W, [ax, ay] = structure.dir;
        for (const s of [1, -1]) {
            for (let e = 1; e < W + H; e++) {
                const i = Math.round(ti + s * e * ax), k = Math.round(tk + s * e * ay);
                if (i < 0 || k < 0 || i >= W || k >= H) break;
                if (source[k * W + i]) {
                    const step = structure.along ? structure.along.pitchPx : 1;
                    for (let m = 0; m < 3; m++) {
                        let lam = e + m * 2;
                        if (structure.along) lam = Math.max(1, Math.round(lam / step)) * step;
                        out.push([Math.round(s * lam * ax), Math.round(s * lam * ay)]);
                    }
                    break;
                }
            }
        }
        return out;
    } : undefined;
    const periodTxt = (p?: MeasuredPeriod) => (p ? `${p.pitchM.toFixed(2)} m (NCC ${p.ncc})` : '');
    continuation('directional continuation', dirRule, structure.refusals.find(r => r.startsWith('no measured direction')),
        `continued along the surface's measured direction (${structure.angleDeg.toFixed(0)}° in the chart, coherence ${structure.coherence.toFixed(2)}) from its clear texels on the same line${structure.along ? `, at the measured period along it ${periodTxt(structure.along)}` : ''}${structure.across ? `, crossing bars at their period ${periodTxt(structure.across)}` : ''}`, ends);
    const periods = [structure.along, structure.across].filter((p): p is MeasuredPeriod => !!p);
    continuation('periodic continuation', periods.length ? latticeRule(periods, S) : undefined, structure.refusals.filter(r => !r.startsWith('no measured direction')).join('; ') || 'no repeat measured',
        `copied in phase at the surface's measured repeat (${periods.map(p => periodTxt(p)).join(' and ')}) from its clear texels`);
    continuation('stochastic synthesis', stochasticRule(sourceList, W), undefined, `synthesised from patches of the surface's own clear texels (${sources} around the region): its grain, not its exact layout`);
    // ---- 3. library
    if (openCount()) {
        if (input.library?.length) {
            const ts = Date.now();
            const prior = snapshot(work, open);
            const r = libraryFillChart(work, input.library);
            settle('library material', r.fill, r.count, prior, r.note);
            attempts[attempts.length - 1].ms = Date.now() - ts;
        } else attempts.push({ rung: 'library material', label: 'generated', texels: 0, accepted: false, reason: 'no library material was given', ms: 0 });
    }
    // ---- 4. inpaint
    if (openCount()) {
        if (input.inpaint) {
            const ts = Date.now();
            let x0 = W, y0 = H, x1 = -1, y1 = -1;
            for (let p = 0; p < N; p++) if (open[p]) { const i = p % W, k = (p - i) / W; x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, k); y1 = Math.max(y1, k); }
            const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.5) + 8;
            x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
            const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
            const crop = new Uint8Array(cw * ch * 4), holeC = new Uint8Array(cw * ch), keepC = new Uint8Array(cw * ch);
            for (let k = 0; k < ch; k++) for (let i = 0; i < cw; i++) {
                const p = (y0 + k) * W + (x0 + i), q = k * cw + i;
                for (let j = 0; j < 3; j++) crop[q * 4 + j] = Math.round(rgb[p * 3 + j]);
                crop[q * 4 + 3] = 255;
                if (open[p]) holeC[q] = 1; else if (ref[p]) keepC[q] = 1;
            }
            const prior = snapshot(work, open);
            let res: Awaited<ReturnType<InfillInpainter>>;
            try { res = await input.inpaint({ rgba: crop, width: cw, height: ch, hole: holeC, keep: keepC, prompt: INFILL_INPAINT_PROMPT(cw, ch), ...(input.signal ? { signal: input.signal } : {}) }); }
            catch (err) { res = { refused: err instanceof Error ? err.message : String(err) }; }
            if ('refused' in res) attempts.push({ rung: 'generative inpaint', label: 'generated', texels: 0, accepted: false, reason: `the inpaint was not used: ${res.refused}`, ms: Date.now() - ts });
            else {
                const fill = new Uint8Array(N);
                let count = 0;
                for (let k = 0; k < ch; k++) for (let i = 0; i < cw; i++) {
                    const q = k * cw + i;
                    if (!holeC[q]) continue;
                    const p = (y0 + k) * W + (x0 + i);
                    for (let j = 0; j < 3; j++) rgb[p * 3 + j] = res.rgba[q * 4 + j];
                    fill[p] = 1; count++;
                }
                settle('generative inpaint', fill, count, prior, `generative inpaint${res.model ? ` (${res.model})` : ''}, detail-locked to the texels around it`);
                attempts[attempts.length - 1].ms = Date.now() - ts;
            }
        } else attempts.push({ rung: 'generative inpaint', label: 'generated', texels: 0, accepted: false, reason: 'no inpaint model was given', ms: 0 });
    }
    // ---- what no rung passed for
    let gatePassed = true;
    if (openCount()) {
        gatePassed = false;
        if (failedBest) {
            const { attempt, fill, colours } = failedBest;
            const name = attempt.rung;
            for (let p = 0; p < N; p++) if (fill[p] && open[p]) { rgb[p * 3] = colours[p * 3]; rgb[p * 3 + 1] = colours[p * 3 + 1]; rgb[p * 3 + 2] = colours[p * 3 + 2]; open[p] = 0; label[p] = LABEL_CODE.generated; rung[p] = INFILL_RUNGS.indexOf(name); }
            attempts.push({ rung: name, label: 'generated', texels: attempt.texels, accepted: false, reason: `no rung passed the seam gate: the least bad attempt (${name}) is kept, labelled generated, its failures as they were (${attempt.gate?.failures.join('; ')})`, ...(attempt.gate ? { gate: attempt.gate } : {}), ms: 0 });
        }
        if (openCount()) {
            // nothing could be sourced at all: the ring's colours carried smoothly across
            const vals = new Float32Array(N * 3), known = new Float32Array(N);
            for (let p = 0; p < N; p++) if (ref[p] && !open[p]) { for (let j = 0; j < 3; j++) vals[p * 3 + j] = rgb[p * 3 + j]; known[p] = 1; }
            const field = known.some(v => v > 0) ? pushPull(vals, known, W, H, 3) : vals;
            let n = 0;
            for (let p = 0; p < N; p++) if (open[p]) { for (let j = 0; j < 3; j++) rgb[p * 3 + j] = field[p * 3 + j]; open[p] = 0; label[p] = LABEL_CODE.generated; rung[p] = INFILL_RUNGS.indexOf('membrane fill'); n++; }
            attempts.push({ rung: 'membrane fill', label: 'generated', texels: n, accepted: false, reason: 'nothing could be sourced for these texels (no clear surface, view, library or inpaint): the colours around them carried smoothly across', ms: 0 });
        }
    }
    const shares: Record<InfillLabelName, number> = { measured: 0, 'photo-inferred': 0, generated: 0 };
    for (let p = 0; p < N; p++) if (target[p] && label[p]) shares[LABEL_NAME[label[p]]]++;
    for (const k of Object.keys(shares) as InfillLabelName[]) shares[k] = targetTexels ? Math.round((shares[k] / targetTexels) * 1000) / 1000 : 0;
    const kept = attempts.filter(a => a.accepted).map(a => `${a.rung} ${a.texels} texels`);
    const reason = `${spec.what}: the surface under it rebuilt from the measured ring (${model.note}); texels ${kept.length ? kept.join(', ') : 'from no rung that passed the seam gate'}${gatePassed ? '' : ' (the rest kept from the attempt that failed least, labelled generated)'}`;
    return {
        id: spec.id, what: spec.what, chart, model, structure, rgb: Uint8Array.from(rgb, v => Math.max(0, Math.min(255, Math.round(v)))), ...(before ? { before } : {}),
        target, source, label, rung, attempts, shares, gatePassed, targetTexels, reason, ms: Date.now() - t0,
        timings: { geometry: tGeometry - t0, raster: tRaster - tGeometry, structure: tStructure - tRaster, rungs: Date.now() - tStructure }
    };
}

/** The infill of every region (see the file comment). */
export async function infillRegions(input: InfillInput): Promise<{ regions: RegionInfill[]; ms: number }> {
    const t0 = Date.now();
    const P = { ...SURFACE_INFILL_PARAMS, ...input.params }, G = { ...SEAM_GATE, ...input.gate }, S = { ...INFILL_SYNTHESIS_PARAMS, ...input.synthesis }, Gm = { ...INFILL_GEOMETRY_PARAMS, ...input.geometry };
    const grid = triangleGrid(input.scan);
    const out: RegionInfill[] = [];
    // the other regions near each one (by their holes' plan boxes)
    const boxOf = (h: Float32Array) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (let i = 0; i < h.length; i += 3) { x0 = Math.min(x0, h[i]); x1 = Math.max(x1, h[i]); z0 = Math.min(z0, h[i + 2]); z1 = Math.max(z1, h[i + 2]); } return { x0, z0, x1, z1 }; };
    const boxes = input.regions.map(r => boxOf(r.hole));
    const exclude = (input.exclude ?? []).map(h => ({ h, b: boxOf(h) }));
    for (let k = 0; k < input.regions.length; k++) {
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('aborted');
        const b = boxes[k], reach = P.marginM + 1;
        const near = (o: { x0: number; z0: number; x1: number; z1: number }) => o.x1 >= b.x0 - reach && o.x0 <= b.x1 + reach && o.z1 >= b.z0 - reach && o.z0 <= b.z1 + reach;
        const others = [...input.regions.filter((_, j) => j !== k && near(boxes[j])).map(r => r.hole), ...exclude.filter(e => near(e.b)).map(e => e.h)];
        const r = await infillOne(input.regions[k], input.scan, grid, others, input, P, G, S, Gm);
        input.log?.(`infill ${r.id}: ${r.targetTexels} texels, ${r.attempts.filter(a => a.accepted).map(a => a.rung).join(' + ') || 'no rung passed'} (${r.ms} ms)`);
        out.push(r);
    }
    return { regions: out, ms: Date.now() - t0 };
}

/**
 * The seam gate's numbers for whatever a scan now holds over a region (another step's fill, or this one's written back):
 * the scan rendered along the region's chart as the infill reads it, the region's target the fill, its clear texels the
 * reference. So two fills of one region are measured alike.
 */
export function measureFill(scan: TileTriangles, r: RegionInfill, gate: Partial<SeamGateParams> = {}): { gate: SeamGateResult; rgb: Uint8Array } {
    const c = r.chart, N = c.width * c.height;
    const grid = triangleGrid(scan);
    let wlo = Infinity, whi = -Infinity;
    for (const l of r.model.levels) { wlo = Math.min(wlo, l.loW); whi = Math.max(whi, l.hiW); }
    const box = chartBox(c, wlo - 3, whi + 30);
    const tris = trianglesInBox(grid, scan, box.lo, box.hi);
    const hitW = new Float32Array(N).fill(-Infinity), hitT = new Int32Array(N).fill(-1), bary = new Float32Array(N * 3);
    rasterizeTriangles(c, scan.positions, tris, tris.length, (p, tr, w, l1, l2, l3) => { if (w > hitW[p]) { hitW[p] = w; hitT[p] = tr; bary[p * 3] = l1; bary[p * 3 + 1] = l2; bary[p * 3 + 2] = l3; } });
    const rgb = new Float32Array(N * 3), c3 = [0, 0, 0];
    for (let p = 0; p < N; p++) {
        if (hitT[p] < 0) continue;
        triangleColour(scan, hitT[p], bary[p * 3], bary[p * 3 + 1], bary[p * 3 + 2], c3);
        rgb[p * 3] = linearToSrgb255(c3[0]); rgb[p * 3 + 1] = linearToSrgb255(c3[1]); rgb[p * 3 + 2] = linearToSrgb255(c3[2]);
    }
    const result = seamGate({ width: c.width, height: c.height, texelM: c.texelM, rgb, fill: r.target, ref: r.source, admitted: admittedOf(r.structure, c.texelM, INFILL_SYNTHESIS_PARAMS), ...(r.structure.coherence >= INFILL_SYNTHESIS_PARAMS.coherenceMin ? { along: r.structure.dir } : {}) }, { ...SEAM_GATE, ...gate });
    return { gate: result, rgb: Uint8Array.from(rgb, v => Math.round(v)) };
}

// ------------------------------------------------------------------------------------------------ the region from a plan grid

/** Plan-grid cells (cellM, origin x0, z0) as world triangles at height `y`: a removal step's cell mask as a hole. */
export function cellsToTriangles(cells: ArrayLike<number>, nx: number, x0: number, z0: number, cellM: number, y: (x: number, z: number) => number): Float32Array {
    const out = new Float32Array(cells.length * 18);
    for (let j = 0; j < cells.length; j++) {
        const c = cells[j], i = c % nx, k = (c - i) / nx;
        const xa = x0 + i * cellM, xb = xa + cellM, za = z0 + k * cellM, zb = za + cellM;
        const ya = y(xa, za), yb = y(xb, za), yc = y(xa, zb), yd = y(xb, zb);
        out.set([xa, ya, za, xa, yc, zb, xb, yb, za, xb, yb, za, xa, yc, zb, xb, yd, zb], j * 18);
    }
    return out;
}

// ------------------------------------------------------------------------------------------------ the GLB

export interface InfillGlbStats { movedVertices: number; paintedTexels: number; repaintedImages: number; primitives: number }

/** Bilinear sRGB sample of a region's fill at chart (a, b), from its target texels only (undefined outside them). */
function sampleRegion(r: RegionInfill, a: number, b: number, out: number[]): boolean {
    const c = r.chart, fx = a / c.texelM - 0.5, fz = b / c.texelM - 0.5;
    const i0 = Math.floor(fx), k0 = Math.floor(fz), ax = fx - i0, az = fz - k0;
    let sw = 0;
    out[0] = out[1] = out[2] = 0;
    for (const [di, dk, w] of [[0, 0, (1 - ax) * (1 - az)], [1, 0, ax * (1 - az)], [0, 1, (1 - ax) * az], [1, 1, ax * az]] as Array<[number, number, number]>) {
        const i = i0 + di, k = k0 + dk;
        if (i < 0 || k < 0 || i >= c.width || k >= c.height || w <= 0) continue;
        const p = k * c.width + i;
        if (!r.target[p]) continue;
        sw += w;
        for (let j = 0; j < 3; j++) out[j] += w * r.rgb[p * 3 + j];
    }
    if (sw <= 0) return false;
    for (let j = 0; j < 3; j++) out[j] /= sw;
    return true;
}

function inTarget(r: RegionInfill, a: number, b: number): boolean {
    const i = Math.floor(a / r.chart.texelM), k = Math.floor(b / r.chart.texelM);
    return i >= 0 && k >= 0 && i < r.chart.width && k < r.chart.height && r.target[k * r.chart.width + i] === 1;
}

/**
 * Writes the infill into a GLB: with `moveVertices`, every vertex inside a region's target and within `moveMaxM` of its
 * model (and that the predicate takes) moves along the chart's normal onto it; with `paint`, every texel of a triangle
 * whose surface lies in a region's target (within `paintTolM` of its model) takes the fill. Index lists are untouched (no
 * triangle removed, no edge opened). `extras` lands in the GLB's root and scene extras.
 */
export function applyInfillToGlb(bytes: Uint8Array, regions: RegionInfill[], opts: { moveVertices?: boolean | ((world: Vec3, region: number) => boolean); paint?: boolean; extras?: Record<string, unknown>; params?: Partial<SurfaceInfillParams> } = {}): { glb: Buffer; stats: InfillGlbStats } {
    const P = { ...SURFACE_INFILL_PARAMS, ...opts.params };
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const bin = new Uint8Array(glb.bin.byteLength);
    bin.set(glb.bin);
    const dv = new DataView(bin.buffer);
    const world = nodeWorldMatrices(json);
    const stats: InfillGlbStats = { movedVertices: 0, paintedTexels: 0, repaintedImages: 0, primitives: 0 };
    // the regions' world boxes, in a plan grid
    const rb = regions.map(r => chartBox(r.chart, Math.min(...r.model.levels.map(l => l.loW)) - P.moveMaxM, Math.max(...r.model.levels.map(l => l.hiW)) + P.moveMaxM));
    const regionsAt = (lo: Vec3, hi: Vec3) => { const out: number[] = []; rb.forEach((b, k) => { if (b.hi[0] >= lo[0] && b.lo[0] <= hi[0] && b.hi[1] >= lo[1] && b.lo[1] <= hi[1] && b.hi[2] >= lo[2] && b.lo[2] <= hi[2]) out.push(k); }); return out; };
    const images = new Map<number, { width: number; height: number; rgba: Uint8Array; mime: string }>();
    const dirty = new Set<number>();
    const done = new Set<number>();
    const layout = (ai: number) => { const a = json.accessors[ai], v = json.bufferViews[a.bufferView]; const comps = a.type === 'VEC3' ? 3 : a.type === 'VEC2' ? 2 : 1; return { a, base: (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: v.byteStride || comps * 4, comps }; };
    const all: Vec3 = [Infinity, Infinity, Infinity];
    const allHi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const b of rb) for (let j = 0; j < 3; j++) { all[j] = Math.min(all[j], b.lo[j]); allHi[j] = Math.max(allHi[j], b.hi[j]); }
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        const m = world[ni], ident = isIdentity(m), inv = ident ? m : invert(m);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pl = layout(prim.attributes.POSITION);
            if (pl.a.componentType !== 5126 || pl.comps !== 3 || pl.a.sparse) continue;
            const n = pl.a.count;
            const wp = new Float64Array(n * 3);
            const moved = new Uint8Array(n);
            for (let v = 0; v < n; v++) {
                const o = pl.base + v * pl.stride;
                const w = ident ? [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)] : transformPoint(m, dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
                wp[v * 3] = w[0]; wp[v * 3 + 1] = w[1]; wp[v * 3 + 2] = w[2];
            }
            let any = 0;
            if (opts.moveVertices) {
                for (let v = 0; v < n; v++) {
                    const x = wp[v * 3], y = wp[v * 3 + 1], z = wp[v * 3 + 2];
                    if (x < all[0] || y < all[1] || z < all[2] || x > allHi[0] || y > allHi[1] || z > allHi[2]) continue;
                    for (const k of regionsAt([x, y, z], [x, y, z])) {
                        const r = regions[k], [a, b, wv] = toChart(r.chart, x, y, z);
                        if (!inTarget(r, a, b)) continue;
                        const h = r.model.heightAt(a, b);
                        if (Math.abs(wv - h) > P.moveMaxM) continue;
                        if (typeof opts.moveVertices === 'function' && !opts.moveVertices([x, y, z], k)) continue;
                        const q = fromChart(r.chart, a, b, h);
                        wp[v * 3] = q[0]; wp[v * 3 + 1] = q[1]; wp[v * 3 + 2] = q[2];
                        const l = ident ? q : transformPoint(inv, q[0], q[1], q[2]);
                        const o = pl.base + v * pl.stride;
                        dv.setFloat32(o, l[0], true); dv.setFloat32(o + 4, l[1], true); dv.setFloat32(o + 8, l[2], true);
                        moved[v] = 1; any++;
                        break;
                    }
                }
                if (any) {
                    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
                    for (let v = 0; v < n; v++) for (let j = 0; j < 3; j++) { const q = dv.getFloat32(pl.base + v * pl.stride + j * 4, true); mn[j] = Math.min(mn[j], q); mx[j] = Math.max(mx[j], q); }
                    pl.a.min = mn; pl.a.max = mx;
                    stats.movedVertices += any;
                }
            }
            const idxAcc = prim.indices !== undefined ? json.accessors[prim.indices] : undefined;
            const count = idxAcc ? idxAcc.count : n;
            const readIndex = (k: number) => {
                if (!idxAcc) return k;
                const v = json.bufferViews[idxAcc.bufferView];
                const size = idxAcc.componentType === 5125 ? 4 : idxAcc.componentType === 5123 ? 2 : 1;
                const o = (v.byteOffset ?? 0) + (idxAcc.byteOffset ?? 0) + k * (v.byteStride || size);
                return size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
            };
            let touched = any > 0;
            if (opts.paint) {
                const mat = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture;
                const uvAcc = mat ? prim.attributes[`TEXCOORD_${mat.texCoord ?? 0}`] : undefined;
                const imageIndex = mat ? json.textures?.[mat.index]?.source : undefined;
                const image = imageIndex !== undefined ? json.images?.[imageIndex] : undefined;
                if (uvAcc !== undefined && image && image.bufferView !== undefined && layout(uvAcc).a.componentType === 5126) {
                    const ul = layout(uvAcc);
                    let img = images.get(imageIndex);
                    const col = [0, 0, 0];
                    for (let t = 0; t + 2 < count; t += 3) {
                        const a = readIndex(t), b = readIndex(t + 1), c = readIndex(t + 2);
                        const lo: Vec3 = [Math.min(wp[a * 3], wp[b * 3], wp[c * 3]), Math.min(wp[a * 3 + 1], wp[b * 3 + 1], wp[c * 3 + 1]), Math.min(wp[a * 3 + 2], wp[b * 3 + 2], wp[c * 3 + 2])];
                        const hi: Vec3 = [Math.max(wp[a * 3], wp[b * 3], wp[c * 3]), Math.max(wp[a * 3 + 1], wp[b * 3 + 1], wp[c * 3 + 1]), Math.max(wp[a * 3 + 2], wp[b * 3 + 2], wp[c * 3 + 2])];
                        if (hi[0] < all[0] || hi[1] < all[1] || hi[2] < all[2] || lo[0] > allHi[0] || lo[1] > allHi[1] || lo[2] > allHi[2]) continue;
                        const ks = regionsAt(lo, hi);
                        if (!ks.length) continue;
                        if (!img) {
                            const view = json.bufferViews[image.bufferView];
                            const d = decodeImageInMemory(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
                            img = { width: d.width, height: d.height, rgba: new Uint8Array(d.rgba), mime: image.mimeType ?? 'image/jpeg' };
                            images.set(imageIndex, img);
                        }
                        const IW = img.width, IH = img.height;
                        const uv = (v: number) => [dv.getFloat32(ul.base + v * ul.stride, true) * IW - 0.5, dv.getFloat32(ul.base + v * ul.stride + 4, true) * IH - 0.5];
                        const [ua, va] = uv(a), [ub, vb] = uv(b), [uc, vc] = uv(c);
                        const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
                        if (Math.abs(det) < 1e-9) continue;
                        const i0 = Math.max(0, Math.floor(Math.min(ua, ub, uc)) - 1), i1 = Math.min(IW - 1, Math.ceil(Math.max(ua, ub, uc)) + 1);
                        const k0 = Math.max(0, Math.floor(Math.min(va, vb, vc)) - 1), k1 = Math.min(IH - 1, Math.ceil(Math.max(va, vb, vc)) + 1);
                        if ((i1 - i0 + 1) * (k1 - k0 + 1) > 4_000_000) continue;
                        // one texel past the triangle's edges, so the chart border's filtering reads the new colour too
                        const e = [Math.hypot(ub - uc, vb - vc), Math.hypot(uc - ua, vc - va), Math.hypot(ua - ub, va - vb)];
                        const tol = e.map(L => 1 / Math.max(Math.abs(det) / Math.max(L, 1e-9), 1e-6));
                        let painted = 0;
                        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
                            const l1 = ((ub - i) * (vc - k) - (uc - i) * (vb - k)) / det, l2 = ((uc - i) * (va - k) - (ua - i) * (vc - k)) / det, l3 = 1 - l1 - l2;
                            if (l1 < -tol[0] || l2 < -tol[1] || l3 < -tol[2]) continue;
                            const b1 = Math.max(0, l1), b2 = Math.max(0, l2), b3 = Math.max(0, l3), bs = b1 + b2 + b3 || 1;
                            const x = (b1 * wp[a * 3] + b2 * wp[b * 3] + b3 * wp[c * 3]) / bs, y = (b1 * wp[a * 3 + 1] + b2 * wp[b * 3 + 1] + b3 * wp[c * 3 + 1]) / bs, z = (b1 * wp[a * 3 + 2] + b2 * wp[b * 3 + 2] + b3 * wp[c * 3 + 2]) / bs;
                            for (const kr of ks) {
                                const r = regions[kr], [ca, cb, cw] = toChart(r.chart, x, y, z);
                                if (!inTarget(r, ca, cb) || Math.abs(cw - r.model.heightAt(ca, cb)) > P.paintTolM) continue;
                                if (!sampleRegion(r, ca, cb, col)) continue;
                                const q = (k * IW + i) * 4;
                                img.rgba[q] = Math.round(col[0]); img.rgba[q + 1] = Math.round(col[1]); img.rgba[q + 2] = Math.round(col[2]);
                                painted++;
                                break;
                            }
                        }
                        if (painted) { stats.paintedTexels += painted; dirty.add(imageIndex); touched = true; }
                    }
                }
            }
            if (touched) stats.primitives++;
            // normals of moved vertices: the chart's normal (in the node's frame)
            if (any && prim.attributes.NORMAL !== undefined) {
                const nl = layout(prim.attributes.NORMAL);
                if (nl.a.componentType === 5126 && nl.comps === 3) for (let v = 0; v < n; v++) {
                    if (!moved[v]) continue;
                    const ks = regionsAt([wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]], [wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]]);
                    const r = regions[ks[0]];
                    if (!r) continue;
                    let nn = r.chart.n as number[];
                    if (!ident) { const x = m[0] * nn[0] + m[1] * nn[1] + m[2] * nn[2], y = m[4] * nn[0] + m[5] * nn[1] + m[6] * nn[2], z = m[8] * nn[0] + m[9] * nn[1] + m[10] * nn[2]; const L = Math.hypot(x, y, z) || 1; nn = [x / L, y / L, z / L]; }
                    const o = nl.base + v * nl.stride;
                    dv.setFloat32(o, nn[0], true); dv.setFloat32(o + 4, nn[1], true); dv.setFloat32(o + 8, nn[2], true);
                }
            }
        }
    });
    const replaced = new Map<number, Uint8Array>();
    for (const [imageIndex, img] of images) {
        if (!dirty.has(imageIndex)) continue;
        const data = img.mime === 'image/png' ? new Uint8Array(encodePng(img.width, img.height, img.rgba, 4)) : new Uint8Array(jpegJs.encode({ data: Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength), width: img.width, height: img.height }, 92).data);
        replaced.set(json.images[imageIndex].bufferView, data);
        stats.repaintedImages++;
    }
    let out: Uint8Array = bin;
    if (replaced.size) {
        const parts = (json.bufferViews as any[]).map((view, vi) => ({ view, data: replaced.get(vi) ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength) }));
        let len = 0;
        for (const p of parts) { len += (4 - (len % 4)) % 4; len += p.data.byteLength; }
        out = new Uint8Array(len);
        let o = 0;
        for (const p of parts) { o += (4 - (o % 4)) % 4; out.set(p.data, o); p.view.byteOffset = o; p.view.byteLength = p.data.byteLength; o += p.data.byteLength; }
        if (json.buffers?.[0]) json.buffers[0].byteLength = out.byteLength;
    }
    if (opts.extras) {
        const scene = json.scenes?.[json.scene ?? 0];
        json.extras = { ...(json.extras ?? {}), ...opts.extras };
        if (scene) scene.extras = { ...(scene.extras ?? {}), ...opts.extras };
    }
    return { glb: assembleGlb(json, out), stats };
}

// ------------------------------------------------------------------------------------------------ the record

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The GLB extras entry (`sbInfill`) for a set of regions: per region its chart, geometry and texture provenance. */
export function infillExtras(regions: RegionInfill[], step: string): Record<string, unknown> {
    return {
        sbInfill: {
            version: SURFACE_INFILL_VERSION, step,
            regions: regions.map(r => ({
                id: r.id, what: r.what, chart: { origin: r.chart.origin.map(r3), u: r.chart.u.map(r3), v: r.chart.v.map(r3), n: r.chart.n.map(r3), texelM: r3(r.chart.texelM), width: r.chart.width, height: r.chart.height },
                geometry: { label: 'generated', kind: r.model.kind, levels: r.model.levels.length, ringPoints: r.model.ringPoints, ringRmsM: r3(r.model.ringRmsM), reason: `estimated from the measured surface around it: nothing was measured under what was removed (${r.model.note})` },
                texture: { shares: r.shares, gatePassed: r.gatePassed, rungs: r.attempts.filter(a => a.texels > 0).map(a => ({ rung: a.rung, label: a.label, texels: a.texels, accepted: a.accepted, reason: a.reason, rim: a.gate?.metrics.rim ? r3(a.gate.metrics.rim.median) : null })) }
            }))
        }
    };
}

/** Label raster colours for records and sheets (Okabe-Ito): measured blue, photo-inferred bluish green, generated vermillion. */
export const INFILL_LABEL_RGB: Record<number, [number, number, number]> = { 0: [0, 0, 0], 1: [0, 114, 178], 2: [0, 158, 115], 3: [213, 94, 0] };

/** Writes each region's before, after and label rasters (PNG) and the report (JSON) into `dir`. */
export function writeInfillRecords(dir: string, regions: RegionInfill[], step: string): string {
    fs.mkdirSync(dir, { recursive: true });
    for (const r of regions) {
        const W = r.chart.width, H = r.chart.height;
        if (r.before) fs.writeFileSync(path.join(dir, `infill_${r.id}_before.png`), encodePng(W, H, r.before, 3));
        fs.writeFileSync(path.join(dir, `infill_${r.id}_after.png`), encodePng(W, H, r.rgb, 3));
        const lab = new Uint8Array(W * H * 3);
        for (let p = 0; p < W * H; p++) { const c = r.target[p] ? INFILL_LABEL_RGB[r.label[p]] : [Math.round(r.rgb[p * 3] * 0.35), Math.round(r.rgb[p * 3 + 1] * 0.35), Math.round(r.rgb[p * 3 + 2] * 0.35)]; lab[p * 3] = c[0]; lab[p * 3 + 1] = c[1]; lab[p * 3 + 2] = c[2]; }
        fs.writeFileSync(path.join(dir, `infill_${r.id}_labels.png`), encodePng(W, H, lab, 3));
    }
    const report = path.join(dir, 'infill.json');
    fs.writeFileSync(report, JSON.stringify({
        schema: 'scratchbox.surface-infill/1', version: SURFACE_INFILL_VERSION, step,
        regions: regions.map(r => ({ id: r.id, what: r.what, targetTexels: r.targetTexels, shares: r.shares, gatePassed: r.gatePassed, reason: r.reason, structure: { angleDeg: r3(r.structure.angleDeg), coherence: r3(r.structure.coherence), along: r.structure.along, across: r.structure.across, refusals: r.structure.refusals }, model: { kind: r.model.kind, levels: r.model.levels, breakline: r.model.breakline, ringRmsM: r3(r.model.ringRmsM), note: r.model.note }, attempts: r.attempts, ms: r.ms }))
    }, null, 1));
    return report;
}
