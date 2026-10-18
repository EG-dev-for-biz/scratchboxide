/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Box-projection texturing of a binary glTF 2.0 scene.
 *
 * Every triangle is projected onto the axis plane of its dominant world-space normal axis. A UV is the position in
 * metres along the two other world axes divided by a tile size in metres, so a texture tile is a fixed physical size
 * wherever it lands and the mapping is never stretched. A vertex shared by triangles that face different axes is
 * split into one vertex per axis, so each copy carries the UV of its own projection; positions, normals, every other
 * attribute and the triangle topology are carried over unchanged, and node transforms are untouched (the projection
 * is done in each node's world space and stored per vertex in the node's local mesh).
 *
 * The three maps of each texture set are embedded as PNG images, and one material per (texture set, UV set)
 * replaces the material of every projected primitive: albedo -> baseColorTexture, the packed ORM image -> both the
 * occlusionTexture (R) and the metallicRoughnessTexture (G roughness, B metal) by the glTF convention, the normal
 * map -> normalTexture, all through one REPEAT sampler.
 *
 * It is a projection, not a shader: where the dominant axis changes across a smooth surface there is a visible
 * change of texture direction. That is the price of a mapping that needs no UV unwrap and never stretches.
 */

import {
    COMPONENT_SIZE,
    TYPE_COMPONENTS,
    enumerateSceneTriangles,
    parseGlb,
    resolveAccessor,
    serializeGlb,
    type GlbDocument,
    type GltfJson,
    type GltfObject,
    type ScenePrimitiveInstance,
    type SkippedScenePrimitive
} from './glb-geometry-patcher';
import { AdaptivePbrInputError, AdaptivePbrOutputError, AdaptivePbrPartSelectionError } from './adaptive-pbr-errors';

/** u = +world[uAxis]/tile, v = -world[vAxis]/tile (glTF's v grows downward, so world +axis reads upward in the image). */
export const BOX_PROJECTION_UV_AXES: ReadonlyArray<readonly [uAxis: number, vAxis: number]> = [
    [2, 1], // dominant X: u from Z, v from Y
    [0, 2], // dominant Y: u from X, v from Z
    [0, 1]  // dominant Z: u from X, v from Y
];
export const BOX_PROJECTION_UV_CONVENTION =
    'per triangle: dominant world-normal axis X -> (u,v) = (z, -y)/tile, Y -> (x, -z)/tile, Z -> (x, -y)/tile, in metres; v is negated for glTF\'s top-left origin';

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;
const SAMPLER_LINEAR = 9729;
const SAMPLER_LINEAR_MIPMAP_LINEAR = 9987;
const SAMPLER_REPEAT = 10497;

/** Float32 spacing at the largest UV may not exceed this fraction of a texel (past it the texture visibly shimmers). */
const MAX_UV_QUANTISATION_TEXELS = 0.25;

interface NodeJson extends GltfObject {
    name?: string;
    mesh?: number;
    children?: number[];
    skin?: number;
}
interface MeshJson extends GltfObject {
    name?: string;
    primitives: PrimitiveJson[];
}
interface PrimitiveJson extends GltfObject {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
    targets?: Array<Record<string, number>>;
    extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scene inspection
// ---------------------------------------------------------------------------

export interface ScenePartInfo {
    nodeIndex: number;
    nodeName?: string;
    meshIndex?: number;
    meshName?: string;
    /** Parent node index, -1 for roots. */
    parent: number;
    children: number[];
    /** Triangle primitives this node renders itself (0 for group nodes and nodes without a mesh). */
    trianglePrimitives: number;
    triangles: number;
    /** World-space bounds of the node's own triangles; undefined when it renders none. */
    worldBounds?: { min: [number, number, number]; max: [number, number, number] };
}

export interface SceneInspection {
    parts: ScenePartInfo[];
    instances: ScenePrimitiveInstance[];
    /** World-space largest bounding-box side of each instance's triangles, parallel to `instances`. */
    instanceExtentsMeters: number[];
    /** Primitives of rendered meshes that are not triangle lists and are therefore left untouched. */
    skippedNonTriangle: Array<SkippedScenePrimitive & { nodeName?: string; meshName?: string }>;
}

function nodesOf(json: GltfJson): NodeJson[] {
    return (json.nodes ?? []) as unknown as NodeJson[];
}
function meshesOf(json: GltfJson): MeshJson[] {
    return (json.meshes ?? []) as unknown as MeshJson[];
}

/** One line per node: `#3 node "tube" (mesh "tube_mesh")`, the form the caller sees in a part-selection error. */
export function describeParts(parts: ScenePartInfo[], limit = 200): string[] {
    const lines = parts.slice(0, limit).map(p => {
        const bits = [`#${p.nodeIndex} node ${p.nodeName !== undefined ? JSON.stringify(p.nodeName) : '(unnamed)'}`];
        if (p.meshIndex !== undefined) bits.push(`(mesh ${p.meshName !== undefined ? JSON.stringify(p.meshName) : '(unnamed)'}, ${p.triangles} triangles)`);
        else if (p.children.length) bits.push(`(group of ${p.children.length})`);
        return bits.join(' ');
    });
    if (parts.length > limit) lines.push(`... and ${parts.length - limit} more nodes`);
    return lines;
}

function assertReadableGeometry(doc: GlbDocument): void {
    const json = doc.json;
    const compressed = (json.extensionsRequired ?? []).filter(e => e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression');
    const meshoptViews = (json.bufferViews ?? []).some(v => v.extensions !== undefined);
    if ((json.buffers ?? []).length > 1 || (json.buffers ?? [])[0]?.uri !== undefined) {
        throw new AdaptivePbrInputError('Box projection reads a GLB with one embedded BIN buffer; this file references external or several buffers.', { buffers: (json.buffers ?? []).length });
    }
    if (compressed.length || meshoptViews) {
        throw new AdaptivePbrInputError(
            `This GLB stores its geometry compressed (${compressed.join(', ') || 'bufferView extensions'}); box projection reads raw accessors and will not guess at compressed data. Decompress it first.`,
            { extensionsRequired: json.extensionsRequired }
        );
    }
}

/**
 * Reads the scene the way a renderer would: every node, which of them render triangles, where those triangles are in
 * world space. Throws a typed error for geometry that cannot be projected (no or unreadable POSITION on a triangle
 * primitive, skinned meshes, compressed or quantised positions); lines and points are reported, not failed.
 */
export function inspectScene(input: Buffer | GlbDocument): SceneInspection {
    const doc = Buffer.isBuffer(input) ? parseGlb(input) : input;
    assertReadableGeometry(doc);
    const nodes = nodesOf(doc.json);
    const meshes = meshesOf(doc.json);

    const skipped: SkippedScenePrimitive[] = [];
    const layout = enumerateSceneTriangles(doc, skipped);

    const named = (s: SkippedScenePrimitive) => ({
        ...s,
        nodeName: nodes[s.nodeIndex]?.name,
        meshName: meshes[s.meshIndex]?.name
    });
    const broken = skipped.filter(s => s.kind !== 'non_triangle_mode');
    if (broken.length) {
        const list = broken.slice(0, 10).map(s => {
            const n = named(s);
            return `node #${s.nodeIndex} ${JSON.stringify(n.nodeName ?? '')} primitive ${s.primitiveIndex}: ${s.kind === 'missing_position' ? 'no POSITION attribute' : 'POSITION is not a readable VEC3 accessor (no bufferView, sparse-only, or out of range)'}`;
        });
        throw new AdaptivePbrInputError(
            `${broken.length} triangle primitive(s) cannot be box-projected: ${list.join('; ')}${broken.length > 10 ? '; ...' : ''}`,
            { primitives: broken.map(named) }
        );
    }

    const parent = new Array<number>(nodes.length).fill(-1);
    nodes.forEach((n, i) => (n.children ?? []).forEach(c => { if (c >= 0 && c < nodes.length) parent[c] = i; }));
    const parts: ScenePartInfo[] = nodes.map((n, i) => ({
        nodeIndex: i,
        nodeName: n.name,
        meshIndex: n.mesh !== undefined && n.mesh >= 0 && n.mesh < meshes.length ? n.mesh : undefined,
        meshName: n.mesh !== undefined ? meshes[n.mesh]?.name : undefined,
        parent: parent[i],
        children: (n.children ?? []).filter(c => c >= 0 && c < nodes.length),
        trianglePrimitives: 0,
        triangles: 0
    }));

    const instanceExtents: number[] = [];
    for (const inst of layout.instances) {
        const node = nodes[inst.nodeIndex];
        if (node.skin !== undefined) {
            throw new AdaptivePbrInputError(
                `Node #${inst.nodeIndex} ${JSON.stringify(node.name ?? '')} is skinned; box projection keys the mesh to its world placement and a skinned mesh has none. Texture the unskinned asset instead.`,
                { nodeIndex: inst.nodeIndex }
            );
        }
        const pos = readFloatPositions(doc, inst);
        const m = inst.world;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < inst.localTriangles.length; i++) {
            const v = inst.localTriangles[i] * 3;
            const x = pos[v], y = pos[v + 1], z = pos[v + 2];
            const w0 = m ? m[0] * x + m[4] * y + m[8] * z + m[12] : x;
            const w1 = m ? m[1] * x + m[5] * y + m[9] * z + m[13] : y;
            const w2 = m ? m[2] * x + m[6] * y + m[10] * z + m[14] : z;
            if (w0 < min[0]) min[0] = w0; if (w0 > max[0]) max[0] = w0;
            if (w1 < min[1]) min[1] = w1; if (w1 > max[1]) max[1] = w1;
            if (w2 < min[2]) min[2] = w2; if (w2 > max[2]) max[2] = w2;
        }
        const empty = inst.localTriangles.length === 0;
        instanceExtents.push(empty ? 0 : Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
        const part = parts[inst.nodeIndex];
        part.trianglePrimitives += 1;
        part.triangles += inst.localTriangles.length / 3;
        if (!empty) {
            const wb = part.worldBounds ?? { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
            for (let a = 0; a < 3; a++) { wb.min[a] = Math.min(wb.min[a], min[a]); wb.max[a] = Math.max(wb.max[a], max[a]); }
            part.worldBounds = wb;
        }
    }
    return { parts, instances: layout.instances, instanceExtentsMeters: instanceExtents, skippedNonTriangle: skipped.map(named) };
}

/** The local-space float32 POSITION data of one primitive instance as float64. */
function readFloatPositions(doc: GlbDocument, inst: ScenePrimitiveInstance): Float64Array {
    const acc = (doc.json.accessors ?? [])[inst.positionAccessor];
    if (acc.componentType !== FLOAT || acc.normalized || acc.sparse) {
        throw new AdaptivePbrInputError(
            `POSITION accessor ${inst.positionAccessor} of node #${inst.nodeIndex} is ${acc.sparse ? 'sparse' : 'not plain float32'} (quantised or sparse positions are not supported)`,
            { accessor: inst.positionAccessor }
        );
    }
    const r = resolveAccessor(doc, inst.positionAccessor)!;
    const out = new Float64Array(r.count * 3);
    for (let v = 0; v < r.count; v++) {
        const p = r.offset + v * r.stride;
        out[v * 3] = doc.bin.readFloatLE(p);
        out[v * 3 + 1] = doc.bin.readFloatLE(p + 4);
        out[v * 3 + 2] = doc.bin.readFloatLE(p + 8);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Part selection (exact names or indices; no matching of any other kind)
// ---------------------------------------------------------------------------

export interface PartSelection {
    nodes: ReadonlyArray<string | number>;
}

export interface PartSelectionResult {
    /** For every node that renders triangles and falls under some entry: the entry that governs it. */
    entryOfNode: Map<number, number>;
    /** The nodes each entry named directly (before expanding groups to their descendants). */
    directNodes: number[][];
}

/**
 * Resolves selections to nodes. A string is an exact node name or an exact mesh name (every node carrying it); a number
 * is a node index; a string that is no name but spells a node index is read as that index. Naming a group node selects
 * its descendants. Where selections overlap, the one naming the closest ancestor-or-self wins; two selections naming the
 * same closest node are a conflict. Anything that matches nothing fails with the real names listed.
 */
export function resolvePartSelections(scene: SceneInspection, selections: ReadonlyArray<PartSelection>): PartSelectionResult {
    const parts = scene.parts;
    const available = describeParts(parts);
    const directNodes: number[][] = [];

    selections.forEach((sel, entryIndex) => {
        if (!sel || !Array.isArray(sel.nodes) || sel.nodes.length === 0) {
            throw new AdaptivePbrPartSelectionError(`partMaterials[${entryIndex}].nodes must list at least one node name or index`, available, { entryIndex });
        }
        const matched = new Set<number>();
        const missing: Array<string | number> = [];
        for (const token of sel.nodes) {
            const hits: number[] = [];
            if (typeof token === 'number') {
                if (Number.isInteger(token) && token >= 0 && token < parts.length) hits.push(token);
            } else if (typeof token === 'string') {
                for (const p of parts) if (p.nodeName === token || (p.meshIndex !== undefined && p.meshName === token)) hits.push(p.nodeIndex);
                if (hits.length === 0 && /^(0|[1-9]\d*)$/.test(token) && Number(token) < parts.length) hits.push(Number(token));
            } else {
                throw new AdaptivePbrPartSelectionError(`partMaterials[${entryIndex}].nodes holds a ${typeof token}; each item must be a node/mesh name (string) or a node index (number)`, available, { entryIndex });
            }
            if (hits.length === 0) missing.push(token);
            hits.forEach(h => matched.add(h));
        }
        if (missing.length) {
            throw new AdaptivePbrPartSelectionError(
                `partMaterials[${entryIndex}] names ${missing.map(m => JSON.stringify(m)).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the scene. Real parts:\n${available.join('\n')}`,
                available, { entryIndex, missing }
            );
        }
        directNodes.push([...matched]);
    });

    // closest named ancestor-or-self per geometry node
    const best = new Map<number, { entry: number; distance: number; tiedWith?: number }>();
    directNodes.forEach((direct, entryIndex) => {
        const reach = new Map<number, number>(); // node -> distance from the closest node this entry named
        const walk = (n: number, d: number): void => {
            const prev = reach.get(n);
            if (prev !== undefined && prev <= d) return;
            reach.set(n, d);
            parts[n].children.forEach(c => walk(c, d + 1));
        };
        direct.forEach(n => walk(n, 0));
        for (const [n, d] of reach) {
            if (parts[n].trianglePrimitives === 0) continue;
            const cur = best.get(n);
            if (!cur || d < cur.distance) best.set(n, { entry: entryIndex, distance: d });
            else if (d === cur.distance && cur.entry !== entryIndex) cur.tiedWith = entryIndex;
        }
    });
    for (const [n, b] of best) {
        if (b.tiedWith !== undefined) {
            throw new AdaptivePbrPartSelectionError(
                `partMaterials[${b.entry}] and partMaterials[${b.tiedWith}] both name node #${n} ${JSON.stringify(parts[n].nodeName ?? '')} (or the same closest group around it); one part cannot take two materials`,
                available, { nodeIndex: n, entries: [b.entry, b.tiedWith] }
            );
        }
    }
    directNodes.forEach((direct, entryIndex) => {
        const geometry = [...best.entries()].filter(([, b]) => b.entry === entryIndex);
        if (geometry.length === 0) {
            throw new AdaptivePbrPartSelectionError(
                `partMaterials[${entryIndex}] names ${direct.map(d => `#${d} ${JSON.stringify(parts[d].nodeName ?? '')}`).join(', ')}, but nothing at or below ${direct.length === 1 ? 'it' : 'them'} renders triangles (or a more specific entry claims all of it)`,
                available, { entryIndex, direct }
            );
        }
    });
    const entryOfNode = new Map<number, number>();
    for (const [n, b] of best) entryOfNode.set(n, b.entry);
    return { entryOfNode, directNodes };
}

// ---------------------------------------------------------------------------
// Applying the projection
// ---------------------------------------------------------------------------

export interface BoxProjectionTextureSet {
    /** Unique, file-name-safe label used for the image, texture and material names. */
    label: string;
    width: number;
    height: number;
    albedoPng: Buffer;
    normalPng: Buffer;
    /** R = occlusion, G = roughness, B = metallic. */
    ormPng: Buffer;
    /** Free-form description written to the material's extras.scratchbox. */
    extras?: Record<string, unknown>;
}

export interface BoxProjectionPlan {
    /** Every node that renders triangles: its texture set and tile size. A node without an entry is an error. */
    nodes: ReadonlyMap<number, { setIndex: number; tileSizeMeters: number }>;
    sets: ReadonlyArray<BoxProjectionTextureSet>;
    /** Keep each primitive's TEXCOORD_0 and write the box UVs to the next free TEXCOORD_n instead of replacing it. */
    preserveExistingUvs: boolean;
    /** Keep COLOR_n (it multiplies baseColor). Default is to drop them from the projected primitives. */
    preserveVertexColors: boolean;
}

export interface BoxProjectionReport {
    method: 'box_projection_uv';
    uvConvention: string;
    /** Primitives per UV attribute the box UVs were written to. */
    uvSets: Record<string, number>;
    projectedNodes: number;
    projectedPrimitives: number;
    /** Triangle-list primitives whose indices are all invalid or that hold no triangle; left as they were. */
    emptyPrimitives: number;
    skippedNonTrianglePrimitives: Array<{ nodeIndex: number; nodeName?: string; primitiveIndex: number; mode: number }>;
    triangles: number;
    droppedInvalidTriangles: number;
    degenerateTriangles: number;
    /** Triangles by dominant axis. */
    axisTriangles: { x: number; y: number; z: number };
    /** Distinct vertices the triangles used before, and the vertices after splitting them per projection axis. */
    verticesBefore: number;
    verticesAfter: number;
    /** Attributes removed from projected primitives, with the number of primitives each was removed from. */
    droppedAttributes: Record<string, number>;
    maxAbsUv: number;
    materialsCreated: number;
    imagesEmbedded: number;
    /** Materials of the input that no primitive uses any more (left in place, with their images). */
    unusedInputMaterials: number;
    geometryCleanup: { performed: boolean; removedAccessors: number; removedBufferViews: number; reasonSkipped?: string };
    inputBytes: number;
    outputBytes: number;
}

interface BuildState {
    doc: GlbDocument;
    chunks: Buffer[];
    cursor: number; // next free byte in the output BIN
}

function roundUp(n: number, a: number): number {
    return Math.ceil(n / a) * a;
}

function addBufferView(state: BuildState, data: Buffer, extra: { target?: number; byteStride?: number } = {}): number {
    const aligned = roundUp(state.cursor, 4);
    if (aligned > state.cursor) state.chunks.push(Buffer.alloc(aligned - state.cursor));
    state.chunks.push(data);
    const views = (state.doc.json.bufferViews ??= []);
    views.push({ buffer: 0, byteOffset: aligned, byteLength: data.length, ...extra });
    state.cursor = aligned + data.length;
    return views.length - 1;
}

function addAccessor(state: BuildState, accessor: GltfObject): number {
    const accessors = (state.doc.json.accessors ??= []);
    accessors.push(accessor as never);
    return accessors.length - 1;
}

/** Copies the elements `source[i]` of an accessor into a new tightly packed accessor of `source.length` elements. */
function duplicateAccessor(state: BuildState, accessorIndex: number, source: Uint32Array, isVertexAttribute: boolean, owner: string): number {
    const doc = state.doc;
    const acc = (doc.json.accessors ?? [])[accessorIndex] as GltfObject & { bufferView?: number; sparse?: unknown; componentType: number; type: string; count: number; normalized?: boolean };
    if (acc.sparse) throw new AdaptivePbrInputError(`${owner}: accessor ${accessorIndex} is sparse; it cannot be re-indexed for split vertices`, { accessor: accessorIndex });
    const out: GltfObject = { componentType: acc.componentType, count: source.length, type: acc.type };
    if (acc.normalized) out.normalized = true;
    if (acc.bufferView === undefined) return addAccessor(state, out); // an all-zero accessor stays one
    const r = resolveAccessor(doc, accessorIndex);
    if (!r) throw new AdaptivePbrInputError(`${owner}: accessor ${accessorIndex} has no readable data (out of range or in an unsupported buffer)`, { accessor: accessorIndex });
    const elementSize = (TYPE_COMPONENTS[acc.type] ?? 0) * (COMPONENT_SIZE[acc.componentType] ?? 0);
    const stride = isVertexAttribute ? roundUp(elementSize, 4) : elementSize;
    const data = Buffer.alloc(source.length * stride);
    for (let i = 0; i < source.length; i++) {
        const from = r.offset + source[i] * r.stride;
        doc.bin.copy(data, i * stride, from, from + elementSize);
    }
    out.bufferView = addBufferView(state, data, {
        target: isVertexAttribute ? TARGET_ARRAY_BUFFER : undefined,
        ...(stride !== elementSize ? { byteStride: stride } : {})
    });
    return addAccessor(state, out);
}

interface Projection {
    /** New vertex -> source vertex. */
    source: Uint32Array;
    uv: Float32Array;
    /** New vertex indices, three per triangle. */
    corners: Uint32Array;
    degenerate: number;
    axisTriangles: [number, number, number];
    usedSourceVertices: number;
    maxAbsUv: number;
    /** Local-space bounds of the emitted vertices (the POSITION accessor's min/max). */
    positionMin: [number, number, number];
    positionMax: [number, number, number];
}

function projectInstance(doc: GlbDocument, inst: ScenePrimitiveInstance, tileSizeMeters: number): Projection {
    const local = readFloatPositions(doc, inst);
    const vertexCount = local.length / 3;
    const m = inst.world;
    const world = new Float64Array(local.length);
    for (let v = 0; v < vertexCount; v++) {
        const x = local[v * 3], y = local[v * 3 + 1], z = local[v * 3 + 2];
        world[v * 3] = m ? m[0] * x + m[4] * y + m[8] * z + m[12] : x;
        world[v * 3 + 1] = m ? m[1] * x + m[5] * y + m[9] * z + m[13] : y;
        world[v * 3 + 2] = m ? m[2] * x + m[6] * y + m[10] * z + m[14] : z;
    }
    const tris = inst.localTriangles;
    const triCount = tris.length / 3;
    const slot = new Int32Array(vertexCount * 3).fill(-1); // (source vertex, axis) -> new vertex
    const source: number[] = [];
    const axisOfNew: number[] = [];
    const corners = new Uint32Array(tris.length);
    const axisTriangles: [number, number, number] = [0, 0, 0];
    let degenerate = 0;
    const seenSource = new Uint8Array(vertexCount);
    let usedSourceVertices = 0;
    for (let t = 0; t < triCount; t++) {
        const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
        const e1x = world[b] - world[a], e1y = world[b + 1] - world[a + 1], e1z = world[b + 2] - world[a + 2];
        const e2x = world[c] - world[a], e2y = world[c + 1] - world[a + 1], e2z = world[c + 2] - world[a + 2];
        const nx = Math.abs(e1y * e2z - e1z * e2y), ny = Math.abs(e1z * e2x - e1x * e2z), nz = Math.abs(e1x * e2y - e1y * e2x);
        if (nx + ny + nz < 1e-30) degenerate++;
        const axis = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
        axisTriangles[axis]++;
        for (let k = 0; k < 3; k++) {
            const v = tris[t * 3 + k];
            if (!seenSource[v]) { seenSource[v] = 1; usedSourceVertices++; }
            const key = v * 3 + axis;
            let id = slot[key];
            if (id < 0) {
                id = source.length;
                source.push(v);
                axisOfNew.push(axis);
                slot[key] = id;
            }
            corners[t * 3 + k] = id;
        }
    }
    const uv = new Float32Array(source.length * 2);
    let maxAbsUv = 0;
    for (let i = 0; i < source.length; i++) {
        const [uAxis, vAxis] = BOX_PROJECTION_UV_AXES[axisOfNew[i]];
        const u = world[source[i] * 3 + uAxis] / tileSizeMeters;
        const v = -world[source[i] * 3 + vAxis] / tileSizeMeters;
        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
        const mag = Math.max(Math.abs(u), Math.abs(v));
        if (mag > maxAbsUv) maxAbsUv = mag;
    }
    const positionMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const positionMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const v of source) {
        for (let a = 0; a < 3; a++) {
            const val = local[v * 3 + a];
            if (val < positionMin[a]) positionMin[a] = val;
            if (val > positionMax[a]) positionMax[a] = val;
        }
    }
    return { source: Uint32Array.from(source), uv, corners, degenerate, axisTriangles, usedSourceVertices, maxAbsUv, positionMin, positionMax };
}

const NUMBERED_COLOR = /^COLOR_\d+$/;

/**
 * Applies the plan to a GLB and returns the new GLB and a report. Throws a typed error when any projected primitive
 * cannot be rebuilt; it never returns the input as if it had been processed.
 */
export function applyBoxProjectionMaterials(glb: Buffer, plan: BoxProjectionPlan): { glb: Buffer; report: BoxProjectionReport } {
    const doc = parseGlb(glb);
    const scene = inspectScene(doc);
    const json = doc.json;
    const nodes = nodesOf(json);
    const meshes = meshesOf(json);

    if (scene.instances.length === 0) throw new AdaptivePbrInputError('This GLB renders no triangle primitives, so there is nothing to texture.');
    for (const part of scene.parts) {
        if (part.trianglePrimitives > 0 && !plan.nodes.has(part.nodeIndex)) {
            throw new AdaptivePbrOutputError(`The plan assigns no texture set to node #${part.nodeIndex} ${JSON.stringify(part.nodeName ?? '')}, which renders triangles`, { nodeIndex: part.nodeIndex });
        }
    }
    for (const [nodeIndex, a] of plan.nodes) {
        if (!plan.sets[a.setIndex]) throw new AdaptivePbrOutputError(`Node #${nodeIndex} points at texture set ${a.setIndex}, which does not exist`);
        if (!(a.tileSizeMeters > 0) || !Number.isFinite(a.tileSizeMeters)) {
            throw new AdaptivePbrOutputError(`Node #${nodeIndex} has tile size ${a.tileSizeMeters}; it must be a positive number of metres`);
        }
    }

    const state: BuildState = { doc, chunks: [], cursor: roundUp(doc.bin.length, 4) };
    const originalBin = doc.bin;
    const replacedAccessors = new Set<number>();
    const noteReplaced = (p: PrimitiveJson): void => {
        Object.values(p.attributes ?? {}).forEach(a => replacedAccessors.add(a));
        if (p.indices !== undefined) replacedAccessors.add(p.indices);
        (p.targets ?? []).forEach(t => Object.values(t).forEach(a => replacedAccessors.add(a)));
    };

    // Texture sets -> images, textures, one shared REPEAT sampler
    json.samplers = (json.samplers as GltfObject[] | undefined) ?? [];
    (json.samplers as GltfObject[]).push({ magFilter: SAMPLER_LINEAR, minFilter: SAMPLER_LINEAR_MIPMAP_LINEAR, wrapS: SAMPLER_REPEAT, wrapT: SAMPLER_REPEAT });
    const samplerIndex = (json.samplers as GltfObject[]).length - 1;
    const images = (json.images ??= []);
    const textures = ((json as GltfObject).textures ??= []) as GltfObject[];
    const setTextures = plan.sets.map(set => {
        const addTexture = (suffix: string, png: Buffer): number => {
            images.push({ bufferView: addBufferView(state, png), mimeType: 'image/png', name: `${set.label}_${suffix}` });
            textures.push({ sampler: samplerIndex, source: images.length - 1, name: `${set.label}_${suffix}` });
            return textures.length - 1;
        };
        return { albedo: addTexture('albedo', set.albedoPng), normal: addTexture('normal', set.normalPng), orm: addTexture('orm', set.ormPng) };
    });
    const materials = (json.materials ??= []) as GltfObject[];
    const originalMaterialCount = materials.length;
    const materialByKey = new Map<string, number>();
    const materialFor = (setIndex: number, texCoord: number): number => {
        const key = `${setIndex}:${texCoord}`;
        const have = materialByKey.get(key);
        if (have !== undefined) return have;
        const set = plan.sets[setIndex];
        const t = setTextures[setIndex];
        const info = (index: number, more: GltfObject = {}): GltfObject => ({ index, ...(texCoord ? { texCoord } : {}), ...more });
        materials.push({
            name: texCoord ? `${set.label}_uv${texCoord}` : set.label,
            pbrMetallicRoughness: {
                baseColorFactor: [1, 1, 1, 1],
                baseColorTexture: info(t.albedo),
                metallicFactor: 1,
                roughnessFactor: 1,
                metallicRoughnessTexture: info(t.orm)
            },
            normalTexture: info(t.normal, { scale: 1 }),
            occlusionTexture: info(t.orm, { strength: 1 }),
            extras: { scratchbox: { textureSet: set.label, textureSizePx: [set.width, set.height], uvSet: `TEXCOORD_${texCoord}`, ...set.extras } }
        });
        materialByKey.set(key, materials.length - 1);
        return materials.length - 1;
    };

    const instancesByNode = new Map<number, ScenePrimitiveInstance[]>();
    scene.instances.forEach(inst => {
        const list = instancesByNode.get(inst.nodeIndex) ?? [];
        list.push(inst);
        instancesByNode.set(inst.nodeIndex, list);
    });

    // A mesh several nodes use is cloned per node, since each projects in its own world placement. When every user is
    // projected, the last one takes the original mesh so no unused copy is left behind.
    const meshUsers = new Map<number, number>();
    const projectedMeshUsers = new Map<number, number>();
    nodes.forEach(n => { if (n.mesh !== undefined) meshUsers.set(n.mesh, (meshUsers.get(n.mesh) ?? 0) + 1); });
    for (const nodeIndex of instancesByNode.keys()) {
        const mesh = nodes[nodeIndex].mesh as number;
        projectedMeshUsers.set(mesh, (projectedMeshUsers.get(mesh) ?? 0) + 1);
    }
    const cloneBudget = new Map<number, number>(); // clones still to hand out per mesh
    for (const [mesh, users] of meshUsers) {
        const projected = projectedMeshUsers.get(mesh) ?? 0;
        if (projected > 0 && users > 1) cloneBudget.set(mesh, users === projected ? projected - 1 : projected);
    }

    const report: BoxProjectionReport = {
        method: 'box_projection_uv',
        uvConvention: BOX_PROJECTION_UV_CONVENTION,
        uvSets: {},
        projectedNodes: instancesByNode.size,
        projectedPrimitives: 0,
        emptyPrimitives: 0,
        skippedNonTrianglePrimitives: scene.skippedNonTriangle.map(s => ({ nodeIndex: s.nodeIndex, nodeName: s.nodeName, primitiveIndex: s.primitiveIndex, mode: s.mode })),
        triangles: 0,
        droppedInvalidTriangles: 0,
        degenerateTriangles: 0,
        axisTriangles: { x: 0, y: 0, z: 0 },
        verticesBefore: 0,
        verticesAfter: 0,
        droppedAttributes: {},
        maxAbsUv: 0,
        materialsCreated: 0,
        imagesEmbedded: plan.sets.length * 3,
        unusedInputMaterials: 0,
        geometryCleanup: { performed: false, removedAccessors: 0, removedBufferViews: 0 },
        inputBytes: glb.length,
        outputBytes: 0
    };
    const bump = (rec: Record<string, number>, key: string): void => { rec[key] = (rec[key] ?? 0) + 1; };

    for (const [nodeIndex, nodeInstances] of instancesByNode) {
        const node = nodes[nodeIndex];
        const assign = plan.nodes.get(nodeIndex)!;
        const set = plan.sets[assign.setIndex];
        const originalMeshIndex = node.mesh as number;
        let target = meshes[originalMeshIndex];
        const clonesLeft = cloneBudget.get(originalMeshIndex) ?? 0;
        if (clonesLeft > 0) {
            cloneBudget.set(originalMeshIndex, clonesLeft - 1);
            target = { ...target, primitives: target.primitives.map(p => ({ ...p })) } as MeshJson;
            meshes.push(target);
            node.mesh = meshes.length - 1;
        }
        for (const inst of nodeInstances) {
            const prim = target.primitives[inst.primitiveIndex];
            const owner = `node #${nodeIndex} ${JSON.stringify(node.name ?? '')} primitive ${inst.primitiveIndex}`;
            if (inst.localTriangles.length === 0) { report.emptyPrimitives++; continue; } // renders nothing; there is no mapping to give it
            noteReplaced(prim);
            const declaredIndices = prim.indices !== undefined ? ((json.accessors ?? [])[prim.indices]?.count ?? 0) : inst.vertexCount;
            const declaredTriangles = Math.floor(declaredIndices / 3);
            const proj = projectInstance(doc, inst, assign.tileSizeMeters);

            // The float32 spacing of the largest UV, in texels of this set, must stay far below one texel.
            const spacingTexels = proj.maxAbsUv * 2 ** -23 * Math.max(set.width, set.height);
            if (spacingTexels > MAX_UV_QUANTISATION_TEXELS) {
                throw new AdaptivePbrInputError(
                    `${owner}: the UVs reach ${proj.maxAbsUv.toFixed(0)} tiles, where float32 resolves only ${spacingTexels.toFixed(2)} texels of a ${set.width}px texture. Use a larger tileSizeMeters or re-centre the mesh nearer the origin.`,
                    { maxAbsUv: proj.maxAbsUv, tileSizeMeters: assign.tileSizeMeters }
                );
            }

            const hadTexcoord0 = prim.attributes.TEXCOORD_0 !== undefined;
            const preserve = plan.preserveExistingUvs && hadTexcoord0;
            let uvKey = 'TEXCOORD_0';
            if (preserve) { let n = 1; while (prim.attributes[`TEXCOORD_${n}`] !== undefined) n++; uvKey = `TEXCOORD_${n}`; }

            const attributes: Record<string, number> = {};
            for (const [key, accessorIndex] of Object.entries(prim.attributes)) {
                if (key === 'TANGENT') { bump(report.droppedAttributes, key); continue; } // tangent space of the old UVs
                if (NUMBERED_COLOR.test(key) && !plan.preserveVertexColors) { bump(report.droppedAttributes, key); continue; }
                if (key === 'TEXCOORD_0' && !preserve) { bump(report.droppedAttributes, 'TEXCOORD_0 (replaced)'); continue; }
                attributes[key] = duplicateAccessor(state, accessorIndex, proj.source, true, `${owner} ${key}`);
            }
            // POSITION's required min/max cover the vertices actually emitted
            const posAcc = (json.accessors as GltfObject[])[attributes.POSITION];
            posAcc.min = proj.positionMin;
            posAcc.max = proj.positionMax;
            attributes[uvKey] = addAccessor(state, {
                bufferView: addBufferView(state, Buffer.from(proj.uv.buffer, proj.uv.byteOffset, proj.uv.byteLength), { target: TARGET_ARRAY_BUFFER }),
                componentType: FLOAT, count: proj.source.length, type: 'VEC2'
            });

            const newVertexCount = proj.source.length;
            const wide = newVertexCount > 65535;
            const indexData = Buffer.alloc(proj.corners.length * (wide ? 4 : 2));
            for (let i = 0; i < proj.corners.length; i++) {
                if (wide) indexData.writeUInt32LE(proj.corners[i], i * 4); else indexData.writeUInt16LE(proj.corners[i], i * 2);
            }
            const indices = addAccessor(state, {
                bufferView: addBufferView(state, indexData, { target: TARGET_ELEMENT_ARRAY_BUFFER }),
                componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, count: proj.corners.length, type: 'SCALAR'
            });

            const targets = prim.targets?.map(t => {
                const out: Record<string, number> = {};
                for (const [key, accessorIndex] of Object.entries(t)) {
                    if (key === 'TANGENT') continue;
                    out[key] = duplicateAccessor(state, accessorIndex, proj.source, true, `${owner} morph target ${key}`);
                }
                return out;
            });

            const rebuilt: PrimitiveJson = { ...prim, attributes, indices, material: materialFor(assign.setIndex, uvKey === 'TEXCOORD_0' ? 0 : Number(uvKey.slice('TEXCOORD_'.length))) };
            if (targets) rebuilt.targets = targets;
            if (rebuilt.extensions && 'KHR_materials_variants' in rebuilt.extensions) {
                const { KHR_materials_variants: _dropped, ...rest } = rebuilt.extensions;
                bump(report.droppedAttributes, 'KHR_materials_variants (primitive extension)');
                if (Object.keys(rest).length) rebuilt.extensions = rest; else delete rebuilt.extensions;
            }
            target.primitives[inst.primitiveIndex] = rebuilt;

            report.projectedPrimitives++;
            report.uvSets[uvKey] = (report.uvSets[uvKey] ?? 0) + 1;
            report.triangles += proj.corners.length / 3;
            report.droppedInvalidTriangles += Math.max(0, declaredTriangles - proj.corners.length / 3);
            report.degenerateTriangles += proj.degenerate;
            report.axisTriangles.x += proj.axisTriangles[0];
            report.axisTriangles.y += proj.axisTriangles[1];
            report.axisTriangles.z += proj.axisTriangles[2];
            report.verticesBefore += proj.usedSourceVertices;
            report.verticesAfter += newVertexCount;
            report.maxAbsUv = Math.max(report.maxAbsUv, proj.maxAbsUv);
        }
    }
    report.materialsCreated = materialByKey.size;

    const usedMaterials = new Set<number>();
    meshes.forEach(mesh => mesh.primitives.forEach(p => { if (p.material !== undefined) usedMaterials.add(p.material); }));
    report.unusedInputMaterials = Array.from({ length: originalMaterialCount }, (_, i) => i).filter(i => !usedMaterials.has(i)).length;

    // New data goes after the original BIN, then geometry nothing refers to any more is cut out of it.
    doc.bin = Buffer.concat([originalBin, Buffer.alloc(roundUp(originalBin.length, 4) - originalBin.length), ...state.chunks]);
    report.geometryCleanup = removeUnreferencedGeometry(doc, replacedAccessors);
    json.buffers = [{ ...((json.buffers ?? [])[0] ?? {}), byteLength: doc.bin.length }] as never;
    delete (json.buffers[0] as GltfObject).uri;

    const out = serializeGlb(doc);
    report.outputBytes = out.length;
    verifyProjected(out, plan, report, scene);
    return { glb: out, report };
}

/** The output must still hold every triangle it was given, each projected primitive with a UV set and a material of the plan. */
function verifyProjected(out: Buffer, plan: BoxProjectionPlan, report: BoxProjectionReport, input: SceneInspection): void {
    const doc = parseGlb(out);
    const check = inspectScene(doc);
    const inputTriangles = input.instances.reduce((s, i) => s + i.localTriangles.length / 3, 0);
    const outputTriangles = check.instances.reduce((s, i) => s + i.localTriangles.length / 3, 0);
    if (outputTriangles !== inputTriangles) {
        throw new AdaptivePbrOutputError(`The projected GLB holds ${outputTriangles} triangles for the ${inputTriangles} it was given`, { inputTriangles, outputTriangles });
    }
    const meshes = meshesOf(doc.json);
    const materials = (doc.json.materials ?? []) as GltfObject[];
    for (const inst of check.instances) {
        const prim = meshes[inst.meshIndex].primitives[inst.primitiveIndex];
        const uvKeys = Object.keys(prim.attributes).filter(k => /^TEXCOORD_\d+$/.test(k));
        const material = prim.material !== undefined ? materials[prim.material] : undefined;
        const pbr = material?.pbrMetallicRoughness as GltfObject | undefined;
        if (!material || !pbr?.baseColorTexture || !material.normalTexture || !material.occlusionTexture || !pbr.metallicRoughnessTexture) {
            throw new AdaptivePbrOutputError(`Projected primitive ${inst.primitiveIndex} of node #${inst.nodeIndex} has no complete PBR material`);
        }
        const texCoord = ((pbr.baseColorTexture as GltfObject).texCoord as number | undefined) ?? 0;
        const uvAccessor = prim.attributes[`TEXCOORD_${texCoord}`];
        const accessors = (doc.json.accessors ?? []) as Array<{ count: number }>;
        if (uvKeys.length === 0 || uvAccessor === undefined || accessors[uvAccessor].count !== inst.vertexCount) {
            throw new AdaptivePbrOutputError(`Projected primitive ${inst.primitiveIndex} of node #${inst.nodeIndex} lacks TEXCOORD_${texCoord} for its ${inst.vertexCount} vertices`);
        }
        // enumerateSceneTriangles drops out-of-range triangles, so equal counts mean every written index is valid
        const written = prim.indices !== undefined ? accessors[prim.indices].count : -1;
        if (written !== inst.localTriangles.length) {
            throw new AdaptivePbrOutputError(`Projected primitive ${inst.primitiveIndex} of node #${inst.nodeIndex} wrote ${written} indices of which ${inst.localTriangles.length} are valid`);
        }
    }
    if (report.projectedPrimitives !== check.instances.length) {
        throw new AdaptivePbrOutputError(`Projected ${report.projectedPrimitives} primitives but the output renders ${check.instances.length}`);
    }
}

// ---------------------------------------------------------------------------
// Cutting out geometry that nothing refers to any more
// ---------------------------------------------------------------------------

const ACCESSOR_BEARING_KEYS = new Set(['accessor', 'accessors', 'bufferView', 'attributes', 'indices', 'input', 'output']);

function extensionHoldsGeometryReferences(value: unknown, insideExtension: boolean): boolean {
    if (Array.isArray(value)) return value.some(v => extensionHoldsGeometryReferences(v, insideExtension));
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (insideExtension && ACCESSOR_BEARING_KEYS.has(k)) return true;
            if (extensionHoldsGeometryReferences(v, insideExtension || k === 'extensions')) return true;
        }
    }
    return false;
}

/**
 * Removes the accessors in `candidates` that no mesh primitive, skin or animation sampler uses any more, the buffer
 * views only they used, and the bytes behind them. Indices are renumbered in every place glTF itself defines. When
 * an extension elsewhere in the file holds accessor or bufferView references this cannot see, nothing is removed.
 */
function removeUnreferencedGeometry(doc: GlbDocument, candidates: Set<number>): BoxProjectionReport['geometryCleanup'] {
    const json = doc.json;
    const accessors = (json.accessors ?? []) as Array<GltfObject & { bufferView?: number; sparse?: { indices: { bufferView: number }; values: { bufferView: number } } }>;
    const views = (json.bufferViews ?? []) as Array<GltfObject & { buffer: number; byteOffset?: number; byteLength: number }>;
    if (extensionHoldsGeometryReferences(json, false)) {
        return { performed: false, removedAccessors: 0, removedBufferViews: 0, reasonSkipped: 'an extension in the file holds accessor or bufferView references that cannot be renumbered safely' };
    }
    if (views.some(v => (v.buffer ?? 0) !== 0)) {
        return { performed: false, removedAccessors: 0, removedBufferViews: 0, reasonSkipped: 'the file has more than one buffer' };
    }

    const live = new Set<number>();
    const visitPrimitiveRefs = (fn: (n: number) => void): void => {
        for (const mesh of meshesOf(json)) {
            for (const p of mesh.primitives) {
                Object.values(p.attributes ?? {}).forEach(fn);
                if (p.indices !== undefined) fn(p.indices);
                (p.targets ?? []).forEach(t => Object.values(t).forEach(fn));
            }
        }
    };
    visitPrimitiveRefs(n => live.add(n));
    ((json.skins ?? []) as Array<{ inverseBindMatrices?: number }>).forEach(s => { if (s.inverseBindMatrices !== undefined) live.add(s.inverseBindMatrices); });
    ((json.animations ?? []) as Array<{ samplers?: Array<{ input: number; output: number }> }>).forEach(a => (a.samplers ?? []).forEach(s => { live.add(s.input); live.add(s.output); }));

    const dropAccessor = new Set([...candidates].filter(a => !live.has(a) && a >= 0 && a < accessors.length));
    if (dropAccessor.size === 0) return { performed: true, removedAccessors: 0, removedBufferViews: 0 };

    const viewsOf = (a: (typeof accessors)[number]): number[] => [a.bufferView, a.sparse?.indices.bufferView, a.sparse?.values.bufferView].filter((v): v is number => v !== undefined);
    const stillUsedViews = new Set<number>();
    accessors.forEach((a, i) => { if (!dropAccessor.has(i)) viewsOf(a).forEach(v => stillUsedViews.add(v)); });
    (json.images ?? []).forEach(img => { if (img.bufferView !== undefined) stillUsedViews.add(img.bufferView); });
    const dropView = new Set<number>();
    dropAccessor.forEach(i => viewsOf(accessors[i]).forEach(v => { if (!stillUsedViews.has(v)) dropView.add(v); }));

    const accessorMap = new Map<number, number>();
    const keptAccessors: typeof accessors = [];
    accessors.forEach((a, i) => { if (!dropAccessor.has(i)) { accessorMap.set(i, keptAccessors.length); keptAccessors.push(a); } });
    const viewMap = new Map<number, number>();
    const newBin: Buffer[] = [];
    let cursor = 0;
    const keptViews: typeof views = [];
    views.forEach((v, i) => {
        if (dropView.has(i)) return;
        const aligned = roundUp(cursor, 4);
        if (aligned > cursor) newBin.push(Buffer.alloc(aligned - cursor));
        const from = v.byteOffset ?? 0;
        newBin.push(doc.bin.subarray(from, from + v.byteLength));
        viewMap.set(i, keptViews.length);
        keptViews.push({ ...v, byteOffset: aligned });
        cursor = aligned + v.byteLength;
    });

    const remapA = (n: number): number => accessorMap.get(n) ?? n;
    for (const mesh of meshesOf(json)) {
        for (const p of mesh.primitives) {
            for (const k of Object.keys(p.attributes ?? {})) p.attributes[k] = remapA(p.attributes[k]);
            if (p.indices !== undefined) p.indices = remapA(p.indices);
            (p.targets ?? []).forEach(t => { for (const k of Object.keys(t)) t[k] = remapA(t[k]); });
        }
    }
    ((json.skins ?? []) as Array<{ inverseBindMatrices?: number }>).forEach(s => { if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = remapA(s.inverseBindMatrices); });
    ((json.animations ?? []) as Array<{ samplers?: Array<{ input: number; output: number }> }>).forEach(a => (a.samplers ?? []).forEach(s => { s.input = remapA(s.input); s.output = remapA(s.output); }));
    keptAccessors.forEach(a => {
        if (a.bufferView !== undefined) a.bufferView = viewMap.get(a.bufferView) ?? a.bufferView;
        if (a.sparse) {
            a.sparse.indices.bufferView = viewMap.get(a.sparse.indices.bufferView) ?? a.sparse.indices.bufferView;
            a.sparse.values.bufferView = viewMap.get(a.sparse.values.bufferView) ?? a.sparse.values.bufferView;
        }
    });
    (json.images ?? []).forEach(img => { if (img.bufferView !== undefined) img.bufferView = viewMap.get(img.bufferView) ?? img.bufferView; });
    json.accessors = keptAccessors as never;
    json.bufferViews = keptViews as never;
    doc.bin = Buffer.concat(newBin);
    return { performed: true, removedAccessors: dropAccessor.size, removedBufferViews: dropView.size };
}
