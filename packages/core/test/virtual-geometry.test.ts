/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Virtual geometry: native C++20 cluster LOD DAG builder (.sbvg) and the WebGPU renderer.
 *
 * The builder tests check the properties the renderer relies on, on real output files:
 *   - every DAG level of a closed mesh is itself closed (border locking keeps groups watertight),
 *   - any cut the GPU selection rule can pick, at any streaming stage, is closed too,
 *   - errors and LOD spheres are monotonic from child to parent,
 *   - each streamed block only references vertices that have already arrived.
 * The renderer test streams a real file into Chrome's WebGPU and screenshots the result.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Served builds go to a private temp directory, never the repository or the shared default cache.
process.env.SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-cache-'));

import {
    VirtualGeometryBuildService, VirtualGeometryBuildError, virtualGeometryServeDir, virtualGeometryBuilderHash, pruneVirtualGeometryCache,
    VIRTUAL_GEOMETRY_BUILDER_SOURCE
} from '../src/node/3d-engine/virtual-geometry-service';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { virtualGeometryHandlers } from '../src/node/gemini/tools/virtual-geometry-tools';
import { resolveWithinRoot } from '../src/node/security/path-guard';
import {
    parseSbvgHeader, splitSbvgLevelBlock, SBVG_CLUSTER_WORDS, SBVG_HEADER_BYTES, SBVG_LEVEL_WORDS, SBVG_V1_LEVEL_WORDS, SBVG_VERSION, SBVG_VERTEX_FLOATS, SBVG_NO_MATERIAL, type SbvgHeader
} from '../src/browser/generative-canvas/services/virtual-geometry/sbvg-format';
import { clusterSelected, projectedLodError, type ClusterSelectionParams } from '../src/browser/generative-canvas/services/virtual-geometry/cluster-selection';
import { virtualGeometryLoadPlan } from '../src/browser/generative-canvas/services/virtual-geometry/viewport-source';
import { requireAll, requireBinary, requireFile, withReason, REPO_ROOT } from './helpers/requirements';
import { webgpuChrome, withWebGpuPage } from './helpers/webgpu-chrome';

const INCLUDE_DIR = path.join(REPO_ROOT, 'packages/core/src/native/3d-engine/include');

const clang = requireBinary(process.env.CXX || 'clang++', 'install clang++ (C++20)');
/**
 * sha256 of the .sbvg the builder writes for the determinism fixture (bumpySphere(60, 120) at [10, 2, -3]). Version 6
 * changed only the header's version word for it (no materials, so no atlas table): with word 1 set back to 5 the file
 * hashes to version 5's pin, 3c302966...
 */
const DETERMINISTIC_FIXTURE_SHA256 = 'e72e579c577a97eb857597c4da61c0062dd228fa9a1f0b2271dc7641163e9b90';
const SCREENSHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots');
const ARCH_GLB = 'deploy/cloud-run/spatial-separator/assets/arch_constantine_sb_archi.glb';

// ---------------------------------------------------------------------------
// GLB fixtures
// ---------------------------------------------------------------------------

interface Prim { positions: Float32Array; indices: Uint32Array }

/** Writes a GLB with one mesh per node; each node carries the given TRS. */
function writeGlb(nodes: Array<{ prim: Prim; translation?: number[]; scale?: number[]; rotation?: number[] }>): Buffer {
    const chunks: Buffer[] = [];
    let offset = 0;
    const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], gltfNodes: any[] = [];
    const push = (data: Buffer) => {
        const view = { buffer: 0, byteOffset: offset, byteLength: data.length };
        chunks.push(data);
        offset += data.length;
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
        bufferViews.push(view);
        return bufferViews.length - 1;
    };
    nodes.forEach((n, i) => {
        const p = n.prim.positions;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < p.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[v + k]); max[k] = Math.max(max[k], p[v + k]); }
        const pv = push(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
        accessors.push({ bufferView: pv, componentType: 5126, count: p.length / 3, type: 'VEC3', min, max });
        const iv = push(Buffer.from(n.prim.indices.buffer, n.prim.indices.byteOffset, n.prim.indices.byteLength));
        accessors.push({ bufferView: iv, componentType: 5125, count: n.prim.indices.length, type: 'SCALAR' });
        meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1 }] });
        gltfNodes.push({ mesh: i, ...(n.translation ? { translation: n.translation } : {}), ...(n.scale ? { scale: n.scale } : {}), ...(n.rotation ? { rotation: n.rotation } : {}) });
    });
    const bin = Buffer.concat(chunks);
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: gltfNodes.map((_, i) => i) }], nodes: gltfNodes, meshes, accessors, bufferViews, buffers: [{ byteLength: bin.length }] };
    let jsonBuf = Buffer.from(JSON.stringify(json));
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

/** A GLB from glTF JSON (object or raw text) and a BIN chunk. */
function rawGlb(json: object | string, bin: Buffer = Buffer.alloc(0)): Buffer {
    let jsonBuf = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json));
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const binBuf = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, binBuf]);
}

/** One mesh with several primitives (any mode, indexed or not), on one node. */
function writePrimitivesGlb(prims: Array<{ positions: Float32Array; indices?: Uint32Array; mode?: number }>): Buffer {
    const chunks: Buffer[] = [];
    let offset = 0;
    const bufferViews: any[] = [], accessors: any[] = [], primitives: any[] = [];
    const push = (data: Buffer) => {
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
        chunks.push(data);
        offset += data.length;
        return bufferViews.length - 1;
    };
    for (const p of prims) {
        accessors.push({ bufferView: push(Buffer.from(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength)), componentType: 5126, count: p.positions.length / 3, type: 'VEC3' });
        const prim: any = { attributes: { POSITION: accessors.length - 1 }, ...(p.mode !== undefined ? { mode: p.mode } : {}) };
        if (p.indices) {
            accessors.push({ bufferView: push(Buffer.from(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength)), componentType: 5125, count: p.indices.length, type: 'SCALAR' });
            prim.indices = accessors.length - 1;
        }
        primitives.push(prim);
    }
    const bin = Buffer.concat(chunks);
    return rawGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives }], accessors, bufferViews, buffers: [{ byteLength: bin.length }] }, bin);
}

/** Closed, bumpy sphere: an icosphere-free lat/long grid with welded seam and poles. */
function bumpySphere(lat: number, lon: number, radius: number): Prim {
    const pos: number[] = [];
    const idx: number[] = [];
    const vid = (i: number, j: number) => {
        if (i === 0) return 0;
        if (i === lat) return 1;
        return 2 + (i - 1) * lon + (j % lon);
    };
    pos.push(0, radius, 0, 0, -radius, 0);
    for (let i = 1; i < lat; i++) {
        for (let j = 0; j < lon; j++) {
            const th = (i / lat) * Math.PI, ph = (j / lon) * Math.PI * 2;
            const r = radius * (1 + 0.08 * Math.sin(5 * th) * Math.cos(7 * ph));
            pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph));
        }
    }
    for (let i = 0; i < lat; i++) {
        for (let j = 0; j < lon; j++) {
            const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1);
            if (i !== 0) idx.push(a, d, b);
            if (i !== lat - 1) idx.push(b, d, c);
        }
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

// ---------------------------------------------------------------------------
// .sbvg reading
// ---------------------------------------------------------------------------

interface ClusterRec {
    index: number; refOffset: number; vertexCount: number; triOffset: number; triCount: number; level: number;
    bounds: number[]; self: number[]; selfError: number; parent: number[]; parentError: number;
}

/** Extent of a file's vertices along each axis. */
function extents(file: { vertices: Float32Array }): { x: number; y: number; z: number } {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < file.vertices.length / SBVG_VERTEX_FLOATS; v++) {
        for (let k = 0; k < 3; k++) { const c = file.vertices[v * SBVG_VERTEX_FLOATS + k]; lo[k] = Math.min(lo[k], c); hi[k] = Math.max(hi[k], c); }
    }
    return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
}

function readFile(file: Buffer) {
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const header = parseSbvgHeader(bytes);
    const clusters: ClusterRec[] = [];
    const vertices = new Float32Array(header.vertexCount * SBVG_VERTEX_FLOATS);
    const refs = new Uint32Array(header.refCount);
    const tris = new Uint32Array(header.triangleCount);
    const materials = new Uint32Array(header.triangleCount);
    for (const level of header.levels) {
        const parts = splitSbvgLevelBlock(level, bytes.subarray(level.byteOffset, level.byteOffset + level.byteLength), header.version);
        const cu = new Uint32Array(parts.clusters.slice().buffer);
        const cf = new Float32Array(parts.clusters.slice().buffer);
        for (let i = 0; i < level.clusterCount; i++) {
            const w = i * SBVG_CLUSTER_WORDS;
            clusters.push({
                index: level.clusterStart + i, refOffset: cu[w], vertexCount: cu[w + 1], triOffset: cu[w + 2], triCount: cu[w + 3], level: cu[w + 4],
                bounds: Array.from(cf.subarray(w + 8, w + 12)), self: Array.from(cf.subarray(w + 16, w + 20)), selfError: cf[w + 20],
                parent: Array.from(cf.subarray(w + 24, w + 28)), parentError: cf[w + 28]
            });
        }
        vertices.set(new Float32Array(parts.vertices.slice().buffer), level.vertexStart * SBVG_VERTEX_FLOATS);
        refs.set(new Uint32Array(parts.refs.slice().buffer), level.refStart);
        tris.set(new Uint32Array(parts.triangles.slice().buffer), level.triangleStart);
        if (parts.materials.byteLength) materials.set(new Uint32Array(parts.materials.slice().buffer), level.triangleStart);
    }
    const triangleVertices = (c: ClusterRec) => {
        const out: Array<[number, number, number]> = [];
        for (let t = 0; t < c.triCount; t++) {
            const p = tris[c.triOffset + t];
            out.push([refs[c.refOffset + (p & 255)], refs[c.refOffset + ((p >> 8) & 255)], refs[c.refOffset + ((p >> 16) & 255)]]);
        }
        return out;
    };
    return { header, clusters, vertices, refs, tris, materials, triangleVertices };
}

/** Undirected edges used by a number of triangles other than 2 (0 for a closed manifold surface). */
function openEdges(triangles: Array<[number, number, number]>): number {
    const use = new Map<string, number>();
    for (const t of triangles) for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        use.set(key, (use.get(key) ?? 0) + 1);
    }
    let open = 0;
    for (const n of use.values()) if (n !== 2) open++;
    return open;
}

/** The renderer's selection rule (cluster-selection.ts, mirrored by CULL_WGSL), without frustum/cone culling. */
function selectCut(file: ReturnType<typeof readFile>, eye: number[], lodScale: number, thresholdPx: number, finestLevel: number, near = 1e-3) {
    const params: ClusterSelectionParams = { eye, lodScale, near, thresholdPx, finestLevel };
    return file.clusters.filter(c => clusterSelected(c, params));
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------

describe.skipIf(!clang.ok)(withReason('Virtual geometry builder (C++20 cluster LOD DAG -> .sbvg)', clang), () => {
    const service = new VirtualGeometryBuildService();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-'));
    let sphere: ReturnType<typeof readFile>;
    let sphereStats: Awaited<ReturnType<VirtualGeometryBuildService['build']>>['stats'];
    const SPHERE_OFFSET = [1200, -35, 400];

    beforeAll(async () => {
        // One closed mesh on a node translated far from the origin and scaled.
        const prim = bumpySphere(160, 320, 1);
        const glb = writeGlb([{ prim, translation: SPHERE_OFFSET, scale: [2, 2, 2] }]);
        fs.writeFileSync(path.join(tmp, 'sphere.glb'), glb);
        const result = await service.build(path.join(tmp, 'sphere.glb'), path.join(tmp, 'sphere.sbvg'));
        sphereStats = result.stats;
        sphere = readFile(fs.readFileSync(result.sbvgPath));
    });

    it('applies node transforms and keeps every source triangle at level 0', () => {
        const h = sphere.header;
        expect(h.sourceTriangleCount).toBe(160 * 320 * 2 - 2 * 320);
        expect(h.leafTriangleCount).toBe(h.sourceTriangleCount - sphereStats.droppedDegenerate);
        expect(sphereStats.droppedDegenerate).toBe(0);
        // Scaled radius ~2 (bumps up to 8%), centred at the node translation (stored as the origin).
        for (let k = 0; k < 3; k++) {
            expect(Math.abs(h.origin[k] - SPHERE_OFFSET[k])).toBeLessThan(0.2);
            expect(h.aabbMax[k] - h.aabbMin[k]).toBeGreaterThan(3.6);
            expect(h.aabbMax[k] - h.aabbMin[k]).toBeLessThan(4.4);
        }
        expect(h.levelCount).toBeGreaterThanOrEqual(6);
        // A closed surface simplifies all the way: no group is ever carried up unchanged, and the
        // partition's leftover groups are merged rather than left stuck.
        expect(sphereStats.levels.length).toBe(h.levelCount - 1);
        for (const level of sphereStats.levels) {
            expect(level.stuckGroups, `level ${level.level}`).toBe(0);
            expect(level.mergedGroups).toBeGreaterThanOrEqual(0);
        }
        expect(h.levels[0].level).toBe(h.levelCount - 1); // coarsest first
        expect(h.levels[h.levels.length - 1].level).toBe(0);
    });

    it('simplifies each level to roughly half the triangles of the one below', () => {
        const byLevel = new Map<number, number>();
        for (const c of sphere.clusters) byLevel.set(c.level, (byLevel.get(c.level) ?? 0) + c.triCount);
        const leaf = byLevel.get(0)!;
        expect(byLevel.get(1)!).toBeLessThan(leaf * 0.6);
        expect(byLevel.get(sphere.header.levelCount - 1)!).toBeLessThan(leaf * 0.05);
    });

    it('keeps every DAG level a closed surface (no cracks from group simplification)', () => {
        for (let level = 0; level < sphere.header.levelCount; level++) {
            const tris = sphere.clusters.filter(c => c.level === level).flatMap(c => sphere.triangleVertices(c));
            expect(openEdges(tris), `level ${level}`).toBe(0);
        }
    });

    it('stores monotonic errors and nested LOD spheres from child to parent', () => {
        for (const c of sphere.clusters) {
            expect(c.parentError).toBeGreaterThanOrEqual(c.selfError);
            if (c.parentError < 1e37) {
                const d = Math.hypot(c.parent[0] - c.self[0], c.parent[1] - c.self[1], c.parent[2] - c.self[2]);
                expect(d + c.self[3]).toBeLessThanOrEqual(c.parent[3] * 1.0001 + 1e-5);
            }
        }
    });

    it('only references vertices that arrived in the same or an earlier stream block', () => {
        let vertexEnd = 0;
        for (const level of sphere.header.levels) {
            vertexEnd = level.vertexStart + level.vertexCount;
            for (const c of sphere.clusters.filter(x => x.level === level.level)) {
                for (let v = 0; v < c.vertexCount; v++) expect(sphere.refs[c.refOffset + v]).toBeLessThan(vertexEnd);
                for (const t of sphere.triangleVertices(c)) expect(Math.max(...t)).toBeLessThan(vertexEnd);
            }
        }
        expect(vertexEnd).toBe(sphere.header.vertexCount);
    });

    it('selects a closed, mixed-level cut for any camera and at every streaming stage', () => {
        const eye = [3.2, 0.4, 0]; // close to one side: fine there, coarse on the far side
        for (const finest of [sphere.header.levelCount - 1, 3, 1, 0]) {
            for (const threshold of [0.5, 2, 8]) {
                const cut = selectCut(sphere, eye, 1000, threshold, finest);
                const levels = new Set(cut.map(c => c.level));
                expect(openEdges(cut.flatMap(c => sphere.triangleVertices(c))), `finest ${finest}, ${threshold}px`).toBe(0);
                if (finest === 0 && threshold === 2) expect(levels.size).toBeGreaterThan(1);
            }
        }
        // The farther camera needs fewer triangles.
        const near = selectCut(sphere, eye, 1000, 1, 0).reduce((n, c) => n + c.triCount, 0);
        const far = selectCut(sphere, [400, 0, 0], 1000, 1, 0).reduce((n, c) => n + c.triCount, 0);
        expect(far).toBeLessThan(near / 4);
    });

    it('rejects a file that is not a GLB with the builder\'s own message', async () => {
        const bad = path.join(tmp, 'bad.glb');
        fs.writeFileSync(bad, 'definitely not a glb file');
        await expect(service.build(bad, path.join(tmp, 'bad.sbvg'))).rejects.toThrow(/not a GLB file/);
        await expect(service.build(bad, path.join(tmp, 'bad.sbvg'))).rejects.toBeInstanceOf(VirtualGeometryBuildError);
        expect(fs.existsSync(path.join(tmp, 'bad.sbvg'))).toBe(false);
    });

    it('virtual_geometry_open_glb builds a served file and mounts a scene for it; refuses paths outside the workspace', async () => {
        const ctx = { workspaceRoot: tmp } as any;
        const ok: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: 'sphere.glb', errorThresholdPx: 2 }, ctx);
        const vg = ok.resultPayload.artifact.data.virtualGeometry;
        expect(ok.resultPayload.artifact.type).toBe('3d-scene');
        expect(vg).toMatchObject({ sourceGlbPath: 'sphere.glb', workspaceRoot: path.resolve(tmp), errorThresholdPx: 2 });
        // <GLB content hash>-<builder hash>
        expect(vg.sbvgUrl).toMatch(/^\/build\/3d-virtual-geometry\/[0-9a-f]{32}-[0-9a-f]{16}\.sbvg$/);
        const served = path.join(virtualGeometryServeDir(), path.basename(vg.sbvgUrl));
        expect(served.startsWith(process.env.SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE!)).toBe(true);
        expect(parseSbvgHeader(new Uint8Array(fs.readFileSync(served))).leafTriangleCount).toBe(sphere.header.leafTriangleCount);
        // Same bytes, same URL, no second build; the summary still comes from the file.
        const again: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: 'sphere.glb' }, ctx);
        expect(again.resultPayload.sbvgUrl).toBe(vg.sbvgUrl);
        expect(again.resultPayload.cached).toBe(true);
        expect(again.resultPayload.summary.clusterCount).toBe(sphere.header.clusterCount);
        expect(again.summaryResult).toMatch(/reused the existing build/);

        const outside: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: '../../etc/passwd' }, ctx);
        expect(outside.status).toBe('failed');
        expect(outside.resultPayload.error).toMatch(/outside the workspace/);
        const missing: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: 'nope.glb' }, ctx);
        expect(missing.resultPayload.error).toMatch(/does not exist/);
        const notGlb: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: 'bad.glb' }, ctx);
        expect(notGlb.status).toBe('failed');
        expect(notGlb.resultPayload.error).toMatch(/not a GLB file/);
    });

    it('stores the source relative to the root it resolved against, and the viewport rebuilds from that same root', async () => {
        fs.mkdirSync(path.join(tmp, 'models'), { recursive: true });
        fs.copyFileSync(path.join(tmp, 'sphere.glb'), path.join(tmp, 'models', 'ball.glb'));
        const ctx = { workspaceRoot: tmp } as any;
        // An absolute path inside the workspace is stored workspace-relative, with the root.
        const res: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: path.join(tmp, 'models', 'ball.glb') }, ctx);
        const vg = res.resultPayload.artifact.data.virtualGeometry;
        expect(vg.sourceGlbPath).toBe('models/ball.glb');
        expect(vg.workspaceRoot).toBe(path.resolve(tmp));
        // The canvas has another workspace open: the rebuild request still names the tool's root.
        const plan = virtualGeometryLoadPlan(vg, '/some/other/workspace');
        expect(plan).toEqual({ kind: 'build', request: { sourceGlbPath: 'models/ball.glb', workspaceRoot: path.resolve(tmp) } });
        if (plan.kind !== 'build') throw new Error('expected a build plan');
        // ...and the server resolves it (as the route does) to the file the tool opened.
        expect(fs.realpathSync(resolveWithinRoot(plan.request.workspaceRoot!, plan.request.sourceGlbPath))).toBe(fs.realpathSync(path.join(tmp, 'models', 'ball.glb')));
        // A scene made by hand (no root) resolves against the open workspace.
        expect(virtualGeometryLoadPlan({ sourceGlbPath: 'a.glb' }, '/ws')).toEqual({ kind: 'build', request: { sourceGlbPath: 'a.glb', workspaceRoot: '/ws' } });
    });

    it('never serves a stale build: a changed GLB or builder gets a new URL, and the viewport re-checks a saved URL', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-stale-'));
        const svc = new VirtualGeometryBuildService(undefined, { cacheDir: path.join(dir, 'cache') });
        const glb = path.join(dir, 'model.glb');
        fs.writeFileSync(glb, writeGlb([{ prim: bumpySphere(20, 40, 1) }]));
        const first = await svc.buildServed(glb);
        expect(first.cached).toBe(false);
        expect(path.basename(first.sbvgUrl)).toBe(`${path.basename(first.sbvgUrl).split('-')[0]}-${svc.builderHash()}.sbvg`);
        expect((await svc.buildServed(glb)).cached).toBe(true);

        // Same path, new bytes (and a different size): a new build at a new URL.
        fs.writeFileSync(glb, writeGlb([{ prim: bumpySphere(24, 48, 1) }]));
        const second = await svc.buildServed(glb);
        expect(second.sbvgUrl).not.toBe(first.sbvgUrl);
        expect(second.cached).toBe(false);
        expect(parseSbvgHeader(new Uint8Array(fs.readFileSync(second.sbvgPath))).sourceTriangleCount).toBe(24 * 48 * 2 - 2 * 48);

        // The builder hash covers the header text: an edited header gives another hash.
        const editedInclude = path.join(dir, 'include');
        fs.mkdirSync(editedInclude);
        const header = fs.readFileSync(path.join(INCLUDE_DIR, 'scratchbox_virtual_geometry.hpp'), 'utf8');
        fs.writeFileSync(path.join(editedInclude, 'scratchbox_virtual_geometry.hpp'), header.replace('kGroupSize = 8', 'kGroupSize = 4'));
        expect(virtualGeometryBuilderHash(editedInclude)).not.toBe(svc.builderHash());
        expect(virtualGeometryBuilderHash(INCLUDE_DIR)).toBe(svc.builderHash());

        // A scene with a source never trusts its saved URL: the viewport asks the server, which answers with the current one.
        expect(virtualGeometryLoadPlan({ sourceGlbPath: 'model.glb', sbvgUrl: first.sbvgUrl }, dir).kind).toBe('build');
        expect(virtualGeometryLoadPlan({ sbvgUrl: first.sbvgUrl })).toEqual({ kind: 'url', url: first.sbvgUrl });
    });

    it('writes served builds to its configured cache directory and evicts by age and size', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-evict-'));
        const cacheDir = path.join(dir, 'cache');
        const svc = new VirtualGeometryBuildService(undefined, { cacheDir });
        const built = await svc.buildServed(path.join(tmp, 'sphere.glb'));
        expect(path.dirname(built.sbvgPath)).toBe(cacheDir);
        expect(fs.existsSync(path.join(process.cwd(), 'build', '3d-virtual-geometry', path.basename(built.sbvgPath)))).toBe(false);

        const now = Date.now();
        const put = (name: string, bytes: number, ageMs: number) => {
            const f = path.join(cacheDir, name);
            fs.writeFileSync(f, Buffer.alloc(bytes));
            fs.utimesSync(f, new Date(now - ageMs), new Date(now - ageMs));
        };
        put('old.sbvg', 10, 40 * 86400_000);          // past the age bound
        put('lru-a.sbvg', 4000, 3 * 3600_000);        // least recently used: goes for size
        put('lru-b.sbvg', 4000, 2 * 3600_000);
        put('fresh.sbvg', 4000, 60_000);              // used within the idle grace: kept even over the bound
        put('x.sbvg.tmp-1-ab', 10, 2 * 86400_000);    // temp of a dead build
        const builtSize = fs.statSync(built.sbvgPath).size;
        const res = pruneVirtualGeometryCache({ dir: cacheDir, maxAgeMs: 30 * 86400_000, maxBytes: builtSize + 8000, minIdleMs: 10 * 60_000, nowMs: now });
        expect(res.removed.sort()).toEqual(['lru-a.sbvg', 'old.sbvg']);
        expect(fs.existsSync(path.join(cacheDir, 'fresh.sbvg'))).toBe(true);
        expect(fs.existsSync(path.join(cacheDir, 'x.sbvg.tmp-1-ab'))).toBe(false);
        expect(fs.existsSync(built.sbvgPath)).toBe(true);
    });

    it('stops the builder process when the caller aborts', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-abort-'));
        const glb = path.join(dir, 'abort-me.glb');
        fs.writeFileSync(glb, writeGlb([{ prim: bumpySphere(500, 1000, 1) }])); // ~1M triangles: seconds of work
        const svc = new VirtualGeometryBuildService(undefined, { cacheDir: path.join(dir, 'cache') });
        const running = () => spawnSync('pgrep', ['-f', glb]).stdout.toString().trim();
        const controller = new AbortController();
        const job = svc.buildServed(glb, { signal: controller.signal });
        const settled = job.then(() => 'resolved', (e: Error) => e.name);
        for (let i = 0; i < 400 && !running(); i++) await new Promise(r => setTimeout(r, 25));
        expect(running(), 'builder process started').not.toBe('');
        const t0 = Date.now();
        controller.abort();
        expect(await settled).toBe('AbortError');
        for (let i = 0; i < 40 && running(); i++) await new Promise(r => setTimeout(r, 25));
        expect(running(), 'builder process killed').toBe('');
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(fs.readdirSync(path.join(dir, 'cache')).filter(f => f.endsWith('.sbvg'))).toEqual([]);
    });

    it('rejects a scene graph that expands to too many node instances instead of hanging', async () => {
        // 48 levels of nodes that each list the next level twice: 2^48 paths through 49 nodes.
        const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const bin = Buffer.from(tri.buffer);
        const nodes = Array.from({ length: 49 }, (_, i) => (i < 48 ? { mesh: 0, children: [i + 1, i + 1] } : { mesh: 0 }));
        const glb = rawGlb({
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes,
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }]
        }, bin);
        const file = path.join(tmp, 'node-bomb.glb');
        fs.writeFileSync(file, glb);
        const t0 = Date.now();
        await expect(service.build(file, path.join(tmp, 'node-bomb.sbvg'), { timeoutMs: 60_000 })).rejects.toThrow(/node instances/);
        expect(Date.now() - t0).toBeLessThan(20_000);
    });

    it('converts triangle strips and fans to triangles with glTF winding, and reports skipped primitives', async () => {
        // Strip: a 2 x 8 row of quads in the XZ plane; fan: a 16-gon disc at y = 1. Both face +Y.
        const strip: number[] = [];
        for (let i = 0; i <= 8; i++) strip.push(i, 0, -1, i, 0, 0);
        const fan: number[] = [20, 1, 0];
        for (let k = 0; k <= 16; k++) { const a = (k / 16) * Math.PI * 2; fan.push(20 + Math.cos(a), 1, -Math.sin(a)); }
        const lines = new Float32Array([0, 5, 0, 1, 5, 0]);
        const glb = writePrimitivesGlb([
            { positions: new Float32Array(strip), mode: 5 },
            { positions: new Float32Array(fan), indices: new Uint32Array(Array.from({ length: fan.length / 3 }, (_, i) => i)), mode: 6 },
            { positions: lines, mode: 1 }
        ]);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-strip-'));
        fs.writeFileSync(path.join(dir, 'strips.glb'), glb);
        const result = await service.build(path.join(dir, 'strips.glb'), path.join(dir, 'strips.sbvg'));
        const file = readFile(fs.readFileSync(result.sbvgPath));
        expect(result.stats.skippedPrimitives).toBe(1);
        expect(file.header.skippedPrimitives).toBe(1);
        expect(file.header.sourceTriangleCount).toBe(16 + 16); // strip: 18 vertices -> 16; fan: 18 vertices -> 16
        expect(file.header.leafTriangleCount).toBe(32);
        const leafTris = file.clusters.filter(c => c.level === 0).flatMap(c => file.triangleVertices(c));
        for (const [a, b, c] of leafTris) {
            const p = (v: number) => [file.vertices[v * SBVG_VERTEX_FLOATS], file.vertices[v * SBVG_VERTEX_FLOATS + 1], file.vertices[v * SBVG_VERTEX_FLOATS + 2]];
            const [pa, pb, pc] = [p(a), p(b), p(c)];
            const ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
            expect(ny).toBeGreaterThan(0); // counter-clockwise seen from +Y
        }
        const ctx = { workspaceRoot: dir } as any;
        const tool: any = await virtualGeometryHandlers.virtual_geometry_open_glb({ glbPath: 'strips.glb' }, ctx);
        expect(tool.resultPayload.summary.skippedPrimitives).toBe(1);
        expect(tool.summaryResult).toMatch(/1 primitive without a surface .* was left out/);
        expect(tool.resultPayload.artifact.data.virtualGeometry.buildStats.skippedPrimitives).toBe(1);
    });

    it('decodes KHR_mesh_quantization positions (16-bit normalized, padded stride, node scale) and builds only level 0 of a level-of-detail group', async () => {
        // A unit quad in the XZ plane stored as normalized int16 in an 8-byte stride (as SB-Veggie writes crowns), placed by
        // its node's scale 4 and translation (10, 2, -3), as level 0; and a level 3 of the same group, which is left out.
        const quad = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]];
        const pos = Buffer.alloc(quad.length * 8);
        quad.forEach((v, i) => v.forEach((c, k) => pos.writeInt16LE(Math.round(c * 32767), i * 8 + k * 2)));
        const idx = Buffer.from(new Uint16Array([0, 2, 1, 0, 3, 2]).buffer);
        const far = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer);
        const bin = Buffer.concat([pos, idx, far]);
        const json = {
            asset: { version: '2.0' }, extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
            scene: 0, scenes: [{ nodes: [0, 1] }],
            nodes: [
                { name: 'crown_lod0', mesh: 0, scale: [4, 4, 4], translation: [10, 2, -3], extras: { sbLod: { level: 0, instanced: false } } },
                { name: 'crown_lod3', mesh: 1, extras: { sbLod: { level: 3, instanced: false } } }
            ],
            meshes: [
                { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
                { primitives: [{ attributes: { POSITION: 2 } }] }
            ],
            accessors: [
                { bufferView: 0, componentType: 5122, normalized: true, count: 4, type: 'VEC3' },
                { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
                { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' }
            ],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: pos.length, byteStride: 8 },
                { buffer: 0, byteOffset: pos.length, byteLength: idx.length },
                { buffer: 0, byteOffset: pos.length + idx.length, byteLength: far.length }
            ],
            buffers: [{ byteLength: bin.length }]
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-quant-'));
        fs.writeFileSync(path.join(dir, 'quantized.glb'), rawGlb(json, bin));
        const result = await service.build(path.join(dir, 'quantized.glb'), path.join(dir, 'quantized.sbvg'));
        expect(result.stats.skippedLodLevels).toBe(1);
        const file = readFile(fs.readFileSync(result.sbvgPath));
        expect(file.header.sourceTriangleCount).toBe(2);
        const ext = extents(file);
        // the file stores vertices relative to its origin: compare extents, which the origin does not move
        expect(ext.x).toBeCloseTo(8, 3);
        expect(ext.z).toBeCloseTo(8, 3);
        expect(ext.y).toBeCloseTo(0, 6);
    });

    it('builds the finest level present in each level-of-detail group, so a snapshot holding one coarse level of a tree keeps it', async () => {
        // Tree A holds levels 0 (a triangle at x = 0) and 2 (at x = 100); tree B, as a viewport snapshot sends it, only level 2 (at x = 200).
        const tri = (x: number) => [x, 0, 0, x + 1, 0, 0, x, 1, 0];
        const bin = Buffer.from(new Float32Array([...tri(0), ...tri(100), ...tri(200)]).buffer);
        const lod = (level: number) => ({ sbLod: { level } });
        const json = {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 3] }],
            nodes: [
                { name: 'treeA', children: [1, 2] }, { name: 'treeA_lod0', mesh: 0, extras: lod(0) }, { name: 'treeA_lod2', mesh: 1, extras: lod(2) },
                { name: 'treeB', children: [4] }, { name: 'treeB_lod2', mesh: 2, extras: lod(2) }
            ],
            meshes: [0, 1, 2].map(a => ({ primitives: [{ attributes: { POSITION: a } }] })),
            accessors: [0, 1, 2].map(v => ({ bufferView: v, componentType: 5126, count: 3, type: 'VEC3' })),
            bufferViews: [0, 1, 2].map(v => ({ buffer: 0, byteOffset: v * 36, byteLength: 36 })),
            buffers: [{ byteLength: bin.length }]
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-lod-'));
        fs.writeFileSync(path.join(dir, 'lods.glb'), rawGlb(json, bin));
        const result = await service.build(path.join(dir, 'lods.glb'), path.join(dir, 'lods.sbvg'), { singleLevel: true });
        expect(result.stats.skippedLodLevels).toBe(1);
        const file = readFile(fs.readFileSync(result.sbvgPath));
        expect(file.header.sourceTriangleCount).toBe(2);
        const xs = new Set<number>();
        for (let v = 0; v < file.vertices.length / SBVG_VERTEX_FLOATS; v++) xs.add(Math.round(file.vertices[v * SBVG_VERTEX_FLOATS] + file.header.origin[0]));
        expect([...xs].sort((a, b) => a - b)).toEqual([0, 1, 200, 201]);
    });

    it('expands EXT_mesh_gpu_instancing: one copy per instance, each moved, turned (int16 quaternions) and scaled in its node\'s frame', async () => {
        // A unit right triangle in XY, instanced three times under a node translated by (0, 10, 0):
        // at x = 0 as is, at x = 10 turned 90 degrees about +Y, at x = 20 scaled by 2.
        const tri = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
        const t = Buffer.from(new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]).buffer);
        const s = Buffer.from(new Float32Array([1, 1, 1, 1, 1, 1, 2, 2, 2]).buffer);
        const r = Buffer.alloc(3 * 8);
        const half = Math.SQRT1_2;
        [[0, 0, 0, 1], [0, half, 0, half], [0, 0, 0, 1]].forEach((q, i) => q.forEach((c, k) => r.writeInt16LE(Math.round(c * 32767), i * 8 + k * 2)));
        const bin = Buffer.concat([tri, t, r, s]);
        let off = 0;
        const view = (b: Buffer) => { const v = { buffer: 0, byteOffset: off, byteLength: b.length }; off += b.length; return v; };
        const json = {
            asset: { version: '2.0' }, extensionsUsed: ['EXT_mesh_gpu_instancing', 'KHR_mesh_quantization'],
            scene: 0, scenes: [{ nodes: [0] }],
            nodes: [{ name: 'leaves', mesh: 0, translation: [0, 10, 0], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1, ROTATION: 2, SCALE: 3 } } } }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
                { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
                { bufferView: 2, componentType: 5122, normalized: true, count: 3, type: 'VEC4' },
                { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' }
            ],
            bufferViews: [view(tri), view(t), view(r), view(s)],
            buffers: [{ byteLength: bin.length }]
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-inst-'));
        fs.writeFileSync(path.join(dir, 'instanced.glb'), rawGlb(json, bin));
        const result = await service.build(path.join(dir, 'instanced.glb'), path.join(dir, 'instanced.sbvg'), { singleLevel: true });
        expect(result.stats.expandedInstances).toBe(3);
        const file = readFile(fs.readFileSync(result.sbvgPath));
        expect(file.header.sourceTriangleCount).toBe(3);
        // world positions back from the file's origin
        const o = file.header.origin;
        const pts: number[][] = [];
        for (let v = 0; v < file.vertices.length / SBVG_VERTEX_FLOATS; v++) {
            pts.push([0, 1, 2].map(k => file.vertices[v * SBVG_VERTEX_FLOATS + k] + o[k]));
        }
        const has = (p: number[]) => pts.some(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-3);
        // as is: (0,10,0), (1,10,0), (0,11,0); turned 90 deg about +Y: (1,0,0) -> (0,0,-1); scaled by 2 at x = 20
        for (const p of [[0, 10, 0], [1, 10, 0], [0, 11, 0], [10, 10, 0], [10, 10, -1], [10, 11, 0], [20, 10, 0], [22, 10, 0], [20, 12, 0]]) expect(has(p)).toBe(true);
    });

    it('writes format version 6 with uvs, materials and an atlas table naming colour, normal and emission atlases; reads versions 1 to 5; refuses unknown versions clearly', () => {
        expect(SBVG_VERSION).toBe(6);
        expect(sphere.header.version).toBe(6);
        expect(sphere.header.materialCount).toBe(0);
        // No materials, so nothing to re-texture: no atlases, and the file ends where the level blocks end.
        expect(sphere.header.atlasCount).toBe(0);
        expect(sphere.header.fileBytes).toBe(fs.statSync(path.join(tmp, 'sphere.sbvg')).size);
        // No glTF material on the fixture: every triangle says so, and the uv slots are present (zero).
        expect(sphere.materials.length).toBe(sphere.header.triangleCount);
        expect(sphere.materials.every(m => m === SBVG_NO_MATERIAL)).toBe(true);
        expect(sphere.vertices.length).toBe(sphere.header.vertexCount * 8);
        // A one-level header whose block sits past 4 GiB (hi word set): read as a 64-bit offset.
        const v2 = Buffer.alloc(SBVG_HEADER_BYTES + SBVG_LEVEL_WORDS * 4);
        v2.writeUInt32LE(0x47564253, 0); v2.writeUInt32LE(2, 4); v2.writeUInt32LE(v2.length, 8); v2.writeUInt32LE(1, 12);
        const row = SBVG_HEADER_BYTES;
        v2.writeUInt32LE(1, row + 8); // clusterCount
        v2.writeUInt32LE(16, row + 9 * 4); v2.writeUInt32LE(1, row + 10 * 4); // offset = 2^32 + 16
        v2.writeUInt32LE(128, row + 11 * 4); v2.writeUInt32LE(0, row + 12 * 4); // length = one cluster record
        v2.writeUInt32LE(3, 24 * 4);
        const h2 = parseSbvgHeader(new Uint8Array(v2));
        expect(h2.levels[0].byteOffset).toBe(4294967296 + 16);
        expect(h2.fileBytes).toBe(4294967296 + 16 + 128);
        expect(h2.skippedPrimitives).toBe(3);

        const v1 = Buffer.alloc(SBVG_HEADER_BYTES + SBVG_V1_LEVEL_WORDS * 4);
        v1.writeUInt32LE(0x47564253, 0); v1.writeUInt32LE(1, 4); v1.writeUInt32LE(v1.length, 8); v1.writeUInt32LE(1, 12);
        v1.writeUInt32LE(1, row + 8);
        v1.writeUInt32LE(v1.length, row + 9 * 4); v1.writeUInt32LE(128, row + 10 * 4);
        const h1 = parseSbvgHeader(new Uint8Array(v1));
        expect(h1.version).toBe(1);
        expect(h1.levels[0]).toMatchObject({ byteOffset: v1.length, byteLength: 128 });
        expect(h1.skippedPrimitives).toBe(0);

        const v7 = Buffer.from(v2);
        v7.writeUInt32LE(7, 4);
        expect(() => parseSbvgHeader(new Uint8Array(v7))).toThrow(/unsupported version 7.*rebuild/);
    });

    it('is deterministic: the same fixture always gives the same bytes (no FMA contraction, total-order heap ties)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-det-'));
        const glb = path.join(dir, 'fixture.glb');
        fs.writeFileSync(glb, writeGlb([{ prim: bumpySphere(60, 120, 1), translation: [10, 2, -3] }]));
        const a = await service.build(glb, path.join(dir, 'a.sbvg'));
        const b = await service.build(glb, path.join(dir, 'b.sbvg'));
        const hash = sha256(fs.readFileSync(a.sbvgPath));
        expect(sha256(fs.readFileSync(b.sbvgPath))).toBe(hash);
        // Pinned: a Linux (libstdc++, x86-64) or macOS (libc++, arm64) build must write exactly these bytes.
        expect(hash).toBe(DETERMINISTIC_FIXTURE_SHA256);

        // Where this Mac can also run x86-64 code (Rosetta), build the driver for it and compare.
        if (process.platform === 'darwin' && process.arch === 'arm64') {
            const x86 = path.join(dir, 'sbvg_builder_x86_64');
            const src = path.join(dir, 'builder.cpp');
            fs.writeFileSync(src, VIRTUAL_GEOMETRY_BUILDER_SOURCE);
            const compiled = spawnSync(process.env.CXX || 'clang++', ['-arch', 'x86_64', '-std=c++20', '-O3', '-ffp-contract=off', `-I${INCLUDE_DIR}`, src, '-o', x86]);
            const runs = compiled.status === 0 && spawnSync(x86, [glb, path.join(dir, 'x.sbvg')]).status === 0;
            if (runs) expect(sha256(fs.readFileSync(path.join(dir, 'x.sbvg')))).toBe(hash);
        }
    });

    const arch = requireFile(ARCH_GLB, 'checked-in asset');
    it.skipIf(!arch.ok)(withReason('builds a real 88k-triangle architectural GLB with a monotonic DAG', arch), async () => {
        const result = await service.build(path.join(REPO_ROOT, ARCH_GLB), path.join(tmp, 'arch.sbvg'));
        const file = readFile(fs.readFileSync(result.sbvgPath));
        expect(file.header.leafTriangleCount).toBe(88556);
        expect(file.header.levelCount).toBeGreaterThanOrEqual(6);
        expect(file.header.levels[0].byteLength).toBeLessThan(100 * 1024); // first visible block is small
        for (const c of file.clusters) expect(c.parentError).toBeGreaterThanOrEqual(c.selfError);
        for (const level of file.header.levels) {
            const tris = file.clusters.filter(c => c.level === level.level).flatMap(c => file.triangleVertices(c));
            expect(tris.length).toBe(level.triangleCount);
        }
    });
});

// ---------------------------------------------------------------------------

describe('Virtual geometry cluster selection rule (CPU copy of CULL_WGSL)', () => {
    it('always refines a LOD sphere closer than the camera near distance, as the GPU does (d <= near, not d <= 1e-6)', () => {
        const eye = [0, 0, 0];
        const near = 0.01;
        // Sphere surface 0.005 from the eye, tiny error: projected 1e-9 * 1000 / 0.005 = 2e-4 px, under any threshold,
        // but inside the near distance, so it must refine (1e30), like projectedError in CULL_WGSL.
        expect(projectedLodError([1.005, 0, 0, 1], 1e-9, eye, 1000, near)).toBe(1e30);
        expect(projectedLodError([1.05, 0, 0, 1], 1e-9, eye, 1000, near)).toBeCloseTo(1e-9 * 1000 / 0.05, 12);
        expect(projectedLodError([5, 0, 0, 1], 0, eye, 1000, near)).toBe(0);
        expect(projectedLodError([5, 0, 0, 1], 3e38, eye, 1000, near)).toBe(1e30);
        const c = { level: 1, self: [1.005, 0, 0, 1], selfError: 1e-9, parent: [1.005, 0, 0, 2], parentError: 1e-8 };
        // Parent and self both "always refine": a level-1 cluster is not drawn unless level 1 is the finest resident.
        expect(clusterSelected(c, { eye, lodScale: 1000, near, thresholdPx: 1, finestLevel: 0 })).toBe(false);
        expect(clusterSelected(c, { eye, lodScale: 1000, near, thresholdPx: 1, finestLevel: 1 })).toBe(true);
    });
});

/** Loads each GLB named on the command line with GlbSceneLoader and prints one line per file. */
const LOADER_HARNESS = `
#include "scratchbox_virtual_geometry.hpp"
#include <cstdio>
#include <fstream>
#include <iterator>
using namespace scratchbox::vgeo;
int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--level-math") {
        // 50M -> 40M triangles removes 20%: worth a level. 32-bit math wrapped and said no above ~45M.
        std::printf("%d %d %d\\n", levelReducesEnough(40000000ull, 50000000ull) ? 1 : 0,
                    levelReducesEnough(49000000ull, 50000000ull) ? 1 : 0, levelReducesEnough(4000000000ull, 4500000000ull) ? 1 : 0);
        return 0;
    }
    for (int i = 1; i < argc; ++i) {
        std::ifstream f(argv[i], std::ios::binary);
        std::vector<uint8_t> d((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        try {
            SourceMesh m = GlbSceneLoader::load(d.data(), d.size());
            std::printf("OK %zu %zu\\n", m.positions.size(), m.indices.size() / 3);
        } catch (const GlbFormatError& e) {
            std::printf("GLB_ERROR %s\\n", e.what());
        } catch (const std::exception& e) {
            std::printf("OTHER_ERROR %s\\n", e.what());
        }
    }
    return 0;
}
`;

/** A valid one-triangle GLB, with hooks to corrupt its JSON. */
function triangleGlb(edit: (json: any) => void = () => undefined, bin?: Buffer): Buffer {
    const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]).buffer);
    const indices = Buffer.from(new Uint32Array([0, 1, 2, 2, 1, 3]).buffer);
    const data = bin ?? Buffer.concat([positions, indices]);
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5125, count: 6, type: 'SCALAR' }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 24 }],
        buffers: [{ byteLength: data.length }]
    };
    edit(json);
    return rawGlb(json, data);
}

// The outline weld (vgeo::weld, kOutlineWeldM = 1 cm), a rule check on purpose small: two facade pieces whose
// shared edge is drawn twice, 5 mm apart, weld into one surface with that edge shared; a gap of 2 cm stays open; a
// piece's inner vertex 5 mm from the other piece's outline is not an outline vertex and stays; uvs stay per corner.
const OUTLINE_WELD = String.raw`
#include "scratchbox_virtual_geometry.hpp"
#include <cstdio>
#include <map>
using namespace scratchbox::vgeo;
static void quad(SourceMesh& m, F3 a, F3 b, F3 c, F3 d, float u0) {
    const uint32_t base = uint32_t(m.positions.size());
    for (F3 p : { a, b, c, d }) m.positions.push_back(p);
    for (int k = 0; k < 4; ++k) m.uvs.push_back(F2(u0 + (k == 1 || k == 2 ? 0.5f : 0.f), k >= 2 ? 1.f : 0.f));
    for (uint32_t i : { 0u, 1u, 2u, 0u, 2u, 3u }) m.indices.push_back(base + i);
    m.triMaterial.push_back(0); m.triMaterial.push_back(0);
}
static size_t openEdges(const WeldedMesh& w) {
    std::map<std::pair<uint32_t, uint32_t>, int> e;
    for (size_t t = 0; t + 2 < w.indices.size(); t += 3) for (int k = 0; k < 3; ++k) {
        uint32_t a = w.indices[t + k], b = w.indices[t + (k + 1) % 3]; e[{std::min(a, b), std::max(a, b)}]++;
    }
    size_t n = 0; for (auto& [k, c] : e) if (c == 1) ++n; return n;
}
int main() {
    for (float gap : { 0.005f, 0.02f }) {
        SourceMesh m; m.materialCount = 1;
        quad(m, F3(0, 0, 0), F3(1, 0, 0), F3(1, 1, 0), F3(0, 1, 0), 0.0f);
        quad(m, F3(1 + gap, 0, 0), F3(2, 0, 0), F3(2, 1, 0), F3(1 + gap, 1, 0), 0.5f);
        // a third piece: a fan whose centre (an inner vertex) sits 5 mm from the first piece's corner (0, 0, 0)
        const uint32_t c = uint32_t(m.positions.size());
        m.positions.push_back(F3(0.003f, 0.004f, 0.0f)); m.uvs.push_back(F2(0, 0));
        const F3 ring[4] = { F3(-1.5f, -1.5f, 0), F3(1.5f, -1.5f, 0), F3(1.5f, 1.5f, 0), F3(-1.5f, 1.5f, 0) };
        for (F3 p : ring) { m.positions.push_back(p); m.uvs.push_back(F2(0, 0)); }
        for (uint32_t k = 0; k < 4; ++k) { m.indices.push_back(c); m.indices.push_back(c + 1 + k); m.indices.push_back(c + 1 + (k + 1) % 4); m.triMaterial.push_back(0); }
        WeldedMesh w = weld(m);
        bool uvsKept = w.cornerUv.size() == w.indices.size() && w.cornerUv[6].x == 0.5f && w.cornerUv[0].x == 0.0f;
        std::printf("%.3f %zu %zu %zu %d\n", gap, w.positions.size(), w.indices.size() / 3, openEdges(w), uvsKept ? 1 : 0);
    }
    return 0;
}
`;

describe.skipIf(!clang.ok)(withReason('Virtual geometry outline weld (rule check)', clang), () => {
    it('welds outlines that meet within 1 cm, leaves a 2 cm gap and inner vertices alone, keeps uvs per corner', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-weld-'));
        fs.writeFileSync(path.join(dir, 'weld.cpp'), OUTLINE_WELD);
        const built = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O1', `-I${INCLUDE_DIR}`, path.join(dir, 'weld.cpp'), '-o', path.join(dir, 'weld')]);
        expect(built.stderr.toString()).not.toMatch(/error:/);
        const out = execFileSync(path.join(dir, 'weld')).toString().trim().split('\n').map(l => l.split(' ').map(Number));
        // 5 mm: the two quads share their middle edge (6 positions, 2 x 3 open edges + the fan's 4), the fan's centre stays
        expect(out[0].slice(1)).toEqual([6 + 5, 4 + 4, 6 + 4, 1]);
        // 2 cm: the quads stay apart (8 positions, 8 open edges + the fan's 4)
        expect(out[1].slice(1)).toEqual([8 + 5, 4 + 4, 8 + 4, 1]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

interface LoaderHarness { binary: string; mode: string; env: Record<string, string> }

/**
 * The strongest checking this machine runs: ASan + UBSan; else UBSan with macOS Guard Malloc (every heap
 * block ends at a protected page, 16-byte aligned, so an out-of-bounds read faults; Apple clang 16's ASan runtime aborts at
 * start-up on macOS 26); else unsanitized. Each candidate is kept only if it actually runs.
 */
function buildLoaderHarness(dir: string): LoaderHarness {
    const src = path.join(dir, 'loader_harness.cpp');
    fs.writeFileSync(src, LOADER_HARNESS);
    const cxx = process.env.CXX || 'clang++';
    const gmalloc = '/usr/lib/libgmalloc.dylib';
    const candidates: Array<LoaderHarness & { flags: string[] }> = [
        { mode: 'asan+ubsan', flags: ['-fsanitize=address,undefined'], binary: path.join(dir, 'h_asan'), env: { ASAN_OPTIONS: 'detect_leaks=0' } },
        ...(process.platform === 'darwin' && fs.existsSync(gmalloc)
            ? [{ mode: 'ubsan+guard-malloc', flags: ['-fsanitize=undefined'], binary: path.join(dir, 'h_gmalloc'), env: { DYLD_INSERT_LIBRARIES: gmalloc } }]
            : []),
        { mode: 'ubsan', flags: ['-fsanitize=undefined'], binary: path.join(dir, 'h_ubsan'), env: {} },
        { mode: 'unsanitized', flags: [], binary: path.join(dir, 'h_plain'), env: {} }
    ];
    for (const c of candidates) {
        const built = spawnSync(cxx, ['-std=c++20', '-O1', '-g', ...c.flags, ...(c.flags.length ? ['-fno-sanitize-recover=all'] : []), `-I${INCLUDE_DIR}`, src, '-o', c.binary]);
        if (built.status !== 0) continue;
        const probe = spawnSync(c.binary, ['--level-math'], { env: { ...process.env, ...c.env } });
        if (probe.status === 0) return { binary: c.binary, mode: c.mode, env: c.env };
    }
    throw new Error('could not build the GLB loader harness');
}

describe.skipIf(!clang.ok)(withReason('GLB loader on malformed input (ASan + UBSan when the compiler supports them)', clang), () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-fuzz-'));
    let harness: LoaderHarness;
    const run = (files: string[]) => {
        const r = spawnSync(harness.binary, files, { env: { ...process.env, ...harness.env }, maxBuffer: 64 * 1024 * 1024 });
        return { status: r.status, signal: r.signal, lines: r.stdout.toString().trim().split('\n'), stderr: r.stderr.toString() };
    };
    beforeAll(() => {
        harness = buildLoaderHarness(dir);
        console.info(`virtual geometry loader fuzz: ${harness.mode}`);
    });

    it('decides whether a level is worth adding in 64-bit arithmetic (no wrap above ~45M triangles)', () => {
        expect(run(['--level-math']).lines[0]).toBe('1 0 1');
    });

    it('rejects each malformed accessor, bufferView and JSON with a typed GlbFormatError and no memory error', () => {
        const cases: Record<string, Buffer> = {
            valid: triangleGlb(),
            negativeAccessorOffset: triangleGlb(j => { j.accessors[0].byteOffset = -4; }),
            hugeAccessorOffset: triangleGlb(j => { j.accessors[0].byteOffset = 2 ** 40; }),
            hugeViewOffset: triangleGlb(j => { j.bufferViews[0].byteOffset = 2 ** 62; }),
            negativeViewOffset: triangleGlb(j => { j.bufferViews[1].byteOffset = -48; }),
            hugeCount: triangleGlb(j => { j.accessors[0].count = 1e15; }),
            negativeCount: triangleGlb(j => { j.accessors[1].count = -1; }),
            fractionalCount: triangleGlb(j => { j.accessors[0].count = 2.5; }),
            hugeStride: triangleGlb(j => { j.bufferViews[0].byteStride = 1e6; }),
            negativeStride: triangleGlb(j => { j.bufferViews[0].byteStride = -12; }),
            strideBelowElement: triangleGlb(j => { j.bufferViews[0].byteStride = 4; }),
            accessorPastItsView: triangleGlb(j => { j.bufferViews[0].byteLength = 36; }),
            viewPastBin: triangleGlb(j => { j.bufferViews[1].byteLength = 4096; }),
            viewWithoutLength: triangleGlb(j => { delete j.bufferViews[0].byteLength; }),
            viewIndexOutOfRange: triangleGlb(j => { j.accessors[0].bufferView = 7; }),
            accessorIndexOutOfRange: triangleGlb(j => { j.meshes[0].primitives[0].attributes.POSITION = 9; }),
            negativeNodeIndex: triangleGlb(j => { j.scenes[0].nodes = [-1]; }),
            infiniteIndex: triangleGlb(j => { j.meshes[0].primitives[0].indices = 1e300; }),
            indexValueOutOfRange: triangleGlb(() => undefined, Buffer.concat([Buffer.from(new Float32Array(12).buffer), Buffer.from(new Uint32Array([0, 1, 9, 2, 1, 3]).buffer)])),
            deepJson: rawGlb('['.repeat(200000)),
            truncatedLiteral: rawGlb('{"asset":tru'),
            truncatedNull: rawGlb('{"scene":nu'),
            jsonLengthLies: (() => { const g = triangleGlb(); g.writeUInt32LE(0x7fffffff, 12); return g; })()
        };
        const names = Object.keys(cases);
        const files = names.map(n => { const f = path.join(dir, `${n}.glb`); fs.writeFileSync(f, cases[n]); return f; });
        const r = run(files);
        expect(r.stderr, 'sanitizer report').not.toMatch(/ERROR: (Address|UndefinedBehavior)Sanitizer|runtime error:/);
        expect(r.status).toBe(0);
        expect(r.lines).toHaveLength(names.length);
        const byName = Object.fromEntries(names.map((n, i) => [n, r.lines[i]]));
        expect(byName.valid).toBe('OK 4 2');
        for (const n of names.filter(x => x !== 'valid')) expect(byName[n], n).toMatch(/^GLB_ERROR /);
        expect(byName.accessorPastItsView).toMatch(/past the end of its bufferView/);
        expect(byName.viewPastBin).toMatch(/out of BIN bounds/);
        expect(byName.deepJson).toMatch(/nesting too deep/);
        expect(byName.indexValueOutOfRange).toMatch(/index out of range/);
    });

    it('survives random byte mutations of a valid GLB (every input loads or fails with a message)', () => {
        const base = writePrimitivesGlb([
            { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), indices: new Uint32Array([0, 1, 2, 2, 1, 3]) },
            { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]), mode: 5 }
        ]);
        let seed = 0x9e3779b9;
        const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
        const files: string[] = [];
        for (let k = 0; k < 400; k++) {
            const g = Buffer.from(base);
            const flips = 1 + Math.floor(rand() * 6);
            for (let f = 0; f < flips; f++) {
                const at = Math.floor(rand() * g.length);
                // Half the mutations write digits/structure into the JSON so numbers and nesting change, half are raw bytes.
                g[at] = rand() < 0.5 ? '0123456789-[]{}:,e."'.charCodeAt(Math.floor(rand() * 21)) : Math.floor(rand() * 256);
            }
            const file = path.join(dir, `mut_${k}.glb`);
            fs.writeFileSync(file, g);
            files.push(file);
        }
        const r = run(files);
        expect(r.stderr, 'sanitizer report').not.toMatch(/ERROR: (Address|UndefinedBehavior)Sanitizer|runtime error:/);
        expect(r.status).toBe(0);
        expect(r.lines).toHaveLength(files.length);
        for (const line of r.lines) expect(line).toMatch(/^(OK \d+ \d+|GLB_ERROR .+|OTHER_ERROR .+)$/);
    });
});

// ---------------------------------------------------------------------------

const RENDER_ENTRY = `
import { VirtualGeometryRenderer } from './src/browser/generative-canvas/services/virtual-geometry/VirtualGeometryRenderer';
const W = 960, H = 600;
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
canvas.style.cssText = 'width:' + W + 'px;height:' + H + 'px;display:block';
document.body.appendChild(canvas);
const probe = document.createElement('canvas');
probe.width = W; probe.height = H;
let renderer;
window.load = async (url, opts = {}) => {
    renderer?.dispose();
    renderer = new VirtualGeometryRenderer(canvas, { clearColor: [0, 0, 0], ...opts });
    await renderer.initialize();
    const stages = [];
    await renderer.load(url, s => stages.push({ finest: s.finestLoadedLevel, loadedClusters: s.loadedClusters, bytes: s.bytesReceived }));
    return { stages, stats: renderer.getStats() };
};
window.shot = async (opts) => {
    if (opts.camera) renderer.setCamera(opts.camera);
    renderer.setErrorThreshold(opts.threshold ?? 1);
    renderer.setShading(opts.shading ?? 'clay');
    renderer.requestStats();
    renderer.renderFrame();
    const stats = await renderer.settle();
    // Draw the frame into a 2D canvas in the same task (before it is presented) to count covered pixels.
    renderer.renderFrame();
    const ctx = probe.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    let covered = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 12) covered++;
    return { stats, coverage: covered / (W * H) };
};
// The clusters the GPU cull pass picked for a camera and threshold, with the inputs it used.
window.selection = async (opts) => {
    const base = renderer.getCamera();
    renderer.setCamera({ ...opts.camera, distance: base.distance * (opts.distanceScale ?? 1), yaw: base.yaw + (opts.yawOffset ?? 0) });
    renderer.setErrorThreshold(opts.threshold);
    renderer.renderFrame();
    const visible = await renderer.readVisibleClusters();
    const params = renderer.getSelectionParams();
    renderer.setCamera(base);
    return { visible, params };
};
window.__ready = true;
`;

const renderReady = requireAll(clang, webgpuChrome);
describe.skipIf(!renderReady.ok)(withReason('Virtual geometry WebGPU renderer (Chrome, streamed .sbvg)', renderReady), () => {
    it('streams levels coarsest first, renders a closed cut with one indirect draw, and saves screenshots', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-render-'));
        const glb = path.join(tmp, 'scene.glb');
        const arch = path.join(REPO_ROOT, ARCH_GLB);
        if (fs.existsSync(arch)) fs.copyFileSync(arch, glb);
        else fs.writeFileSync(glb, writeGlb([{ prim: bumpySphere(160, 320, 1) }]));
        const built = await new VirtualGeometryBuildService().build(glb, path.join(tmp, 'scene.sbvg'));
        const sbvg = fs.readFileSync(built.sbvgPath);
        const header: SbvgHeader = parseSbvgHeader(new Uint8Array(sbvg.buffer, sbvg.byteOffset, sbvg.byteLength));

        await withWebGpuPage({ contents: RENDER_ENTRY, resolveDir: path.resolve(__dirname, '..') }, { '/scene.sbvg': sbvg }, { width: 960, height: 600 }, async page => {
            const loaded = await page.evaluate(`window.load('/scene.sbvg')`);
            expect(page.errors).toEqual([]);
            expect(loaded.stages.map((s: any) => s.finest)).toEqual(header.levels.map(l => l.level));
            expect(loaded.stats.loadedClusters).toBe(header.clusterCount);
            expect(loaded.stats.bytesReceived).toBe(sbvg.length);

            const overview = await page.evaluate(`window.shot({ shading: 'clay' })`);
            await page.screenshot(path.join(SCREENSHOTS, 'virtual_geometry_overview_clay.png'));
            const clusters = await page.evaluate(`window.shot({ shading: 'clusters' })`);
            await page.screenshot(path.join(SCREENSHOTS, 'virtual_geometry_overview_clusters.png'));
            const coarse = await page.evaluate(`window.shot({ shading: 'lod-levels', threshold: 16 })`);
            await page.screenshot(path.join(SCREENSHOTS, 'virtual_geometry_overview_lod_levels_16px.png'));

            for (const s of [overview, clusters, coarse]) {
                expect(s.stats.drawCalls).toBe(1);
                expect(s.stats.visibleClusters).toBeGreaterThan(0);
                expect(s.stats.visibleTriangles).toBeGreaterThan(0);
                expect(s.stats.visibleTriangles).toBeLessThanOrEqual(header.leafTriangleCount);
                expect(s.coverage).toBeGreaterThan(0.05); // the model fills a real part of the frame
            }
            // A looser error budget draws fewer triangles for the same view.
            expect(coarse.stats.visibleTriangles).toBeLessThan(overview.stats.visibleTriangles);
            expect(page.errors).toEqual([]);
        });
    });

    it('selects on the GPU exactly the clusters the CPU rule selects, for several cameras and thresholds', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vgeo-gpucpu-'));
        const glb = path.join(tmp, 'scene.glb');
        const arch = path.join(REPO_ROOT, ARCH_GLB);
        if (fs.existsSync(arch)) fs.copyFileSync(arch, glb);
        else fs.writeFileSync(glb, writeGlb([{ prim: bumpySphere(160, 320, 1) }]));
        const built = await new VirtualGeometryBuildService(undefined, { cacheDir: tmp }).build(glb, path.join(tmp, 'scene.sbvg'));
        const sbvg = fs.readFileSync(built.sbvgPath);
        const file = readFile(sbvg);

        await withWebGpuPage({ contents: RENDER_ENTRY, resolveDir: path.resolve(__dirname, '..') }, { '/scene.sbvg': sbvg }, { width: 960, height: 600 }, async page => {
            // Frustum and cone culling off: what is left is the LOD rule alone, which the CPU copy must match.
            await page.evaluate(`window.load('/scene.sbvg', { frustumCulling: false, coneCulling: false })`);
            let compared = 0, mixedLevels = 0;
            for (const view of [{ distanceScale: 1 }, { distanceScale: 0.15 }, { distanceScale: 0.04, yawOffset: 1.3 }, { distanceScale: 6, yawOffset: -2 }]) {
                for (const threshold of [0.5, 1, 4, 16]) {
                    const { visible, params } = await page.evaluate(`window.selection(${JSON.stringify({ ...view, threshold })})`);
                    const p: ClusterSelectionParams = params;
                    const cpu = file.clusters.filter(c => clusterSelected(c, p)).map(c => c.index);
                    const gpuSet = new Set<number>(visible);
                    const cpuSet = new Set(cpu);
                    const differing = [...cpu.filter(i => !gpuSet.has(i)), ...visible.filter((i: number) => !cpuSet.has(i))];
                    // The GPU evaluates in float32: a cluster may only differ when one of its tests sits on the threshold.
                    for (const i of differing) {
                        const c = file.clusters[i];
                        const pe = projectedLodError(c.parent, c.parentError, p.eye, p.lodScale, p.near);
                        const se = projectedLodError(c.self, c.selfError, p.eye, p.lodScale, p.near);
                        const onEdge = Math.abs(pe - p.thresholdPx) <= 1e-4 * p.thresholdPx || Math.abs(se - p.thresholdPx) <= 1e-4 * p.thresholdPx;
                        expect(onEdge, `cluster ${i} differs at ${JSON.stringify(view)} ${threshold}px (parent ${pe}, self ${se})`).toBe(true);
                    }
                    expect(differing.length).toBeLessThanOrEqual(Math.max(2, cpu.length * 0.002));
                    expect(visible.length).toBeGreaterThan(0);
                    if (new Set(cpu.map(i => file.clusters[i].level)).size > 1) mixedLevels++;
                    compared++;
                }
            }
            expect(compared).toBe(16);
            expect(mixedLevels).toBeGreaterThan(0);
            expect(page.errors).toEqual([]);
        });
    });
});
