/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Texture-preserving GLB geometry patcher for real photogrammetric scans.
 *
 * Two operations, both generic over any binary glTF 2.0 file:
 *
 * - `applyRectification` applies an SBRX sidecar written by the native scan rectifier
 *   (`scratchbox_scan_rectifier.hpp`): it patches POSITION data in place (updating accessor
 *   min/max) and rewrites each primitive's index accessor as uint32 without the triangles the
 *   sidecar drops. Images, UVs, materials, samplers and every other byte of the file stay
 *   identical, so the result is a "textured base" that later texturing stages can build on.
 * - `toClay` flattens the scene into one studio-clay mesh with crease-split normals (default
 *   30 degrees) and no UV / COLOR / TANGENT attributes.
 *
 * Vertex and triangle order follow `gltf::GlbSceneReader` (scratchbox_gltf_scene.hpp) exactly:
 * scene roots depth-first, mesh before children, primitives in order, `mode` 4 only, triangles
 * with out-of-range indices skipped. The sidecar is indexed in that order.
 *
 * SBRX sidecar (little-endian):
 *   bytes 0..3  ASCII "SBRX"
 *   uint32      version (1)
 *   uint32      V  vertex count
 *   uint32      T  triangle count
 *   float32[3V] world-space positions in GlbSceneReader order
 *   uint8[T]    flags: 1 keep, 0 hidden (culled), 2 degenerate (collapsed)
 * Trailing bytes after the flags (alignment padding) are ignored.
 *
 * This module only edits. Quality measurement lives in `scan-geometry-metrics.ts`, which has
 * its own independent GLB reader so editing bugs cannot hide in shared code.
 */

import { GltfBinaryPacker } from './gltf-binary-packer';

// ---------------------------------------------------------------------------
// glTF JSON shapes (only the fields this module touches; everything else is carried verbatim)
// ---------------------------------------------------------------------------

/** A loose glTF JSON object. Unknown fields are preserved untouched. */
export type GltfObject = { [key: string]: unknown };

interface GltfAccessor extends GltfObject {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    min?: number[];
    max?: number[];
    sparse?: GltfObject;
}

interface GltfBufferView extends GltfObject {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
}

interface GltfPrimitive extends GltfObject {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
    targets?: Array<Record<string, number>>;
}

interface GltfMesh extends GltfObject {
    primitives: GltfPrimitive[];
}

interface GltfNode extends GltfObject {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    skin?: number;
    weights?: number[];
}

/** Top-level glTF document. */
export interface GltfJson extends GltfObject {
    asset: GltfObject;
    scene?: number;
    scenes?: Array<GltfObject & { nodes?: number[] }>;
    nodes?: GltfNode[];
    meshes?: GltfMesh[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: Array<GltfObject & { byteLength: number; uri?: string }>;
    images?: Array<GltfObject & { bufferView?: number; mimeType?: string }>;
    skins?: Array<GltfObject & { inverseBindMatrices?: number }>;
    animations?: Array<GltfObject & { samplers?: Array<GltfObject & { input: number; output: number }> }>;
    extensionsUsed?: string[];
    extensionsRequired?: string[];
}

/** A parsed GLB: its JSON chunk and (possibly empty) BIN chunk. */
export interface GlbDocument {
    json: GltfJson;
    bin: Buffer;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;

export const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Sidecar flag values written by the native rectifier. */
export const SBRX_FLAG_HIDDEN = 0;
export const SBRX_FLAG_KEEP = 1;
export const SBRX_FLAG_DEGENERATE = 2;

// ---------------------------------------------------------------------------
// GLB container I/O
// ---------------------------------------------------------------------------

/** Parses a binary glTF 2.0 container. The BIN chunk is referenced, not copied. */
export function parseGlb(buffer: Buffer): GlbDocument {
    if (buffer.length < 20) throw new Error('GLB is too small');
    if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file (bad magic)');
    if (buffer.readUInt32LE(4) !== 2) throw new Error(`unsupported GLB version ${buffer.readUInt32LE(4)}`);
    const total = Math.min(buffer.readUInt32LE(8), buffer.length);
    let offset = 12;
    let json: GltfJson | null = null;
    let bin: Buffer = Buffer.alloc(0);
    while (offset + 8 <= total) {
        const length = buffer.readUInt32LE(offset);
        const type = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + length > total) throw new Error('GLB chunk extends past the end of the file');
        if (type === CHUNK_JSON && json === null) {
            json = JSON.parse(buffer.toString('utf8', start, start + length)) as GltfJson;
        } else if (type === CHUNK_BIN && bin.length === 0) {
            bin = buffer.subarray(start, start + length);
        }
        offset = start + length;
    }
    if (!json) throw new Error('GLB has no JSON chunk');
    return { json, bin };
}

/** Serialises a document into a GLB container (JSON padded with spaces, BIN with zeros). */
export function serializeGlb(doc: GlbDocument): Buffer {
    let jsonBuf = Buffer.from(JSON.stringify(doc.json), 'utf8');
    const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
    if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
    let bin = doc.bin;
    const binPad = (4 - (bin.length % 4)) % 4;
    if (binPad) bin = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
    const hasBin = bin.length > 0;
    const total = 12 + 8 + jsonBuf.length + (hasBin ? 8 + bin.length : 0);
    const out = Buffer.alloc(total);
    out.writeUInt32LE(GLB_MAGIC, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(total, 8);
    out.writeUInt32LE(jsonBuf.length, 12);
    out.writeUInt32LE(CHUNK_JSON, 16);
    jsonBuf.copy(out, 20);
    if (hasBin) {
        const at = 20 + jsonBuf.length;
        out.writeUInt32LE(bin.length, at);
        out.writeUInt32LE(CHUNK_BIN, at + 4);
        bin.copy(out, at + 8);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Accessor access (validity rules mirror GlbSceneReader::accessor)
// ---------------------------------------------------------------------------

export interface ResolvedAccessor {
    /** Absolute byte offset of element 0 inside the BIN chunk. */
    offset: number;
    stride: number;
    count: number;
    components: number;
    componentType: number;
    elementSize: number;
}

/** Locates an accessor's elements inside the BIN chunk; null when it has no readable data (no bufferView, sparse-only, out of range). */
export function resolveAccessor(doc: GlbDocument, index: number | undefined): ResolvedAccessor | null {
    const accessors = doc.json.accessors ?? [];
    if (index === undefined || index < 0 || index >= accessors.length || doc.bin.length === 0) return null;
    const acc = accessors[index];
    const views = doc.json.bufferViews ?? [];
    if (acc.bufferView === undefined || acc.bufferView < 0 || acc.bufferView >= views.length) return null;
    const view = views[acc.bufferView];
    if ((view.buffer ?? 0) !== 0) return null;
    const components = TYPE_COMPONENTS[acc.type] ?? 0;
    const componentSize = COMPONENT_SIZE[acc.componentType] ?? 0;
    const elementSize = components * componentSize;
    const count = acc.count ?? 0;
    const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : elementSize;
    const offset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    if (elementSize === 0 || count === 0 || offset + (count - 1) * stride + elementSize > doc.bin.length) return null;
    return { offset, stride, count, components, componentType: acc.componentType, elementSize };
}

function readIndex(bin: Buffer, a: ResolvedAccessor, element: number): number {
    const p = a.offset + element * a.stride;
    switch (a.componentType) {
        case 5121: return bin[p];
        case 5123: return bin.readUInt16LE(p);
        case 5125: return bin.readUInt32LE(p);
        default: return 0; // GlbSceneReader returns 0 for non-integer index types
    }
}

// ---------------------------------------------------------------------------
// Scene traversal (order identical to GlbSceneReader)
// ---------------------------------------------------------------------------

/** Column-major 4x4 matrix in float64. */
type Mat4 = Float64Array;

function identity4(): Mat4 {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function isIdentity(m: Mat4): boolean {
    for (let i = 0; i < 16; i++) if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
    return true;
}

function multiply4(a: Mat4, b: Mat4): Mat4 {
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
            r[c * 4 + row] = s;
        }
    }
    return r;
}

function nodeLocalMatrix(node: GltfNode): Mat4 {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
    const t = Array.isArray(node.translation) && node.translation.length === 3 ? node.translation : [0, 0, 0];
    const s = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale : [1, 1, 1];
    const q = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
    const [qx, qy, qz, qw] = q;
    const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const m = identity4();
    m[0] = (1 - 2 * (yy + zz)) * s[0]; m[1] = 2 * (xy + wz) * s[0]; m[2] = 2 * (xz - wy) * s[0];
    m[4] = 2 * (xy - wz) * s[1]; m[5] = (1 - 2 * (xx + zz)) * s[1]; m[6] = 2 * (yz + wx) * s[1];
    m[8] = 2 * (xz + wy) * s[2]; m[9] = 2 * (yz - wx) * s[2]; m[10] = (1 - 2 * (xx + yy)) * s[2];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
}

/** Inverse of an affine column-major 4x4 matrix (throws when singular). */
function invertAffine(m: Mat4): Mat4 {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-20) throw new Error('node transform is singular; cannot map world positions back to the mesh');
    const inv = 1 / det;
    const r = identity4();
    r[0] = (e * i - f * h) * inv; r[4] = (c * h - b * i) * inv; r[8] = (b * f - c * e) * inv;
    r[1] = (f * g - d * i) * inv; r[5] = (a * i - c * g) * inv; r[9] = (c * d - a * f) * inv;
    r[2] = (d * h - e * g) * inv; r[6] = (b * g - a * h) * inv; r[10] = (a * e - b * d) * inv;
    const tx = m[12], ty = m[13], tz = m[14];
    r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
    r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
    r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
    return r;
}

/** One rendered instance of a triangle primitive, in GlbSceneReader order. */
export interface ScenePrimitiveInstance {
    nodeIndex: number;
    meshIndex: number;
    primitiveIndex: number;
    /** World matrix (column-major), or null when the instance is untransformed. */
    world: Float64Array | null;
    positionAccessor: number;
    /** First vertex of this instance in the merged GlbSceneReader vertex stream. */
    vertexBase: number;
    vertexCount: number;
    /** First triangle of this instance in the merged GlbSceneReader triangle stream. */
    triangleBase: number;
    /** Local vertex indices of the valid triangles, three per triangle. */
    localTriangles: Uint32Array;
}

/** Merged-stream layout of a GLB scene. */
export interface SceneTriangleLayout {
    instances: ScenePrimitiveInstance[];
    vertexCount: number;
    triangleCount: number;
}

/** A primitive of a rendered mesh that `enumerateSceneTriangles` leaves out, and why. */
export interface SkippedScenePrimitive {
    nodeIndex: number;
    meshIndex: number;
    primitiveIndex: number;
    /** 'non_triangle_mode' (lines, points, strips, fans), 'missing_position' or 'unreadable_position' (not a readable VEC3 accessor). */
    kind: 'non_triangle_mode' | 'missing_position' | 'unreadable_position';
    mode: number;
}

/**
 * Enumerates every triangle primitive instance exactly as GlbSceneReader merges them.
 * When `skipped` is given, every primitive of a rendered mesh that is left out is appended to it with the reason.
 */
export function enumerateSceneTriangles(doc: GlbDocument, skipped?: SkippedScenePrimitive[]): SceneTriangleLayout {
    const json = doc.json;
    const nodes = json.nodes ?? [];
    const meshes = json.meshes ?? [];
    const roots: number[] = [];
    const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
    const scenes = json.scenes ?? [];
    if (scenes.length > 0 && sceneIndex >= 0 && sceneIndex < scenes.length) {
        for (const n of scenes[sceneIndex].nodes ?? []) roots.push(n);
    } else {
        const isChild = new Array<boolean>(nodes.length).fill(false);
        for (const n of nodes) for (const c of n.children ?? []) if (c >= 0 && c < nodes.length) isChild[c] = true;
        for (let i = 0; i < nodes.length; i++) if (!isChild[i]) roots.push(i);
    }

    const instances: ScenePrimitiveInstance[] = [];
    let vertexBase = 0;
    let triangleBase = 0;
    const walk = (nodeIndex: number, parent: Mat4, depth: number): void => {
        if (nodeIndex < 0 || nodeIndex >= nodes.length || depth > 64) return;
        const node = nodes[nodeIndex];
        const world = multiply4(parent, nodeLocalMatrix(node));
        const meshIndex = node.mesh;
        if (meshIndex !== undefined && meshIndex >= 0 && meshIndex < meshes.length) {
            meshes[meshIndex].primitives.forEach((prim, primitiveIndex) => {
                const mode = prim.mode ?? 4;
                if (mode !== 4) {
                    skipped?.push({ nodeIndex, meshIndex, primitiveIndex, kind: 'non_triangle_mode', mode });
                    return;
                }
                const posIndex = prim.attributes?.POSITION;
                const pos = resolveAccessor(doc, posIndex);
                if (!pos || pos.components !== 3) {
                    skipped?.push({ nodeIndex, meshIndex, primitiveIndex, kind: posIndex === undefined ? 'missing_position' : 'unreadable_position', mode });
                    return;
                }
                const idx = resolveAccessor(doc, prim.indices);
                const indexCount = idx ? idx.count : pos.count;
                const tris: number[] = [];
                for (let i = 0; i + 2 < indexCount; i += 3) {
                    const a = idx ? readIndex(doc.bin, idx, i) : i;
                    const b = idx ? readIndex(doc.bin, idx, i + 1) : i + 1;
                    const c = idx ? readIndex(doc.bin, idx, i + 2) : i + 2;
                    if (a >= pos.count || b >= pos.count || c >= pos.count) continue;
                    tris.push(a, b, c);
                }
                const localTriangles = Uint32Array.from(tris);
                instances.push({
                    nodeIndex, meshIndex, primitiveIndex,
                    world: isIdentity(world) ? null : world,
                    positionAccessor: posIndex as number,
                    vertexBase, vertexCount: pos.count,
                    triangleBase, localTriangles
                });
                vertexBase += pos.count;
                triangleBase += localTriangles.length / 3;
            });
        }
        for (const child of node.children ?? []) walk(child, world, depth + 1);
    };
    for (const r of roots) walk(r, identity4(), 0);
    return { instances, vertexCount: vertexBase, triangleCount: triangleBase };
}

/** World-space positions (float32) and merged triangles, in GlbSceneReader order. */
export function readSceneGeometry(doc: GlbDocument, layout: SceneTriangleLayout = enumerateSceneTriangles(doc)): {
    positions: Float32Array;
    triangles: Uint32Array;
} {
    const positions = new Float32Array(layout.vertexCount * 3);
    const triangles = new Uint32Array(layout.triangleCount * 3);
    for (const inst of layout.instances) {
        const acc = resolveAccessor(doc, inst.positionAccessor)!;
        assertFloatVec3(doc, inst.positionAccessor);
        const m = inst.world;
        for (let v = 0; v < inst.vertexCount; v++) {
            const p = acc.offset + v * acc.stride;
            const x = doc.bin.readFloatLE(p), y = doc.bin.readFloatLE(p + 4), z = doc.bin.readFloatLE(p + 8);
            const o = (inst.vertexBase + v) * 3;
            if (m) {
                positions[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
                positions[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                positions[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            } else {
                positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
            }
        }
        const t0 = inst.triangleBase * 3;
        for (let i = 0; i < inst.localTriangles.length; i++) triangles[t0 + i] = inst.localTriangles[i] + inst.vertexBase;
    }
    return { positions, triangles };
}

function assertFloatVec3(doc: GlbDocument, accessorIndex: number): void {
    const acc = (doc.json.accessors ?? [])[accessorIndex];
    if (acc.componentType !== FLOAT || acc.normalized) {
        throw new Error(`POSITION accessor ${accessorIndex} is not float32 (quantized positions are not supported)`);
    }
    if (acc.sparse) throw new Error(`POSITION accessor ${accessorIndex} is sparse (not supported)`);
}

// ---------------------------------------------------------------------------
// SBRX sidecar
// ---------------------------------------------------------------------------

/** Decoded rectification sidecar. */
export interface RectificationSidecar {
    version: number;
    /** World-space positions, 3 per vertex, in GlbSceneReader order. */
    positions: Float32Array;
    /** Per-triangle flag: 1 keep, 0 hidden, 2 degenerate. */
    flags: Uint8Array;
}

/** Decodes an SBRX sidecar; throws on any contract violation. */
export function readSbrxSidecar(buffer: Buffer): RectificationSidecar {
    if (buffer.length < 16 || buffer.toString('latin1', 0, 4) !== 'SBRX') throw new Error('not an SBRX sidecar (bad magic)');
    const version = buffer.readUInt32LE(4);
    if (version !== 1) throw new Error(`unsupported SBRX version ${version}`);
    const v = buffer.readUInt32LE(8);
    const t = buffer.readUInt32LE(12);
    const need = 16 + 12 * v + t;
    if (buffer.length < need) throw new Error(`SBRX sidecar truncated: ${buffer.length} bytes, expected ${need}`);
    const positions = new Float32Array(v * 3);
    for (let i = 0; i < v * 3; i++) positions[i] = buffer.readFloatLE(16 + i * 4);
    const flags = Uint8Array.from(buffer.subarray(16 + 12 * v, need));
    return { version, positions, flags };
}

/** Encodes an SBRX sidecar (no trailing padding). */
export function encodeSbrxSidecar(sidecar: { positions: Float32Array; flags: Uint8Array }): Buffer {
    if (sidecar.positions.length % 3 !== 0) throw new Error('positions length must be a multiple of 3');
    const v = sidecar.positions.length / 3;
    const t = sidecar.flags.length;
    const out = Buffer.alloc(16 + 12 * v + t);
    out.write('SBRX', 0, 'latin1');
    out.writeUInt32LE(1, 4);
    out.writeUInt32LE(v, 8);
    out.writeUInt32LE(t, 12);
    for (let i = 0; i < v * 3; i++) out.writeFloatLE(sidecar.positions[i], 16 + i * 4);
    Buffer.from(sidecar.flags.buffer, sidecar.flags.byteOffset, t).copy(out, 16 + 12 * v);
    return out;
}

/** A sidecar that keeps every triangle and every position (identity pass). */
export function createIdentitySidecar(doc: GlbDocument): RectificationSidecar {
    const geometry = readSceneGeometry(doc);
    return { version: 1, positions: geometry.positions, flags: new Uint8Array(geometry.triangles.length / 3).fill(SBRX_FLAG_KEEP) };
}

// ---------------------------------------------------------------------------
// applyRectification
// ---------------------------------------------------------------------------

/** Extensions that never reference accessors or bufferViews, so index remapping is safe. */
function isGeometrySafeExtension(name: string): boolean {
    return name.startsWith('KHR_materials_') || name === 'KHR_texture_transform' || name === 'KHR_lights_punctual'
        || name === 'KHR_texture_basisu' || name === 'EXT_texture_webp' || name === 'EXT_texture_avif'
        || name === 'KHR_xmp_json_ld';
}

export interface ApplyRectificationOptions {
    /**
     * When one POSITION accessor is reached by several instances or primitives, the sidecar holds
     * one copy per instance. Copies must agree within this tolerance in mesh space (metres).
     */
    sharedAccessorToleranceM?: number;
}

export interface ApplyRectificationReport {
    vertexCount: number;
    triangleCount: number;
    keptTriangles: number;
    droppedHiddenTriangles: number;
    droppedDegenerateTriangles: number;
    patchedPositionAccessors: number;
    changedVertices: number;
    rewrittenIndexAccessors: number;
    removedPrimitives: number;
    removedMeshes: number;
    removedAccessors: number;
    removedBufferViews: number;
    sharedAccessorConflicts: number;
    instanceFlagConflicts: number;
}

/**
 * Applies an SBRX sidecar to a GLB. Returns a new document; the input is not modified.
 * Only POSITION bytes, POSITION min/max, index accessors (rewritten as uint32) and primitive
 * lists change. Image, UV and all other bufferView bytes are copied verbatim.
 */
export function applyRectification(
    input: GlbDocument,
    sidecar: RectificationSidecar,
    options: ApplyRectificationOptions = {}
): { doc: GlbDocument; report: ApplyRectificationReport } {
    const tolerance = options.sharedAccessorToleranceM ?? 1e-4;
    for (const ext of input.json.extensionsUsed ?? []) {
        if (!isGeometrySafeExtension(ext)) throw new Error(`extension ${ext} may reference geometry buffers; patching is not supported`);
    }
    const layout = enumerateSceneTriangles(input);
    if (sidecar.positions.length !== layout.vertexCount * 3) {
        throw new Error(`sidecar has ${sidecar.positions.length / 3} vertices, GLB scene has ${layout.vertexCount}`);
    }
    if (sidecar.flags.length !== layout.triangleCount) {
        throw new Error(`sidecar has ${sidecar.flags.length} triangle flags, GLB scene has ${layout.triangleCount}`);
    }
    for (let i = 0; i < sidecar.positions.length; i++) {
        if (!Number.isFinite(sidecar.positions[i])) throw new Error(`sidecar position component ${i} is not finite`);
    }
    let droppedHidden = 0, droppedDegenerate = 0;
    for (let t = 0; t < sidecar.flags.length; t++) {
        const f = sidecar.flags[t];
        if (f === SBRX_FLAG_HIDDEN) droppedHidden++;
        else if (f === SBRX_FLAG_DEGENERATE) droppedDegenerate++;
        else if (f !== SBRX_FLAG_KEEP) throw new Error(`sidecar flag ${f} at triangle ${t} is not 0, 1 or 2`);
    }

    const json = JSON.parse(JSON.stringify(input.json)) as GltfJson;
    const bin = Buffer.from(input.bin); // private copy; only POSITION bytes are written
    const doc: GlbDocument = { json, bin };

    // 1. POSITION patch (in place, per element, honouring byteStride).
    const written = new Map<number, Float32Array>(); // accessor -> mesh-space values already written
    let sharedConflicts = 0;
    let changedVertices = 0;
    for (const inst of layout.instances) {
        assertFloatVec3(doc, inst.positionAccessor);
        const acc = resolveAccessor(doc, inst.positionAccessor)!;
        const inv = inst.world ? invertAffine(inst.world) : null;
        const prior = written.get(inst.positionAccessor);
        const values = prior ?? new Float32Array(acc.count * 3);
        for (let v = 0; v < acc.count; v++) {
            const s = (inst.vertexBase + v) * 3;
            const p = acc.offset + v * acc.stride;
            const ox = input.bin.readFloatLE(p), oy = input.bin.readFloatLE(p + 4), oz = input.bin.readFloatLE(p + 8);
            let x = sidecar.positions[s], y = sidecar.positions[s + 1], z = sidecar.positions[s + 2];
            if (inst.world && inv) {
                const m = inst.world;
                // Keep the original bytes when the sidecar returns the original world position
                // (float32 round-off of the forward transform must not count as an edit).
                const fx = Math.fround(m[0] * ox + m[4] * oy + m[8] * oz + m[12]);
                const fy = Math.fround(m[1] * ox + m[5] * oy + m[9] * oz + m[13]);
                const fz = Math.fround(m[2] * ox + m[6] * oy + m[10] * oz + m[14]);
                const ulp = 4 * 1.1920929e-7 * Math.max(1, Math.abs(fx), Math.abs(fy), Math.abs(fz));
                if (Math.abs(x - fx) <= ulp && Math.abs(y - fy) <= ulp && Math.abs(z - fz) <= ulp) {
                    x = ox; y = oy; z = oz;
                } else {
                    const lx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
                    const ly = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
                    const lz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
                    x = Math.fround(lx); y = Math.fround(ly); z = Math.fround(lz);
                }
            }
            if (prior) {
                if (Math.abs(prior[v * 3] - x) > tolerance || Math.abs(prior[v * 3 + 1] - y) > tolerance || Math.abs(prior[v * 3 + 2] - z) > tolerance) {
                    sharedConflicts++;
                }
                continue;
            }
            values[v * 3] = x; values[v * 3 + 1] = y; values[v * 3 + 2] = z;
            bin.writeFloatLE(x, p); bin.writeFloatLE(y, p + 4); bin.writeFloatLE(z, p + 8);
            if (bin.readUInt32LE(p) !== input.bin.readUInt32LE(p) || bin.readUInt32LE(p + 4) !== input.bin.readUInt32LE(p + 4)
                || bin.readUInt32LE(p + 8) !== input.bin.readUInt32LE(p + 8)) {
                changedVertices++;
            }
        }
        if (!prior) written.set(inst.positionAccessor, values);
    }
    for (const [accessorIndex, values] of written) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < values.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                if (values[i + k] < min[k]) min[k] = values[i + k];
                if (values[i + k] > max[k]) max[k] = values[i + k];
            }
        }
        json.accessors![accessorIndex].min = min;
        json.accessors![accessorIndex].max = max;
    }

    // 2. Kept-triangle masks per primitive (union over instances of the same primitive).
    interface PrimitiveEdit { meshIndex: number; primitiveIndex: number; triangles: Uint32Array; keep: Uint8Array }
    const edits = new Map<string, PrimitiveEdit>();
    let flagConflicts = 0;
    for (const inst of layout.instances) {
        const key = `${inst.meshIndex}:${inst.primitiveIndex}`;
        const n = inst.localTriangles.length / 3;
        const flags = sidecar.flags.subarray(inst.triangleBase, inst.triangleBase + n);
        const edit = edits.get(key);
        if (!edit) {
            const keep = new Uint8Array(n);
            for (let t = 0; t < n; t++) keep[t] = flags[t] === SBRX_FLAG_KEEP ? 1 : 0;
            edits.set(key, { meshIndex: inst.meshIndex, primitiveIndex: inst.primitiveIndex, triangles: inst.localTriangles, keep });
        } else {
            for (let t = 0; t < n; t++) {
                const k = flags[t] === SBRX_FLAG_KEEP ? 1 : 0;
                if (k !== edit.keep[t]) flagConflicts++;
                edit.keep[t] |= k;
            }
        }
    }

    // 3. New uint32 index data, appended after the surviving bufferViews.
    const accessors = json.accessors ?? (json.accessors = []);
    const views = json.bufferViews ?? (json.bufferViews = []);
    const meshes = json.meshes ?? [];
    const replacedAccessors = new Set<number>();
    const newIndexViews: Array<{ view: number; data: Buffer }> = [];
    const emptied = new Set<string>();
    let keptTriangles = 0;
    for (const [key, edit] of edits) {
        const prim = meshes[edit.meshIndex].primitives[edit.primitiveIndex];
        let n = 0;
        for (let t = 0; t < edit.keep.length; t++) n += edit.keep[t];
        if (prim.indices !== undefined) replacedAccessors.add(prim.indices);
        if (n === 0) {
            emptied.add(key);
            for (const a of Object.values(prim.attributes ?? {})) replacedAccessors.add(a);
            for (const target of prim.targets ?? []) for (const a of Object.values(target)) replacedAccessors.add(a);
            continue;
        }
        const data = Buffer.alloc(n * 12);
        let w = 0;
        for (let t = 0; t < edit.keep.length; t++) {
            if (!edit.keep[t]) continue;
            data.writeUInt32LE(edit.triangles[t * 3], w);
            data.writeUInt32LE(edit.triangles[t * 3 + 1], w + 4);
            data.writeUInt32LE(edit.triangles[t * 3 + 2], w + 8);
            w += 12;
        }
        views.push({ buffer: 0, byteOffset: 0, byteLength: data.length, target: TARGET_ELEMENT_ARRAY_BUFFER });
        newIndexViews.push({ view: views.length - 1, data });
        accessors.push({ bufferView: views.length - 1, componentType: UNSIGNED_INT, count: n * 3, type: 'SCALAR' });
        prim.indices = accessors.length - 1;
        keptTriangles += n;
    }
    // Primitives that GlbSceneReader skips (non-triangle modes, invalid POSITION) stay untouched.

    // 4. Drop emptied primitives, then emptied meshes (node references are removed, not dangled).
    let removedPrimitives = 0;
    const meshRemap = new Int32Array(meshes.length).fill(-1);
    const keptMeshes: GltfMesh[] = [];
    meshes.forEach((mesh, mi) => {
        const before = mesh.primitives.length;
        mesh.primitives = mesh.primitives.filter((_, pi) => !emptied.has(`${mi}:${pi}`));
        removedPrimitives += before - mesh.primitives.length;
        if (mesh.primitives.length > 0) {
            meshRemap[mi] = keptMeshes.length;
            keptMeshes.push(mesh);
        }
    });
    const removedMeshes = meshes.length - keptMeshes.length;
    if (removedMeshes > 0) {
        json.meshes = keptMeshes;
        for (const node of json.nodes ?? []) {
            if (node.mesh === undefined) continue;
            const mapped = meshRemap[node.mesh];
            if (mapped < 0) {
                delete node.mesh;
                delete node.weights;
                delete node.skin;
            } else {
                node.mesh = mapped;
            }
        }
    }

    // 5. Garbage-collect accessors that only the replaced/removed primitive data used.
    const referencedAccessors = new Set<number>();
    for (const mesh of json.meshes ?? []) {
        for (const prim of mesh.primitives) {
            for (const a of Object.values(prim.attributes ?? {})) referencedAccessors.add(a);
            if (prim.indices !== undefined) referencedAccessors.add(prim.indices);
            for (const target of prim.targets ?? []) for (const a of Object.values(target)) referencedAccessors.add(a);
        }
    }
    for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) referencedAccessors.add(skin.inverseBindMatrices);
    for (const anim of json.animations ?? []) for (const s of anim.samplers ?? []) { referencedAccessors.add(s.input); referencedAccessors.add(s.output); }
    const accessorRemap = new Int32Array(accessors.length);
    const keptAccessors: GltfAccessor[] = [];
    const freedViews = new Set<number>();
    accessors.forEach((acc, i) => {
        if (replacedAccessors.has(i) && !referencedAccessors.has(i)) {
            accessorRemap[i] = -1;
            if (acc.bufferView !== undefined) freedViews.add(acc.bufferView);
            return;
        }
        accessorRemap[i] = keptAccessors.length;
        keptAccessors.push(acc);
    });
    const removedAccessors = accessors.length - keptAccessors.length;
    const mapAccessor = (i: number): number => {
        const m = accessorRemap[i];
        if (m < 0) throw new Error(`internal: accessor ${i} removed while still referenced`);
        return m;
    };
    if (removedAccessors > 0) {
        json.accessors = keptAccessors;
        for (const mesh of json.meshes ?? []) {
            for (const prim of mesh.primitives) {
                for (const k of Object.keys(prim.attributes ?? {})) prim.attributes[k] = mapAccessor(prim.attributes[k]);
                if (prim.indices !== undefined) prim.indices = mapAccessor(prim.indices);
                for (const target of prim.targets ?? []) for (const k of Object.keys(target)) target[k] = mapAccessor(target[k]);
            }
        }
        for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = mapAccessor(skin.inverseBindMatrices);
        for (const anim of json.animations ?? []) for (const s of anim.samplers ?? []) { s.input = mapAccessor(s.input); s.output = mapAccessor(s.output); }
    }

    // 6. Garbage-collect bufferViews no longer referenced by anything.
    const referencedViews = new Set<number>();
    for (const acc of json.accessors ?? []) {
        if (acc.bufferView !== undefined) referencedViews.add(acc.bufferView);
        const sparse = acc.sparse as { indices?: { bufferView?: number }; values?: { bufferView?: number } } | undefined;
        if (sparse?.indices?.bufferView !== undefined) referencedViews.add(sparse.indices.bufferView);
        if (sparse?.values?.bufferView !== undefined) referencedViews.add(sparse.values.bufferView);
    }
    for (const img of json.images ?? []) if (img.bufferView !== undefined) referencedViews.add(img.bufferView);
    collectBufferViewKeys(json, referencedViews);
    const viewRemap = new Int32Array(views.length);
    const newViewOrder: number[] = [];
    views.forEach((_, i) => {
        if (freedViews.has(i) && !referencedViews.has(i)) { viewRemap[i] = -1; return; }
        viewRemap[i] = newViewOrder.length;
        newViewOrder.push(i);
    });
    const removedBufferViews = views.length - newViewOrder.length;

    // 7. Re-pack buffer 0: verbatim copies, each view keeping its original offset modulo 4 so
    //    every accessor keeps its component alignment.
    const appended = new Map<number, Buffer>(newIndexViews.map(e => [e.view, e.data]));
    const chunks: Buffer[] = [];
    let cursor = 0;
    const outViews: GltfBufferView[] = [];
    for (const oldIndex of newViewOrder) {
        const view = views[oldIndex];
        if ((view.buffer ?? 0) !== 0) { outViews.push(view); continue; }
        const data = appended.get(oldIndex) ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        const wantMod = appended.has(oldIndex) ? 0 : (view.byteOffset ?? 0) % 4;
        const pad = (wantMod - (cursor % 4) + 4) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
        const nv: GltfBufferView = { ...view, byteOffset: cursor };
        if (nv.byteOffset === 0 && view.byteOffset === undefined) delete nv.byteOffset;
        outViews.push(nv);
        chunks.push(data);
        cursor += data.length;
    }
    const tailPad = (4 - (cursor % 4)) % 4;
    if (tailPad) { chunks.push(Buffer.alloc(tailPad)); cursor += tailPad; }
    const outBin = Buffer.concat(chunks, cursor);
    json.bufferViews = outViews;
    for (const acc of json.accessors ?? []) {
        if (acc.bufferView !== undefined) acc.bufferView = viewRemap[acc.bufferView];
        const sparse = acc.sparse as { indices?: { bufferView?: number }; values?: { bufferView?: number } } | undefined;
        if (sparse?.indices?.bufferView !== undefined) sparse.indices.bufferView = viewRemap[sparse.indices.bufferView];
        if (sparse?.values?.bufferView !== undefined) sparse.values.bufferView = viewRemap[sparse.values.bufferView];
    }
    for (const img of json.images ?? []) if (img.bufferView !== undefined) img.bufferView = viewRemap[img.bufferView];
    if (json.buffers && json.buffers.length > 0) json.buffers[0].byteLength = outBin.length;
    else json.buffers = [{ byteLength: outBin.length }];

    // Invariant: every image's bytes survive verbatim (cheap structural assertion, not a metric).
    (input.json.images ?? []).forEach((img, i) => {
        if (img.bufferView === undefined) return;
        const a = input.json.bufferViews![img.bufferView];
        const b = json.bufferViews![json.images![i].bufferView!];
        const before = input.bin.subarray(a.byteOffset ?? 0, (a.byteOffset ?? 0) + a.byteLength);
        const after = outBin.subarray(b.byteOffset ?? 0, (b.byteOffset ?? 0) + b.byteLength);
        if (!before.equals(after)) throw new Error(`internal: image ${i} bytes changed during patching`);
    });

    return {
        doc: { json, bin: outBin },
        report: {
            vertexCount: layout.vertexCount,
            triangleCount: layout.triangleCount,
            keptTriangles,
            droppedHiddenTriangles: droppedHidden,
            droppedDegenerateTriangles: droppedDegenerate,
            patchedPositionAccessors: written.size,
            changedVertices,
            rewrittenIndexAccessors: newIndexViews.length,
            removedPrimitives,
            removedMeshes,
            removedAccessors,
            removedBufferViews,
            sharedAccessorConflicts: sharedConflicts,
            instanceFlagConflicts: flagConflicts
        }
    };
}

/** Collects `bufferView` references held anywhere except the accessor / bufferView / image arrays. */
function collectBufferViewKeys(json: GltfJson, out: Set<number>): void {
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) { for (const v of value) visit(v); return; }
        if (!value || typeof value !== 'object') return;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === 'bufferView' && typeof v === 'number') out.add(v);
            else visit(v);
        }
    };
    for (const [k, v] of Object.entries(json)) {
        if (k === 'accessors' || k === 'bufferViews' || k === 'images') continue;
        visit(v);
    }
}

// ---------------------------------------------------------------------------
// Crease-split normals and studio clay
// ---------------------------------------------------------------------------

export interface CreaseSplitResult {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    weldGroups: number;
    degenerateTriangles: number;
}

/**
 * Splits vertex normals at creases. Corners are smoothed with the angle-weighted normals of
 * the faces around their weld group (positions within `weldToleranceM`) whose normals lie within
 * `creaseAngleDeg` of the corner's own face. Output positions keep their exact input float32
 * values; corners sharing a position and an identical normal share one output vertex.
 */
export function computeCreaseSplitNormals(
    positions: Float32Array,
    triangles: Uint32Array,
    creaseAngleDeg = 30,
    weldToleranceM = 1e-3
): CreaseSplitResult {
    const T = triangles.length / 3;
    const V = positions.length / 3;
    const cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180);

    // Weld groups (adjacency only; positions are never merged).
    const groupOf = new Int32Array(V).fill(-1);
    const keyToGroup = new Map<string, number>();
    let groups = 0;
    const inv = 1 / weldToleranceM;
    for (let v = 0; v < V; v++) {
        const key = `${Math.round(positions[v * 3] * inv)},${Math.round(positions[v * 3 + 1] * inv)},${Math.round(positions[v * 3 + 2] * inv)}`;
        let g = keyToGroup.get(key);
        if (g === undefined) { g = groups++; keyToGroup.set(key, g); }
        groupOf[v] = g;
    }

    // Face normals and corner angles.
    const fn = new Float64Array(T * 3);
    const cornerAngle = new Float64Array(T * 3);
    const faceOk = new Uint8Array(T);
    let degenerate = 0;
    for (let t = 0; t < T; t++) {
        const ia = triangles[t * 3] * 3, ib = triangles[t * 3 + 1] * 3, ic = triangles[t * 3 + 2] * 3;
        const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
        const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
        const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) { degenerate++; continue; }
        faceOk[t] = 1;
        fn[t * 3] = nx / len; fn[t * 3 + 1] = ny / len; fn[t * 3 + 2] = nz / len;
        const pts = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
        for (let k = 0; k < 3; k++) {
            const p = pts[k], q = pts[(k + 1) % 3], r = pts[(k + 2) % 3];
            const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
            const wx = r[0] - p[0], wy = r[1] - p[1], wz = r[2] - p[2];
            const lu = Math.hypot(ux, uy, uz), lw = Math.hypot(wx, wy, wz);
            const c = lu > 0 && lw > 0 ? (ux * wx + uy * wy + uz * wz) / (lu * lw) : 1;
            cornerAngle[t * 3 + k] = Math.acos(Math.max(-1, Math.min(1, c)));
        }
    }

    // Corners per weld group (CSR).
    const groupStart = new Int32Array(groups + 1);
    for (let c = 0; c < T * 3; c++) groupStart[groupOf[triangles[c]] + 1]++;
    for (let g = 0; g < groups; g++) groupStart[g + 1] += groupStart[g];
    const fill = groupStart.slice(0, groups);
    const groupCorners = new Int32Array(T * 3);
    for (let c = 0; c < T * 3; c++) groupCorners[fill[groupOf[triangles[c]]]++] = c;

    // Per-corner normal and output vertex.
    const outPos: number[] = [];
    const outNrm: number[] = [];
    const indices = new Uint32Array(T * 3);
    const emitted = new Map<number, number[]>(); // group -> output vertex ids
    for (let c = 0; c < T * 3; c++) {
        const t = (c / 3) | 0;
        const v = triangles[c];
        const g = groupOf[v];
        let sx = 0, sy = 0, sz = 0;
        for (let i = groupStart[g]; i < groupStart[g + 1]; i++) {
            const c2 = groupCorners[i];
            const t2 = (c2 / 3) | 0;
            if (!faceOk[t2]) continue;
            if (faceOk[t]) {
                const d = fn[t * 3] * fn[t2 * 3] + fn[t * 3 + 1] * fn[t2 * 3 + 1] + fn[t * 3 + 2] * fn[t2 * 3 + 2];
                if (d < cosCrease) continue;
            }
            const w = cornerAngle[c2];
            sx += w * fn[t2 * 3]; sy += w * fn[t2 * 3 + 1]; sz += w * fn[t2 * 3 + 2];
        }
        let len = Math.hypot(sx, sy, sz);
        if (len < 1e-12 && faceOk[t]) { sx = fn[t * 3]; sy = fn[t * 3 + 1]; sz = fn[t * 3 + 2]; len = 1; }
        const nx = len < 1e-12 ? 0 : Math.fround(sx / len);
        const ny = len < 1e-12 ? 1 : Math.fround(sy / len);
        const nz = len < 1e-12 ? 0 : Math.fround(sz / len);
        const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
        let list = emitted.get(g);
        if (!list) { list = []; emitted.set(g, list); }
        let out = -1;
        for (const o of list) {
            if (outPos[o * 3] === px && outPos[o * 3 + 1] === py && outPos[o * 3 + 2] === pz
                && outNrm[o * 3] === nx && outNrm[o * 3 + 1] === ny && outNrm[o * 3 + 2] === nz) { out = o; break; }
        }
        if (out < 0) {
            out = outPos.length / 3;
            outPos.push(px, py, pz);
            outNrm.push(nx, ny, nz);
            list.push(out);
        }
        indices[c] = out;
    }
    return {
        positions: Float32Array.from(outPos),
        normals: Float32Array.from(outNrm),
        indices,
        weldGroups: groups,
        degenerateTriangles: degenerate
    };
}

export interface ClayOptions {
    creaseAngleDeg?: number;
    weldToleranceM?: number;
    materialName?: string;
    /** Linear base colour; defaults to the 18% studio grey clay used across Scratchbox stages. */
    baseColor?: [number, number, number];
    roughness?: number;
    metallic?: number;
    doubleSided?: boolean;
    meshName?: string;
    nodeName?: string;
    generator?: string;
    /** Provenance written to the document's top-level `extras`. */
    extras?: Record<string, unknown>;
}

export interface ClayReport {
    triangleCount: number;
    inputVertexCount: number;
    outputVertexCount: number;
    weldGroups: number;
    degenerateTriangles: number;
    creaseAngleDeg: number;
}

/**
 * Flattens every triangle primitive of the scene (world space, no node transforms written) into
 * one clay mesh with POSITION + NORMAL (crease-split) and uint32 indices. UV, COLOR and TANGENT
 * attributes, images and source materials are dropped.
 */
export function toClay(input: GlbDocument, options: ClayOptions = {}): { doc: GlbDocument; report: ClayReport } {
    const creaseAngleDeg = options.creaseAngleDeg ?? 30;
    const geometry = readSceneGeometry(input);
    const split = computeCreaseSplitNormals(geometry.positions, geometry.triangles, creaseAngleDeg, options.weldToleranceM ?? 1e-3);
    const vertexCount = split.positions.length / 3;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < split.positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const x = split.positions[i + k];
            if (x < min[k]) min[k] = x;
            if (x > max[k]) max[k] = x;
        }
    }
    const color = options.baseColor ?? [0.55, 0.57, 0.6];
    const name = options.meshName ?? 'ScanStudioGreyClay';
    const gltf: GltfJson = {
        asset: { version: '2.0', generator: options.generator ?? 'Scratchbox glb-geometry-patcher' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: options.nodeName ?? name, mesh: 0 }],
        meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }] }],
        materials: [{
            name: options.materialName ?? 'Mat_StudioGreyClay',
            pbrMetallicRoughness: {
                baseColorFactor: [color[0], color[1], color[2], 1],
                metallicFactor: options.metallic ?? 0,
                roughnessFactor: options.roughness ?? 0.85
            },
            doubleSided: options.doubleSided ?? false
        }],
        accessors: [
            { bufferView: 0, componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max },
            { bufferView: 1, componentType: FLOAT, count: vertexCount, type: 'VEC3' },
            { bufferView: 2, componentType: UNSIGNED_INT, count: split.indices.length, type: 'SCALAR' }
        ],
        bufferViews: [
            { buffer: 0, byteLength: 0, target: TARGET_ARRAY_BUFFER },
            { buffer: 0, byteLength: 0, target: TARGET_ARRAY_BUFFER },
            { buffer: 0, byteLength: 0, target: TARGET_ELEMENT_ARRAY_BUFFER }
        ],
        buffers: [{ byteLength: 0 }]
    };
    if (options.extras) gltf.extras = options.extras;
    const packed = GltfBinaryPacker.packGlb(gltf, [
        Buffer.from(split.positions.buffer, split.positions.byteOffset, split.positions.byteLength),
        Buffer.from(split.normals.buffer, split.normals.byteOffset, split.normals.byteLength),
        Buffer.from(split.indices.buffer, split.indices.byteOffset, split.indices.byteLength)
    ]);
    return {
        doc: parseGlb(packed.glbBuffer),
        report: {
            triangleCount: split.indices.length / 3,
            inputVertexCount: geometry.positions.length / 3,
            outputVertexCount: vertexCount,
            weldGroups: split.weldGroups,
            degenerateTriangles: split.degenerateTriangles,
            creaseAngleDeg
        }
    };
}
