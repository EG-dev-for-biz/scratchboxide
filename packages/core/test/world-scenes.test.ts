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
import { listWorldScenes, listWorldVersions, openWorld, openWorldVersion, saveWorld, syncWorldScene } from '../src/node/cloud-store/world-scenes';

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

        // saved twice: the newest opens, from this machine's copy without the cloud; both are listed, the built files are untouched
        const strokes = [{ op: 'erase', points: [0, 1, 2], radius: 0.5 }];
        const v1 = await saveWorld(slug, { ...first.scene, splatEdits: strokes }, tilesets, bucket);
        const v2 = await saveWorld(slug, { ...first.scene, title: 'edited', splatEdits: [...strokes, ...strokes] }, tilesets, bucket);
        const reopened = await openWorld<{ title: string; splatEdits?: unknown[] }>(slug, tilesets, undefined);
        expect(reopened.source).toBe('cache');
        expect(reopened.version).toBe(v2.version);
        expect(reopened.scene.title).toBe('edited');
        expect(reopened.scene.splatEdits).toHaveLength(2);
        expect(reopened.fetchedFiles).toBeUndefined();
        expect((await listWorldScenes(bucket, 'key1')).sort()).toEqual([v1.version, v2.version].sort());
        expect(fs.readFileSync(path.join(tilesets, slug, 'fused.spz'))).toEqual(Buffer.from([1, 2, 3, 4]));

        // a third machine fetches the world and keeps its newest save; storing the world again leaves the saves out of its files
        const third = path.join(WORK, 'third', 'tilesets');
        const fetched = await openWorld<{ title: string }>(slug, third, bucket);
        expect(fetched.source).toBe('cloud');
        expect(fetched.version).toBe(v2.version);
        expect((await openWorld<{ title: string }>(slug, third, undefined)).version).toBe(v2.version);
        expect(await storeWorld(bucket, 'key1', path.join(third, slug), { splatCount: 1 })).toBe(2);
    });

    it('keeps a world here opening from its local copy until a newer save made elsewhere is synced', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket3'));
        const slug = 'synced_street_40.2_-73.8';
        const built = path.join(WORK, 'built3', slug);
        await fs.outputJson(path.join(built, 'scene3d.json'), { title: 'built' });
        await storeWorld(bucket, 'key3', built, { splatCount: 1 });
        const here = path.join(WORK, 'here', 'tilesets');
        const elsewhere = path.join(WORK, 'elsewhere', 'tilesets');
        await openWorld(slug, here, bucket);
        await openWorld(slug, elsewhere, bucket);

        const mine = await saveWorld(slug, { title: 'mine' }, here, bucket);
        expect(await syncWorldScene(slug, here, bucket)).toBeUndefined();
        const theirs = await saveWorld(slug, { title: 'theirs' }, elsewhere, bucket);
        const before = await openWorld<{ title: string }>(slug, here, bucket);
        expect([before.source, before.version, before.scene.title]).toEqual(['cache', mine.version, 'mine']);

        expect((await syncWorldScene(slug, here, bucket))?.version).toBe(theirs.version);
        const after = await openWorld<{ title: string }>(slug, here, bucket);
        expect([after.source, after.version, after.scene.title]).toEqual(['cache', theirs.version, 'theirs']);
        expect(await syncWorldScene(slug, here, bucket)).toBeUndefined();
    });

    it('lists a world\'s saved versions and opens an older one, or the world as built', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket4'));
        const slug = 'versioned_street_40.3_-73.7';
        const built = path.join(WORK, 'built4', slug);
        await fs.outputJson(path.join(built, 'scene3d.json'), { title: 'built' });
        await storeWorld(bucket, 'key4', built, { splatCount: 1 });
        const here = path.join(WORK, 'here4', 'tilesets');
        await openWorld(slug, here, bucket);
        const v1 = await saveWorld(slug, { title: 'first' }, here, bucket);
        const v2 = await saveWorld(slug, { title: 'second' }, here, bucket);

        // listed newest first, each with the time read from its name, from the cloud and, without it, from this machine
        const listed = await listWorldVersions(slug, here, bucket);
        expect(listed.source).toBe('cloud');
        expect(listed.versions.map(v => v.version)).toEqual([v2.version, v1.version].sort().reverse());
        expect(listed.versions.find(v => v.version === v1.version)!.savedAt).toBe(v1.savedAt.replace(/\.\d+Z$/, 'Z'));
        expect((await listWorldVersions(slug, here, undefined))).toEqual({ ...listed, source: 'cache' });

        // the older version opens from this machine's copy; on another machine from the cloud, then from its own copy
        const older = await openWorldVersion<{ title: string }>(slug, v1.version, here, undefined);
        expect([older.source, older.version, older.scene.title]).toEqual(['cache', v1.version, 'first']);
        const other = path.join(WORK, 'other4', 'tilesets');
        await openWorld(slug, other, bucket);
        expect((await openWorldVersion<{ title: string }>(slug, v1.version, other, bucket)).source).toBe('cloud');
        expect((await openWorldVersion<{ title: string }>(slug, v1.version, other, undefined)).scene.title).toBe('first');

        // as built is the build's own scene; names that are not versions, and versions never saved, are refused
        const asBuilt = await openWorldVersion<{ title: string }>(slug, 'built', here, bucket);
        expect([asBuilt.source, asBuilt.version, asBuilt.scene.title]).toEqual(['local', undefined, 'built']);
        await expect(openWorldVersion(slug, '../../etc/passwd', here, bucket)).rejects.toThrow(/Not a version name/);
        await expect(openWorldVersion(slug, '20200101T000000Z-zzzz', here, bucket)).rejects.toThrow(/no saved version/);
    });

    it('refuses to save a world the cache does not hold, and to open a name that is not a folder name', async () => {
        const bucket = new DirectoryCloudBucket(path.join(WORK, 'bucket2'));
        await expect(saveWorld('never_built', {}, path.join(WORK, 't'), bucket)).rejects.toThrow(/no entry/);
        await expect(saveWorld('never_built', {}, path.join(WORK, 't'), undefined)).rejects.toThrow(/No world cache bucket/);
        await expect(openWorld('../etc', path.join(WORK, 't'), bucket)).rejects.toThrow(/Not a world name/);
        await expect(openWorld('missing', path.join(WORK, 't'), bucket)).rejects.toThrow(/not on this machine/);
    });
});
