/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D's seam stage, one chunk at a time (scene-healing §3.1): the chunks' grounds made into one surface without
 * ever holding the district's ground in memory at once.
 *
 * Each chunk's joined ground keeps a band of `seamBandM` past its own edge (district-chunks.ts chunkTerritory), so along a
 * cell line two grounds overlap: two copies of one surface, a few centimetres apart, that z-fight. The rims never meet
 * within a weld's tolerance (each lies a band's width inside the other's surface), so a rim weld closes nothing there.
 * Instead:
 *  1. Colour (sampleSeamColour, solveSeamGains): before cutting, each chunk's textured ground is sampled from above on one
 *     grid shared by all chunks, in the bands either side of every cell line, the highest surface at each point, in linear
 *     RGB. Where two chunks' samples stand on one surface (heights within `sameSurfaceM`), the median log ratio per channel
 *     is how much brighter one chunk's photos are than the other's there; one gain per chunk and channel is solved from
 *     every pair by least squares (mean zero over the chunks), so the district keeps its own overall level.
 *     Brightness is levelled in full, hue only by `maxHueShift` (a gain per channel tinted whole chunks).
 *  2. Cut (cutChunkGround): each chunk's ground is cut exactly at the cell lines around what it owns, the pieces kept by
 *     who owns their middle, every vertex attribute carried, so both copies end on the same line. Where ownership changes
 *     at no cell line (the outline of a building that reaches into the next cell: its own chunk's build may have taken the
 *     street out from under it), a triangle across the change is kept by each chunk owning a corner of it: a sliver of
 *     overlap beside a wall rather than a hole. Who owns a point (seamOwner) is the
 *     plan's owner (district-chunks.ts chunkOwner) where that chunk's ground reaches it, else a chunk whose ground does
 *     (seamCoverage, read from every chunk first): a building far larger than a cell can reach past where its own chunk's
 *     extraction stopped, and its ground there must not be handed to a chunk that has none.
 *  3. Snap: chunks are cut in a fixed order; each later chunk's vertices on a cell line are moved, along the line and up
 *     or down, onto the nearest edge an earlier chunk left on that line within `snapM`, so the two cuts meet on one curve
 *     (the step between two independent remeshes, a few centimetres, is closed; the cut edges of the earlier chunk stay).
 *  4. Feathered fields (solveSeamGains): a gain per chunk levels each pair only on average, and the step along a line
 *     varies (each chunk harmonised its photos to its own reference), so what is left along each shared line, in 10 m bins,
 *     is split between the two chunks as a correction that fades out `featherM` inside each: they meet on one colour at
 *     the line and keep their own inside.
 *  5. Applied (applySeamGain): a chunk's gain and field multiply each vertex's colour: lossless in the materials' base
 *     colour factors (a gain alone) or vertex colours (COLOR_0, with a field) where nothing brightens, else each channel's
 *     brightest multiplier in the base colour photos' texels and the rest in the vertex colours.
 * Measured geometry is moved by at most `snapM` at a cut; the gains and fields are generated (fitted levels, labelled in
 * the GLB).
 */

import * as jpegJs from 'jpeg-js';
import { encodePng } from '../../../texture-processing';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { assembleGlb, parseGlbBytes, readAccessor, replaceGlbImages, type ParsedGlb } from '../glb-bytes';
import { appendPieces, readPrims, split, vertexOf, type PrimRead, type Vx } from './lattice-stitch';
import { chunkOwner, DISTRICT_CHUNKS_PARAMS, type DistrictChunkPlan } from './district-chunks';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export const DISTRICT_SEAMS_VERSION = 'district-seams/2';

export const DISTRICT_SEAMS_PARAMS = {
    /** How far a later chunk's cut vertex may move onto an earlier chunk's cut edge (m): the step two remeshes leave. */
    snapM: 0.25,
    /** The grid where each chunk's ground is recorded as present or not (m): ground its owner lacks goes to one that has it. */
    coverageM: 0.5,
    /** The colour grid's spacing (m), shared by every chunk. */
    sampleM: 0.5,
    /** How far either side of a cell line colour is sampled (m): the band each chunk keeps past its edge. */
    bandM: DISTRICT_CHUNKS_PARAMS.seamBandM,
    /** Two chunks' samples at one grid point are of one surface when their heights are this close (m). */
    sameSurfaceM: 0.3,
    /** A pair of chunks sets a gain only with this many shared samples (50 m² at 0.5 m). */
    minSamples: 200,
    /** Samples darker than this (linear) carry no ratio. */
    minLinear: 0.01,
    /** The bins along a shared line its feathered correction is read in (m). */
    fieldBinM: 10,
    /** A bin sets its correction only with this many shared samples. */
    fieldMinSamples: 20,
    /** How far inside a chunk its correction toward a neighbour fades out (m). */
    featherM: 30,
    /** The largest gain either way. */
    maxGain: 1.5,
    /**
     * The most a gain or correction may change one channel against the others (log; 0.03: 3%). The chunks' photos differ
     * mostly in brightness; a gain per channel also moved their hue (up to 20% between chunks at Shibuya), which read as a
     * tint over whole chunks. Brightness is levelled in full, hue only this far.
     */
    maxHueShift: 0.03,
    /** Least-squares sweeps. */
    iterations: 400,
    /** A gain this close to 1 is left out. */
    gainEpsilon: 0.003,
    /** Re-encoded base colour photos (when a chunk is brightened). */
    jpegQuality: 92
};
export type DistrictSeamsParams = typeof DISTRICT_SEAMS_PARAMS;

/** The cell lines of a plan: x = value (along z) and z = value (along x), sorted. */
export function cellLines(plan: DistrictChunkPlan): { xs: number[]; zs: number[] } {
    const xs = new Set<number>(), zs = new Set<number>();
    for (const c of plan.chunks) { xs.add(c.cx - c.half); xs.add(c.cx + c.half); zs.add(c.cz - c.half); zs.add(c.cz + c.half); }
    return { xs: [...xs].sort((a, b) => a - b), zs: [...zs].sort((a, b) => a - b) };
}

const nearest = (sorted: number[], v: number) => {
    let lo = 0, hi = sorted.length - 1;
    while (hi - lo > 1) { const k = (lo + hi) >> 1; if (sorted[k] <= v) lo = k; else hi = k; }
    return Math.abs(sorted[lo] - v) <= Math.abs(sorted[hi] - v) ? sorted[lo] : sorted[hi];
};
/** Whether a line lies strictly between a and b. */
const between = (sorted: number[], a: number, b: number) => sorted.filter(v => v > a && v < b);

// ============================================================================
// Cut and snap
// ============================================================================

/**
 * The cut edges a chunk left on each cell line, in that line's own plane: s along the line (z for an x line, x for a z
 * line) and height, as segments [s0, y0, s1, y1, ...]. Keyed `x<value>` / `z<value>`.
 */
export type SeamEdges = Map<string, number[]>;

export interface SeamCutReport {
    trianglesIn: number;
    /** Triangles dropped whole (owned by another chunk). */
    dropped: number;
    /** Triangles cut at a cell line. */
    cut: number;
    /** Pieces of cut triangles kept. */
    keptPieces: number;
    /** Cut vertices moved onto an earlier chunk's edge, and those with none within snapM. */
    snapped: number;
    unsnapped: number;
    /** Largest move (m). */
    maxSnapM: number;
    /** Primitives without indices, kept as they were. */
    skippedPrimitives: number;
}

interface SnapIndex { segs: number[]; buckets: Map<number, number[]> }

function snapIndex(edges: SeamEdges): Map<string, SnapIndex> {
    const out = new Map<string, SnapIndex>();
    for (const [k, segs] of edges) {
        const buckets = new Map<number, number[]>();
        for (let i = 0; i < segs.length; i += 4) {
            for (let b = Math.floor(Math.min(segs[i], segs[i + 2])); b <= Math.floor(Math.max(segs[i], segs[i + 2])); b++) {
                const l = buckets.get(b);
                if (l) l.push(i); else buckets.set(b, [i]);
            }
        }
        out.set(k, { segs, buckets });
    }
    return out;
}

/** The nearest point of the line's edges to (s, y) within r, or undefined. */
function nearestOnEdges(ix: SnapIndex, s: number, y: number, r: number): [number, number, number] | undefined {
    let best: [number, number, number] | undefined;
    const seen = new Set<number>();
    for (let b = Math.floor(s - r); b <= Math.floor(s + r); b++) for (const i of ix.buckets.get(b) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s0 = ix.segs[i], y0 = ix.segs[i + 1], ds = ix.segs[i + 2] - s0, dy = ix.segs[i + 3] - y0, l2 = ds * ds + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((s - s0) * ds + (y - y0) * dy) / l2)) : 0;
        const ps = s0 + ds * t, py = y0 + dy * t, d = Math.hypot(ps - s, py - y);
        if (d <= r && (!best || d < best[2])) best = [ps, py, d];
    }
    return best;
}

/**
 * Chunk `index`'s ground (district frame, as joined) cut to what it owns: cut exactly at the cell lines a triangle with
 * corners of different owners crosses, each piece kept by its middle's owner or an owned corner of its own, every attribute
 * carried. With `snapTo` (the
 * edges earlier chunks left), its vertices on a cell line are moved onto them. Returns the cut GLB and the edges this cut
 * left on the cell lines (after snapping), for later chunks. Cut the clay and the textured twin with the same `snapTo`:
 * the two share positions, so they are cut and snapped alike. `owner` (default chunkOwner) must be the same for every
 * chunk of the district: seamOwner, from every chunk's coverage, so ground no chunk's build reached is never handed to it.
 */
export function cutChunkGround(bytes: Uint8Array, plan: DistrictChunkPlan, index: number, opts: { snapTo?: SeamEdges; owner?: (x: number, z: number) => number } = {}, P: DistrictSeamsParams = DISTRICT_SEAMS_PARAMS): { glb: Buffer; edges: SeamEdges; report: SeamCutReport } {
    const { snapTo } = opts;
    // a copy: the dropped triangles are collapsed in the index bytes, which must not be the caller's
    const glb = parseGlbBytes(Uint8Array.from(bytes));
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const owner = opts.owner ?? chunkOwner(plan), { xs, zs } = cellLines(plan);
    const touchesLine = (x: number, z: number) => Math.abs(nearest(xs, x) - x) < 1e-6 || Math.abs(nearest(zs, z) - z) < 1e-6;
    const snap = snapTo ? snapIndex(snapTo) : undefined;
    const report: SeamCutReport = { trianglesIn: 0, dropped: 0, cut: 0, keptPieces: 0, snapped: 0, unsnapped: 0, maxSnapM: 0, skippedPrimitives: 0 };
    for (const m of glb.json.meshes ?? []) for (const p of m.primitives ?? []) if ((p.mode ?? 4) === 4 && p.attributes?.POSITION !== undefined && p.indices === undefined) report.skippedPrimitives++;
    const appended: Array<{ pr: PrimRead; polys: Vx[][] }> = [];
    const kill = (pr: PrimRead, t: number) => {
        for (const e of [t + 1, t + 2]) { const o = pr.idxBase + e * pr.idxStride; if (pr.idxSize === 4) dv.setUint32(o, pr.I[t], true); else if (pr.idxSize === 2) dv.setUint16(o, pr.I[t], true); else dv.setUint8(o, pr.I[t]); }
    };
    for (const pr of readPrims(glb)) {
        const X = pr.data[0], vOwner = new Int32Array(X.length / 3).fill(-2);
        const ownerOf = (i: number) => { let o = vOwner[i]; if (o === -2) { o = owner(X[i * 3], X[i * 3 + 2]); vOwner[i] = o; } return o; };
        const kept: Vx[][] = [];
        const cache = new Map<string, Vx>();
        for (let t = 0; t + 2 < pr.I.length; t += 3) {
            const a = pr.I[t], b = pr.I[t + 1], c = pr.I[t + 2];
            if (a === b || b === c || a === c) continue;
            report.trianglesIn++;
            const oa = ownerOf(a), ob = ownerOf(b), oc = ownerOf(c);
            const mx = (X[a * 3] + X[b * 3] + X[c * 3]) / 3, mz = (X[a * 3 + 2] + X[b * 3 + 2] + X[c * 3 + 2]) / 3;
            const om = oa === ob && ob === oc ? oa : owner(mx, mz);
            const x0 = Math.min(X[a * 3], X[b * 3], X[c * 3]), x1 = Math.max(X[a * 3], X[b * 3], X[c * 3]);
            const z0 = Math.min(X[a * 3 + 2], X[b * 3 + 2], X[c * 3 + 2]), z1 = Math.max(X[a * 3 + 2], X[b * 3 + 2], X[c * 3 + 2]);
            // one owner at every corner and the middle: nothing to cut
            const uniform = oa === ob && ob === oc && oa === om;
            const lx = uniform ? [] : between(xs, x0, x1), lz = uniform ? [] : between(zs, z0, z1);
            // where ownership changes at no cell line (a building's outline, where a chunk's own build may have taken the
            // street out from under its building; the edge of what a chunk's build reached), a triangle across it is kept by
            // every chunk owning one of its corners or its middle: a sliver of overlap beside a wall, never a hole
            const offLine = (i: number) => !touchesLine(X[i * 3], X[i * 3 + 2]);
            const ownsAny = (oa === index && offLine(a)) || (ob === index && offLine(b)) || (oc === index && offLine(c)) || om === index;
            // a corner already on a cell line: the triangle goes through the cut too, so that corner is snapped and its edge
            // on the line recorded like any cut one
            const onLine = !offLine(a) || !offLine(b) || !offLine(c);
            if (!lx.length && !lz.length && !(onLine && ownsAny)) {
                if (!ownsAny) { kill(pr, t); report.dropped++; }
                continue;
            }
            // cut exactly at every cell line it crosses; each piece kept when this chunk owns its middle or one of the
            // triangle's own corners in it (a piece lies in one cell, so this never keeps anything across a cell line)
            const va = vertexOf(pr, a), vb = vertexOf(pr, b), vc = vertexOf(pr, c);
            const corner = new Map<Vx, boolean>([[va, oa === index && offLine(a)], [vb, ob === index && offLine(b)], [vc, oc === index && offLine(c)]]);
            let polys: Vx[][] = [[va, vb, vc]];
            for (const x of lx) polys = polys.flatMap(poly => split(poly, v => v.p[0] - x, `x${x}`, pr, cache)).filter(q => q.length >= 3);
            for (const z of lz) polys = polys.flatMap(poly => split(poly, v => v.p[2] - z, `z${z}`, pr, cache)).filter(q => q.length >= 3);
            const mine = polys.filter(poly => poly.some(v => corner.get(v)) || owner(poly.reduce((s, v) => s + v.p[0], 0) / poly.length, poly.reduce((s, v) => s + v.p[2], 0) / poly.length) === index);
            if (mine.length === polys.length && polys.length === 1 && !onLine) continue;
            kill(pr, t);
            if (!mine.length) { report.dropped++; continue; }
            report.cut++;
            report.keptPieces += mine.length;
            kept.push(...mine);
        }
        if (kept.length) appended.push({ pr, polys: kept });
    }
    // the cut vertices on a cell line: snapped onto the earlier chunks' edges, then this chunk's own edges recorded
    const onLine = (v: Vx): [string, number, 0 | 2] | undefined => {
        const x = nearest(xs, v.p[0]);
        if (Math.abs(v.p[0] - x) < 1e-6) return [`x${x}`, x, 0];
        const z = nearest(zs, v.p[2]);
        if (Math.abs(v.p[2] - z) < 1e-6) return [`z${z}`, z, 2];
        return undefined;
    };
    const done = new Set<Vx>(), lineOf = new Map<Vx, string>();
    for (const { polys } of appended) for (const poly of polys) for (const v of poly) {
        if (done.has(v)) continue;
        done.add(v);
        const l = onLine(v);
        if (!l) continue;
        const [key, value, axis] = l, along = axis === 0 ? 2 : 0;
        v.p[axis] = value;
        lineOf.set(v, key);
        const ix = snap?.get(key);
        if (!ix) continue;
        const hit = nearestOnEdges(ix, v.p[along], v.p[1], P.snapM);
        if (!hit) { report.unsnapped++; continue; }
        v.p[along] = hit[0]; v.p[1] = hit[1];
        report.snapped++;
        report.maxSnapM = Math.max(report.maxSnapM, hit[2]);
    }
    const edges: SeamEdges = new Map();
    for (const { polys } of appended) for (const poly of polys) for (let k = 0; k < poly.length; k++) {
        const u = poly[k], w = poly[(k + 1) % poly.length], key = lineOf.get(u);
        if (!key || lineOf.get(w) !== key) continue;
        const along = key[0] === 'x' ? 2 : 0;
        let segs = edges.get(key);
        if (!segs) edges.set(key, segs = []);
        segs.push(u.p[along], u.p[1], w.p[along], w.p[1]);
    }
    report.maxSnapM = Math.round(report.maxSnapM * 1000) / 1000;
    const out = appendPieces(glb, appended, { sbDistrictSeam: { version: DISTRICT_SEAMS_VERSION, chunk: index, provenance: `as-scanned: the chunk's ground cut at its cell lines, its cut edge moved at most ${P.snapM} m onto its neighbour's` } });
    return { glb: out, edges, report };
}

/** Where a chunk's ground has any surface, from above: a grid of `coverageM` cells over its plan box. */
export interface SeamCoverage { x0: number; z0: number; nx: number; nz: number; cellM: number; bits: Uint8Array }

/**
 * Where a chunk's ground (as joined) surely has surface: every grid cell whose middle lies under one of its triangles, or
 * that holds one of its corners, and whose eight neighbours do too. Read once per chunk, before any is cut.
 */
export function seamCoverage(bytes: Uint8Array, P: DistrictSeamsParams = DISTRICT_SEAMS_PARAMS): SeamCoverage {
    const g = parseGlbBytes(bytes), C = P.coverageM;
    const prims: Array<{ X: Float64Array; I?: Float64Array }> = [];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const m of g.json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
        const X = readAccessor(g, p.attributes.POSITION).data;
        prims.push({ X, ...(p.indices !== undefined ? { I: readAccessor(g, p.indices).data } : {}) });
        for (let i = 0; i < X.length; i += 3) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); z0 = Math.min(z0, X[i + 2]); z1 = Math.max(z1, X[i + 2]); }
    }
    if (!(x1 >= x0)) return { x0: 0, z0: 0, nx: 0, nz: 0, cellM: C, bits: new Uint8Array(0) };
    x0 = Math.floor(x0 / C) * C; z0 = Math.floor(z0 / C) * C;
    const nx = Math.ceil((x1 - x0) / C) + 1, nz = Math.ceil((z1 - z0) / C) + 1, bits = new Uint8Array(nx * nz);
    const mark = (i: number, j: number) => { if (i >= 0 && j >= 0 && i < nx && j < nz) bits[j * nx + i] = 1; };
    for (const { X, I } of prims) {
        const n = I ? I.length : X.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            const v = [I ? I[t] : t, I ? I[t + 1] : t + 1, I ? I[t + 2] : t + 2];
            const ax = X[v[0] * 3], az = X[v[0] * 3 + 2], bx = X[v[1] * 3], bz = X[v[1] * 3 + 2], cx = X[v[2] * 3], cz = X[v[2] * 3 + 2];
            for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]]) mark(Math.floor((x - x0) / C), Math.floor((z - z0) / C));
            const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
            if (Math.abs(det) < 1e-9) continue;
            const i0 = Math.ceil((Math.min(ax, bx, cx) - x0) / C - 0.5), i1 = Math.floor((Math.max(ax, bx, cx) - x0) / C - 0.5);
            const j0 = Math.ceil((Math.min(az, bz, cz) - z0) / C - 0.5), j1 = Math.floor((Math.max(az, bz, cz) - z0) / C - 0.5);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const px = x0 + (i + 0.5) * C, pz = z0 + (j + 0.5) * C;
                const l1 = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / det, l2 = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / det;
                if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) mark(i, j);
            }
        }
    }
    // only cells whose eight neighbours are covered too: a cell the ground only partly covers (at its edge) is not counted, so
    // there the next chunk keeps its ground as well (a sliver of overlap, never a hole)
    const inner = new Uint8Array(nx * nz);
    for (let j = 1; j + 1 < nz; j++) for (let i = 1; i + 1 < nx; i++) {
        let all = 1;
        for (let dj = -1; dj <= 1 && all; dj++) for (let di = -1; di <= 1; di++) if (!bits[(j + dj) * nx + i + di]) { all = 0; break; }
        inner[j * nx + i] = all;
    }
    return { x0, z0, nx, nz, cellM: C, bits: inner };
}

const covers = (c: SeamCoverage | undefined, x: number, z: number) => {
    if (!c) return false;
    const i = Math.floor((x - c.x0) / c.cellM), j = Math.floor((z - c.z0) / c.cellM);
    return i >= 0 && j >= 0 && i < c.nx && j < c.nz && c.bits[j * c.nx + i] === 1;
};

/**
 * Who keeps the ground at a plan point, the same for every chunk: its owner (chunkOwner) when the owner's ground reaches
 * it; else the chunk whose cell it lies in, when that one's does (a building that reaches far out of its own cell, past
 * where its chunk's extraction reached); else the first chunk in `order` whose ground does; else the owner (nobody has it).
 */
export function seamOwner(plan: DistrictChunkPlan, coverage: Map<number, SeamCoverage>, order: number[]): (x: number, z: number) => number {
    const owner = chunkOwner(plan), half = plan.cellM / 2;
    const cellOf = (x: number, z: number) => plan.chunks.findIndex(c => Math.abs(x - c.cx) <= half && Math.abs(z - c.cz) <= half);
    return (x, z) => {
        const o = owner(x, z);
        if (o < 0 || covers(coverage.get(o), x, z)) return o;
        const c = cellOf(x, z);
        if (c >= 0 && c !== o && covers(coverage.get(c), x, z)) return c;
        for (const k of order) if (covers(coverage.get(k), x, z)) return k;
        return o;
    };
}

/** Adds one chunk's cut edges to the edges later chunks snap to. */
export function addSeamEdges(into: SeamEdges, from: SeamEdges): void {
    for (const [k, segs] of from) { const l = into.get(k); if (l) for (const s of segs) l.push(s); else into.set(k, [...segs]); }
}

// ============================================================================
// Colour
// ============================================================================

/** One chunk's colour samples: grid key -> [height, r, g, b] (linear). */
export type SeamSamples = Map<number, Float32Array>;

const OFF = 2 ** 20;
const gridKey = (i: number, j: number) => (i + OFF) * 2 ** 21 + (j + OFF);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** The image a material's base colour photo is, and its texture coordinate set and factor. */
function baseColourOf(json: any, material: number | undefined): { image: number; texCoord: number; factor: number[] } | undefined {
    const m = material !== undefined ? json.materials?.[material] : undefined;
    const bt = m?.pbrMetallicRoughness?.baseColorTexture;
    if (!bt) return undefined;
    const image = json.textures?.[bt.index]?.source;
    if (image === undefined) return undefined;
    return { image, texCoord: bt.texCoord ?? 0, factor: m.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1] };
}

function imageBytes(glb: ParsedGlb, image: number): Uint8Array {
    const v = glb.json.bufferViews[glb.json.images[image].bufferView];
    return glb.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
}

/**
 * A chunk's textured ground sampled from above in the bands either side of every cell line (the shared grid, the highest
 * surface at each point): what its photos show there, in linear RGB, with the height they show it at.
 */
export function sampleSeamColour(bytes: Uint8Array, plan: DistrictChunkPlan, P: DistrictSeamsParams = DISTRICT_SEAMS_PARAMS): SeamSamples {
    const glb = parseGlbBytes(bytes), json = glb.json;
    const { xs, zs } = cellLines(plan);
    const near = (v: number, sorted: number[]) => Math.abs(nearest(sorted, v) - v) < P.bandM;
    const best = new Map<number, { y: number; prim: number; u: number; v: number; col?: [number, number, number] }>();
    const prims: Array<{ material?: number; uv?: Float64Array }> = [];
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
        const bc = baseColourOf(json, p.material);
        const uvAcc = bc ? p.attributes[`TEXCOORD_${bc.texCoord}`] : undefined;
        if (uvAcc === undefined) continue;
        const X = readAccessor(glb, p.attributes.POSITION).data, UV = readAccessor(glb, uvAcc).data;
        const I = p.indices !== undefined ? readAccessor(glb, p.indices).data : undefined;
        const pid = prims.length;
        prims.push({ material: p.material, uv: UV });
        // vertex colours multiply the photo (glTF): read with it, so a levelled ground is sampled as it is drawn
        const C = p.attributes.COLOR_0 !== undefined ? readAccessor(glb, p.attributes.COLOR_0) : undefined;
        const n = I ? I.length : X.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            const a = I ? I[t] : t, b = I ? I[t + 1] : t + 1, c = I ? I[t + 2] : t + 2;
            const ax = X[a * 3], az = X[a * 3 + 2], bx = X[b * 3], bz = X[b * 3 + 2], cx = X[c * 3], cz = X[c * 3 + 2];
            const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
            // only triangles reaching a band
            if (!(between(xs, x0 - P.bandM, x1 + P.bandM).length || between(zs, z0 - P.bandM, z1 + P.bandM).length)) continue;
            const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
            if (Math.abs(det) < 1e-8) continue; // a wall seen edge-on from above
            for (let i = Math.ceil(x0 / P.sampleM); i * P.sampleM <= x1; i++) for (let j = Math.ceil(z0 / P.sampleM); j * P.sampleM <= z1; j++) {
                const px = i * P.sampleM, pz = j * P.sampleM;
                if (!near(px, xs) && !near(pz, zs)) continue;
                const l1 = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / det, l2 = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / det, l3 = 1 - l1 - l2;
                if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
                const y = l1 * X[a * 3 + 1] + l2 * X[b * 3 + 1] + l3 * X[c * 3 + 1];
                const k = gridKey(i, j), cur = best.get(k);
                if (cur && cur.y >= y) continue;
                const col = C ? ([0, 1, 2].map(q => l1 * C.data[a * C.comps + q] + l2 * C.data[b * C.comps + q] + l3 * C.data[c * C.comps + q]) as [number, number, number]) : undefined;
                best.set(k, { y, prim: pid, u: l1 * UV[a * 2] + l2 * UV[b * 2] + l3 * UV[c * 2], v: l1 * UV[a * 2 + 1] + l2 * UV[b * 2 + 1] + l3 * UV[c * 2 + 1], ...(col ? { col } : {}) });
            }
        }
    }
    const images = new Map<number, RgbaImage8 | undefined>();
    const out: SeamSamples = new Map();
    for (const [k, s] of best) {
        const bc = baseColourOf(json, prims[s.prim].material)!;
        let img = images.get(bc.image);
        if (!images.has(bc.image)) { try { img = decodeImageInMemory(imageBytes(glb, bc.image)); } catch { img = undefined; } images.set(bc.image, img); }
        if (!img) continue;
        // bilinear, wrapped (glTF's default sampler)
        const fx = (s.u - Math.floor(s.u)) * img.width - 0.5, fy = (s.v - Math.floor(s.v)) * img.height - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const rgb = [0, 0, 0];
        for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]] as const) {
            const xx = ((x0 + dx) % img.width + img.width) % img.width, yy = ((y0 + dy) % img.height + img.height) % img.height, o = (yy * img.width + xx) * 4;
            for (let q = 0; q < 3; q++) rgb[q] += w * srgbToLinear(img.rgba[o + q] / 255);
        }
        const col = s.col ?? [1, 1, 1];
        out.set(k, Float32Array.of(s.y, rgb[0] * bc.factor[0] * col[0], rgb[1] * bc.factor[1] * col[1], rgb[2] * bc.factor[2] * col[2]));
    }
    return out;
}

export interface SeamGainsReport {
    /**
     * Each pair of chunks that met on enough surface: shared samples, and the colour step between them (the median over the
     * line's 10 m bins of each bin's median luminance step, %) as joined, after the chunks' gains, and after the gains and the
     * feathered corrections.
     */
    pairs: Array<{ a: number; b: number; samples: number; stepBeforePct: number; stepAfterPct: number; stepAfterFieldPct?: number }>;
    /** Pairs with too few shared samples to set a gain. */
    thinPairs: number;
}

/**
 * A chunk's feathered colour correction (log, per channel): along each line it shares with a neighbour, half the step left
 * there after the gains, by `fieldBinM` bins, fading to nothing `featherM` inside the chunk.
 */
export interface SeamField { lines: Array<{ /** The plan coordinate along the line (0: x, 2: z). */ along: 0 | 2; /** The line's other coordinate. */ at: number; s0: number; step: number; corr: number[][] }> }

/** The field's correction at a plan point (log, per channel); [0, 0, 0] with none. */
export function seamFieldAt(field: SeamField | undefined, x: number, z: number, P: DistrictSeamsParams = DISTRICT_SEAMS_PARAMS): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    if (!field?.lines.length) return out;
    let wsum = 0, wmax = 0;
    const acc = [0, 0, 0];
    for (const l of field.lines) {
        const s = l.along === 0 ? x : z, d0 = Math.abs((l.along === 0 ? z : x) - l.at);
        const s1 = l.s0 + l.step * l.corr.length, past = s < l.s0 ? l.s0 - s : s > s1 ? s - s1 : 0;
        const d = Math.hypot(d0, past);
        if (d >= P.featherM) continue;
        const t = d / P.featherM, w = 1 - t * t * (3 - 2 * t);
        // the bins' middles, linearly between them, held at the ends
        const f = Math.max(0, Math.min(l.corr.length - 1, (s - l.s0) / l.step - 0.5)), k = Math.floor(f), u = f - k, k1 = Math.min(l.corr.length - 1, k + 1);
        for (let q = 0; q < 3; q++) acc[q] += w * (l.corr[k][q] * (1 - u) + l.corr[k1][q] * u);
        wsum += w; wmax = Math.max(wmax, w);
    }
    if (!(wsum > 0)) return out;
    for (let q = 0; q < 3; q++) out[q] = (acc[q] / wsum) * wmax;
    return out;
}

/**
 * One gain per chunk and channel from every pair's median log ratio (least squares, mean zero over the chunks that met any
 * other), clamped to maxGain either way; a chunk that met none keeps 1. Then, for each line two chunks share, what is left
 * of the step along it (10 m bins) is split between them as each one's feathered field (SeamField): the two meet on one
 * colour at the line, and each chunk's inside keeps its own.
 */
export function solveSeamGains(samples: Map<number, SeamSamples>, plan: DistrictChunkPlan, P: DistrictSeamsParams = DISTRICT_SEAMS_PARAMS): { gains: Map<number, [number, number, number]>; fields: Map<number, SeamField>; report: SeamGainsReport } {
    // every grid point's samples, by chunk
    const at = new Map<number, Array<[number, Float32Array]>>();
    for (const [c, m] of samples) for (const [k, s] of m) { const l = at.get(k); if (l) l.push([c, s]); else at.set(k, [[c, s]]); }
    const ratios = new Map<string, { d: number[][]; x: number[]; z: number[] }>();
    for (const [k, list] of at) {
        if (list.length < 2) continue;
        const x = (Math.floor(k / 2 ** 21) - OFF) * P.sampleM, z = ((k % 2 ** 21) - OFF) * P.sampleM;
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            let [ca, sa] = list[i], [cb, sb] = list[j];
            if (ca > cb) [ca, sa, cb, sb] = [cb, sb, ca, sa];
            if (Math.abs(sa[0] - sb[0]) > P.sameSurfaceM) continue;
            if (Math.min(sa[1], sa[2], sa[3], sb[1], sb[2], sb[3]) < P.minLinear) continue;
            const key = `${ca},${cb}`;
            let r = ratios.get(key);
            // per channel, and (the fourth) the brightness: the luminance ratio itself, not a mean of the channels' logs
            if (!r) ratios.set(key, r = { d: [[], [], [], []], x: [], z: [] });
            for (let q = 0; q < 3; q++) r.d[q].push(Math.log(sb[q + 1] / sa[q + 1]));
            r.d[3].push(Math.log((0.2126 * sb[1] + 0.7152 * sb[2] + 0.0722 * sb[3]) / (0.2126 * sa[1] + 0.7152 * sa[2] + 0.0722 * sa[3])));
            r.x.push(x); r.z.push(z);
        }
    }
    const median = (v: number[]) => { const s = [...v].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    // g_a - g_b = log(c_b / c_a): the gain that brings a's photos to b's level, and b's to a's, halfway each
    const edges: Array<{ a: number; b: number; n: number; d: number[] }> = [];
    let thinPairs = 0;
    for (const [key, r] of ratios) {
        const [a, b] = key.split(',').map(Number);
        if (r.d[0].length < P.minSamples) { thinPairs++; continue; }
        edges.push({ a, b, n: r.d[0].length, d: r.d.map(median) });
    }
    const nodes = [...new Set(edges.flatMap(e => [e.a, e.b]))];
    const g = new Map<number, number[]>(nodes.map(n => [n, [0, 0, 0, 0]]));
    const adj = new Map<number, Array<{ o: number; w: number; d: number[] }>>(nodes.map(n => [n, []]));
    for (const e of edges) {
        const w = Math.sqrt(e.n);
        adj.get(e.a)!.push({ o: e.b, w, d: e.d });
        adj.get(e.b)!.push({ o: e.a, w, d: e.d.map(x => -x) });
    }
    for (let it = 0; it < P.iterations; it++) for (const n of nodes) {
        const acc = [0, 0, 0, 0];
        let wsum = 0;
        for (const { o, w, d } of adj.get(n)!) { const go = g.get(o)!; for (let q = 0; q < 4; q++) acc[q] += w * (go[q] + d[q]); wsum += w; }
        g.set(n, acc.map(x => x / wsum));
    }
    const mean = [0, 1, 2, 3].map(q => nodes.reduce((s, n) => s + g.get(n)![q], 0) / Math.max(1, nodes.length));
    const lim = Math.log(P.maxGain);
    // a log multiplier per channel from [r, g, b, brightness]: the brightness in full (clamped to maxGain), and each
    // channel's difference from the channels' own mean at most maxHueShift on top
    const brightnessFirst = (v: number[]) => {
        const l = Math.max(-lim, Math.min(lim, v[3])), m = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        const h = [0, 1, 2].map(q => Math.max(-P.maxHueShift, Math.min(P.maxHueShift, v[q] - m)));
        // the hue left with no brightness of its own (luminance-weighted mean zero), so the brightness stays l
        const hm = 0.2126 * h[0] + 0.7152 * h[1] + 0.0722 * h[2];
        return h.map(x => l + x - hm);
    };
    const brightness = new Map<number, number>();
    const gains = new Map<number, [number, number, number]>();
    for (const c of samples.keys()) {
        const v = g.get(c);
        gains.set(c, v ? (brightnessFirst(v.map((x, q) => x - mean[q])).map(Math.exp) as [number, number, number]) : [1, 1, 1]);
        brightness.set(c, v ? Math.max(-lim, Math.min(lim, v[3] - mean[3])) : 0);
    }
    // the feathered fields: along each line two side-by-side chunks share, the step left after the gains, by bins
    const fields = new Map<number, SeamField>();
    const fieldOf = (c: number) => { let f = fields.get(c); if (!f) fields.set(c, f = { lines: [] }); return f; };
    const lineSteps = new Map<string, { bins: Array<{ s: number; r: number[] }>; along: 0 | 2; s0: number }>();
    for (const e of edges) {
        const A = plan.chunks[e.a], B = plan.chunks[e.b];
        if (!A || !B || Math.abs(A.cx - B.cx) + Math.abs(A.cz - B.cz) !== plan.cellM) continue;
        // side by side across x (the line runs along z) or across z (along x)
        const along: 0 | 2 = A.cx === B.cx ? 0 : 2, lineAt = along === 0 ? (A.cz + B.cz) / 2 : (A.cx + B.cx) / 2, s0 = (along === 0 ? A.cx : A.cz) - A.half;
        const nb = Math.round(plan.cellM / P.fieldBinM), r = ratios.get(`${e.a},${e.b}`)!;
        const ga = [...gains.get(e.a)!.map(Math.log), brightness.get(e.a)!], gb = [...gains.get(e.b)!.map(Math.log), brightness.get(e.b)!];
        const byBin: number[][][] = Array.from({ length: nb }, () => [[], [], [], []]);
        r.x.forEach((x, i) => {
            const k = Math.floor(((along === 0 ? x : r.z[i]) - s0) / P.fieldBinM);
            if (k >= 0 && k < nb) for (let q = 0; q < 4; q++) byBin[k][q].push(r.d[q][i] + gb[q] - ga[q]);
        });
        // a bin with too few samples takes its neighbours' (held at the ends)
        let corr: Array<number[] | undefined> = byBin.map(b => (b[0].length >= P.fieldMinSamples ? b.map(median) : undefined));
        const known = corr.map((c, k) => (c ? k : -1)).filter(k => k >= 0);
        if (!known.length) continue;
        corr = corr.map((c, k) => {
            if (c) return c;
            const lo = [...known].reverse().find(j => j < k), hi = known.find(j => j > k);
            if (lo === undefined) return corr[hi!]; if (hi === undefined) return corr[lo];
            const u = (k - lo) / (hi - lo);
            return corr[lo]!.map((v, q) => v * (1 - u) + corr[hi]![q] * u);
        });
        // (each bin's median is already robust; read between the bins' middles linearly)
        const smooth = corr.map(c => brightnessFirst(c!));
        // half of it each: a toward b (up by half the step), b toward a
        fieldOf(e.a).lines.push({ along, at: lineAt, s0, step: P.fieldBinM, corr: smooth.map(c => c.map(v => v / 2)) });
        fieldOf(e.b).lines.push({ along, at: lineAt, s0, step: P.fieldBinM, corr: smooth.map(c => c.map(v => -v / 2)) });
        lineSteps.set(`${e.a},${e.b}`, { bins: byBin.map((b, k) => ({ s: s0 + (k + 0.5) * P.fieldBinM, r: b[0].length >= P.fieldMinSamples ? b.map(median) : [] })), along, s0 });
    }
    const lum = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const pct = (x: number) => Math.round((Math.exp(Math.abs(x)) - 1) * 1000) / 10;
    // the brightness step (the luminance ratio, the fourth component) as joined, after the gains, and after the fields too
    const pairs = edges.map(e => {
        const la = brightness.get(e.a)!, lb = brightness.get(e.b)!;
        const line = lineSteps.get(`${e.a},${e.b}`);
        const bins = line?.bins.filter(b => b.r.length) ?? [];
        if (!line || !bins.length) return { a: e.a, b: e.b, samples: e.n, stepBeforePct: pct(e.d[3]), stepAfterPct: pct(e.d[3] + lb - la) };
        // per bin: r[3] is the step left after the gains; the fields read on the line, at the bin's middle
        const lineAt = line.along === 0 ? (plan.chunks[e.a].cz + plan.chunks[e.b].cz) / 2 : (plan.chunks[e.a].cx + plan.chunks[e.b].cx) / 2;
        const before = bins.map(b => Math.abs(b.r[3] - lb + la));
        const after = bins.map(b => Math.abs(b.r[3]));
        const field = bins.map(b => {
            const [x, z] = line.along === 0 ? [b.s, lineAt] : [lineAt, b.s];
            return Math.abs(b.r[3] + lum(seamFieldAt(fields.get(e.b), x, z, P)) - lum(seamFieldAt(fields.get(e.a), x, z, P)));
        });
        return { a: e.a, b: e.b, samples: e.n, stepBeforePct: pct(median(before)), stepAfterPct: pct(median(after)), stepAfterFieldPct: pct(median(field)) };
    });
    return { gains, fields, report: { pairs, thinPairs } };
}

/**
 * A chunk's textured ground with its gain and feathered field. Each vertex's colour multiplier (the gain times the field
 * there) goes, when no vertex brightens, into the materials' base colour factors (no field) or vertex colours (COLOR_0, with
 * a field), lossless; where some do, the brightest multiplier of each channel goes into the texels of the base colour
 * photos (re-encoded as they were stored) and the rest into the vertex colours. Labelled in the GLB's extras.
 */
export function applySeamGain(bytes: Uint8Array, gain: [number, number, number], field?: SeamField, P: DistrictSeamsParams = DISTRICT_SEAMS_PARAMS): { glb: Buffer; mode: 'none' | 'factor' | 'vertex' | 'texels' | 'texels+vertex'; images: number } {
    const flat = !field?.lines.length;
    if (flat && gain.every(x => Math.abs(x - 1) < P.gainEpsilon)) return { glb: Buffer.from(bytes), mode: 'none', images: 0 };
    const glb = parseGlbBytes(bytes), json = glb.json;
    const label = { version: DISTRICT_SEAMS_VERSION, gain: gain.map(x => Math.round(x * 10000) / 10000), feathered: !flat, provenance: `generated: one colour gain for this chunk${flat ? '' : ', and a correction fading in over its last ' + P.featherM + ' m to each neighbour'}, fitted where it meets its neighbours, so the district reads as one set of photos` };
    json.extras = { ...(json.extras ?? {}), sbDistrictSeamGain: label };
    // each vertex's multiplier, and each channel's largest
    const prims: Array<{ p: any; mult: Float32Array }> = [];
    const top = [0, 0, 0];
    const lg = gain.map(Math.log);
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
        const X = readAccessor(glb, p.attributes.POSITION).data, mult = new Float32Array(X.length);
        for (let i = 0; i < X.length; i += 3) {
            const f = flat ? [0, 0, 0] : seamFieldAt(field, X[i], X[i + 2], P);
            for (let q = 0; q < 3; q++) { mult[i + q] = Math.exp(lg[q] + f[q]); top[q] = Math.max(top[q], mult[i + q]); }
        }
        prims.push({ p, mult });
    }
    const brightens = top.some(x => x > 1 + P.gainEpsilon);
    const scaleFactor = (m: any, f: number[]) => {
        const pbr = m.pbrMetallicRoughness ??= {};
        const b = pbr.baseColorFactor ?? [1, 1, 1, 1];
        pbr.baseColorFactor = [Math.min(1, b[0] * f[0]), Math.min(1, b[1] * f[1]), Math.min(1, b[2] * f[2]), b[3] ?? 1];
    };
    if (flat && !brightens) {
        for (const m of json.materials ?? []) scaleFactor(m, gain);
        return { glb: assembleGlb(json, glb.bin), mode: 'factor', images: 0 };
    }
    // the texels take each channel's brightest multiplier (when above 1), the vertex colours the rest
    const texel = top.map(x => Math.max(1, x));
    const replaced = new Map<number, { bytes: Uint8Array; mime: string }>();
    if (brightens) {
        // the photos only base colour reads
        const baseTex = new Set<number>();
        for (const m of json.materials ?? []) { const i = m.pbrMetallicRoughness?.baseColorTexture?.index; if (i !== undefined) baseTex.add(i); }
        const baseImg = new Set<number>(), otherImg = new Set<number>();
        (json.textures ?? []).forEach((t: any, i: number) => { if (t.source !== undefined) (baseTex.has(i) ? baseImg : otherImg).add(t.source); });
        const lut = texel.map(gq => Uint8Array.from({ length: 256 }, (_, c) => Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(srgbToLinear(c / 255) * gq))))));
        for (const im of baseImg) {
            if (otherImg.has(im) || json.images[im]?.bufferView === undefined) continue;
            let d: RgbaImage8;
            try { d = decodeImageInMemory(imageBytes(glb, im)); } catch { continue; }
            const px = new Uint8Array(d.rgba);
            for (let o = 0; o < px.length; o += 4) { px[o] = lut[0][px[o]]; px[o + 1] = lut[1][px[o + 1]]; px[o + 2] = lut[2][px[o + 2]]; }
            const png = json.images[im].mimeType === 'image/png';
            replaced.set(im, png ? { bytes: encodePng(d.width, d.height, Buffer.from(px.buffer, px.byteOffset, px.byteLength)), mime: 'image/png' }
                : { bytes: new Uint8Array(jpegJs.encode({ data: Buffer.from(px.buffer, px.byteOffset, px.byteLength), width: d.width, height: d.height }, P.jpegQuality).data), mime: 'image/jpeg' });
        }
    }
    if (flat) {
        // one gain, all of it in the texels: a material whose photo could not be rewritten takes it in its factor (clamped)
        for (const m of json.materials ?? []) {
            const t = m.pbrMetallicRoughness?.baseColorTexture?.index, im = t !== undefined ? json.textures?.[t]?.source : undefined;
            if (im === undefined || !replaced.has(im)) scaleFactor(m, gain);
        }
        return { glb: replaceGlbImages(glb, replaced), mode: 'texels', images: replaced.size };
    }
    // the rest in each vertex's colour (times any it had); a surface whose photo was not rewritten keeps the whole multiplier, clamped at 1
    const extra: Uint8Array[] = [];
    let len = glb.bin.byteLength;
    for (const { p, mult } of prims) {
        const t = json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorTexture?.index, im = t !== undefined ? json.textures?.[t]?.source : undefined;
        const div = im !== undefined && replaced.has(im) ? texel : [1, 1, 1];
        const old = p.attributes.COLOR_0 !== undefined ? readAccessor(glb, p.attributes.COLOR_0) : undefined;
        const n = mult.length / 3, col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) col[i * 3 + q] = Math.min(1, (mult[i * 3 + q] / div[q]) * (old ? old.data[i * old.comps + q] : 1));
        const pad = (4 - (len % 4)) % 4;
        if (pad) { extra.push(new Uint8Array(pad)); len += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: col.byteLength, target: 34962 });
        json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: n, type: 'VEC3' });
        p.attributes.COLOR_0 = json.accessors.length - 1;
        const bytesOf = new Uint8Array(col.buffer);
        extra.push(bytesOf); len += bytesOf.byteLength;
    }
    const bin = new Uint8Array(len);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength;
    for (const e of extra) { bin.set(e, o); o += e.byteLength; }
    return { glb: replaceGlbImages({ json, bin }, replaced), mode: brightens ? 'texels+vertex' : 'vertex', images: replaced.size };
}
