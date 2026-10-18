/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { GoogleTileDistrictCrawler, type ParsedLeafTile } from '../src/node/spatial/GoogleTileDistrictCrawler';
import { Google3DTileCrawlerBaker } from '../src/node/spatial/Google3DTileCrawlerBaker';

const ANCHOR = { lat: 40.7646318, lng: -73.9743251 };
const GROUND_H = -14.5;

type V3 = [number, number, number];

/** Google leaf tiles store ECEF-oriented local positions; this node rotation cancels the runtime Y-up -> Z-up turn. */
const NODE_ROTATION_COLUMNS = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];

function enuToEcef(east: number, north: number, up: number, h = GROUND_H): V3 {
    return Google3DTileCrawlerBaker.enuToECEF(east, north, up, ANCHOR.lat, ANCHOR.lng, h);
}

function pad4(buf: Buffer, fill = 0): Buffer {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
}

/** Builds a leaf GLB in the layout Google serves (matrix node, POSITION/TEXCOORD_0/u16 indices, one JPEG, unlit). */
function makeLeafGlb(enuVertices: V3[], indices: number[], opts: { copyright?: string; jpeg?: Buffer } = {}): Buffer {
    const ecef = enuVertices.map(([e, n, u]) => enuToEcef(e, n, u));
    const center: V3 = [0, 1, 2].map(i => ecef.reduce((s, p) => s + p[i], 0) / ecef.length) as V3;
    // Node translation t satisfies Ryz * t = center, with Ryz(x, y, z) = (x, -z, y)
    const t: V3 = [center[0], center[2], -center[1]];
    const local = new Float32Array(ecef.flatMap(p => [p[0] - center[0], p[1] - center[1], p[2] - center[2]]));
    const uvs = new Float32Array(enuVertices.flatMap((_, i) => [i % 2, Math.floor(i / 2) % 2]));
    const idx = new Uint16Array(indices);
    const jpeg = opts.jpeg ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

    const idxBuf = pad4(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
    const posBuf = Buffer.from(local.buffer, local.byteOffset, local.byteLength);
    const uvBuf = Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength);
    const imgBuf = pad4(jpeg);
    const offsets = [0, idxBuf.length, idxBuf.length + posBuf.length, idxBuf.length + posBuf.length + uvBuf.length];
    const bin = Buffer.concat([idxBuf, posBuf, uvBuf, imgBuf]);
    const min = [0, 1, 2].map(k => Math.min(...Array.from({ length: local.length / 3 }, (_, i) => local[i * 3 + k])));
    const max = [0, 1, 2].map(k => Math.max(...Array.from({ length: local.length / 3 }, (_, i) => local[i * 3 + k])));
    const json = {
        asset: { version: '2.0', copyright: opts.copyright ?? 'Google', generator: 'draco_decoder' },
        extensionsUsed: ['KHR_materials_unlit'],
        extensionsRequired: ['KHR_materials_unlit'],
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ matrix: [...NODE_ROTATION_COLUMNS, t[0], t[1], t[2], 1], mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 1, TEXCOORD_0: 2 }, indices: 0, material: 0, mode: 4 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: { KHR_materials_unlit: {} } }],
        textures: [{ source: 0 }],
        images: [{ mimeType: 'image/jpeg', bufferView: 3 }],
        accessors: [
            { bufferView: 0, componentType: 5123, count: idx.length, type: 'SCALAR' },
            { bufferView: 1, componentType: 5126, count: local.length / 3, type: 'VEC3', min, max },
            { bufferView: 2, componentType: 5126, count: uvs.length / 2, type: 'VEC2' }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: offsets[0], byteLength: idx.byteLength },
            { buffer: 0, byteOffset: offsets[1], byteLength: posBuf.length },
            { buffer: 0, byteOffset: offsets[2], byteLength: uvBuf.length },
            { buffer: 0, byteOffset: offsets[3], byteLength: jpeg.length }
        ],
        buffers: [{ byteLength: bin.length }]
    };
    const jsonBuf = pad4(Buffer.from(JSON.stringify(json)), 0x20);
    const header = Buffer.alloc(12);
    header.write('glTF', 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

function readGlbJson(glb: Buffer): any {
    const len = glb.readUInt32LE(12);
    return JSON.parse(glb.slice(20, 20 + len).toString('utf8'));
}

function readAccessorF32(glb: Buffer, json: any, accessorIndex: number): Float32Array {
    const jsonLen = glb.readUInt32LE(12);
    const binStart = 20 + jsonLen + 8;
    const acc = json.accessors[accessorIndex];
    const bv = json.bufferViews[acc.bufferView];
    const comps = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
    const start = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const copy = Buffer.from(glb.subarray(start, start + acc.count * comps * 4));
    return new Float32Array(copy.buffer, copy.byteOffset, acc.count * comps);
}

/** Axis-aligned-in-ENU box expressed as a 3D Tiles ECEF oriented box. */
function enuBox(centerEnu: V3, halfExtents: V3): number[] {
    const c = enuToEcef(...centerEnu);
    const e = enuToEcef(centerEnu[0] + halfExtents[0], centerEnu[1], centerEnu[2]);
    const n = enuToEcef(centerEnu[0], centerEnu[1] + halfExtents[1], centerEnu[2]);
    const u = enuToEcef(centerEnu[0], centerEnu[1], centerEnu[2] + halfExtents[2]);
    return [...c, ...e.map((v, i) => v - c[i]), ...n.map((v, i) => v - c[i]), ...u.map((v, i) => v - c[i])];
}

describe('GoogleTileDistrictCrawler: real leaf-tile district extraction', () => {
    const frame = GoogleTileDistrictCrawler.localFrame(ANCHOR.lat, ANCHOR.lng, GROUND_H);

    it('selects tiles by their ground footprint against the radius, with no vertical limit', () => {
        const hit = (box: number[], r: number) => GoogleTileDistrictCrawler.footprintIntersectsCircle(box, frame, r);
        expect(hit(enuBox([0, 0, 0], [10, 10, 10]), 50)).toBe(true);
        expect(hit(enuBox([1000, 0, 0], [10, 10, 10]), 50)).toBe(false);
        expect(hit(enuBox([55, 0, 0], [10, 10, 10]), 50)).toBe(true);
        // A spire 2 km up but inside the footprint is still selected
        expect(hit(enuBox([0, 0, 2000], [5, 5, 5]), 50)).toBe(true);
        // A continental box that contains the anchor is selected
        expect(hit(enuBox([300000, -200000, 0], [800000, 800000, 50000]), 50)).toBe(true);
    });

    it('parses a Google-layout leaf GLB into ECEF-placed geometry with its texture bytes and copyright', () => {
        const jpeg = Buffer.from([0xff, 0xd8, 9, 8, 7, 6, 5, 0xff, 0xd9]);
        const glb = makeLeafGlb([[0, 0, 0], [4, 0, 0], [0, 4, 0], [4, 4, 3]], [0, 1, 2, 2, 1, 3], { copyright: 'Google;Vexcel', jpeg });
        const leaf = GoogleTileDistrictCrawler.parseLeafGlb(glb);
        expect(leaf.indices.length).toBe(6);
        expect(leaf.uvs?.length).toBe(8);
        expect(leaf.image?.mimeType).toBe('image/jpeg');
        expect(Buffer.compare(leaf.image!.bytes, jpeg)).toBe(0);
        expect(leaf.copyright).toBe('Google;Vexcel');
        const ecef = GoogleTileDistrictCrawler.leafVertexEcef(leaf, 3);
        const expected = enuToEcef(4, 4, 3);
        for (let k = 0; k < 3; k++) expect(Math.abs(ecef[k] - expected[k])).toBeLessThan(0.01);
    });

    it('builds one district GLB in the local frame (x east, y up, z south) with the ground at y = 0', () => {
        const ground = makeLeafGlb([[-30, -30, 0], [30, -30, 0], [-30, 30, 0], [30, 30, 0]], [0, 1, 2, 2, 1, 3]);
        const tower = makeLeafGlb([[20, 10, 0], [24, 10, 0], [20, 10, 80], [24, 10, 80]], [0, 1, 2, 2, 1, 3], { copyright: 'Google;Maxar' });
        const leaves: ParsedLeafTile[] = [ground, tower].map(b => GoogleTileDistrictCrawler.parseLeafGlb(b));
        // Anchor height deliberately wrong by 20 m: the builder must find the real ground from the geometry
        const result = GoogleTileDistrictCrawler.buildDistrictGlb(leaves, { lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H + 20 });

        expect(result.tileCount).toBe(2);
        expect(result.triangleCount).toBe(4);
        expect(Math.abs(result.originEllipsoidalHeightM - GROUND_H)).toBeLessThan(0.05);
        expect(result.copyrights).toEqual(expect.arrayContaining(['Google', 'Maxar']));

        const json = readGlbJson(result.glb);
        expect(json.meshes).toHaveLength(2);
        expect(json.images).toHaveLength(2);
        expect(json.extensionsUsed).toContain('KHR_materials_unlit');
        const towerPrim = json.meshes[1].primitives[0];
        const pos = readAccessorF32(result.glb, json, towerPrim.attributes.POSITION);
        // Top corner of the tower: 24 m east, 10 m north, 80 m up
        expect(pos[9]).toBeCloseTo(24, 1);
        expect(pos[10]).toBeCloseTo(80, 1);
        expect(pos[11]).toBeCloseTo(-10, 1);
        expect(json.accessors[towerPrim.attributes.POSITION].max[1]).toBeCloseTo(80, 1);

        // Local -> ECEF matrix round-trips the tower top
        const m = result.localToEcef;
        const p = [pos[9], pos[10], pos[11]];
        const ecef = [0, 1, 2].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
        const expected = enuToEcef(24, 10, 80);
        for (let k = 0; k < 3; k++) expect(Math.abs(ecef[k] - expected[k])).toBeLessThan(0.02);
    });

    it('puts y = 0 on the street surface, not on a small pit below it or on large roofs above it', () => {
        const street = makeLeafGlb([[-40, -40, 0], [40, -40, 0], [-40, 40, 0], [40, 40, 0]], [0, 1, 2, 2, 1, 3]);
        const roof = makeLeafGlb([[-20, -20, 30], [20, -20, 30], [-20, 20, 30], [20, 20, 30]], [0, 1, 2, 2, 1, 3]);
        const stairwell = makeLeafGlb([[10, 10, -4], [14, 10, -4], [10, 14, -4], [14, 14, -4]], [0, 1, 2, 2, 1, 3]);
        const leaves = [street, roof, stairwell].map(b => GoogleTileDistrictCrawler.parseLeafGlb(b));
        const result = GoogleTileDistrictCrawler.buildDistrictGlb(leaves, { lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H - 7 });
        expect(Math.abs(result.originEllipsoidalHeightM - GROUND_H)).toBeLessThan(0.3);
    });

    it('builds a crop in its parent commit\'s frame when the origin height is given', () => {
        const street = makeLeafGlb([[-40, -40, 0], [40, -40, 0], [-40, 40, 0], [40, 40, 0]], [0, 1, 2, 2, 1, 3]);
        const roof = makeLeafGlb([[-20, -20, 30], [20, -20, 30], [-20, 20, 30], [20, 20, 30]], [0, 1, 2, 2, 1, 3]);
        const parent = GoogleTileDistrictCrawler.buildDistrictGlb(
            [street, roof].map(b => GoogleTileDistrictCrawler.parseLeafGlb(b)), { lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H });
        // The roof alone would put the estimated ground on the roof; the parent's origin keeps the frame.
        const crop = GoogleTileDistrictCrawler.buildDistrictGlb(
            [GoogleTileDistrictCrawler.parseLeafGlb(roof)], { lat: ANCHOR.lat, lng: ANCHOR.lng }, { originEllipsoidalHeightM: parent.originEllipsoidalHeightM });
        expect(crop.originEllipsoidalHeightM).toBe(parent.originEllipsoidalHeightM);
        expect(crop.localToEcef).toEqual(parent.localToEcef);
        expect(crop.boundsLocal.min[1]).toBeCloseTo(parent.boundsLocal.max[1], 1);
    });

    it('walks the tileset with key and session on every request, keeps only fine leaves inside the footprint', async () => {
        const nearGlb = makeLeafGlb([[0, 0, 0], [5, 0, 0], [0, 5, 0]], [0, 1, 2]);
        const farGlb = makeLeafGlb([[900, 0, 0], [905, 0, 0], [900, 5, 0]], [0, 1, 2]);
        const tileset: Record<string, any> = {
            '/v1/3dtiles/root.json': {
                root: {
                    boundingVolume: { box: enuBox([0, 0, 0], [5e5, 5e5, 5e4]) }, geometricError: 1e100, refine: 'REPLACE',
                    children: [{ boundingVolume: { box: enuBox([0, 0, 0], [2000, 2000, 500]) }, geometricError: 4000, content: { uri: '/v1/3dtiles/datasets/X/files/sub.json?session=S123' } }]
                }
            },
            '/v1/3dtiles/datasets/X/files/sub.json': {
                root: {
                    boundingVolume: { box: enuBox([0, 0, 0], [2000, 2000, 500]) }, geometricError: 4000, refine: 'REPLACE',
                    children: [
                        { boundingVolume: { box: enuBox([2, 2, 0], [8, 8, 8]) }, geometricError: 2.01, content: { uri: '/v1/3dtiles/datasets/X/files/near.glb' } },
                        { boundingVolume: { box: enuBox([900, 0, 0], [8, 8, 8]) }, geometricError: 2.01, content: { uri: '/v1/3dtiles/datasets/X/files/far.glb' } },
                        // Coarse catch-all leaf covering the district: must be excluded by the geometric-error cap
                        { boundingVolume: { box: enuBox([0, 0, 0], [3000, 3000, 100]) }, geometricError: 4109, content: { uri: '/v1/3dtiles/datasets/X/files/coarse.glb' } }
                    ]
                }
            }
        };
        const seen: URL[] = [];
        const fakeFetch = (async (input: any) => {
            const url = new URL(String(input));
            seen.push(url);
            if (url.pathname.endsWith('.json')) return new Response(JSON.stringify(tileset[url.pathname]), { status: 200, headers: { 'content-type': 'application/json' } });
            const body = url.pathname.endsWith('near.glb') ? nearGlb : farGlb;
            return new Response(body, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
        }) as typeof fetch;

        const crawler = new GoogleTileDistrictCrawler({ apiKey: 'TESTKEY', fetchImpl: fakeFetch, concurrency: 2 });
        const collected = await crawler.collectLeafTiles({ lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H }, 100);
        expect(collected.leaves.map(l => l.path)).toEqual(['/v1/3dtiles/datasets/X/files/near.glb']);
        expect(collected.excludedCoarseLeaves).toBe(1);

        const bytes = await crawler.downloadLeaves(collected.leaves, collected.session);
        expect(bytes).toHaveLength(1);
        expect(seen.every(u => u.searchParams.get('key') === 'TESTKEY')).toBe(true);
        const glbRequest = seen.find(u => u.pathname.endsWith('near.glb'))!;
        expect(glbRequest.searchParams.get('session')).toBe('S123');
        // Recorded paths never carry credentials
        expect(JSON.stringify(collected.leaves)).not.toContain('TESTKEY');
    });

    it('caches leaves by their stable bounding box, since content paths change with every session', async () => {
        const glb = makeLeafGlb([[0, 0, 0], [5, 0, 0], [0, 5, 0]], [0, 1, 2]);
        let token = 'A';
        let glbFetches = 0;
        const box = enuBox([2, 2, 0], [8, 8, 8]);
        const fakeFetch = (async (input: any) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('root.json')) {
                return new Response(JSON.stringify({ root: { boundingVolume: { box }, geometricError: 1e100, children: [{ boundingVolume: { box }, geometricError: 2.01, content: { uri: `/v1/3dtiles/datasets/X/files/${token}.glb?session=S${token}` } }] } }), { status: 200 });
            }
            glbFetches++;
            return new Response(glb, { status: 200 });
        }) as typeof fetch;
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-cache-'));
        // Walk the tileset every time here: the point is the leaf cache across sessions.
        const crawler = new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, cacheDir, traversalCacheTtlMs: 0 });
        const anchor = { lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H };
        const first = await crawler.collectLeafTiles(anchor, 50);
        await crawler.downloadLeaves(first.leaves, first.session);
        token = 'B';
        const second = await crawler.collectLeafTiles(anchor, 50);
        expect(second.leaves[0].path).not.toBe(first.leaves[0].path);
        expect(second.leaves[0].id).toBe(first.leaves[0].id);
        await crawler.downloadLeaves(second.leaves, second.session);
        expect(glbFetches).toBe(1);
    });

    it('reuses a traversal for the same district (memory, then disk) and walks again once it expires', async () => {
        const box = enuBox([2, 2, 0], [8, 8, 8]);
        let jsonFetches = 0;
        const tileset = () => ({ root: { boundingVolume: { box }, geometricError: 1e100, children: [{ boundingVolume: { box }, geometricError: 2.01, content: { uri: `/v1/3dtiles/datasets/X/files/t${jsonFetches}.glb?session=S${jsonFetches}` } }] } });
        const fakeFetch = (async (input: any) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('.json')) { jsonFetches++; return new Response(JSON.stringify(tileset()), { status: 200 }); }
            throw new Error('no leaf downloads in this test');
        }) as typeof fetch;
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traversal-cache-'));
        const anchor = { lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H };
        const a = await new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, cacheDir }).collectLeafTiles(anchor, 50);
        expect(jsonFetches).toBe(1);
        expect(a.traversalCache).toBeUndefined();
        const b = await new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, cacheDir }).collectLeafTiles(anchor, 50);
        expect(jsonFetches).toBe(1);
        expect(b.traversalCache).toBe('memory');
        expect(b.leaves).toEqual(a.leaves);
        expect(b.session).toBe(a.session);
        // A new process (another transport) reads the file beside the leaf cache.
        const otherFetch = ((input: any) => fakeFetch(input)) as typeof fetch;
        const c = await new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: otherFetch, cacheDir }).collectLeafTiles(anchor, 50);
        expect(jsonFetches).toBe(1);
        expect(c.traversalCache).toBe('disk');
        expect(c.leaves).toEqual(a.leaves);
        // Another radius, another key, or an expired entry walks the tileset.
        await new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, cacheDir }).collectLeafTiles(anchor, 60);
        expect(jsonFetches).toBe(2);
        await new GoogleTileDistrictCrawler({ apiKey: 'K2', fetchImpl: fakeFetch, cacheDir }).collectLeafTiles(anchor, 50);
        expect(jsonFetches).toBe(3);
        await new Promise(r => setTimeout(r, 5));
        const d = await new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, cacheDir, traversalCacheTtlMs: 1 }).collectLeafTiles(anchor, 50);
        expect(jsonFetches).toBe(4);
        expect(d.traversalCache).toBeUndefined();
        expect(d.session).not.toBe(a.session);
        // The cache file holds no API key.
        const files = fs.readdirSync(path.join(cacheDir, 'traversals'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) expect(fs.readFileSync(path.join(cacheDir, 'traversals', f), 'utf8')).not.toContain('key=');
    });

    it('downloads up to 16 leaves at once by default and backs off on 429', async () => {
        const glb = makeLeafGlb([[0, 0, 0], [5, 0, 0], [0, 5, 0]], [0, 1, 2]);
        let inFlight = 0, peak = 0, throttled = 0;
        const fakeFetch = (async (input: any) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('t3.glb') && throttled === 0) { throttled++; return new Response('', { status: 429 }); }
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 15));
            inFlight--;
            return new Response(glb, { status: 200 });
        }) as typeof fetch;
        const leaves = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, path: `/v1/3dtiles/datasets/X/files/t${i}.glb`, geometricError: 2, depth: 3, box: [] }));
        const bytes = await new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch }).downloadLeaves(leaves, 'S');
        expect(bytes).toHaveLength(40);
        // One slot sits out the 429 backoff, so 15-16 requests are on the wire at the peak (8 before).
        expect(peak).toBeGreaterThanOrEqual(15);
        expect(peak).toBeLessThanOrEqual(16);
        expect(throttled).toBe(1);
    });

    it('writes a commit: GLB plus a manifest with anchor, frame, attribution, fetch time and a verified hash', async () => {
        const ground = makeLeafGlb([[-30, -30, 0], [30, -30, 0], [-30, 30, 0], [30, 30, 0]], [0, 1, 2, 2, 1, 3]);
        const result = GoogleTileDistrictCrawler.buildDistrictGlb([GoogleTileDistrictCrawler.parseLeafGlb(ground)], { lat: ANCHOR.lat, lng: ANCHOR.lng, heightGuessM: GROUND_H });
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-commit-'));
        const { glbPath, manifestPath, manifest } = GoogleTileDistrictCrawler.writeCommit(result, {
            outDir,
            commitId: 'test-base',
            glbFileName: 'district.glb',
            location: { query: 'The Plaza Hotel', formattedAddress: '768 5th Ave', placeId: 'PID', lat: ANCHOR.lat, lng: ANCHOR.lng, precision: 'ROOFTOP' },
            radiusMeters: 250,
            dilateMeters: 40,
            leaves: [{ id: 'tile-abc', geometricError: 2.01, box: enuBox([0, 0, 0], [8, 8, 8]) }],
            fetchedAt: '2026-09-28T20:00:00.000Z'
        });
        const onDisk = fs.readFileSync(glbPath);
        expect(manifest.glb.sha256).toBe(crypto.createHash('sha256').update(onDisk).digest('hex'));
        const reread = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        expect(reread.parent).toBeNull();
        expect(reread.location.placeId).toBe('PID');
        expect(reread.frame.convention).toMatch(/east.*up.*south/i);
        expect(reread.frame.localToEcef).toHaveLength(16);
        expect(reread.extent.verticalExtent).toBe('unbounded');
        expect(reread.attribution).toContain('Google');
        expect(reread.time.fetchedAt).toBe('2026-09-28T20:00:00.000Z');
        expect(reread.source.tiles[0].id).toBe('tile-abc');
        expect(reread.source.tiles[0].box).toHaveLength(12);
    });

    it('refuses to run without an API key instead of inventing geometry', async () => {
        expect(() => new GoogleTileDistrictCrawler({ apiKey: '' })).toThrow(/api key/i);
        const baker = new Google3DTileCrawlerBaker();
        const saved = process.env.GOOGLE_MAPS_API_KEY;
        delete process.env.GOOGLE_MAPS_API_KEY;
        try {
            await expect(baker.crawlAndBake({ origin: { lat: 35.6762, lng: 139.6503, alt: 20 }, radiusMeters: 80 })).rejects.toThrow(/api key/i);
        } finally {
            if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
        }
    });
});
