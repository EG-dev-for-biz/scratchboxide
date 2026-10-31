/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D tile tools do what the user asked. In a recorded run the agent extracted a tile at the default 250 m when
 * the user asked for 120 m, merged it into an unrelated active scene under that scene's sky, and could not refine
 * the extracted GLB because tile_refine looked for it under desktop-app/ while the extraction wrote <repo>/public/models.
 * Each case runs the real tool registry. The extraction cases serve a two-leaf Google 3D Tiles tileset from a fake
 * fetch (a ground leaf at the anchor and a roof leaf 190-210 m east) and run the real crawler and district builder.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { tileRefineRootFor } from '../src/node/gemini/tools/tile-refine-tools';
import { findTileRefineRepoRoot, TileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { TileVegetationError, TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { TILE_SEAMS_VERSION } from '../src/node/3d-engine/tile-seam-weld-service';
import { Google3DTileCrawlerBaker } from '../src/node/spatial/Google3DTileCrawlerBaker';
import { Google3DTileBlockoutPipelineService } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { DistrictTooLargeError, GoogleTileDistrictCrawler } from '../src/node/spatial/GoogleTileDistrictCrawler';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const DESKTOP = path.join(REPO, 'desktop-app');

type V3 = [number, number, number];
const ANCHOR = { lat: 40.7411, lng: -73.9897 };
const GROUND_H = 10;

function pad4(buf: Buffer): Buffer {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function enuToEcef(east: number, north: number, up: number): V3 {
    return Google3DTileCrawlerBaker.enuToECEF(east, north, up, ANCHOR.lat, ANCHOR.lng, GROUND_H) as V3;
}

/** An ENU-aligned box as a 3D Tiles ECEF oriented box. */
function enuBox(c: V3, h: V3): number[] {
    const o = enuToEcef(...c);
    const axis = (p: V3) => p.map((v, i) => v - o[i]);
    return [...o, ...axis(enuToEcef(c[0] + h[0], c[1], c[2])), ...axis(enuToEcef(c[0], c[1] + h[1], c[2])), ...axis(enuToEcef(c[0], c[1], c[2] + h[2]))];
}

/** A leaf GLB in Google's layout: ECEF positions relative to a node translation, under the Y-up -> Z-up node rotation. */
function leafGlb(enu: V3[], indices: number[]): Buffer {
    const ecef = enu.map(p => enuToEcef(...p));
    const c = [0, 1, 2].map(i => ecef.reduce((s, p) => s + p[i], 0) / ecef.length);
    const local = new Float32Array(ecef.flatMap(p => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]));
    const idx = new Uint16Array(indices);
    const idxBuf = pad4(Buffer.from(idx.buffer));
    const posBuf = Buffer.from(local.buffer);
    const bin = Buffer.concat([idxBuf, posBuf]);
    const json = {
        asset: { version: '2.0', copyright: 'Google' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, c[0], c[2], -c[1], 1], mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5123, count: idx.length, type: 'SCALAR' },
            { bufferView: 1, componentType: 5126, count: local.length / 3, type: 'VEC3' }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: idx.byteLength },
            { buffer: 0, byteOffset: idxBuf.length, byteLength: posBuf.length }
        ],
        buffers: [{ byteLength: bin.length }]
    };
    const jsonBuf = Buffer.from(JSON.stringify(json));
    const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPadded.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonPadded, bh, bin]);
}

const QUAD = [0, 1, 2, 2, 1, 3];
const LEAVES: Record<string, Buffer> = {
    'near.glb': leafGlb([[-40, -40, 0], [40, -40, 0], [-40, 40, 0], [40, 40, 0]], QUAD),
    'far.glb': leafGlb([[190, -10, 20], [210, -10, 20], [190, 10, 20], [210, 10, 20]], QUAD)
};
const TILESET = {
    root: {
        boundingVolume: { box: enuBox([0, 0, 0], [5000, 5000, 500]) },
        geometricError: 10000,
        children: [
            { boundingVolume: { box: enuBox([0, 0, 0], [40, 40, 5]) }, geometricError: 2, content: { uri: '/v1/3dtiles/datasets/T/files/near.glb' } },
            { boundingVolume: { box: enuBox([200, 0, 15], [10, 10, 15]) }, geometricError: 2, content: { uri: '/v1/3dtiles/datasets/T/files/far.glb' } }
        ]
    }
};

const realFetch = globalThis.fetch;
const realKey = process.env.GOOGLE_MAPS_API_KEY;
const realRoot = process.env.SCRATCHBOX_ROOT;
const scratch: string[] = [];

/** Serves the tileset, its leaves and the elevation API; records every requested path. */
function serveTiles(tileset: unknown = TILESET, leaves: Record<string, Buffer> = LEAVES): { requested: string[] } {
    const requested: string[] = [];
    globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        if (url.hostname === 'maps.googleapis.com' && url.pathname.endsWith('/elevation/json')) {
            return new Response(JSON.stringify({ status: 'OK', results: [{ elevation: GROUND_H }] }), { status: 200 });
        }
        if (url.hostname === 'tile.googleapis.com' && url.pathname === '/v1/3dtiles/root.json') {
            return new Response(JSON.stringify(tileset), { status: 200 });
        }
        const leaf = leaves[path.basename(url.pathname)];
        if (url.hostname === 'tile.googleapis.com' && leaf) return new Response(new Uint8Array(leaf), { status: 200 });
        return new Response('not served by this test', { status: 404 });
    }) as typeof fetch;
    process.env.GOOGLE_MAPS_API_KEY = 'TEST_KEY';
    // The staged build keeps its caches and published models under the workspace root; keep them out of the checkout too.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tile-tools-root-')));
    scratch.push(root);
    process.env.SCRATCHBOX_ROOT = root;
    // The crawler caches leaves under cwd/.scratchbox; keep them out of the checkout.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-tools-cwd-'));
    scratch.push(cwd);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    return { requested };
}

function outGlb(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-tools-out-'));
    scratch.push(dir);
    return path.join(dir, name);
}

const ACTIVE_SCENE = {
    id: 'artifact-colosseum',
    type: '3d-scene',
    title: 'Colosseum',
    version: 3,
    data: {
        renderMode: 'shaded',
        environment: { skybox: 'realistic-sky', lighting: 'golden_hour', ground: true },
        objects: [{ id: 'hero-colosseum', content: { type: '3d-model', durableUri: '/models/colosseum_refined.glb', metadata: { source: 'tile_refine', role: 'hero' } } }]
    }
};

afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = realKey;
    if (realRoot === undefined) delete process.env.SCRATCHBOX_ROOT;
    else process.env.SCRATCHBOX_ROOT = realRoot;
});

afterAll(() => {
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('google_3d_tiles extraction radius', () => {
    it('declares radiusMeters and stageIntoActiveScene on both extraction tools', () => {
        const registry = createDefaultToolRegistry();
        for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
            const props = (registry.declarations().find(d => d.name === name)?.parameters as any)?.properties;
            expect(props?.radiusMeters?.type).toBe('NUMBER');
            expect(props?.stageIntoActiveScene?.type).toBe('BOOLEAN');
        }
    });

    it('extracts only the tiles within the radius the user asked for, and reports it', async () => {
        const { requested } = serveTiles();
        const outcome = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_full_texture',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, outputGlbPath: outGlb('flatiron_120.glb'), remesh: false }, {} as any);
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.requestedRadiusMeters).toBe(120);
        expect(payload.coveredRadiusMeters).toBe(120);
        expect(payload.truncated).toBe(false);
        expect(payload.leafTiles).toEqual({ kept: 1, selected: 1 });
        expect(requested.some(p => p.endsWith('/near.glb'))).toBe(true);
        expect(requested.some(p => p.endsWith('/far.glb'))).toBe(false); // the roof 190 m out is beyond 120 m
        expect(payload.mesh.triangleCount).toBe(2);
        expect(fs.statSync(payload.glbPath).size).toBeGreaterThan(0);
        expect(outcome.exec.summaryResult).toContain('within 120 m of the anchor');
    });

    it('uses the 250 m default when no radius is given', async () => {
        const { requested } = serveTiles();
        const outcome = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_clay',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, outputGlbPath: outGlb('flatiron_default.glb'), remesh: false }, {} as any);
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.requestedRadiusMeters).toBe(250);
        expect(payload.coveredRadiusMeters).toBe(250);
        expect(payload.truncated).toBe(false);
        expect(requested.some(p => p.endsWith('/far.glb'))).toBe(true);
        expect(payload.mesh.triangleCount).toBe(4);
    });
});

describe('google_3d_tiles extraction beyond the leaf cap', () => {
    // A 25 x 25 grid of 20 m leaves covering 500 m x 500 m around the anchor: 625 leaves, more than the 524 kept.
    const CELL = 20;
    const cells: Array<{ name: string; east: number; north: number }> = [];
    for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) cells.push({ name: `cell_${i + 12}_${j + 12}.glb`, east: i * CELL, north: j * CELL });
    const half = CELL / 2;
    const grid = {
        root: {
            boundingVolume: { box: enuBox([0, 0, 0], [5000, 5000, 500]) },
            geometricError: 10000,
            children: cells.map(c => ({
                boundingVolume: { box: enuBox([c.east, c.north, 0], [half, half, 5]) },
                geometricError: 2,
                content: { uri: `/v1/3dtiles/datasets/T/files/${c.name}` }
            }))
        }
    };
    const gridLeaves = Object.fromEntries(cells.map(c => [c.name, leafGlb([
        [c.east - half, c.north - half, 0], [c.east + half, c.north - half, 0], [c.east - half, c.north + half, 0], [c.east + half, c.north + half, 0]
    ], QUAD)]));
    /** Horizontal distance from the anchor to a cell's footprint. */
    const footprintDistance = (c: { east: number; north: number }) => Math.hypot(Math.max(0, Math.abs(c.east) - half), Math.max(0, Math.abs(c.north) - half));

    it('reports the radius the kept tiles cover, not the one asked for', async () => {
        const { requested } = serveTiles(grid, gridLeaves);
        const outcome = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_full_texture',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 400, outputGlbPath: outGlb('grid_400.glb'), remesh: false }, {} as any);
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');

        const downloaded = new Set(requested.filter(p => p.includes('/cell_')).map(p => path.basename(p)));
        const dropped = cells.filter(c => !downloaded.has(c.name));
        expect(downloaded.size).toBe(524);
        expect(dropped).toHaveLength(625 - 524);
        // complete out to the nearest left-out tile, which is well inside the 400 m asked for
        const nearestDropped = Math.min(...dropped.map(footprintDistance));
        expect(payload.requestedRadiusMeters).toBe(400);
        expect(payload.truncated).toBe(true);
        expect(payload.leafTiles).toEqual({ kept: 524, selected: 625 });
        expect(payload.coveredRadiusMeters).toBeLessThan(400);
        expect(Math.abs(payload.coveredRadiusMeters - Math.floor(nearestDropped))).toBeLessThanOrEqual(1);
        for (const c of cells.filter(c => footprintDistance(c) < payload.coveredRadiusMeters)) expect(downloaded.has(c.name)).toBe(true);
        expect(payload.mesh.triangleCount).toBe(2 * 524);

        const summary = outcome.exec.summaryResult!;
        expect(summary).toContain(`covers about ${payload.coveredRadiusMeters} m around the anchor (asked for 400 m; capped at 524 of the 625 tiles in that radius)`);
        expect(summary).not.toContain('within 400 m');
    });

    it('fails with the crawler\'s "reduce the radius" error instead of running the blockout runner', async () => {
        // more leaves than the crawler's 6000 cap, all within the radius
        const box = enuBox([0, 0, 0], [half, half, 5]);
        const crowded = {
            root: {
                boundingVolume: { box: enuBox([0, 0, 0], [5000, 5000, 500]) },
                geometricError: 10000,
                children: Array.from({ length: 6001 }, (_, i) => ({ boundingVolume: { box }, geometricError: 2, content: { uri: `/v1/3dtiles/datasets/T/files/crowd_${i}.glb` } }))
            }
        };
        const { requested } = serveTiles(crowded, {});
        const runner = vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'run').mockRejectedValue(new Error('the blockout runner ran'));
        const outcome = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_clay',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 2000, outputGlbPath: outGlb('crowded.glb') }, {} as any);
        const payload: any = outcome.resultPayload;
        expect(runner).not.toHaveBeenCalled();
        expect(outcome.exec.status).toBe('failed');
        expect(payload.error).toContain('District selects more than 6000 leaf tiles within 2000 m of the anchor; reduce the radius.');
        expect(requested.some(p => p.includes('/crowd_'))).toBe(false);
    });

    it('the crawler signals a too-large district with a typed error, not only a message', async () => {
        serveTiles();
        const crawler = new GoogleTileDistrictCrawler({ apiKey: 'TEST_KEY', maxLeafTiles: 1 });
        const err = await crawler.collectLeafTiles({ ...ANCHOR, heightGuessM: GROUND_H }, 250).catch(e => e);
        expect(err).toBeInstanceOf(DistrictTooLargeError);
        expect(err.code).toBe('district_too_large');
        expect(err.message).toContain('reduce the radius');
    });
});

describe('google_3d_tiles staging', () => {
    for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
        it(`${name} opens a new studio scene instead of merging into an unrelated active scene`, async () => {
            serveTiles();
            const outcome = await createDefaultToolRegistry().dispatch(name,
                { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, outputGlbPath: outGlb(`${name}_new.glb`), remesh: false },
                { request: { prompt: 'Flatiron Building, 120 m', activeArtifact: ACTIVE_SCENE } } as any);
            const artifact: any = (outcome.resultPayload as any).artifact;
            expect(outcome.exec.status).toBe('completed');
            expect(artifact.id).not.toBe(ACTIVE_SCENE.id);
            expect(artifact.data.environment).toEqual({ skybox: 'studio', lighting: 'studio', ground: false });
            expect(artifact.data.renderMode).toBe(name.endsWith('_clay') ? 'clay' : 'shaded');
            expect(artifact.data.objects).toHaveLength(1);
            expect(artifact.data.objects[0].content.metadata.role).toBe('environment');
            expect(JSON.stringify(artifact)).not.toContain('hero-colosseum');
        });

        it(`${name} stages the active scene at the place when stageIntoActiveScene is true`, async () => {
            serveTiles();
            const outcome = await createDefaultToolRegistry().dispatch(name,
                { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, stageIntoActiveScene: true, outputGlbPath: outGlb(`${name}_staged.glb`), remesh: false },
                { request: { prompt: 'Put it here', activeArtifact: ACTIVE_SCENE } } as any);
            const artifact: any = (outcome.resultPayload as any).artifact;
            expect(artifact.id).toBe(ACTIVE_SCENE.id);
            expect(artifact.version).toBe(ACTIVE_SCENE.version + 1);
            expect(artifact.data.objects.map((o: any) => o.id)).toContain('hero-colosseum');
            expect(artifact.data.objects).toHaveLength(2);
        });
    }
});

describe('tile_refine reads the tiles the extraction tools write', () => {
    const name = `tile_root_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
    const tile = path.join(REPO, 'public', 'models', `${name}.glb`);
    const published = [`${name}_refined.glb`, `${name}_refined_clay.glb`].map(f => path.join(REPO, 'public', 'models', f));
    let binDir: string;
    let fakeBin: string;
    let cacheEntry: string | undefined;

    beforeAll(() => {
        fs.mkdirSync(path.dirname(tile), { recursive: true });
        fs.writeFileSync(tile, Buffer.concat([Buffer.from('glTF'), crypto.randomBytes(64)]));
        // Stand-in for the clang-built pipeline (as in tile-refine-service.test.ts): textured = input, clay = input.
        binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-root-bin-'));
        fakeBin = path.join(binDir, 'fake_tile_refine');
        fs.writeFileSync(fakeBin, [
            '#!/bin/sh',
            'while [ $# -gt 0 ]; do case "$1" in',
            '  --input) IN="$2"; shift 2;; --out-textured) T="$2"; shift 2;; --out-clay) C="$2"; shift 2;;',
            '  --stats) S="$2"; shift 2;; *) shift;; esac; done',
            'cp "$IN" "$T"; cp "$IN" "$C"; printf \'{"totalMs":1,"outputs":{"triangles":3}}\' > "$S"',
            ''
        ].join('\n'), { mode: 0o755 });
    });

    afterAll(() => {
        for (const f of [tile, ...published]) fs.rmSync(f, { force: true });
        if (cacheEntry) {
            fs.rmSync(cacheEntry, { recursive: true, force: true });
            // and the cache folders the run created, when nothing else is in them
            for (let dir = path.dirname(cacheEntry); dir.startsWith(path.join(REPO, '.scratchbox')); dir = path.dirname(dir)) {
                try { fs.rmdirSync(dir); } catch { break; }
            }
        }
        fs.rmSync(binDir, { recursive: true, force: true });
    });

    it('resolves the extraction output under the checkout when the workspace is desktop-app', () => {
        expect(fs.realpathSync(findTileRefineRepoRoot())).toBe(REPO);
        expect(fs.realpathSync(tileRefineRootFor(tile, DESKTOP).root)).toBe(REPO);
        expect(fs.realpathSync(tileRefineRootFor(`public/models/${name}.glb`, DESKTOP).root)).toBe(REPO);
        // a file only in the workspace stays there; a missing one is reported against the workspace
        expect(tileRefineRootFor('vite.config.ts', DESKTOP)).toEqual({ root: DESKTOP });
        expect(tileRefineRootFor('public/tiles/no_such_tile.glb', DESKTOP)).toEqual({ root: DESKTOP });
        // an absolute path inside the workspace is still read from the workspace
        expect(tileRefineRootFor(path.join(DESKTOP, 'vite.config.ts'), DESKTOP)).toEqual({ root: DESKTOP });
    });

    describe('when a relative path exists in both the workspace and the checkout', () => {
        const both = `${name}_both`;
        const rel = `public/models/${both}.glb`;
        const repoCopy = path.join(REPO, rel);
        let workspace: string;
        let staleCopy: string;

        beforeAll(() => {
            // the workspace holds an older copy of a different size, as desktop-app/public/models did after an earlier incident
            workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-root-ws-'));
            staleCopy = path.join(workspace, rel);
            fs.mkdirSync(path.dirname(staleCopy), { recursive: true });
            fs.writeFileSync(staleCopy, Buffer.concat([Buffer.from('glTF'), crypto.randomBytes(32)]));
            fs.utimesSync(staleCopy, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
            fs.writeFileSync(repoCopy, Buffer.concat([Buffer.from('glTF'), crypto.randomBytes(96)]));
        });

        afterAll(() => {
            fs.rmSync(repoCopy, { force: true });
            fs.rmSync(workspace, { recursive: true, force: true });
        });

        it('reads the checkout copy, where the extraction tools write, and says which copy it used', () => {
            const { root, note } = tileRefineRootFor(rel, workspace);
            expect(fs.realpathSync(root)).toBe(REPO);
            expect(note).toContain(`used ${fs.realpathSync(repoCopy)} (100 bytes`);
            expect(note).toContain(`not ${fs.realpathSync(staleCopy)} (36 bytes, modified 2026-01-01T00:00:00.000Z)`);
        });

        it('says nothing when the two copies match', () => {
            const same = path.join(workspace, 'public', 'models', `${both}_same.glb`);
            const repoSame = path.join(REPO, 'public', 'models', `${both}_same.glb`);
            try {
                fs.copyFileSync(repoCopy, same);
                fs.copyFileSync(repoCopy, repoSame);
                const t = new Date('2026-02-02T00:00:00Z');
                fs.utimesSync(same, t, t);
                fs.utimesSync(repoSame, t, t);
                const resolved = tileRefineRootFor(`public/models/${both}_same.glb`, workspace);
                expect(fs.realpathSync(resolved.root)).toBe(REPO);
                expect(resolved.note).toBeUndefined();
            } finally {
                fs.rmSync(repoSame, { force: true });
            }
        });

        it('tile_refine refines the checkout copy and reports the note', async () => {
            vi.spyOn(TileRefineService.prototype, 'ensureBinary').mockResolvedValue({ path: fakeBin, built: false });
            const outcome = await createDefaultToolRegistry().dispatch('tile_refine', { tilePath: rel }, { workspaceRoot: workspace } as any);
            const payload: any = outcome.resultPayload;
            expect(payload.message).toBeUndefined();
            expect(outcome.exec.status).toBe('completed');
            const refined = fs.readFileSync(payload.texturedGlb);
            fs.rmSync(path.dirname(payload.texturedGlb), { recursive: true, force: true });
            expect(Buffer.compare(refined, fs.readFileSync(repoCopy))).toBe(0);
            expect(payload.note).toContain(`used ${fs.realpathSync(repoCopy)}`);
            expect(outcome.exec.summaryResult).toContain(payload.note);
        });
    });

    it('refines the absolute glbPath from a desktop-app workspace and returns absolute paths and /models URLs', async () => {
        vi.spyOn(TileRefineService.prototype, 'ensureBinary').mockResolvedValue({ path: fakeBin, built: false });
        const outcome = await createDefaultToolRegistry().dispatch('tile_refine', { tilePath: tile, publishAs: name }, { workspaceRoot: DESKTOP } as any);
        const payload: any = outcome.resultPayload;
        expect(payload.message).toBeUndefined();
        expect(outcome.exec.status).toBe('completed');
        cacheEntry = path.dirname(payload.texturedGlb);
        expect(path.isAbsolute(payload.texturedGlb)).toBe(true);
        expect(Buffer.compare(fs.readFileSync(payload.texturedGlb), fs.readFileSync(tile))).toBe(0);
        expect(payload.published.textured).toBe(published[0]);
        expect(payload.published.clay).toBe(published[1]);
        expect(payload.published.urls).toEqual({ textured: `/models/${name}_refined.glb`, clay: `/models/${name}_refined_clay.glb` });
        for (const f of published) expect(fs.existsSync(f)).toBe(true);
    });
});

describe('a location request returns remeshed geometry', () => {
    /**
     * tile_refine stand-in (exercised for real in tile-refine.test.ts): writes small remeshed GLBs (4 vertices and 2
     * triangles, a 10 m square: the remesh cleanup drops pieces under 3 m² as scraps, 64f473b3) and reports stats in
     * tile_refine's shape. It also checks publishAs against tile_refine's naming rule.
     */
    let remeshDir = '';
    const fakeRefine = (fail?: string) => vi.spyOn(TileRefineService.prototype, 'refine').mockImplementation(async (req: any) => {
        if (fail) throw new Error(fail);
        // the old tools name their published models (tile_refine's rule); the staged build publishes through its own cache
        const base = req.publishAs === undefined ? undefined : String(req.publishAs);
        if (base !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(base)) throw new Error('publishAs must be a plain name ([A-Za-z0-9_-], up to 64 chars)');
        remeshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-remesh-'));
        scratch.push(remeshDir);
        const quad = leafGlb([[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0]], [0, 1, 2, 1, 3, 2]);
        fs.writeFileSync(path.join(remeshDir, 'textured.glb'), quad);
        fs.writeFileSync(path.join(remeshDir, 'clay.glb'), quad);
        return {
            texturedGlb: path.join(remeshDir, 'textured.glb'), clayGlb: path.join(remeshDir, 'clay.glb'), cached: false, ms: 12_300,
            cacheKey: crypto.createHash('sha256').update(`refine|${req.tilePath ?? req.glbPath}|${remeshDir}`).digest('hex'),
            stats: { triangles: { input: 403_385, hidden: 0, droppedDegenerate: 0, kept: 403_385 }, outputs: { triangles: 46_220 } },
            ...(base ? { published: { urls: { textured: `/models/${base}_refined.glb`, clay: `/models/${base}_refined_clay.glb` }, backups: [] } } : {}),
            binary: { path: path.join(remeshDir, 'tile_refine'), built: false }
        } as any;
    });

    /** Stand-ins for the native tile_vegetation stages (exercised for real in tile-vegetation.test.ts). */
    const fakeVegetation = (opts: {
        trees: number; canopyAreaM2?: number; removed?: number; fail?: 'strip' | 'plant' | 'plant_explicit'; notRegrowable?: number;
        /** what plant measured: trees short of their crown, trunks off the mounted model, kept trees off an isolated structure */
        shortOfCrown?: any[]; offGround?: any[]; keptNotOnSupportMesh?: number[]; keptSkirt?: boolean;
    }) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-veg-'));
        scratch.push(dir);
        const crowns = path.join(dir, 'crowns.json');
        // measured crowns of 100, 110, 120 ... m², the first one running to the extraction's edge
        const list = Array.from({ length: opts.trees }, (_, i) => ({ id: i, status: 'tree', areaM2: 100 + 10 * i, reachesBoundary: i === 0 }));
        // measured trees the strip could not regrow: left in the scan with their reason
        const kept = Array.from({ length: opts.notRegrowable ?? 0 }, (_, i) => ({
            id: 50 + i, status: 'not_regrowable', areaM2: 479, apexAboveSupport: 3.6515,
            regrowth: { reasonCode: 'crown_not_reached', reason: "the regrown tree's leaves reach 89% of its measured crown surface (162 of 182 samples within 1.4 m; 90% needed)", colonisation: '193 of 215 attractors reached in 52 iterations, stopped: no_attractor_within_perception' },
            ...(opts.keptSkirt ? { keptSkirt: { areaM2: 329.4, topY: 9.48, bottomY: -0.53 } } : {})
        }));
        fs.writeFileSync(crowns, JSON.stringify({ version: 1, crowns: [...list, ...kept, { id: 97, status: 'cut_at_boundary_removed', areaM2: 30 }, { id: 98, status: 'cut_at_boundary' }, { id: 99, status: 'below_min_height' }] }));
        const strip = vi.spyOn(TileVegetationService.prototype, 'strip').mockImplementation(async (req: any) => {
            if (opts.fail === 'strip') throw new TileVegetationError('texture_decode', 'photo texture 3 could not be decoded: bad Huffman code');
            // what strip leaves of the tile it was given (the stand-in removes nothing it could show)
            fs.copyFileSync(req.tilePath, path.join(dir, 'devegetated.glb'));
            return {
                devegetatedGlb: path.join(dir, 'devegetated.glb'), crownsJson: crowns, tileSha256: 'ab'.repeat(32), cached: false, ms: 900, cacheKey: crypto.createHash('sha256').update(`strip|${dir}`).digest('hex'),
                stats: {
                    canopyAreaM2: opts.canopyAreaM2 ?? 812.5, treeCanopyAreaM2: opts.trees ? 640 : 0, cutCanopyRemovedM2: 30,
                    triangles: { removed: opts.removed ?? 9000, cap: 700, skirt: 120 }, openEdges: { before: 100, after: 90 },
                    skirts: { areaM2: { onWalls: 80, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 40 }, maxHeightByHangM: { onWalls: 12.5, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 6 } }
                }
            } as any;
        });
        const plant = vi.spyOn(TileVegetationService.prototype, 'plant').mockImplementation(async (req: any) => {
            if (opts.fail === 'plant') throw new TileVegetationError('budget_too_small', "the 13,000 measured trees need at least 1,560,000 triangles at 120 each, more than the scene's cap of 1,500,000 triangles for trees");
            if (opts.fail === 'plant_explicit') throw new TileVegetationError('budget_too_small', 'a triangle budget of 10 cannot hold 3 trees at 120 triangles each (they need at least 360)');
            fs.writeFileSync(path.join(dir, 'trees.glb'), leafGlb([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], [0, 1, 2, 1, 3, 2]));
            return {
                treesGlb: path.join(dir, 'trees.glb'), cached: false, ms: 400, cacheKey: crypto.createHash('sha256').update(`plant|${dir}|${req.triangleBudget ?? ''}`).digest('hex'),
                stats: {
                    trees: opts.trees, triangles: 21_000, triangleBudget: req.triangleBudget ?? 23_500, triangleBudgetSource: req.triangleBudget !== undefined ? 'explicit' : 'crown_targets', targetTriangles: 23_500,
                    skipped: [], inferred: { crownBaseRatio: 0.35, trunkRadiusPerHeight: 0.016, shellDepth: 0.8 },
                    shortOfCrown: opts.shortOfCrown ?? [], groundTolerance: 0.5, offGround: opts.offGround ?? [],
                    ...(req.supportMeshPath ? { keptOnSupportMesh: kept.map(k => k.id).filter(id => !(opts.keptNotOnSupportMesh ?? []).includes(id)), keptNotOnSupportMesh: opts.keptNotOnSupportMesh ?? [] } : {}),
                    perTree: list.map(c => ({ crownId: c.id, crownSurfaceReached: 0.97 }))
                },
                published: { path: `public/models/${req.publishAs}`, url: `/models/${req.publishAs}` }
            } as any;
        });
        return { strip, plant, dir };
    };
    const ask = (name: string, args: Record<string, unknown>, file: string) => createDefaultToolRegistry().dispatch(name,
        { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, outputGlbPath: outGlb(file), ...args }, { request: { prompt: 'Show me the Flatiron Building' } } as any);

    it('google_3d_tiles_get_full_texture remeshes the extracted tiles by default and mounts the remeshed model', async () => {
        serveTiles();
        const refine = fakeRefine();
        const veg = fakeVegetation({ trees: 3 });
        const outcome = await ask('google_3d_tiles_get_full_texture', {}, 'tex_remesh.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(veg.strip).not.toHaveBeenCalled(); // the photo-textured result keeps its scanned trees
        expect(refine).toHaveBeenCalledTimes(1);
        expect(refine.mock.calls[0][0]).toMatchObject({ tilePath: payload.glbPath, isolate: undefined });
        const obj = payload.artifact.data.objects[0];
        expect(payload.artifact.data.objects).toHaveLength(1);
        expect(obj.content.durableUri.endsWith('_refined.glb')).toBe(true);
        expect(obj.content.metadata).toMatchObject({ remeshed: true, rawGlbPath: payload.glbPath });
        expect(payload.remesh).toMatchObject({ ok: true, triangles: 46_220, inputTriangles: 403_385 });
        // what is mounted is counted from the remeshed model itself, and the scene says so (not the raw extraction)
        expect(outcome.exec.summaryResult).toContain('Remeshed (403,385 -> 2 triangles) in 12.3 s');
        expect(outcome.exec.summaryResult).not.toContain('[object Object]');
        expect(obj.content.metadata).toMatchObject({ vertexCount: 4, triangleCount: 2, rawTriangleCount: payload.mesh.triangleCount });
        expect(payload.artifact.summary).toContain('(4 vertices, 2 triangles)');
        expect(payload.mode).toBe('full-texture');
    });

    /**
     * The extraction with its tile seams closed (dffab125), written beside the raw extraction (textured.glb): every stage
     * after the tiles reads it, and the raw extraction is kept as it came.
     */
    const WELDED = `textured_${TILE_SEAMS_VERSION.replace(/\W/g, '_')}.glb`;
    /** The file a layer of the mounted scene was published as. */
    const publishedFile = (layer: any) => path.join(process.env.SCRATCHBOX_ROOT!, 'public', 'models', path.basename(layer.content.durableUri));

    /** The layers of the mounted scene, by their stage layer name (l1 tiles, l2 remesh, l5 trees). */
    const layersOf = (payload: any): Record<string, any> => Object.fromEntries(payload.artifact.data.objects.map((o: any) => [o.content.metadata.stagedLayer, o]));

    it('google_3d_tiles_get_clay builds the district in stages: the tiles, the remeshed devegetated tiles, then SB-Veggie trees grown from the measured crowns', async () => {
        serveTiles();
        const refine = fakeRefine();
        const veg = fakeVegetation({ trees: 3 });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_trees.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.status).toBe('complete');
        expect(payload.mode).toBe('clay');
        // the trees are measured in the photo tiles (the textured extraction, its tile seams closed), remeshing runs on what is
        // left, the trees are grown afterwards; the raw extraction beside the welded one is what the result names, unchanged
        const stripped = veg.strip.mock.calls[0][0].tilePath as string;
        expect(path.basename(stripped)).toBe(WELDED);
        expect(fs.readFileSync(payload.glbPath)).toEqual(fs.readFileSync(path.join(path.dirname(stripped), 'textured.glb')));
        expect(refine.mock.calls[0][0]).toMatchObject({ tilePath: path.join(veg.dir, 'devegetated.glb') });
        expect(refine.mock.calls[0][0].isolate).toBeUndefined();
        expect(veg.plant).toHaveBeenCalledTimes(1);
        // no budget given: the trees' budget comes from the measured crowns within the scene's cap, not from the remeshed tile
        expect(veg.plant.mock.calls[0][0]).toMatchObject({ crownsPath: path.join(veg.dir, 'crowns.json'), sceneTriangleCap: 1_500_000, seed: 'abababababababab', supportMeshPath: undefined });
        expect(veg.plant.mock.calls[0][0].triangleBudget).toBeUndefined();
        // the scene: the tiles as downloaded, the remesh that supersedes them (the ground objects stand on), the trees
        const layers = layersOf(payload);
        // every trunk base is measured against the remesh that is mounted: tile_refine's clay as the remesh polish left it
        const ground = veg.plant.mock.calls[0][0].groundMeshPath as string;
        expect(path.relative(remeshDir, ground)).toMatch(/^polish[\\/][0-9a-f]{16}[\\/]clay\.glb$/);
        expect(fs.readFileSync(ground)).toEqual(fs.readFileSync(publishedFile(layers.l2)));
        expect(Object.keys(layers)).toEqual(['l1', 'l2', 'l5']);
        expect(layers.l2.content.metadata).toMatchObject({ role: 'environment', remeshed: true, treesRemoved: true, isGround: true, source: 'Google3DTilesClay' });
        expect(layers.l1.content.metadata.isGround).toBe(false);
        expect(layers.l2.content.durableUri).toMatch(/^\/models\/.+_remesh_[0-9a-f]{8}\.glb$/);
        // the trees belong to the location layer: the viewer never re-seats an environment object on the ground under its
        // origin; they are not ground: nothing placed under a crown stands on top of it
        expect(layers.l5.content.metadata).toMatchObject({ source: 'SB-Veggie', role: 'environment', layer: 'vegetation', isGround: false, treeCount: 3, treesLeftAsScanned: 0, canopyAreaM2: 330, provenance: 'grown to the measured crown' });
        expect(layers.l5.content.durableUri).toMatch(/^\/models\/.+_trees_[0-9a-f]{8}\.glb$/);
        expect(layers.l5.space.spatial3d).toEqual(layers.l2.space.spatial3d);
        expect(payload.artifact.data.renderMode).toBe('clay');
        expect(payload.trees).toMatchObject({ measured: 3, count: 3, notRegrowable: 0, triangles: 21_000, triangleBudget: 23_500, triangleBudgetSource: 'crown_targets', cutAtBoundary: 1, cutRemoved: 1, belowMinHeight: 1 });
        expect(payload.trees.outcome).toBe('3 of 3 trees rebuilt as SB-Veggie; 0 left as scanned');
        // what the model reads says all of it
        const summary = payload.summary as string;
        expect(outcome.exec.summaryResult).toBe(payload.digest);
        expect(summary).toContain('Trees, grown to the measured crown: 3 of 3 trees rebuilt as SB-Veggie; 0 left as scanned. The rebuilt trees (space colonisation, studio clay) fill 330 m² of measured crown (1 of them runs to the extraction\'s edge and was rebuilt');
        expect(summary).toContain('Kept as scanned: 1 crown cut by the extraction boundary (its top lies outside it), 1 low planting');
        expect(summary).toContain('Taken out with the trees it was joined to, and not rebuilt (its trunk lies outside the extraction): 1 cut crown, 30 m² of canopy.');
        // what closing the ground added is said, not hidden in the payload
        expect(summary).toContain('walls and building sides the trees hid were continued straight down to that ground (80 m², up to 12.5 m tall; not in the scan)');
        expect(summary).toContain('the edges of other surfaces left standing over it were closed down to it (40 m², up to 6.0 m tall; not in the scan)');
        // every published model is a plain name under public/models, written whole
        for (const o of payload.artifact.data.objects) {
            const file = path.join(process.env.SCRATCHBOX_ROOT!, 'public', 'models', path.basename(o.content.durableUri));
            expect(path.basename(file)).toMatch(/^[A-Za-z0-9._-]+$/);
            expect(fs.statSync(file).size).toBeGreaterThan(0);
        }
    });

    it('google_3d_tiles_get_clay reports zero trees when no crown measures as a tree, and mounts only the tiles', async () => {
        serveTiles();
        fakeRefine();
        const veg = fakeVegetation({ trees: 0 });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_no_trees.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(veg.plant).not.toHaveBeenCalled();
        expect(Object.keys(layersOf(payload))).toEqual(['l1', 'l2']);
        expect(payload.trees).toMatchObject({ count: 0, canopyAreaM2: 812.5 });
        expect(payload.summary).toContain('no crown that measures as a tree, so no trees were added');
    });

    it('google_3d_tiles_get_clay marks the tiles as devegetated only when the strip removed something', async () => {
        serveTiles();
        fakeRefine();
        fakeVegetation({ trees: 0, canopyAreaM2: 0, removed: 0 });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_nothing_removed.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(layersOf(payload).l2.content.metadata).toMatchObject({ remeshed: true, treesRemoved: false });
        expect(payload.summary).toContain('No tree canopy was measured in the photo tiles, so no trees were added.');
        expect(payload.summary).not.toContain('ground was rebuilt');
    });

    it('google_3d_tiles_get_clay plants within the treeTriangleBudget the model gives, and the chat\'s stop reaches the extraction', async () => {
        serveTiles();
        fakeRefine();
        const veg = fakeVegetation({ trees: 3 });
        const outcome = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_clay',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, outputGlbPath: outGlb('clay_budget.glb'), treeTriangleBudget: '50000' },
            { request: { prompt: 'Show me the Flatiron Building' } } as any);
        expect(outcome.exec.status).toBe('completed');
        expect(veg.plant.mock.calls[0][0]).toMatchObject({ triangleBudget: 50_000 });
        const bad = await ask('google_3d_tiles_get_clay', { treeTriangleBudget: -5 }, 'clay_budget_bad.glb');
        expect(bad.exec.status).toBe('failed');
        expect((bad.resultPayload as any).error).toContain('google_3d_tiles_get_clay needs a treeTriangleBudget of at least 1 triangle: got -5');

        // a stop while the tiles download stops the extraction and mounts nothing
        const stop = new AbortController();
        let seen: AbortSignal | undefined;
        vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'fetch3DObject').mockImplementation(((_q: unknown, _m: unknown, options?: { signal?: AbortSignal }) => {
            seen = options?.signal;
            queueMicrotask(() => stop.abort());
            return new Promise((_, reject) => options!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('Google 3D Tiles extraction was stopped'), { name: 'AbortError' })), { once: true }));
        }) as never);
        const stopped = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_clay',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 90, trees: false }, { request: { prompt: 'Show me the Flatiron Building' }, signal: stop.signal } as any);
        expect(seen?.aborted).toBe(true);
        expect(stopped.exec.status).toBe('failed');
        expect((stopped.resultPayload as any).artifact).toBeUndefined();
    });

    it('google_3d_tiles_get_clay keeps the scanned canopy out of the trees step when trees is false', async () => {
        serveTiles();
        const refine = fakeRefine();
        const veg = fakeVegetation({ trees: 3 });
        const outcome = await ask('google_3d_tiles_get_clay', { trees: false }, 'clay_trees_off.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(veg.strip).not.toHaveBeenCalled();
        expect(path.basename(refine.mock.calls[0][0].tilePath)).toBe(WELDED);
        expect(Object.keys(layersOf(payload))).toEqual(['l1', 'l2']);
        expect(payload.trees).toBeUndefined();
    });

    it('google_3d_tiles_get_full_texture isolates the structure at the anchor when asked', async () => {
        serveTiles();
        const refine = fakeRefine();
        fakeVegetation({ trees: 2 });
        const outcome = await ask('google_3d_tiles_get_full_texture', { isolate: true }, 'google_3d_tiles_get_full_texture_iso.glb');
        expect(outcome.exec.status).toBe('completed');
        expect(refine.mock.calls[0][0]).toMatchObject({ isolate: true });
        expect(String(refine.mock.calls[0][0].publishAs)).toMatch(/_isolated/);
    });

    it('google_3d_tiles_get_clay with isolate shows the district, and says so, when no structure stands at the anchor', async () => {
        serveTiles(); // a flat ground leaf and a roof 200 m away: nothing 3 m tall within the widened 60 m search either
        const refine = fakeRefine();
        fakeVegetation({ trees: 2 });
        const outcome = await ask('google_3d_tiles_get_clay', { isolate: true }, 'clay_iso.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.status).toBe('degraded');
        // no isolate is asked of tile_refine for a structure that was not found
        expect(refine.mock.calls[0][0].isolate).toBeUndefined();
        const d = payload.degradations.find((x: any) => x.reasonCode === 'no_structure_at_anchor');
        expect(d).toMatchObject({ stage: 'tiles', reasonCode: 'no_structure_at_anchor', fellTo: 'the remeshed area around the place, without a rebuild', provenanceAfter: 'remeshed' });
        expect(payload.summary).toContain('no structure 3 m or taller stands within 60 m of the place; showing the area around it');
        // the rebuild stages are skipped, not failed, and the rest of the build stands
        for (const stage of ['fit', 'vision', 'detail']) expect(payload.stages.find((x: any) => x.stage === stage).status).toBe('skipped');
        expect(Object.keys(layersOf(payload))).toEqual(['l1', 'l2', 'l5']);
    });

    for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
        it(`${name} returns the raw tiles when remesh is false`, async () => {
            serveTiles();
            const refine = fakeRefine();
            const veg = fakeVegetation({ trees: 2 });
            const outcome = await ask(name, { remesh: false }, `${name}_raw.glb`);
            expect(outcome.exec.status).toBe('completed');
            expect(refine).not.toHaveBeenCalled();
            expect(veg.strip).not.toHaveBeenCalled();
            expect((outcome.resultPayload as any).artifact.data.objects[0].content.metadata.remeshed).toBe(false);
            expect(outcome.exec.summaryResult).toContain('Returned as raw tiles (not remeshed), as asked.');
            expect((outcome.resultPayload as any).mode).toBe(name.endsWith('_clay') ? 'clay' : 'full-texture');
        });
    }

    it('google_3d_tiles_get_full_texture fails, and mounts nothing, when remeshing fails', async () => {
        serveTiles();
        fakeRefine('tile_refine binary could not be built');
        fakeVegetation({ trees: 2 });
        const outcome = await ask('google_3d_tiles_get_full_texture', {}, 'tex_fail.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('failed');
        expect(payload.error).toContain('Tile extraction failed at remesh: tile_refine binary could not be built');
        expect(payload.artifact).toBeUndefined();
    });

    it('google_3d_tiles_get_clay shows the raw scan, and says the remesh failed and why, when remeshing fails', async () => {
        serveTiles();
        fakeRefine('tile_refine binary could not be built');
        const veg = fakeVegetation({ trees: 2 });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_fail.glb');
        const payload: any = outcome.resultPayload;
        // the call succeeds with what is real: the tiles as downloaded; nothing is planted over their scanned canopy
        expect(outcome.exec.status).toBe('completed');
        expect(payload.status).toBe('degraded');
        expect(Object.keys(layersOf(payload))).toEqual(['l1']);
        expect(veg.plant).not.toHaveBeenCalled();
        // the scan fitter is part of the app now: the ladder tries to flatten the raw scan first, and says so when that fails too
        expect(payload.degradations.filter((x: any) => x.stage === 'remesh').map((x: any) => x.reasonCode)).toEqual(['flatten_failed', 'remesh_failed']);
        const remesh = payload.degradations.find((x: any) => x.stage === 'remesh' && x.reasonCode === 'remesh_failed');
        expect(remesh).toMatchObject({ reasonCode: 'remesh_failed', provenanceAfter: 'as-scanned', transient: true, retry: { tool: 'google_3d_tiles_get_clay', args: { retryStage: 'remesh' } } });
        expect(remesh.reason).toContain('tile_refine binary could not be built');
        expect(payload.remesh).toMatchObject({ ok: false, error: expect.stringContaining('tile_refine binary could not be built') });
        expect(payload.summary).toContain('tile_refine binary could not be built');
        expect(outcome.exec.summaryResult).toMatch(/^Staged build degraded: .*remesh: remesh_failed.*retry retryRunId [0-9a-f]{8} stage remesh\.$/);
        // the isolated trees stay in the scan they were measured in: the layer of the tiles is the ground
        expect(layersOf(payload).l1.content.metadata.isGround).toBe(true);
    });

    for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
        it(`${name} refuses placeholder (mock) tiles instead of mounting them as real ones`, async () => {
            serveTiles();
            vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'fetch3DObject').mockResolvedValue({
                success: true, mock: true, mode: 'full-texture', glbPath: '/tmp/mock.glb', mesh: { vertexCount: 4, triangleCount: 2 }
            } as any);
            const refine = fakeRefine();
            const outcome = await ask(name, {}, `${name}_mock.glb`);
            expect(outcome.exec.status).toBe('failed');
            expect((outcome.resultPayload as any).error).toContain('placeholder tiles, not Google 3D Tiles');
            expect((outcome.resultPayload as any).artifact).toBeUndefined();
            expect(refine).not.toHaveBeenCalled();
        });
    }

    // The staged build names its published models itself: a plain name from the place (at most 40 characters) and the
    // stage key, whatever the place's address looks like. tile_refine's own naming rule applies to the textured tool.
    it('google_3d_tiles_get_clay publishes plain names for a place with a long address', async () => {
        serveTiles();
        fakeRefine();
        fakeVegetation({ trees: 2 });
        const geocode = vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'resolveAddress').mockResolvedValue({
            lat: ANCHOR.lat, lng: ANCHOR.lng, formattedAddress: 'Flatiron Building, 175 5th Ave, New York, NY 10010, USA (the triangular 1902 building between Broadway and Fifth Avenue)', landmarkName: 'Flatiron'
        } as any);
        const outcome = await ask('google_3d_tiles_get_clay', { query: 'Flatiron Building, 175 5th Ave, New York, NY 10010, USA (the triangular 1902 building)' }, 'flatiron_textured.glb');
        expect(geocode).toHaveBeenCalled();
        expect(outcome.exec.status).toBe('completed');
        const names = (outcome.resultPayload as any).artifact.data.objects.map((o: any) => path.basename(o.content.durableUri));
        expect(names.length).toBe(3);
        for (const name of names) {
            expect(name).toMatch(/^flatiron_building_175_5th_ave_new_york_n_(tiles|remesh|trees)_[0-9a-f]{8}\.glb$/);
        }
    });

    it('google_3d_tiles_get_clay keeps the scanned trees and remeshes the raw tile, and says the trees were not measured, when measuring them fails', async () => {
        serveTiles();
        const refine = fakeRefine();
        const veg = fakeVegetation({ trees: 2, fail: 'strip' });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_strip_fail.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.status).toBe('degraded');
        // the remesh runs on the extraction (its tile seams closed), its scanned trees in it; nothing is planted
        expect(path.basename(refine.mock.calls[0][0].tilePath)).toBe(WELDED);
        expect(veg.plant).not.toHaveBeenCalled();
        expect(Object.keys(layersOf(payload))).toEqual(['l1', 'l2']);
        const d = payload.degradations.find((x: any) => x.stage === 'trees-measure');
        expect(d).toMatchObject({ reasonCode: 'trees_not_measured', fellTo: "the scan's own trees, left in the remeshed scan", provenanceAfter: 'remeshed', transient: false });
        expect(d.reason).toContain('photo texture 3 could not be decoded: bad Huffman code');
        expect(payload.summary).toContain('photo texture 3 could not be decoded: bad Huffman code');
    });

    it('google_3d_tiles_get_clay puts the scanned trees back, and says why, when the measured trees need more than the scene cap', async () => {
        serveTiles();
        fakeRefine();
        fakeVegetation({ trees: 3, fail: 'plant' });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_plant_fail.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.status).toBe('degraded');
        const d = payload.degradations.find((x: any) => x.stage === 'trees' && x.reasonCode === 'trees_failed');
        expect(d.provenanceAfter === 'as-scanned' || d.fellTo.includes('nothing')).toBe(true);
        expect(d.reason).toContain("the 13,000 measured trees need at least 1,560,000 triangles at 120 each, more than the scene's cap of 1,500,000 triangles for trees.");
        // the model is told how to ask for fewer trees, or a budget that holds them
        expect(d.reason).toContain('Ask again with a smaller radiusMeters (fewer trees), or with treeTriangleBudget set to at least that many triangles to go over the cap, or with trees false.');
        expect(payload.summary).toContain('Ask again with a smaller radiusMeters (fewer trees)');
        // the tiles and the remesh stay committed
        expect(Object.keys(layersOf(payload)).slice(0, 2)).toEqual(['l1', 'l2']);
    });

    it('google_3d_tiles_get_clay puts the scanned trees back when the treeTriangleBudget asked for cannot hold the trees', async () => {
        serveTiles();
        fakeRefine();
        fakeVegetation({ trees: 3, fail: 'plant_explicit' });
        const outcome = await ask('google_3d_tiles_get_clay', { treeTriangleBudget: 10 }, 'clay_plant_fail_explicit.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        const d = payload.degradations.find((x: any) => x.stage === 'trees' && x.reasonCode === 'trees_failed');
        expect(d.reason).toContain('a triangle budget of 10 cannot hold 3 trees at 120 triangles each (they need at least 360); the budget was the treeTriangleBudget asked for.');
        expect(d.reason).toContain('Ask again with treeTriangleBudget set to at least that many triangles, or with trees false.');
    });

    it('google_3d_tiles_get_clay names the measured trees left as scanned, with why, and never counts them as rebuilt', async () => {
        serveTiles();
        fakeRefine();
        fakeVegetation({ trees: 3, notRegrowable: 1 });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_kept_scanned.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.trees).toMatchObject({ measured: 4, count: 3, notRegrowable: 1 });
        expect(payload.trees.keptAsScanned).toEqual([{
            crownId: 50, reasonCode: 'crown_not_reached', reason: "the regrown tree's leaves reach 89% of its measured crown surface (162 of 182 samples within 1.4 m; 90% needed)",
            colonisation: '193 of 215 attractors reached in 52 iterations, stopped: no_attractor_within_perception', areaM2: 479, heightM: 3.6515
        }]);
        const said = "3 of 4 trees rebuilt as SB-Veggie; 1 left as scanned: crown 50 (479 m², 3.7 m tall), the regrown tree's leaves reach 89% of its measured crown surface (162 of 182 samples within 1.4 m; 90% needed)";
        expect(payload.trees.outcome).toBe(said);
        expect(payload.summary).toContain(` ${said}.`);
        // that tree is a degraded part of its own: kept as scanned, with its reason, for the viewport to shade and the model to read
        expect(payload.degradations.find((x: any) => x.reasonCode === 'not_regrowable')).toMatchObject({ stage: 'trees', fellTo: 'that tree kept as scanned', provenanceAfter: 'as-scanned', part: { crownId: 50 } });
        expect(layersOf(payload).l5.content.metadata).toMatchObject({ treeCount: 3, treesLeftAsScanned: 1 });
    });

    it('google_3d_tiles_get_clay says, in the summary, the side closed beside a tree kept as scanned and every rebuilt tree short of its crown or off the mounted ground', async () => {
        serveTiles();
        fakeRefine();
        const veg = fakeVegetation({
            trees: 3, notRegrowable: 1, keptSkirt: true,
            shortOfCrown: [{ crownId: 1, budget: 120, ownBudget: 812, neededTriangles: 334, crownSurfaceReached: 0.776, reason: 'within its budget of 120 triangles its 5 leaf masses reach 77.6% of its measured crown surface (164 of 211 samples within 1.4 m; 90% needed)' }],
            offGround: [{ crownId: 2, gapM: 17.7 }]
        });
        const outcome = await ask('google_3d_tiles_get_clay', {}, 'clay_short.glb');
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        // every trunk base is measured against the model that is mounted (the remesh as the polish left it)
        expect(fs.readFileSync(veg.plant.mock.calls[0][0].groundMeshPath)).toEqual(fs.readFileSync(publishedFile(layersOf(payload).l2)));
        expect(payload.trees.keptAsScanned[0].closedSide).toEqual({ areaM2: 329.4, topY: 9.48, bottomY: -0.53 });
        expect(payload.trees.shortOfCrown).toHaveLength(1);
        expect(payload.trees.offGround).toEqual([{ crownId: 2, gapM: 17.7 }]);
        for (const part of [
            'where the trees beside it were taken out, its side was closed down to their ground with 329 m² of clay wall from 9.5 m down to -0.5 m (not in the scan)',
            '1 rebuilt tree does not fill its measured crown within its budget: crown 1, within its budget of 120 triangles its 5 leaf masses reach 77.6% of its measured crown surface',
            '1 rebuilt tree stands more than 0.5 m off the mounted model at its trunk base, measured under each stem: crown 2 (17.7 m above it)'
        ]) {
            expect(payload.trees.outcome).toContain(part);
            expect(payload.summary).toContain(part);
        }
        // a tree short of its crown is not said to fill it
        expect(payload.summary).toContain('The rebuilt trees (space colonisation, studio clay) are grown into 330 m² of measured crown, 220 m² of it by trees whose leaves fill their crown');
    });

    it('both extraction tools fail with a typed missing-input error when no place is given', async () => {
        for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
            const outcome = await createDefaultToolRegistry().dispatch(name, { radiusMeters: 120 }, { request: { prompt: 'tiles' } } as any);
            expect(outcome.exec.status).toBe('failed');
            expect((outcome.resultPayload as any).error).toContain(`${name} needs query`);
            expect((outcome.resultPayload as any).artifact).toBeUndefined();
        }
    });

    it('google_3d_tiles_get_clay refuses trees with remesh false, which would be raw tiles', async () => {
        serveTiles();
        const outcome = await ask('google_3d_tiles_get_clay', { remesh: false, trees: true }, 'clay_raw_trees.glb');
        expect(outcome.exec.status).toBe('failed');
        // the typed missing-input error, before anything is downloaded
        expect((outcome.resultPayload as any).error).toContain('google_3d_tiles_get_clay needs remesh true to rebuild trees: trees are rebuilt as part of remeshing');
        const { MissingInputError } = await import('../src/common/errors/pipeline-errors');
        const handler = createDefaultToolRegistry().get('google_3d_tiles_get_clay')!.handler;
        await expect(handler({ query: 'x', remesh: false, trees: true }, {} as any)).rejects.toBeInstanceOf(MissingInputError);
    });

    it('declares remesh and isolate on both extraction tools, trees on the clay tool, and no mock mode', () => {
        const registry = createDefaultToolRegistry();
        for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
            const props = (registry.get(name)!.declaration.parameters as any).properties;
            expect(props.remesh.type).toBe('BOOLEAN');
            expect(props.isolate.type).toBe('BOOLEAN');
            expect(props.mockExecution).toBeUndefined();
            expect(props.remesh.description).toMatch(/If remeshing fails/);
        }
        expect((registry.get('google_3d_tiles_get_clay')!.declaration.parameters as any).properties.trees.type).toBe('BOOLEAN');
        expect((registry.get('google_3d_tiles_get_clay')!.declaration.parameters as any).properties.treeTriangleBudget.type).toBe('NUMBER');
        expect((registry.get('google_3d_tiles_get_full_texture')!.declaration.parameters as any).properties.trees).toBeUndefined();
    });
});
