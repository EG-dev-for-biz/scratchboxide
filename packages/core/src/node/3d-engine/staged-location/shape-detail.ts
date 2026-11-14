/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Detail from the scan on a clean shape: the bulk of a structure drawn by a clean shape (a measured twin, a massing, any
 * closed shell in the scan's frame), and the scan's own surface kept wherever it departs from that shape.
 *
 * A scan is right about where things are and wrong about small shape: walls bulge, edges melt. A clean shape is right
 * about the bulk and wrong wherever the structure is more than its model: a crown's buttresses, a podium's steps, plant
 * on a roof. Both are sampled evenly, and each scan point is sorted by its distance to the shape:
 *   - near (under `keepM`): the shape explains it. The scan there is scanning error and is dropped;
 *   - outside (at least `keepM` in front of the shape): real geometry the shape does not have. Kept, measured;
 *   - recess (at least `keepM` behind the shape, and seen from outside): the structure steps in where the shape stands
 *     in air. Kept, and the shape's unsupported surface in front of it is removed;
 *   - buried (air the outside never reaches: seenFromOutside): the tiles' cut faces and interior surfaces. Dropped.
 * A scan triangle follows the class most of its points have. Kept triangles are grown by the small triangles touching
 * them (so a kept patch laps over the shape's edge and no gap opens), and a patch smaller than `minPatchM2` is noise.
 *
 * Nothing is generated: every triangle of the result is the shape's or the scan's own, with its own material and
 * photo. The report says how much of each was kept and how well the shape alone and the result reproduce the scan,
 * by height band. Distances are between even samples (`spacingM`), so they are good to about that spacing.
 */

import { assembleGlb, dropPrimitives, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type ParsedGlb } from './glb-bytes';
import { mergeGlbs } from './glb-subset';

export const SHAPE_DETAIL_VERSION = 'shape-detail/1';

export const SHAPE_DETAIL_PARAMS = {
    /** Even surface samples this far apart (m), at most maxSamples a triangle. */
    spacingM: 0.4, maxSamples: 600,
    /** Scan this far (m) or more from the shape is kept; nearer, the shape explains it. */
    keepM: 0.3,
    /** The relief band's upper edge (m), for the report's sorting (keepM..reliefM: relief; beyond: geometry). */
    reliefM: 0.6,
    /** A shape sample is supported when scan lies within this of it (m). */
    supportM: 0.6,
    /** How far (m) the nearest surface is looked for; a seen scan point with no shape that near is far out (kept). */
    reachM: 3,
    /** The voxel (m) of the seen-from-outside test, enlarged when the structure's box would need more than maxVoxels. */
    seenVoxelM: 0.5, maxVoxels: 40_000_000,
    /** A triangle takes a class when this share of its samples have it. */
    majority: 0.5,
    /** A shape triangle is removed when under this share of it is supported and kept scan lies within nearM of it. */
    unsupportedShare: 0.35, nearM: 1.5,
    /** A shape sample stands proud when the nearest seen scan within reachM lies this far (m) behind it along the scan's
     *  own normal: the shape is in the air in front of the structure (not across a hole in the scan, whose rim lies
     *  beside it). A shape triangle most of whose samples stand proud is removed. */
    proudM: 0.6,
    /** The local fallback: space is cut into cells of regionM; in a cell holding at least regionMinM2 of seen scan where
     *  under regionFit of the shape is supported, or under regionFit of the seen scan lies within keepM of the shape, the
     *  shape does not describe the structure: the seen scan stands there whole and the shape's surface goes. Off (regionFit 0) by default: on the Empire State Building it opened holes in the podium wall. */
    regionM: 4, regionMinM2: 4, regionFit: 0,
    /** A kept patch (triangles joined by shared corners) smaller than this (m2) is noise. */
    minPatchM2: 1,
    /** The ring grown round a kept patch takes only triangles up to this size (m2): a wall-sized scan triangle touching a
     *  patch is not dragged back in. */
    growMaxM2: 4,
    /** Height bands of the report. */
    bands: 6
};
export type ShapeDetailParams = typeof SHAPE_DETAIL_PARAMS;

/** A GLB's triangles in the world frame, in the order `keepTriangles` filters them: nodes in order, each mesh once, mode 4. */
export interface TriangleSet { pos: Float32Array; count: number }

export function readTriangles(bytes: Uint8Array): TriangleSet {
    const glb = parseGlbBytes(bytes), json = glb.json, world = nodeWorldMatrices(json);
    const chunks: Float32Array[] = [];
    let count = 0;
    forEachPrimitive(glb, world, (pos, idx, m) => {
        const n = Math.floor((idx ? idx.length : pos.length / 3) / 3), out = new Float32Array(n * 9);
        for (let t = 0; t < n; t++) for (let c = 0; c < 3; c++) {
            const v = idx ? idx[t * 3 + c] : t * 3 + c, q = transformPoint(m, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
            out[t * 9 + c * 3] = q[0]; out[t * 9 + c * 3 + 1] = q[1]; out[t * 9 + c * 3 + 2] = q[2];
        }
        chunks.push(out); count += n;
    });
    const pos = new Float32Array(count * 9);
    let o = 0; for (const c of chunks) { pos.set(c, o); o += c.length; }
    return { pos, count };
}

function forEachPrimitive(glb: ParsedGlb, world: ReturnType<typeof nodeWorldMatrices>, visit: (pos: Float64Array, idx: Float64Array | undefined, m: (typeof world)[number], prim: any) => void): void {
    const json = glb.json, done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            visit(readAccessor(glb, prim.attributes.POSITION).data, prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined, world[ni], prim);
        }
    });
}

/** The GLB with only the triangles `keep` marks (readTriangles' order); a primitive left with none is dropped. */
export function keepTriangles(bytes: Uint8Array, keep: Uint8Array): { glb: Buffer; kept: number; removed: number } {
    const glb = parseGlbBytes(bytes), json = glb.json, world = nodeWorldMatrices(json);
    const extra: Uint8Array[] = [], emptied = new Set<object>();
    let binLength = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4), t0 = 0, kept = 0, removed = 0;
    forEachPrimitive(glb, world, (pos, idx, _m, prim) => {
        const n = Math.floor((idx ? idx.length : pos.length / 3) / 3), out: number[] = [];
        for (let t = 0; t < n; t++) if (keep[t0 + t]) for (let c = 0; c < 3; c++) out.push(idx ? idx[t * 3 + c] : t * 3 + c);
        t0 += n; kept += out.length / 3; removed += n - out.length / 3;
        if (out.length === n * 3) return;
        if (!out.length) { emptied.add(prim); return; }
        const data = new Uint8Array(new Uint32Array(out).buffer);
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34963 });
        json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: out.length, type: 'SCALAR' });
        prim.indices = json.accessors.length - 1;
        extra.push(data); binLength += data.byteLength;
    });
    if (!removed) return { glb: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), kept, removed };
    dropPrimitives(json, emptied);
    const bin = new Uint8Array(binLength);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    for (const e of extra) { bin.set(e, o); o += e.byteLength; }
    if (json.buffers?.[0]) json.buffers[0].byteLength = binLength;
    return { glb: assembleGlb(json, bin), kept, removed };
}

/** Even samples of a triangle set: points, each one's triangle, and each triangle's area and unit normal. */
export interface SurfaceSamples { p: Float32Array; tri: Int32Array; count: number; area: Float32Array; normal: Float32Array; first: Int32Array }

export function sampleTriangles(t: TriangleSet, spacingM: number, maxSamples: number): SurfaceSamples {
    const area = new Float32Array(t.count), normal = new Float32Array(t.count * 3), first = new Int32Array(t.count + 1);
    let total = 0;
    for (let i = 0; i < t.count; i++) {
        const o = i * 9, ux = t.pos[o + 3] - t.pos[o], uy = t.pos[o + 4] - t.pos[o + 1], uz = t.pos[o + 5] - t.pos[o + 2], vx = t.pos[o + 6] - t.pos[o], vy = t.pos[o + 7] - t.pos[o + 1], vz = t.pos[o + 8] - t.pos[o + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
        area[i] = l / 2;
        if (l > 1e-12) { normal[i * 3] = nx / l; normal[i * 3 + 1] = ny / l; normal[i * 3 + 2] = nz / l; }
        first[i] = total;
        total += Math.max(1, Math.min(maxSamples, Math.round(area[i] / (spacingM * spacingM))));
    }
    first[t.count] = total;
    const p = new Float32Array(total * 3), tri = new Int32Array(total);
    // the R2 low-discrepancy sequence over the triangle (folded onto it): even, and the same every run
    const A1 = 0.7548776662466927, A2 = 0.5698402909980532;
    for (let i = 0; i < t.count; i++) {
        const o = i * 9, n = first[i + 1] - first[i];
        for (let k = 0; k < n; k++) {
            let u = n === 1 ? 1 / 3 : (0.5 + (k + 1) * A1) % 1, v = n === 1 ? 1 / 3 : (0.5 + (k + 1) * A2) % 1;
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const s = first[i] + k, w = 1 - u - v;
            for (let c = 0; c < 3; c++) p[s * 3 + c] = w * t.pos[o + c] + u * t.pos[o + 3 + c] + v * t.pos[o + 6 + c];
            tri[s] = i;
        }
    }
    return { p, tri, count: total, area, normal, first };
}

/** Points in a dense grid of `cell` metres, for nearest-point queries within a few cells. */
export class PointGrid {
    private readonly lo: [number, number, number]; private readonly n: [number, number, number];
    private readonly start: Int32Array; private readonly order: Int32Array;
    constructor(private readonly p: Float32Array, count: number, private readonly cell: number, use?: Uint8Array) {
        const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < count; i++) if (!use || use[i]) for (let c = 0; c < 3; c++) { const v = p[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
        if (!Number.isFinite(lo[0])) { lo[0] = lo[1] = lo[2] = 0; hi[0] = hi[1] = hi[2] = 0; }
        this.lo = lo; this.n = [0, 1, 2].map(c => Math.floor((hi[c] - lo[c]) / cell) + 1) as [number, number, number];
        const cells = this.n[0] * this.n[1] * this.n[2];
        this.start = new Int32Array(cells + 1);
        const key = (i: number) => this.cellOf(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        for (let i = 0; i < count; i++) if (!use || use[i]) this.start[key(i) + 1]++;
        for (let k = 0; k < cells; k++) this.start[k + 1] += this.start[k];
        this.order = new Int32Array(this.start[cells]);
        const fill = this.start.slice(0, cells);
        for (let i = 0; i < count; i++) if (!use || use[i]) this.order[fill[key(i)]++] = i;
    }
    private cellOf(x: number, y: number, z: number): number {
        const i = Math.floor((x - this.lo[0]) / this.cell), j = Math.floor((y - this.lo[1]) / this.cell), k = Math.floor((z - this.lo[2]) / this.cell);
        return (k * this.n[1] + j) * this.n[0] + i;
    }
    /** The nearest point within `r` of (x, y, z): its index and distance, or -1 and Infinity. */
    nearest(x: number, y: number, z: number, r: number): { i: number; d: number } {
        const c = this.cell, i0 = Math.floor((x - r - this.lo[0]) / c), i1 = Math.floor((x + r - this.lo[0]) / c), j0 = Math.floor((y - r - this.lo[1]) / c), j1 = Math.floor((y + r - this.lo[1]) / c), k0 = Math.floor((z - r - this.lo[2]) / c), k1 = Math.floor((z + r - this.lo[2]) / c);
        let best = -1, bd = r * r;
        for (let k = Math.max(0, k0); k <= Math.min(this.n[2] - 1, k1); k++) for (let j = Math.max(0, j0); j <= Math.min(this.n[1] - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(this.n[0] - 1, i1); i++) {
            const cellIndex = (k * this.n[1] + j) * this.n[0] + i;
            for (let q = this.start[cellIndex]; q < this.start[cellIndex + 1]; q++) {
                const s = this.order[q], dx = this.p[s * 3] - x, dy = this.p[s * 3 + 1] - y, dz = this.p[s * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
                if (d <= bd) { bd = d; best = s; }
            }
        }
        return best < 0 ? { i: -1, d: Infinity } : { i: best, d: Math.sqrt(bd) };
    }
}

/**
 * Which scan samples the outside air reaches. Space is cut into voxels of `seenVoxelM`; a voxel the scan's surface
 * passes through, or the shape's where the scan supports it, is a wall, and so is the lowest layer (a cut-out scan is open underneath). The
 * empty voxels are flooded from the box's faces (6-connected); a scan sample is seen when its voxel touches flooded air.
 * The tiles' cut faces and interior surfaces sit in air the flood never reaches; a pocket behind a part of the shape that
 * no scan supports is reached through it. A recess narrower than a voxel is not reached, and a hole in the scan where
 * the shape has no support lets the flood in: both are limits of this test, at the voxel's size.
 */
function seenFromOutside(scan: TriangleSet, shape: TriangleSet, ss: SurfaceSamples, hs: SurfaceSamples, shapeSupported: Uint8Array, P: ShapeDetailParams): Uint8Array {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const set of [scan, shape]) for (let i = 0; i < set.count * 9; i++) { const v = set.pos[i], k = i % 3; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    // the voxel: seenVoxelM, larger when the box would need more than maxVoxels of them
    const pad = 2, volume = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1), c = Math.max(P.seenVoxelM, Math.cbrt(volume / P.maxVoxels));
    const n = [0, 1, 2].map(k => Math.floor((hi[k] - lo[k]) / c) + 1 + 2 * pad), nx = n[0], ny = n[1], nz = n[2];
    const at = (x: number, y: number, z: number) => ((Math.floor((z - lo[2]) / c) + pad) * ny + Math.floor((y - lo[1]) / c) + pad) * nx + Math.floor((x - lo[0]) / c) + pad;
    // 0 empty, 1 wall, 2 flooded air
    const vox = new Uint8Array(nx * ny * nz);
    // a triangle marked at half-voxel steps over its surface, so the wall it makes holds a 6-connected flood
    const mark = (set: TriangleSet, t: number) => {
        const o = t * 9, e1 = Math.hypot(set.pos[o + 3] - set.pos[o], set.pos[o + 4] - set.pos[o + 1], set.pos[o + 5] - set.pos[o + 2]), e2 = Math.hypot(set.pos[o + 6] - set.pos[o], set.pos[o + 7] - set.pos[o + 1], set.pos[o + 8] - set.pos[o + 2]);
        const m = Math.max(1, Math.ceil((2 * Math.max(e1, e2)) / c));
        for (let a = 0; a <= m; a++) for (let b = 0; a + b <= m; b++) {
            const u = a / m, v = b / m, w = 1 - u - v;
            vox[at(w * set.pos[o] + u * set.pos[o + 3] + v * set.pos[o + 6], w * set.pos[o + 1] + u * set.pos[o + 4] + v * set.pos[o + 7], w * set.pos[o + 2] + u * set.pos[o + 5] + v * set.pos[o + 8])] = 1;
        }
    };
    for (let t = 0; t < scan.count; t++) mark(scan, t);
    // the shape is a wall where the scan supports it: a triangle mostly supported whole, else its supported samples
    for (let t = 0; t < shape.count; t++) {
        let sup = 0; for (let i = hs.first[t]; i < hs.first[t + 1]; i++) sup += shapeSupported[i];
        if (sup >= P.majority * (hs.first[t + 1] - hs.first[t])) mark(shape, t);
        else for (let i = hs.first[t]; i < hs.first[t + 1]; i++) if (shapeSupported[i]) vox[at(hs.p[i * 3], hs.p[i * 3 + 1], hs.p[i * 3 + 2])] = 1;
    }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (let j = 0; j <= pad; j++) vox[(k * ny + j) * nx + i] = 1;
    const queue = new Int32Array(nx * ny * nz); let head = 0, tail = 0;
    const push = (v: number) => { if (vox[v] === 0) { vox[v] = 2; queue[tail++] = v; } };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === ny - 1 || k === 0 || i === nx - 1 || k === nz - 1) push((k * ny + j) * nx + i);
    const step = [1, -1, nx, -nx, nx * ny, -nx * ny];
    while (head < tail) {
        const v = queue[head++], i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny));
        if (i > 0) push(v - 1); if (i < nx - 1) push(v + 1); if (j > 0) push(v - nx); if (j < ny - 1) push(v + nx); if (k > 0) push(v - nx * ny); if (k < nz - 1) push(v + nx * ny);
    }
    const seen = new Uint8Array(ss.count);
    for (let i = 0; i < ss.count; i++) { const v = at(ss.p[i * 3], ss.p[i * 3 + 1], ss.p[i * 3 + 2]); for (const d of step) if (vox[v + d] === 2) { seen[i] = 1; break; } }
    return seen;
}

/** What a scan sample is against the shape. */
export const SCAN_CLASS = { near: 0, outside: 1, recess: 2, buried: 3, farOut: 4 } as const;

export interface BandFit { fromY: number; toY: number; seenM2: number; nearShare: number; reliefShare: number; geometryShare: number; buriedM2: number }
export interface ShapeFit {
    version: string;
    /** The scan's area, and the part of it never seen from outside (behind supported shape, or deep under it). */
    scanM2: number; buriedM2: number; seenM2: number;
    /** Of the seen scan: within keepM of the shape (the shape explains it), in keepM..reliefM, and beyond. */
    nearShare: number; reliefShare: number; geometryShare: number;
    /** The shape's area and the share of it with scan within supportM. */
    shapeM2: number; supportedShare: number;
    bands: BandFit[];
}

interface Sorted { scan: TriangleSet; shape: TriangleSet; ss: SurfaceSamples; hs: SurfaceSamples; cls: Uint8Array; dist: Float32Array; shapeSupported: Uint8Array; fit: ShapeFit }

function sortScan(scanBytes: Uint8Array, shapeBytes: Uint8Array, P: ShapeDetailParams): Sorted {
    const scan = readTriangles(scanBytes), shape = readTriangles(shapeBytes);
    if (!scan.count) throw new Error('the scan holds no triangles');
    if (!shape.count) throw new Error('the shape holds no triangles');
    const ss = sampleTriangles(scan, P.spacingM, P.maxSamples), hs = sampleTriangles(shape, P.spacingM, P.maxSamples);
    const cell = Math.max(1, P.spacingM * 2), scanGrid = new PointGrid(ss.p, ss.count, cell), shapeGrid = new PointGrid(hs.p, hs.count, cell);
    // the shape's support: scan within supportM of each of its samples
    const shapeSupported = new Uint8Array(hs.count);
    for (let i = 0; i < hs.count; i++) shapeSupported[i] = scanGrid.nearest(hs.p[i * 3], hs.p[i * 3 + 1], hs.p[i * 3 + 2], P.supportM).i >= 0 ? 1 : 0;
    const seen = seenFromOutside(scan, shape, ss, hs, shapeSupported, P);
    const cls = new Uint8Array(ss.count), dist = new Float32Array(ss.count);
    for (let i = 0; i < ss.count; i++) {
        const x = ss.p[i * 3], y = ss.p[i * 3 + 1], z = ss.p[i * 3 + 2];
        let q = shapeGrid.nearest(x, y, z, Math.max(P.keepM, P.reliefM));
        if (q.i < 0) q = shapeGrid.nearest(x, y, z, P.reachM);
        dist[i] = q.d;
        if (q.i >= 0 && q.d < P.keepM) { cls[i] = SCAN_CLASS.near; continue; }
        if (!seen[i]) { cls[i] = SCAN_CLASS.buried; continue; }
        if (q.i < 0) { cls[i] = SCAN_CLASS.farOut; continue; }
        const t = hs.tri[q.i], side = (x - hs.p[q.i * 3]) * hs.normal[t * 3] + (y - hs.p[q.i * 3 + 1]) * hs.normal[t * 3 + 1] + (z - hs.p[q.i * 3 + 2]) * hs.normal[t * 3 + 2];
        cls[i] = side > 0 ? SCAN_CLASS.outside : SCAN_CLASS.recess;
    }
    // the report: each sample stands for its triangle's area over its sample count
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < ss.count; i++) { y0 = Math.min(y0, ss.p[i * 3 + 1]); y1 = Math.max(y1, ss.p[i * 3 + 1]); }
    const nb = Math.max(1, P.bands), acc = Array.from({ length: nb + 1 }, () => ({ seen: 0, near: 0, relief: 0, geo: 0, buried: 0 }));
    for (let i = 0; i < ss.count; i++) {
        const t = ss.tri[i], a = ss.area[t] / (ss.first[t + 1] - ss.first[t]), b = Math.min(nb - 1, Math.floor(((ss.p[i * 3 + 1] - y0) / Math.max(1e-9, y1 - y0)) * nb));
        for (const s of [acc[b], acc[nb]]) {
            if (cls[i] === SCAN_CLASS.buried) { s.buried += a; continue; }
            s.seen += a;
            if (dist[i] < P.keepM) s.near += a; else if (dist[i] < P.reliefM) s.relief += a; else s.geo += a;
        }
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000, share = (v: number, of: number) => (of > 0 ? r3(v / of) : 0);
    let shapeM2 = 0, supM2 = 0;
    for (let i = 0; i < hs.count; i++) { const t = hs.tri[i], a = hs.area[t] / (hs.first[t + 1] - hs.first[t]); shapeM2 += a; if (shapeSupported[i]) supM2 += a; }
    const all = acc[nb];
    const fit: ShapeFit = {
        version: SHAPE_DETAIL_VERSION, scanM2: Math.round(all.seen + all.buried), buriedM2: Math.round(all.buried), seenM2: Math.round(all.seen),
        nearShare: share(all.near, all.seen), reliefShare: share(all.relief, all.seen), geometryShare: share(all.geo, all.seen),
        shapeM2: Math.round(shapeM2), supportedShare: share(supM2, shapeM2),
        bands: acc.slice(0, nb).map((s, b) => ({ fromY: r3(y0 + (b * (y1 - y0)) / nb), toY: r3(y0 + ((b + 1) * (y1 - y0)) / nb), seenM2: Math.round(s.seen), nearShare: share(s.near, s.seen), reliefShare: share(s.relief, s.seen), geometryShare: share(s.geo, s.seen), buriedM2: Math.round(s.buried) }))
    };
    return { scan, shape, ss, hs, cls, dist, shapeSupported, fit };
}

/** How well a clean shape reproduces a scan: the scan sorted by its distance to the shape, overall and by height band. */
export function measureShapeFit(scanBytes: Uint8Array, shapeBytes: Uint8Array, P: ShapeDetailParams = SHAPE_DETAIL_PARAMS): ShapeFit {
    return sortScan(scanBytes, shapeBytes, P).fit;
}

export interface DetailCompose {
    version: string; params: ShapeDetailParams;
    /** The shape alone against the scan. */
    fit: ShapeFit;
    /** Scan kept (m2, triangles): standing outside the shape, in a recess of it, and far from it; and the ring grown round them. */
    scanKept: { m2: number; triangles: number; outsideM2: number; recessM2: number; farOutM2: number; grownM2: number; patches: number; noiseM2: number };
    /** Scan dropped: explained by the shape, and never seen. */
    scanDropped: { explainedM2: number; buriedM2: number; triangles: number };
    /** The shape's surface removed: unsupported in front of kept scan, or standing proud of the seen scan (proudM2). */
    shapeRemoved: { m2: number; triangles: number; proudM2: number };
    shapeKept: { m2: number; triangles: number };
    /** Of the seen scan, the share the result reproduces within keepM: what the shape explains plus what was kept as scanned. */
    /** The local fallback: cells where the shape did not describe the structure, the scan taken whole there and the shape dropped (m2). */
    regions: { cells: number; scanM2: number; shapeM2: number };
    reproducedShare: number;
    triangles: number;
}

/**
 * The clean shape with the scan's surface kept where it departs (see the module doc). `shapeBytes` and `scanBytes` are
 * GLBs in one frame; the result holds the shape's kept triangles and the scan's kept triangles, each with its own
 * materials, under one root whose extras carry the report.
 */
export function composeShapeDetail(shapeBytes: Uint8Array, scanBytes: Uint8Array, P: ShapeDetailParams = SHAPE_DETAIL_PARAMS): { glb: Buffer; report: DetailCompose } {
    const S = sortScan(scanBytes, shapeBytes, P), { scan, shape, ss, hs, cls } = S;
    // each scan triangle's class: kept when most of its samples stand off the shape and are seen
    const triClass = new Int8Array(scan.count).fill(-1), keep = new Uint8Array(scan.count);
    for (let t = 0; t < scan.count; t++) {
        const n = ss.first[t + 1] - ss.first[t], c = [0, 0, 0, 0, 0];
        for (let i = ss.first[t]; i < ss.first[t + 1]; i++) c[cls[i]]++;
        const off = c[SCAN_CLASS.outside] + c[SCAN_CLASS.recess] + c[SCAN_CLASS.farOut];
        if (off >= P.majority * n) { keep[t] = 1; triClass[t] = c[SCAN_CLASS.outside] >= c[SCAN_CLASS.recess] && c[SCAN_CLASS.outside] >= c[SCAN_CLASS.farOut] ? SCAN_CLASS.outside : c[SCAN_CLASS.recess] >= c[SCAN_CLASS.farOut] ? SCAN_CLASS.recess : SCAN_CLASS.farOut; }
        else triClass[t] = c[SCAN_CLASS.buried] >= P.majority * n ? SCAN_CLASS.buried : SCAN_CLASS.near;
    }
    // the local fallback: cells the shape fits badly
    const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / P.regionM)},${Math.floor(y / P.regionM)},${Math.floor(z / P.regionM)}`;
    const cells = new Map<string, { seen: number; near: number; shape: number; sup: number }>();
    const cellOf = (k: string) => { let c = cells.get(k); if (!c) { c = { seen: 0, near: 0, shape: 0, sup: 0 }; cells.set(k, c); } return c; };
    for (let i = 0; i < ss.count; i++) {
        if (cls[i] === SCAN_CLASS.buried) continue;
        const t = ss.tri[i], a = ss.area[t] / (ss.first[t + 1] - ss.first[t]), c = cellOf(cellKey(ss.p[i * 3], ss.p[i * 3 + 1], ss.p[i * 3 + 2]));
        c.seen += a; if (cls[i] === SCAN_CLASS.near) c.near += a;
    }
    for (let i = 0; i < hs.count; i++) {
        const t = hs.tri[i], a = hs.area[t] / (hs.first[t + 1] - hs.first[t]), c = cellOf(cellKey(hs.p[i * 3], hs.p[i * 3 + 1], hs.p[i * 3 + 2]));
        c.shape += a; if (S.shapeSupported[i]) c.sup += a;
    }
    const badCells = new Set<string>();
    for (const [k, c] of cells) if (c.seen >= P.regionMinM2 && ((c.shape > 0 && c.sup < P.regionFit * c.shape) || c.near < P.regionFit * c.seen)) badCells.add(k);
    const inBad = (S0: SurfaceSamples, t: number) => { let b = 0; for (let i = S0.first[t]; i < S0.first[t + 1]; i++) if (badCells.has(cellKey(S0.p[i * 3], S0.p[i * 3 + 1], S0.p[i * 3 + 2]))) b++; return b >= P.majority * (S0.first[t + 1] - S0.first[t]); };
    let regionScanM2 = 0, regionShapeM2 = 0;
    const regionScan = new Uint8Array(scan.count);
    for (let t = 0; t < scan.count; t++) if (triClass[t] !== SCAN_CLASS.buried && inBad(ss, t)) { regionScan[t] = 1; if (!keep[t]) { keep[t] = 1; triClass[t] = SCAN_CLASS.farOut; regionScanM2 += ss.area[t]; } }
    // corners welded at a millimetre: patches of kept triangles, and the triangles touching them
    const vid = new Int32Array(scan.count * 3), ids = new Map<string, number>();
    for (let v = 0; v < scan.count * 3; v++) {
        const k = `${Math.round(scan.pos[v * 3] * 1000)},${Math.round(scan.pos[v * 3 + 1] * 1000)},${Math.round(scan.pos[v * 3 + 2] * 1000)}`;
        let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); }
        vid[v] = id;
    }
    const parent = new Int32Array(ids.size).map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < scan.count; t++) if (keep[t]) { const r = find(vid[t * 3]); parent[find(vid[t * 3 + 1])] = r; parent[find(vid[t * 3 + 2])] = r; }
    const patchArea = new Map<number, number>();
    for (let t = 0; t < scan.count; t++) if (keep[t]) { const r = find(vid[t * 3]); patchArea.set(r, (patchArea.get(r) ?? 0) + ss.area[t]); }
    let noiseM2 = 0, patches = 0;
    for (const a of patchArea.values()) if (a >= P.minPatchM2) patches++;
    for (let t = 0; t < scan.count; t++) if (keep[t] && (patchArea.get(find(vid[t * 3])) ?? 0) < P.minPatchM2) { keep[t] = 0; noiseM2 += ss.area[t]; }
    const keptCorner = new Uint8Array(ids.size);
    for (let t = 0; t < scan.count; t++) if (keep[t]) for (let c = 0; c < 3; c++) keptCorner[vid[t * 3 + c]] = 1;
    const grown = new Uint8Array(scan.count);
    for (let t = 0; t < scan.count; t++) if (!keep[t] && triClass[t] !== SCAN_CLASS.buried && ss.area[t] <= P.growMaxM2 && (keptCorner[vid[t * 3]] || keptCorner[vid[t * 3 + 1]] || keptCorner[vid[t * 3 + 2]])) grown[t] = 1;
    // the shape's surface standing in air in front of kept scan goes
    const keptSample = new Uint8Array(ss.count);
    for (let i = 0; i < ss.count; i++) keptSample[i] = keep[ss.tri[i]];
    const keptGrid = new PointGrid(ss.p, ss.count, Math.max(1, P.nearM), keptSample);
    const seenSample = new Uint8Array(ss.count);
    for (let i = 0; i < ss.count; i++) seenSample[i] = cls[i] === SCAN_CLASS.buried ? 0 : 1;
    const seenGrid = new PointGrid(ss.p, ss.count, Math.max(1, P.reachM), seenSample);
    const shapeKeep = new Uint8Array(shape.count).fill(1);
    let removedM2 = 0, removedTris = 0, shapeKeptM2 = 0, proudM2 = 0;
    for (let t = 0; t < shape.count; t++) {
        const n = hs.first[t + 1] - hs.first[t]; let sup = 0, near = false;
        for (let i = hs.first[t]; i < hs.first[t + 1]; i++) sup += S.shapeSupported[i];
        if (sup < P.unsupportedShare * n) for (let i = hs.first[t]; i < hs.first[t + 1] && !near; i++) near = keptGrid.nearest(hs.p[i * 3], hs.p[i * 3 + 1], hs.p[i * 3 + 2], P.nearM).i >= 0;
        let proud = 0;
        if (!near && sup < P.unsupportedShare * n) for (let i = hs.first[t]; i < hs.first[t + 1]; i++) {
            if (S.shapeSupported[i]) continue;
            const x = hs.p[i * 3], y = hs.p[i * 3 + 1], z = hs.p[i * 3 + 2], q = seenGrid.nearest(x, y, z, P.reachM);
            if (q.i < 0) continue;
            const st = ss.tri[q.i];
            if ((x - ss.p[q.i * 3]) * ss.normal[st * 3] + (y - ss.p[q.i * 3 + 1]) * ss.normal[st * 3 + 1] + (z - ss.p[q.i * 3 + 2]) * ss.normal[st * 3 + 2] >= P.proudM) proud++;
        }
        const isProud = proud >= P.majority * n, region = !near && !isProud && inBad(hs, t);
        if (region) regionShapeM2 += hs.area[t];
        if (near || isProud || region) { shapeKeep[t] = 0; removedM2 += hs.area[t]; removedTris++; if (isProud) proudM2 += hs.area[t]; } else shapeKeptM2 += hs.area[t];
    }
    const sum = { outside: 0, recess: 0, farOut: 0, grown: 0, explained: 0, buried: 0, keptTris: 0, droppedTris: 0 };
    const scanKeep = new Uint8Array(scan.count);
    for (let t = 0; t < scan.count; t++) {
        const a = ss.area[t];
        if (keep[t]) { scanKeep[t] = 1; sum.keptTris++; if (triClass[t] === SCAN_CLASS.outside) sum.outside += a; else if (triClass[t] === SCAN_CLASS.recess) sum.recess += a; else sum.farOut += a; }
        else if (grown[t]) { scanKeep[t] = 1; sum.keptTris++; sum.grown += a; }
        else { sum.droppedTris++; if (triClass[t] === SCAN_CLASS.buried) sum.buried += a; else sum.explained += a; }
    }
    const shapeOut = keepTriangles(shapeBytes, shapeKeep), scanOut = keepTriangles(scanBytes, scanKeep);
    // of the seen scan: its samples within keepM of the shape, or on a triangle kept as scanned
    let seen = 0, got = 0;
    for (let i = 0; i < ss.count; i++) {
        if (cls[i] === SCAN_CLASS.buried) continue;
        const t = ss.tri[i], a = ss.area[t] / (ss.first[t + 1] - ss.first[t]);
        seen += a; if (scanKeep[t] || cls[i] === SCAN_CLASS.near) got += a;
    }
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const report: DetailCompose = {
        version: SHAPE_DETAIL_VERSION, params: P, fit: S.fit,
        scanKept: { m2: r1(sum.outside + sum.recess + sum.farOut + sum.grown), triangles: sum.keptTris, outsideM2: r1(sum.outside), recessM2: r1(sum.recess), farOutM2: r1(sum.farOut), grownM2: r1(sum.grown), patches, noiseM2: r1(noiseM2) },
        scanDropped: { explainedM2: r1(sum.explained), buriedM2: r1(sum.buried), triangles: sum.droppedTris },
        shapeRemoved: { m2: r1(removedM2), triangles: removedTris, proudM2: r1(proudM2) }, shapeKept: { m2: r1(shapeKeptM2), triangles: shapeOut.kept },
        regions: { cells: badCells.size, scanM2: r1(regionScanM2), shapeM2: r1(regionShapeM2) },
        reproducedShare: seen > 0 ? Math.round((got / seen) * 1000) / 1000 : 0,
        triangles: shapeOut.kept + scanOut.kept
    };
    const parts = [parseGlbBytes(shapeOut.glb)];
    if (scanOut.kept) {
        const kept = parseGlbBytes(scanOut.glb);
        // the scan's kept surface is measured: said on every node that draws it
        for (const node of kept.json.nodes ?? []) if (node.mesh !== undefined) node.extras = { ...(node.extras ?? {}), sb: { ...(node.extras?.sb ?? {}), provenance: 'measured', method: `the scan's own surface, kept where it stands ${P.keepM} m or more off the clean shape (${SHAPE_DETAIL_VERSION})` } };
        parts.push(kept);
    }
    const glb = mergeGlbs(parts, { name: 'shape_detail', unwrapGroups: false, rootExtras: { sb: { schema: 'scratchbox.shape-detail/1', report } } });
    return { glb, report };
}
