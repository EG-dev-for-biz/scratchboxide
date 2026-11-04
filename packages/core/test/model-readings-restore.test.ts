/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The vision model's answers read back from the cache mirror's bucket (pipeline-k/model-readings.ts fileReadingStore's
 * `restore`, cache-mirror.ts restoreCacheFile, stage-cache.ts restoreFile), against a directory bucket and stand-in models
 * (no call leaves the process): a record this workspace lacks is read back once and given to every ask of it, one the
 * bucket lacks is asked of the model; a file read back is not sent back by the next sync; and an empty workspace, as a
 * Cloud Run chunk starts, answers the facade reader and the material choice from what another machine kept.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import { CACHE_MIRROR_PARAMS, restoreCacheFile, syncCacheDir } from '../src/node/cloud-store/cache-mirror';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { fileReadingStore, MODEL_READINGS_DIR, planePixelsKey, readingKey } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { FACADE_READER_PARAMS, readFacade, type FacadeAsk, type FacadePhoto } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { chooseWithMemory, type ChoiceRow, type SetChoice } from '../src/node/3d-engine/staged-location/pipeline-k/material-choice';

const SEND = { ...CACHE_MIRROR_PARAMS, settleMs: 0 };

/** A workspace and the bucket's mirror prefix of its staged-location cache. */
function workspace(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `readings-${tag}-`));
}

/** The workspace's stage cache, its single files read back from `bucket` (as staged-location-tool.ts wires it). */
function cacheOf(root: string, bucket?: DirectoryCloudBucket): StageCache {
    return new StageCache({ workspaceRoot: root, ...(bucket ? { restoreFile: (rel: string) => restoreCacheFile(bucket, root, `staged_location/${rel}`) } : {}) });
}

/** The run's store, as the orchestrator makes it. */
const storeOf = (cache: StageCache) => fileReadingStore(path.join(cache.dir, MODEL_READINGS_DIR), { restore: rel => cache.restoreFile(`${MODEL_READINGS_DIR}/${rel}`) });

const syncUp = (bucket: DirectoryCloudBucket, cache: StageCache) => syncCacheDir(bucket, cache.dir, 'cache/v1/staged_location', SEND);

/** A wall of window rows, 0.1 m a pixel. */
function wall(): FacadePhoto {
    const width = 120, height = 160, rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const win = x % 30 >= 8 && x % 30 < 22 && y % 40 >= 10 && y % 40 < 28;
        rgba.set(win ? [60, 62, 70, 255] : [190, 180, 165, 255], (y * width + x) * 4);
    }
    return { rgba, width, height };
}
const frame = { facadeId: 3, image: 'f3.png', coverage: 1, width: 120, height: 160, pixel: 0.1, orthoSMin: 0, orthoTMax: 16, texel: 0.1 };

/** A stand-in reader model: the plane fits one read crop and the reading finds no openings, so it takes one question. */
function reader(): { ask: FacadeAsk; calls: string[] } {
    const calls: string[] = [];
    const ask: FacadeAsk = async (_png, _prompt, kind) => {
        calls.push(kind);
        if (kind === 'read') return JSON.stringify({ rows: [], conf: 90 });
        throw new Error(`the stand-in was asked ${kind}`);
    };
    return { ask, calls };
}

const cands = (ids: string[]) => ids.map(id => ({ id, realSizeM: [1, 1] as [number, number], preview: { width: 2, height: 2, rgba: new Uint8Array(16).fill(128) } }));
const rows: ChoiceRow[] = [{ meanLinear: [0.4, 0.38, 0.35], candidates: cands(['stone1', 'stone2']) }, { meanLinear: [0.05, 0.05, 0.06], candidates: cands(['dark1', 'dark2']) }];
const swatches = { png: Buffer.alloc(0), spanM: 1.5 };
function chooser(): { ask: (rs: ChoiceRow[]) => Promise<Array<SetChoice | undefined>>; asked: number[] } {
    const asked: number[] = [];
    return { ask: async rs => { asked.push(rs.length); return rs.map(() => ({ pick: 1, conf: 80 })); }, asked };
}

describe("the vision model's answers read back from the cache mirror", () => {
    it('reads a record back once a key, shares the read between asks, asks the model when the bucket lacks it, and counts a failed read as a miss', async () => {
        const dir = workspace('store');
        try {
            const local = path.join(dir, 'readings'), elsewhere = new Map<string, string>();
            const hit = readingKey('facade-reading', ['kept']), none = readingKey('facade-reading', ['never']), broken = readingKey('facade-reading', ['broken']);
            elsewhere.set(hit, JSON.stringify({ text: 'from the bucket' }));
            const asked: string[] = [];
            const restore = async (rel: string) => {
                asked.push(rel);
                await new Promise(r => setTimeout(r, 5));
                const key = `${rel.split('/')[0]}/${path.basename(rel, '.json')}`;
                if (key === broken) throw new Error('the bucket did not answer');
                const v = elsewhere.get(key);
                if (v === undefined) return false;
                fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
                fs.writeFileSync(path.join(local, rel), v);
                return true;
            };
            const store = fileReadingStore(local, { restore });
            // two asks at once: one read of the bucket, both answered
            const [a, b] = await Promise.all([store.get<{ text: string }>(hit), store.get<{ text: string }>(hit)]);
            expect(a).toEqual({ text: 'from the bucket' });
            expect(b).toEqual(a);
            expect(asked).toEqual([`facade-reading/${hit.slice(15, 17)}/${hit.slice(15)}.json`]);
            // now here: answered at once, no promise
            expect(store.get<{ text: string }>(hit)).toEqual({ text: 'from the bucket' });
            // the bucket lacks one: a miss, not looked for again until it is written
            expect(await store.get(none)).toBeUndefined();
            expect(store.get(none)).toBeUndefined();
            expect(asked.length).toBe(2);
            store.put(none, { text: 'asked' });
            expect(store.get(none)).toEqual({ text: 'asked' });
            // a read that fails is a miss, never a throw
            expect(await store.get(broken)).toBeUndefined();
            expect(store.report()).toMatchObject({ kept: 2, restored: 2, missed: 3, written: 1, restoreFailed: 1, restoreError: 'the bucket did not answer' });
            // without `restore` (SCRATCHBOX_CACHE_RESTORE=off) the store is this workspace's files only
            const plain = fileReadingStore(path.join(dir, 'plain'));
            expect(plain.get(hit)).toBeUndefined();
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('does not send a file read back from the bucket back to it; a file written here is sent', async () => {
        const a = workspace('a'), b = workspace('b'), bucketDir = workspace('bucket');
        try {
            const bucket = new DirectoryCloudBucket(bucketDir);
            const ca = cacheOf(a), key = readingKey('material-choice', ['x']);
            storeOf(ca).put(key, { classes: [] });
            expect((await syncUp(bucket, ca)).uploaded).toBe(1);
            const cb = cacheOf(b, bucket), sb = storeOf(cb);
            expect(await sb.get(key)).toEqual({ classes: [] });
            sb.put(readingKey('material-choice', ['y']), { classes: [] });
            const rep = await syncUp(bucket, cb);
            expect(rep).toMatchObject({ uploaded: 1, unchanged: 1, failed: 0 });
            // the list of files read back is folded into the manifest and gone
            expect(fs.readdirSync(cb.dir).filter(n => n.startsWith('.cloud-mirror-restored'))).toEqual([]);
            expect((await syncUp(bucket, cb)).uploaded).toBe(0);
            // a file that is not a cache file is never read back
            expect(await restoreCacheFile(bucket, b, 'elsewhere/x.json')).toBe(false);
            expect(await restoreCacheFile(bucket, b, 'staged_location/../x.json')).toBe(false);
        } finally { for (const d of [a, b, bucketDir]) fs.rmSync(d, { recursive: true, force: true }); }
    });

    it('answers the facade reader and the material choice in an empty workspace (a Cloud Run chunk) from what another machine kept', async () => {
        const laptop = workspace('laptop'), chunk = workspace('chunk'), off = workspace('off'), bucketDir = workspace('bucket');
        try {
            const bucket = new DirectoryCloudBucket(bucketDir), img = wall();
            const read = async (cache: StageCache, restoreOn: boolean) => {
                const store = restoreOn ? storeOf(cache) : fileReadingStore(path.join(cache.dir, MODEL_READINGS_DIR));
                const r = reader(), c = chooser();
                const out = await readFacade(img, undefined, frame, r.ask, FACADE_READER_PARAMS, undefined, undefined, '', { store, model: 'stand-in', plane: planePixelsKey(img) });
                const chose = await chooseWithMemory(rows, swatches, c.ask, { store, model: 'stand-in' });
                return { record: out.record, readerCalls: r.calls.length, choice: chose, choiceCalls: c.asked.length, report: store.report() };
            };
            // the laptop asks, and its caches go to the bucket
            const first = await read(cacheOf(laptop), true);
            expect(first.record).toMatchObject({ calls: 1, zones: [{ why: 'the model saw no openings in the zone' }] });
            expect(first).toMatchObject({ readerCalls: 1, choiceCalls: 1 });
            expect((await syncUp(bucket, cacheOf(laptop))).uploaded).toBe(3);
            // the chunk starts on an empty disk: every answer read back, the model not asked
            const cloud = await read(cacheOf(chunk, bucket), true);
            expect(cloud.readerCalls).toBe(0);
            expect(cloud.choiceCalls).toBe(0);
            expect(cloud.record).toMatchObject({ outcome: first.record.outcome, calls: 0, reused: 1 });
            expect(cloud.choice).toMatchObject({ calls: 0, reused: 2 });
            expect(cloud.report).toMatchObject({ restored: 3, missed: 0, written: 0 });
            // and sends none of them back
            expect((await syncUp(bucket, cacheOf(chunk, bucket))).uploaded).toBe(0);
            // with the restore off, the empty disk asks again (the gap this closes)
            const fresh = await read(cacheOf(off, bucket), false);
            expect(fresh).toMatchObject({ readerCalls: 1, choiceCalls: 1 });
        } finally { for (const d of [laptop, chunk, off, bucketDir]) fs.rmSync(d, { recursive: true, force: true }); }
    });
});
