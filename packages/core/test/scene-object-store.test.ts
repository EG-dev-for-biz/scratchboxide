/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scene object store: a finished build's separable objects are kept as versioned GLBs with a scratchbox.object/1
 * record, and its scene as a scratchbox.scene/1 record. Gates: every stored GLB passes the structural check, a stored
 * object reads back byte for byte, the same inputs make no new version, a changed input makes one and moves the current
 * pointer, old versions stay readable; the GLB cut keeps geometry, extras, instancing and texels.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { locationHashOf, objectInputHash, objectKeyOf, SceneObjectStore, OBJECT_RECORD_SCHEMA, SCENE_RECORD_SCHEMA } from '../src/node/asset-store/scene-object-store';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { composeGlb, mergeGlbs } from '../src/node/3d-engine/staged-location/glb-subset';
import { checkGlbBytes } from '../src/node/3d-engine/staged-location/glb-integrity';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';
import { DecodedImageCache } from '../src/node/3d-engine/staged-location/glb-texture-repack';
import { evidenceLookup, type VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import type { DistrictBuildingMassing } from '../src/node/3d-engine/staged-location/district-massing';
import type { ScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';
import {
    buildingScanDigests, cutObjectGlb, districtMassingManifest, footprintOwners, storeSceneObjects, treesManifest, wholeLayerManifest, type LayerObjectManifest
} from '../src/node/3d-engine/staged-location/scene-objects';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-scene-objects-')));
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const FRAME = { lat: -37.817979, lng: 144.969058, ellipsoidalHeightM: 31.5 };

/** A box's 12 triangles at (x, z), `h` tall, as flat arrays. */
function box(x: number, z: number, w: number, h: number): { positions: Float32Array; indices: Uint32Array } {
    const p: number[] = [];
    for (const [a, b, c] of [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]]) p.push(x + a * w, b * h, z + c * w);
    const i = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
    return { positions: Float32Array.from(p), indices: Uint32Array.from(i) };
}

/** A 64 px RGBA PNG, each 16 px cell its own colour. */
function cellsPng(): { png: Buffer; rgba: Uint8Array } {
    const rgba = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const c = (y >> 4) * 4 + (x >> 4);
        rgba.set([c * 16, 255 - c * 16, (c * 37) % 256, 255], (y * 64 + x) * 4);
    }
    return { png: encodePng(64, 64, rgba, 4), rgba };
}

/** UVs over a box's vertices covering one 16 px cell (u0, v0 in cells). */
function cellUv(cx: number, cy: number, n: number): Float32Array {
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = (cx * 16 + 2 + (i % 2) * 12) / 64; uv[i * 2 + 1] = (cy * 16 + 2 + ((i >> 1) % 2) * 12) / 64; }
    return uv;
}

const nodeExtras = (label: string, confidence?: number) => ({ sb: { schema: 'scratchbox.staged-node/2', stage: 'massing', provenance: { label, measuredGeometry: false, ...(confidence !== undefined ? { confidence } : {}) } } });

/** A district massing layer: building A (two nodes), building B (one node), and one residual node spread over A, B and the street. */
function massingLayer(): Buffer {
    const tex = cellsPng();
    const a1 = box(1, 1, 4, 8), a2 = box(5, 1, 3, 6), b1 = box(21, 1, 6, 12);
    // residual: one triangle over A, one over B, one far out in the street
    const res = { positions: Float32Array.from([2, 9, 2, 3, 9, 2, 2, 9, 3, 22, 13, 2, 23, 13, 2, 22, 13, 3, 60, 0, 60, 61, 0, 60, 60, 0, 61]), indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]) };
    return writeStagedGlb([
        { name: 'w:17/1/2/f0/e0:0:0', ...a1, uv: cellUv(0, 0, 8), extras: nodeExtras('vector-massing', 1) },
        { name: 'r:17/1/2/f0/e1:0', ...a2, uv: cellUv(1, 0, 8), extras: nodeExtras('vector-massing', 0.9) },
        { name: 'w:17/1/2/f1/e0:0:0', ...b1, uv: cellUv(3, 3, 8), extras: nodeExtras('vector-massing', 1) },
        { name: 'residual:0', ...res, uv: cellUv(2, 1, 9), extras: nodeExtras('as-scanned') }
    ], { texture: { bytes: tex.png, mimeType: 'image/png' }, rootExtras: { sb: { schema: 'scratchbox.staged-glb/2', stage: 'massing', stageKey: 'k', frame: 'tile frame' } } });
}

/** The vector evidence of buildings A (0..10 m) and B (20..30 m). */
function evidence(): VectorEvidence {
    const sq = (x0: number, z0: number, s: number): Array<[number, number]> => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
    return { buildings: [{ id: '17/1/2/f0', parts: [[sq(0, 0, 10)]] }, { id: '17/1/2/f1', parts: [[sq(20, 0, 10)]] }], water: [], roads: [], tiles: 1, zoom: 17 } as unknown as VectorEvidence;
}

const rowOf = (id: string, index: number): DistrictBuildingMassing => ({ id, index, groundY: 0, footprintCells: 100, raisedShare: 1, overhangShare: 0, ok: true, ms: 0, massing: { parts: [{ id: `${id}/e0`, topY: 8 }], meshes: [] } } as unknown as DistrictBuildingMassing);

/** A scan of two triangles, one over each building. */
function scanOf(dy = 0): ScanMesh {
    const vertices = Float32Array.from([2, 5 + dy, 2, 3, 5, 2, 2, 5, 3, 22, 7, 2, 23, 7, 2, 22, 7, 3]);
    const indices = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    return { mesh: { vertices, indices }, triCount: 2, triCentroid: Float32Array.from([7 / 3, 5, 7 / 3, 67 / 3, 7, 7 / 3]), triTexelMeters: Float32Array.from([0.1, 0.1]), triNormal: new Float32Array(6), triArea: new Float32Array(2), bounds: { min: [0, 0, 0], max: [1, 1, 1] } } as unknown as ScanMesh;
}

function layerOf(objectId: string, layer: string, url: string): StagedLayer {
    return { objectId, stage: 'massing', layer, order: 1, url, bytes: 0, provenance: { label: 'vector-massing', measuredGeometry: false }, provenanceLabels: ['vector-massing'], supersedes: [], revealAfter: [], reveal: { durationMs: 1, stagger: 0, crossfadeFrom: [] }, cached: false, builtAtMs: 0, counts: { vertices: 0, triangles: 0 } } as unknown as StagedLayer;
}

describe('GLB cut, merge and structural check', () => {
    it('cuts nodes and triangle subsets out of a layer, keeping names, extras, positions and texels', () => {
        const layer = parseGlbBytes(massingLayer());
        const out = composeGlb([{ glb: layer, select: [{ node: 2 }, { node: 4, triangles: [1] }] }], { name: 'building/17/1/2/f0' });
        const check = checkGlbBytes(out);
        expect(check.errors).toEqual([]);
        const g = parseGlbBytes(out);
        expect(g.json.nodes[0].children.map((c: number) => g.json.nodes[c].name)).toEqual(['r:17/1/2/f0/e1:0', 'residual:0']);
        expect(g.json.nodes[1].extras.sb.provenance.confidence).toBe(0.9);
        // the cut residual holds exactly triangle 1 (the one over building B), its positions bit for bit
        const prim = g.json.meshes[g.json.nodes[2].mesh].primitives[0];
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        expect(Array.from(pos)).toEqual([22, 13, 2, 23, 13, 2, 22, 13, 3]);
        expect(g.json.accessors[prim.attributes.POSITION].min).toEqual([22, 13, 2]);
        expect(check.counts.triangles).toBe(12 + 1);
    });

    it('carries EXT_mesh_gpu_instancing and refuses what it cannot renumber', () => {
        // a mesh drawn at three instances
        const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const translations = Float32Array.from([0, 0, 0, 5, 0, 0, 10, 0, 0]);
        const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(translations.buffer)]);
        const json = {
            asset: { version: '2.0' }, extensionsUsed: ['EXT_mesh_gpu_instancing'], scene: 0, scenes: [{ nodes: [0] }],
            nodes: [{ name: 'tree', children: [1], extras: { crownId: 3 } }, { name: 'leaves', mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 36 }],
            buffers: [{ byteLength: 72 }]
        };
        const src = assembleGlb(json, bin);
        expect(checkGlbBytes(src).errors).toEqual([]);
        const out = composeGlb([{ glb: parseGlbBytes(src), select: [{ node: 0 }] }], { name: 'tree/x' });
        expect(checkGlbBytes(out).errors).toEqual([]);
        const g = parseGlbBytes(out);
        const inst = g.json.nodes[2].extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION;
        expect(Array.from(readAccessor(g, inst).data)).toEqual(Array.from(translations));
        expect(g.json.extensionsUsed).toEqual(['EXT_mesh_gpu_instancing']);
        expect(g.json.nodes[1].extras).toEqual({ crownId: 3 });
        // a skinned node is refused rather than copied with a dangling skin
        const skinned = assembleGlb({ ...json, nodes: [{ name: 's', mesh: 0, skin: 0 }], scenes: [{ nodes: [0] }], extensionsUsed: undefined }, bin);
        expect(() => composeGlb([{ glb: parseGlbBytes(skinned), select: [{ node: 0 }] }], { name: 'x' })).toThrow(/skinned/);
    });

    it('merges cut objects back into one layer', () => {
        const layer = parseGlbBytes(massingLayer());
        const a = composeGlb([{ glb: layer, select: [{ node: 1 }, { node: 2 }] }], { name: 'a' });
        const b = composeGlb([{ glb: layer, select: [{ node: 3 }] }], { name: 'b' });
        const merged = mergeGlbs([parseGlbBytes(a), parseGlbBytes(b)], { name: 'staged', rootExtras: { sb: { stage: 'massing' } } });
        const check = checkGlbBytes(merged);
        expect(check.errors).toEqual([]);
        const g = parseGlbBytes(merged);
        expect(g.json.nodes[0].children.map((c: number) => g.json.nodes[c].name)).toEqual(['w:17/1/2/f0/e0:0:0', 'r:17/1/2/f0/e1:0', 'w:17/1/2/f1/e0:0:0']);
        expect(g.json.nodes[0].extras).toEqual({ sb: { stage: 'massing' } });
        expect(check.counts.triangles).toBe(36);
    });

    it('reports broken references, misaligned accessors and wrong bounds', () => {
        const g = parseGlbBytes(massingLayer());
        const broken = JSON.parse(JSON.stringify(g.json));
        broken.meshes[0].primitives[0].material = 9;
        broken.accessors[0].min = [-1, -1, -1];
        broken.accessors[1].count = 10_000;
        broken.nodes[0].children.push(1);
        const errors = checkGlbBytes(assembleGlb(broken, g.bin)).errors.join('\n');
        expect(errors).toMatch(/material 9 is out of range/);
        expect(errors).toMatch(/POSITION min\/max .* do not match/);
        expect(errors).toMatch(/accessor 1 runs past its bufferView/);
        expect(errors).toMatch(/has two parents|is in a cycle|child/);
        expect(checkGlbBytes(Buffer.from('glTF but not really')).ok).toBe(false);
    });

    it('cuts a shared atlas page down to the texels an object samples, every texel unchanged', () => {
        const layer = parseGlbBytes(massingLayer());
        const tex = cellsPng();
        const { glb, imageBytesBefore, imageBytesAfter } = cutObjectGlb(layer, { kind: 'building', identity: 'x', inputHash: 'h', nodes: [3], provenance: { labels: [], confidence: null } }, 'x', new DecodedImageCache());
        expect(checkGlbBytes(glb).errors).toEqual([]);
        expect(imageBytesAfter).toBeLessThan(imageBytesBefore);
        const g = parseGlbBytes(glb);
        const view = g.json.bufferViews[g.json.images[0].bufferView];
        const img = decodePng(Buffer.from(g.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)));
        expect(img.width * img.height).toBeLessThanOrEqual(64 * 16);
        // every vertex samples the colour it sampled on the page
        const uv = readAccessor(g, g.json.meshes[0].primitives[0].attributes.TEXCOORD_0).data;
        const old = cellUv(3, 3, 8);
        for (let i = 0; i < 8; i++) {
            const nx = Math.min(img.width - 1, Math.floor(uv[i * 2] * img.width)), ny = Math.min(img.height - 1, Math.floor(uv[i * 2 + 1] * img.height));
            const ox = Math.min(63, Math.floor(old[i * 2] * 64)), oy = Math.min(63, Math.floor(old[i * 2 + 1] * 64));
            expect(Array.from(img.rgba.subarray((ny * img.width + nx) * 4, (ny * img.width + nx) * 4 + 4))).toEqual(Array.from(tex.rgba.subarray((oy * 64 + ox) * 4, (oy * 64 + ox) * 4 + 4)));
        }
    });
});

describe('SceneObjectStore', () => {
    const store = new DurableAssetStore(path.join(HOME, 'home-store'));
    const objects = new SceneObjectStore(store);
    const base = { kind: 'building', identity: '17/1/2/f0', frame: FRAME, provenance: { labels: ['vector-massing'], confidence: 1 }, producer: { stage: 'massing', version: 'district-massing/1' } };
    const glbA = composeGlb([{ glb: parseGlbBytes(massingLayer()), select: [{ node: 1 }] }], { name: 'a' });
    const glbB = composeGlb([{ glb: parseGlbBytes(massingLayer()), select: [{ node: 1 }, { node: 2 }] }], { name: 'a' });

    it('stores a version, reads it back byte for byte, and parses its record', () => {
        const put = objects.put({ ...base, inputHash: objectInputHash('a'), glb: () => glbA });
        expect(put).toMatchObject({ version: 1, reused: false, pointerMoved: true });
        const read = objects.read(put.objectKey)!;
        expect(sha(fs.readFileSync(read.glbFile))).toBe(sha(glbA));
        expect(Buffer.compare(fs.readFileSync(read.glbFile), glbA)).toBe(0);
        expect(read.record.schema).toBe(OBJECT_RECORD_SCHEMA);
        expect(read.record).toMatchObject({ objectKey: put.objectKey, kind: 'building', identity: '17/1/2/f0', inputHash: objectInputHash('a') });
        expect(read.record.location.frame.locationHash).toBe(locationHashOf(FRAME));
        expect(read.record.location.bboxEnu).toEqual({ min: [1, 0, 1], max: [5, 8, 5] });
        expect(read.record.glb).toMatchObject({ sha256: sha(glbA), bytes: glbA.length, triangles: 12 });
        expect(read.record.materials).toEqual([{ name: 'PhotoTextured', images: 1 }]);
        expect(put.objectKey).toBe(objectKeyOf('building', '17/1/2/f0', locationHashOf(FRAME)));
    });

    it('reuses a version for the same inputs (nothing cut), adds one for changed inputs, keeps old versions readable', () => {
        let made = 0;
        const again = objects.put({ ...base, inputHash: objectInputHash('a'), glb: () => { made++; return glbA; } });
        expect(again).toMatchObject({ version: 1, reused: true, pointerMoved: false });
        expect(made).toBe(0);
        const changed = objects.put({ ...base, inputHash: objectInputHash('b'), glb: () => glbB });
        expect(changed).toMatchObject({ version: 2, reused: false, pointerMoved: true });
        expect(objects.current(changed.objectKey)!.version).toBe(2);
        expect(objects.versions(changed.objectKey).map(v => v.version)).toEqual([1, 2]);
        const v1 = objects.read(changed.objectKey, 1)!;
        expect(Buffer.compare(fs.readFileSync(v1.glbFile), glbA)).toBe(0);
        expect(v1.record.inputHash).toBe(objectInputHash('a'));
        // the earlier input again: back to version 1, no third version
        const back = objects.put({ ...base, inputHash: objectInputHash('a'), glb: () => { made++; return glbA; } });
        expect(back).toMatchObject({ version: 1, reused: true, pointerMoved: true });
        expect(made).toBe(0);
        expect(objects.versions(changed.objectKey)).toHaveLength(2);
        expect(objects.current(changed.objectKey)!.version).toBe(1);
    });

    it('refuses a GLB that fails the structural check', () => {
        const g = parseGlbBytes(glbA);
        const bad = JSON.parse(JSON.stringify(g.json));
        bad.meshes[0].primitives[0].indices = 99;
        expect(() => objects.put({ ...base, identity: 'bad', inputHash: objectInputHash('bad'), glb: () => assembleGlb(bad, g.bin) })).toThrow(/not a valid GLB/);
        expect(objects.current(objectKeyOf('building', 'bad', locationHashOf(FRAME)))).toBeUndefined();
    });
});

describe('a finished scene into the store', () => {
    const store = new DurableAssetStore(path.join(HOME, 'home-scene'));
    const models = path.join(HOME, 'models');
    fs.mkdirSync(models, { recursive: true });
    const ev = evidence();
    const look = evidenceLookup(ev, 80);
    const within = () => true;
    const rows = [rowOf('17/1/2/f0', 0), rowOf('17/1/2/f1', 1)];

    function manifestFor(file: string, scan: ScanMesh): LayerObjectManifest {
        const owners = footprintOwners(rows, look, within, 2);
        const digests = buildingScanDigests(scan, owners, rows.length);
        const hashes = new Map(rows.map((r, i) => [r.id, { hash: objectInputHash('building', r.id, digests[i].digest), inputs: { digest: digests[i].digest } }]));
        const bytes = fs.readFileSync(file);
        return districtMassingManifest(parseGlbBytes(bytes), sha(bytes), rows, owners, hashes, { stage: 'massing', stageKey: 'k', layer: 'l2m', version: 'district-massing/1' });
    }

    it('lists each building with the residual over its footprint, and the rest as unattributed', () => {
        const file = path.join(models, 'site_massing_k.glb');
        fs.writeFileSync(file, massingLayer());
        const m = manifestFor(file, scanOf());
        const byId = Object.fromEntries(m.objects.map(o => [`${o.kind}/${o.identity}`, o]));
        expect(byId['building/17/1/2/f0']).toMatchObject({ nodes: [1, 2], cuts: [{ node: 4, triangles: [0] }] });
        expect(byId['building/17/1/2/f1']).toMatchObject({ nodes: [3], cuts: [{ node: 4, triangles: [1] }] });
        expect(byId['scan-residual/unattributed']).toMatchObject({ cuts: [{ node: 4, triangles: [2] }] });
        expect(byId['building/17/1/2/f0'].provenance).toMatchObject({ labels: ['vector-massing', 'as-scanned'], confidence: 0.9 });
        // a scan change over B changes only B's hash
        const moved = manifestFor(file, scanOf(0.5));
        const h = (mm: LayerObjectManifest, id: string) => mm.objects.find(o => o.identity === id)!.inputHash;
        expect(h(moved, '17/1/2/f0')).not.toBe(h(m, '17/1/2/f0'));
        expect(h(moved, '17/1/2/f1')).toBe(h(m, '17/1/2/f1'));
    });

    it('keeps every object and the scene, reuses them on a rebuild, and versions the one that changed', async () => {
        const file = path.join(models, 'site_massing_k.glb');
        fs.writeFileSync(file, massingLayer());
        const groundFile = path.join(models, 'site_ground_k.glb');
        fs.writeFileSync(groundFile, writeStagedGlb([{ name: 'ground', ...box(-50, -50, 100, 0.1) }]));
        for (const f of [file, groundFile]) store.putFile(f, { servedPath: `/models/${path.basename(f)}`, origin: 'staged-location' });
        const layers = [layerOf('stg-k-l2m', 'l2m', '/models/site_massing_k.glb'), layerOf('stg-k-l1g', 'l1g', '/models/site_ground_k.glb'), { ...layerOf('stg-old-l2', 'l2', '/models/old.glb'), retired: true }];
        const ground = wholeLayerManifest('ground', 'surface', objectInputHash('ground', 1), sha(fs.readFileSync(groundFile)), { stage: 'massing', version: 'g/1' }, { labels: ['measured'], confidence: null });
        const scene = { title: 'Federation Square', objects: [{ id: 'stg-k-l2m' }] };
        const run = async (scan: ScanMesh, runId: string) => storeSceneObjects({
            store, runId, sceneId: 'scene-stg-x', query: 'Federation Square', frame: FRAME, layers, modelsDir: models, scene,
            manifests: new Map([['stg-k-l2m', manifestFor(file, scan)], ['stg-k-l1g', ground]])
        });
        const first = await run(scanOf(), 'aaaa0001');
        expect(first.failed).toEqual([]);
        expect(first).toMatchObject({ objects: 4, stored: 4, reused: 0 });
        const objects = new SceneObjectStore(store);
        const rec = objects.readScene(first.scenePath!)!;
        expect(rec.schema).toBe(SCENE_RECORD_SCHEMA);
        expect(rec.scene).toEqual(scene);
        expect(rec.objects.map(o => o.objectKey.split('@')[0]).sort()).toEqual(['building/17/1/2/f0', 'building/17/1/2/f1', 'ground/surface', 'scan-residual/unattributed']);
        expect(rec.layers.map(l => [l.layer, l.objects])).toEqual([['l2m', 3], ['l1g', 1], ['l2', 0]]);
        for (const o of rec.objects) {
            const read = objects.read(o.objectKey, o.version)!;
            expect(checkGlbBytes(fs.readFileSync(read.glbFile)).errors).toEqual([]);
            expect(sha(fs.readFileSync(read.glbFile))).toBe(o.sha256);
        }
        // the ground is the layer file as it was
        const g = rec.objects.find(o => o.kind === 'ground')!;
        expect(Buffer.compare(fs.readFileSync(objects.read(g.objectKey)!.glbFile), fs.readFileSync(groundFile))).toBe(0);
        // building A holds its two nodes and the residual triangle over it
        const a = parseGlbBytes(fs.readFileSync(objects.read(rec.objects.find(o => o.objectKey.startsWith('building/17/1/2/f0@'))!.objectKey)!.glbFile));
        expect(a.json.nodes[0].children.map((c: number) => a.json.nodes[c].name)).toEqual(['w:17/1/2/f0/e0:0:0', 'r:17/1/2/f0/e1:0', 'residual:0']);

        const second = await run(scanOf(), 'aaaa0002');
        expect(second).toMatchObject({ objects: 4, stored: 0, reused: 4, bytesWritten: 0 });
        expect(objects.readScene(second.scenePath!)!.objects.every(o => o.reused && o.version === 1)).toBe(true);

        const third = await run(scanOf(0.5), 'aaaa0003');
        expect(third).toMatchObject({ objects: 4, stored: 1, reused: 3 });
        const keyA = objectKeyOf('building', '17/1/2/f0', locationHashOf(FRAME));
        expect(objects.current(keyA)!.version).toBe(2);
        expect(objects.read(keyA, 1)).toBeDefined();
        expect(objects.latestSceneAt(FRAME)!.runId).toBe('aaaa0003');
    });

    it('names a tree by its object catalog row, so a renumbered crown is the same tree', async () => {
        const crown = (crownId: number) => ({ crownId, stem: [3, 4], apex: [3, 9, 4], supportY: 0, crownAreaM2: 12 });
        const trees = (crownId: number) => {
            const t = box(2, 3, 2, 9);
            const g = parseGlbBytes(writeStagedGlb([{ name: 'trunk', ...t }]));
            // a crown group around the trunk, and an outline-only crown kept as scanned
            g.json.nodes = [{ name: 'sb_veggie_trees', children: [1, 3] }, { name: `sb_veggie_crown_${crownId}`, extras: crown(crownId), children: [2] }, { ...g.json.nodes[1] }, { name: 'as_scanned_crown_9', extras: { crownId: 9, keptAsScanned: true, stem: [0, 0], apex: [0, 1, 0] } }];
            return assembleGlb(g.json, g.bin);
        };
        const run = (crownId: number, runId: string) => {
            const file = path.join(models, `site_trees_${crownId}.glb`);
            fs.writeFileSync(file, trees(crownId));
            store.putFile(file, { servedPath: `/models/${path.basename(file)}`, origin: 'staged-location' });
            const m = treesManifest(parseGlbBytes(fs.readFileSync(file)), sha(fs.readFileSync(file)), { stage: 'trees', stageKey: 'tk', layer: 'l5', version: 'v' });
            expect(m.objects).toHaveLength(1);
            return storeSceneObjects({ store, runId, sceneId: 's', frame: FRAME, layers: [layerOf(`stg-t${crownId}-l5`, 'l5', `/models/${path.basename(file)}`)], manifests: new Map([[`stg-t${crownId}-l5`, m]]), modelsDir: models, scene: {} });
        };
        const first = await run(4, 'bbbb0001');
        expect(first).toMatchObject({ stored: 1, reused: 0, failed: [] });
        const second = await run(17, 'bbbb0002');
        expect(second).toMatchObject({ stored: 0, reused: 1, failed: [] });
        const objects = new SceneObjectStore(store);
        const key = objects.readScene(first.scenePath!)!.objects[0].objectKey;
        expect(objects.readScene(second.scenePath!)!.objects[0].objectKey).toBe(key);
        const catalogId = objects.read(key)!.record.catalogId!;
        expect(key.startsWith(`tree/${catalogId}@`)).toBe(true);
        expect(store.db.object(catalogId)!.type).toBe('SB_FEATURE_TYPE_TREE');
    });
});

describe('the scene object store is on by default (user decision 2026-11-03)', () => {
    it('stores and reuses objects unless a switch says 0', async () => {
        const { objectReuseEnabled, objectStoreEnabled } = await import('../src/node/3d-engine/staged-location/scene-objects');
        expect(objectStoreEnabled({})).toBe(true);
        expect(objectReuseEnabled({})).toBe(true);
        expect(objectStoreEnabled({ SCRATCHBOX_OBJECT_STORE: '0' })).toBe(false);
        expect(objectReuseEnabled({ SCRATCHBOX_OBJECT_REUSE: '0' })).toBe(false);
        // the old opt-in value still means on
        expect(objectReuseEnabled({ SCRATCHBOX_OBJECT_REUSE: '1' })).toBe(true);
    });
});
