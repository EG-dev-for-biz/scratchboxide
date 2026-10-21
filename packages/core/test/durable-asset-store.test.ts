/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The durable asset store: files are kept by content hash under the Scratchbox home with the served path and recipe
 * that made them, a lost checkout copy is found again by its served path, a sweep records a directory without
 * re-hashing unchanged files, and every change is logged.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableAssetStore, normalizeServedPath, sha256OfFile } from '../src/node/asset-store/durable-asset-store';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-asset-store-')));
const WORK = path.join(HOME, 'work');
fs.mkdirSync(WORK, { recursive: true });
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const glbBytes = (n: number, fill = 7) => Buffer.concat([Buffer.from('glTF'), Buffer.alloc(n, fill)]);
const writeGlb = (name: string, n: number, fill?: number) => {
    const file = path.join(WORK, name);
    fs.writeFileSync(file, glbBytes(n, fill));
    return file;
};

describe('DurableAssetStore', () => {
    it('keeps a published file by content hash and finds it again by its served path after the checkout copy is gone', () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-a'));
        const file = writeGlb('tower.glb', 4000);
        const expectedSha = sha256OfFile(file);
        const stored = store.putFile(file, { servedPath: '/models/tower.glb', origin: 'staged-location', recipeId: 'staged:0a1b2c3d', workspace: WORK });
        expect(stored.sha256).toBe(expectedSha);
        expect(stored.bytes).toBe(4004);
        expect(stored.mime).toBe('model/gltf-binary');
        expect(stored.file).toBe(path.join(store.root, 'blobs', expectedSha.slice(0, 2), expectedSha));
        expect(fs.readFileSync(stored.file)).toEqual(glbBytes(4000));

        fs.rmSync(file);
        const found = store.lookup('/models/tower.glb');
        expect(found?.file).toBe(stored.file);
        expect(found?.recipeId).toBe('staged:0a1b2c3d');
        expect(found?.rebuilt).toBe(false);
        // URL-encoded and query-suffixed requests resolve to the same record
        expect(store.lookup('/models/tower.glb?x=1')?.sha256).toBe(expectedSha);
        expect(store.lookup('%2Fmodels%2Ftower.glb')?.sha256).toBe(expectedSha);
        expect(store.lookup('/models/other.glb')).toBeUndefined();
        // no temp files are left in the blob directory
        expect(fs.readdirSync(path.dirname(stored.file)).filter(f => f.includes('.tmp-'))).toEqual([]);
        store.close();
    });

    it('stores identical content once, logs a replaced path, and refuses to serve a blob whose bytes are not whole', () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-b'));
        const a = store.putFile(writeGlb('a.glb', 300), { servedPath: '/models/a.glb', origin: 'test' });
        const b = store.putFile(writeGlb('b.glb', 300), { servedPath: '/models/b.glb', origin: 'test' });
        expect(a.sha256).toBe(b.sha256);
        expect(a.file).toBe(b.file);
        const c = store.putFile(writeGlb('c.glb', 300, 9), { servedPath: '/models/a.glb', origin: 'test' });
        expect(c.sha256).not.toBe(a.sha256);
        expect(store.lookup('/models/a.glb')?.sha256).toBe(c.sha256);
        const kinds = store.events({ subject: '/models/a.glb' }).map(e => e.kind);
        expect(kinds).toEqual(['asset.replaced', 'asset.stored']);
        expect(store.events({ subject: '/models/a.glb' })[0].detail).toMatchObject({ previousSha256: a.sha256, origin: 'test' });

        // a truncated blob is not served, and the record stays so the recipe can still be found
        fs.writeFileSync(c.file, fs.readFileSync(c.file).subarray(0, 100));
        expect(store.lookup('/models/a.glb')).toBeUndefined();
        expect(store.record('/models/a.glb')?.sha256).toBe(c.sha256);
        store.close();
    });

    it('keeps recipes, finds the recipe behind a served path, and aliases a rebuilt file under the lost name', () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-c'));
        const request = { query: 'Washington Square Park', isolate: false, trees: true };
        store.putRecipe({ id: 'staged:deadbeef', kind: 'staged-location', workspace: WORK, body: { runId: 'deadbeef', request } });
        store.putFile(writeGlb('old_l2.glb', 2000), { servedPath: '/models/wsp_l2_deadbeef.glb', origin: 'staged-location', recipeId: 'staged:deadbeef' });
        expect(store.recipeFor('/models/wsp_l2_deadbeef.glb')).toMatchObject({ kind: 'staged-location', body: { request } });
        expect(store.servedByRecipe('staged:deadbeef').map(s => s.path)).toEqual(['/models/wsp_l2_deadbeef.glb']);

        // the blob is lost (a cleaned store), then a rebuild publishes under a new name: the old path is pointed at it
        fs.rmSync(store.lookup('/models/wsp_l2_deadbeef.glb')!.file);
        expect(store.lookup('/models/wsp_l2_deadbeef.glb')).toBeUndefined();
        store.putFile(writeGlb('new_l2.glb', 2100), { servedPath: '/models/wsp_l2_c0ffee00.glb', origin: 'staged-location', recipeId: 'staged:c0ffee00' });
        const aliased = store.alias('/models/wsp_l2_deadbeef.glb', '/models/wsp_l2_c0ffee00.glb', { origin: 'recovery', rebuilt: true });
        expect(aliased.rebuilt).toBe(true);
        expect(aliased.bytes).toBe(2104);
        expect(store.lookup('/models/wsp_l2_deadbeef.glb')?.sha256).toBe(store.lookup('/models/wsp_l2_c0ffee00.glb')?.sha256);
        expect(store.events({ subject: '/models/wsp_l2_deadbeef.glb' })[0]).toMatchObject({ kind: 'asset.rebuilt', detail: { from: '/models/wsp_l2_c0ffee00.glb' } });
        store.close();
    });

    it('sweeps a directory into the store once, skips unchanged files on the next sweep, and sees a changed file', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-d'));
        const models = path.join(HOME, 'public-d', 'models');
        fs.mkdirSync(path.join(models, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(models, 'one.glb'), glbBytes(500));
        fs.writeFileSync(path.join(models, 'nested', 'two.json'), '{"a":1}');
        fs.writeFileSync(path.join(models, '.hidden.tmp-1'), 'x');
        const first = await store.backfill(models, '/models', { origin: 'backfill', workspace: WORK });
        expect(first).toEqual({ added: 2, unchanged: 0, failed: [] });
        expect(store.lookup('/models/nested/two.json')?.mime).toBe('application/json');
        expect(store.lookup('/models/.hidden.tmp-1')).toBeUndefined();

        const second = await store.backfill(models, '/models');
        expect(second).toEqual({ added: 0, unchanged: 2, failed: [] });

        // same size, new content and mtime: hashed again and recorded as replaced
        fs.writeFileSync(path.join(models, 'one.glb'), glbBytes(500, 3));
        fs.utimesSync(path.join(models, 'one.glb'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
        const third = await store.backfill(models, '/models');
        expect(third).toMatchObject({ added: 1, unchanged: 1 });
        expect(store.lookup('/models/one.glb')?.sha256).toBe(sha256OfFile(path.join(models, 'one.glb')));

        // a copy the store wrote back to disk keeps its record (origin, recipe, rebuilt) through the next sweep
        store.putFile(writeGlb('r.glb', 640), { servedPath: '/models/other.glb', origin: 'staged-location', recipeId: 'staged:0000aaaa' });
        store.alias('/models/lost.glb', '/models/other.glb', { origin: 'recovery', rebuilt: true });
        store.materialize('/models/lost.glb', models);
        const fourth = await store.backfill(models, '/models');
        expect(fourth).toMatchObject({ added: 0, unchanged: 3 });
        expect(store.lookup('/models/lost.glb')).toMatchObject({ rebuilt: true, origin: 'recovery', recipeId: 'staged:0000aaaa' });
        store.close();
    });

    it('rejects served paths that could escape or alias a directory', () => {
        expect(normalizeServedPath('models/x.glb')).toBe('/models/x.glb');
        expect(normalizeServedPath('/models//x%20y.glb')).toBe('/models/x y.glb');
        expect(() => normalizeServedPath('/models/../etc/passwd')).toThrow(/\.\./);
        expect(() => normalizeServedPath('/models/./x.glb')).toThrow();
        expect(() => normalizeServedPath('/models/%ZZ.glb')).toThrow(/URL text/);
    });

    it('is shared safely between two store instances on the same database (two app processes)', () => {
        const home = path.join(HOME, 'home-e');
        const one = new DurableAssetStore(home);
        const two = new DurableAssetStore(home);
        one.putFile(writeGlb('shared.glb', 800), { servedPath: '/models/shared.glb', origin: 'one' });
        expect(two.lookup('/models/shared.glb')?.origin).toBe('one');
        two.putFile(writeGlb('shared2.glb', 900), { servedPath: '/models/shared.glb', origin: 'two' });
        expect(one.lookup('/models/shared.glb')?.origin).toBe('two');
        expect(one.db.countServed()).toBe(1);
        one.close();
        two.close();
    });
});
