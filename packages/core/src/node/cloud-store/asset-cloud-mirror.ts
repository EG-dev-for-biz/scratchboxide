/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { DurableAssetStore, sha256OfFileStreamed } from '../asset-store/durable-asset-store';
import type { CloudBucket } from './cloud-bucket';

const SHA = /^[0-9a-f]{64}$/;

export interface MirrorSweepReport {
    local: number;
    alreadyInBucket: number;
    queued: number;
}

/**
 * Keeps the durable asset store's bytes in a cloud bucket (`blobs/<aa>/<sha256>`, written once: content never changes
 * under a hash). New blobs are uploaded in the background as they are stored; `sweep` uploads whatever the bucket still
 * lacks; `restore` brings back a blob whose local bytes are gone, checked against its hash before it is used.
 */
export class AssetCloudMirror {
    private readonly queue: string[] = [];
    private readonly queued = new Set<string>();
    private readonly restoring = new Map<string, Promise<boolean>>();
    private active = 0;
    private idleWaiters: Array<() => void> = [];
    uploaded = 0;
    readonly failures: Array<{ sha256: string; error: string }> = [];

    constructor(private readonly store: DurableAssetStore, readonly bucket: CloudBucket, private readonly concurrency = 3) {}

    static key(sha256: string): string {
        return `blobs/${sha256.slice(0, 2)}/${sha256}`;
    }

    /** Uploads every blob the store keeps from now on. */
    attach(): () => void {
        return this.store.onBlobKept(sha256 => this.enqueue(sha256));
    }

    enqueue(sha256: string): void {
        if (!SHA.test(sha256) || this.queued.has(sha256)) return;
        this.queued.add(sha256);
        this.queue.push(sha256);
        this.pump();
    }

    /** Resolves once nothing is queued or uploading. */
    idle(): Promise<void> {
        if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this.idleWaiters.push(resolve));
    }

    private pump(): void {
        while (this.active < this.concurrency && this.queue.length > 0) {
            const sha256 = this.queue.shift()!;
            this.active++;
            this.uploadOne(sha256)
                .then(result => {
                    if (result === 'stored') this.uploaded++;
                })
                .catch(err => {
                    const error = (err as Error).message;
                    this.failures.push({ sha256, error });
                    if (this.failures.length > 50) this.failures.shift();
                    console.warn(`[cloud-store] asset ${sha256.slice(0, 12)} not uploaded to ${this.bucket.label} (retried by the next sweep): ${error}`);
                })
                .finally(() => {
                    this.active--;
                    this.queued.delete(sha256);
                    this.pump();
                    if (this.active === 0 && this.queue.length === 0) {
                        const waiters = this.idleWaiters;
                        this.idleWaiters = [];
                        for (const resolve of waiters) resolve();
                    }
                });
        }
    }

    private async uploadOne(sha256: string): Promise<'stored' | 'exists' | 'gone'> {
        const file = this.store.blobPath(sha256);
        if (!(await fs.pathExists(file))) return 'gone';
        return this.bucket.putFile(AssetCloudMirror.key(sha256), file, { onlyIfAbsent: true, metadata: { sha256 } });
    }

    /** Queues every local blob the bucket does not have yet (the first upload of an existing store, and retries). */
    async sweep(): Promise<MirrorSweepReport> {
        const inBucket = new Set((await this.bucket.list('blobs/')).map(o => o.key));
        const report: MirrorSweepReport = { local: 0, alreadyInBucket: 0, queued: 0 };
        const blobsDir = path.join(this.store.root, 'blobs');
        if (!(await fs.pathExists(blobsDir))) return report;
        for (const shard of await fs.readdir(blobsDir)) {
            const shardDir = path.join(blobsDir, shard);
            if (!(await fs.stat(shardDir)).isDirectory()) continue;
            for (const name of await fs.readdir(shardDir)) {
                if (!SHA.test(name)) continue;
                report.local++;
                if (inBucket.has(AssetCloudMirror.key(name))) {
                    report.alreadyInBucket++;
                } else {
                    report.queued++;
                    this.enqueue(name);
                }
            }
        }
        return report;
    }

    /** Downloads a blob into the store; true once its bytes are back and match the hash, false if the bucket lacks it. */
    restore(sha256: string): Promise<boolean> {
        if (!SHA.test(sha256)) return Promise.resolve(false);
        const running = this.restoring.get(sha256);
        if (running) return running;
        const attempt = this.restoreOnce(sha256).finally(() => this.restoring.delete(sha256));
        this.restoring.set(sha256, attempt);
        return attempt;
    }

    private async restoreOnce(sha256: string): Promise<boolean> {
        const target = this.store.blobPath(sha256);
        if (await fs.pathExists(target)) return true;
        await fs.ensureDir(path.dirname(target));
        const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        try {
            if (!(await this.bucket.download(AssetCloudMirror.key(sha256), tmp))) return false;
            const actual = await sha256OfFileStreamed(tmp);
            if (actual !== sha256) throw new Error(`bucket copy of ${sha256} hashes to ${actual}; not restored`);
            await fs.move(tmp, target, { overwrite: true });
            return true;
        } finally {
            await fs.remove(tmp);
        }
    }
}
