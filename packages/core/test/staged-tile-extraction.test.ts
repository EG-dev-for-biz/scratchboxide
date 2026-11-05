/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the crawler and the extraction hand the staged build: the completion rank of each leaf download (for a sidecar,
 * never the GLB bytes), run-independent node extras (stage, provenance, build order, leaf id), the geometry-only first
 * layer built in the same frame as the textured model, and the copyrights, leaf ids and fetch time of the extraction.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoogleTileDistrictCrawler, type LeafTileRef, type ParsedLeafTile } from '../src/node/spatial/GoogleTileDistrictCrawler';
import { Google3DTileCrawlerBaker } from '../src/node/spatial/Google3DTileCrawlerBaker';
import { getGoogle3DTilesFullTexture } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { renderClayPng } from './helpers/clay-glb-render';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';

const ANCHOR = { lat: 40.7308, lng: -73.9973 };
const GROUND_H = 30;

afterEach(() => vi.restoreAllMocks());

/** A flat quad (two triangles) at height `up`, centred `east`/`north` metres from the anchor, as a parsed leaf primitive. */
function leafQuad(leafId: string | undefined, east: number, north: number, up: number, half = 12, jpeg = true): ParsedLeafTile {
    const corners: Array<[number, number]> = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const ecef = corners.map(([e, n]) => Google3DTileCrawlerBaker.enuToECEF(east + e, north + n, up, ANCHOR.lat, ANCHOR.lng, GROUND_H));
    const centre = [0, 1, 2].map(k => ecef.reduce((s, p) => s + p[k], 0) / 4);
    const positions = new Float32Array(ecef.flatMap(p => [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]));
    return {
        positions,
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, centre[0], centre[1], centre[2], 1],
        image: jpeg ? { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]), mimeType: 'image/jpeg' } : null,
        copyright: 'Google;Airbus',
        ...(leafId ? { leafId } : {})
    };
}

function readGlb(glb: Buffer): { json: any; bin: Buffer } {
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
    const binStart = 20 + jsonLen + 8;
    return { json, bin: glb.subarray(binStart) };
}

const BUILD = { clayPreset: 'studio-grey', groundSearchRadiusM: 60 } as const;

describe('downloadLeaves: completion ranks', () => {
    it('reports the order the downloads finished in, not the order they were asked for', async () => {
        const delays: Record<string, number> = { slow: 90, fast: 5, middle: 40 };
        const leafBytes = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16, 1)]);
        const fakeFetch = (async (input: any) => {
            const url = String(input);
            const name = Object.keys(delays).find(k => url.includes(`/${k}.glb`))!;
            await new Promise(r => setTimeout(r, delays[name]));
            return new Response(leafBytes, { status: 200 });
        }) as typeof fetch;
        const crawler = new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, concurrency: 4 });
        const leaves: LeafTileRef[] = ['slow', 'fast', 'middle'].map(n => ({ id: `leaf-${n}`, path: `/v1/3dtiles/${n}.glb`, geometricError: 1.2, depth: 4, box: [] }));
        const ranks: number[] = [];
        const buffers = await crawler.downloadLeaves(leaves, 'session', (index, rank) => { ranks[index] = rank; });
        expect(buffers).toHaveLength(3);
        expect(ranks).toEqual([2, 0, 1]);
    });

    it('is a no-op for callers that pass no callback (the input order of the buffers is kept)', async () => {
        const fakeFetch = (async () => new Response(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16, 3)]), { status: 200 })) as typeof fetch;
        const crawler = new GoogleTileDistrictCrawler({ apiKey: 'K', fetchImpl: fakeFetch, concurrency: 2 });
        const buffers = await crawler.downloadLeaves([{ id: 'a', path: '/a.glb', geometricError: 1, depth: 1, box: [] }], null);
        expect(buffers[0].toString('utf8', 0, 4)).toBe('glTF');
    });
});

describe('buildDistrictGlb: run-independent node extras and the geometry-only first layer', () => {
    const leaves = (): ParsedLeafTile[] => [
        leafQuad('leaf-far', 60, 0, 0),
        leafQuad('leaf-near', 4, 3, 0),
        leafQuad('leaf-mid', -25, 20, 0)
    ];

    it('writes stage, provenance, leaf id and a build order by distance from the anchor on every node', () => {
        const r = GoogleTileDistrictCrawler.buildDistrictGlb(leaves(), ANCHOR, { ...BUILD, clay: false });
        const { json } = readGlb(r.glb);
        const tiles = json.nodes.filter((n: any) => /^tile_/.test(n.name));
        expect(tiles).toHaveLength(3);
        const byLeaf = Object.fromEntries(tiles.map((n: any) => [n.extras.sb.ids.leafId, n.extras.sb]));
        expect(Object.keys(byLeaf).sort()).toEqual(['leaf-far', 'leaf-mid', 'leaf-near']);
        expect(byLeaf['leaf-near'].buildOrder).toBe(0);
        expect(byLeaf['leaf-mid'].buildOrder).toBe(1);
        expect(byLeaf['leaf-far'].buildOrder).toBe(2);
        for (const sb of Object.values<any>(byLeaf)) {
            expect(sb).toMatchObject({
                schema: 'scratchbox.staged-node/2', stage: 'tiles', buildCount: 3, revealKind: 'appear',
                provenance: { label: 'as-scanned', measuredGeometry: true },
                counts: { vertices: 4, triangles: 2 },
                reveal: { attribute: null, displacement: null }
            });
            expect(sb.provenance.sources[0].kind).toBe('tile-leaf');
            expect(sb.tile).toBeUndefined();   // these leaves state no geometric error
        }
        // a leaf that states one carries it in its node (the tile seam stage welds up to it)
        const stated = GoogleTileDistrictCrawler.buildDistrictGlb([{ ...leafQuad('leaf-e', 4, 3, 0), geometricErrorM: 2.01 }], ANCHOR, { ...BUILD, clay: false });
        expect(readGlb(stated.glb).json.nodes.find((n: any) => /^tile_/.test(n.name)).extras.sb.tile).toEqual({ geometricErrorM: 2.01 });
        // the frame extras the loader and the reshaper read are kept beside them
        expect(json.extras.frame).toMatch(/x = east/);
        expect(json.extras.localToEcef).toHaveLength(16);
    });

    it('is the same bytes every build, whatever order the leaves finished downloading in', () => {
        const a = GoogleTileDistrictCrawler.buildDistrictGlb(leaves(), ANCHOR, { ...BUILD });
        const b = GoogleTileDistrictCrawler.buildDistrictGlb(leaves(), ANCHOR, { ...BUILD });
        expect(a.glb.equals(b.glb)).toBe(true);
        // no run-dependent number is in the bytes: the download ranks live in a sidecar
        expect(a.glb.toString('latin1')).not.toMatch(/downloadRank|completionRank|"rank"/);
    });

    it('geometryOnly keeps the triangles and the frame and drops images, textures, samplers and UVs for one clay material', () => {
        const textured = GoogleTileDistrictCrawler.buildDistrictGlb(leaves(), ANCHOR, { ...BUILD });
        const geometry = GoogleTileDistrictCrawler.buildDistrictGlb(leaves(), ANCHOR, { ...BUILD, geometryOnly: true, originEllipsoidalHeightM: textured.originEllipsoidalHeightM });
        const t = readGlb(textured.glb).json, g = readGlb(geometry.glb).json;
        expect(t.images).toHaveLength(3);
        expect(t.textures).toHaveLength(3);
        expect(g.images).toBeUndefined();
        expect(g.textures).toBeUndefined();
        expect(g.samplers).toBeUndefined();
        expect(g.materials).toHaveLength(1);
        expect(g.meshes.every((m: any) => m.primitives.every((p: any) => p.attributes.TEXCOORD_0 === undefined && p.material === 0))).toBe(true);
        expect(geometry.vertexCount).toBe(textured.vertexCount);
        expect(geometry.triangleCount).toBe(textured.triangleCount);
        expect(geometry.glb.length).toBeLessThan(textured.glb.length);
        // same frame, so the two models line up exactly
        expect(geometry.originEllipsoidalHeightM).toBe(textured.originEllipsoidalHeightM);
        expect(geometry.localToEcef).toEqual(textured.localToEcef);
        const a = readGlbTriangles(textured.glb), b = readGlbTriangles(geometry.glb);
        expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
        // the node extras survive in the geometry-only variant
        expect(g.nodes.filter((n: any) => n.extras?.sb?.stage === 'tiles')).toHaveLength(3);
        // screenshot: the geometry-only layer renders as clay
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        const png = renderClayPng([{ positions: b.positions, indices: b.indices }], { kind: 'aerial', width: 640, height: 420, bearingDeg: 20, elevationDeg: 40 });
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'tile_extraction_geometry_only_layer.png'), png);
        expect(png.subarray(1, 4).toString()).toBe('PNG');
    });
});

describe('fetch3DObject: what it hands the staged build', () => {
    it('returns the leaf ids, copyrights, fetch time, largest leaf error and download order, and writes the geometry-only GLB beside the textured one', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-extract-'));
        try {
            const refs: LeafTileRef[] = [
                { id: 'leaf-a', path: '/a.glb', geometricError: 0.8, depth: 5, box: [] },
                { id: 'leaf-b', path: '/b.glb', geometricError: 2.0, depth: 5, box: [] }
            ];
            vi.spyOn(GoogleTileDistrictCrawler.prototype, 'collectLeafTiles').mockResolvedValue({ leaves: refs, session: null, requests: 2, excludedCoarseLeaves: 0 });
            vi.spyOn(GoogleTileDistrictCrawler.prototype, 'downloadLeaves').mockImplementation(async (leaves, _s, onComplete) => {
                // leaf-b lands first
                onComplete?.(1, 0);
                onComplete?.(0, 1);
                return leaves.map(() => Buffer.from('leaf'));
            });
            const parsedBy = new Map<string, ParsedLeafTile[]>([['leaf-a', [leafQuad(undefined, 3, 2, 0)]], ['leaf-b', [leafQuad(undefined, -20, 9, 0)]]]);
            vi.spyOn(GoogleTileDistrictCrawler, 'parseLeafGlbPrimitives').mockImplementation((_glb, leafId) =>
                parsedBy.get(leafId!)!.map(p => ({ ...p, ...(leafId ? { leafId } : {}) })));
            const out = path.join(root, 'out');
            const textured = path.join(out, 'textured.glb');
            const geometry = path.join(out, 'geometry.glb');
            const r = await getGoogle3DTilesFullTexture({ ...ANCHOR, elevation: 12 }, {
                apiKey: 'k', outputDir: out, outputGlbPath: textured, geometryGlbPath: geometry, radiusMeters: 30
            });
            expect(r.leafIds).toEqual(['leaf-a', 'leaf-b']);
            expect(r.copyrights).toEqual(['Google', 'Airbus']);
            expect(r.leafGeometricErrorM).toBe(2.0);
            expect(new Date(r.fetchedAt!).toISOString()).toBe(r.fetchedAt);
            expect(r.downloadOrder).toEqual({ 'leaf-a': 1, 'leaf-b': 0 });
            expect(r.geometryGlbPath).toBe(geometry);
            const t = readGlb(fs.readFileSync(textured)).json, g = readGlb(fs.readFileSync(geometry)).json;
            expect(t.images).toHaveLength(2);
            expect(g.images).toBeUndefined();
            expect(g.nodes.filter((n: any) => n.extras?.sb?.ids?.leafId).map((n: any) => n.extras.sb.ids.leafId).sort()).toEqual(['leaf-a', 'leaf-b']);
            // and nothing asks for a geometry-only GLB when the caller does not
            const plain = await getGoogle3DTilesFullTexture({ ...ANCHOR, elevation: 12 }, { apiKey: 'k', outputDir: out, outputGlbPath: path.join(out, 'plain.glb'), radiusMeters: 30 });
            expect(plain.geometryGlbPath).toBeUndefined();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
