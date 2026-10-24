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
import type { Bucket } from '@google-cloud/storage';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { scratchboxHome } from '../asset-store/scratchbox-home';

/** An object in the bucket: its key, size, last write time and the string metadata it was written with. */
export interface CloudObject {
    key: string;
    bytes: number;
    updatedMs: number;
    metadata: Record<string, string>;
}

export interface PutFileOptions {
    contentType?: string;
    metadata?: Record<string, string>;
    /** Write only when no object has the key yet (content-addressed blobs never need rewriting). */
    onlyIfAbsent?: boolean;
}

/** Where chats, asset bytes and database snapshots are kept off this machine. */
export interface CloudBucket {
    /** Human-readable location, e.g. gs://bucket. */
    readonly label: string;
    /** 'stored' when written, 'exists' when `onlyIfAbsent` found the key taken. */
    putFile(key: string, file: string, opts?: PutFileOptions): Promise<'stored' | 'exists'>;
    /** Writes the object to `file`; false when there is no such object. */
    download(key: string, file: string): Promise<boolean>;
    list(prefix: string): Promise<CloudObject[]>;
    /** Removes the object; missing objects are not an error. */
    remove(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function assertKey(key: string): void {
    if (!KEY.test(key) || key.split('/').some(part => part === '.' || part === '..')) {
        throw new Error(`cloud store: bad object key ${JSON.stringify(key)}`);
    }
}

function errorCode(err: unknown): number | undefined {
    const code = (err as { code?: unknown })?.code;
    return typeof code === 'number' ? code : undefined;
}

/** Google Cloud Storage, authenticated with the app's service account. */
export class GcsCloudBucket implements CloudBucket {
    readonly label: string;

    constructor(private readonly bucket: Bucket) {
        this.label = `gs://${bucket.name}`;
    }

    async putFile(key: string, file: string, opts: PutFileOptions = {}): Promise<'stored' | 'exists'> {
        assertKey(key);
        const { size } = await fs.stat(file);
        try {
            await this.bucket.upload(file, {
                destination: key,
                resumable: size > 16 * 1024 * 1024,
                metadata: { contentType: opts.contentType ?? 'application/octet-stream', metadata: opts.metadata ?? {} },
                ...(opts.onlyIfAbsent ? { preconditionOpts: { ifGenerationMatch: 0 } } : {})
            });
            return 'stored';
        } catch (err) {
            if (opts.onlyIfAbsent && errorCode(err) === 412) return 'exists';
            throw err;
        }
    }

    async download(key: string, file: string): Promise<boolean> {
        assertKey(key);
        try {
            await this.bucket.file(key).download({ destination: file });
            return true;
        } catch (err) {
            if (errorCode(err) === 404) return false;
            throw err;
        }
    }

    async list(prefix: string): Promise<CloudObject[]> {
        const [files] = await this.bucket.getFiles({ prefix, autoPaginate: true });
        return files.map(f => ({
            key: f.name,
            bytes: Number(f.metadata.size ?? 0),
            updatedMs: Date.parse(String(f.metadata.updated ?? '')) || 0,
            metadata: Object.fromEntries(Object.entries(f.metadata.metadata ?? {}).map(([k, v]) => [k, String(v)]))
        }));
    }

    async remove(key: string): Promise<void> {
        assertKey(key);
        await this.bucket.file(key).delete({ ignoreNotFound: true });
    }
}

/** A directory laid out like a bucket (a mounted share, or a temp dir under test); metadata sits in `<key>.meta.json`. */
export class DirectoryCloudBucket implements CloudBucket {
    readonly label: string;
    private readonly root: string;

    constructor(root: string) {
        this.root = path.resolve(root);
        this.label = `dir://${this.root}`;
    }

    private objectPath(key: string): string {
        assertKey(key);
        return path.join(this.root, ...key.split('/'));
    }

    async putFile(key: string, file: string, opts: PutFileOptions = {}): Promise<'stored' | 'exists'> {
        const target = this.objectPath(key);
        if (opts.onlyIfAbsent && await fs.pathExists(target)) return 'exists';
        await fs.ensureDir(path.dirname(target));
        const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
        await fs.copyFile(file, tmp);
        await fs.writeJson(`${target}.meta.json`, { metadata: opts.metadata ?? {}, updatedMs: Date.now() });
        await fs.move(tmp, target, { overwrite: true });
        return 'stored';
    }

    async download(key: string, file: string): Promise<boolean> {
        const source = this.objectPath(key);
        if (!(await fs.pathExists(source))) return false;
        await fs.copyFile(source, file);
        return true;
    }

    async list(prefix: string): Promise<CloudObject[]> {
        const out: CloudObject[] = [];
        const walk = async (dir: string, keyPrefix: string): Promise<void> => {
            if (!(await fs.pathExists(dir))) return;
            for (const name of await fs.readdir(dir)) {
                const full = path.join(dir, name);
                const key = keyPrefix ? `${keyPrefix}/${name}` : name;
                const stat = await fs.stat(full);
                if (stat.isDirectory()) {
                    await walk(full, key);
                } else if (!name.endsWith('.meta.json') && !/\.tmp-[0-9a-f]{8}$/.test(name) && key.startsWith(prefix)) {
                    const meta = await fs.readJson(`${full}.meta.json`).catch(() => ({ metadata: {}, updatedMs: stat.mtimeMs }));
                    out.push({ key, bytes: stat.size, updatedMs: meta.updatedMs, metadata: meta.metadata });
                }
            }
        };
        await walk(this.root, '');
        return out;
    }

    async remove(key: string): Promise<void> {
        const target = this.objectPath(key);
        await fs.remove(target);
        await fs.remove(`${target}.meta.json`);
    }
}

/**
 * The bucket name: SCRATCHBOX_STORE_BUCKET (`off` disables), else `bucket` in `<scratchbox home>/cloud-store.json`.
 * Undefined means no cloud copy (isolated SCRATCHBOX_HOME instances and tests have no config file).
 */
export function resolveCloudStoreBucketName(): string | undefined {
    const fromEnv = process.env.SCRATCHBOX_STORE_BUCKET?.trim();
    if (fromEnv) return fromEnv === 'off' ? undefined : fromEnv;
    const configFile = path.join(scratchboxHome(), 'cloud-store.json');
    try {
        const bucket = fs.readJsonSync(configFile)?.bucket;
        return typeof bucket === 'string' && bucket.trim() ? bucket.trim() : undefined;
    } catch {
        return undefined;
    }
}

let shared: { name: string; bucket: CloudBucket } | undefined;

/** The process-wide cloud bucket, or undefined when none is configured. */
export function defaultCloudBucket(): CloudBucket | undefined {
    const name = resolveCloudStoreBucketName();
    if (!name) return undefined;
    if (shared?.name !== name) {
        const storage = new GoogleMediaCredentialsService().createStorageClient();
        shared = { name, bucket: new GcsCloudBucket(storage.bucket(name)) };
    }
    return shared.bucket;
}
