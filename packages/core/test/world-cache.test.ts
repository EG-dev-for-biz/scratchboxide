/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { fetchWorld, storeWorld, worldCacheKey, WORLD_CACHE_PREFIX, WORLD_MANIFEST } from '../src/node/cloud-store/world-cache';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-world-cache-'));
afterAll(() => fs.removeSync(WORK));

/** A built world's output folder: tileset, tiles, splat, scene, and per-station work that is not stored. */
function builtWorld(dir: string): void {
    fs.outputFileSync(path.join(dir, 'tileset.json'), JSON.stringify({ root: { content: { uri: 'tiles/0.glb' } } }));
    fs.outputFileSync(path.join(dir, 'tiles', '0.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]));
    fs.outputFileSync(path.join(dir, 'fused.splat'), Buffer.alloc(32 * 10, 7));
    fs.outputFileSync(path.join(dir, 'scene3d.json'), '{}');
    fs.outputFileSync(path.join(dir, 'stations', 'station_001_beautified.png'), Buffer.alloc(100, 1));
}

describe('world cache', () => {
    it('keys a world by what decides it, in any order, and no other ask shares it', () => {
        const a = worldCacheKey({ lat: '40.749745', lng: '-73.991630', sideDeg: 270, headingDeg: 90 });
        expect(worldCacheKey({ headingDeg: 90, sideDeg: 270, lng: '-73.991630', lat: '40.749745', unset: undefined })).toBe(a);
        expect(worldCacheKey({ lat: '40.749745', lng: '-73.991630', sideDeg: 270, headingDeg: 180 })).not.toBe(a);
        expect(a).toMatch(/^[0-9a-f]{24}$/);
    });

    it('stores a built world without its per-station work and fetches it whole into another folder', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket'));
        const built = path.join(WORK, 'built');
        builtWorld(built);
        const stored = await storeWorld(bucket, 'k1', built, { splatCount: 10 });
        expect(stored).toBe(4);
        expect(fs.existsSync(path.join(WORK, 'bucket', ...WORLD_CACHE_PREFIX.split('/'), 'k1', 'stations'))).toBe(false);

        const fresh = path.join(WORK, 'fresh');
        const hit = await fetchWorld<{ splatCount: number }>(bucket, 'k1', fresh);
        expect(hit!.result.splatCount).toBe(10);
        expect(hit!.files.sort()).toEqual(['fused.splat', 'scene3d.json', 'tiles/0.glb', 'tileset.json']);
        for (const f of hit!.files) expect(fs.readFileSync(path.join(fresh, f)).equals(fs.readFileSync(path.join(built, f)))).toBe(true);
        // no manifest is left behind in either folder
        expect(fs.readdirSync(fresh).some(f => f.includes(WORLD_MANIFEST))).toBe(false);
        expect(fs.readdirSync(built).some(f => f.includes(WORLD_MANIFEST))).toBe(false);
    });

    it('finds nothing for an unknown world, or one whose upload never wrote its manifest', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket2'));
        expect(await fetchWorld(bucket, 'missing', path.join(WORK, 'none'))).toBeUndefined();
        // an interrupted upload: files, no manifest
        await bucket.putFile(`${WORLD_CACHE_PREFIX}/half/fused.splat`, (builtWorld(path.join(WORK, 'half')), path.join(WORK, 'half', 'fused.splat')));
        expect(await fetchWorld(bucket, 'half', path.join(WORK, 'none2'))).toBeUndefined();
    });
});
