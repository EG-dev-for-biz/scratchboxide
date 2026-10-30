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
import { readWorldIndex, storeWorld } from '../src/node/cloud-store/world-cache';
import { listWorldScenes, openWorld, saveWorld } from '../src/node/cloud-store/world-scenes';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-world-scenes-'));
afterAll(() => fs.removeSync(WORK));

describe('world scenes', () => {
    it('opens a world by its folder name, fetching it from the cache, and saves and reopens its scene as versions', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket'));
        const slug = 'some_street_40.1_-73.9';
        const built = path.join(WORK, 'built', slug);
        await fs.outputFile(path.join(built, 'fused.spz'), Buffer.from([1, 2, 3, 4]));
        await fs.outputJson(path.join(built, 'scene3d.json'), { title: 'built', splatUrl: `/tilesets/${slug}/fused.spz` });
        await storeWorld(bucket, 'key1', built, { splatCount: 1 });
        expect(await readWorldIndex(bucket, slug)).toBe('key1');

        // another machine: no local copy, the world comes from the cache, its scene as built
        const tilesets = path.join(WORK, 'other', 'tilesets');
        const first = await openWorld<{ title: string; splatEdits?: unknown[] }>(slug, tilesets, bucket);
        expect(first.source).toBe('local');
        expect(first.fetchedFiles).toBe(2);
        expect(first.scene.title).toBe('built');
        expect(fs.readFileSync(path.join(tilesets, slug, 'fused.spz'))).toEqual(Buffer.from([1, 2, 3, 4]));

        // saved twice: the newest opens, both are listed, the built files are untouched
        const strokes = [{ op: 'erase', points: [0, 1, 2], radius: 0.5 }];
        const v1 = await saveWorld(slug, { ...first.scene, splatEdits: strokes }, bucket);
        const v2 = await saveWorld(slug, { ...first.scene, title: 'edited', splatEdits: [...strokes, ...strokes] }, bucket);
        const reopened = await openWorld<{ title: string; splatEdits?: unknown[] }>(slug, tilesets, bucket);
        expect(reopened.source).toBe('cloud');
        expect(reopened.version).toBe(v2.version);
        expect(reopened.scene.title).toBe('edited');
        expect(reopened.scene.splatEdits).toHaveLength(2);
        expect(reopened.fetchedFiles).toBeUndefined();
        expect((await listWorldScenes(bucket, 'key1')).sort()).toEqual([v1.version, v2.version].sort());
        expect(fs.readFileSync(path.join(tilesets, slug, 'fused.spz'))).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it('refuses to save a world the cache does not hold, and to open a name that is not a folder name', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket2'));
        await expect(saveWorld('never_built', {}, bucket)).rejects.toThrow(/no entry/);
        await expect(saveWorld('never_built', {}, undefined)).rejects.toThrow(/No world cache bucket/);
        await expect(openWorld('../etc', path.join(WORK, 't'), bucket)).rejects.toThrow(/Not a world name/);
        await expect(openWorld('missing', path.join(WORK, 't'), bucket)).rejects.toThrow(/not on this machine/);
    });
});
