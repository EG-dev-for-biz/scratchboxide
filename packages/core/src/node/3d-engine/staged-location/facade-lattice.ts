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
 *    scan's facade triangles; textured with the facade's own orthophoto (planar UVs in the plane's frame).
 * Lines are photo-inferred; depths are measured (averaged); the rebuilt faces are labelled so in the GLB extras.
 */

import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';
import { decodePng } from '../../texture-processing';
import * as fs from 'fs';
import * as path from 'path';

export const FACADE_LATTICE_VERSION = 'facade-lattice/1';

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
    minMeasuredShare: 0.5
};

export interface ReliefFacade {
    facadeId: number; image: string; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[];
    sMin: number; sMax: number; tMin: number; tMax: number; pixel: number; width: number; height: number; orthoSMin: number; orthoTMax: number; coverage: number;
}

export interface FacadeLatticeResult {
    facadeId: number; s: number[]; t: number[]; cells: number; measuredShare: number;
    depth: number[][]; positions: Float32Array; normals: Float32Array; uv: Float32Array; indices: Uint32Array;
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
export function latticeFacade(f: ReliefFacade, img: { rgba: Uint8Array; width: number; height: number }, samples: Float64Array, P = FACADE_LATTICE_PARAMS): FacadeLatticeResult | undefined {
    const { s, t } = photoLattice(img, f, P);
    const ns = s.length - 1, nt = t.length - 1;
    if (ns < 1 || nt < 1) return undefined;
    const cellOf = (v: number, edges: number[]) => { let lo = 0, hi = edges.length - 1; if (v < edges[0] || v > edges[hi]) return -1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (edges[m] <= v) lo = m; else hi = m; } return lo; };
    const bucket: number[][] = Array.from({ length: ns * nt }, () => []);
    for (let i = 0; i < samples.length; i += 3) { const a = cellOf(samples[i], s), b = cellOf(samples[i + 1], t); if (a >= 0 && b >= 0) bucket[b * ns + a].push(samples[i + 2]); }
    // the photo's mean luminance per cell (openings read darker than wall)
    const lum = new Float64Array(ns * nt).fill(NaN);
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        let sum = 0, n = 0;
        const x0 = Math.max(0, Math.floor((s[a] - f.orthoSMin) / f.pixel)), x1 = Math.min(img.width, Math.ceil((s[a + 1] - f.orthoSMin) / f.pixel));
        const y0 = Math.max(0, Math.floor((f.orthoTMax - t[b + 1]) / f.pixel)), y1 = Math.min(img.height, Math.ceil((f.orthoTMax - t[b]) / f.pixel));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; if (img.rgba[i + 3]) { sum += 0.3 * img.rgba[i] + 0.59 * img.rgba[i + 1] + 0.11 * img.rgba[i + 2]; n++; } }
        if (n) lum[b * ns + a] = sum / n;
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
        const d = depth[b][a];
        // counter-clockwise seen from outside (along +normal): s right, t up
        quad([[s[a], t[b], d], [s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a], t[b + 1], d]], N);
        if (a + 1 < ns) { const e = depth[b][a + 1]; if (Math.abs(e - d) > P.stepM) quad(d > e ? [[s[a + 1], t[b], e], [s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a + 1], t[b + 1], e]] : [[s[a + 1], t[b], d], [s[a + 1], t[b + 1], d], [s[a + 1], t[b + 1], e], [s[a + 1], t[b], e]], d > e ? S : neg(S)); }
        if (b + 1 < nt) { const e = depth[b + 1][a]; if (Math.abs(e - d) > P.stepM) quad(d > e ? [[s[a], t[b + 1], e], [s[a], t[b + 1], d], [s[a + 1], t[b + 1], d], [s[a + 1], t[b + 1], e]].reverse() as Array<[number, number, number]> : [[s[a], t[b + 1], d], [s[a], t[b + 1], e], [s[a + 1], t[b + 1], e], [s[a + 1], t[b + 1], d]].reverse() as Array<[number, number, number]>, d > e ? T : neg(T)); }
    }
    return { facadeId: f.facadeId, s, t, cells: ns * nt, measuredShare: Math.round((measured / (ns * nt)) * 1000) / 1000, depth, positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

// ---------------------------------------------------------------------------------------------------------------
// GLB editing: the facade's scan triangles made degenerate, the rebuilt facade appended
// ---------------------------------------------------------------------------------------------------------------

/** Triangle soup (world) of every triangle primitive of a GLB without node transforms (tile_refine writes none). */
export function glbSoup(glb: ParsedGlb): Float32Array {
    const out: number[] = [];
    for (const m of glb.json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
        const P = readAccessor(glb, p.attributes.POSITION).data, I = p.indices !== undefined ? readAccessor(glb, p.indices).data : Float64Array.from({ length: P.length / 3 }, (_, i) => i);
        for (let t = 0; t + 2 < I.length; t += 3) for (let k = 0; k < 3; k++) out.push(P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]);
    }
    return Float32Array.from(out);
}

/** Is a triangle (world corners) part of facade f's rebuilt region: facing it, within its depth band, inside a measured lattice. */
function inFacade(a: number[], b: number[], c: number[], f: ReliefFacade, r: FacadeLatticeResult, P = FACADE_LATTICE_PARAMS): boolean {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
    const m = [(a[0] + b[0] + c[0]) / 3 - f.centroid[0], (a[1] + b[1] + c[1]) / 3 - f.centroid[1], (a[2] + b[2] + c[2]) / 3 - f.centroid[2]];
    const d = dot(m, f.normal), sv = dot(m, f.axisS), tv = dot(m, f.axisT);
    if (Math.abs(d) > P.depthBandM || sv < r.s[0] || sv > r.s[r.s.length - 1] || tv < r.t[0] || tv > r.t[r.t.length - 1]) return false;
    // a facing triangle, or a sliver (the reveals of the scan's lumps): both are the facade's
    return !(nl > 0) || Math.abs(dot([nx / nl, ny / nl, nz / nl], f.normal)) >= 0.3;
}

function align4(bin: number[]): void { while (bin.length % 4) bin.push(0); }

/**
 * Edits a GLB of the remesh: the facades' scan triangles degenerate, each rebuilt facade appended as a node (`textured`:
 * an unlit material with the facade's orthophoto, as tile_refine's twin is; otherwise the GLB's first material, its clay).
 */
export function applyFacadeLattices(bytes: Uint8Array, facades: Array<{ f: ReliefFacade; r: FacadeLatticeResult; png?: Uint8Array }>, textured: boolean): { glb: Buffer; removed: number } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const bin = Array.from(glb.bin);
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    let removed = 0;
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) continue;
        const Pp = readAccessor(glb, p.attributes.POSITION).data, I = readAccessor(glb, p.indices).data;
        const li = accessorLayout(json, p.indices), size = li.componentType === 5125 ? 4 : li.componentType === 5123 ? 2 : 1;
        for (let t = 0; t + 2 < I.length; t += 3) {
            const v = (k: number) => [Pp[I[t + k] * 3], Pp[I[t + k] * 3 + 1], Pp[I[t + k] * 3 + 2]];
            const a = v(0), b = v(1), c = v(2);
            if (!facades.some(x => inFacade(a, b, c, x.f, x.r))) continue;
            for (const e of [t + 1, t + 2]) { const o = li.base + e * li.stride; if (size === 4) dv.setUint32(o, I[t], true); else if (size === 2) dv.setUint16(o, I[t], true); else dv.setUint8(o, I[t]); }
            removed++;
        }
    }
    // the edited bytes back into the array we append to
    for (let i = 0; i < glb.bin.length; i++) bin[i] = glb.bin[i];
    json.bufferViews ??= []; json.accessors ??= []; json.meshes ??= []; json.nodes ??= []; json.materials ??= [];
    const view = (bytesArr: ArrayLike<number>, target?: number) => { align4(bin); const off = bin.length; for (let i = 0; i < bytesArr.length; i++) bin.push(bytesArr[i]); json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: bytesArr.length, ...(target ? { target } : {}) }); return json.bufferViews.length - 1; };
    const f32 = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const scene = json.scenes?.[json.scene ?? 0];
    for (const { f, r, png } of facades) {
        const acc = (bv: number, count: number, type: string, componentType: number, minmax?: { min: number[]; max: number[] }) => { json.accessors.push({ bufferView: bv, componentType, count, type, ...(minmax ?? {}) }); return json.accessors.length - 1; };
        const min = [0, 1, 2].map(k => Math.min(...Array.from({ length: r.positions.length / 3 }, (_, v) => r.positions[v * 3 + k]))), max = [0, 1, 2].map(k => Math.max(...Array.from({ length: r.positions.length / 3 }, (_, v) => r.positions[v * 3 + k])));
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
        json.nodes.push({ name: `FacadeLattice_${f.facadeId}`, mesh: json.meshes.length - 1, extras: { sbFacadeLattice: { version: FACADE_LATTICE_VERSION, facadeId: f.facadeId, provenance: { lines: 'photo-inferred', depth: 'measured (median per cell, averaged along the row\'s repeats)' }, cells: r.cells, measuredShare: r.measuredShare, sLines: r.s.length, tLines: r.t.length } } });
        scene?.nodes?.push(json.nodes.length - 1);
    }
    align4(bin);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: bin.length }];
    return { glb: assembleGlb(json, Uint8Array.from(bin)), removed };
}

/** Rebuilds a remesh's rectified facades on their photo lattices: the clay and (when given) its textured twin. */
export function rebuildFacadesOnLattice(clayBytes: Uint8Array, texturedBytes: Uint8Array | undefined, orthosDir: string, P: typeof FACADE_LATTICE_PARAMS = FACADE_LATTICE_PARAMS, skip: Set<number> = new Set()): { clay: Buffer; textured?: Buffer; stats: { facades: number; rebuilt: number; cells: number; removedTriangles: number; perFacade: Array<{ id: number; cells: number; measuredShare: number; lines: [number, number] }> } } {
    const facades = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as ReliefFacade[];
    const soup = glbSoup(parseGlbBytes(clayBytes));
    const done: Array<{ f: ReliefFacade; r: FacadeLatticeResult; png: Uint8Array }> = [];
    for (const f of facades.filter(x => x.coverage >= P.minCoverage && !skip.has(x.facadeId))) {
        const file = path.join(orthosDir, f.image);
        if (!fs.existsSync(file)) continue;
        const png = fs.readFileSync(file);
        const img = decodePng(png);
        const r = latticeFacade(f, { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height }, facadeSamples(soup, f, P), P);
        if (r) done.push({ f, r, png });
    }
    const clay = applyFacadeLattices(clayBytes, done, false);
    const tex = texturedBytes ? applyFacadeLattices(texturedBytes, done, true) : undefined;
    return {
        clay: clay.glb, ...(tex ? { textured: tex.glb } : {}),
        stats: { facades: facades.length, rebuilt: done.length, cells: done.reduce((a, d) => a + d.r.cells, 0), removedTriangles: clay.removed, perFacade: done.map(d => ({ id: d.f.facadeId, cells: d.r.cells, measuredShare: d.r.measuredShare, lines: [d.r.s.length, d.r.t.length] as [number, number] })) }
    };
}
