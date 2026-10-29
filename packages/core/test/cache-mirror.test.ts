/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { cacheMirrorBucket, cacheMirrorRoots, syncCacheDir } from '../src/node/cloud-store/cache-mirror';
import type { CloudBucket, CloudObject, PutFileOptions } from '../src/node/cloud-store/cloud-bucket';

/** A bucket in memory: what was written, with its bytes and metadata. */
class MemoryBucket implements CloudBucket {
    readonly label = 'mem://training';
    readonly objects = new Map<string, { bytes: Buffer; opts?: PutFileOptions }>();
    puts = 0;
    failOn?: string;
    async putFile(key: string, file: string, opts?: PutFileOptions): Promise<'stored' | 'exists'> {
        this.puts++;
        if (this.failOn && key.endsWith(this.failOn)) throw new Error('network down');
        this.objects.set(key, { bytes: fs.readFileSync(file), ...(opts ? { opts } : {}) });
        return 'stored';
    }
    async download(): Promise<boolean> { return false; }
    async list(prefix: string): Promise<CloudObject[]> { return [...this.objects.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, bytes: 0, updatedMs: 0, metadata: {} })); }
    async remove(key: string): Promise<void> { this.objects.delete(key); }
}

const write = (file: string, text: string, ageMs = 3_600_000) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
};

describe('the build caches mirrored to the training bucket', () => {
    it('sends each settled file once, again only when it changes, and leaves temp, hidden and fresh files for later', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-mirror-'));
        const [staged] = cacheMirrorRoots(ws);
        expect(staged.prefix).toBe('cache/v1/staged_location');
        const key = 'a'.repeat(64);
        write(path.join(staged.dir, 'remesh', key, 'done.json'), '{"value":1}');
        write(path.join(staged.dir, 'remesh', key, 'clay.glb'), 'glb-bytes');
        write(path.join(staged.dir, 'runs', 'c527da43', 'timeline.jsonl'), '{"stage":"tiles"}\n');
        // still being written: a temp entry dir, a hidden file, a file changed seconds ago
        write(path.join(staged.dir, 'remesh', `${key}.tmp-123`, 'clay.glb'), 'half');
        write(path.join(staged.dir, 'remesh', key, '.lock'), 'x');
        write(path.join(staged.dir, 'runs', 'c527da43', 'stages.json'), '{}', 1_000);
        const bucket = new MemoryBucket();
        const r1 = await syncCacheDir(bucket, staged.dir, staged.prefix);
        expect(r1.uploaded).toBe(3);
        expect(r1.waiting).toBe(1);
        expect([...bucket.objects.keys()].sort()).toEqual([
            `cache/v1/staged_location/remesh/${key}/clay.glb`,
            `cache/v1/staged_location/remesh/${key}/done.json`,
            'cache/v1/staged_location/runs/c527da43/timeline.jsonl'
        ]);
        expect(bucket.objects.get(`cache/v1/staged_location/remesh/${key}/clay.glb`)!.bytes.toString()).toBe('glb-bytes');
        expect(bucket.objects.get(`cache/v1/staged_location/remesh/${key}/done.json`)!.opts?.contentType).toBe('application/json');
        // nothing changed: nothing sent
        const puts = bucket.puts;
        const r2 = await syncCacheDir(bucket, staged.dir, staged.prefix);
        expect(r2.uploaded).toBe(0);
        expect(bucket.puts).toBe(puts);
        // a run note rewritten and a native-style sub-folder added after done.json: just those go
        write(path.join(staged.dir, 'runs', 'c527da43', 'timeline.jsonl'), '{"stage":"tiles"}\n{"stage":"finish"}\n');
        write(path.join(staged.dir, 'remesh', key, 'polish', 'k.json'), '{}');
        const r3 = await syncCacheDir(bucket, staged.dir, staged.prefix);
        expect(r3.uploaded).toBe(2);
        expect(bucket.objects.get('cache/v1/staged_location/runs/c527da43/timeline.jsonl')!.bytes.toString()).toContain('finish');
        // the file that settled since goes next time
        const later = await syncCacheDir(bucket, staged.dir, staged.prefix, { settleMs: 60_000, concurrency: 2, saveEvery: 25 }, () => Date.now() + 120_000);
        expect(later.uploaded).toBe(1);
        expect(bucket.objects.has('cache/v1/staged_location/runs/c527da43/stages.json')).toBe(true);
    });

    it('tries a file that failed again on the next sync, and starts over for another bucket', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-mirror-'));
        const [staged] = cacheMirrorRoots(ws);
        write(path.join(staged.dir, 'vector', 'b'.repeat(64), 'done.json'), '{}');
        write(path.join(staged.dir, 'vector', 'b'.repeat(64), 'vector_massing.glb'), 'm');
        const bucket = new MemoryBucket();
        bucket.failOn = 'vector_massing.glb';
        const r1 = await syncCacheDir(bucket, staged.dir, staged.prefix);
        expect(r1.uploaded).toBe(1);
        expect(r1.failed).toBe(1);
        expect(r1.errors[0]).toMatch(/network down/);
        bucket.failOn = undefined;
        const r2 = await syncCacheDir(bucket, staged.dir, staged.prefix);
        expect(r2.uploaded).toBe(1);
        // the manifest is per bucket: a different bucket gets everything
        const other = new MemoryBucket();
        Object.defineProperty(other, 'label', { value: 'mem://other' });
        expect((await syncCacheDir(other, staged.dir, staged.prefix)).uploaded).toBe(2);
    });

    it('is off without a training bucket and with SCRATCHBOX_CACHE_MIRROR=off', () => {
        const saved = { t: process.env.SCRATCHBOX_TRAINING_BUCKET, m: process.env.SCRATCHBOX_CACHE_MIRROR, h: process.env.SCRATCHBOX_HOME };
        try {
            process.env.SCRATCHBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-mirror-home-'));
            delete process.env.SCRATCHBOX_TRAINING_BUCKET;
            expect(cacheMirrorBucket()).toBeUndefined();
            process.env.SCRATCHBOX_TRAINING_BUCKET = 'off';
            expect(cacheMirrorBucket()).toBeUndefined();
            process.env.SCRATCHBOX_TRAINING_BUCKET = 'some-bucket';
            process.env.SCRATCHBOX_CACHE_MIRROR = 'off';
            expect(cacheMirrorBucket()).toBeUndefined();
        } finally {
            for (const [k, v] of [['SCRATCHBOX_TRAINING_BUCKET', saved.t], ['SCRATCHBOX_CACHE_MIRROR', saved.m], ['SCRATCHBOX_HOME', saved.h]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    });
});
