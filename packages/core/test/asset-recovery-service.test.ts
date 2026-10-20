/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Asset recovery: a missing file is restored from the store when it is there, rebuilt from its staged recipe when it
 * is not (one re-run per lost run, the old names pointed at the new files and marked rebuilt), reported as
 * unrecoverable with why otherwise, and a running rebuild can be cancelled.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableAssetStore } from '../src/node/asset-store/durable-asset-store';
import { AssetRecoveryService, layerNameKey, type StagedRebuilder } from '../src/node/asset-store/asset-recovery-service';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-asset-recovery-')));
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

const glbBytes = (n: number, fill = 7) => Buffer.concat([Buffer.from('glTF'), Buffer.alloc(n, fill)]);
let fileCounter = 0;
const writeFile = (bytes: Buffer) => {
    const file = path.join(HOME, `f${fileCounter++}.bin`);
    fs.writeFileSync(file, bytes);
    return file;
};
const settled = async (service: AssetRecoveryService, id: string) => {
    for (let i = 0; i < 200; i++) {
        const job = service.get(id)!;
        if (job.status !== 'running') return job;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('the job did not settle');
};

describe('layerNameKey', () => {
    it('is the same for one layer across runs and differs between layers and twins', () => {
        expect(layerNameKey('/models/wsp_l2_deadbeef.glb')).toBe(layerNameKey('/models/wsp_l2_c0ffee00.glb'));
        expect(layerNameKey('/models/wsp_massing_deadbeef_tex.glb')).toBe('wsp_massing|_tex.glb');
        expect(layerNameKey('/models/wsp_massing_deadbeef_tex.glb')).not.toBe(layerNameKey('/models/wsp_massing_deadbeef.glb'));
        expect(layerNameKey('/models/wsp_tiles_deadbeef.order.json')).toBe('wsp_tiles|.order.json');
        expect(layerNameKey('/models/plain.glb')).toBeUndefined();
    });
});

describe('AssetRecoveryService', () => {
    it('restores what the store has, rebuilds a lost staged run once, and explains what it cannot recover', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-a'));
        const request = { query: 'Washington Square Park', isolate: false, trees: true };
        store.putRecipe({ id: 'staged:deadbeef', kind: 'staged-location', body: { runId: 'deadbeef', request } });
        store.putFile(writeFile(glbBytes(1000)), { servedPath: '/models/wsp_l2_deadbeef.glb', origin: 'staged-location', recipeId: 'staged:deadbeef' });
        store.putFile(writeFile(glbBytes(1200)), { servedPath: '/models/wsp_l5_deadbeef.glb', origin: 'staged-location', recipeId: 'staged:deadbeef' });
        store.putFile(writeFile(glbBytes(500)), { servedPath: '/models/still_here.glb', origin: 'test' });
        store.putRecipe({ id: 'generate_image:cat', kind: 'generate_image', body: { prompt: 'a cat' } });
        store.putFile(writeFile(Buffer.from('png')), { servedPath: '/build/generated-images/cat.png', origin: 'generate_image', recipeId: 'generate_image:cat' });
        // the staged files and the image are lost from the store; still_here keeps its bytes
        for (const p of ['/models/wsp_l2_deadbeef.glb', '/models/wsp_l5_deadbeef.glb', '/build/generated-images/cat.png']) fs.rmSync(store.lookup(p)!.file);

        const calls: unknown[] = [];
        const rebuild: StagedRebuilder = async (req, ctx) => {
            calls.push(req);
            ctx.reportProgress('fitting the structure', 0.4);
            // the new run publishes the same layers under new keys, through the store as the stage cache does
            store.putFile(writeFile(glbBytes(1000, 1)), { servedPath: '/models/wsp_l2_c0ffee00.glb', origin: 'staged-location', recipeId: 'staged:c0ffee00' });
            store.putFile(writeFile(glbBytes(1300, 2)), { servedPath: '/models/wsp_l5_c0ffee00.glb', origin: 'staged-location', recipeId: 'staged:c0ffee00' });
            return { runId: 'c0ffee00', layers: [{ url: '/models/wsp_l2_c0ffee00.glb' }] };
        };
        const service = new AssetRecoveryService(store, { workspaceRoot: HOME, rebuildStaged: rebuild });
        const started = service.start(['/models/still_here.glb', '/models/wsp_l2_deadbeef.glb', '/models/wsp_l5_deadbeef.glb', '/build/generated-images/cat.png', '/models/never_seen.glb', '/models/../x.glb']);
        expect(started.status).toBe('running');
        const job = await settled(service, started.id);
        expect(job.status).toBe('done');
        expect(calls).toEqual([request]);
        const outcomes = Object.fromEntries(job.items.map(i => [i.path, i.outcome]));
        expect(outcomes).toEqual({
            '/models/still_here.glb': 'restored',
            '/models/wsp_l2_deadbeef.glb': 'rebuilt',
            '/models/wsp_l5_deadbeef.glb': 'rebuilt',
            '/build/generated-images/cat.png': 'unrecoverable',
            '/models/never_seen.glb': 'unrecoverable',
            '/models/../x.glb': 'unrecoverable'
        });
        expect(job.items.find(i => i.path === '/build/generated-images/cat.png')?.detail).toMatch(/generate_image/);
        expect(job.items.find(i => i.path === '/models/never_seen.glb')?.detail).toMatch(/never recorded/);
        expect(job.message).toBe('1 restored, 2 rebuilt, 3 not recoverable');
        // the lost names now serve the new run's bytes, and say so
        const l2 = store.lookup('/models/wsp_l2_deadbeef.glb')!;
        expect(l2.rebuilt).toBe(true);
        expect(fs.readFileSync(l2.file)).toEqual(glbBytes(1000, 1));
        expect(fs.readFileSync(store.lookup('/models/wsp_l5_deadbeef.glb')!.file)).toEqual(glbBytes(1300, 2));
        expect(store.events({ subject: '/models/wsp_l5_deadbeef.glb' })[0].kind).toBe('asset.rebuilt');
        store.close();
    });

    it('cancels a running rebuild and reports its files as failed', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-b'));
        store.putRecipe({ id: 'staged:11111111', kind: 'staged-location', body: { runId: '11111111', request: { query: 'Somewhere' } } });
        store.putFile(writeFile(glbBytes(100)), { servedPath: '/models/somewhere_l2_11111111.glb', origin: 'staged-location', recipeId: 'staged:11111111' });
        fs.rmSync(store.lookup('/models/somewhere_l2_11111111.glb')!.file);
        const rebuild: StagedRebuilder = (_req, ctx) => new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })));
        });
        const service = new AssetRecoveryService(store, { workspaceRoot: HOME, rebuildStaged: rebuild });
        const started = service.start(['/models/somewhere_l2_11111111.glb']);
        await new Promise(r => setTimeout(r, 10));
        expect(service.get(started.id)?.message).toMatch(/Rebuilding 1 file/);
        const cancelled = service.cancel(started.id)!;
        expect(cancelled.status).toBe('cancelled');
        const job = await settled(service, started.id);
        expect(job.status).toBe('cancelled');
        expect(job.items[0]).toMatchObject({ outcome: 'failed', detail: 'cancelled' });
        expect(store.lookup('/models/somewhere_l2_11111111.glb')).toBeUndefined();
        store.close();
    });

    it('reports a rebuild that published nothing for a layer, without touching the old record', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-c'));
        store.putRecipe({ id: 'staged:22222222', kind: 'staged-location', body: { runId: '22222222', request: { query: 'Elsewhere' } } });
        store.putFile(writeFile(glbBytes(100)), { servedPath: '/models/elsewhere_l4_22222222.glb', origin: 'staged-location', recipeId: 'staged:22222222' });
        fs.rmSync(store.lookup('/models/elsewhere_l4_22222222.glb')!.file);
        const rebuild: StagedRebuilder = async () => ({ runId: '33333333', layers: [{ url: '/models/elsewhere_l2_33333333.glb' }] });
        const service = new AssetRecoveryService(store, { workspaceRoot: HOME, rebuildStaged: rebuild });
        const job = await settled(service, service.start(['/models/elsewhere_l4_22222222.glb']).id);
        expect(job.items[0].outcome).toBe('failed');
        expect(job.items[0].detail).toMatch(/published no file for this layer \(elsewhere_l2_33333333.glb\)/);
        expect(store.record('/models/elsewhere_l4_22222222.glb')?.rebuilt).toBe(false);
        store.close();
    });
});
