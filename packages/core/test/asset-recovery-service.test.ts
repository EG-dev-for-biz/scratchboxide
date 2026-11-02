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
        // the same layer asked for with different words for the place (the query's slug differs)
        expect(layerNameKey('/models/washington_square_arch_new_york_iso_l3a_8001dfec.glb')).toBe(layerNameKey('/models/washington_square_arch_washington_square_iso_l3a_3d3558f0.glb'));
        expect(layerNameKey('/models/wsp_l2_tex_b5d2fd5b.glb')).toBe('l2_tex|.glb');
        expect(layerNameKey('/models/wsp_l2_tex_b5d2fd5b.glb')).not.toBe(layerNameKey('/models/wsp_l3b_tex_7c99ed91.glb'));
        expect(layerNameKey('/models/wsp_massing_deadbeef_tex.glb')).toBe('massing|_tex.glb');
        expect(layerNameKey('/models/wsp_massing_deadbeef_tex.glb')).not.toBe(layerNameKey('/models/wsp_massing_deadbeef.glb'));
        expect(layerNameKey('/models/wsp_tiles_deadbeef.order.json')).toBe('tiles|.order.json');
        // carved around a kept structure: the remesh and the tiles are different layers
        expect(layerNameKey('/models/wsa_new_york_remesh_711be145_around_5057abf7.glb')).toBe('remesh_around|.glb');
        expect(layerNameKey('/models/wsa_washington_square_remesh_7f2f9b1d_around_74562430.glb')).toBe('remesh_around|.glb');
        expect(layerNameKey('/models/wsa_washington_square_tiles_150c191d_around_74562430.glb')).toBe('tiles_around|.glb');
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
        expect(store.events({ subject: '/models/wsp_l5_deadbeef.glb' }).map(e => e.kind).slice(0, 2)).toEqual(['asset.materialized', 'asset.rebuilt']);
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

    it('rebuilds files that have no recipe from the scene\'s own place when the caller gives it', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-d'));
        const seen: unknown[] = [];
        const rebuild: StagedRebuilder = async (req) => {
            seen.push(req);
            store.putFile(writeFile(glbBytes(700, 4)), { servedPath: '/models/washington_square_iso_l3a_aaaaaaaa.glb', origin: 'staged-location', recipeId: 'staged:aaaaaaaa' });
            return { runId: 'aaaaaaaa', layers: [{ url: '/models/washington_square_iso_l3a_aaaaaaaa.glb' }] };
        };
        const service = new AssetRecoveryService(store, { workspaceRoot: HOME, rebuildStaged: rebuild });
        const request = { query: 'Washington Square Arch, New York', isolate: true, trees: true };
        // never recorded (made before the store); one path is not a staged layer name and stays unrecoverable
        const job = await settled(service, service.start(['/models/washington_square_iso_l3a_8001dfec.glb', '/models/hand_made.glb'], { fallbackStaged: { request } }).id);
        expect(seen).toEqual([request]);
        expect(job.items.map(i => i.outcome)).toEqual(['rebuilt', 'unrecoverable']);
        const rebuilt = store.lookup('/models/washington_square_iso_l3a_8001dfec.glb')!;
        expect(rebuilt.rebuilt).toBe(true);
        expect(rebuilt.recipeId).toBe('staged:aaaaaaaa');
        expect(fs.readFileSync(rebuilt.file)).toEqual(glbBytes(700, 4));
        // without the fallback the same path is simply unrecoverable
        const plain = await settled(service, service.start(['/models/other_iso_l2_bbbbbbbb.glb']).id);
        expect(plain.items[0]).toMatchObject({ outcome: 'unrecoverable' });
        expect(seen).toHaveLength(1);
        store.close();
    });

    it('restores only, rebuilding nothing, for a chat opened to look at it, and says what could rebuild each file', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-restore-only'));
        store.putRecipe({ id: 'staged:44444444', kind: 'staged-location', body: { runId: '44444444', request: { query: 'Jefferson Market Library' } } });
        store.putFile(writeFile(glbBytes(300)), { servedPath: '/models/jml_iso_l2_44444444.glb', origin: 'staged-location', recipeId: 'staged:44444444' });
        store.putFile(writeFile(glbBytes(310)), { servedPath: '/models/jml_iso_tiles_44444444.glb', origin: 'staged-location', recipeId: 'staged:44444444' });
        fs.rmSync(store.lookup('/models/jml_iso_l2_44444444.glb')!.file);
        const calls: unknown[] = [];
        const rebuild: StagedRebuilder = async req => { calls.push(req); return { runId: '55555555', layers: [] }; };
        const service = new AssetRecoveryService(store, { workspaceRoot: HOME, rebuildStaged: rebuild });
        const paths = ['/models/jml_iso_tiles_44444444.glb', '/models/jml_iso_l2_44444444.glb', '/models/jml_iso_remesh_66666666.glb'];
        // a fallback given with restoreOnly is not used either
        const job = await settled(service, service.start(paths, { restoreOnly: true, fallbackStaged: { request: { query: 'Jefferson Market Library', isolate: true } } }).id);
        expect(calls).toEqual([]);
        expect(job.items.map(i => [i.path.split('/').pop(), i.outcome])).toEqual([
            ['jml_iso_tiles_44444444.glb', 'restored'],
            ['jml_iso_l2_44444444.glb', 'unrecoverable'],
            ['jml_iso_remesh_66666666.glb', 'unrecoverable']
        ]);
        expect(job.items[1].detail).toBe('not in the asset store; its recorded run staged:44444444 can build it again (Rebuild this location)');
        expect(job.items[2].detail).toMatch(/never recorded/);
        // the same files without restoreOnly: the recorded run is re-run once
        await settled(service, service.start(paths).id);
        expect(calls).toHaveLength(1);
        store.close();
    });

    it('splits a fallback into the isolated structure and its district, and takes twins an earlier run published at the same place', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-e'));
        const place = { lat: 40.73122, lng: -73.99709, formattedAddress: 'Washington Square Arch, New York' };
        // an earlier rebuild at the same place: its background texture pass published the l3b twin after it ended
        store.putRecipe({ id: 'staged:0f5545a7', kind: 'staged-location', body: { runId: '0f5545a7', request: { query: 'Washington Square Arch', isolate: true, trees: true }, place } });
        store.putFile(writeFile(glbBytes(300, 5)), { servedPath: '/models/wsa_washington_square_iso_l3b_tex_7c99ed91.glb', origin: 'staged-location', recipeId: 'staged:0f5545a7' });
        // a run somewhere else with the same layer name must never be taken
        store.putRecipe({ id: 'staged:99999999', kind: 'staged-location', body: { runId: '99999999', request: { query: 'Shibuya', isolate: true, trees: true }, place: { lat: 35.6595, lng: 139.7005, formattedAddress: 'Shibuya' } } });
        store.putFile(writeFile(glbBytes(300, 6)), { servedPath: '/models/shibuya_iso_l4_tex_11111111.glb', origin: 'staged-location', recipeId: 'staged:99999999' });

        const runs: Array<{ isolate: boolean }> = [];
        const rebuild: StagedRebuilder = async (req) => {
            const r = req as { isolate: boolean };
            runs.push({ isolate: r.isolate });
            if (r.isolate) {
                store.putFile(writeFile(glbBytes(500, 7)), { servedPath: '/models/wsa_washington_square_iso_l3b_cccccccc.glb', origin: 'staged-location', recipeId: 'staged:cccccccc' });
                return { runId: 'cccccccc', layers: [{ url: '/models/wsa_washington_square_iso_l3b_cccccccc.glb' }] };
            }
            store.putFile(writeFile(glbBytes(900, 8)), { servedPath: '/models/wsa_washington_square_trees_dddddddd.glb', origin: 'staged-location', recipeId: 'staged:dddddddd' });
            return { runId: 'dddddddd', layers: [{ url: '/models/wsa_washington_square_trees_dddddddd.glb' }] };
        };
        const service = new AssetRecoveryService(store, { workspaceRoot: HOME, rebuildStaged: rebuild });
        const request = { query: 'Washington Square Arch, Washington Square N, New York', isolate: true, trees: true, place };
        const job = await settled(service, service.start([
            '/models/wsa_new_york_iso_l3b_8001dfec.glb', '/models/wsa_new_york_iso_l3b_tex_4bf1832d.glb',
            '/models/wsa_new_york_iso_l4_tex_7af8a944.glb', '/models/wsa_washington_square_trees_df7ce2bb.glb'
        ], { fallbackStaged: { request } }).id);
        expect(runs).toEqual([{ isolate: true }, { isolate: false }]);
        expect(job.items.map(i => [i.path.split('/').pop(), i.outcome])).toEqual([
            ['wsa_new_york_iso_l3b_8001dfec.glb', 'rebuilt'],
            ['wsa_new_york_iso_l3b_tex_4bf1832d.glb', 'rebuilt'],
            ['wsa_new_york_iso_l4_tex_7af8a944.glb', 'failed'],
            ['wsa_washington_square_trees_df7ce2bb.glb', 'rebuilt']
        ]);
        expect(fs.readFileSync(store.lookup('/models/wsa_new_york_iso_l3b_tex_4bf1832d.glb')!.file)).toEqual(glbBytes(300, 5));
        expect(fs.readFileSync(store.lookup('/models/wsa_washington_square_trees_df7ce2bb.glb')!.file)).toEqual(glbBytes(900, 8));
        store.close();
    });

    it('stages the district rebuild into the given scene and writes recovered files back to public/models', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-f'));
        const workspace = path.join(HOME, 'checkout-f');
        fs.mkdirSync(workspace, { recursive: true });
        store.putFile(writeFile(glbBytes(200, 1)), { servedPath: '/models/wsa_new_york_iso_l3b_8001dfec.glb', origin: 'test' });
        // a kept structure file recovered by an earlier job: on disk again before the district is staged into the scene
        store.putFile(writeFile(glbBytes(250, 3)), { servedPath: '/models/wsa_new_york_iso_l3c_8001dfec.glb', origin: 'test' });
        const seen: Array<Record<string, unknown>> = [];
        const rebuild: StagedRebuilder = async (req, ctx) => {
            seen.push({ ...(req as Record<string, unknown>), scene: ctx.activeArtifact?.id, keptOnDisk: fs.existsSync(path.join(workspace, 'public', 'models', 'wsa_new_york_iso_l3c_8001dfec.glb')) });
            store.putFile(writeFile(glbBytes(400, 2)), { servedPath: '/models/wsa_washington_square_remesh_eeeeeeee_around_5057abf7.glb', origin: 'staged-location', recipeId: 'staged:eeeeeeee' });
            return { runId: 'eeeeeeee', layers: [{ url: '/models/wsa_washington_square_remesh_eeeeeeee_around_5057abf7.glb' }] };
        };
        const service = new AssetRecoveryService(store, { workspaceRoot: workspace, rebuildStaged: rebuild });
        const job = await settled(service, service.start(
            ['/models/wsa_new_york_iso_l3b_8001dfec.glb', '/models/wsa_washington_square_remesh_711be145_around_5057abf7.glb'],
            { fallbackStaged: { request: { query: 'Washington Square Arch', isolate: true, trees: true } }, activeArtifact: { id: 'scene-stg-8001dfec', type: '3d-scene', data: { objects: [{ id: 'kept', content: { durableUri: '/models/wsa_new_york_iso_l3c_8001dfec.glb' } }] } } }
        ).id);
        expect(job.items.map(i => i.outcome)).toEqual(['restored', 'rebuilt']);
        // the district run, staged into the scene; the isolated run is not asked for (no _iso file was lost)
        expect(seen).toEqual([{ query: 'Washington Square Arch', isolate: false, trees: true, stageIntoActiveScene: true, scene: 'scene-stg-8001dfec', keptOnDisk: true }]);
        // both files are on disk where the staged build reads kept structure files from
        expect(fs.readFileSync(path.join(workspace, 'public', 'models', 'wsa_new_york_iso_l3b_8001dfec.glb'))).toEqual(glbBytes(200, 1));
        expect(fs.readFileSync(path.join(workspace, 'public', 'models', 'wsa_washington_square_remesh_711be145_around_5057abf7.glb'))).toEqual(glbBytes(400, 2));
        expect(store.events({ subject: '/models/wsa_new_york_iso_l3b_8001dfec.glb' })[0].kind).toBe('asset.materialized');
        store.close();
    });

    it('re-points a path that an earlier rebuild matched to the wrong layer when an explicit rebuild finds the right one', async () => {
        const store = new DurableAssetStore(path.join(HOME, 'home-g'));
        store.putFile(writeFile(glbBytes(100, 1)), { servedPath: '/models/wsa_sq_tiles_aaaaaaaa_around_bbbbbbbb.glb', origin: 'staged-location', recipeId: 'staged:aaaaaaaa' });
        store.putFile(writeFile(glbBytes(200, 2)), { servedPath: '/models/wsa_sq_remesh_aaaaaaaa_around_bbbbbbbb.glb', origin: 'staged-location', recipeId: 'staged:aaaaaaaa' });
        // the earlier (wrong) match: the lost remesh carve points at the tiles carve, then a sweep of the written-back
        // copy made before the sweep kept records re-recorded it as a backfill that inherited the run's recipe
        store.alias('/models/wsa_ny_remesh_11111111_around_22222222.glb', '/models/wsa_sq_tiles_aaaaaaaa_around_bbbbbbbb.glb', { origin: 'recovery', rebuilt: true });
        store.putFile(store.lookup('/models/wsa_ny_remesh_11111111_around_22222222.glb')!.file, { servedPath: '/models/wsa_ny_remesh_11111111_around_22222222.glb', origin: 'backfill' });
        expect(store.lookup('/models/wsa_ny_remesh_11111111_around_22222222.glb')).toMatchObject({ rebuilt: false, origin: 'backfill', recipeId: 'staged:aaaaaaaa' });
        const rebuild: StagedRebuilder = async () => ({ runId: 'aaaaaaaa', layers: [] });
        const service = new AssetRecoveryService(store, { workspaceRoot: path.join(HOME, 'checkout-g'), rebuildStaged: rebuild });
        const lost = '/models/wsa_ny_remesh_11111111_around_22222222.glb';
        // automatic recovery leaves a present file alone
        const auto = await settled(service, service.start([lost]).id);
        expect(auto.items[0].outcome).toBe('restored');
        // an explicit rebuild re-matches it
        const job = await settled(service, service.start([lost], { fallbackStaged: { request: { query: 'WSA', isolate: false, trees: true } } }).id);
        expect(job.items[0]).toMatchObject({ outcome: 'rebuilt', detail: 'rebuilt by run aaaaaaaa as wsa_sq_remesh_aaaaaaaa_around_bbbbbbbb.glb' });
        expect(fs.readFileSync(store.lookup(lost)!.file)).toEqual(glbBytes(200, 2));
        // and a second explicit rebuild finds nothing better to do
        const again = await settled(service, service.start([lost], { fallbackStaged: { request: { query: 'WSA', isolate: false, trees: true } } }).id);
        expect(again.items[0]).toMatchObject({ outcome: 'restored', detail: 'already rebuilt as wsa_sq_remesh_aaaaaaaa_around_bbbbbbbb.glb' });
        store.close();
    });
});
