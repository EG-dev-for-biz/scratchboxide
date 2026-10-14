/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scan stage assembly: texture-preserving GLB geometry patcher, studio clay with crease-split
 * normals, and the independent geometry metrics used as stage gates.
 *
 * Synthetic GLBs exercise the patcher's contract (strides, uint8/uint16/non-indexed primitives,
 * node transforms, shared POSITION accessors, view alignment, primitive/mesh removal). The real
 * Google 3D tile (public/tiles/scan_studio_tile_esb_77197_98526.glb) exercises Stage 1 and a
 * synthetic sidecar; the prototype fixtures (local, gitignored) cross-check the metrics port
 * against the Python reference implementation. Survey values below are TEST ORACLES only.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    applyRectification,
    createIdentitySidecar,
    encodeSbrxSidecar,
    enumerateSceneTriangles,
    parseGlb,
    readSbrxSidecar,
    readSceneGeometry,
    serializeGlb,
    toClay,
    SBRX_FLAG_DEGENERATE,
    SBRX_FLAG_HIDDEN,
    SBRX_FLAG_KEEP
} from '../src/node/3d-engine/glb-geometry-patcher';
import {
    alignInputToOutput,
    classifyRemovedTriangles,
    creaseLengths,
    dedupPositionDigest,
    displacementStats,
    facadeReliefRidges,
    facadeStats,
    inventoryGlb,
    measureClayStage,
    measureRectifiedStage,
    normalFaceDeviation,
    rasterizeSilhouette,
    readMeasuredMesh,
    readPrimitiveAttribute,
    reliefProjection,
    roofFlatness,
    selectTriangles,
    standardOrthoViews,
    topology,
    trianglesInGridRect,
    type MetricsFrameSpec
} from '../src/node/3d-engine/scan-geometry-metrics';
import { encodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const TILE = path.join(REPO, 'public/tiles/scan_studio_tile_esb_77197_98526.glb');
const WORK = path.join(REPO, '.scratchbox/scan_stages/esb');
const FIXTURES = process.env.SCAN_STAGES_FIXTURE_DIR ?? path.join(WORK, 'fixtures/prototype');
const SHOTS = path.join(REPO, 'test-results/screenshots');
const hasTile = fs.existsSync(TILE);
const hasPrototype = hasTile && ['P_snapv4.npy', 'esc192.npy', 'm_input_culled192.json', 'm_snapv4_culled192.json'].every(f => fs.existsSync(path.join(FIXTURES, f)));
const STAGE2_SIDECAR = path.join(WORK, 'stage2.rectify.bin');

// ---------------------------------------------------------------------------
// Synthetic GLB construction
// ---------------------------------------------------------------------------

/** 1x1 PNGs; any distinct bytes would do, real PNGs keep the fixtures honest. */
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

class GlbBuilder {
    json: any = {
        asset: { version: '2.0', generator: 'scan-stages.test' },
        scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [],
        buffers: [{ byteLength: 0 }], materials: [], textures: [], images: [], samplers: [{ wrapS: 33071, wrapT: 33071 }]
    };
    private chunks: Buffer[] = [];
    private length = 0;

    view(data: Buffer, opts: { stride?: number; target?: number; pad?: boolean } = {}): number {
        if (opts.pad !== false) {
            const pad = (4 - (this.length % 4)) % 4;
            if (pad) { this.chunks.push(Buffer.alloc(pad)); this.length += pad; }
        }
        const v: any = { buffer: 0, byteOffset: this.length, byteLength: data.length };
        if (opts.stride) v.byteStride = opts.stride;
        if (opts.target) v.target = opts.target;
        this.chunks.push(data);
        this.length += data.length;
        this.json.bufferViews.push(v);
        return this.json.bufferViews.length - 1;
    }

    accessor(view: number, componentType: number, count: number, type: string, byteOffset = 0, extra: any = {}): number {
        const a: any = { bufferView: view, componentType, count, type, ...extra };
        if (byteOffset) a.byteOffset = byteOffset;
        this.json.accessors.push(a);
        return this.json.accessors.length - 1;
    }

    floats(values: number[], type: 'VEC2' | 'VEC3'): number {
        const b = Buffer.alloc(values.length * 4);
        values.forEach((v, i) => b.writeFloatLE(v, i * 4));
        const n = type === 'VEC3' ? 3 : 2;
        const extra: any = {};
        if (type === 'VEC3') {
            extra.min = [0, 1, 2].map(k => Math.min(...values.filter((_, i) => i % 3 === k)));
            extra.max = [0, 1, 2].map(k => Math.max(...values.filter((_, i) => i % 3 === k)));
        }
        return this.accessor(this.view(b, { target: 34962 }), 5126, values.length / n, type, 0, extra);
    }

    indices(values: number[], componentType: 5121 | 5123 | 5125, pad = true): number {
        const size = componentType === 5121 ? 1 : componentType === 5123 ? 2 : 4;
        const b = Buffer.alloc(values.length * size);
        values.forEach((v, i) => (size === 1 ? b.writeUInt8(v, i) : size === 2 ? b.writeUInt16LE(v, i * 2) : b.writeUInt32LE(v, i * 4)));
        return this.accessor(this.view(b, { target: 34963, pad }), componentType, values.length, 'SCALAR');
    }

    material(png: Buffer): number {
        this.json.images.push({ mimeType: 'image/png', bufferView: this.view(png) });
        this.json.textures.push({ sampler: 0, source: this.json.images.length - 1 });
        this.json.materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: this.json.textures.length - 1 }, metallicFactor: 0 }, extensions: { KHR_materials_unlit: {} } });
        this.json.extensionsUsed = ['KHR_materials_unlit'];
        return this.json.materials.length - 1;
    }

    mesh(primitives: any[]): number {
        this.json.meshes.push({ primitives });
        return this.json.meshes.length - 1;
    }

    node(node: any, root = false): number {
        this.json.nodes.push(node);
        const i = this.json.nodes.length - 1;
        if (root) this.json.scenes[0].nodes.push(i);
        return i;
    }

    build(): Buffer {
        const pad = (4 - (this.length % 4)) % 4;
        const bin = Buffer.concat([...this.chunks, Buffer.alloc(pad)]);
        this.json.buffers[0].byteLength = bin.length;
        return serializeGlb({ json: this.json, bin });
    }
}

/** Axis-aligned box with per-face vertices (24) and outward normals. */
function boxSoup(c: [number, number, number], h: [number, number, number]): { positions: number[]; uvs: number[]; indices: number[] } {
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    const faces: Array<[number, number]> = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    for (const [axis, sign] of faces) {
        const u = (axis + 1) % 3, v = (axis + 2) % 3;
        const base = positions.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const p = [0, 0, 0];
            p[axis] = c[axis] + sign * h[axis];
            p[u] = c[u] + su * h[u];
            p[v] = c[v] + sv * h[v];
            positions.push(...p);
            uvs.push((su + 1) / 2, (sv + 1) / 2);
        }
        if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    return { positions, uvs, indices };
}

/**
 * A scene that covers the patcher's corner cases:
 *   node 0 (root, no mesh) -> children 1..4
 *   node 1: box, uint16 indices, material 0
 *   node 2: quad with TRS transform, uint8 indices stored unpadded so the next view (UVs, accessor
 *           byteOffset 2) starts at an offset = 2 mod 4
 *   node 3: interleaved POSITION+TEXCOORD_0 (stride 20), non-indexed
 *   node 4: two primitives sharing one POSITION accessor, uint32 indices
 *   mesh 4: not referenced by any node (must be left untouched)
 */
function buildSyntheticScene(): Buffer {
    const g = new GlbBuilder();
    const matA = g.material(PNG_A);
    const matB = g.material(PNG_B);

    const box = boxSoup([0, 1, 0], [1, 1, 1]);
    const boxMesh = g.mesh([{ attributes: { POSITION: g.floats(box.positions, 'VEC3'), TEXCOORD_0: g.floats(box.uvs, 'VEC2') }, indices: g.indices(box.indices, 5123), material: matA, mode: 4 }]);

    const quadPos = g.floats([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 'VEC3');
    const quadIdx = g.indices([0, 2, 1, 0, 3, 2], 5121, true);
    const uvBytes = Buffer.alloc(2 + 8 * 4);
    [0, 0, 1, 0, 1, 1, 0, 1].forEach((v, i) => uvBytes.writeFloatLE(v, 2 + i * 4));
    const uvView = g.view(uvBytes, { pad: false, target: 34962 });
    const quadUv = g.accessor(uvView, 5126, 4, 'VEC2', 2);
    const quadMesh = g.mesh([{ attributes: { POSITION: quadPos, TEXCOORD_0: quadUv }, indices: quadIdx, material: matB, mode: 4 }]);

    const inter = Buffer.alloc(6 * 20);
    const stripPos = [[3, 0, 0], [4, 0, 0], [4, 1, 0], [3, 0, 0], [4, 1, 0], [3, 1, 0]];
    stripPos.forEach((p, i) => {
        inter.writeFloatLE(p[0], i * 20); inter.writeFloatLE(p[1], i * 20 + 4); inter.writeFloatLE(p[2], i * 20 + 8);
        inter.writeFloatLE(p[0] - 3, i * 20 + 12); inter.writeFloatLE(p[1], i * 20 + 16);
    });
    const interView = g.view(inter, { stride: 20, target: 34962 });
    const stripMesh = g.mesh([{
        attributes: {
            POSITION: g.accessor(interView, 5126, 6, 'VEC3', 0, { min: [3, 0, 0], max: [4, 1, 0] }),
            TEXCOORD_0: g.accessor(interView, 5126, 6, 'VEC2', 12)
        }, material: matA, mode: 4
    }]);

    const sharedPos = g.floats([6, 0, 0, 7, 0, 0, 7, 1, 0, 6, 1, 0], 'VEC3');
    const sharedUv = g.floats([0, 0, 1, 0, 1, 1, 0, 1], 'VEC2');
    const sharedMesh = g.mesh([
        { attributes: { POSITION: sharedPos, TEXCOORD_0: sharedUv }, indices: g.indices([0, 1, 2], 5125), material: matA, mode: 4 },
        { attributes: { POSITION: sharedPos, TEXCOORD_0: sharedUv }, indices: g.indices([0, 2, 3], 5125), material: matB, mode: 4 }
    ]);
    g.mesh([{ attributes: { POSITION: g.floats([9, 9, 9, 9, 9, 8, 9, 8, 9], 'VEC3') }, material: matA, mode: 4 }]);

    const root = g.node({ name: 'root', children: [] }, true);
    g.json.nodes[root].children.push(
        g.node({ name: 'box', mesh: boxMesh }),
        g.node({ name: 'quad', mesh: quadMesh, translation: [10, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 2, 2] }),
        g.node({ name: 'strip', mesh: stripMesh }),
        g.node({ name: 'shared', mesh: sharedMesh })
    );
    return g.build();
}

/** Structural validity: references in range, views inside the BIN, components aligned. */
function assertWellFormed(glb: Buffer): void {
    const { json, bin } = parseGlb(glb);
    expect(json.buffers![0].byteLength).toBe(bin.length);
    const views = json.bufferViews ?? [];
    for (const v of views) {
        expect((v.byteOffset ?? 0) + v.byteLength).toBeLessThanOrEqual(bin.length);
    }
    const size: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
    for (const a of json.accessors ?? []) {
        expect(a.bufferView).toBeGreaterThanOrEqual(0);
        expect(a.bufferView!).toBeLessThan(views.length);
        const abs = (views[a.bufferView!].byteOffset ?? 0) + (a.byteOffset ?? 0);
        expect(abs % size[a.componentType]).toBe(0);
    }
    for (const m of json.meshes ?? []) {
        expect(m.primitives.length).toBeGreaterThan(0);
        for (const p of m.primitives) {
            for (const a of Object.values(p.attributes)) expect(a).toBeLessThan(json.accessors!.length);
            if (p.indices !== undefined) expect(p.indices).toBeLessThan(json.accessors!.length);
        }
    }
    for (const n of json.nodes ?? []) if (n.mesh !== undefined) expect(n.mesh).toBeLessThan(json.meshes!.length);
    for (const im of json.images ?? []) expect(im.bufferView!).toBeLessThan(views.length);
}

function sceneVertexRanges(glb: Buffer): Array<{ start: number; count: number }> {
    return enumerateSceneTriangles(parseGlb(glb)).instances.map(i => ({ start: i.vertexBase, count: i.vertexCount }));
}

function savePng(name: string, width: number, height: number, rgba: Buffer): void {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, name), encodePng(width, height, rgba));
}

/** Red = input only, green = output only, grey = both. */
function maskDiffRgba(a: Uint8Array, b: Uint8Array): Buffer {
    const out = Buffer.alloc(a.length * 4);
    for (let i = 0; i < a.length; i++) {
        const c = a[i] && b[i] ? [150, 150, 150] : a[i] ? [230, 40, 40] : b[i] ? [40, 200, 60] : [18, 22, 28];
        out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
    return out;
}

function readNpy(file: string): { descr: string; shape: number[]; data: Buffer } {
    const b = fs.readFileSync(file);
    const headerLength = b.readUInt16LE(8);
    const header = b.toString('latin1', 10, 10 + headerLength);
    const descr = /'descr':\s*'([^']+)'/.exec(header)![1];
    const shape = /'shape':\s*\(([^)]*)\)/.exec(header)![1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
    return { descr, shape, data: b.subarray(10 + headerLength) };
}

// ---------------------------------------------------------------------------
// Synthetic contract tests
// ---------------------------------------------------------------------------

describe('GLB geometry patcher (synthetic contract)', () => {
    const input = buildSyntheticScene();

    it('enumerates instances in GlbSceneReader order and skips unreferenced meshes', () => {
        const layout = enumerateSceneTriangles(parseGlb(input));
        expect(layout.instances.map(i => [i.meshIndex, i.primitiveIndex])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]]);
        expect(layout.vertexCount).toBe(24 + 4 + 6 + 4 + 4);
        expect(layout.triangleCount).toBe(12 + 2 + 2 + 1 + 1);
        expect(layout.instances[1].world).not.toBeNull();
        expect(layout.instances[0].world).toBeNull();
    });

    it('identity sidecar keeps every byte that matters and rewrites indices as uint32', () => {
        const doc = parseGlb(input);
        const result = applyRectification(doc, createIdentitySidecar(doc));
        const out = serializeGlb(result.doc);
        assertWellFormed(out);
        expect(result.report.changedVertices).toBe(0);
        expect(result.report.keptTriangles).toBe(18);

        const a = readMeasuredMesh(input), b = readMeasuredMesh(out);
        expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
        expect(Array.from(b.triangles)).toEqual(Array.from(a.triangles));
        const ia = inventoryGlb(input), ib = inventoryGlb(out);
        expect(ib.images.map(i => i.sha256)).toEqual(ia.images.map(i => i.sha256));
        expect(ib.primitives.map(p => p.texcoord0Sha256)).toEqual(ia.primitives.map(p => p.texcoord0Sha256));
        const rewritten = ib.primitives.filter(p => p.mesh !== 4);
        expect(rewritten.every(p => p.indexComponentType === 5125)).toBe(true);
        // The unreferenced mesh is not part of the scene and keeps its (non-indexed) layout.
        expect(ib.primitives.find(p => p.mesh === 4)!.indexComponentType).toBeNull();
        // The UV view that started at offset 2 mod 4 still yields 4-byte-aligned floats.
        const { json } = parseGlb(out);
        const quadUv = json.accessors![json.meshes![1].primitives[0].attributes.TEXCOORD_0];
        expect(((json.bufferViews![quadUv.bufferView!].byteOffset ?? 0) + (quadUv.byteOffset ?? 0)) % 4).toBe(0);
        expect(dedupPositionDigest(b.positions, b.triangles).sha256).toBe(dedupPositionDigest(a.positions, a.triangles).sha256);
    });

    it('applies a known perturbation, honouring strides, node transforms and min/max', () => {
        const doc = parseGlb(input);
        const sidecar = createIdentitySidecar(doc);
        const delta = [0.25, -0.125, 0.5];
        const ranges = sceneVertexRanges(input);
        // Move the whole box, the transformed quad and the interleaved strip (world space).
        for (const r of [ranges[0], ranges[1], ranges[2]]) {
            for (let v = r.start; v < r.start + r.count; v++) for (let k = 0; k < 3; k++) sidecar.positions[v * 3 + k] += delta[k];
        }
        const before = readMeasuredMesh(input);
        const result = applyRectification(doc, sidecar);
        const out = serializeGlb(result.doc);
        assertWellFormed(out);
        const after = readMeasuredMesh(out);
        expect(result.report.changedVertices).toBe(24 + 4 + 6);
        for (let v = 0; v < after.vertexCount; v++) {
            const moved = v < 34;
            for (let k = 0; k < 3; k++) {
                expect(after.positions[v * 3 + k]).toBeCloseTo(before.positions[v * 3 + k] + (moved ? delta[k] : 0), 5);
            }
        }
        // Untouched vertices keep their exact bytes.
        for (let v = 34; v < after.vertexCount; v++) {
            for (let k = 0; k < 3; k++) expect(after.positions[v * 3 + k]).toBe(before.positions[v * 3 + k]);
        }
        // min/max of the box POSITION accessor follow the data.
        const { json } = parseGlb(out);
        const boxPos = json.accessors![json.meshes![0].primitives[0].attributes.POSITION];
        expect(boxPos.min![0]).toBeCloseTo(-1 + delta[0], 6);
        expect(boxPos.max![1]).toBeCloseTo(2 + delta[1], 6);
        // UVs survive even inside the interleaved view that was patched.
        expect(inventoryGlb(out).primitives.map(p => p.texcoord0Sha256)).toEqual(inventoryGlb(input).primitives.map(p => p.texcoord0Sha256));
    });

    it('drops flagged triangles and removes emptied primitives and meshes without dangling references', () => {
        const doc = parseGlb(input);
        const sidecar = createIdentitySidecar(doc);
        sidecar.flags[0] = SBRX_FLAG_HIDDEN;
        sidecar.flags[5] = SBRX_FLAG_DEGENERATE;
        sidecar.flags[12] = SBRX_FLAG_HIDDEN; // quad, both triangles -> mesh 1 disappears
        sidecar.flags[13] = SBRX_FLAG_HIDDEN;
        sidecar.flags[16] = SBRX_FLAG_HIDDEN; // first shared primitive only
        const result = applyRectification(doc, sidecar);
        const out = serializeGlb(result.doc);
        assertWellFormed(out);
        expect(result.report).toMatchObject({ keptTriangles: 13, droppedHiddenTriangles: 4, droppedDegenerateTriangles: 1, removedPrimitives: 2, removedMeshes: 1 });
        const { json } = parseGlb(out);
        expect(json.meshes!.length).toBe(4);
        expect(json.nodes!.find(n => n.name === 'quad')!.mesh).toBeUndefined();
        expect(json.nodes!.find(n => n.name === 'shared')!.mesh).toBe(2);
        expect(json.meshes![2].primitives.length).toBe(1);
        expect(json.meshes![2].primitives[0].material).toBe(1);
        const after = readMeasuredMesh(out);
        expect(after.triangleCount).toBe(13);
        expect(inventoryGlb(out).images.map(i => i.sha256)).toEqual(inventoryGlb(input).images.map(i => i.sha256));
        // The independent metrics can align output to input and see zero displacement.
        const m = measureRectifiedStage(input, out, { silhouetteResolution: 64, streetProbeCount: 0 });
        expect(m.output.droppedInputPrimitives).toBe(2);
        expect(m.displacement.maxM).toBe(0);
        expect(m.texturePreservation.imagesIdentical).toBe(true);
    });

    it('detects disagreeing copies of a shared POSITION accessor', () => {
        const doc = parseGlb(input);
        const sidecar = createIdentitySidecar(doc);
        const ranges = sceneVertexRanges(input);
        sidecar.positions[ranges[4].start * 3] += 0.5; // second primitive's copy of the shared vertex 0
        expect(applyRectification(doc, sidecar).report.sharedAccessorConflicts).toBe(1);
        for (const r of [ranges[3], ranges[4]]) sidecar.positions[r.start * 3 + 1] += 0.25;
        sidecar.positions[ranges[4].start * 3] -= 0.5;
        const consistent = applyRectification(doc, sidecar);
        expect(consistent.report.sharedAccessorConflicts).toBe(0);
        const after = readMeasuredMesh(serializeGlb(consistent.doc));
        expect(after.positions[ranges[3].start * 3 + 1]).toBeCloseTo(0.25, 6);
        expect(after.positions[ranges[4].start * 3 + 1]).toBeCloseTo(0.25, 6);
    });

    it('encodes, decodes and enforces the SBRX contract', () => {
        const doc = parseGlb(input);
        const sidecar = createIdentitySidecar(doc);
        const bytes = encodeSbrxSidecar(sidecar);
        expect(bytes.toString('latin1', 0, 4)).toBe('SBRX');
        expect(bytes.length).toBe(16 + 12 * 42 + 18);
        const back = readSbrxSidecar(Buffer.concat([bytes, Buffer.alloc(2)])); // trailing padding tolerated
        expect(Array.from(back.positions)).toEqual(Array.from(sidecar.positions));
        expect(Array.from(back.flags)).toEqual(Array.from(sidecar.flags));
        expect(() => readSbrxSidecar(Buffer.from('XXXX' + '\0'.repeat(20), 'latin1'))).toThrow(/magic/);
        expect(() => readSbrxSidecar(bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
        expect(() => applyRectification(doc, { ...sidecar, flags: sidecar.flags.subarray(1) })).toThrow(/triangle flags/);
        const badFlag = { ...sidecar, flags: Uint8Array.from(sidecar.flags) };
        badFlag.flags[3] = 7;
        expect(() => applyRectification(doc, badFlag)).toThrow(/not 0, 1 or 2/);
        const nan = { ...sidecar, positions: Float32Array.from(sidecar.positions) };
        nan.positions[5] = NaN;
        expect(() => applyRectification(doc, nan)).toThrow(/not finite/);
    });
});

describe('scan geometry metrics: removed-triangle classes, reliefs and crease classes (synthetic)', () => {
    it('tells triangles the edit collapsed apart from culled ones, from the two files alone', () => {
        const input = buildSyntheticScene();
        const doc = parseGlb(input);
        const sidecar = createIdentitySidecar(doc);
        const box = sceneVertexRanges(input)[0];
        // box face +x is triangles 0 (v0, v1, v2) and 1 (v0, v2, v3); v1 is used by triangle 0 only.
        // Moving v1 onto the midpoint of v0-v2 collapses triangle 0 without touching triangle 1.
        for (let c = 0; c < 3; c++) {
            sidecar.positions[(box.start + 1) * 3 + c] = 0.5 * (sidecar.positions[box.start * 3 + c] + sidecar.positions[(box.start + 2) * 3 + c]);
        }
        sidecar.flags[0] = SBRX_FLAG_DEGENERATE;
        sidecar.flags[5] = SBRX_FLAG_HIDDEN;
        const out = serializeGlb(applyRectification(doc, sidecar).doc);
        const m0 = readMeasuredMesh(input), m1 = readMeasuredMesh(out);
        const aligned = alignInputToOutput(m0, m1);
        const cls = classifyRemovedTriangles(m0, m1, aligned);
        expect(Array.from(cls.collapsed).flatMap((f, t) => (f ? [t] : []))).toEqual([0]);
        expect([cls.collapsedCount, cls.culledCount]).toEqual([1, 1]);
        const m = measureRectifiedStage(input, out, { silhouetteResolution: 64, streetProbeCount: 0 });
        expect(m.removed).toMatchObject({ culled: 1, collapsed: 1 });
        expect(m.removed.collapsedAreaM2).toBeCloseTo(2, 6); // half of the 2 x 2 m face
    });

    it('measures how far a relief stands proud of its main wall', () => {
        // grid frame at 0 degrees: u = x, w = z. Main wall at z = 10, a 2 m wide relief at z = 10.4.
        const P: number[] = [];
        const T: number[] = [];
        const rect = (x0: number, x1: number, z: number) => {
            const b = P.length / 3;
            P.push(x0, 0, z, x1, 0, z, x1, 8, z, x0, 8, z);
            T.push(b, b + 1, b + 2, b, b + 2, b + 3); // outward +z
        };
        rect(-10, -2, 10);
        rect(2, 10, 10);
        rect(-1, 1, 10.4);
        const r = reliefProjection(P, Uint32Array.from(T), { thetaDeg: 0 }, [{
            name: 'relief', axis: 'w', sign: 1, offset: 10.2, band: 1, y0: 0, y1: 10, relief: { lo: 0, hi: 1.5 }, main: { lo: 2, hi: 10 }
        }]);
        expect(r.relief!.proudM).toBeCloseTo(0.4, 5);
        expect(r.relief!.reliefAreaM2).toBeCloseTo(16, 6);
    });

    it('finds piers proud of the main plane, tells them from crinkle ridges and sees one pressed in', () => {
        // grid frame at 0 degrees: u = x, w = z; a 40 m wall (z = 10, x -20..20), y 0..30, facing +z.
        // A pier: x -6.6..-5.4 at z = 10.2 (0.2 m proud of the main plane). A "crinkle ridge": x 5.4..6.6 stays at
        // z = 10 while the wall dips to z = 9.85 in the 2 m on either side (proud of its ring only).
        const P: number[] = [];
        const T: number[] = [];
        const rect = (x0: number, x1: number, z0: number, z1 = z0) => {
            const b = P.length / 3;
            P.push(x0, 0, z0, x1, 0, z1, x1, 30, z1, x0, 30, z0);
            T.push(b, b + 1, b + 2, b, b + 2, b + 3); // outward +z
        };
        const wall = (pierZ: number) => {
            P.length = 0; T.length = 0;
            rect(-20, -6.6, 10); rect(-6.6, -5.4, pierZ); rect(-5.4, 3.4, 10);
            rect(3.4, 5.4, 9.85); rect(5.4, 6.6, 10); rect(6.6, 8.6, 9.85); rect(8.6, 20, 10);
            return { P: Float64Array.from(P), T: Uint32Array.from(T) };
        };
        const before = wall(10.2), pressed = wall(10.03);
        const spec = [{ name: 'wall', axis: 'w' as const, sign: 1 as const, offset: 10, lateral: { lo: -20, hi: 20 }, y0: 2, y1: 17, span: { lo: -20, hi: 20 } }]; // one 15 m band
        const kept = facadeReliefRidges(before.P, before.P, before.T, { thetaDeg: 0 }, spec);
        expect(kept.piers).toBe(1);             // the crinkle ridge is proud of its ring, not of the main plane
        expect(kept.crisp).toBeGreaterThanOrEqual(2);
        expect(kept.piersFlattened).toBe(0);
        const lost = facadeReliefRidges(before.P, pressed.P, before.T, { thetaDeg: 0 }, spec);
        expect(lost.piers).toBe(1);
        expect(lost.piersFlattened).toBe(1);
        const pier = lost.ridges.find(r => r.proudMainInM >= 0.1)!;
        expect(pier.proudMainInM).toBeCloseTo(0.2, 2);
        expect(pier.proudMainOutM).toBeCloseTo(0.03, 2);
        expect(pier.s0).toBeCloseTo(-6.6, 1);
    });

    it('separates right-angle creases and sliver folds from the >= 45 degree total', () => {
        // a right-angle corner between two 2 m wide faces (edge length 4 m), and a 60 degree fold
        // along a 0.5 m wide sliver (edge length 4 m)
        const P = [0, 0, 0, 0, 4, 0, 2, 0, 0, 0, 0, 2,
            10, 0, 0, 10, 4, 0, 12, 0, 0, 10 + 0.5 * Math.cos((2 * Math.PI) / 3), 0, 0.5 * Math.sin((2 * Math.PI) / 3)];
        const T = Uint32Array.from([0, 1, 2, 0, 3, 1, 4, 5, 6, 4, 7, 5]);
        const c = creaseLengths(P, T);
        expect(c.realM).toBeCloseTo(8, 6);
        expect(c.rightAngleM).toBeCloseTo(4, 6);
        expect(c.realNonSliverM).toBeCloseTo(4, 6);
    });
});

describe('studio clay with crease-split normals (synthetic)', () => {
    it('splits a box into 24 axis-aligned vertices and keeps the position set', () => {
        const g = new GlbBuilder();
        const box = boxSoup([0, 0, 0], [1, 2, 3]);
        // Weld the soup to 8 corner positions so splitting has to happen in the clay pass.
        const key = (i: number): string => box.positions.slice(i * 3, i * 3 + 3).join(',');
        const uniq = new Map<string, number>();
        const pos: number[] = [];
        const remap = box.indices.map(i => {
            const k = key(i);
            if (!uniq.has(k)) { uniq.set(k, uniq.size); pos.push(...box.positions.slice(i * 3, i * 3 + 3)); }
            return uniq.get(k)!;
        });
        g.mesh([{ attributes: { POSITION: g.floats(pos, 'VEC3') }, indices: g.indices(remap, 5123), mode: 4 }]);
        g.node({ mesh: 0 }, true);
        const src = g.build();
        const clay = serializeGlb(toClay(parseGlb(src)).doc);
        const m = readMeasuredMesh(clay);
        expect(m.vertexCount).toBe(24);
        expect(m.triangleCount).toBe(12);
        const n = readPrimitiveAttribute(clay, 0, 0, 'NORMAL')!;
        for (let v = 0; v < 24; v++) {
            const c = [Math.abs(n.data[v * 3]), Math.abs(n.data[v * 3 + 1]), Math.abs(n.data[v * 3 + 2])].sort();
            expect(c[2]).toBeCloseTo(1, 6);
            expect(c[0] + c[1]).toBeCloseTo(0, 6);
        }
        const report = measureClayStage(src, clay);
        expect(report.gates.filter(gt => !gt.pass)).toEqual([]);
        const { json } = parseGlb(clay);
        expect(json.materials).toEqual([{ name: 'Mat_StudioGreyClay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: false }]);
    });

    it('keeps smooth shading across shallow angles and drops UV/COLOR/TANGENT', () => {
        const g = new GlbBuilder();
        const seg = 24, r = 5, positions: number[] = [], uvs: number[] = [], colors: number[] = [], idx: number[] = [];
        for (let i = 0; i < seg; i++) {
            const a0 = (i / seg) * 2 * Math.PI, a1 = (((i + 1) % seg) / seg) * 2 * Math.PI;
            const base = positions.length / 3;
            for (const [a, y] of [[a0, 0], [a1, 0], [a1, 4], [a0, 4]]) {
                positions.push(r * Math.cos(a), y, r * Math.sin(a));
                uvs.push(i / seg, y / 4);
                colors.push(1, 1, 1, 1);
            }
            idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
        }
        const colorBytes = Buffer.alloc(colors.length * 4);
        colors.forEach((c, i) => colorBytes.writeFloatLE(c, i * 4));
        const color = g.accessor(g.view(colorBytes, { target: 34962 }), 5126, colors.length / 4, 'VEC4');
        g.mesh([{ attributes: { POSITION: g.floats(positions, 'VEC3'), TEXCOORD_0: g.floats(uvs, 'VEC2'), COLOR_0: color }, indices: g.indices(idx, 5123), mode: 4 }]);
        g.node({ mesh: 0 }, true);
        const src = g.build();
        const clay = serializeGlb(toClay(parseGlb(src), { creaseAngleDeg: 30 }).doc);
        const m = readMeasuredMesh(clay);
        // 15 degrees between neighbouring faces: duplicated seam vertices collapse to 2 * seg.
        expect(m.vertexCount).toBe(2 * seg);
        expect(inventoryGlb(clay).attributeNames).toEqual(['NORMAL', 'POSITION']);
        const n = readPrimitiveAttribute(clay, 0, 0, 'NORMAL')!;
        for (let v = 0; v < m.vertexCount; v++) {
            const x = m.positions[v * 3], z = m.positions[v * 3 + 2];
            expect(n.data[v * 3] * x / r + n.data[v * 3 + 2] * z / r).toBeCloseTo(1, 5); // radial normal
            expect(n.data[v * 3 + 1]).toBeCloseTo(0, 6);
        }
        const dev = normalFaceDeviation(m.positions, n.data, m.triangles);
        expect(dev.maxDeg).toBeLessThan(8); // half of the 15 degree facet angle, plus slack
        expect(dev.nonUnitNormals).toBe(0);
        // A 10 degree crease threshold must split every seam instead.
        expect(readMeasuredMesh(serializeGlb(toClay(parseGlb(src), { creaseAngleDeg: 10 }).doc)).vertexCount).toBe(4 * seg);
    });
});

// ---------------------------------------------------------------------------
// Real tile
// ---------------------------------------------------------------------------

describe.skipIf(!hasTile)('real Google 3D tile: Stage 1 and synthetic sidecars', () => {
    const tile = hasTile ? fs.readFileSync(TILE) : Buffer.alloc(0);

    it('Stage 1 identity pass: 169,588 triangles and the same distinct-position set', () => {
        const doc = parseGlb(tile);
        const identity = applyRectification(doc, createIdentitySidecar(doc));
        expect(identity.report.changedVertices).toBe(0);
        const clay = serializeGlb(toClay(identity.doc, { creaseAngleDeg: 30 }).doc);
        const m = measureClayStage(tile, clay, { creaseAngleDeg: 30 });
        expect(m.gates.filter(g => !g.pass)).toEqual([]);
        expect(m.source.triangles).toBe(169588);
        expect(m.clay.triangles).toBe(169588);
        expect(m.clay.positionDigest.sha256).toBe(m.source.positionDigest.sha256);
        expect(m.clay.bytes).toBeLessThan(10e6);

        // The textured identity base is the tile with uint32 indices: same images, UVs, geometry.
        const base = serializeGlb(identity.doc);
        assertWellFormed(base);
        const r = measureRectifiedStage(tile, base, { silhouetteResolution: 256, streetProbeCount: 2 });
        expect(r.texturePreservation).toEqual({ imagesIdentical: true, imageCount: 70, uvPrimitivesMatched: 70 });
        expect(r.displacement.maxM).toBe(0);
        expect(r.silhouettes.every(s => s.iou === 1)).toBe(true);

        const top = standardOrthoViews(readMeasuredMesh(tile).positions).find(v => v.name === 'top')!;
        const mt = readMeasuredMesh(tile), mc = readMeasuredMesh(clay);
        savePng('scan_stages_stage1_top_silhouette_diff.png', 512, 512, maskDiffRgba(
            rasterizeSilhouette(mt.positions, mt.triangles, top, 512, 512),
            rasterizeSilhouette(mc.positions, mc.triangles, top, 512, 512)
        ));
    });

    it('published Stage 1 file (when present) passes the same gates', () => {
        const published = path.join(REPO, 'public/models/omnispatial_stage1_real_clay_tile.glb');
        const clay = fs.readFileSync(published);
        const extras = parseGlb(clay).json.extras as { scratchboxScanStage?: { stage: number } } | undefined;
        if (!extras?.scratchboxScanStage) return; // an older procedural output is still in place
        const m = measureClayStage(tile, clay);
        expect(m.gates.filter(g => !g.pass)).toEqual([]);
        expect(m.clay.triangles).toBe(169588);
    });

    it('synthetic sidecar on the real tile: known translation and every 7th triangle hidden', () => {
        const doc = parseGlb(tile);
        const sidecar = createIdentitySidecar(doc);
        const delta = [0.25, -0.1, 0.4];
        for (let i = 0; i < sidecar.positions.length; i++) sidecar.positions[i] += delta[i % 3];
        for (let t = 0; t < sidecar.flags.length; t += 7) sidecar.flags[t] = SBRX_FLAG_HIDDEN;
        const kept = sidecar.flags.reduce((s, f) => s + (f === SBRX_FLAG_KEEP ? 1 : 0), 0);
        const result = applyRectification(doc, sidecar);
        const out = serializeGlb(result.doc);
        assertWellFormed(out);
        const m = measureRectifiedStage(tile, out, { silhouetteResolution: 128, streetProbeCount: 0 });
        expect(m.output.triangles).toBe(kept);
        expect(m.texturePreservation.imagesIdentical).toBe(true);
        expect(m.texturePreservation.uvPrimitivesMatched).toBe(70);
        const expected = Math.hypot(...delta);
        expect(m.displacement.maxM).toBeCloseTo(expected, 4);
        expect(m.displacement.meanM).toBeCloseTo(expected, 4);
        expect(m.displacement.flippedTris).toBe(0);
        // Rigid translation leaves every intrinsic quantity unchanged.
        expect(m.topologyOutput.boundaryEdges).toBe(m.topologyBaseline.boundaryEdges);
        expect(m.creasesOutput.realM).toBeCloseTo(m.creasesBaseline.realM, 0);
    });
});

/** Survey values from the independent ESB measurements: TEST ORACLE ONLY. */
const ESB_ORACLE_FRAME: MetricsFrameSpec = {
    thetaDeg: 61.07,
    lot: { u0: -30, u1: 32.4, w0: -64.9, w1: 65.4 },
    faces: [
        { name: 'shaft -u (33rd St)', axis: 'u', sign: -1, offset: -20.29, band: 1.2, lateral: { lo: 10, hi: 26 }, y0: 130, y1: 265 },
        { name: 'shaft +u (34th St)', axis: 'u', sign: 1, offset: 20.74, band: 1.2, lateral: { lo: 10, hi: 26 }, y0: 130, y1: 265 },
        { name: 'shaft -w (rear)', axis: 'w', sign: -1, offset: -28.28, band: 1.2, lateral: { lo: 2, hi: 18 }, y0: 130, y1: 265 },
        { name: 'shaft +w (5th Ave)', axis: 'w', sign: 1, offset: 28.08, band: 1.2, lateral: { lo: 2, hi: 18 }, y0: 130, y1: 265 }
    ],
    cornerYs: Array.from({ length: 27 }, (_, i) => 135 + 5 * i),
    roofs: [
        { name: 'podium roof', y: 33.85, expectedY: 33.85, below: { u0: -28.8, u1: 29.4, w0: -64.6, w1: 64.2 }, above: { u0: -24.8, u1: 25.5, w0: -47.0, w1: 47.2 } },
        { name: 'T1 roof', y: 88.2, expectedY: 88.2, below: { u0: -24.8, u1: 25.5, w0: -47.0, w1: 47.2 }, above: { u0: -24.9, u1: 25.3, w0: -35.7, w1: 35.8 } },
        { name: 'T4 shaft roof', y: 274.4, expectedY: 274.4, below: { u0: -20.3, u1: 20.7, w0: -28.3, w1: 28.1 }, above: { u0: -18.3, u1: 18.7, w0: -26.2, w1: 26.3 } }
    ],
    // facade faces scanned for piers; `span` is each wall's corner-to-corner extent (survey tier table)
    reliefScans: [
        { name: 'podium+w', axis: 'w', sign: 1, offset: 64.2, lateral: { lo: -32, hi: 33 }, y0: 14, y1: 33, span: { lo: -28.81, hi: 29.38 } },
        { name: 'podium+u', axis: 'u', sign: 1, offset: 29.4, lateral: { lo: -66, hi: 66 }, y0: 17, y1: 33, span: { lo: -64.56, hi: 64.17 } },
        { name: 'podium-u', axis: 'u', sign: -1, offset: -28.8, lateral: { lo: -66, hi: 66 }, y0: 17, y1: 33, span: { lo: -64.56, hi: 64.17 } },
        { name: 'T1+u', axis: 'u', sign: 1, offset: 25.5, lateral: { lo: -49, hi: 49 }, y0: 36, y1: 86, span: { lo: -47.0, hi: 47.19 } },
        { name: 'T1-u', axis: 'u', sign: -1, offset: -24.8, lateral: { lo: -49, hi: 49 }, y0: 36, y1: 86, span: { lo: -47.0, hi: 47.19 } },
        { name: 'shaft+u', axis: 'u', sign: 1, offset: 20.7, lateral: { lo: -30, hi: 30 }, y0: 126, y1: 270, span: { lo: -28.28, hi: 28.08 } },
        { name: 'shaft-u', axis: 'u', sign: -1, offset: -20.3, lateral: { lo: -30, hi: 30 }, y0: 126, y1: 270, span: { lo: -28.28, hi: 28.08 } },
        { name: 'shaft+w', axis: 'w', sign: 1, offset: 28.1, lateral: { lo: -22, hi: 22 }, y0: 126, y1: 270, span: { lo: -20.29, hi: 20.74 } },
        { name: 'shaft-w', axis: 'w', sign: -1, offset: -28.3, lateral: { lo: -22, hi: 22 }, y0: 126, y1: 270, span: { lo: -20.29, hi: 20.74 } }
    ]
};

describe.skipIf(!hasPrototype)('metrics port reproduces the Python reference on the prototype sidecar', () => {
    it('matches metrics.py for the culled input and the plane-snapped prototype', () => {
        const tile = fs.readFileSync(TILE);
        const P = readNpy(path.join(FIXTURES, 'P_snapv4.npy'));
        const E = readNpy(path.join(FIXTURES, 'esc192.npy'));
        expect(P.descr).toBe('<f8');
        expect(E.descr).toBe('|u1');
        const positions = new Float32Array(P.shape[0] * 3);
        for (let i = 0; i < positions.length; i++) positions[i] = P.data.readDoubleLE(i * 8);
        const flags = new Uint8Array(E.shape[0]);
        for (let t = 0; t < flags.length; t++) flags[t] = E.data[t] > 0 ? SBRX_FLAG_KEEP : SBRX_FLAG_HIDDEN;
        const sidecar = readSbrxSidecar(encodeSbrxSidecar({ positions, flags }));
        const out = serializeGlb(applyRectification(parseGlb(tile), sidecar).doc);
        assertWellFormed(out);

        const pyIn = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'm_input_culled192.json'), 'utf8'));
        const pyOut = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'm_snapv4_culled192.json'), 'utf8'));
        const m = measureRectifiedStage(tile, out, { frame: ESB_ORACLE_FRAME, silhouetteResolution: 256, streetProbeCount: 4 });

        // Culled input: exact agreement with the reference implementation.
        expect(m.topologyBaseline).toMatchObject({
            tris: pyIn.topology.tris, weldedVerts: pyIn.topology.welded_verts, edges: pyIn.topology.edges,
            boundaryEdges: pyIn.topology.boundary_edges, nonmanifoldEdges: pyIn.topology.nonmanifold_edges
        });
        expect(m.site!.lotFacadeBaseline!.areaFracWithin1DegPlumbAndGrid).toBeCloseTo(pyIn.facade_esb_lot.area_frac_within_1deg_plumb_and_grid, 9);
        expect(m.site!.lotFacadeBaseline!.tiltP90Deg).toBeCloseTo(pyIn.facade_esb_lot.tilt_p90_deg, 9);
        for (const [name, f] of Object.entries(m.site!.facesBaseline!)) {
            expect(f!.rmsM).toBeCloseTo(pyIn.shaft_planes[name].rms_m, 4);
            expect(f!.offsetFit).toBeCloseTo(pyIn.shaft_planes[name].offset_fit, 3);
        }
        for (const [name, c] of Object.entries(m.site!.cornersBaseline!)) expect(c.meanM).toBeCloseTo(pyIn.shaft_corner_bevel[name].mean_m, 6);

        // Prototype output: float32 storage vs the reference's float64 arrays, so small tolerances.
        expect(m.site!.lotFacadeOutput!.areaFracWithin1DegPlumbAndGrid).toBeCloseTo(pyOut.facade_esb_lot.area_frac_within_1deg_plumb_and_grid, 3);
        for (const [name, c] of Object.entries(m.site!.cornersOutput!)) expect(Math.abs(c.meanM - pyOut.shaft_corner_bevel[name].mean_m)).toBeLessThan(0.003);
        for (const [name, f] of Object.entries(m.site!.facesOutput!)) expect(Math.abs(f!.rmsM - pyOut.shaft_planes[name].rms_m)).toBeLessThan(0.003);
        const m0 = readMeasuredMesh(tile), m1 = readMeasuredMesh(out);
        // metrics.py selects the roof's triangles at the output positions; the module's roofsOutput selects them at
        // the input positions (same triangles before and after), so the reference comparison re-selects at the output
        const roofsAtOutput = roofFlatness(m1.positions, m1.triangles, { thetaDeg: ESB_ORACLE_FRAME.thetaDeg }, ESB_ORACLE_FRAME.roofs!);
        expect(Math.abs(roofsAtOutput['T1 roof']!.yMedian - pyOut.roof_flatness['T1 roof'].y_median)).toBeLessThan(0.01);
        const all = displacementStats(m0.positions, m1.positions, m1.triangles);
        expect(Math.abs(all.maxM - pyOut.deviation_all.max_m)).toBeLessThan(1e-3);
        expect(Math.abs(all.meanM - pyOut.deviation_all.mean_m)).toBeLessThan(1e-3);
        expect(Math.abs(all.p95M - pyOut.deviation_all.p95_m)).toBeLessThan(2e-3);
        // District facade statistics with the oracle frame (independent of the runtime estimate).
        const culled = selectTriangles(m0.triangles, flags);
        expect(facadeStats(m0.positions, culled, { thetaDeg: 61.07 }).areaFracWithin1DegPlumbAndGrid).toBeCloseTo(pyIn.facade_district.area_frac_within_1deg_plumb_and_grid, 9);
        expect(topology(m0.positions, culled).boundaryEdges).toBe(pyIn.topology.boundary_edges);
        // The runtime grid estimate agrees with the survey orientation within 0.1 degree.
        expect(Math.abs(m.gridEstimate.frame.thetaDeg - 61.07)).toBeLessThan(0.1);
        expect(trianglesInGridRect(m0.positions, culled, { thetaDeg: 61.07 }, ESB_ORACLE_FRAME.lot!).reduce((s, x) => s + x, 0)).toBeGreaterThan(0);

        fs.mkdirSync(path.join(REPO, 'test-results'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'test-results/scan_stages_prototype_measurement.json'), JSON.stringify(m, null, 1));
        const oblique = standardOrthoViews(m0.positions).find(v => v.name === 'oblique')!;
        savePng('scan_stages_prototype_oblique_silhouette_diff.png', 512, 512, maskDiffRgba(
            rasterizeSilhouette(m0.positions, m0.triangles, oblique, 512, 512),
            rasterizeSilhouette(m1.positions, m1.triangles, oblique, 512, 512)
        ));
    });
});

describe.skipIf(!hasTile || !fs.existsSync(STAGE2_SIDECAR))('Stage 2 rectifier sidecar (structural contract)', () => {
    it('applies the native sidecar with byte-identical textures and a matching clay', () => {
        const tile = fs.readFileSync(TILE);
        const sidecarBytes = fs.readFileSync(STAGE2_SIDECAR);
        const sidecar = readSbrxSidecar(sidecarBytes);
        const kept = sidecar.flags.reduce((s, f) => s + (f === SBRX_FLAG_KEEP ? 1 : 0), 0);
        const patched = applyRectification(parseGlb(tile), sidecar);
        const base = serializeGlb(patched.doc);
        assertWellFormed(base);
        const geometry = readSceneGeometry(parseGlb(base));
        expect(geometry.triangles.length / 3).toBe(kept);
        const inv0 = inventoryGlb(tile), inv1 = inventoryGlb(base);
        expect(inv1.images.map(i => i.sha256)).toEqual(inv0.images.map(i => i.sha256));
        const clay = serializeGlb(toClay(patched.doc).doc);
        const c = measureClayStage(base, clay);
        expect(c.gates.filter(g => !g.pass)).toEqual([]);
        // Quality gates are measured and recorded, not asserted here: they belong to the rectifier.
        const m = measureRectifiedStage(tile, base, { frame: ESB_ORACLE_FRAME, silhouetteResolution: 256 });
        expect(m.texturePreservation.uvPrimitivesMatched).toBe(inv1.primitives.length);
        fs.mkdirSync(path.join(REPO, 'test-results'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'test-results/scan_stages_stage2_sidecar_measurement.json'), JSON.stringify({ sidecarBytes: sidecarBytes.length, gates: m.gates, site: m.site }, null, 1));
    });
});
