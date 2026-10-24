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
import { ASSET_DB_SCHEMA_VERSION } from '../asset-store/asset-db';
import type { DurableAssetStore } from '../asset-store/durable-asset-store';
import type { CloudBucket } from './cloud-bucket';

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_PREFIX = 'db/';

/**
 * Uploads a copy of the asset database as `db/scratchbox-<YYYY-MM-DD>.db` when the newest snapshot in the bucket is
 * older than `maxAgeMs` (the bucket's lifecycle rule drops snapshots after 30 days). Returns the key written, or
 * undefined when a recent snapshot already exists.
 */
export async function snapshotAssetDbIfDue(store: DurableAssetStore, bucket: CloudBucket, now = Date.now(), maxAgeMs = DAY_MS): Promise<string | undefined> {
    const newest = Math.max(0, ...(await bucket.list(SNAPSHOT_PREFIX)).map(o => o.updatedMs));
    if (newest && now - newest < maxAgeMs) return undefined;
    const tmpDir = path.join(store.home, 'tmp');
    await fs.ensureDir(tmpDir);
    const tmp = path.join(tmpDir, `scratchbox-snapshot-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
        await store.db.backupTo(tmp);
        const key = `${SNAPSHOT_PREFIX}scratchbox-${new Date(now).toISOString().slice(0, 10)}.db`;
        await bucket.putFile(key, tmp, { contentType: 'application/vnd.sqlite3', metadata: { schemaVersion: String(ASSET_DB_SCHEMA_VERSION) } });
        return key;
    } finally {
        await fs.remove(tmp);
    }
}

/** Checks hourly (from a few minutes after start) whether a daily snapshot is due; returns a stop function. */
export function scheduleAssetDbSnapshots(store: DurableAssetStore, bucket: CloudBucket, firstCheckMs = 3 * 60 * 1000): () => void {
    let interval: NodeJS.Timeout | undefined;
    const check = (): void => {
        snapshotAssetDbIfDue(store, bucket)
            .then(key => { if (key) console.log(`[cloud-store] asset database snapshot uploaded to ${bucket.label}/${key}`); })
            .catch(err => console.warn(`[cloud-store] asset database snapshot to ${bucket.label} failed (retried within the hour): ${(err as Error).message}`));
    };
    const first = setTimeout(() => {
        check();
        interval = setInterval(check, 60 * 60 * 1000);
        interval.unref();
    }, firstCheckMs);
    first.unref();
    return () => {
        clearTimeout(first);
        if (interval) clearInterval(interval);
    };
}
