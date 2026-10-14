/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Independent geometry-quality metrics for scan rectification stages.
 *
 * This module is measurement only. It has its own GLB reader and never imports the editing code
 * (`glb-geometry-patcher.ts`, the native rectifier), so a bug in an editor cannot also hide in the
 * proof. Every number is computed from the bytes written to disk.
 *
 * Nothing here knows about a specific building or site. Grid orientation, lot rectangles, facade
 * plane specs and roof specs are parameters: callers derive them from the scan at runtime
 * (`estimateGridOrientation`, `deriveStreetLevelViews`) or pass independent survey values in tests.
 *
 * Grid frame convention (`GridFrame.thetaDeg`): u = x cos(theta) - z sin(theta), w = x sin(theta) +
 * z cos(theta) in the tile's (x = East, y = Up, z = South) frame. A wall is grid-aligned when its
 * normal azimuth atan2(nz, nx) is congruent to -theta modulo 90 degrees.
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Independent GLB reader
// ---------------------------------------------------------------------------

/** World-space triangle soup read from a GLB, in scene traversal order. */
export interface MeasuredMesh {
    /** Positions (x, y, z per vertex) as float64 copies of the stored float32 values. */
    positions: Float64Array;
    /** Vertex indices, three per triangle. */
    triangles: Uint32Array;
    /** Material index per triangle (-1 when the primitive has none). */
    triangleMaterial: Int32Array;
    vertexCount: number;
    triangleCount: number;
    /** One entry per rendered primitive instance, in traversal order. */
    instances: MeasuredInstance[];
}

/** A primitive instance's slice of the merged vertex and triangle streams. */
export interface MeasuredInstance {
    mesh: number;
    primitive: number;
    material: number;
    vertexBase: number;
    vertexCount: number;
    triangleBase: number;
    triangleCount: number;
    /** sha256 of the TEXCOORD_0 element bytes, or null when absent. */
    texcoord0Sha256: string | null;
}

/** Byte-level inventory used to prove that textures and UVs survived an edit untouched. */
export interface GlbInventory {
    images: Array<{ index: number; mimeType: string; byteLength: number; sha256: string }>;
    primitives: Array<{
        mesh: number;
        primitive: number;
        material: number;
        attributes: string[];
        indexComponentType: number | null;
        /** sha256 of the TEXCOORD_0 element bytes (stride removed), or null. */
        texcoord0Sha256: string | null;
        triangleCount: number;
    }>;
    materialCount: number;
    meshCount: number;
    nodeTransforms: number;
    attributeNames: string[];
}

interface RawAccessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }
interface RawView { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface RawPrimitive { attributes?: Record<string, number>; indices?: number; material?: number; mode?: number }
interface RawNode { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface RawJson {
    scene?: number;
    scenes?: Array<{ nodes?: number[] }>;
    nodes?: RawNode[];
    meshes?: Array<{ primitives?: RawPrimitive[] }>;
    accessors?: RawAccessor[];
    bufferViews?: RawView[];
    images?: Array<{ bufferView?: number; mimeType?: string }>;
    materials?: unknown[];
}
interface RawGlb { json: RawJson; bin: Buffer }

function readRawGlb(glb: Buffer): RawGlb {
    if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
    let off = 12;
    let json: RawJson | null = null;
    let bin: Buffer = Buffer.alloc(0);
    const end = Math.min(glb.readUInt32LE(8), glb.length);
    while (off + 8 <= end) {
        const len = glb.readUInt32LE(off);
        const type = glb.readUInt32LE(off + 4);
        if (type === 0x4e4f534a && !json) json = JSON.parse(glb.toString('utf8', off + 8, off + 8 + len)) as RawJson;
        else if (type === 0x004e4942 && bin.length === 0) bin = glb.subarray(off + 8, off + 8 + len);
        off += 8 + len;
    }
    if (!json) throw new Error('GLB without JSON chunk');
    return { json, bin };
}

const CSIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorLayout(raw: RawGlb, index: number | undefined): { start: number; stride: number; item: number; count: number; ct: number; nc: number } | null {
    if (index === undefined || !raw.json.accessors || !raw.json.accessors[index]) return null;
    const a = raw.json.accessors[index];
    const bv = a.bufferView === undefined ? undefined : raw.json.bufferViews?.[a.bufferView];
    if (!bv || (bv.buffer ?? 0) !== 0) return null;
    const nc = NCOMP[a.type] ?? 0;
    const item = (CSIZE[a.componentType] ?? 0) * nc;
    const stride = bv.byteStride || item;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (!item || !a.count || start + stride * (a.count - 1) + item > raw.bin.length) return null;
    return { start, stride, item, count: a.count, ct: a.componentType, nc };
}

function readUint(bin: Buffer, at: number, ct: number): number {
    return ct === 5121 ? bin[at] : ct === 5123 ? bin.readUInt16LE(at) : ct === 5125 ? bin.readUInt32LE(at) : 0;
}

function trsMatrix(node: RawNode): number[] {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
        2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
        2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1
    ];
}

function mul(a: number[], b: number[]): number[] {
    const r = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
    return r;
}

function sceneWalk(raw: RawGlb, visit: (nodeIndex: number, meshIndex: number, world: number[]) => void): void {
    const nodes = raw.json.nodes ?? [];
    const scenes = raw.json.scenes ?? [];
    const sceneIndex = raw.json.scene ?? 0;
    let roots: number[];
    if (scenes.length && sceneIndex >= 0 && sceneIndex < scenes.length) roots = scenes[sceneIndex].nodes ?? [];
    else {
        const child = new Set<number>();
        nodes.forEach(n => (n.children ?? []).forEach((c: number) => child.add(c)));
        roots = nodes.map((_, i) => i).filter(i => !child.has(i));
    }
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const walk = (n: number, parent: number[], depth: number): void => {
        if (n < 0 || n >= nodes.length || depth > 64) return;
        const world = mul(parent, trsMatrix(nodes[n]));
        if (nodes[n].mesh !== undefined) visit(n, nodes[n].mesh, world);
        for (const c of nodes[n].children ?? []) walk(c, world, depth + 1);
    };
    for (const r of roots) walk(r, I, 0);
}

/** Reads every triangle primitive (mode 4) in world space. */
export function readMeasuredMesh(glb: Buffer): MeasuredMesh {
    const raw = readRawGlb(glb);
    const P: number[] = [];
    const T: number[] = [];
    const M: number[] = [];
    const instances: MeasuredInstance[] = [];
    sceneWalk(raw, (_n, meshIndex, world) => {
        const mesh = raw.json.meshes?.[meshIndex];
        if (!mesh) return;
        (mesh.primitives ?? []).forEach((prim, primitiveIndex) => {
            if ((prim.mode ?? 4) !== 4) return;
            const pos = accessorLayout(raw, prim.attributes?.POSITION);
            if (!pos || pos.nc !== 3 || pos.ct !== 5126) return;
            const base = P.length / 3;
            const triBase = T.length / 3;
            for (let v = 0; v < pos.count; v++) {
                const at = pos.start + v * pos.stride;
                const x = raw.bin.readFloatLE(at), y = raw.bin.readFloatLE(at + 4), z = raw.bin.readFloatLE(at + 8);
                P.push(
                    world[0] * x + world[4] * y + world[8] * z + world[12],
                    world[1] * x + world[5] * y + world[9] * z + world[13],
                    world[2] * x + world[6] * y + world[10] * z + world[14]
                );
            }
            const idx = accessorLayout(raw, prim.indices);
            const n = idx ? idx.count : pos.count;
            for (let i = 0; i + 2 < n; i += 3) {
                const a = idx ? readUint(raw.bin, idx.start + i * idx.stride, idx.ct) : i;
                const b = idx ? readUint(raw.bin, idx.start + (i + 1) * idx.stride, idx.ct) : i + 1;
                const c = idx ? readUint(raw.bin, idx.start + (i + 2) * idx.stride, idx.ct) : i + 2;
                if (a >= pos.count || b >= pos.count || c >= pos.count) continue;
                T.push(base + a, base + b, base + c);
                M.push(prim.material ?? -1);
            }
            instances.push({
                mesh: meshIndex, primitive: primitiveIndex, material: prim.material ?? -1,
                vertexBase: base, vertexCount: pos.count, triangleBase: triBase, triangleCount: T.length / 3 - triBase,
                texcoord0Sha256: attributeSha256(raw, prim.attributes?.TEXCOORD_0)
            });
        });
    });
    return {
        positions: Float64Array.from(P),
        triangles: Uint32Array.from(T),
        triangleMaterial: Int32Array.from(M),
        vertexCount: P.length / 3,
        triangleCount: T.length / 3,
        instances
    };
}

function attributeSha256(raw: RawGlb, accessor: number | undefined): string | null {
    const a = accessorLayout(raw, accessor);
    if (!a) return null;
    const packed = Buffer.alloc(a.item * a.count);
    for (let i = 0; i < a.count; i++) raw.bin.copy(packed, i * a.item, a.start + i * a.stride, a.start + i * a.stride + a.item);
    return createHash('sha256').update(packed).digest('hex');
}

/** Reads a float attribute of one primitive (stride removed), or null. */
export function readPrimitiveAttribute(glb: Buffer, meshIndex: number, primitiveIndex: number, attribute: string): { components: number; data: Float32Array } | null {
    const raw = readRawGlb(glb);
    const prim = raw.json.meshes?.[meshIndex]?.primitives?.[primitiveIndex];
    const a = accessorLayout(raw, prim?.attributes?.[attribute]);
    if (!a || a.ct !== 5126) return null;
    const data = new Float32Array(a.count * a.nc);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.nc; k++) data[i * a.nc + k] = raw.bin.readFloatLE(a.start + i * a.stride + k * 4);
    return { components: a.nc, data };
}

/**
 * Puts the input's positions into the output's vertex order. The output's primitive instances
 * must be an in-order subsequence of the input's (an editor may drop whole primitives but never
 * reorders vertices); instances are matched on material, vertex count and TEXCOORD_0 bytes.
 */
export function alignInputToOutput(input: MeasuredMesh, output: MeasuredMesh): {
    inputPositions: Float64Array;
    /** Per input triangle: 1 when the output still contains it (same instance, same local indices, same order). */
    inputTriangleKept: Uint8Array;
    /** Per input vertex: its index in the output, or -1 when its primitive was dropped. */
    inputVertexToOutput: Int32Array;
    matchedInstances: number;
    droppedInputInstances: number;
} {
    const aligned = new Float64Array(output.vertexCount * 3);
    const kept = new Uint8Array(input.triangleCount);
    const vertexToOutput = new Int32Array(input.vertexCount).fill(-1);
    let i = 0;
    for (const o of output.instances) {
        while (i < input.instances.length) {
            const c = input.instances[i];
            if (c.material === o.material && c.vertexCount === o.vertexCount && c.texcoord0Sha256 === o.texcoord0Sha256) break;
            i++;
        }
        if (i >= input.instances.length) throw new Error(`output primitive mesh ${o.mesh}/${o.primitive} has no matching input primitive`);
        const c = input.instances[i];
        aligned.set(input.positions.subarray(c.vertexBase * 3, (c.vertexBase + c.vertexCount) * 3), o.vertexBase * 3);
        for (let v = 0; v < c.vertexCount; v++) vertexToOutput[c.vertexBase + v] = o.vertexBase + v;
        // Output triangles are an in-order subsequence of the input instance's triangles.
        let j = c.triangleBase;
        for (let t = o.triangleBase; t < o.triangleBase + o.triangleCount; t++) {
            const a = output.triangles[t * 3] - o.vertexBase, b = output.triangles[t * 3 + 1] - o.vertexBase, d = output.triangles[t * 3 + 2] - o.vertexBase;
            while (j < c.triangleBase + c.triangleCount
                && !(input.triangles[j * 3] - c.vertexBase === a && input.triangles[j * 3 + 1] - c.vertexBase === b && input.triangles[j * 3 + 2] - c.vertexBase === d)) j++;
            if (j >= c.triangleBase + c.triangleCount) throw new Error(`output triangle ${t} is not an in-order subset of its input primitive`);
            kept[j++] = 1;
        }
        i++;
    }
    return {
        inputPositions: aligned, inputTriangleKept: kept, inputVertexToOutput: vertexToOutput,
        matchedInstances: output.instances.length, droppedInputInstances: input.instances.length - output.instances.length
    };
}

/**
 * Splits the input triangles an edit removed into culled ones and collapsed ones, from the two
 * files alone: a removed triangle whose vertices still exist in the output (its primitive was
 * kept) and whose area at the output positions has shrunk to under `max(minAreaM2, maxAreaRatio *
 * inputArea)` was collapsed by the geometry edit (its neighbours now meet across it); every
 * other removed triangle was culled.
 */
export function classifyRemovedTriangles(
    input: MeasuredMesh, output: MeasuredMesh, alignment: { inputTriangleKept: Uint8Array; inputVertexToOutput: Int32Array },
    minAreaM2 = 1e-4, maxAreaRatio = 0.01
): { collapsed: Uint8Array; culledCount: number; collapsedCount: number; culledAreaM2: number; collapsedAreaM2: number } {
    const collapsed = new Uint8Array(input.triangleCount);
    let culledCount = 0, collapsedCount = 0, culledAreaM2 = 0, collapsedAreaM2 = 0;
    const P = input.positions, Q = output.positions, T = input.triangles, map = alignment.inputVertexToOutput;
    const area = (X: ArrayLike<number>, a: number, b: number, c: number): number => {
        const ux = X[b * 3] - X[a * 3], uy = X[b * 3 + 1] - X[a * 3 + 1], uz = X[b * 3 + 2] - X[a * 3 + 2];
        const vx = X[c * 3] - X[a * 3], vy = X[c * 3 + 1] - X[a * 3 + 1], vz = X[c * 3 + 2] - X[a * 3 + 2];
        return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    for (let t = 0; t < input.triangleCount; t++) {
        if (alignment.inputTriangleKept[t]) continue;
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        const a0 = area(P, a, b, c);
        const oa = map[a], ob = map[b], oc = map[c];
        if (oa >= 0 && ob >= 0 && oc >= 0 && area(Q, oa, ob, oc) < Math.max(minAreaM2, maxAreaRatio * a0)) {
            collapsed[t] = 1; collapsedCount++; collapsedAreaM2 += a0;
        } else {
            culledCount++; culledAreaM2 += a0;
        }
    }
    return { collapsed, culledCount, collapsedCount, culledAreaM2, collapsedAreaM2 };
}

/** Hashes images and per-primitive UV bytes so texture preservation can be proven. */
export function inventoryGlb(glb: Buffer): GlbInventory {
    const raw = readRawGlb(glb);
    const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
    const images = (raw.json.images ?? []).map((img, index) => {
        const bv = img.bufferView === undefined ? undefined : raw.json.bufferViews?.[img.bufferView];
        if (!bv) return { index, mimeType: img.mimeType ?? '', byteLength: 0, sha256: '' };
        const bytes = raw.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        return { index, mimeType: img.mimeType ?? '', byteLength: bytes.length, sha256: sha(bytes) };
    });
    const names = new Set<string>();
    const primitives: GlbInventory['primitives'] = [];
    (raw.json.meshes ?? []).forEach((mesh, mi) => {
        (mesh.primitives ?? []).forEach((prim, pi) => {
            Object.keys(prim.attributes ?? {}).forEach(k => names.add(k));
            const uvSha = attributeSha256(raw, prim.attributes?.TEXCOORD_0);
            const idx = accessorLayout(raw, prim.indices);
            const pos = accessorLayout(raw, prim.attributes?.POSITION);
            primitives.push({
                mesh: mi, primitive: pi, material: prim.material ?? -1,
                attributes: Object.keys(prim.attributes ?? {}).sort(),
                indexComponentType: idx ? idx.ct : null,
                texcoord0Sha256: uvSha,
                triangleCount: Math.floor((idx ? idx.count : pos ? pos.count : 0) / 3)
            });
        });
    });
    const nodeTransforms = (raw.json.nodes ?? []).filter(n => n.matrix || n.translation || n.rotation || n.scale).length;
    return {
        images, primitives,
        materialCount: (raw.json.materials ?? []).length,
        meshCount: (raw.json.meshes ?? []).length,
        nodeTransforms,
        attributeNames: [...names].sort()
    };
}

// ---------------------------------------------------------------------------
// Basic triangle geometry and welding
// ---------------------------------------------------------------------------

export interface TriangleGeometry {
    normals: Float64Array;
    areas: Float64Array;
    centroids: Float64Array;
}

export function triangleGeometry(P: ArrayLike<number>, T: ArrayLike<number>): TriangleGeometry {
    const n = T.length / 3;
    const normals = new Float64Array(n * 3), areas = new Float64Array(n), centroids = new Float64Array(n * 3);
    for (let t = 0; t < n; t++) {
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz);
        areas[t] = 0.5 * l;
        const s = 1 / Math.max(l, 1e-12);
        normals[t * 3] = nx * s; normals[t * 3 + 1] = ny * s; normals[t * 3 + 2] = nz * s;
        centroids[t * 3] = (P[a] + P[b] + P[c]) / 3;
        centroids[t * 3 + 1] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
        centroids[t * 3 + 2] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    }
    return { normals, areas, centroids };
}

/** Weld ids from position quantisation at `tol` metres (positions are never modified). */
export function weldIds(P: ArrayLike<number>, tol = 1e-3): { ids: Int32Array; count: number } {
    const V = P.length / 3;
    const ids = new Int32Array(V);
    const map = new Map<string, number>();
    for (let v = 0; v < V; v++) {
        const key = `${Math.round(P[v * 3] / tol)},${Math.round(P[v * 3 + 1] / tol)},${Math.round(P[v * 3 + 2] / tol)}`;
        let id = map.get(key);
        if (id === undefined) { id = map.size; map.set(key, id); }
        ids[v] = id;
    }
    return { ids, count: map.size };
}

/** Selects the triangles whose mask entry is non-zero. */
export function selectTriangles(T: Uint32Array, keep: ArrayLike<number>): Uint32Array {
    let n = 0;
    for (let t = 0; t < keep.length; t++) if (keep[t]) n++;
    const out = new Uint32Array(n * 3);
    let w = 0;
    for (let t = 0; t < keep.length; t++) {
        if (!keep[t]) continue;
        out[w++] = T[t * 3]; out[w++] = T[t * 3 + 1]; out[w++] = T[t * 3 + 2];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/** Weighted quantile: the smallest x whose cumulative weight reaches q of the total. */
export function weightedQuantile(x: ArrayLike<number>, w: ArrayLike<number>, q: number): number {
    const n = x.length;
    if (n === 0) return NaN;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
    let total = 0;
    for (let i = 0; i < n; i++) total += w[i];
    const target = q * total;
    let acc = 0;
    for (const i of order) { acc += w[i]; if (acc >= target) return x[i]; }
    return x[order[n - 1]];
}

/** Linear-interpolated percentile (numpy default). */
export function percentile(values: ArrayLike<number>, p: number): number {
    const n = values.length;
    if (n === 0) return NaN;
    const s = Float64Array.from(values).sort();
    const pos = (p / 100) * (n - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(values: ArrayLike<number>): number {
    return percentile(values, 50);
}

/** Floor modulo, matching Python's `%` for floats. */
function fmod(a: number, m: number): number {
    return a - m * Math.floor(a / m);
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export interface TopologyStats {
    tris: number;
    verts: number;
    weldedVerts: number;
    degenerateTris: number;
    edges: number;
    boundaryEdges: number;
    nonmanifoldEdges: number;
    watertight: boolean;
}

/** Welded (1 mm) edge topology: boundary edges show cracks, >2-face edges show shells. */
export function topology(P: ArrayLike<number>, T: Uint32Array, weldTol = 1e-3): TopologyStats {
    const { ids, count } = weldIds(P, weldTol);
    const geo = triangleGeometry(P, T);
    let degenerate = 0;
    for (let t = 0; t < geo.areas.length; t++) if (geo.areas[t] < 1e-6) degenerate++;
    const edges = new Map<number, number>();
    const n = T.length / 3;
    for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
            let a = ids[T[t * 3 + k]], b = ids[T[t * 3 + ((k + 1) % 3)]];
            if (a === b) continue;
            if (a > b) { const s = a; a = b; b = s; }
            const key = a * count + b;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    let boundary = 0, nonmanifold = 0, two = 0;
    for (const c of edges.values()) { if (c === 1) boundary++; else if (c > 2) nonmanifold++; else two++; }
    return {
        tris: n, verts: P.length / 3, weldedVerts: count, degenerateTris: degenerate,
        edges: edges.size, boundaryEdges: boundary, nonmanifoldEdges: nonmanifold, watertight: two === edges.size
    };
}

// ---------------------------------------------------------------------------
// Chunk-seam openings (geometric; the welded topology above cannot see unwelded T-junctions)
// ---------------------------------------------------------------------------

export interface SeamOpeningStats {
    /** Boundary vertices within `contactM` of a boundary edge of another raw component, at input positions. */
    tJunctions: number;
    tJunctionsOpenedOver2cm: number;
    tJunctionsOpenedOver5cm: number;
    tJunctionsOpenedOver10cm: number;
    tJunctionMaxGapM: number;
    /** Boundary edges whose interior points (t = 0.2, 0.5, 0.8) touch another boundary edge within `edgeContactM`. */
    edgeContactLengthM: number;
    edgeOpenedOver2cmM: number;
    edgeOpenedOver5cmM: number;
    edgeOpenedOver10cmM: number;
    edgeOpenedOver20cmM: number;
    edgeMaxGapM: number;
}

/**
 * Measures how far the edit pulls apart surfaces that touched at input positions along unwelded tile-chunk
 * seams. `P0`/`P1` share vertex order; `T` is the kept triangle set. Partners are found at the input
 * positions and their gap is re-measured at the output positions with the same parameters, so a seam that
 * moves rigidly keeps its gap and a seam the edit closes reports a smaller one.
 */
export function seamOpenings(P0: ArrayLike<number>, P1: ArrayLike<number>, T: Uint32Array, options: { contactM?: number; edgeContactM?: number } = {}): SeamOpeningStats {
    const contactM = options.contactM ?? 0.005, edgeContactM = options.edgeContactM ?? 0.01;
    const V = P0.length / 3, n = T.length / 3;
    const { ids, count } = weldIds(P0, 1e-3);
    // raw components: triangles connected through shared vertex indices (chunks are not stitched)
    const parent = new Int32Array(V).map((_, i) => i);
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let t = 0; t < n; t++) {
        const a = find(T[t * 3]), b = find(T[t * 3 + 1]), c = find(T[t * 3 + 2]);
        parent[b] = a; parent[find(c)] = find(a);
    }
    // boundary edges of the welded topology (used once), with one representative pair of raw vertices
    const edgeUse = new Map<number, number>();
    const edgeRaw = new Map<number, [number, number]>();
    for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
            const va = T[t * 3 + k], vb = T[t * 3 + ((k + 1) % 3)];
            let a = ids[va], b = ids[vb];
            if (a === b) continue;
            if (a > b) { const s = a; a = b; b = s; }
            const key = a * count + b;
            edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
            if (!edgeRaw.has(key)) edgeRaw.set(key, [va, vb]);
        }
    }
    const E: Array<[number, number]> = [];
    for (const [key, c] of edgeUse) if (c === 1) E.push(edgeRaw.get(key)!);
    const cell = 2.0;
    const ck = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    const grid = new Map<string, number[]>();
    const pad = Math.max(contactM, edgeContactM) + 0.01;
    E.forEach(([a, b], e) => {
        const x0 = Math.min(P0[a * 3], P0[b * 3]) - pad, x1 = Math.max(P0[a * 3], P0[b * 3]) + pad;
        const y0 = Math.min(P0[a * 3 + 1], P0[b * 3 + 1]) - pad, y1 = Math.max(P0[a * 3 + 1], P0[b * 3 + 1]) + pad;
        const z0 = Math.min(P0[a * 3 + 2], P0[b * 3 + 2]) - pad, z1 = Math.max(P0[a * 3 + 2], P0[b * 3 + 2]) + pad;
        for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++)
            for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++)
                for (let k = Math.floor(z0 / cell); k <= Math.floor(z1 / cell); k++) {
                    const key = `${i},${j},${k}`;
                    let l = grid.get(key);
                    if (!l) { l = []; grid.set(key, l); }
                    l.push(e);
                }
    });
    const pointSeg = (P: ArrayLike<number>, px: number, py: number, pz: number, a: number, b: number): { d: number; t: number } => {
        const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
        const dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az;
        const l2 = dx * dx + dy * dy + dz * dz;
        const t = l2 > 1e-18 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2)) : 0;
        return { d: Math.hypot(px - ax - dx * t, py - ay - dy * t, pz - az - dz * t), t };
    };
    const at = (P: ArrayLike<number>, a: number, b: number, t: number, k: number): number => P[a * 3 + k] + (P[b * 3 + k] - P[a * 3 + k]) * t;

    // 1. vertex-on-edge T-junctions
    const bverts = new Set<number>();
    for (const [a, b] of E) { bverts.add(a); bverts.add(b); }
    let tj = 0, o2 = 0, o5 = 0, o10 = 0, tmax = 0;
    for (const v of bverts) {
        const px = P0[v * 3], py = P0[v * 3 + 1], pz = P0[v * 3 + 2];
        const cand = grid.get(ck(px, py, pz));
        if (!cand) continue;
        let best = Infinity, be = -1, bt = 0;
        for (const e of cand) {
            const [a, b] = E[e];
            if (ids[a] === ids[v] || ids[b] === ids[v] || find(a) === find(v)) continue;
            const r = pointSeg(P0, px, py, pz, a, b);
            if (r.d < best) { best = r.d; be = e; bt = r.t; }
        }
        if (be < 0 || best >= contactM) continue;
        tj++;
        const [a, b] = E[be];
        const g = Math.hypot(P1[v * 3] - at(P1, a, b, bt, 0), P1[v * 3 + 1] - at(P1, a, b, bt, 1), P1[v * 3 + 2] - at(P1, a, b, bt, 2));
        if (g > 0.02) o2++;
        if (g > 0.05) o5++;
        if (g > 0.10) o10++;
        tmax = Math.max(tmax, g);
    }

    // 2. edge-on-edge contacts at interior points of each boundary edge
    let paired = 0, e2 = 0, e5 = 0, e10 = 0, e20 = 0, emax = 0;
    E.forEach(([a, b], e) => {
        const len = Math.hypot(P0[b * 3] - P0[a * 3], P0[b * 3 + 1] - P0[a * 3 + 1], P0[b * 3 + 2] - P0[a * 3 + 2]);
        let gap = -1;
        for (const tq of [0.2, 0.5, 0.8]) {
            const qx = at(P0, a, b, tq, 0), qy = at(P0, a, b, tq, 1), qz = at(P0, a, b, tq, 2);
            const cand = grid.get(ck(qx, qy, qz));
            if (!cand) continue;
            let best = Infinity, bf = -1, bt = 0;
            for (const f of cand) {
                if (f === e) continue;
                const [c, d] = E[f];
                if (ids[c] === ids[a] || ids[c] === ids[b] || ids[d] === ids[a] || ids[d] === ids[b]) continue;
                const r = pointSeg(P0, qx, qy, qz, c, d);
                if (r.d < best) { best = r.d; bf = f; bt = r.t; }
            }
            if (bf < 0 || best > edgeContactM) continue;
            const [c, d] = E[bf];
            const g = Math.hypot(at(P1, a, b, tq, 0) - at(P1, c, d, bt, 0), at(P1, a, b, tq, 1) - at(P1, c, d, bt, 1), at(P1, a, b, tq, 2) - at(P1, c, d, bt, 2));
            gap = Math.max(gap, g);
        }
        if (gap < 0) return;
        paired += len;
        if (gap > 0.02) e2 += len;
        if (gap > 0.05) e5 += len;
        if (gap > 0.10) e10 += len;
        if (gap > 0.20) e20 += len;
        emax = Math.max(emax, gap);
    });
    return {
        tJunctions: tj, tJunctionsOpenedOver2cm: o2, tJunctionsOpenedOver5cm: o5, tJunctionsOpenedOver10cm: o10, tJunctionMaxGapM: tmax,
        edgeContactLengthM: paired, edgeOpenedOver2cmM: e2, edgeOpenedOver5cmM: e5, edgeOpenedOver10cmM: e10, edgeOpenedOver20cmM: e20, edgeMaxGapM: emax
    };
}

export interface SeamCrackSample {
    /** Sample point on the boundary edge at the input positions. */
    at: [number, number, number];
    /** Gap to the surface it touched, before and after (m). */
    gapInM: number;
    gapOutM: number;
    /** Share of the edge's length this sample stands for (m). */
    lengthM: number;
}

export interface SeamCrackStats {
    /** Welded boundary edges of the kept set. */
    boundaryEdges: number;
    /** Boundary-edge length whose samples touched another piece's surface (edge or face) at input (m). */
    contactLengthM: number;
    /** Contact length whose gap grew by more than 2 / 5 / 10 / 20 cm (m). */
    openedOver2cmM: number;
    openedOver5cmM: number;
    openedOver10cmM: number;
    openedOver20cmM: number;
    /** Largest gap growth (m). */
    maxOpeningM: number;
    /** Contact length whose gap shrank by more than 5 mm (closed by the edit, m). */
    closedM: number;
    /** The widest openings (diagnostics). */
    worst: SeamCrackSample[];
}

/**
 * Chunk-seam cracks, edge-to-edge and edge-to-face. Unwelded tile chunks meet along borders that either coincide
 * with another chunk's border or run across another chunk's face; an edit that moves the two sides differently opens
 * a slit there. For every welded (1 mm) boundary edge of the kept triangles `T`, five points (t = 0.1 .. 0.9) are
 * sampled at the input positions `P0`; the kept triangles of OTHER pieces (connected through shared raw vertices)
 * within `contactM` of a sample are its partner surface. At the output positions `P1` the sample's distance to the
 * same partner triangles is measured again; the growth of that distance is the crack the edit opened. A partner that
 * slides along its own plane leaves the distance unchanged, so tangential motion is not counted; a border lifted off
 * the surface it lay on is. Independent of the editing code: it reads only the two position sets.
 */
export function seamCracks(P0: ArrayLike<number>, P1: ArrayLike<number>, T: Uint32Array, options: { contactM?: number; worst?: number } = {}): SeamCrackStats {
    const contactM = options.contactM ?? 0.01;
    const V = P0.length / 3, n = T.length / 3;
    const { ids, count } = weldIds(P0, 1e-3);
    const parent = new Int32Array(V).map((_, i) => i);
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let t = 0; t < n; t++) {
        const a = find(T[t * 3]), b = find(T[t * 3 + 1]);
        if (a !== b) parent[b] = a;
        const c = find(T[t * 3 + 2]), r = find(a);
        if (c !== r) parent[c] = r;
    }
    const edgeUse = new Map<number, number>();
    const edgeRaw = new Map<number, [number, number]>();
    for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
            const va = T[t * 3 + k], vb = T[t * 3 + ((k + 1) % 3)];
            let a = ids[va], b = ids[vb];
            if (a === b) continue;
            if (a > b) { const s = a; a = b; b = s; }
            const key = a * count + b;
            edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
            if (!edgeRaw.has(key)) edgeRaw.set(key, [va, vb]);
        }
    }
    const E: Array<[number, number]> = [];
    for (const [key, c] of edgeUse) if (c === 1) E.push(edgeRaw.get(key)!);
    E.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    // kept triangles hashed by their padded input AABB (2 m cells)
    const cell = 2.0, pad = contactM + 0.01;
    const grid = new Map<string, number[]>();
    const triComp = new Int32Array(n);
    for (let t = 0; t < n; t++) {
        triComp[t] = find(T[t * 3]);
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let k = 0; k < 3; k++) {
            const v = T[t * 3 + k];
            x0 = Math.min(x0, P0[v * 3]); y0 = Math.min(y0, P0[v * 3 + 1]); z0 = Math.min(z0, P0[v * 3 + 2]);
            x1 = Math.max(x1, P0[v * 3]); y1 = Math.max(y1, P0[v * 3 + 1]); z1 = Math.max(z1, P0[v * 3 + 2]);
        }
        for (let i = Math.floor((x0 - pad) / cell); i <= Math.floor((x1 + pad) / cell); i++)
            for (let j = Math.floor((y0 - pad) / cell); j <= Math.floor((y1 + pad) / cell); j++)
                for (let k = Math.floor((z0 - pad) / cell); k <= Math.floor((z1 + pad) / cell); k++) {
                    const key = `${i},${j},${k}`;
                    let l = grid.get(key);
                    if (!l) { l = []; grid.set(key, l); }
                    l.push(t);
                }
    }
    const closest = (P: ArrayLike<number>, t: number, px: number, py: number, pz: number): number => {
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const q = closestPointOnTriangle(px, py, pz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]);
        return Math.hypot(px - q[0], py - q[1], pz - q[2]);
    };
    const ts = [0.1, 0.3, 0.5, 0.7, 0.9];
    let contact = 0, o2 = 0, o5 = 0, o10 = 0, o20 = 0, omax = 0, closed = 0;
    const samples: SeamCrackSample[] = [];
    const keepWorst = options.worst ?? 40;
    for (const [a, b] of E) {
        const L = Math.hypot(P0[b * 3] - P0[a * 3], P0[b * 3 + 1] - P0[a * 3 + 1], P0[b * 3 + 2] - P0[a * 3 + 2]);
        const comp = find(a);
        for (const tq of ts) {
            const qx = P0[a * 3] + (P0[b * 3] - P0[a * 3]) * tq, qy = P0[a * 3 + 1] + (P0[b * 3 + 1] - P0[a * 3 + 1]) * tq, qz = P0[a * 3 + 2] + (P0[b * 3 + 2] - P0[a * 3 + 2]) * tq;
            const cand = grid.get(`${Math.floor(qx / cell)},${Math.floor(qy / cell)},${Math.floor(qz / cell)}`);
            if (!cand) continue;
            let din = Infinity;
            const near: number[] = [];
            for (const t of cand) {
                if (triComp[t] === comp) continue;
                const d = closest(P0, t, qx, qy, qz);
                if (d < contactM) { near.push(t); din = Math.min(din, d); }
            }
            if (!near.length) continue;
            const rx = P1[a * 3] + (P1[b * 3] - P1[a * 3]) * tq, ry = P1[a * 3 + 1] + (P1[b * 3 + 1] - P1[a * 3 + 1]) * tq, rz = P1[a * 3 + 2] + (P1[b * 3 + 2] - P1[a * 3 + 2]) * tq;
            let dout = Infinity;
            for (const t of near) dout = Math.min(dout, closest(P1, t, rx, ry, rz));
            const w = L / ts.length, g = dout - din;
            contact += w;
            if (g > 0.02) o2 += w;
            if (g > 0.05) o5 += w;
            if (g > 0.10) o10 += w;
            if (g > 0.20) o20 += w;
            if (g < -0.005) closed += w;
            omax = Math.max(omax, g);
            if (g > 0.05 && keepWorst > 0) {
                samples.push({ at: [qx, qy, qz], gapInM: din, gapOutM: dout, lengthM: w });
                if (samples.length > 4 * keepWorst) {
                    samples.sort((x, y) => (y.gapOutM - y.gapInM) - (x.gapOutM - x.gapInM));
                    samples.length = keepWorst;
                }
            }
        }
    }
    samples.sort((x, y) => (y.gapOutM - y.gapInM) - (x.gapOutM - x.gapInM));
    if (samples.length > keepWorst) samples.length = keepWorst;
    return {
        boundaryEdges: E.length, contactLengthM: contact,
        openedOver2cmM: o2, openedOver5cmM: o5, openedOver10cmM: o10, openedOver20cmM: o20, maxOpeningM: omax, closedM: closed,
        worst: samples
    };
}

/** Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestPointOnTriangle(
    px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number
): [number, number, number] {
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return [bx, by, bz];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [ax + abx * v, ay + aby * v, az + abz * v]; }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return [cx, cy, cz];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [ax + acx * w, ay + acy * w, az + acz * w]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return [bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w];
    }
    const den = 1 / (va + vb + vc);
    const v = vb * den, w = vc * den;
    return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}

// ---------------------------------------------------------------------------
// Grid orientation and facade statistics
// ---------------------------------------------------------------------------

export interface GridFrame {
    /** Rotation (degrees) of the (u, w) grid frame; see the module header for the convention. */
    thetaDeg: number;
}

/** Axis-aligned rectangle in the grid frame. */
export interface GridRect { u0: number; u1: number; w0: number; w1: number }

export function toGridUW(x: number, z: number, frame: GridFrame): [number, number] {
    const th = (frame.thetaDeg * Math.PI) / 180;
    const C = Math.cos(th), S = Math.sin(th);
    return [x * C - z * S, x * S + z * C];
}

export interface GridOrientationEstimate {
    /** Dominant wall-normal azimuth atan2(nz, nx) modulo 90 degrees. */
    normalAzimuthDeg: number;
    /** The same orientation as a `GridFrame.thetaDeg`. */
    frame: GridFrame;
    /** Facade area that voted (m^2). */
    votingAreaM2: number;
}

/**
 * Measurement-side estimate of the dominant facade grid: an area-weighted histogram of
 * near-vertical normal azimuths modulo 90 degrees (0.5 degree bins, 5-bin circular smoothing),
 * refined by a 4-theta circular mean within 2 degrees of the peak.
 */
export function estimateGridOrientation(P: ArrayLike<number>, T: Uint32Array, triangleMask?: ArrayLike<number>): GridOrientationEstimate {
    const geo = triangleGeometry(P, T);
    const n = T.length / 3;
    const az: number[] = [], ar: number[] = [];
    for (let t = 0; t < n; t++) {
        if (triangleMask && !triangleMask[t]) continue;
        if (Math.abs(geo.normals[t * 3 + 1]) >= 0.15 || geo.areas[t] <= 0.5) continue;
        az.push(fmod((Math.atan2(geo.normals[t * 3 + 2], geo.normals[t * 3]) * 180) / Math.PI, 90));
        ar.push(geo.areas[t]);
    }
    const bins = 180;
    const h = new Float64Array(bins);
    for (let i = 0; i < az.length; i++) h[Math.min(bins - 1, Math.floor(az[i] / 0.5))] += ar[i];
    let best = 0, bestV = -1;
    for (let b = 0; b < bins; b++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += h[(b + k + bins) % bins];
        if (s / 5 > bestV) { bestV = s / 5; best = b; }
    }
    const pk = best * 0.5 + 0.25;
    let ss = 0, cc = 0, votes = 0;
    for (let i = 0; i < az.length; i++) {
        const d = fmod(az[i] - pk + 45, 90) - 45;
        if (Math.abs(d) >= 2) continue;
        const r = (4 * d * Math.PI) / 180;
        ss += Math.sin(r) * ar[i]; cc += Math.cos(r) * ar[i]; votes += ar[i];
    }
    const alpha = fmod(pk + (Math.atan2(ss, cc) * 180) / Math.PI / 4, 90);
    return { normalAzimuthDeg: alpha, frame: { thetaDeg: fmod(-alpha, 90) }, votingAreaM2: votes };
}

export interface FacadeStats {
    facadeAreaM2: number;
    tiltMeanDeg: number;
    tiltP90Deg: number;
    /** Mean |azimuth deviation| of walls within 20 degrees of the grid. */
    azDevMeanDegGridWalls: number;
    /** Facade area fraction within 1 degree of plumb and 1 degree of the grid. */
    areaFracWithin1DegPlumbAndGrid: number;
}

/** Facade (|ny| < 0.3) plumbness and grid alignment, optionally restricted to a triangle mask. */
export function facadeStats(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, triangleMask?: ArrayLike<number>): FacadeStats {
    const geo = triangleGeometry(P, T);
    const th = (frame.thetaDeg * Math.PI) / 180;
    const C = Math.cos(th), S = Math.sin(th);
    const tilt: number[] = [], area: number[] = [], dev: number[] = [];
    for (let t = 0; t < T.length / 3; t++) {
        const nx = geo.normals[t * 3], ny = geo.normals[t * 3 + 1], nz = geo.normals[t * 3 + 2];
        if (!(Math.abs(ny) < 0.3) || !(geo.areas[t] > 1e-6)) continue;
        if (triangleMask && !triangleMask[t]) continue;
        area.push(geo.areas[t]);
        tilt.push((Math.asin(Math.min(1, Math.abs(ny))) * 180) / Math.PI);
        const nu = nx * C - nz * S, nw = nx * S + nz * C;
        dev.push(fmod((Math.atan2(nw, nu) * 180) / Math.PI + 45, 90) - 45);
    }
    let total = 0, tiltSum = 0, alA = 0, alD = 0, good = 0;
    for (let i = 0; i < area.length; i++) {
        total += area[i];
        tiltSum += tilt[i] * area[i];
        if (Math.abs(dev[i]) < 20) { alA += area[i]; alD += Math.abs(dev[i]) * area[i]; }
        if (tilt[i] < 1 && Math.abs(dev[i]) < 1) good += area[i];
    }
    return {
        facadeAreaM2: total,
        tiltMeanDeg: total > 0 ? tiltSum / total : NaN,
        tiltP90Deg: weightedQuantile(tilt, area, 0.9),
        azDevMeanDegGridWalls: alA > 0 ? alD / alA : NaN,
        areaFracWithin1DegPlumbAndGrid: total > 0 ? good / total : NaN
    };
}

/** Triangle mask: centroid inside a grid-frame rectangle. */
export function trianglesInGridRect(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, rect: GridRect): Uint8Array {
    const geo = triangleGeometry(P, T);
    const out = new Uint8Array(T.length / 3);
    for (let t = 0; t < out.length; t++) {
        const [u, w] = toGridUW(geo.centroids[t * 3], geo.centroids[t * 3 + 2], frame);
        out[t] = u >= rect.u0 && u <= rect.u1 && w >= rect.w0 && w <= rect.w1 ? 1 : 0;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Plane fits, facade faces, corner bevels, roofs
// ---------------------------------------------------------------------------

/** Eigen-decomposition of a symmetric 3x3 matrix (Jacobi). Returns ascending eigenpairs. */
function symmetricEigen3(a: number[][]): { values: number[]; vectors: number[][] } {
    const A = a.map(r => r.slice());
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
        if (off < 1e-30) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(A[p][q]) < 1e-300) continue;
            const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = A[k][p], akq = A[k][q];
                A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = A[p][k], aqk = A[q][k];
                A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = V[k][p], vkq = V[k][q];
                V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const order = [0, 1, 2].sort((i, j) => A[i][i] - A[j][j]);
    return { values: order.map(i => A[i][i]), vectors: order.map(i => [V[0][i], V[1][i], V[2][i]]) };
}

export interface PlaneFit {
    nTris: number;
    areaM2: number;
    rmsM: number;
    p95M: number;
    tiltDeg: number;
    azDevDeg: number;
    centroid: [number, number, number];
    normal: [number, number, number];
}

/** Area-weighted PCA plane through the vertices of the selected triangles. */
export function fitPlane(P: ArrayLike<number>, T: Uint32Array, triangleMask: ArrayLike<number>, frame: GridFrame): PlaneFit | null {
    const geo = triangleGeometry(P, T);
    const pts: number[] = [], w: number[] = [];
    let nTris = 0, area = 0;
    for (let t = 0; t < T.length / 3; t++) {
        if (!triangleMask[t]) continue;
        nTris++; area += geo.areas[t];
        for (let k = 0; k < 3; k++) {
            const v = T[t * 3 + k];
            pts.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
            w.push(geo.areas[t] / 3);
        }
    }
    if (nTris === 0) return null;
    let W = 0; const mu = [0, 0, 0];
    for (let i = 0; i < w.length; i++) { W += w[i]; for (let k = 0; k < 3; k++) mu[k] += pts[i * 3 + k] * w[i]; }
    for (let k = 0; k < 3; k++) mu[k] /= W;
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < w.length; i++) {
        const d = [pts[i * 3] - mu[0], pts[i * 3 + 1] - mu[1], pts[i * 3 + 2] - mu[2]];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += d[r] * d[c] * w[i];
    }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] /= W;
    const n = symmetricEigen3(cov).vectors[0];
    const dist: number[] = [];
    let ss = 0;
    for (let i = 0; i < w.length; i++) {
        const d = (pts[i * 3] - mu[0]) * n[0] + (pts[i * 3 + 1] - mu[1]) * n[1] + (pts[i * 3 + 2] - mu[2]) * n[2];
        dist.push(Math.abs(d)); ss += d * d * w[i];
    }
    const th = (frame.thetaDeg * Math.PI) / 180;
    const nu = n[0] * Math.cos(th) - n[2] * Math.sin(th), nw = n[0] * Math.sin(th) + n[2] * Math.cos(th);
    return {
        nTris, areaM2: area,
        rmsM: Math.sqrt(ss / W),
        p95M: weightedQuantile(dist, w, 0.95),
        tiltDeg: (Math.asin(Math.min(1, Math.abs(n[1]))) * 180) / Math.PI,
        azDevDeg: fmod((Math.atan2(nw, nu) * 180) / Math.PI + 45, 90) - 45,
        centroid: [mu[0], mu[1], mu[2]],
        normal: [n[0], n[1], n[2]]
    };
}

/** A facade face to measure: walls facing `sign` along `axis`, near `offset`, in a height band. */
export interface FacadeFaceSpec {
    name: string;
    axis: 'u' | 'w';
    sign: 1 | -1;
    offset: number;
    /** |coord - offset| tolerance (m). */
    band: number;
    /** Lateral window on the other axis, as |coord| range. */
    lateral: { lo: number; hi: number };
    y0: number;
    y1: number;
}

export interface FacadeFaceResult extends PlaneFit {
    /** Fitted plane offset along the face axis. */
    offsetFit: number;
}

export function measureFacadeFaces(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, faces: FacadeFaceSpec[]): Record<string, FacadeFaceResult | null> {
    const geo = triangleGeometry(P, T);
    const th = (frame.thetaDeg * Math.PI) / 180;
    const C = Math.cos(th), S = Math.sin(th);
    const n = T.length / 3;
    const out: Record<string, FacadeFaceResult | null> = {};
    for (const f of faces) {
        const sel = new Uint8Array(n);
        for (let t = 0; t < n; t++) {
            const cx = geo.centroids[t * 3], cy = geo.centroids[t * 3 + 1], cz = geo.centroids[t * 3 + 2];
            const nx = geo.normals[t * 3], nz = geo.normals[t * 3 + 2];
            const cu = cx * C - cz * S, cw = cx * S + cz * C;
            const nu = nx * C - nz * S, nw = nx * S + nz * C;
            const coord = f.axis === 'u' ? cu : cw;
            const ncomp = f.axis === 'u' ? nu : nw;
            const other = Math.abs(f.axis === 'u' ? cw : cu);
            sel[t] = ncomp * f.sign > 0.8 && Math.abs(coord - f.offset) < f.band && cy > f.y0 && cy < f.y1
                && other > f.lateral.lo && other < f.lateral.hi ? 1 : 0;
        }
        const fit = fitPlane(P, T, sel, frame);
        if (!fit) { out[f.name] = null; continue; }
        const [mu, mw] = toGridUW(fit.centroid[0], fit.centroid[2], frame);
        out[f.name] = { ...fit, offsetFit: f.axis === 'u' ? mu : mw };
    }
    return out;
}

/** Horizontal cross-section segments at height y, as (u, w) endpoint pairs. */
export function crossSection(P: ArrayLike<number>, T: Uint32Array, y: number, frame: GridFrame): Array<[[number, number], [number, number]]> {
    const segs: Array<[[number, number], [number, number]]> = [];
    for (let t = 0; t < T.length / 3; t++) {
        const pts: Array<[number, number]> = [];
        for (let k = 0; k < 3; k++) {
            const p = T[t * 3 + k] * 3, q = T[t * 3 + ((k + 1) % 3)] * 3;
            const py = P[p + 1], qy = P[q + 1];
            if ((py - y) * (qy - y) < 0) {
                const s = (y - py) / (qy - py);
                pts.push(toGridUW(P[p] + (P[q] - P[p]) * s, P[p + 2] + (P[q + 2] - P[p + 2]) * s, frame));
            }
        }
        if (pts.length === 2) segs.push([pts[0], pts[1]]);
    }
    return segs;
}

function pointSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(l2, 1e-12)));
    return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

export interface CornerSpec { name: string; u: number; w: number }

/**
 * Corner bevel: distance from the ideal plane-plane corner (u, w) to the nearest cross-section
 * segment, sampled at each height in `ys` (0 = razor-sharp corner).
 */
export function cornerBevel(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, corners: CornerSpec[], ys: number[], searchRadius = 4): Record<string, { meanM: number; maxM: number; n: number }> {
    const sections = ys.map(y => crossSection(P, T, y, frame));
    const out: Record<string, { meanM: number; maxM: number; n: number }> = {};
    for (const c of corners) {
        const cp: [number, number] = [c.u, c.w];
        const ds: number[] = [];
        for (const segs of sections) {
            let best = Infinity;
            for (const [a, b] of segs) {
                if (Math.hypot(a[0] - cp[0], a[1] - cp[1]) >= searchRadius && Math.hypot(b[0] - cp[0], b[1] - cp[1]) >= searchRadius) continue;
                best = Math.min(best, pointSegDist(cp, a, b));
            }
            if (best < Infinity) ds.push(best);
        }
        out[c.name] = {
            meanM: ds.length ? ds.reduce((s, v) => s + v, 0) / ds.length : NaN,
            maxM: ds.length ? Math.max(...ds) : NaN,
            n: ds.length
        };
    }
    return out;
}

/** A roof/terrace to measure: up-facing triangles near height `y` inside `below` but outside `above`. */
export interface RoofSpec { name: string; y: number; below: GridRect; above?: GridRect }

export interface RoofResult {
    nTris: number; areaM2: number; yMedian: number; yStdM: number; p95AbsDevM: number;
    /**
     * Median of a 0.5 m top-surface (max height) raster over the same ring, cells within 2 m of `y`: the slicing
     * method the survey oracle used. Independent of which triangles' centroids fall in the ring.
     */
    yDsmMedian: number | null; dsmCells: number;
}

/**
 * Roof height by triangles: up-facing triangles whose centroid lies in the ring between `below` and `above`.
 * With `selectP` (the same triangles at other positions, e.g. the input of an edit) the triangles are chosen
 * there and their heights read from P, so a before/after comparison measures the same triangles instead of
 * whichever ones a sub-centimetre slide carries across the ring's edge.
 */
export function roofFlatness(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, roofs: RoofSpec[], selectP?: ArrayLike<number>): Record<string, RoofResult | null> {
    const geo = triangleGeometry(selectP ?? P, T);
    const out: Record<string, RoofResult | null> = {};
    for (const r of roofs) {
        const ys: number[] = [], ws: number[] = [];
        let nTris = 0, area = 0;
        for (let t = 0; t < T.length / 3; t++) {
            if (!(geo.normals[t * 3 + 1] > 0.9) || Math.abs(geo.centroids[t * 3 + 1] - r.y) >= 2) continue;
            const [u, w] = toGridUW(geo.centroids[t * 3], geo.centroids[t * 3 + 2], frame);
            const b = r.below;
            if (!(u > b.u0 + 0.5 && u < b.u1 - 0.5 && w > b.w0 + 0.5 && w < b.w1 - 0.5)) continue;
            const a = r.above;
            if (a && u > a.u0 - 0.5 && u < a.u1 + 0.5 && w > a.w0 - 0.5 && w < a.w1 + 0.5) continue;
            nTris++; area += geo.areas[t];
            for (let k = 0; k < 3; k++) { ys.push(P[T[t * 3 + k] * 3 + 1]); ws.push(geo.areas[t] / 3); }
        }
        if (!nTris) { out[r.name] = null; continue; }
        const dsm = ringDsmMedian(P, T, frame, r);
        const med = median(ys);
        let W = 0, M = 0;
        for (let i = 0; i < ys.length; i++) { W += ws[i]; M += ys[i] * ws[i]; }
        M /= W;
        let V = 0;
        for (let i = 0; i < ys.length; i++) V += (ys[i] - M) ** 2 * ws[i];
        out[r.name] = { nTris, areaM2: area, yMedian: med, yStdM: Math.sqrt(V / W), p95AbsDevM: percentile(ys.map(y => Math.abs(y - med)), 95), yDsmMedian: dsm.median, dsmCells: dsm.cells };
    }
    return out;
}

/** Top-surface raster (0.5 m cells in the grid frame) over a roof's ring; median of cells within 2 m of the roof height. */
function ringDsmMedian(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, r: RoofSpec, cell = 0.5): { median: number | null; cells: number } {
    const b = r.below;
    const nu = Math.max(1, Math.ceil((b.u1 - b.u0) / cell)), nw = Math.max(1, Math.ceil((b.w1 - b.w0) / cell));
    const H = new Float64Array(nu * nw).fill(-Infinity);
    for (let t = 0; t < T.length / 3; t++) {
        const pu: number[] = [], pw: number[] = [], py: number[] = [];
        for (let k = 0; k < 3; k++) {
            const v = T[t * 3 + k];
            const [u, w] = toGridUW(P[v * 3], P[v * 3 + 2], frame);
            pu.push((u - b.u0) / cell); pw.push((w - b.w0) / cell); py.push(P[v * 3 + 1]);
        }
        if (Math.max(...py) < r.y - 2) continue;
        const i0 = Math.max(0, Math.floor(Math.min(...pu))), i1 = Math.min(nu - 1, Math.ceil(Math.max(...pu)));
        const j0 = Math.max(0, Math.floor(Math.min(...pw))), j1 = Math.min(nw - 1, Math.ceil(Math.max(...pw)));
        if (i1 < i0 || j1 < j0) continue;
        const det = (pu[1] - pu[0]) * (pw[2] - pw[0]) - (pw[1] - pw[0]) * (pu[2] - pu[0]);
        if (Math.abs(det) < 1e-12) continue;
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const x = i + 0.5, y = j + 0.5;
                const l0 = ((pu[1] - x) * (pw[2] - y) - (pw[1] - y) * (pu[2] - x)) / det;
                const l1 = ((pu[2] - x) * (pw[0] - y) - (pw[2] - y) * (pu[0] - x)) / det;
                const l2 = 1 - l0 - l1;
                if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                const h = l0 * py[0] + l1 * py[1] + l2 * py[2];
                if (h > H[i * nw + j]) H[i * nw + j] = h;
            }
        }
    }
    const vals: number[] = [];
    for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nw; j++) {
            const u = b.u0 + (i + 0.5) * cell, w = b.w0 + (j + 0.5) * cell;
            if (!(u > b.u0 + 0.5 && u < b.u1 - 0.5 && w > b.w0 + 0.5 && w < b.w1 - 0.5)) continue;
            const a = r.above;
            if (a && u > a.u0 - 0.5 && u < a.u1 + 0.5 && w > a.w0 - 0.5 && w < a.w1 + 0.5) continue;
            const h = H[i * nw + j];
            if (Number.isFinite(h) && Math.abs(h - r.y) < 2) vals.push(h);
        }
    }
    return { median: vals.length ? median(vals) : null, cells: vals.length };
}

/**
 * A relief band on a facade (a frontispiece, pier or pilaster) and the main wall beside it. Both
 * are selected among triangles facing `sign` along `axis` within `band` of `offset` and between
 * y0 and y1; `relief` and `main` are |lateral| windows on the other grid axis.
 */
export interface ReliefSpec {
    name: string;
    axis: 'u' | 'w';
    sign: 1 | -1;
    offset: number;
    band: number;
    y0: number;
    y1: number;
    relief: { lo: number; hi: number };
    main: { lo: number; hi: number };
}

export interface ReliefResult { reliefCoord: number; mainCoord: number; proudM: number; reliefAreaM2: number; mainAreaM2: number }

/** Area-weighted median facade coordinate of the relief and of the main wall; proud = outward gap. */
export function reliefProjection(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, reliefs: ReliefSpec[]): Record<string, ReliefResult | null> {
    const geo = triangleGeometry(P, T);
    const th = (frame.thetaDeg * Math.PI) / 180;
    const C = Math.cos(th), S = Math.sin(th);
    const out: Record<string, ReliefResult | null> = {};
    for (const r of reliefs) {
        const pick = (win: { lo: number; hi: number }): { coord: number; area: number } | null => {
            const items: Array<[number, number]> = [];
            for (let t = 0; t < T.length / 3; t++) {
                if (!(geo.areas[t] > 1e-6)) continue;
                const cx = geo.centroids[t * 3], cy = geo.centroids[t * 3 + 1], cz = geo.centroids[t * 3 + 2];
                if (!(cy > r.y0 && cy < r.y1)) continue;
                const nx = geo.normals[t * 3], nz = geo.normals[t * 3 + 2];
                const ncomp = r.axis === 'u' ? nx * C - nz * S : nx * S + nz * C;
                if (!(ncomp * r.sign > 0.9)) continue;
                const cu = cx * C - cz * S, cw = cx * S + cz * C;
                const coord = r.axis === 'u' ? cu : cw;
                const other = Math.abs(r.axis === 'u' ? cw : cu);
                if (Math.abs(coord - r.offset) >= r.band || !(other >= win.lo && other < win.hi)) continue;
                items.push([coord, geo.areas[t]]);
            }
            if (!items.length) return null;
            items.sort((a, b) => a[0] - b[0]);
            const total = items.reduce((acc, it) => acc + it[1], 0);
            let cum = 0;
            for (const [coord, area] of items) { cum += area; if (cum >= 0.5 * total) return { coord, area: total }; }
            return { coord: items[items.length - 1][0], area: total };
        };
        const rel = pick(r.relief), main = pick(r.main);
        out[r.name] = rel && main ? { reliefCoord: rel.coord, mainCoord: main.coord, proudM: r.sign * (rel.coord - main.coord), reliefAreaM2: rel.area, mainAreaM2: main.area } : null;
    }
    return out;
}

/**
 * A facade face scanned for relief ridges: the plane `axis = offset` facing `sign`, `lateral` is the
 * signed span along the other grid axis, y0..y1 the height span.
 */
export interface ReliefScanSpec {
    name: string;
    axis: 'u' | 'w';
    sign: 1 | -1;
    offset: number;
    lateral: { lo: number; hi: number };
    y0: number;
    y1: number;
    /**
     * The wall's own extent along the lateral axis (its two corners). Ridges within `cornerMarginM` of a corner
     * are reported but not gated: corner bevels are removed on purpose (and gated on their own), which moves
     * whatever a column profile next to the corner shows.
     */
    span?: { lo: number; hi: number };
}

export interface ReliefRidge {
    face: string;
    /** Bottom of the 15 m height band the ridge was found in. */
    bandY0: number;
    /** Lateral extent (signed coordinate on the face's other axis). */
    s0: number;
    s1: number;
    widthM: number;
    /** Median height above the 1-3 m ring baseline, before and after. */
    proudInM: number;
    proudOutM: number;
    /** Median height above the face's main plane in the band (median of every column), before and after. */
    proudMainInM: number;
    proudMainOutM: number;
    /** Share of the ridge's pixels whose input triangle is within 3.5 degrees of the face normal. */
    parallelFrac: number;
    /** The same share over its ring baseline (1-3 m to either side): high when the ridge is a step between two
     * parallel sheets, low when its neighbours are tilted crinkle that makes it look proud. */
    ringParallelFrac: number;
    /** Within cornerMarginM of a corner of the wall (spec.span). */
    nearCorner: boolean;
}

export interface ReliefRidgeStats {
    ridges: ReliefRidge[];
    /** Ridges made of faces parallel to the wall (>= 80% of pixels), ring-relative (a ridge may only look proud
     * because the crinkle next to it dips): counts for information. */
    crisp: number;
    crispFlattened: number;
    crispReduced: number;
    all: number;
    allFlattened: number;
    /**
     * Piers: crisp ridges standing >= 0.1 m proud of the wall's main plane (the band's median column height) in
     * the BEFORE geometry, away from the corners; `piersFlattened` of them stand less than 0.1 m proud of the
     * main plane AFTER. This is the plan's "piers still stand at least 0.1 m proud of the main plane".
     */
    piers: number;
    piersFlattened: number;
    /**
     * Projections: runs of columns 3-15 m wide standing >= 0.1 m proud of the band's main level in the BEFORE geometry
     * (a frontispiece, a bay window, a projecting wing face), mostly made of faces parallel to the wall, away from the
     * corners; `projectionsFlattened` of them end less than 0.1 m proud.
     */
    projections: ReliefRidge[];
    projectionsFlattened: number;
}

/**
 * Orthographic height map of the nearest surface in front of a facade plane (both faces rasterised):
 * height above the plane along the face normal, `res` metres per pixel, NaN where nothing is hit.
 */
function facadeHeightMap(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, f: ReliefScanSpec, res: number): { W: number; H: number; h: Float64Array; ids: Int32Array } {
    const th = (frame.thetaDeg * Math.PI) / 180;
    const C = Math.cos(th), S = Math.sin(th);
    const eu: [number, number, number] = [C, 0, -S], ew: [number, number, number] = [S, 0, C];
    const nAxis = f.axis === 'u' ? eu : ew, tAxis = f.axis === 'u' ? ew : eu;
    const n: [number, number, number] = [nAxis[0] * f.sign, nAxis[1] * f.sign, nAxis[2] * f.sign];
    const standoff = 4;
    const sMid = 0.5 * (f.lateral.lo + f.lateral.hi), yMid = 0.5 * (f.y0 + f.y1);
    const center: [number, number, number] = [
        nAxis[0] * f.offset + tAxis[0] * sMid + n[0] * standoff,
        yMid,
        nAxis[2] * f.offset + tAxis[2] * sMid + n[2] * standoff
    ];
    const W = Math.max(1, Math.round((f.lateral.hi - f.lateral.lo) / res));
    const H = Math.max(1, Math.round((f.y1 - f.y0) / res));
    const view: OrthoView = { kind: 'ortho', name: f.name, center, dir: [-n[0], -n[1], -n[2]], up: [0, 1, 0], halfExtent: 0.5 * W * res };
    // an orthographic raster has no near plane: keep only triangles behind the camera plane (and not far
    // behind the facade), within the face window grown by 1 m
    const nTri = T.length / 3;
    const sel: number[] = [];
    for (let t = 0; t < nTri; t++) {
        let ok = true;
        for (let k = 0; k < 3 && ok; k++) {
            const v = T[t * 3 + k];
            const hgt = (P[v * 3] * n[0] + P[v * 3 + 2] * n[2]) - f.offset * f.sign;
            if (hgt > standoff - 0.5 || hgt < -20) ok = false;
        }
        if (!ok) continue;
        let sLo = Infinity, sHi = -Infinity, yLo = Infinity, yHi = -Infinity;
        for (let k = 0; k < 3; k++) {
            const v = T[t * 3 + k];
            const sv = P[v * 3] * tAxis[0] + P[v * 3 + 2] * tAxis[2];
            sLo = Math.min(sLo, sv); sHi = Math.max(sHi, sv);
            yLo = Math.min(yLo, P[v * 3 + 1]); yHi = Math.max(yHi, P[v * 3 + 1]);
        }
        if (sHi < f.lateral.lo - 1 || sLo > f.lateral.hi + 1 || yHi < f.y0 - 1 || yLo > f.y1 + 1) continue;
        sel.push(t);
    }
    const Tsel = new Uint32Array(sel.length * 3);
    for (let i = 0; i < sel.length; i++) for (let k = 0; k < 3; k++) Tsel[i * 3 + k] = T[sel[i] * 3 + k];
    const r0 = rasterizeIdBuffer(P, Tsel, view, W, H);
    const depth = r0.depth;
    const ids = new Int32Array(r0.ids.length);
    for (let i = 0; i < ids.length; i++) ids[i] = r0.ids[i] < 0 ? -1 : sel[r0.ids[i]];
    const h = new Float64Array(W * H);
    for (let i = 0; i < h.length; i++) h[i] = Number.isFinite(depth[i]) ? standoff - depth[i] : NaN;
    // the image's +x runs along r = dir x up; flip columns so column 0 is at lateral.lo when needed
    const r = cross3([-n[0], -n[1], -n[2]], [0, 1, 0]);
    const along = r[0] * tAxis[0] + r[1] * tAxis[1] + r[2] * tAxis[2];
    if (along < 0) {
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W >> 1; x++) {
                const a = y * W + x, b = y * W + (W - 1 - x);
                const th2 = h[a]; h[a] = h[b]; h[b] = th2;
                const ti = ids[a]; ids[a] = ids[b]; ids[b] = ti;
            }
        }
    }
    return { W, H, h, ids };
}

function nanMedian(values: number[]): number {
    const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

/**
 * Relief ridges of facade faces (pilasters, piers, strips) found in the BEFORE geometry and re-measured
 * in the AFTER geometry at the same place. Height maps at `res` (0.1 m) per face; in every 15 m height
 * band (10 m steps) each column's median height is compared with a ring baseline (median of the column
 * medians 1-3 m to either side). A ridge is a run of columns 0.3-2.5 m wide standing >= 0.10 m proud with
 * >= 70% of its rows at least 0.06 m proud. Independent of how the edit was made: it reads only the two
 * position sets over the same triangles.
 */
export function facadeReliefRidges(P0: ArrayLike<number>, P1: ArrayLike<number>, T: Uint32Array, frame: GridFrame, faces: ReliefScanSpec[], res = 0.1, cornerMarginM = 2): ReliefRidgeStats {
    const ridges: ReliefRidge[] = [];
    const projections: ReliefRidge[] = [];
    const geo0 = triangleGeometry(P0, T);
    const th = (frame.thetaDeg * Math.PI) / 180;
    const C = Math.cos(th), S = Math.sin(th);
    const inner = Math.round(1 / res), outer = Math.round(3 / res);
    for (const f of faces) {
        const a = facadeHeightMap(P0, T, frame, f, res), b = facadeHeightMap(P1, T, frame, f, res);
        const { W, H } = a;
        const nu = f.axis === 'u' ? [C, 0, -S] : [S, 0, C];
        const cosPar = Math.cos((3.5 * Math.PI) / 180);
        const clean = (v: number): number => (Number.isFinite(v) && v >= -1 ? v : NaN);
        for (let ys = f.y0; ys < f.y1 - 10; ys += 10) {
            // rows whose centre height lies in [ys, ys + 15) (row 0 is the top, y1)
            let r0 = H, r1 = 0;
            for (let y = 0; y < H; y++) {
                const yv = f.y1 - (y + 0.5) * res;
                if (yv >= ys && yv < ys + 15) { r0 = Math.min(r0, y); r1 = Math.max(r1, y + 1); }
            }
            if (r1 <= r0) continue;
            const colMed = (m: Float64Array): Float64Array => {
                const out = new Float64Array(W);
                for (let x = 0; x < W; x++) {
                    const col: number[] = [];
                    for (let y = r0; y < r1; y++) col.push(clean(m[y * W + x]));
                    out[x] = nanMedian(col);
                }
                return out;
            };
            const ma = colMed(a.h), mb = colMed(b.h);
            const ring = (m: Float64Array): Float64Array => {
                const out = new Float64Array(W).fill(NaN);
                for (let x = 0; x < W; x++) {
                    const v: number[] = [];
                    for (let k = Math.max(0, x - outer); k < Math.max(0, x - inner); k++) v.push(m[k]);
                    for (let k = x + inner + 1; k < Math.min(W, x + outer + 1); k++) v.push(m[k]);
                    const fin = v.filter(Number.isFinite);
                    if (fin.length >= 20) out[x] = nanMedian(fin);
                }
                return out;
            };
            const ba = ring(ma), bb = ring(mb);
            const mainA = nanMedian(Array.from(ma)), mainB = nanMedian(Array.from(mb));
            const ridgeCol = new Uint8Array(W);
            for (let x = 0; x < W; x++) {
                let valid = 0, cov = 0;
                for (let y = r0; y < r1; y++) {
                    const v = clean(a.h[y * W + x]);
                    if (!Number.isFinite(v)) continue;
                    valid++;
                    if (v - ba[x] >= 0.06) cov++;
                }
                const rows = r1 - r0;
                ridgeCol[x] = rows > 0 && valid / rows > 0.9 && Number.isFinite(ba[x]) && ma[x] - ba[x] >= 0.1 && cov / rows >= 0.7 ? 1 : 0;
            }
            // projections: wide runs proud of the main level (not of a ring, which would sit on the projection itself)
            const projCol = new Uint8Array(W);
            for (let x = 0; x < W; x++) projCol[x] = Number.isFinite(ma[x]) && ma[x] - mainA >= 0.1 ? 1 : 0;
            for (let x = 0; x < W;) {
                if (!projCol[x]) { x++; continue; }
                let e = x;
                while (e < W && projCol[e]) e++;
                const width = (e - x) * res;
                if (width >= 3 && width <= 15) {
                    const qin: number[] = [], qout: number[] = [];
                    for (let k = x; k < e; k++) { qin.push(ma[k] - mainA); qout.push(mb[k] - mainB); }
                    let par = 0, tot = 0;
                    for (let k = x; k < e; k++) for (let y = r0; y < r1; y++) {
                        const id = a.ids[y * W + k];
                        if (id < 0) continue;
                        tot++;
                        if ((geo0.normals[id * 3] * nu[0] + geo0.normals[id * 3 + 2] * nu[2]) * f.sign >= cosPar) par++;
                    }
                    const s0 = f.lateral.lo + x * res, s1 = f.lateral.lo + e * res;
                    projections.push({
                        face: f.name, bandY0: ys, s0, s1, widthM: width,
                        nearCorner: !!f.span && (s0 < f.span.lo + cornerMarginM || s1 > f.span.hi - cornerMarginM),
                        proudInM: NaN, proudOutM: NaN, proudMainInM: nanMedian(qin), proudMainOutM: nanMedian(qout),
                        parallelFrac: tot ? par / tot : 0, ringParallelFrac: NaN
                    });
                }
                x = e;
            }
            for (let x = 0; x < W;) {
                if (!ridgeCol[x]) { x++; continue; }
                let e = x;
                while (e < W && ridgeCol[e]) e++;
                const width = (e - x) * res;
                if (width >= 0.3 && width <= 2.5) {
                    const pin: number[] = [], pout: number[] = [], qin: number[] = [], qout: number[] = [];
                    const parallelShare = (c0: number, c1: number): number => {
                        let par = 0, tot = 0;
                        for (let k = Math.max(0, c0); k < Math.min(W, c1); k++) {
                            for (let y = r0; y < r1; y++) {
                                const id = a.ids[y * W + k];
                                if (id < 0) continue;
                                tot++;
                                const d = (geo0.normals[id * 3] * nu[0] + geo0.normals[id * 3 + 2] * nu[2]) * f.sign;
                                if (d >= cosPar) par++;
                            }
                        }
                        return tot ? par / tot : 0;
                    };
                    for (let k = x; k < e; k++) { pin.push(ma[k] - ba[k]); pout.push(mb[k] - bb[k]); qin.push(ma[k] - mainA); qout.push(mb[k] - mainB); }
                    const ringL = parallelShare(x - outer, x - inner), ringR = parallelShare(e + inner, e + outer);
                    const s0 = f.lateral.lo + x * res, s1 = f.lateral.lo + e * res;
                    const nearCorner = !!f.span && (s0 < f.span.lo + cornerMarginM || s1 > f.span.hi - cornerMarginM);
                    ridges.push({
                        face: f.name, bandY0: ys, s0, s1, widthM: width, nearCorner,
                        proudInM: nanMedian(pin), proudOutM: nanMedian(pout), proudMainInM: nanMedian(qin), proudMainOutM: nanMedian(qout),
                        parallelFrac: parallelShare(x, e),
                        ringParallelFrac: 0.5 * (ringL + ringR)
                    });
                }
                x = e;
            }
        }
    }
    const crisp = ridges.filter(r => r.parallelFrac >= 0.8);
    const flat = (r: ReliefRidge): boolean => !(r.proudOutM >= 0.1);
    const piers = crisp.filter(r => r.proudMainInM >= 0.1 && !r.nearCorner);
    return {
        ridges,
        crisp: crisp.length,
        crispFlattened: crisp.filter(flat).length,
        crispReduced: crisp.filter(r => !flat(r) && r.proudOutM < 0.6 * r.proudInM).length,
        all: ridges.length,
        allFlattened: ridges.filter(flat).length,
        piers: piers.length,
        piersFlattened: piers.filter(r => !(r.proudMainOutM >= 0.1)).length,
        projections: projections.filter(p => p.parallelFrac >= 0.6 && !p.nearCorner),
        projectionsFlattened: projections.filter(p => p.parallelFrac >= 0.6 && !p.nearCorner && !(p.proudMainOutM >= 0.1)).length
    };
}

// ---------------------------------------------------------------------------
// Displacement, flips and degenerates
// ---------------------------------------------------------------------------

export interface DisplacementStats {
    vertexCount: number;
    /** Fraction of vertices whose position is bit-for-bit unchanged. */
    untouchedFrac: number;
    /** Fraction moved more than 1 cm. */
    movedFrac: number;
    /** Fraction moved at most 1 cm (1 - movedFrac). */
    withinCentimetreFrac: number;
    meanM: number;
    p95M: number;
    maxM: number;
    meanMovedM: number;
    triAreaChangeMean: number;
    /** Triangles whose normal reversed (dot < 0). */
    flippedTris: number;
    /** Triangles whose normal turned more than ~78 degrees (dot < 0.2). */
    turnedTris: number;
    /** Triangles that went from area > 1e-6 to below 1e-6 m^2. */
    newDegenerateTris: number;
    /** Triangles that went from area >= 1e-4 to below 1e-4 m^2 (slivers). */
    newSliverTris: number;
    /** Triangles below 1e-4 m^2 after the edit (any origin). */
    sliverTrisAfter: number;
}

/**
 * Per-vertex displacement between two position sets with identical vertex order, plus
 * per-triangle flip/degeneracy checks over `T` (the triangles that are actually kept).
 * `vertexMask` limits the displacement statistics to a subset of vertices.
 */
export function displacementStats(P0: ArrayLike<number>, P1: ArrayLike<number>, T: Uint32Array, vertexMask?: ArrayLike<number>): DisplacementStats {
    if (P0.length !== P1.length) throw new Error('displacementStats: vertex counts differ');
    const V = P0.length / 3;
    const d: number[] = [];
    let untouched = 0;
    for (let v = 0; v < V; v++) {
        if (vertexMask && !vertexMask[v]) continue;
        const dx = P1[v * 3] - P0[v * 3], dy = P1[v * 3 + 1] - P0[v * 3 + 1], dz = P1[v * 3 + 2] - P0[v * 3 + 2];
        if (dx === 0 && dy === 0 && dz === 0) untouched++;
        d.push(Math.hypot(dx, dy, dz));
    }
    const g0 = triangleGeometry(P0, T), g1 = triangleGeometry(P1, T);
    let flipped = 0, turned = 0, newDeg = 0, newSliver = 0, sliverAfter = 0, wsum = 0, csum = 0;
    for (let t = 0; t < g0.areas.length; t++) {
        const a0 = g0.areas[t], a1 = g1.areas[t];
        if (a1 < 1e-4) sliverAfter++;
        if (a0 >= 1e-4 && a1 < 1e-4) newSliver++;
        if (!(a0 > 1e-6)) continue;
        const dot = g0.normals[t * 3] * g1.normals[t * 3] + g0.normals[t * 3 + 1] * g1.normals[t * 3 + 1] + g0.normals[t * 3 + 2] * g1.normals[t * 3 + 2];
        if (dot < 0) flipped++;
        if (dot < 0.2 && a1 > 1e-6) turned++;
        if (a1 < 1e-6) newDeg++;
        wsum += a0; csum += Math.abs(a1 / a0 - 1) * a0;
    }
    const moved = d.filter(x => x > 0.01);
    const n = d.length;
    return {
        vertexCount: n,
        untouchedFrac: n ? untouched / n : NaN,
        movedFrac: n ? moved.length / n : NaN,
        withinCentimetreFrac: n ? 1 - moved.length / n : NaN,
        meanM: n ? d.reduce((s, x) => s + x, 0) / n : NaN,
        p95M: percentile(d, 95),
        maxM: n ? d.reduce((m, x) => Math.max(m, x), 0) : NaN,
        meanMovedM: moved.length ? moved.reduce((s, x) => s + x, 0) / moved.length : 0,
        triAreaChangeMean: wsum > 0 ? csum / wsum : 0,
        flippedTris: flipped,
        turnedTris: turned,
        newDegenerateTris: newDeg,
        newSliverTris: newSliver,
        sliverTrisAfter: sliverAfter
    };
}

/** Marks the vertices referenced by `T`. */
export function referencedVertexMask(vertexCount: number, T: Uint32Array): Uint8Array {
    const m = new Uint8Array(vertexCount);
    for (let i = 0; i < T.length; i++) m[T[i]] = 1;
    return m;
}

// ---------------------------------------------------------------------------
// Crease lengths
// ---------------------------------------------------------------------------

export interface CreaseLengths {
    /** Total welded-edge length with a dihedral angle in [spuriousMinDeg, realMinDeg). */
    spuriousM: number;
    /** Total welded-edge length with a dihedral angle >= realMinDeg. */
    realM: number;
    /** Same, restricted to edges whose two faces are both facades (|ny| < 0.3). */
    facadeSpuriousM: number;
    facadeRealM: number;
    /** Welded-edge length with a dihedral angle >= 80 degrees (right-angle structural corners). */
    rightAngleM: number;
    /**
     * >= realMinDeg crease length on edges whose two faces are both at least `sliverWidthM` wide
     * across the edge (altitude over it); folds along slivers and bevel strips are excluded.
     */
    realNonSliverM: number;
    manifoldEdges: number;
}

/**
 * Crease lengths over welded edges shared by exactly two non-degenerate triangles. The dihedral
 * angle is the angle between the two face normals (0 = coplanar). With `triangleMask`, only edges
 * whose two faces are both inside the mask count.
 */
export function creaseLengths(
    P: ArrayLike<number>, T: Uint32Array, spuriousMinDeg = 15, realMinDeg = 45, weldTol = 1e-3, triangleMask?: ArrayLike<number>, sliverWidthM = 1.0
): CreaseLengths {
    const { ids, count } = weldIds(P, weldTol);
    const geo = triangleGeometry(P, T);
    const n = T.length / 3;
    const first = new Map<number, number>();
    const second = new Map<number, number>();
    const many = new Set<number>();
    const endpoints = new Map<number, [number, number]>();
    for (let t = 0; t < n; t++) {
        if (!(geo.areas[t] > 1e-9)) continue;
        if (triangleMask && !triangleMask[t]) continue;
        for (let k = 0; k < 3; k++) {
            const va = T[t * 3 + k], vb = T[t * 3 + ((k + 1) % 3)];
            let a = ids[va], b = ids[vb];
            if (a === b) continue;
            if (a > b) { const s = a; a = b; b = s; }
            const key = a * count + b;
            if (!first.has(key)) { first.set(key, t); endpoints.set(key, [va, vb]); }
            else if (!second.has(key)) second.set(key, t);
            else many.add(key);
        }
    }
    const cosSp = Math.cos((spuriousMinDeg * Math.PI) / 180), cosReal = Math.cos((realMinDeg * Math.PI) / 180);
    const cosRight = Math.cos((80 * Math.PI) / 180);
    let spurious = 0, real = 0, fSp = 0, fReal = 0, right = 0, realWide = 0, manifold = 0;
    for (const [key, t2] of second) {
        if (many.has(key)) continue;
        manifold++;
        const t1 = first.get(key)!;
        const dot = geo.normals[t1 * 3] * geo.normals[t2 * 3] + geo.normals[t1 * 3 + 1] * geo.normals[t2 * 3 + 1] + geo.normals[t1 * 3 + 2] * geo.normals[t2 * 3 + 2];
        if (dot > cosSp) continue;
        const [va, vb] = endpoints.get(key)!;
        const len = Math.hypot(P[vb * 3] - P[va * 3], P[vb * 3 + 1] - P[va * 3 + 1], P[vb * 3 + 2] - P[va * 3 + 2]);
        const facade = Math.abs(geo.normals[t1 * 3 + 1]) < 0.3 && Math.abs(geo.normals[t2 * 3 + 1]) < 0.3;
        if (dot <= cosReal) {
            real += len;
            if (facade) fReal += len;
            if (dot <= cosRight) right += len;
            const wide = len > 0 && (2 * geo.areas[t1]) / len >= sliverWidthM && (2 * geo.areas[t2]) / len >= sliverWidthM;
            if (wide) realWide += len;
        } else { spurious += len; if (facade) fSp += len; }
    }
    return { spuriousM: spurious, realM: real, facadeSpuriousM: fSp, facadeRealM: fReal, rightAngleM: right, realNonSliverM: realWide, manifoldEdges: manifold };
}

// ---------------------------------------------------------------------------
// Position-stream identity
// ---------------------------------------------------------------------------

export interface PositionDigest {
    sha256: string;
    uniquePositions: number;
    referencedVertices: number;
}

/**
 * sha256 over the sorted set of distinct float32 positions referenced by `T` (all vertices when
 * `T` is omitted). Invariant to vertex order, duplication and splitting; -0 is folded into +0.
 */
export function dedupPositionDigest(P: ArrayLike<number>, T?: Uint32Array): PositionDigest {
    const V = P.length / 3;
    const used = T ? referencedVertexMask(V, T) : new Uint8Array(V).fill(1);
    const f = new Float32Array(3);
    const bits = new Uint32Array(f.buffer);
    const keys: Array<[number, number, number]> = [];
    let referenced = 0;
    for (let v = 0; v < V; v++) {
        if (!used[v]) continue;
        referenced++;
        f[0] = P[v * 3] || 0; f[1] = P[v * 3 + 1] || 0; f[2] = P[v * 3 + 2] || 0;
        keys.push([bits[0], bits[1], bits[2]]);
    }
    keys.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const out: number[] = [];
    for (let i = 0; i < keys.length; i++) {
        if (i > 0 && keys[i][0] === keys[i - 1][0] && keys[i][1] === keys[i - 1][1] && keys[i][2] === keys[i - 1][2]) continue;
        out.push(keys[i][0], keys[i][1], keys[i][2]);
    }
    const buf = Buffer.alloc(out.length * 4);
    for (let i = 0; i < out.length; i++) buf.writeUInt32LE(out[i], i * 4);
    return { sha256: createHash('sha256').update(buf).digest('hex'), uniquePositions: out.length / 3, referencedVertices: referenced };
}

// ---------------------------------------------------------------------------
// Silhouette rasterisation (coverage masks, no shading)
// ---------------------------------------------------------------------------

export interface OrthoView {
    kind: 'ortho';
    name: string;
    center: [number, number, number];
    /** Viewing direction (from camera into the scene). */
    dir: [number, number, number];
    up: [number, number, number];
    halfExtent: number;
}

export interface PerspectiveView {
    kind: 'perspective';
    name: string;
    eye: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fovYDeg: number;
    near?: number;
}

export type SilhouetteView = OrthoView | PerspectiveView;

function norm3(v: number[]): [number, number, number] {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a: number[], b: number[]): [number, number, number] {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function fillTriangle(mask: Uint8Array, W: number, H: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void {
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!(Math.abs(area) > 1e-12)) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    const s = area > 0 ? 1 : -1;
    for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            const e0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * s;
            if (e0 < 0) continue;
            const e1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * s;
            if (e1 < 0) continue;
            const e2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * s;
            if (e2 < 0) continue;
            mask[y * W + x] = 1;
        }
    }
}

/** Rasterises triangle coverage (both faces) into a W x H mask. */
export function rasterizeSilhouette(P: ArrayLike<number>, T: Uint32Array, view: SilhouetteView, W: number, H: number): Uint8Array {
    const mask = new Uint8Array(W * H);
    if (view.kind === 'ortho') {
        const f = norm3(view.dir);
        const r = norm3(cross3(f, view.up));
        const u = cross3(r, f);
        const sc = W / (2 * view.halfExtent);
        const proj = (v: number): [number, number] => {
            const dx = P[v * 3] - view.center[0], dy = P[v * 3 + 1] - view.center[1], dz = P[v * 3 + 2] - view.center[2];
            return [(dx * r[0] + dy * r[1] + dz * r[2] + view.halfExtent) * sc, (view.halfExtent * (H / W) - (dx * u[0] + dy * u[1] + dz * u[2])) * sc];
        };
        for (let t = 0; t < T.length / 3; t++) {
            const a = proj(T[t * 3]), b = proj(T[t * 3 + 1]), c = proj(T[t * 3 + 2]);
            fillTriangle(mask, W, H, a[0], a[1], b[0], b[1], c[0], c[1]);
        }
        return mask;
    }
    const f = norm3([view.target[0] - view.eye[0], view.target[1] - view.eye[1], view.target[2] - view.eye[2]]);
    const r = norm3(cross3(f, view.up));
    const u = cross3(r, f);
    const near = view.near ?? 0.05;
    const fpx = (H / 2) / Math.tan(((view.fovYDeg * Math.PI) / 180) / 2);
    const cam = (v: number): [number, number, number] => {
        const dx = P[v * 3] - view.eye[0], dy = P[v * 3 + 1] - view.eye[1], dz = P[v * 3 + 2] - view.eye[2];
        return [dx * r[0] + dy * r[1] + dz * r[2], dx * u[0] + dy * u[1] + dz * u[2], dx * f[0] + dy * f[1] + dz * f[2]];
    };
    const screen = (p: [number, number, number]): [number, number] => [W / 2 + (p[0] / p[2]) * fpx, H / 2 - (p[1] / p[2]) * fpx];
    for (let t = 0; t < T.length / 3; t++) {
        const tri = [cam(T[t * 3]), cam(T[t * 3 + 1]), cam(T[t * 3 + 2])];
        if (tri[0][2] < near && tri[1][2] < near && tri[2][2] < near) continue;
        // Clip against the near plane (Sutherland-Hodgman, one plane).
        const poly: Array<[number, number, number]> = [];
        for (let k = 0; k < 3; k++) {
            const p = tri[k], q = tri[(k + 1) % 3];
            const pin = p[2] >= near, qin = q[2] >= near;
            if (pin) poly.push(p);
            if (pin !== qin) {
                const s = (near - p[2]) / (q[2] - p[2]);
                poly.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, near]);
            }
        }
        if (poly.length < 3) continue;
        const pts = poly.map(screen);
        for (let k = 1; k + 1 < pts.length; k++) fillTriangle(mask, W, H, pts[0][0], pts[0][1], pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
    }
    return mask;
}

/** Intersection-over-union of two coverage masks. */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) uni++; }
    return uni ? inter / uni : 1;
}

/** Fraction of pixels covered in `before` but empty in `after` ("new sky"). */
export function lostCoverageFraction(before: Uint8Array, after: Uint8Array): number {
    let lost = 0;
    for (let i = 0; i < before.length; i++) if (before[i] && !after[i]) lost++;
    return lost / before.length;
}

function bounds(P: ArrayLike<number>, T?: Uint32Array): { min: number[]; max: number[] } {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const visit = (v: number): void => {
        for (let k = 0; k < 3; k++) { const x = P[v * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
    };
    if (T) for (let i = 0; i < T.length; i++) visit(T[i]);
    else for (let v = 0; v < P.length / 3; v++) visit(v);
    return { min, max };
}

/** Six orthographic views framing the given geometry: four sides, top and an oblique. */
export function standardOrthoViews(P: ArrayLike<number>, T?: Uint32Array): OrthoView[] {
    const b = bounds(P, T);
    const center: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const half = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 1.02;
    const mk = (name: string, dir: [number, number, number], up: [number, number, number]): OrthoView => ({ kind: 'ortho', name, center, dir, up, halfExtent: half });
    return [
        mk('side +x', [-1, 0, 0], [0, 1, 0]),
        mk('side -x', [1, 0, 0], [0, 1, 0]),
        mk('side +z', [0, 0, -1], [0, 1, 0]),
        mk('side -z', [0, 0, 1], [0, 1, 0]),
        mk('top', [0, -1, 0], [0, 0, -1]),
        mk('oblique', [-1, -1, -1], [0, 1, 0])
    ];
}

/**
 * Z-buffered triangle-id raster (both faces): each pixel holds the index of the nearest triangle
 * (or -1) and its depth along the view direction (perspective depth interpolated as 1/z).
 */
export function rasterizeIdBuffer(P: ArrayLike<number>, T: Uint32Array, view: SilhouetteView, W: number, H: number): { ids: Int32Array; depth: Float64Array } {
    const ids = new Int32Array(W * H).fill(-1);
    const best = new Float64Array(W * H).fill(-Infinity); // larger = closer
    const fill = (id: number, x: number[], y: number[], key: number[]): void => {
        const area = (x[1] - x[0]) * (y[2] - y[0]) - (y[1] - y[0]) * (x[2] - x[0]);
        if (!(Math.abs(area) > 1e-12)) return;
        const x0 = Math.max(0, Math.floor(Math.min(x[0], x[1], x[2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(x[0], x[1], x[2])));
        const y0 = Math.max(0, Math.floor(Math.min(y[0], y[1], y[2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(y[0], y[1], y[2])));
        for (let py = y0; py <= y1; py++) {
            const cy = py + 0.5;
            for (let px = x0; px <= x1; px++) {
                const cx = px + 0.5;
                const w0 = ((x[1] - cx) * (y[2] - cy) - (y[1] - cy) * (x[2] - cx)) / area;
                const w1 = ((x[2] - cx) * (y[0] - cy) - (y[2] - cy) * (x[0] - cx)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const k = w0 * key[0] + w1 * key[1] + w2 * key[2];
                const i = py * W + px;
                if (k > best[i]) { best[i] = k; ids[i] = id; }
            }
        }
    };
    if (view.kind === 'ortho') {
        const f = norm3(view.dir), r = norm3(cross3(f, view.up)), u = cross3(r, f);
        const sc = W / (2 * view.halfExtent);
        for (let t = 0; t < T.length / 3; t++) {
            const xs: number[] = [], ys: number[] = [], ks: number[] = [];
            for (let k = 0; k < 3; k++) {
                const v = T[t * 3 + k];
                const dx = P[v * 3] - view.center[0], dy = P[v * 3 + 1] - view.center[1], dz = P[v * 3 + 2] - view.center[2];
                xs.push((dx * r[0] + dy * r[1] + dz * r[2] + view.halfExtent) * sc);
                ys.push((view.halfExtent * (H / W) - (dx * u[0] + dy * u[1] + dz * u[2])) * sc);
                ks.push(-(dx * f[0] + dy * f[1] + dz * f[2]));
            }
            fill(t, xs, ys, ks);
        }
        return { ids, depth: best.map(k => (k === -Infinity ? Infinity : -k)) };
    }
    const f = norm3([view.target[0] - view.eye[0], view.target[1] - view.eye[1], view.target[2] - view.eye[2]]);
    const r = norm3(cross3(f, view.up)), u = cross3(r, f);
    const near = view.near ?? 0.05;
    const fpx = (H / 2) / Math.tan(((view.fovYDeg * Math.PI) / 180) / 2);
    for (let t = 0; t < T.length / 3; t++) {
        const tri: Array<[number, number, number]> = [];
        for (let k = 0; k < 3; k++) {
            const v = T[t * 3 + k];
            const dx = P[v * 3] - view.eye[0], dy = P[v * 3 + 1] - view.eye[1], dz = P[v * 3 + 2] - view.eye[2];
            tri.push([dx * r[0] + dy * r[1] + dz * r[2], dx * u[0] + dy * u[1] + dz * u[2], dx * f[0] + dy * f[1] + dz * f[2]]);
        }
        if (tri[0][2] < near && tri[1][2] < near && tri[2][2] < near) continue;
        const poly: Array<[number, number, number]> = [];
        for (let k = 0; k < 3; k++) {
            const p = tri[k], q = tri[(k + 1) % 3];
            const pin = p[2] >= near, qin = q[2] >= near;
            if (pin) poly.push(p);
            if (pin !== qin) {
                const s = (near - p[2]) / (q[2] - p[2]);
                poly.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, near]);
            }
        }
        if (poly.length < 3) continue;
        const sx = poly.map(p => W / 2 + (p[0] / p[2]) * fpx), sy = poly.map(p => H / 2 - (p[1] / p[2]) * fpx), iz = poly.map(p => 1 / p[2]);
        for (let k = 1; k + 1 < poly.length; k++) fill(t, [sx[0], sx[k], sx[k + 1]], [sy[0], sy[k], sy[k + 1]], [iz[0], iz[k], iz[k + 1]]);
    }
    return { ids, depth: best.map(k => (k === -Infinity ? Infinity : 1 / k)) };
}

/** Perspective views orbiting the geometry's bounds at several elevations (aerial survey ring). */
export function standardAerialViews(P: ArrayLike<number>, T?: Uint32Array, options: { elevationsDeg?: number[]; azimuthCount?: number; fovYDeg?: number; distanceScale?: number } = {}): PerspectiveView[] {
    const b = bounds(P, T);
    const c: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const radius = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const fov = options.fovYDeg ?? 40;
    const dist = (options.distanceScale ?? 1) * radius / Math.sin(((fov * Math.PI) / 180) / 2);
    const out: PerspectiveView[] = [];
    const n = options.azimuthCount ?? 8;
    for (const el of options.elevationsDeg ?? [25, 45, 70]) {
        for (let k = 0; k < n; k++) {
            const az = (2 * Math.PI * k) / n, e = (el * Math.PI) / 180;
            out.push({
                kind: 'perspective', name: `aerial el${el} az${Math.round((az * 180) / Math.PI)}`,
                eye: [c[0] + dist * Math.cos(e) * Math.cos(az), c[1] + dist * Math.sin(e), c[2] + dist * Math.cos(e) * Math.sin(az)],
                target: c, up: [0, 1, 0], fovYDeg: fov, near: 0.5
            });
        }
    }
    return out;
}

/**
 * Fraction of pixels whose nearest input triangle was removed and whose new nearest surface (input
 * positions, kept triangles only) lies farther back than `max(depthTolM, depthTolRel * depth)`, or
 * is missing. Coincident duplicate layers (a culled copy directly on a kept one) do not count.
 */
export function revealedPixelFraction(
    P: ArrayLike<number>, T: Uint32Array, triangleKept: Uint8Array, view: SilhouetteView, W: number, H: number,
    depthTolM = 0.1, depthTolRel = 0.002
): number {
    const before = rasterizeIdBuffer(P, T, view, W, H);
    const after = rasterizeIdBuffer(P, selectTriangles(T, triangleKept), view, W, H);
    let revealed = 0;
    for (let i = 0; i < before.ids.length; i++) {
        const id = before.ids[i];
        if (id < 0 || triangleKept[id]) continue;
        const d0 = before.depth[i];
        if (after.depth[i] - d0 > Math.max(depthTolM, depthTolRel * Math.abs(d0))) revealed++;
    }
    return revealed / before.ids.length;
}

// ---------------------------------------------------------------------------
// Height field and street-level probe views (derived from the scan at runtime)
// ---------------------------------------------------------------------------

export interface HeightField {
    width: number;
    depth: number;
    originX: number;
    originZ: number;
    cellSize: number;
    /** Highest surface y per cell (NaN where nothing covers the cell). */
    maxY: Float32Array;
}

/** Top-down max-height raster of the triangles (cell centres sampled). */
export function rasterizeHeightField(P: ArrayLike<number>, T: Uint32Array, cellSize: number): HeightField {
    const b = bounds(P, T);
    const width = Math.max(1, Math.ceil((b.max[0] - b.min[0]) / cellSize));
    const depth = Math.max(1, Math.ceil((b.max[2] - b.min[2]) / cellSize));
    const maxY = new Float32Array(width * depth).fill(NaN);
    const ox = b.min[0], oz = b.min[2];
    for (let t = 0; t < T.length / 3; t++) {
        const a = T[t * 3] * 3, bb = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const ax = (P[a] - ox) / cellSize, az = (P[a + 2] - oz) / cellSize;
        const bx = (P[bb] - ox) / cellSize, bz = (P[bb + 2] - oz) / cellSize;
        const cx = (P[c] - ox) / cellSize, cz = (P[c + 2] - oz) / cellSize;
        const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        if (Math.abs(area) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
        const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), z1 = Math.min(depth - 1, Math.ceil(Math.max(az, bz, cz)));
        for (let z = z0; z <= z1; z++) {
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, pz = z + 0.5;
                const w0 = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / area;
                const w1 = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const y = w0 * P[a + 1] + w1 * P[bb + 1] + w2 * P[c + 1];
                const i = z * width + x;
                if (!(maxY[i] >= y)) maxY[i] = y;
            }
        }
    }
    return { width, depth, originX: ox, originZ: oz, cellSize, maxY };
}

export interface StreetViewProbeOptions {
    count?: number;
    eyeHeightM?: number;
    cellSize?: number;
    pitchDeg?: number;
    fovYDeg?: number;
    /** Height above the low-percentile ground reference still treated as street (m). */
    groundBandM?: number;
    /** Only cells within this fraction of the half-extent from the centre are candidates. */
    centralFraction?: number;
}

/**
 * Derives outdoor street-level probe views from the scan itself: open cells of the top-down
 * height field that sit near the low ground reference (with an open 3x3 neighbourhood), spread
 * by farthest-point sampling, each looking toward the tile centre with a slight upward pitch.
 */
export function deriveStreetLevelViews(P: ArrayLike<number>, T: Uint32Array, options: StreetViewProbeOptions = {}): PerspectiveView[] {
    const count = options.count ?? 8;
    if (count <= 0) return [];
    const cell = options.cellSize ?? 2;
    const hf = rasterizeHeightField(P, T, cell);
    const filled: number[] = [];
    for (const y of hf.maxY) if (!Number.isNaN(y)) filled.push(y);
    const ground = percentile(filled, 10);
    const band = options.groundBandM ?? 2.5;
    const cxCell = hf.width / 2, czCell = hf.depth / 2;
    const reach = (options.centralFraction ?? 0.6) * Math.min(hf.width, hf.depth) / 2;
    const candidates: number[] = [];
    for (let z = 1; z < hf.depth - 1; z++) {
        for (let x = 1; x < hf.width - 1; x++) {
            if (Math.hypot(x + 0.5 - cxCell, z + 0.5 - czCell) > reach) continue;
            let open = true;
            for (let dz = -1; dz <= 1 && open; dz++) {
                for (let dx = -1; dx <= 1 && open; dx++) {
                    const y = hf.maxY[(z + dz) * hf.width + x + dx];
                    if (Number.isNaN(y) || y > ground + band) open = false;
                }
            }
            if (open) candidates.push(z * hf.width + x);
        }
    }
    if (candidates.length === 0) return [];
    const pos = (i: number): [number, number] => [(i % hf.width) + 0.5, Math.floor(i / hf.width) + 0.5];
    const chosen: number[] = [];
    let start = candidates[0], bestD = Infinity;
    for (const c of candidates) { const [x, z] = pos(c); const d = Math.hypot(x - cxCell, z - czCell); if (d < bestD) { bestD = d; start = c; } }
    chosen.push(start);
    const minD = new Float64Array(candidates.length).fill(Infinity);
    while (chosen.length < Math.min(count, candidates.length)) {
        const last = pos(chosen[chosen.length - 1]);
        let pick = -1, pickD = -1;
        candidates.forEach((c, i) => {
            const [x, z] = pos(c);
            minD[i] = Math.min(minD[i], Math.hypot(x - last[0], z - last[1]));
            if (minD[i] > pickD) { pickD = minD[i]; pick = c; }
        });
        if (pick < 0 || pickD <= 0) break;
        chosen.push(pick);
    }
    const eyeH = options.eyeHeightM ?? 1.7;
    const pitch = ((options.pitchDeg ?? 15) * Math.PI) / 180;
    const centerX = hf.originX + cxCell * cell, centerZ = hf.originZ + czCell * cell;
    return chosen.map((c, i) => {
        const [gx, gz] = pos(c);
        const ex = hf.originX + gx * cell, ez = hf.originZ + gz * cell;
        const ey = hf.maxY[c] + eyeH;
        let dx = centerX - ex, dz = centerZ - ez;
        const l = Math.hypot(dx, dz);
        if (l < 1) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
        return {
            kind: 'perspective' as const,
            name: `street probe ${i}`,
            eye: [ex, ey, ez] as [number, number, number],
            target: [ex + dx * Math.cos(pitch), ey + Math.sin(pitch), ez + dz * Math.cos(pitch)] as [number, number, number],
            up: [0, 1, 0] as [number, number, number],
            fovYDeg: options.fovYDeg ?? 75,
            near: 0.05
        };
    });
}

// ---------------------------------------------------------------------------
// Normal checks
// ---------------------------------------------------------------------------

/** Angle between each corner's vertex normal and its face normal; flags non-unit normals. */
export function normalFaceDeviation(P: ArrayLike<number>, N: ArrayLike<number>, T: Uint32Array): { maxDeg: number; p99Deg: number; nonUnitNormals: number } {
    const geo = triangleGeometry(P, T);
    const angles: number[] = [];
    let nonUnit = 0;
    for (let v = 0; v < N.length / 3; v++) {
        if (Math.abs(Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) - 1) > 1e-3) nonUnit++;
    }
    for (let t = 0; t < T.length / 3; t++) {
        if (!(geo.areas[t] > 1e-9)) continue;
        for (let k = 0; k < 3; k++) {
            const v = T[t * 3 + k];
            const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
            const l = Math.hypot(nx, ny, nz) || 1;
            const d = (nx * geo.normals[t * 3] + ny * geo.normals[t * 3 + 1] + nz * geo.normals[t * 3 + 2]) / l;
            angles.push((Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI);
        }
    }
    return { maxDeg: angles.reduce((m, a) => Math.max(m, a), 0), p99Deg: percentile(angles, 99), nonUnitNormals: nonUnit };
}

// ---------------------------------------------------------------------------
// Stage measurement bundles (read from the files written to disk)
// ---------------------------------------------------------------------------

export interface GateResult {
    name: string;
    pass: boolean;
    value: number | string | boolean | null;
    limit: string;
}

export interface ClayStageMeasurement {
    source: { triangles: number; positionDigest: PositionDigest };
    clay: {
        triangles: number;
        vertices: number;
        positionDigest: PositionDigest;
        attributes: string[];
        images: number;
        meshes: number;
        materials: number;
        nodeTransforms: number;
        normalFaceDeviation: { maxDeg: number; p99Deg: number; nonUnitNormals: number } | null;
        bytes: number;
    };
    gates: GateResult[];
    pass: boolean;
}

/**
 * Measures a clay GLB against the GLB it was made from: same triangle count, same set of distinct
 * positions, POSITION + NORMAL only, unit normals within the crease angle of their faces.
 */
export function measureClayStage(sourceGlb: Buffer, clayGlb: Buffer, options: { creaseAngleDeg?: number } = {}): ClayStageMeasurement {
    const crease = options.creaseAngleDeg ?? 30;
    const src = readMeasuredMesh(sourceGlb);
    const clay = readMeasuredMesh(clayGlb);
    const inv = inventoryGlb(clayGlb);
    const srcDigest = dedupPositionDigest(src.positions, src.triangles);
    const clayDigest = dedupPositionDigest(clay.positions, clay.triangles);
    let deviation: ClayStageMeasurement['clay']['normalFaceDeviation'] = null;
    if (clay.instances.length === 1) {
        const n = readPrimitiveAttribute(clayGlb, clay.instances[0].mesh, clay.instances[0].primitive, 'NORMAL');
        if (n) deviation = normalFaceDeviation(clay.positions, n.data, clay.triangles);
    }
    const gates: GateResult[] = [
        { name: 'triangle count equals source', pass: clay.triangleCount === src.triangleCount, value: clay.triangleCount, limit: `== ${src.triangleCount}` },
        { name: 'distinct-position digest equals source', pass: clayDigest.sha256 === srcDigest.sha256, value: clayDigest.sha256, limit: srcDigest.sha256 },
        { name: 'attributes are POSITION + NORMAL only', pass: inv.attributeNames.join(',') === 'NORMAL,POSITION', value: inv.attributeNames.join(','), limit: 'NORMAL,POSITION' },
        { name: 'no images embedded', pass: inv.images.length === 0, value: inv.images.length, limit: '== 0' },
        { name: 'no node transforms', pass: inv.nodeTransforms === 0, value: inv.nodeTransforms, limit: '== 0' },
        { name: 'normals are unit length', pass: !!deviation && deviation.nonUnitNormals === 0, value: deviation ? deviation.nonUnitNormals : null, limit: '== 0 non-unit' },
        { name: 'vertex normals within crease angle of their faces', pass: !!deviation && deviation.maxDeg <= crease + 0.5, value: deviation ? deviation.maxDeg : null, limit: `<= ${crease + 0.5} deg` }
    ];
    return {
        source: { triangles: src.triangleCount, positionDigest: srcDigest },
        clay: {
            triangles: clay.triangleCount, vertices: clay.vertexCount, positionDigest: clayDigest,
            attributes: inv.attributeNames, images: inv.images.length, meshes: inv.meshCount, materials: inv.materialCount,
            nodeTransforms: inv.nodeTransforms, normalFaceDeviation: deviation, bytes: clayGlb.length
        },
        gates,
        pass: gates.every(g => g.pass)
    };
}

// ---------------------------------------------------------------------------
// Site frame derived from the scan at runtime (no survey values)
// ---------------------------------------------------------------------------

/** Top-surface raster in the grid frame: the highest surface over each `cell` x `cell` square (NaN = nothing). */
export interface GridDsm { frame: GridFrame; u0: number; w0: number; cell: number; nu: number; nw: number; h: Float64Array }

export function rasterizeGridDsm(P: ArrayLike<number>, T: Uint32Array, frame: GridFrame, cell = 0.5): GridDsm {
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    const V = P.length / 3;
    const U = new Float64Array(V), W = new Float64Array(V);
    for (let v = 0; v < V; v++) {
        const [u, w] = toGridUW(P[v * 3], P[v * 3 + 2], frame);
        U[v] = u; W[v] = w;
    }
    for (let i = 0; i < T.length; i++) { const v = T[i]; u0 = Math.min(u0, U[v]); u1 = Math.max(u1, U[v]); w0 = Math.min(w0, W[v]); w1 = Math.max(w1, W[v]); }
    const nu = Math.max(1, Math.ceil((u1 - u0) / cell)), nw = Math.max(1, Math.ceil((w1 - w0) / cell));
    const h = new Float64Array(nu * nw).fill(NaN);
    for (let t = 0; t < T.length / 3; t++) {
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        const xa = (U[a] - u0) / cell, xb = (U[b] - u0) / cell, xc = (U[c] - u0) / cell;
        const ya = (W[a] - w0) / cell, yb = (W[b] - w0) / cell, yc = (W[c] - w0) / cell;
        const det = (xb - xa) * (yc - ya) - (yb - ya) * (xc - xa);
        if (Math.abs(det) < 1e-12) continue;
        const i0 = Math.max(0, Math.floor(Math.min(xa, xb, xc))), i1 = Math.min(nu - 1, Math.ceil(Math.max(xa, xb, xc)));
        const j0 = Math.max(0, Math.floor(Math.min(ya, yb, yc))), j1 = Math.min(nw - 1, Math.ceil(Math.max(ya, yb, yc)));
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const x = i + 0.5, y = j + 0.5;
                const l0 = ((xb - x) * (yc - y) - (yb - y) * (xc - x)) / det;
                const l1 = ((xc - x) * (ya - y) - (yc - y) * (xa - x)) / det;
                const l2 = 1 - l0 - l1;
                if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                const z = l0 * P[a * 3 + 1] + l1 * P[b * 3 + 1] + l2 * P[c * 3 + 1];
                const k = i * nw + j;
                if (!(h[k] >= z)) h[k] = z;
            }
        }
    }
    return { frame, u0, w0, cell, nu, nw, h };
}

/** A tier of the hero building: a level band between two terraces and its footprint rectangle. */
export interface DerivedTier { y0: number; y1: number; rect: GridRect }

export interface DerivedSiteFrame {
    spec: MetricsFrameSpec;
    groundY: number;
    /** Up-facing area modes inside the hero lot (m), lowest first. */
    terraces: Array<{ y: number; areaM2: number }>;
    tiers: DerivedTier[];
    /** Index into `tiers` of the tier the shaft faces and corners come from (the tallest one). */
    shaftTier: number;
    lotCells: number;
}

export interface SiteFrameOptions {
    /** Hero anchor in the tile frame (x, z); the ENU origin by default. */
    anchor?: [number, number];
    /** Grid orientation; estimated from the scan when omitted. */
    thetaDeg?: number;
    cell?: number;
    /** Height above ground that makes a cell part of a building (m). */
    buildingMinHeightM?: number;
    /** Height above ground of the hero's core (the part above its podium, if any; m). */
    coreMinHeightM?: number;
    /** A terrace is an up-facing area mode holding at least this much area (m^2). */
    terraceMinAreaM2?: number;
    /** A tier is scanned for relief / fitted for faces only when at least this tall (m). */
    tierMinHeightM?: number;
}

/**
 * Derives the site frame of the hero building from the scan itself (no survey values): grid orientation (facade
 * normals), ground (low percentile of the top surface), the hero lot (the tall core under the anchor plus the level
 * band its podium deck forms around it: a neighbour abutting at another roof height stays outside), terrace heights
 * (up-facing area modes inside the lot), tier footprints (cells reaching each terrace), the shaft (tallest tier) faces
 * and corners, and the relief scans of every tier face. Measurement only: nothing here touches the editing code.
 * Every value comes from `P`/`T`, which should be the INPUT geometry, so the frame is the same for both sides of an edit.
 */
export function deriveSiteFrame(P: ArrayLike<number>, T: Uint32Array, options: SiteFrameOptions = {}): DerivedSiteFrame | null {
    const cell = options.cell ?? 0.5;
    const thetaDeg = options.thetaDeg ?? estimateGridOrientation(P, T).frame.thetaDeg;
    const frame: GridFrame = { thetaDeg };
    const dsm = rasterizeGridDsm(P, T, frame, cell);
    const { nu, nw, h } = dsm;
    const filled: number[] = [];
    for (const z of h) if (Number.isFinite(z)) filled.push(z);
    if (!filled.length) return null;
    const groundY = percentile(filled, 10);
    const bMin = options.buildingMinHeightM ?? 20, cMin = options.coreMinHeightM ?? 25;
    const [ax, az] = options.anchor ?? [0, 0];
    const [au, aw] = toGridUW(ax, az, frame);
    const idx = (i: number, j: number): number => i * nw + j;
    const component = (pred: (k: number) => boolean, seed: number): Uint8Array => {
        const out = new Uint8Array(nu * nw);
        if (seed < 0 || !pred(seed)) return out;
        const stack = [seed];
        out[seed] = 1;
        while (stack.length) {
            const k = stack.pop()!;
            const i = Math.floor(k / nw), j = k % nw;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= nu || jj >= nw) continue;
                const kk = idx(ii, jj);
                if (out[kk] || !pred(kk)) continue;
                out[kk] = 1;
                stack.push(kk);
            }
        }
        return out;
    };
    // the core: cells at least cMin above ground connected to the cell nearest the anchor that qualifies
    const isCore = (k: number): boolean => h[k] > groundY + cMin;
    const isBuilding = (k: number): boolean => h[k] > groundY + bMin;
    let seed = -1, best = Infinity;
    const ai = Math.floor((au - dsm.u0) / cell), aj = Math.floor((aw - dsm.w0) / cell);
    for (let r = 0; r < 200 && seed < 0; r++) {
        for (let i = ai - r; i <= ai + r; i++) {
            for (let j = aj - r; j <= aj + r; j++) {
                if (i < 0 || j < 0 || i >= nu || j >= nw || Math.max(Math.abs(i - ai), Math.abs(j - aj)) !== r) continue;
                const k = idx(i, j);
                const d = Math.hypot(i - ai, j - aj);
                if (isCore(k) && d < best) { best = d; seed = k; }
            }
        }
    }
    if (seed < 0) return null;
    const core = component(isCore, seed);
    // the podium deck: the modal height of building cells right around the core (within 2 m), and every building cell
    // within 0.75 m of that level connected to the core through such cells
    const ringHeights: number[] = [];
    const reach = Math.max(1, Math.round(2 / cell));
    for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nw; j++) {
            const k = idx(i, j);
            if (!core[k]) continue;
            for (let di = -reach; di <= reach; di++) {
                for (let dj = -reach; dj <= reach; dj++) {
                    const ii = i + di, jj = j + dj;
                    if (ii < 0 || jj < 0 || ii >= nu || jj >= nw) continue;
                    const kk = idx(ii, jj);
                    if (!core[kk] && isBuilding(kk)) ringHeights.push(h[kk]);
                }
            }
        }
    }
    const lot = new Uint8Array(nu * nw);
    let deck: number | null = null;
    if (ringHeights.length > 50) {
        const bins = new Map<number, number>();
        for (const z of ringHeights) { const b = Math.round(z / 0.25); bins.set(b, (bins.get(b) ?? 0) + 1); }
        let bestBin = 0, bestCount = -1;
        for (const [b, c] of bins) { const s = c + (bins.get(b - 1) ?? 0) + (bins.get(b + 1) ?? 0); if (s > bestCount) { bestCount = s; bestBin = b; } }
        deck = bestBin * 0.25;
    }
    const deckY = deck;
    const lotPred = (k: number): boolean => core[k] === 1 || (deckY !== null && isBuilding(k) && Math.abs(h[k] - deckY) <= 0.75);
    const lotComp = component(lotPred, seed);
    let lotCells = 0;
    const us: number[] = [], ws: number[] = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) {
        const k = idx(i, j);
        if (!lotComp[k]) continue;
        lot[k] = 1; lotCells++;
        us.push(dsm.u0 + (i + 0.5) * cell); ws.push(dsm.w0 + (j + 0.5) * cell);
    }
    const robustRect = (uu: number[], ww: number[]): GridRect => ({
        u0: percentile(uu, 0.5) - cell / 2, u1: percentile(uu, 99.5) + cell / 2, w0: percentile(ww, 0.5) - cell / 2, w1: percentile(ww, 99.5) + cell / 2
    });
    const lotRect = robustRect(us, ws);
    // terraces: modes of the lot's top surface heights (0.1 m bins, 3-bin smoothing, merged within 1 m, >= minArea of
    // open sky above them): a level only counts where it is the top surface, so caps and chunk bands inside walls do not
    const hist = new Map<number, number>();
    for (let k = 0; k < nu * nw; k++) {
        if (!lot[k]) continue;
        const b = Math.floor(h[k] / 0.1);
        hist.set(b, (hist.get(b) ?? 0) + cell * cell);
    }
    const minArea = options.terraceMinAreaM2 ?? 40;
    const cand: Array<{ y: number; areaM2: number }> = [];
    for (const [b] of hist) {
        const s = (hist.get(b - 1) ?? 0) + (hist.get(b) ?? 0) + (hist.get(b + 1) ?? 0);
        const l = (hist.get(b - 2) ?? 0) + (hist.get(b - 1) ?? 0) + (hist.get(b) ?? 0);
        const r = (hist.get(b) ?? 0) + (hist.get(b + 1) ?? 0) + (hist.get(b + 2) ?? 0);
        if (s >= minArea && s >= l && s >= r) cand.push({ y: (b + 0.5) * 0.1, areaM2: s });
    }
    cand.sort((a, b) => b.areaM2 - a.areaM2 || a.y - b.y);
    const terraces: Array<{ y: number; areaM2: number }> = [];
    for (const c of cand) if (c.y > groundY + bMin - 1 && !terraces.some(x => Math.abs(x.y - c.y) < 1.0)) terraces.push(c);
    terraces.sort((a, b) => a.y - b.y);
    // tier footprints: the lot cells reaching up to each terrace (robust rectangle), and the band between terraces
    const reachRect = (y: number): GridRect | null => {
        const uu: number[] = [], ww: number[] = [];
        for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) {
            const k = idx(i, j);
            if (lot[k] && h[k] >= y - 0.5) { uu.push(dsm.u0 + (i + 0.5) * cell); ww.push(dsm.w0 + (j + 0.5) * cell); }
        }
        return uu.length >= 20 ? robustRect(uu, ww) : null;
    };
    const tiers: DerivedTier[] = [];
    const levels = [groundY, ...terraces.map(t => t.y)];
    for (let k = 0; k + 1 < levels.length; k++) {
        const rect = reachRect(levels[k + 1]);
        if (rect) tiers.push({ y0: levels[k], y1: levels[k + 1], rect });
    }
    const roofs: Array<RoofSpec & { expectedY?: number }> = [];
    terraces.forEach((t, k) => {
        const below = reachRect(t.y);
        if (!below) return;
        const above = k + 1 < terraces.length ? reachRect(terraces[k + 1].y) ?? undefined : undefined;
        roofs.push({ name: `terrace ${t.y.toFixed(1)}`, y: t.y, below, above });
    });
    const tierMinH = options.tierMinHeightM ?? 10;
    let shaftTier = -1;
    tiers.forEach((t, k) => { if (shaftTier < 0 || t.y1 - t.y0 > tiers[shaftTier].y1 - tiers[shaftTier].y0) shaftTier = k; });
    const faces: FacadeFaceSpec[] = [];
    let cornerYs: number[] = [];
    if (shaftTier >= 0) {
        const s = tiers[shaftTier], r = s.rect;
        const halfU = (r.u1 - r.u0) / 2, halfW = (r.w1 - r.w0) / 2;
        const y0 = s.y0 + 6, y1 = s.y1 - 8;
        faces.push(
            { name: 'shaft -u', axis: 'u', sign: -1, offset: r.u0, band: 1.2, lateral: { lo: 0.1 * halfW, hi: 0.9 * halfW }, y0, y1 },
            { name: 'shaft +u', axis: 'u', sign: 1, offset: r.u1, band: 1.2, lateral: { lo: 0.1 * halfW, hi: 0.9 * halfW }, y0, y1 },
            { name: 'shaft -w', axis: 'w', sign: -1, offset: r.w0, band: 1.2, lateral: { lo: 0.1 * halfU, hi: 0.9 * halfU }, y0, y1 },
            { name: 'shaft +w', axis: 'w', sign: 1, offset: r.w1, band: 1.2, lateral: { lo: 0.1 * halfU, hi: 0.9 * halfU }, y0, y1 }
        );
        for (let y = y0 + 6; y <= y1 - 2; y += 5) cornerYs.push(y);
        if (!cornerYs.length) cornerYs = [0.5 * (y0 + y1)];
    }
    const reliefScans: ReliefScanSpec[] = [];
    tiers.forEach((t, k) => {
        if (t.y1 - t.y0 < tierMinH) return;
        const r = t.rect, y0 = t.y0 + 2, y1 = t.y1 - 1;
        const nm = (s: string): string => `tier ${k} ${s}`;
        reliefScans.push(
            { name: nm('+w'), axis: 'w', sign: 1, offset: r.w1, lateral: { lo: r.u0 - 2, hi: r.u1 + 2 }, y0, y1, span: { lo: r.u0, hi: r.u1 } },
            { name: nm('-w'), axis: 'w', sign: -1, offset: r.w0, lateral: { lo: r.u0 - 2, hi: r.u1 + 2 }, y0, y1, span: { lo: r.u0, hi: r.u1 } },
            { name: nm('+u'), axis: 'u', sign: 1, offset: r.u1, lateral: { lo: r.w0 - 2, hi: r.w1 + 2 }, y0, y1, span: { lo: r.w0, hi: r.w1 } },
            { name: nm('-u'), axis: 'u', sign: -1, offset: r.u0, lateral: { lo: r.w0 - 2, hi: r.w1 + 2 }, y0, y1, span: { lo: r.w0, hi: r.w1 } }
        );
    });
    return {
        spec: { thetaDeg, lot: lotRect, faces, cornerYs, roofs, reliefScans },
        groundY, terraces, tiers, shaftTier, lotCells
    };
}

/** Optional grid-frame description for site-level measurements (tests pass survey values). */
export interface MetricsFrameSpec {
    thetaDeg: number;
    /** Lot rectangle used for the lot-level plumb/grid fraction. */
    lot?: GridRect;
    /** Facade faces to plane-fit; u/w pairs also define the corners for the bevel measurement. */
    faces?: FacadeFaceSpec[];
    cornerYs?: number[];
    roofs?: Array<RoofSpec & { expectedY?: number }>;
    /** Facade reliefs (frontispiece, piers) that must stay proud of their main wall. */
    reliefs?: ReliefSpec[];
    /** Facade faces scanned for relief ridges (pilasters, piers, strips) that must stay proud. */
    reliefScans?: ReliefScanSpec[];
}

export interface RectifiedStageThresholds {
    maxDisplacementM: number;
    p95DisplacementM: number;
    meanDisplacementM: number;
    /** Minimum fraction of kept-triangle vertices that move at most 1 cm. */
    minWithinCentimetreFrac: number;
    maxFlippedTris: number;
    maxNewSliverTris: number;
    /** Allowed relative change of >= 45 degree crease length. */
    realCreaseTolerance: number;
    /** Maximum ratio of 15-45 degree crease length after / before. */
    maxSpuriousCreaseRatio: number;
    minSilhouetteIoU: number;
    maxNewSkyFraction: number;
    /** Maximum fraction of pixels whose visible input triangle was culled, per view. */
    maxRevealedFraction: number;
    minLotPlumbGridFrac: number;
    maxCornerBevelMeanM: number;
    maxFaceRmsM: number;
    roofToleranceM: number;
    minReliefProudM: number;
    /** Maximum share of the input piers (reliefScans) the edit leaves less than 0.1 m proud of the main plane. */
    maxReliefRidgeFlattenedFrac: number;
    /** Maximum share of input chunk-seam T-junctions (vertex within 5 mm of a foreign boundary edge) the edit opens by > 5 cm. */
    maxSeamOpenedFrac: number;
    /**
     * Cracks (`seamCracks`): maximum share of the boundary-edge length touching another piece (edge or face) at the input
     * whose gap the edit widens by more than 5 cm, and by more than 20 cm.
     */
    maxCrackOpened5cmFrac: number;
    maxCrackOpened20cmFrac: number;
    /** Maximum change of a terrace's height (top-surface median) when no survey height is given (m). */
    terraceKeepToleranceM: number;
}

export const DEFAULT_RECTIFIED_STAGE_THRESHOLDS: RectifiedStageThresholds = {
    maxDisplacementM: 0.75,
    p95DisplacementM: 0.45,
    meanDisplacementM: 0.12,
    minWithinCentimetreFrac: 0.5,
    maxFlippedTris: 0,
    maxNewSliverTris: 0,
    realCreaseTolerance: 0.02,
    maxSpuriousCreaseRatio: 0.75,
    minSilhouetteIoU: 0.995,
    maxNewSkyFraction: 0.0005,
    maxRevealedFraction: 0.0005,
    minLotPlumbGridFrac: 0.7,
    maxCornerBevelMeanM: 0.12,
    maxFaceRmsM: 0.16,
    roofToleranceM: 0.3,
    minReliefProudM: 0.1,
    maxReliefRidgeFlattenedFrac: 0.1,
    maxSeamOpenedFrac: 0.001,
    maxCrackOpened5cmFrac: 0.01,
    maxCrackOpened20cmFrac: 0.001,
    terraceKeepToleranceM: 0.3
};

export interface RectifiedStageOptions {
    thresholds?: Partial<RectifiedStageThresholds>;
    /** Site frame (survey values in tests). */
    frame?: MetricsFrameSpec;
    /**
     * Without `frame`: derive the site frame from the input scan (restricted to the output's triangles) with
     * `deriveSiteFrame`, so lot, shaft, terrace and relief gates are measured without any survey values.
     */
    deriveFrame?: boolean | SiteFrameOptions;
    silhouetteResolution?: number;
    streetProbeCount?: number;
    streetProbeSize?: [number, number];
}

export interface RectifiedStageMeasurement {
    input: { triangles: number; vertices: number };
    output: { triangles: number; vertices: number; droppedInputPrimitives: number };
    /**
     * Input triangles the edit removed, split from the files alone: culled (hidden-surface removal)
     * versus collapsed to zero area by the geometry edit (neighbours meet across them). Only culled
     * triangles can open holes; the cull-reveal and cull-only sky gates count those alone.
     */
    removed: { culled: number; collapsed: number; culledAreaM2: number; collapsedAreaM2: number };
    texturePreservation: { imagesIdentical: boolean; imageCount: number; uvPrimitivesMatched: number };
    displacement: DisplacementStats;
    topologyBaseline: TopologyStats;
    topologyOutput: TopologyStats;
    /** Geometric seam openings (unwelded tile-chunk seams), measured between input and output positions. */
    seams: SeamOpeningStats;
    /** Chunk-seam cracks: boundary edges against other pieces' edges and faces (see `seamCracks`). */
    cracks: SeamCrackStats;
    gridEstimate: GridOrientationEstimate;
    facadeDistrictBaseline: FacadeStats;
    facadeDistrictOutput: FacadeStats;
    creasesBaseline: CreaseLengths;
    creasesOutput: CreaseLengths;
    silhouettes: Array<{ view: string; iou: number }>;
    /**
     * Street-level probes. `newSkyFraction` compares the full input with the output;
     * `cullOnlyNewSkyFraction` renders the input positions without the culled triangles (collapsed
     * ones stay, see `removed`), isolating holes caused by culling from silhouette changes caused
     * by vertex motion.
     */
    streetProbes: Array<{ view: string; eye: [number, number, number]; newSkyFraction: number; cullOnlyNewSkyFraction: number; inputSkyFraction: number; revealedFraction: number }>;
    /** Pixels whose nearest input triangle was culled, in ortho + aerial-ring views. */
    cullReveal: Array<{ view: string; revealedFraction: number }>;
    site?: {
        frame: MetricsFrameSpec;
        /** How the frame was obtained: given (survey values) or derived from the scan at runtime. */
        frameSource: 'given' | 'derived';
        derived?: Omit<DerivedSiteFrame, 'spec'>;
        lotFacadeBaseline?: FacadeStats;
        lotFacadeOutput?: FacadeStats;
        lotCreasesBaseline?: CreaseLengths;
        lotCreasesOutput?: CreaseLengths;
        facesBaseline?: Record<string, FacadeFaceResult | null>;
        facesOutput?: Record<string, FacadeFaceResult | null>;
        cornersBaseline?: Record<string, { meanM: number; maxM: number; n: number }>;
        cornersOutput?: Record<string, { meanM: number; maxM: number; n: number }>;
        roofsOutput?: Record<string, RoofResult | null>;
        roofsBaseline?: Record<string, RoofResult | null>;
        reliefsBaseline?: Record<string, ReliefResult | null>;
        reliefsOutput?: Record<string, ReliefResult | null>;
        reliefRidges?: ReliefRidgeStats;
    };
    gates: GateResult[];
    pass: boolean;
}

function cornersFromFaces(faces: Record<string, FacadeFaceResult | null>, specs: FacadeFaceSpec[]): CornerSpec[] {
    const us = specs.filter(f => f.axis === 'u' && faces[f.name]);
    const ws = specs.filter(f => f.axis === 'w' && faces[f.name]);
    const out: CornerSpec[] = [];
    for (const fu of us) for (const fw of ws) {
        out.push({ name: `corner u${fu.sign > 0 ? '+' : '-'} w${fw.sign > 0 ? '+' : '-'}`, u: faces[fu.name]!.offsetFit, w: faces[fw.name]!.offsetFit });
    }
    return out;
}

/**
 * Measures a rectified (position-patched, triangle-culled) GLB against its input. All numbers come
 * from the two files: the output's primitives are aligned to the input's, the baseline for
 * topology/crease/facade metrics is the input geometry restricted to the output's triangles.
 */
export function measureRectifiedStage(inputGlb: Buffer, outputGlb: Buffer, options: RectifiedStageOptions = {}): RectifiedStageMeasurement {
    const th = { ...DEFAULT_RECTIFIED_STAGE_THRESHOLDS, ...(options.thresholds ?? {}) };
    const m0 = readMeasuredMesh(inputGlb);
    const m1 = readMeasuredMesh(outputGlb);
    const inv0 = inventoryGlb(inputGlb), inv1 = inventoryGlb(outputGlb);
    const aligned = alignInputToOutput(m0, m1);
    const P0 = aligned.inputPositions, P1 = m1.positions, T1 = m1.triangles;
    const used = referencedVertexMask(m1.vertexCount, T1);
    const removed = classifyRemovedTriangles(m0, m1, aligned);
    // Input triangles still present after culling: kept ones plus the ones the edit collapsed.
    const notCulled = new Uint8Array(m0.triangleCount);
    for (let t = 0; t < m0.triangleCount; t++) notCulled[t] = aligned.inputTriangleKept[t] | removed.collapsed[t];
    const notCulledTriangles = selectTriangles(m0.triangles, notCulled);

    const imagesIdentical = inv0.images.length === inv1.images.length && inv0.images.every((im, i) => im.sha256 === inv1.images[i].sha256);
    const displacement = displacementStats(P0, P1, T1, used);
    const topologyBaseline = topology(P0, T1);
    const topologyOutput = topology(P1, T1);
    const seams = seamOpenings(P0, P1, T1);
    const cracks = seamCracks(P0, P1, T1);
    const gridEstimate = estimateGridOrientation(P0, T1);
    const facadeDistrictBaseline = facadeStats(P0, T1, gridEstimate.frame);
    const facadeDistrictOutput = facadeStats(P1, T1, gridEstimate.frame);
    const creasesBaseline = creaseLengths(P0, T1);
    const creasesOutput = creaseLengths(P1, T1);

    const res = options.silhouetteResolution ?? 512;
    const silhouettes = standardOrthoViews(m0.positions, m0.triangles).map(view => ({
        view: view.name,
        iou: maskIoU(rasterizeSilhouette(m0.positions, m0.triangles, view, res, res), rasterizeSilhouette(P1, T1, view, res, res))
    }));
    const [pw, ph] = options.streetProbeSize ?? [640, 480];
    const probeCount = options.streetProbeCount ?? 8;
    const streetProbes: RectifiedStageMeasurement['streetProbes'] = [];
    // Oversample candidates (farthest-point order) and keep the first views that see open sky,
    // so every probe can actually reveal culling holes.
    for (const view of deriveStreetLevelViews(m0.positions, m0.triangles, { count: probeCount * 4 })) {
        if (streetProbes.length >= probeCount) break;
        const before = rasterizeSilhouette(m0.positions, m0.triangles, view, pw, ph);
        let sky = 0;
        for (let i = 0; i < before.length; i++) if (!before[i]) sky++;
        if (sky / before.length < 0.02) continue;
        const after = rasterizeSilhouette(P1, T1, view, pw, ph);
        const culledOnly = rasterizeSilhouette(m0.positions, notCulledTriangles, view, pw, ph);
        streetProbes.push({
            view: view.name, eye: view.eye, newSkyFraction: lostCoverageFraction(before, after),
            cullOnlyNewSkyFraction: lostCoverageFraction(before, culledOnly), inputSkyFraction: sky / before.length,
            revealedFraction: revealedPixelFraction(m0.positions, m0.triangles, notCulled, view, pw, ph)
        });
    }
    const revealViews: SilhouetteView[] = [...standardOrthoViews(m0.positions, m0.triangles), ...standardAerialViews(m0.positions, m0.triangles)];
    const cullReveal = revealViews.map(view => ({ view: view.name, revealedFraction: revealedPixelFraction(m0.positions, m0.triangles, notCulled, view, pw, ph) }));

    const gates: GateResult[] = [
        { name: 'images byte-identical', pass: imagesIdentical, value: imagesIdentical, limit: 'true' },
        { name: 'every output primitive keeps its input UV bytes', pass: aligned.matchedInstances === m1.instances.length, value: aligned.matchedInstances, limit: `== ${m1.instances.length}` },
        { name: 'max displacement', pass: displacement.maxM <= th.maxDisplacementM, value: displacement.maxM, limit: `<= ${th.maxDisplacementM} m` },
        { name: 'p95 displacement', pass: displacement.p95M <= th.p95DisplacementM, value: displacement.p95M, limit: `<= ${th.p95DisplacementM} m` },
        { name: 'mean displacement', pass: displacement.meanM <= th.meanDisplacementM, value: displacement.meanM, limit: `<= ${th.meanDisplacementM} m` },
        { name: 'kept-triangle vertices moved <= 1 cm', pass: displacement.withinCentimetreFrac >= th.minWithinCentimetreFrac, value: displacement.withinCentimetreFrac, limit: `>= ${th.minWithinCentimetreFrac}` },
        { name: 'flipped triangles', pass: displacement.flippedTris <= th.maxFlippedTris, value: displacement.flippedTris, limit: `<= ${th.maxFlippedTris}` },
        { name: 'newly collapsed slivers (< 1e-4 m^2)', pass: displacement.newSliverTris <= th.maxNewSliverTris, value: displacement.newSliverTris, limit: `<= ${th.maxNewSliverTris}` },
        { name: 'welded boundary edges not above culled-input baseline', pass: topologyOutput.boundaryEdges <= topologyBaseline.boundaryEdges, value: topologyOutput.boundaryEdges, limit: `<= ${topologyBaseline.boundaryEdges}` },
        {
            // edge-to-edge and edge-to-face: chunk borders lying on another piece's border or face must stay on it
            name: 'chunk-seam cracks opened by > 5 cm (edge and face contacts)', pass: cracks.openedOver5cmM <= th.maxCrackOpened5cmFrac * cracks.contactLengthM,
            value: cracks.openedOver5cmM, limit: `<= ${(th.maxCrackOpened5cmFrac * cracks.contactLengthM).toFixed(1)} m (${th.maxCrackOpened5cmFrac * 100}% of ${cracks.contactLengthM.toFixed(0)} m in contact)`
        },
        {
            name: 'chunk-seam cracks opened by > 20 cm', pass: cracks.openedOver20cmM <= th.maxCrackOpened20cmFrac * cracks.contactLengthM,
            value: cracks.openedOver20cmM, limit: `<= ${(th.maxCrackOpened20cmFrac * cracks.contactLengthM).toFixed(1)} m (${th.maxCrackOpened20cmFrac * 100}% of the contact length)`
        },
        {
            // the welded count above cannot see unwelded chunk seams; this measures their geometric gap
            name: 'chunk-seam T-junctions opened by > 5 cm', pass: seams.tJunctionsOpenedOver5cm <= th.maxSeamOpenedFrac * seams.tJunctions,
            value: seams.tJunctionsOpenedOver5cm, limit: `<= ${(th.maxSeamOpenedFrac * seams.tJunctions).toFixed(1)} (${th.maxSeamOpenedFrac * 100}% of ${seams.tJunctions} T-junctions)`
        },
        { name: 'district plumb+grid facade fraction not reduced', pass: facadeDistrictOutput.areaFracWithin1DegPlumbAndGrid >= facadeDistrictBaseline.areaFracWithin1DegPlumbAndGrid, value: facadeDistrictOutput.areaFracWithin1DegPlumbAndGrid, limit: `>= ${facadeDistrictBaseline.areaFracWithin1DegPlumbAndGrid}` },
        {
            name: '>= 45 deg crease length preserved', pass: Math.abs(creasesOutput.realM / creasesBaseline.realM - 1) <= th.realCreaseTolerance,
            value: creasesOutput.realM, limit: `${creasesBaseline.realM.toFixed(1)} m +/- ${th.realCreaseTolerance * 100}%`
        },
        {
            name: '15-45 deg spurious facade crease length reduced', pass: creasesOutput.facadeSpuriousM <= th.maxSpuriousCreaseRatio * creasesBaseline.facadeSpuriousM,
            value: creasesOutput.facadeSpuriousM, limit: `<= ${(th.maxSpuriousCreaseRatio * creasesBaseline.facadeSpuriousM).toFixed(1)} m`
        },
        { name: 'silhouette IoU vs input (6 ortho views)', pass: silhouettes.every(s => s.iou >= th.minSilhouetteIoU), value: Math.min(...silhouettes.map(s => s.iou)), limit: `>= ${th.minSilhouetteIoU}` },
        {
            name: 'visible triangles culled (ortho + aerial ring)', pass: cullReveal.every(v => v.revealedFraction <= th.maxRevealedFraction),
            value: Math.max(...cullReveal.map(v => v.revealedFraction)), limit: `<= ${th.maxRevealedFraction} of pixels per view (${cullReveal.length} views)`
        }
    ];
    if (probeCount > 0) {
        // Culling false positives open holes to the sky; vertex motion only shifts silhouettes,
        // which the displacement and boundary-edge gates already bound.
        gates.push({
            name: 'new sky from culling at street-level probes', pass: streetProbes.length > 0 && streetProbes.every(p => p.cullOnlyNewSkyFraction <= th.maxNewSkyFraction),
            value: streetProbes.length ? Math.max(...streetProbes.map(p => p.cullOnlyNewSkyFraction)) : null, limit: `<= ${th.maxNewSkyFraction} (${streetProbes.length} probes)`
        });
        gates.push({
            name: 'visible triangles culled at street-level probes', pass: streetProbes.length > 0 && streetProbes.every(p => p.revealedFraction <= th.maxRevealedFraction),
            value: streetProbes.length ? Math.max(...streetProbes.map(p => p.revealedFraction)) : null, limit: `<= ${th.maxRevealedFraction} of pixels per view`
        });
    }

    let site: RectifiedStageMeasurement['site'];
    let siteFrame: MetricsFrameSpec | undefined = options.frame;
    let derived: DerivedSiteFrame | null = null;
    if (!siteFrame && options.deriveFrame) {
        derived = deriveSiteFrame(P0, T1, typeof options.deriveFrame === 'object' ? options.deriveFrame : {});
        if (derived) siteFrame = derived.spec;
        else gates.push({ name: 'site frame derived from the scan', pass: false, value: null, limit: 'a hero building under the anchor' });
    }
    if (siteFrame) {
        const f = siteFrame;
        const frame: GridFrame = { thetaDeg: f.thetaDeg };
        site = { frame: f, frameSource: options.frame ? 'given' : 'derived' };
        if (derived) { const { spec: _spec, ...info } = derived; site.derived = info; }
        if (f.lot) {
            site.lotFacadeBaseline = facadeStats(P0, T1, frame, trianglesInGridRect(P0, T1, frame, f.lot));
            site.lotFacadeOutput = facadeStats(P1, T1, frame, trianglesInGridRect(P1, T1, frame, f.lot));
            const lotMask = trianglesInGridRect(P0, T1, frame, f.lot);
            site.lotCreasesBaseline = creaseLengths(P0, T1, 15, 45, 1e-3, lotMask);
            site.lotCreasesOutput = creaseLengths(P1, T1, 15, 45, 1e-3, lotMask);
            gates.push({ name: 'lot plumb+grid facade fraction', pass: site.lotFacadeOutput.areaFracWithin1DegPlumbAndGrid >= th.minLotPlumbGridFrac, value: site.lotFacadeOutput.areaFracWithin1DegPlumbAndGrid, limit: `>= ${th.minLotPlumbGridFrac}` });
            gates.push({
                name: 'lot 15-45 deg spurious facade crease length reduced', pass: site.lotCreasesOutput.facadeSpuriousM <= th.maxSpuriousCreaseRatio * site.lotCreasesBaseline.facadeSpuriousM,
                value: site.lotCreasesOutput.facadeSpuriousM, limit: `<= ${(th.maxSpuriousCreaseRatio * site.lotCreasesBaseline.facadeSpuriousM).toFixed(1)} m`
            });
        }
        if (f.faces && f.faces.length) {
            site.facesBaseline = measureFacadeFaces(P0, T1, frame, f.faces);
            site.facesOutput = measureFacadeFaces(P1, T1, frame, f.faces);
            for (const face of f.faces) {
                const b = site.facesBaseline[face.name], o = site.facesOutput[face.name];
                gates.push({ name: `face RMS ${face.name}`, pass: !!b && !!o && o.rmsM <= b.rmsM + 1e-9 && o.rmsM <= th.maxFaceRmsM, value: o ? o.rmsM : null, limit: `<= min(${b ? b.rmsM.toFixed(4) : '?'}, ${th.maxFaceRmsM}) m` });
            }
            const ys = f.cornerYs ?? [];
            if (ys.length) {
                site.cornersBaseline = cornerBevel(P0, T1, frame, cornersFromFaces(site.facesBaseline, f.faces), ys);
                site.cornersOutput = cornerBevel(P1, T1, frame, cornersFromFaces(site.facesOutput, f.faces), ys);
                for (const [name, r] of Object.entries(site.cornersOutput)) {
                    gates.push({ name: `corner bevel ${name}`, pass: r.meanM <= th.maxCornerBevelMeanM, value: r.meanM, limit: `<= ${th.maxCornerBevelMeanM} m` });
                }
            }
        }
        if (f.reliefs && f.reliefs.length) {
            site.reliefsBaseline = reliefProjection(P0, T1, frame, f.reliefs);
            site.reliefsOutput = reliefProjection(P1, T1, frame, f.reliefs);
            for (const r of f.reliefs) {
                const o = site.reliefsOutput[r.name];
                gates.push({ name: `relief proud ${r.name}`, pass: !!o && o.proudM >= th.minReliefProudM, value: o ? o.proudM : null, limit: `>= ${th.minReliefProudM} m` });
            }
        }
        if (f.reliefScans && f.reliefScans.length) {
            const rr = facadeReliefRidges(P0, P1, T1, frame, f.reliefScans);
            site.reliefRidges = rr;
            gates.push({
                name: 'piers still >= 0.1 m proud of the main plane', pass: rr.piers > 0 && rr.piersFlattened <= th.maxReliefRidgeFlattenedFrac * rr.piers,
                value: rr.piersFlattened, limit: `<= ${(th.maxReliefRidgeFlattenedFrac * rr.piers).toFixed(1)} of ${rr.piers} input piers (crisp ridges >= 0.1 m proud of the main plane, away from corners)`
            });
            gates.push({
                name: 'projections (3-15 m wide) still >= 0.1 m proud of the main plane', pass: rr.projectionsFlattened <= th.maxReliefRidgeFlattenedFrac * rr.projections.length,
                value: rr.projectionsFlattened, limit: `<= ${(th.maxReliefRidgeFlattenedFrac * rr.projections.length).toFixed(1)} of ${rr.projections.length} input projections`
            });
        }
        if (f.roofs && f.roofs.length) {
            site.roofsBaseline = roofFlatness(P0, T1, frame, f.roofs);
            site.roofsOutput = roofFlatness(P1, T1, frame, f.roofs, P0);
            for (const r of f.roofs) {
                if (r.expectedY === undefined) {
                    // no survey height: the terrace keeps the height it has in the input (same top-surface estimator)
                    const i = site.roofsBaseline[r.name], o = site.roofsOutput[r.name];
                    if (!i || i.yDsmMedian === null) continue;
                    gates.push({
                        name: `terrace ${r.name} height kept (top-surface median)`, pass: !!o && o.yDsmMedian !== null && Math.abs(o.yDsmMedian - i.yDsmMedian) <= th.terraceKeepToleranceM,
                        value: o ? o.yDsmMedian : null, limit: `${i.yDsmMedian.toFixed(3)} +/- ${th.terraceKeepToleranceM} m (input)`
                    });
                    continue;
                }
                const o = site.roofsOutput[r.name];
                gates.push({ name: `roof height ${r.name}`, pass: !!o && Math.abs(o.yMedian - r.expectedY) <= th.roofToleranceM, value: o ? o.yMedian : null, limit: `${r.expectedY} +/- ${th.roofToleranceM} m` });
                // the survey oracle sliced a top-surface raster; the same estimator, reported as its own gate
                gates.push({ name: `roof height ${r.name} (DSM, the oracle's estimator)`, pass: !!o && o.yDsmMedian !== null && Math.abs(o.yDsmMedian - r.expectedY) <= th.roofToleranceM, value: o ? o.yDsmMedian : null, limit: `${r.expectedY} +/- ${th.roofToleranceM} m` });
            }
        }
    }

    return {
        input: { triangles: m0.triangleCount, vertices: m0.vertexCount },
        output: { triangles: m1.triangleCount, vertices: m1.vertexCount, droppedInputPrimitives: aligned.droppedInputInstances },
        removed: { culled: removed.culledCount, collapsed: removed.collapsedCount, culledAreaM2: removed.culledAreaM2, collapsedAreaM2: removed.collapsedAreaM2 },
        texturePreservation: { imagesIdentical, imageCount: inv1.images.length, uvPrimitivesMatched: aligned.matchedInstances },
        displacement, topologyBaseline, topologyOutput, seams, cracks, gridEstimate,
        facadeDistrictBaseline, facadeDistrictOutput, creasesBaseline, creasesOutput,
        silhouettes, streetProbes, cullReveal, site,
        gates,
        pass: gates.every(g => g.pass)
    };
}
