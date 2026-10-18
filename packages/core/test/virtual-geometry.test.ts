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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VirtualGeometryBuildService, VirtualGeometryBuildError } from '../src/node/3d-engine/virtual-geometry-service';
import { parseSbvgHeader, splitSbvgLevelBlock, SBVG_CLUSTER_WORDS, type SbvgHeader } from '../src/browser/generative-canvas/services/virtual-geometry/sbvg-format';
import { requireAll, requireBinary, requireFile, withReason, REPO_ROOT } from './helpers/requirements';
import { webgpuChrome, withWebGpuPage } from './helpers/webgpu-chrome';

const clang = requireBinary(process.env.CXX || 'clang++', 'install clang++ (C++20)');
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

function readFile(file: Buffer) {
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const header = parseSbvgHeader(bytes);
    const clusters: ClusterRec[] = [];
    const vertices = new Float32Array(header.vertexCount * 6);
    const refs = new Uint32Array(header.refCount);
    const tris = new Uint32Array(header.triangleCount);
    for (const level of header.levels) {
        const parts = splitSbvgLevelBlock(level, bytes.subarray(level.byteOffset, level.byteOffset + level.byteLength));
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
        vertices.set(new Float32Array(parts.vertices.slice().buffer), level.vertexStart * 6);
        refs.set(new Uint32Array(parts.refs.slice().buffer), level.refStart);
        tris.set(new Uint32Array(parts.triangles.slice().buffer), level.triangleStart);
    }
    const triangleVertices = (c: ClusterRec) => {
        const out: Array<[number, number, number]> = [];
        for (let t = 0; t < c.triCount; t++) {
            const p = tris[c.triOffset + t];
            out.push([refs[c.refOffset + (p & 255)], refs[c.refOffset + ((p >> 8) & 255)], refs[c.refOffset + ((p >> 16) & 255)]]);
        }
        return out;
    };
    return { header, clusters, vertices, refs, tris, triangleVertices };
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

/** The renderer's selection rule (CULL_WGSL), on the CPU, without frustum/cone culling. */
function selectCut(file: ReturnType<typeof readFile>, eye: number[], lodScale: number, thresholdPx: number, finestLevel: number) {
    const proj = (s: number[], err: number) => {
        if (err <= 0) return 0;
        if (err >= 1e37) return 1e30;
        const d = Math.hypot(s[0] - eye[0], s[1] - eye[1], s[2] - eye[2]) - s[3];
        return d <= 1e-6 ? 1e30 : (err * lodScale) / d;
    };
    return file.clusters.filter(c => c.level >= finestLevel
        && proj(c.parent, c.parentError) > thresholdPx
        && (c.level === finestLevel || proj(c.self, c.selfError) <= thresholdPx));
}

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
window.load = async (url) => {
    renderer = new VirtualGeometryRenderer(canvas, { clearColor: [0, 0, 0] });
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
});
