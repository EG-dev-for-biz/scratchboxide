/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build's stage cache: atomic entries and publishing, a truncated published file republished on the next
 * hit (never served), in-flight dedupe, negative entries tied to the engine build, bypass for a retry, run records.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StageCache, sha256File, stageKey } from '../src/node/3d-engine/staged-location/stage-cache';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-stage-cache-')));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const glbBytes = (n: number) => Buffer.concat([Buffer.from('glTF'), Buffer.alloc(n, 7)]);

describe('StageCache', () => {
    it('writes an entry atomically, publishes it, and serves the next request from cache without running', async () => {
        const cache = new StageCache({ workspaceRoot: ROOT });
        const key = stageKey('fit', { a: 1 });
        let runs = 0;
        const produce = async (dir: string) => {
            runs++;
            fs.writeFileSync(path.join(dir, 'fitted.glb'), glbBytes(5000));
            return { value: { primitives: 23 }, inputs: { scan: 'abc' } };
        };
        const first = await cache.run('fit', key, produce, { publish: () => [{ from: 'fitted.glb', as: `arch_fit_${key.slice(0, 8)}.glb` }] });
        expect(first.cached).toBe(false);
        expect(first.value).toEqual({ primitives: 23 });
        expect(first.published[0]).toMatchObject({ url: `/models/arch_fit_${key.slice(0, 8)}.glb`, bytes: 5004 });
        expect(fs.readFileSync(first.published[0].path)).toEqual(glbBytes(5000));
        // no temp files are left beside the entry or the published file
        expect(fs.readdirSync(path.join(cache.dir, 'fit')).filter(f => f.includes('.tmp-'))).toEqual([]);
        expect(fs.readdirSync(cache.modelsDir).filter(f => f.startsWith('.'))).toEqual([]);

        const second = await cache.run('fit', key, produce);
        expect(second.cached).toBe(true);
        expect(runs).toBe(1);
        expect(second.published[0].sha256).toBe(first.published[0].sha256);
    });

    it('detects a truncated published file on the next hit and publishes it again from the entry', async () => {
        const cache = new StageCache({ workspaceRoot: ROOT });
        const key = stageKey('detail', 'x');
        const made = await cache.run('detail', key, async dir => {
            fs.writeFileSync(path.join(dir, 'detail.glb'), glbBytes(20_000));
            return { value: { elements: 14 } };
        }, { publish: () => [{ from: 'detail.glb', as: 'arch_detail.glb' }] });
        const target = made.published[0].path;
        // an interrupted copy: the first 3 KB only
        fs.writeFileSync(target, fs.readFileSync(target).subarray(0, 3000));
        expect(fs.statSync(target).size).toBe(3000);
        const hit = cache.get<{ elements: number }>('detail', key);
        expect(hit?.cached).toBe(true);
        expect(fs.statSync(target).size).toBe(20_004);
        expect(sha256File(target)).toBe(made.published[0].sha256);
    });

    it('treats an entry whose published source is gone and whose copy is damaged as a miss, never a hit', async () => {
        const cache = new StageCache({ workspaceRoot: ROOT });
        const src = path.join(ROOT, 'elsewhere.glb');
        fs.writeFileSync(src, glbBytes(800));
        const key = stageKey('remesh', 'y');
        const rec = cache.remember('remesh', key, { triangles: 2 }, [{ from: src, as: 'arch_remesh.glb' }]);
        expect(cache.get('remesh', key)?.value).toEqual({ triangles: 2 });
        fs.writeFileSync(rec.published[0].path, 'trunc');
        fs.rmSync(src);
        expect(cache.get('remesh', key)).toBeUndefined();
    });

    it('shares one run between concurrent identical requests, and bypass replaces the entry', async () => {
        const cache = new StageCache({ workspaceRoot: ROOT });
        const key = stageKey('vision', 'z');
        let runs = 0;
        const produce = async (dir: string) => {
            runs++;
            await new Promise(r => setTimeout(r, 30));
            fs.writeFileSync(path.join(dir, 'reply.json'), `{"n":${runs}}`);
            return { value: { n: runs } };
        };
        const [a, b] = await Promise.all([cache.run('vision', key, produce), cache.run('vision', key, produce)]);
        expect(runs).toBe(1);
        expect(a.value).toEqual(b.value);
        const fresh = await cache.run('vision', key, produce, { bypass: true });
        expect(runs).toBe(2);
        expect(fresh.value).toEqual({ n: 2 });
        expect(cache.get('vision', key)?.value).toEqual({ n: 2 });
    });

    it('keeps a deterministic failure per engine build, so a rebuilt engine runs again', () => {
        const cache = new StageCache({ workspaceRoot: ROOT });
        const key = stageKey('fit', 'bad');
        cache.putNegative('fit', key, { code: 'input_unreadable', message: 'the scan GLB has no POSITION accessor', binarySha256: 'aa' });
        expect(cache.negative('fit', key, 'aa')).toMatchObject({ code: 'input_unreadable', message: 'the scan GLB has no POSITION accessor' });
        expect(cache.negative('fit', key, 'bb')).toBeUndefined();
        cache.clearNegative('fit', key);
        expect(cache.negative('fit', key, 'aa')).toBeUndefined();
    });

    it('keeps a run record by its 8-hex run id and refuses any other id', () => {
        const cache = new StageCache({ workspaceRoot: ROOT });
        cache.writeRunRecord('a1b2c3d4', { request: { query: 'Washington Square Arch', isolate: true }, keys: { tiles: 'k' } });
        expect(cache.readRunRecord('a1b2c3d4')).toEqual({ request: { query: 'Washington Square Arch', isolate: true }, keys: { tiles: 'k' } });
        expect(cache.readRunRecord('00000000')).toBeUndefined();
        expect(() => cache.writeRunRecord('../etc', {})).toThrow(/bad run id/);
        expect(() => cache.entryDir('fit', '../x')).toThrow(/bad key/);
    });
});
