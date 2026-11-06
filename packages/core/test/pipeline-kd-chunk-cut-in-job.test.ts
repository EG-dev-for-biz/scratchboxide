/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D's chunk cut moved into the chunk's own job (district-chunks.ts cutChunkLayer: cut, placed and compacted
 * in the district's exact frame), the laptop only checking and publishing what comes back (joinChunkLayerFile, on its
 * worker thread): held to the join as it ran on the laptop's main thread
 * (helpers/legacy-join-chunk-glb.ts, frozen) for geometry, placement and extras, and the compaction to leaving no
 * unreferenced byte. KD_PARITY_RUN_DIR (a workspace holding a real district run: public/models and the run's
 * district_chunks note) runs the same parity over its real chunk layers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { kdChunkJobKeys, KD_CHUNK_JOB_SCHEMA, type KdChunkJobOutcome, type KdChunkJobSpec } from '../src/node/3d-engine/staged-location/cloud-chunk-runner';
import { runKdChunkJob } from '../src/node/3d-engine/staged-location/kd-chunk-job';
import { createChunkJoiner } from '../src/node/3d-engine/staged-location/pipeline-k/chunk-join-worker';
import {
    chunkKeep, cutChunkLayer, DISTRICT_CHUNKS_PARAMS, frameTransform, joinChunkGlb, joinChunkLayerFile, KD_CHUNK_CUT_VERSION, planDistrictChunks,
    type DistrictChunkPlan, type KdChunkCutSpec, type TileFrame
} from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, type ParsedGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import type { StagedLocationOutcome } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { legacyJoinChunkGlb } from './helpers/legacy-join-chunk-glb';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `kd-cut-${name}-`));
const align4 = (n: number) => n + ((4 - (n % 4)) % 4);

/** A GLB built by hand: every accessor its own bufferView, in the order given. */
class GlbBuilder {
    json: any = { asset: { version: '2.0', extras: { scratchbox: { attributes: { _PROUD_BLOCK: 'test' } } } }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
    private parts: Uint8Array[] = [];
    private length = 0;
    view(data: Uint8Array, target?: number): number {
        this.json.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: data.byteLength, ...(target ? { target } : {}) });
        this.parts.push(data);
        this.length += align4(data.byteLength);
        return this.json.bufferViews.length - 1;
    }
    accessor(data: Float32Array | Uint32Array | Uint16Array, type: string, target: number, minMax = false): number {
        const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint32Array ? 5125 : 5123;
        const comps = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
        const extra: Record<string, unknown> = {};
        if (minMax) {
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < data.length; i++) { lo[i % 3] = Math.min(lo[i % 3], data[i]); hi[i % 3] = Math.max(hi[i % 3], data[i]); }
            Object.assign(extra, { min: lo, max: hi });
        }
        this.json.accessors.push({ bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), target), componentType, count: data.length / comps, type, ...extra });
        return this.json.accessors.length - 1;
    }
    build(): Buffer {
        const bin = new Uint8Array(this.length);
        let o = 0;
        for (const p of this.parts) { bin.set(p, o); o += align4(p.byteLength); }
        this.json.buffers[0].byteLength = this.length;
        return assembleGlb(this.json, bin);
    }
}

/** A grid of quads over [x0, x1] x [z0, z1] (step m) with normals and UVs; its positions, normals, UVs and triangle corners. */
function grid(x0: number, x1: number, z0: number, z1: number, step: number, y: (x: number, z: number) => number) {
    const nx = Math.round((x1 - x0) / step), nz = Math.round((z1 - z0) / step);
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + i * step, z = z0 + j * step;
        pos.push(x, y(x, z), z); nrm.push(0.1 * Math.sin(x), 1, 0.1 * Math.cos(z)); uv.push(i / nx, j / nz);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
    }
    return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: Float32Array.from(uv), idx };
}

/** A chunk's scan-like layer: a textured ground under a transformed group, a uint16 roof, a non-indexed wall, extras on every node. */
function chunkLayer(half: number): Buffer {
    const b = new GlbBuilder();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7]);
    b.json.images = [{ bufferView: b.view(png), mimeType: 'image/png' }];
    b.json.textures = [{ source: 0 }];
    b.json.materials.push({ name: 'photo', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extras: { provenance: 'measured' } }, { name: 'clay' });
    const g = grid(-half, half, -half, half, 4, (x, z) => 0.02 * x + 0.01 * z);
    b.json.meshes.push({ name: 'ground', extras: { provenance: 'measured', confidence: 0.9 }, primitives: [{ attributes: { POSITION: b.accessor(g.pos, 'VEC3', 34962, true), NORMAL: b.accessor(g.nrm, 'VEC3', 34962), TEXCOORD_0: b.accessor(g.uv, 'VEC2', 34962) }, indices: b.accessor(Uint32Array.from(g.idx), 'SCALAR', 34963), material: 0 }] });
    const r = grid(-20, 30, -25, 25, 5, () => 0);
    b.json.meshes.push({ name: 'roof', extras: { provenance: 'vector-modelled' }, primitives: [{ attributes: { POSITION: b.accessor(r.pos, 'VEC3', 34962, true) }, indices: b.accessor(Uint16Array.from(r.idx), 'SCALAR', 34963), material: 1 }] });
    const wall: number[] = [];
    for (let k = -half; k < half; k += 8) wall.push(k, 0, 0, k + 8, 0, 0, k + 8, 12, 0, k, 0, 0, k + 8, 12, 0, k, 12, 0);
    b.json.meshes.push({ name: 'wall', primitives: [{ attributes: { POSITION: b.accessor(Float32Array.from(wall), 'VEC3', 34962, true) } }] });
    b.json.nodes.push(
        { name: 'group', translation: [1.5, -0.25, 2.0], rotation: [0, Math.sin(0.15), 0, Math.cos(0.15)], children: [1, 2, 3], extras: { scratchbox: { source: 'Google3DTilesClay' } } },
        { name: 'ground', mesh: 0, extras: { scratchbox: { provenance: 'measured', confidence: 0.95 } } },
        { name: 'roof', mesh: 1, translation: [0, 41.5, 0], extras: { scratchbox: { provenance: 'vector-modelled' } } },
        { name: 'wall', mesh: 2, matrix: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 7, 0, -3, 1] }
    );
    b.json.scenes[0].nodes = [0];
    return b.build();
}

/**
 * Trees: two crown meshes, each drawn by many nodes (instanced, so placed on a root node, never baked; a mesh drawn by
 * several nodes is cut by the first that draws it): the west one's first tree in the centre's cell, the east one's in this chunk's.
 */
function treesLayer(half: number): Buffer {
    const b = new GlbBuilder();
    b.json.materials.push({ name: 'leaf' });
    const crown = Float32Array.from([-1, 0, -1, 1, 0, -1, 0, 5, 0, 1, 0, -1, 1, 0, 1, 0, 5, 0, 1, 0, 1, -1, 0, 1, 0, 5, 0]);
    for (const name of ['crown_west', 'crown_east']) {
        b.json.meshes.push({ name, extras: { provenance: 'generated' }, primitives: [{ attributes: { POSITION: b.accessor(crown, 'VEC3', 34962, true) }, indices: b.accessor(Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]), 'SCALAR', 34963), material: 0 }] });
    }
    // the east crown's first tree stands in the chunk's own cell: that crown is kept, the west one left to the centre
    b.json.nodes.push({ name: 'tree_first_east', mesh: 1, translation: [10, 0, 3], extras: { species: 'Platanus' } });
    for (let x = -half + 3; x < half; x += 11) for (let z = -half + 5; z < half; z += 13) b.json.nodes.push({ name: `tree_${x}_${z}`, mesh: x < 0 ? 0 : 1, translation: [x, 0, z], extras: { species: 'Platanus' } });
    b.json.scenes[0].nodes = b.json.nodes.map((_: unknown, i: number) => i);
    return b.build();
}

/** A trees layer whose every mesh is drawn once (so baked), two connected pieces in one primitive. */
function hedgesLayer(): Buffer {
    const b = new GlbBuilder();
    const pos: number[] = [], idx: number[] = [];
    for (const [cx, cz] of [[-61, 3], [-55, 3], [58, -4], [63, 9]]) {
        const o = pos.length / 3;
        pos.push(cx - 3, 0, cz, cx + 3, 0, cz, cx + 3, 2, cz, cx - 3, 2, cz);
        idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    b.json.meshes.push({ name: 'hedges', primitives: [{ attributes: { POSITION: b.accessor(Float32Array.from(pos), 'VEC3', 34962, true) }, indices: b.accessor(Uint32Array.from(idx), 'SCALAR', 34963) }] });
    b.json.nodes.push({ name: 'hedges', mesh: 0 });
    b.json.scenes[0].nodes = [0];
    return b.build();
}

/** A plain ground (one node, no transform): in the district's own frame its vertices lie exactly on the cell lines. */
function lineGround(): Buffer {
    const b = new GlbBuilder();
    const g = grid(-100, 100, -100, 100, 4, () => 0);
    b.json.meshes.push({ name: 'ground', primitives: [{ attributes: { POSITION: b.accessor(g.pos, 'VEC3', 34962, true), NORMAL: b.accessor(g.nrm, 'VEC3', 34962) }, indices: b.accessor(Uint32Array.from(g.idx), 'SCALAR', 34963) }] });
    b.json.nodes.push({ name: 'ground', mesh: 0 });
    b.json.scenes[0].nodes = [0];
    return b.build();
}

/** A district plan of 300 m, buildings straddling the cell lines around the chunk east of the centre. */
function district(): { plan: DistrictChunkPlan; place: { lat: number; lng: number }; index: number } {
    const box = (id: string, x0: number, z0: number, x1: number, z1: number) => ({ id, centroid: [(x0 + x1) / 2, (z0 + z1) / 2] as [number, number], loops: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as Array<[number, number]>] });
    const plan = planDistrictChunks(300, [
        box('a', 50, -20, 75, 10), box('b', 165, 50, 190, 75), box('c', 150, -80, 172, -55), box('d', 120, -10, 140, 20), box('e', 172, -15, 195, 15)
    ])!;
    const index = plan.chunks.findIndex(c => c.cx === 120 && c.cz === 0);
    return { plan, place: { lat: 40.75032, lng: -73.99172 }, index };
}

/** The chunk's frame: about at its cell's centre (as frameToLatLng puts it), with an origin height of its own. */
function chunkFrame(place: { lat: number; lng: number }, cx: number, cz: number, h: number): TileFrame {
    return { lat: place.lat - cz / 111_132, lng: place.lng + cx / (111_320 * Math.cos(place.lat * Math.PI / 180)), originEllipsoidalHeightM: h };
}

/**
 * What a GLB shows, independent of how its buffer is laid out: per node (its name, extras, world matrix) each primitive's
 * material, mode and every triangle's corners with every attribute's stored values; and the JSON besides the lists.
 */
function shown(glb: ParsedGlb) {
    const { json } = glb;
    const world = nodeWorldMatrices(json);
    const nodes = (json.nodes ?? []).map((n: any, ni: number) => ({
        name: n.name, extras: n.extras, children: n.children, mesh: n.mesh, world: Array.from(world[ni]),
        prims: n.mesh === undefined ? undefined : json.meshes[n.mesh].primitives.map((p: any) => {
            const idx = p.indices !== undefined ? readAccessor(glb, p.indices).data : undefined;
            const attrs = Object.keys(p.attributes).sort();
            const data = Object.fromEntries(attrs.map(a => [a, readAccessor(glb, p.attributes[a])]));
            const corners: number[] = [];
            const count = idx ? idx.length : data.POSITION.count;
            for (let k = 0; k < count; k++) {
                const v = idx ? idx[k] : k;
                for (const a of attrs) for (let c = 0; c < data[a].comps; c++) corners.push(data[a].data[v * data[a].comps + c]);
            }
            return { material: p.material, mode: p.mode, attrs, triangles: count / 3, corners, min: json.accessors[p.attributes.POSITION].min, max: json.accessors[p.attributes.POSITION].max };
        })
    }));
    const images = (json.images ?? []).map((im: any) => {
        const v = json.bufferViews[im.bufferView];
        return { mimeType: im.mimeType, bytes: Array.from(glb.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)) };
    });
    const meshes = (json.meshes ?? []).map((m: any) => ({ name: m.name, extras: m.extras }));
    return { asset: json.asset, scene: json.scene, scenes: json.scenes, materials: json.materials, textures: json.textures, images, meshes, nodes };
}

/** Bytes of the binary chunk no accessor or image reads (the bufferViews' padding aside), and lists entries nothing uses. */
function unreferenced(bytes: Uint8Array): { bytes: number; views: number; accessors: number } {
    const { json, bin } = parseGlbBytes(bytes);
    const usedAcc = new Set<number>();
    for (const m of json.meshes ?? []) for (const p of m.primitives) { for (const a of Object.values(p.attributes)) usedAcc.add(a as number); if (p.indices !== undefined) usedAcc.add(p.indices); }
    const usedViews = new Set<number>();
    for (const a of usedAcc) usedViews.add(json.accessors[a].bufferView);
    for (const im of json.images ?? []) if (im.bufferView !== undefined) usedViews.add(im.bufferView);
    const covered = new Uint8Array(bin.byteLength);
    for (const v of usedViews) { const o = json.bufferViews[v].byteOffset ?? 0; covered.fill(1, o, Math.min(bin.byteLength, o + align4(json.bufferViews[v].byteLength))); }
    let free = 0;
    for (const c of covered) free += c ? 0 : 1;
    return { bytes: free, views: json.bufferViews.length - usedViews.size, accessors: json.accessors.length - usedAcc.size };
}

describe('pipeline K-D: the chunk cut in its own job, the laptop only publishing it', () => {
    const { plan, place, index } = district();
    const c = plan.chunks[index];
    const here: TileFrame = { lat: place.lat, lng: place.lng, originEllipsoidalHeightM: -8.7 };
    const frame = chunkFrame(place, c.cx, c.cz, 12.3);
    const m = frameTransform(frame, here);
    const bandM = DISTRICT_CHUNKS_PARAMS.seamBandM;
    const cutIn = (bytes: Uint8Array, whole: boolean, chunk = index, f = frame) => cutChunkLayer(bytes, { frame: f, district: here, plan, bandM, of, chunk, whole });
    const of = 'c81d307d';
    const layers: Array<{ name: string; bytes: Buffer; whole: boolean }> = [
        { name: 'ground', bytes: chunkLayer(c.half + 40), whole: false },
        { name: 'trees', bytes: treesLayer(c.half + 30), whole: true },
        { name: 'hedges', bytes: hedgesLayer(), whole: true }
    ];
    const joinJob = (source: string, target: string, whole: boolean, chunk = index) => ({ source, target, transform: Array.from(m), whole, of, chunk, plan, bandM });

    it('gives, cut in the job and published here, the same geometry, placement and extras as the join on the laptop did', () => {
        const dir = tmp('parity');
        for (const l of layers) {
            const keep = chunkKeep(plan, index, l.whole, bandM);
            const legacy = legacyJoinChunkGlb(l.bytes, m, keep, { whole: l.whole });
            const job = cutIn(l.bytes, l.whole);
            fs.writeFileSync(path.join(dir, `${l.name}.glb`), job.glb);
            const r = joinChunkLayerFile(joinJob(path.join(dir, `${l.name}.glb`), path.join(dir, `${l.name}_kd.glb`), l.whole));
            // a real cut: some of the layer kept, some left to the neighbours
            expect(legacy.keptTriangles, l.name).toBeGreaterThan(0);
            expect(legacy.removedTriangles, l.name).toBeGreaterThan(0);
            expect(r.cutBy).toBe('job');
            expect({ kept: r.keptTriangles, removed: r.removedTriangles, pieces: r.pieces }).toEqual({ kept: legacy.keptTriangles, removed: legacy.removedTriangles, pieces: legacy.pieces });
            // the same triangles, every attribute bit for bit, at the same place (baked, or on the same root node), the same extras
            const after = parseGlbBytes(fs.readFileSync(path.join(dir, `${l.name}_kd.glb`)));
            expect(shown(after), l.name).toEqual(shown(parseGlbBytes(legacy.glb)));
            // the stamp is the job's to the laptop, not the layer's: the asset's extras are the build's
            expect(after.json.asset).toEqual(parseGlbBytes(l.bytes).json.asset);
            // and the one-machine join (the centre built here, the placeholders) is unchanged too
            expect(shown(parseGlbBytes(joinChunkGlb(l.bytes, m, keep, { whole: l.whole }).glb)), l.name).toEqual(shown(parseGlbBytes(legacy.glb)));
        }
    });

    it('cuts what lies exactly on a cell line as the laptop did: the frame is the exact one', () => {
        // the centre chunk, whose frame is the district's: its ground's vertices fall exactly on its cell lines (x, z = +-60)
        const centre = plan.chunks.findIndex(k => k.centre), dir = tmp('online');
        const bytes = lineGround(), mc = frameTransform(here, here);
        const legacy = legacyJoinChunkGlb(bytes, mc, chunkKeep(plan, centre, false, 0));
        const job = cutChunkLayer(bytes, { frame: here, district: here, plan, bandM: 0, of, chunk: centre, whole: false });
        fs.writeFileSync(path.join(dir, 'g.glb'), job.glb);
        const r = joinChunkLayerFile({ source: path.join(dir, 'g.glb'), target: path.join(dir, 'g_kd.glb'), transform: Array.from(mc), whole: false, of, chunk: centre, plan, bandM: 0 });
        expect(r.keptTriangles).toBe(legacy.keptTriangles);
        expect(shown(parseGlbBytes(fs.readFileSync(path.join(dir, 'g_kd.glb'))))).toEqual(shown(parseGlbBytes(legacy.glb)));
    });

    it('cuts here, as before, a layer that came uncut (a chunk built on this machine, a job without the frame)', () => {
        const dir = tmp('fallback');
        for (const l of layers) {
            fs.writeFileSync(path.join(dir, `${l.name}.glb`), l.bytes);
            const r = joinChunkLayerFile(joinJob(path.join(dir, `${l.name}.glb`), path.join(dir, `${l.name}_kd.glb`), l.whole));
            const legacy = legacyJoinChunkGlb(l.bytes, m, chunkKeep(plan, index, l.whole, bandM), { whole: l.whole });
            expect(r.cutBy).toBe('here');
            expect(r.keptTriangles).toBe(legacy.keptTriangles);
            expect(shown(parseGlbBytes(fs.readFileSync(path.join(dir, `${l.name}_kd.glb`)))), l.name).toEqual(shown(parseGlbBytes(legacy.glb)));
        }
    });

    it('leaves no unreferenced byte in what the job sends or the laptop writes; the old join carried the replaced data along', () => {
        const dir = tmp('compact');
        const l = layers[0];
        const legacy = legacyJoinChunkGlb(l.bytes, m, chunkKeep(plan, index, false, bandM));
        // the old join: the uncut indices and the unplaced positions and normals still in the file
        expect(unreferenced(legacy.glb).bytes).toBeGreaterThan(0);
        const job = cutIn(l.bytes, false);
        expect(unreferenced(job.glb)).toEqual({ bytes: 0, views: 0, accessors: 0 });
        expect(job.glb.byteLength).toBeLessThan(legacy.glb.byteLength);
        expect(job.stamp.droppedBytes).toBeGreaterThan(0);
        fs.writeFileSync(path.join(dir, 'g.glb'), job.glb);
        const r = joinChunkLayerFile(joinJob(path.join(dir, 'g.glb'), path.join(dir, 'g_kd.glb'), false));
        const out = fs.readFileSync(path.join(dir, 'g_kd.glb'));
        expect(unreferenced(out)).toEqual({ bytes: 0, views: 0, accessors: 0 });
        expect(r.bytesOut).toBe(out.byteLength);
        // the laptop's own join (an uncut layer) and the one-machine join compact too
        fs.writeFileSync(path.join(dir, 'raw.glb'), l.bytes);
        joinChunkLayerFile(joinJob(path.join(dir, 'raw.glb'), path.join(dir, 'raw_kd.glb'), false));
        expect(unreferenced(fs.readFileSync(path.join(dir, 'raw_kd.glb')))).toEqual({ bytes: 0, views: 0, accessors: 0 });
        expect(unreferenced(joinChunkGlb(l.bytes, m, chunkKeep(plan, index, false, bandM)).glb)).toEqual({ bytes: 0, views: 0, accessors: 0 });
    });

    it('refuses a layer cut for another chunk or district, or placed in another frame', () => {
        const dir = tmp('refuse');
        fs.writeFileSync(path.join(dir, 'g.glb'), cutIn(layers[0].bytes, false).glb);
        const base = joinJob(path.join(dir, 'g.glb'), path.join(dir, 'g_kd.glb'), false);
        expect(() => joinChunkLayerFile({ ...base, chunk: index + 1 })).toThrow(/was cut for chunk/);
        expect(() => joinChunkLayerFile({ ...base, of: 'ffffffff' })).toThrow(/was cut for chunk/);
        expect(() => joinChunkLayerFile({ ...base, whole: true })).toThrow(/was cut for chunk/);
        // the district's frame a millimetre higher: another transform, refused rather than published misplaced
        const other = frameTransform(frame, { ...here, originEllipsoidalHeightM: here.originEllipsoidalHeightM + 0.001 });
        expect(() => joinChunkLayerFile({ ...base, transform: Array.from(other) })).toThrow(/in another frame/);
        expect(joinChunkLayerFile(base).cutBy).toBe('job');
    });

    it('joins on a worker thread with the same result as on this one', async () => {
        const dir = tmp('worker');
        fs.writeFileSync(path.join(dir, 'g.glb'), layers[0].bytes);
        const joiner = createChunkJoiner({ threads: true });
        try {
            const r = await joiner.join(joinJob(path.join(dir, 'g.glb'), path.join(dir, 'w.glb'), false));
            expect(r.cutBy).toBe('here');
            fs.writeFileSync(path.join(dir, 'c.glb'), cutIn(layers[0].bytes, false).glb);
            await expect(joiner.join(joinJob(path.join(dir, 'c.glb'), path.join(dir, 'x.glb'), false, index + 1))).rejects.toThrow(/was cut for chunk/);
        } finally {
            await joiner.close();
        }
        joinChunkLayerFile(joinJob(path.join(dir, 'g.glb'), path.join(dir, 'm.glb'), false));
        expect(fs.readFileSync(path.join(dir, 'w.glb')).equals(fs.readFileSync(path.join(dir, 'm.glb')))).toBe(true);
    }, 60_000);

    /** A chunk job over a directory bucket whose build writes these layers and reports `chunkFrame` (the centre's publishes its frame). */
    const lay = (objectId: string, stage: string, url: string, extra: Record<string, unknown> = {}) => ({ objectId, stage, url, supersedes: [], retired: false, ...extra });
    async function runJob(bucket: DirectoryCloudBucket, chunk: number, cut: KdChunkCutSpec, ownFrame: TileFrame, opts: { frameWaitMs?: number } = {}) {
        const jobRoot = tmp('job'), staging = tmp('staging');
        const cache = new StageCache({ workspaceRoot: jobRoot });
        const prefix = `kd-jobs/${of}/${chunk}`, keys = kdChunkJobKeys(prefix);
        const spec: KdChunkJobSpec = { schema: KD_CHUNK_JOB_SCHEMA, runId: 'a1b2c3d4', request: { query: 'Penn', isolate: false, stageIntoActiveScene: false, district: 'kd', place: { ...place, formattedAddress: 'Penn' }, chunk: { of, index: chunk } } as KdChunkJobSpec['request'], cut };
        fs.writeFileSync(path.join(staging, 'request.json'), JSON.stringify(spec));
        await bucket.putFile(keys.request, path.join(staging, 'request.json'));
        const ok = await runKdChunkJob({
            bucket, prefix, cache, flushMs: 5, log: () => undefined, libraryStatsDir: path.join(jobRoot, 'stats'), framePollMs: 5, ...opts,
            build: async (_spec, ctx) => {
                ctx.onFrame?.(ownFrame);
                fs.mkdirSync(cache.modelsDir, { recursive: true });
                fs.writeFileSync(path.join(cache.modelsDir, 'ground.glb'), layers[0].bytes);
                fs.writeFileSync(path.join(cache.modelsDir, 'ground_tex.glb'), layers[0].bytes);
                fs.writeFileSync(path.join(cache.modelsDir, 'trees.glb'), layers[1].bytes);
                return {
                    result: { status: 'complete', stages: [], artifact: { data: { stagedBuild: { layers: [lay('g', 'remesh', '/models/ground.glb', { textured: { url: '/models/ground_tex.glb' } }), lay('t', 'trees', '/models/trees.glb')] } } } },
                    compat: { frame: ownFrame }
                } as unknown as StagedLocationOutcome;
            }
        });
        expect(ok).toBe(true);
        await bucket.download(keys.outcome, path.join(staging, 'outcome.json'));
        await bucket.download(keys.progress, path.join(staging, 'progress.jsonl'));
        const seen = fs.readFileSync(path.join(staging, 'progress.jsonl'), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x).message as string);
        return { record: JSON.parse(fs.readFileSync(path.join(staging, 'outcome.json'), 'utf8')) as KdChunkJobOutcome, keys, seen, staging };
    }

    it('cuts in the job in the frame the centre job publishes, and the laptop only checks and publishes what comes back', async () => {
        const bucket = new DirectoryCloudBucket(tmp('bucket'));
        // the centre is in the cloud too: neither job is told the district's height; the centre's own frame is the district's
        const cut: KdChunkCutSpec = { version: KD_CHUNK_CUT_VERSION, plan, district: { lat: place.lat, lng: place.lng }, bandM };
        const centre = plan.chunks.findIndex(k => k.centre);
        const chunkJob = runJob(bucket, index, cut, frame);
        const centreJob = runJob(bucket, centre, cut, here);
        const [mine, theirs] = await Promise.all([chunkJob, centreJob]);
        expect(theirs.seen).toContain("the district's frame published for the other chunks");
        expect(Object.keys(mine.record.cut ?? {}).sort()).toEqual(['ground.glb', 'ground_tex.glb', 'trees.glb']);
        for (const [name, whole] of [['ground.glb', false], ['ground_tex.glb', false], ['trees.glb', true]] as const) {
            const file = path.join(mine.staging, name);
            await bucket.download(mine.keys.model(name), file);
            const sent = fs.readFileSync(file);
            expect(mine.record.cut![name].bytesOut).toBe(sent.byteLength);
            expect(parseGlbBytes(sent).json.asset.extras.scratchbox.kdCut).toMatchObject({ version: KD_CHUNK_CUT_VERSION, of, chunk: index, whole, transform: Array.from(m) });
            expect(unreferenced(sent).bytes).toBe(0);
            // and published here, it is what the laptop's own join gave
            const r = joinChunkLayerFile(joinJob(file, `${file}.kd`, whole));
            const legacy = legacyJoinChunkGlb(whole ? layers[1].bytes : layers[0].bytes, m, chunkKeep(plan, index, whole, bandM), { whole });
            expect(r.cutBy).toBe('job');
            expect(shown(parseGlbBytes(fs.readFileSync(`${file}.kd`)))).toEqual(shown(parseGlbBytes(legacy.glb)));
        }
        // the centre's own layers were cut in its own (the district's) frame
        const centreFile = path.join(theirs.staging, 'ground.glb');
        await bucket.download(theirs.keys.model('ground.glb'), centreFile);
        expect(parseGlbBytes(fs.readFileSync(centreFile)).json.asset.extras.scratchbox.kdCut.transform).toEqual(Array.from(frameTransform(here, here)));
    });

    it('sends the layers uncut when the district frame does not come in time, and the laptop joins them as before', async () => {
        const bucket = new DirectoryCloudBucket(tmp('bucket'));
        const cut: KdChunkCutSpec = { version: KD_CHUNK_CUT_VERSION, plan, district: { lat: place.lat, lng: place.lng }, bandM };
        const job = await runJob(bucket, index, cut, frame, { frameWaitMs: 30 });
        expect(job.record.cut).toBeUndefined();
        expect(job.seen.some(x => /did not come within/.test(x))).toBe(true);
        const file = path.join(job.staging, 'ground.glb');
        await bucket.download(job.keys.model('ground.glb'), file);
        expect(fs.readFileSync(file).equals(layers[0].bytes)).toBe(true);
        const r = joinChunkLayerFile(joinJob(file, `${file}.kd`, false));
        expect(r.cutBy).toBe('here');
        expect(shown(parseGlbBytes(fs.readFileSync(`${file}.kd`)))).toEqual(shown(parseGlbBytes(legacyJoinChunkGlb(layers[0].bytes, m, chunkKeep(plan, index, false, bandM)).glb)));
    });
});

/**
 * A real district run's chunk layers (KD_PARITY_RUN_DIR: its workspace; KD_PARITY_RUN: the run id; KD_PARITY_LIMIT: how
 * many layers, largest first, default 4). Each downloaded layer `<name>.glb` that was joined as `<name>_kd<i>_<hash>.glb`
 * is cut both ways in a frame where the chunk sits at its cell (the run did not record the chunks' frames) and compared.
 */
describe.runIf(!!process.env.KD_PARITY_RUN_DIR)('pipeline K-D chunk cut: parity on a real run', () => {
    it('gives the same geometry, placement and extras on the real chunk layers', () => {
        const root = process.env.KD_PARITY_RUN_DIR!, run = process.env.KD_PARITY_RUN!;
        const plan = JSON.parse(fs.readFileSync(path.join(root, '.scratchbox/cache/staged_location/runs', run, 'district_chunks.json'), 'utf8')) as DistrictChunkPlan;
        const models = path.join(root, 'public/models');
        const joined = fs.readdirSync(models).map(n => /^(.*)_kd(\d+)_[0-9a-f]{8}\.glb$/.exec(n)).filter((x): x is RegExpExecArray => !!x && fs.existsSync(path.join(models, `${x[1]}.glb`)));
        joined.sort((a, b) => fs.statSync(path.join(models, `${b[1]}.glb`)).size - fs.statSync(path.join(models, `${a[1]}.glb`)).size);
        const place = { lat: 40.75032, lng: -73.99172 }, dir = tmp('real');
        for (const j of joined.slice(0, Number(process.env.KD_PARITY_LIMIT ?? 4))) {
            const index = Number(j[2]), c = plan.chunks[index], whole = /_trees_/.test(j[1]);
            const bytes = fs.readFileSync(path.join(models, `${j[1]}.glb`));
            const frame = chunkFrame(place, c.cx, c.cz, -20), m = frameTransform(frame, { ...place, originEllipsoidalHeightM: -26.4 });
            const legacy = legacyJoinChunkGlb(bytes, m, chunkKeep(plan, index, whole, DISTRICT_CHUNKS_PARAMS.seamBandM), { whole });
            const job = cutChunkLayer(bytes, { frame, district: { ...place, originEllipsoidalHeightM: -26.4 }, plan, bandM: DISTRICT_CHUNKS_PARAMS.seamBandM, of: run, chunk: index, whole });
            const src = path.join(dir, 'in.glb'), dst = path.join(dir, 'out.glb');
            fs.writeFileSync(src, job.glb);
            const r = joinChunkLayerFile({ source: src, target: dst, transform: Array.from(m), whole, of: run, chunk: index, plan, bandM: DISTRICT_CHUNKS_PARAMS.seamBandM });
            const out = fs.readFileSync(dst);
            console.log(`[kd-parity] ${j[1]} (chunk ${index}): ${(bytes.byteLength / 1e6).toFixed(1)} MB in, job sends ${(job.glb.byteLength / 1e6).toFixed(1)} MB, old join wrote ${(legacy.glb.byteLength / 1e6).toFixed(1)} MB, new ${(out.byteLength / 1e6).toFixed(1)} MB; ${r.keptTriangles} kept, ${r.removedTriangles} removed`);
            expect(r.keptTriangles).toBe(legacy.keptTriangles);
            expect(unreferenced(out)).toEqual({ bytes: 0, views: 0, accessors: 0 });
            expect(shown(parseGlbBytes(out))).toEqual(shown(parseGlbBytes(legacy.glb)));
        }
    }, 3_600_000);
});
