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
import { Google3DTileCrawlerBaker } from '../src/node/spatial/Google3DTileCrawlerBaker';

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
const scratch: string[] = [];

/** Serves the tileset, its leaves and the elevation API; records every requested path. */
function serveTiles(): { requested: string[] } {
    const requested: string[] = [];
    globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        if (url.hostname === 'maps.googleapis.com' && url.pathname.endsWith('/elevation/json')) {
            return new Response(JSON.stringify({ status: 'OK', results: [{ elevation: GROUND_H }] }), { status: 200 });
        }
        if (url.hostname === 'tile.googleapis.com' && url.pathname === '/v1/3dtiles/root.json') {
            return new Response(JSON.stringify(TILESET), { status: 200 });
        }
        const leaf = LEAVES[path.basename(url.pathname)];
        if (url.hostname === 'tile.googleapis.com' && leaf) return new Response(new Uint8Array(leaf), { status: 200 });
        return new Response('not served by this test', { status: 404 });
    }) as typeof fetch;
    process.env.GOOGLE_MAPS_API_KEY = 'TEST_KEY';
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
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, outputGlbPath: outGlb('flatiron_120.glb') }, {} as any);
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.radiusMeters).toBe(120);
        expect(requested.some(p => p.endsWith('/near.glb'))).toBe(true);
        expect(requested.some(p => p.endsWith('/far.glb'))).toBe(false); // the roof 190 m out is beyond 120 m
        expect(payload.mesh.triangleCount).toBe(2);
        expect(fs.statSync(payload.glbPath).size).toBeGreaterThan(0);
        expect(outcome.exec.summaryResult).toContain('within 120 m of the anchor');
    });

    it('uses the 250 m default when no radius is given', async () => {
        const { requested } = serveTiles();
        const outcome = await createDefaultToolRegistry().dispatch('google_3d_tiles_get_clay',
            { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, outputGlbPath: outGlb('flatiron_default.glb') }, {} as any);
        const payload: any = outcome.resultPayload;
        expect(outcome.exec.status).toBe('completed');
        expect(payload.radiusMeters).toBe(250);
        expect(requested.some(p => p.endsWith('/far.glb'))).toBe(true);
        expect(payload.mesh.triangleCount).toBe(4);
    });
});

describe('google_3d_tiles staging', () => {
    for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
        it(`${name} opens a new studio scene instead of merging into an unrelated active scene`, async () => {
            serveTiles();
            const outcome = await createDefaultToolRegistry().dispatch(name,
                { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, outputGlbPath: outGlb(`${name}_new.glb`) },
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
                { query: `${ANCHOR.lat}, ${ANCHOR.lng}`, radiusMeters: 120, stageIntoActiveScene: true, outputGlbPath: outGlb(`${name}_staged.glb`) },
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
        expect(fs.realpathSync(tileRefineRootFor(tile, DESKTOP))).toBe(REPO);
        expect(fs.realpathSync(tileRefineRootFor(`public/models/${name}.glb`, DESKTOP))).toBe(REPO);
        // a file in the workspace stays there; a missing one is reported against the workspace
        expect(tileRefineRootFor('package.json', DESKTOP)).toBe(DESKTOP);
        expect(tileRefineRootFor('public/tiles/no_such_tile.glb', DESKTOP)).toBe(DESKTOP);
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
