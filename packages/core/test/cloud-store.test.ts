/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryCloudBucket, resolveCloudStoreBucketName } from '../src/node/cloud-store/cloud-bucket';
import { AssetCloudMirror } from '../src/node/cloud-store/asset-cloud-mirror';
import { snapshotAssetDbIfDue } from '../src/node/cloud-store/asset-db-snapshot';
import { ChatSessionStore } from '../src/node/chat-session-store';
import { DurableAssetStore, sha256OfFile } from '../src/node/asset-store/durable-asset-store';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cloud-store-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function fresh(name: string): string {
    const dir = path.join(TMP, `${name}-${n++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sessionFiles(workspace: string): string[] {
    const dir = path.join(workspace, '.scratchbox', 'sessions');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
}

describe('chat sessions in the cloud bucket', () => {
    it('uploads on save and brings the chat to a machine that never had it', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const workspace = fresh('ws');
        const a = new ChatSessionStore(fresh('home'), bucket);
        await a.save(workspace, { id: 'chat-1', title: 'Plaza', messages: [{ role: 'user', text: 'hello' }] });

        const objects = await bucket.list('sessions/');
        expect(objects).toHaveLength(1);
        expect(objects[0].key).toMatch(/^sessions\/[0-9a-f]{16}\/chat-1\.json$/);
        expect(Number(objects[0].metadata.savedAt)).toBeGreaterThan(0);

        // same workspace path, empty local copy (a wiped checkout): the list restores it from the bucket
        fs.rmSync(path.join(workspace, '.scratchbox'), { recursive: true });
        const b = new ChatSessionStore(fresh('home'), bucket);
        const listed = await b.list(workspace);
        expect(listed.map(s => s.id)).toEqual(['chat-1']);
        expect(listed[0].messages).toEqual([{ role: 'user', text: 'hello' }]);
        expect(sessionFiles(workspace)).toEqual(['chat-1.json']);
    });

    it('keeps the newer side: bucket-newer is downloaded, machine-newer is uploaded', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const workspace = fresh('ws');
        const store = new ChatSessionStore(fresh('home'), bucket);
        await store.save(workspace, { id: 'chat-2', title: 'v1' });

        // the bucket gets a newer version written elsewhere
        const newer = path.join(fresh('src'), 'chat-2.json');
        fs.writeFileSync(newer, JSON.stringify({ id: 'chat-2', title: 'v2', savedAt: Date.now() + 60_000 }));
        const [obj] = await bucket.list('sessions/');
        await bucket.putFile(obj.key, newer, { metadata: { savedAt: String(Date.now() + 60_000) } });
        expect((await store.list(workspace))[0].title).toBe('v2');

        // this machine then has a newer one the bucket lacks (an upload that failed earlier)
        const local = path.join(workspace, '.scratchbox', 'sessions', 'chat-2.json');
        fs.writeFileSync(local, JSON.stringify({ id: 'chat-2', title: 'v3', savedAt: Date.now() + 120_000 }));
        await store.list(workspace);
        const pulled = path.join(fresh('check'), 'x.json');
        expect(await bucket.download(obj.key, pulled)).toBe(true);
        expect(JSON.parse(fs.readFileSync(pulled, 'utf8')).title).toBe('v3');
    });

    it('removes a chat from both copies, so it does not come back', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const workspace = fresh('ws');
        const store = new ChatSessionStore(fresh('home'), bucket);
        await store.save(workspace, { id: 'keep' });
        await store.save(workspace, { id: 'drop' });
        await store.remove(workspace, 'drop');
        expect((await bucket.list('sessions/')).map(o => path.basename(o.key))).toEqual(['keep.json']);
        expect((await store.list(workspace)).map(s => s.id)).toEqual(['keep']);
    });

    it('keeps chats of different workspaces apart', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const store = new ChatSessionStore(fresh('home'), bucket);
        const ws1 = fresh('ws');
        const ws2 = fresh('ws');
        await store.save(ws1, { id: 'one' });
        await store.save(ws2, { id: 'two' });
        expect((await store.list(ws1)).map(s => s.id)).toEqual(['one']);
        expect((await store.list(ws2)).map(s => s.id)).toEqual(['two']);
    });
});

describe('asset bytes in the cloud bucket', () => {
    function storeWithFile(bytes: Buffer): { store: DurableAssetStore; sha256: string; servedPath: string } {
        const store = new DurableAssetStore(fresh('home'));
        const file = path.join(fresh('src'), 'tower.glb');
        fs.writeFileSync(file, bytes);
        const servedPath = '/models/tower.glb';
        const stored = store.putFile(file, { servedPath, origin: 'test' });
        return { store, sha256: stored.sha256, servedPath };
    }

    it('uploads a newly stored file once, under its hash', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const store = new DurableAssetStore(fresh('home'));
        const mirror = new AssetCloudMirror(store, bucket);
        mirror.attach();
        const file = path.join(fresh('src'), 'a.glb');
        fs.writeFileSync(file, Buffer.from('glTF\u0002\u0000\u0000\u0000payload-a'));
        const { sha256 } = store.putFile(file, { servedPath: '/models/a.glb', origin: 'test' });
        store.putFile(file, { servedPath: '/models/a-copy.glb', origin: 'test' }); // same bytes: no second upload
        await mirror.idle();

        const objects = await bucket.list('blobs/');
        expect(objects.map(o => o.key)).toEqual([`blobs/${sha256.slice(0, 2)}/${sha256}`]);
        const pulled = path.join(fresh('check'), 'blob');
        await bucket.download(objects[0].key, pulled);
        expect(sha256OfFile(pulled)).toBe(sha256);
        expect(fs.readFileSync(pulled).subarray(0, 4).toString()).toBe('glTF');
        expect(mirror.uploaded).toBe(1);
    });

    it('sweeps blobs stored before the mirror existed', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const { store, sha256 } = storeWithFile(Buffer.from('older file'));
        const mirror = new AssetCloudMirror(store, bucket);
        expect(await mirror.sweep()).toEqual({ local: 1, alreadyInBucket: 0, queued: 1 });
        await mirror.idle();
        expect(await mirror.sweep()).toEqual({ local: 1, alreadyInBucket: 1, queued: 0 });
        expect((await bucket.list('blobs/'))[0].key.endsWith(sha256)).toBe(true);
    });

    it('restores lost local bytes from the bucket, checked against the hash', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const { store, sha256, servedPath } = storeWithFile(Buffer.from('restore me'));
        const mirror = new AssetCloudMirror(store, bucket);
        await mirror.sweep();
        await mirror.idle();

        fs.rmSync(store.blobPath(sha256));
        expect(store.lookup(servedPath)).toBeUndefined();
        expect(await mirror.restore(sha256)).toBe(true);
        const back = store.lookup(servedPath);
        expect(back).toBeDefined();
        expect(fs.readFileSync(back!.file, 'utf8')).toBe('restore me');
    });

    it('refuses a bucket copy whose bytes do not match the hash', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const { store, sha256, servedPath } = storeWithFile(Buffer.from('genuine'));
        const forged = path.join(fresh('src'), 'forged');
        fs.writeFileSync(forged, 'tampered');
        await bucket.putFile(AssetCloudMirror.key(sha256), forged);
        fs.rmSync(store.blobPath(sha256));

        const mirror = new AssetCloudMirror(store, bucket);
        await expect(mirror.restore(sha256)).rejects.toThrow(/hashes to/);
        expect(store.lookup(servedPath)).toBeUndefined();
        expect(fs.readdirSync(path.dirname(store.blobPath(sha256)))).toEqual([]);
    });

    it('reports a blob the bucket does not have', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const { store, sha256 } = storeWithFile(Buffer.from('never uploaded'));
        fs.rmSync(store.blobPath(sha256));
        expect(await new AssetCloudMirror(store, bucket).restore(sha256)).toBe(false);
    });
});

describe('asset database snapshots', () => {
    it('uploads a SQLite copy when none is recent, and skips while one is', async () => {
        const bucket = new DirectoryCloudBucket(fresh('bucket'));
        const store = new DurableAssetStore(fresh('home'));
        const file = path.join(fresh('src'), 'x.bin');
        fs.writeFileSync(file, 'x');
        store.putFile(file, { servedPath: '/models/x.bin', origin: 'test' });

        const now = Date.parse('2026-10-24T03:00:00Z');
        const key = await snapshotAssetDbIfDue(store, bucket, now);
        expect(key).toBe('db/scratchbox-2026-10-24.db');
        const pulled = path.join(fresh('check'), 'snap.db');
        await bucket.download(key!, pulled);
        expect(fs.readFileSync(pulled).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000');
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as { DatabaseSync: new (f: string) => { prepare(s: string): { get(): unknown }; close(): void } };
        const copy = new DatabaseSync(pulled);
        expect(copy.prepare(`SELECT path FROM served WHERE path = '/models/x.bin'`).get()).toEqual({ path: '/models/x.bin' });
        copy.close();

        expect(await snapshotAssetDbIfDue(store, bucket, Date.now() + 60_000)).toBeUndefined();
        expect(fs.readdirSync(path.join(store.home, 'tmp'))).toEqual([]);
    });
});

describe('bucket configuration', () => {
    it('is off without a configured bucket, and the env var wins over the config file', () => {
        const saved = { home: process.env.SCRATCHBOX_HOME, bucket: process.env.SCRATCHBOX_STORE_BUCKET };
        try {
            delete process.env.SCRATCHBOX_STORE_BUCKET;
            process.env.SCRATCHBOX_HOME = fresh('home');
            expect(resolveCloudStoreBucketName()).toBeUndefined();
            fs.writeFileSync(path.join(process.env.SCRATCHBOX_HOME, 'cloud-store.json'), JSON.stringify({ bucket: 'from-file' }));
            expect(resolveCloudStoreBucketName()).toBe('from-file');
            process.env.SCRATCHBOX_STORE_BUCKET = 'from-env';
            expect(resolveCloudStoreBucketName()).toBe('from-env');
            process.env.SCRATCHBOX_STORE_BUCKET = 'off';
            expect(resolveCloudStoreBucketName()).toBeUndefined();
        } finally {
            if (saved.home === undefined) delete process.env.SCRATCHBOX_HOME; else process.env.SCRATCHBOX_HOME = saved.home;
            if (saved.bucket === undefined) delete process.env.SCRATCHBOX_STORE_BUCKET; else process.env.SCRATCHBOX_STORE_BUCKET = saved.bucket;
        }
    });
});
