/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district model pool (gemini/model-call-pool.ts) over a real HTTP server on this machine, and the prepared texture
 * library (prepared-library.ts) over a directory bucket. Nothing reaches the cloud or a model.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ModelCallPool, modelPoolFromEnv, modelPoolHandler, modelPoolLimitsFromEnv, PoolCallBudget } from '../src/node/gemini/model-call-pool';
import { bucketPreparedLibrary, preparedLibrary, preparedMapsKey } from '../src/node/3d-engine/prepared-library';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-model-pool-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function serve(pool: ModelCallPool, pollMs = 200): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(modelPoolHandler(pool, pollMs));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

describe('the district model pool', () => {
    it('reads its limits and the pool a process takes its turns from', () => {
        const l = modelPoolLimitsFromEnv({ SCRATCHBOX_MODEL_POOL_LIMITS: '*=96/, gemini-3-pro-image=8/60' });
        expect(l.all).toEqual({ inFlight: 96 });
        expect(l.byModel.get('gemini-3-pro-image')).toEqual({ inFlight: 8, perMinute: 60 });
        expect(() => modelPoolLimitsFromEnv({ SCRATCHBOX_MODEL_POOL_LIMITS: 'nonsense' })).toThrow(/model=inFlight\/perMinute/);
        expect(modelPoolFromEnv({ SCRATCHBOX_MODEL_POOL_URL: 'https://kd-model-pool-x.a.run.app/', SCRATCHBOX_MODEL_POOL_DISTRICT: 'c527da43' })).toEqual({ url: 'https://kd-model-pool-x.a.run.app', district: 'c527da43' });
        expect(modelPoolFromEnv({ SCRATCHBOX_MODEL_POOL_URL: 'https://x' })).toBeUndefined();
        expect(modelPoolFromEnv({ SCRATCHBOX_MODEL_POOL_DISTRICT: 'c527da43' })).toBeUndefined();
    });

    it("keeps every task of a district to its one in-flight limit, across clients, and counts what it granted", async () => {
        const pool = new ModelCallPool({ all: { inFlight: 2 }, byModel: new Map() });
        const s = await serve(pool);
        try {
            // two tasks of one district, each asking for three turns at once
            const a = new PoolCallBudget(s.url, 'c527da43'), b = new PoolCallBudget(s.url, 'c527da43');
            let held = 0, most = 0;
            const call = async (budget: PoolCallBudget) => {
                const release = await budget.acquire('gemini-3.8-flash');
                held++; most = Math.max(most, held);
                await new Promise(r => setTimeout(r, 30));
                held--;
                release();
            };
            await Promise.all([...[1, 2, 3].map(() => call(a)), ...[1, 2, 3].map(() => call(b))]);
            expect(most).toBe(2);
            await new Promise(r => setTimeout(r, 50));
            expect(pool.stats('c527da43')).toMatchObject({ granted: { 'gemini-3.8-flash': 6 }, refused: 0, waiting: 0, held: 0 });
            // another district is a lane of its own
            expect(pool.stats('feedbeef').granted).toEqual({});
        } finally { await s.close(); }
    });

    it('answers a waiting turn "ask again" after its poll and grants it once a turn is free; past the cap a call fails with the reason', async () => {
        const pool = new ModelCallPool({ all: { inFlight: 1 }, byModel: new Map() }, 3);
        const s = await serve(pool, 100);
        try {
            const budget = new PoolCallBudget(s.url, 'c527da43');
            const first = await budget.acquire('m');
            // the second waits through several polls (each answered 202), then gets the turn the first gives back
            let second: (() => void) | undefined;
            const waiting = budget.acquire('m').then(r => { second = r; });
            await new Promise(r => setTimeout(r, 350));
            expect(second).toBeUndefined();
            first();
            await waiting;
            expect(second).toBeTypeOf('function');
            second!();
            await new Promise(r => setTimeout(r, 30));
            const third = await budget.acquire('m');
            third();
            await new Promise(r => setTimeout(r, 30));
            // three granted: the fourth is past the district's cap
            await expect(budget.acquire('m')).rejects.toThrow(/budget for c527da43 is spent \(3 calls\)/);
            expect(pool.stats('c527da43')).toMatchObject({ granted: { m: 3 }, refused: 1 });
        } finally { await s.close(); }
    });

    it('gives back a ticket only once, and a pool that cannot be reached fails the call', async () => {
        const pool = new ModelCallPool({ all: { inFlight: 1 }, byModel: new Map() });
        const t = await pool.turn('d', 'm');
        expect(pool.release(t)).toBe(true);
        expect(pool.release(t)).toBe(false);
        let clock = 0;
        const dead = new PoolCallBudget('http://127.0.0.1:9', 'd', async () => ({}), (async () => { throw new Error('ECONNREFUSED'); }) as never, () => (clock += 200_000));
        await expect(dead.acquire('m')).rejects.toThrow(/did not answer \(ECONNREFUSED\)/);
    });
});

describe('the prepared texture library', () => {
    it('keeps a set\'s prepared maps and previews by key, written once, read back as they were', async () => {
        const dir = fs.mkdtempSync(path.join(TMP, 'lib-'));
        const lib = bucketPreparedLibrary(new DirectoryCloudBucket(dir), 'library-prepared');
        expect(await lib.getMaps('library-prepared/1', 256, 'Bricks076C')).toBeUndefined();
        const rec = { normal: Buffer.from('normal-png').toString('base64'), orm: Buffer.from('orm-png').toString('base64') };
        await lib.putMaps('library-prepared/1', 256, 'Bricks076C', rec);
        expect(await lib.getMaps('library-prepared/1', 256, 'Bricks076C')).toEqual(rec);
        // an object there is kept: a second write never replaces it
        await lib.putMaps('library-prepared/1', 256, 'Bricks076C', { normal: 'eA==', orm: 'eA==' });
        expect(await lib.getMaps('library-prepared/1', 256, 'Bricks076C')).toEqual(rec);
        expect(fs.existsSync(path.join(dir, 'library-prepared', 'maps', 'library-prepared_1', '256', 'Bricks076C.json'))).toBe(true);
        const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
        await lib.putPreview('color', 'Bricks076C', jpeg);
        expect(await lib.getPreview('color', 'Bricks076C')).toEqual(jpeg);
        expect(await lib.getPreview('height', 'Bricks076C')).toBeUndefined();
        expect(() => preparedMapsKey('p', 'v', 256, '../escape')).toThrow(/not a library set id/);
    });

    it('is off under a test runner unless the environment names one, and off when asked', () => {
        expect(preparedLibrary({ VITEST: 'true' })).toBeUndefined();
        expect(preparedLibrary({ SCRATCHBOX_PREPARED_LIBRARY: 'off' })).toBeUndefined();
    });
});
