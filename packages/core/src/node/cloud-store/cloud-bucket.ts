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

/**
 * A bucket that can say which generation of an object it read and write only over that generation: a compare-and-swap,
 * so one writer at a time can hold a lease on an object (the place store's manifest, place-store.ts). A generation is an
 * opaque string that changes on every write; NO_GENERATION names an object that does not exist yet.
 */
export interface VersionedCloudBucket extends CloudBucket {
    /** Writes the object to `file` and returns the generation it was read at; undefined when there is no such object. */
    downloadVersioned(key: string, file: string): Promise<string | undefined>;
    /** Writes `file` only when the object is still at `generation`: its new generation, or 'conflict' when it is not. */
    putFileIfGeneration(key: string, file: string, generation: string, opts?: Omit<PutFileOptions, 'onlyIfAbsent'>): Promise<{ generation: string } | 'conflict'>;
}

/** The generation of an object that does not exist (GCS's ifGenerationMatch: 0). */
export const NO_GENERATION = '0';

export function isVersionedBucket(bucket: CloudBucket | undefined): bucket is VersionedCloudBucket {
    const b = bucket as Partial<VersionedCloudBucket> | undefined;
    return typeof b?.downloadVersioned === 'function' && typeof b.putFileIfGeneration === 'function';
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
export class GcsCloudBucket implements VersionedCloudBucket {
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

    async downloadVersioned(key: string, file: string): Promise<string | undefined> {
        assertKey(key);
        // the generation first, then exactly that generation's bytes: a write in between makes the read a 404 (the
        // generation is gone), and the read starts again at the new one
        for (let attempt = 0; attempt < 4; attempt++) {
            let generation: string;
            try {
                const [meta] = await this.bucket.file(key).getMetadata();
                generation = String(meta.generation);
            } catch (err) {
                if (errorCode(err) === 404) return undefined;
                throw err;
            }
            try {
                await this.bucket.file(key, { generation }).download({ destination: file });
                return generation;
            } catch (err) {
                if (errorCode(err) !== 404) throw err;
            }
        }
        throw new Error(`cloud store: ${this.label}/${key} kept changing while it was read`);
    }

    async putFileIfGeneration(key: string, file: string, generation: string, opts: Omit<PutFileOptions, 'onlyIfAbsent'> = {}): Promise<{ generation: string } | 'conflict'> {
        assertKey(key);
        try {
            const [written] = await this.bucket.upload(file, {
                destination: key,
                resumable: false,
                metadata: { contentType: opts.contentType ?? 'application/octet-stream', metadata: opts.metadata ?? {} },
                preconditionOpts: { ifGenerationMatch: Number(generation) }
            });
            return { generation: String(written.metadata.generation) };
        } catch (err) {
            if (errorCode(err) === 412) return 'conflict';
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

/** How long a directory bucket's write lock may stand before it is taken for a crashed writer's and broken (ms). */
const DIRECTORY_LOCK_STALE_MS = 30_000;

/**
 * A directory laid out like a bucket (a mounted share, or a temp dir under test); metadata sits in `<key>.meta.json`,
 * with the object's generation, which every write changes. A generation-matched write (and the read that gives the
 * generation) holds `<key>.lock`, a directory, for the moment it takes: creating a directory is atomic on a local disk
 * and on an SMB share alike.
 */
export class DirectoryCloudBucket implements VersionedCloudBucket {
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

    private async write(target: string, file: string, metadata: Record<string, string>): Promise<string> {
        await fs.ensureDir(path.dirname(target));
        const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
        const generation = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
        await fs.copyFile(file, tmp);
        await fs.writeJson(`${target}.meta.json`, { metadata, updatedMs: Date.now(), generation });
        await fs.move(tmp, target, { overwrite: true });
        return generation;
    }

    /** The object's generation; one written before generations were kept has its write time as one. */
    private async generationOf(target: string): Promise<string | undefined> {
        if (!(await fs.pathExists(target))) return undefined;
        const meta = await fs.readJson(`${target}.meta.json`).catch(() => undefined);
        return typeof meta?.generation === 'string' ? meta.generation : `t${Math.round((await fs.stat(target)).mtimeMs)}`;
    }

    private async locked<T>(target: string, run: () => Promise<T>): Promise<T> {
        const lock = `${target}.lock`;
        await fs.ensureDir(path.dirname(target));
        for (let attempt = 0; ; attempt++) {
            try {
                await fs.mkdir(lock);
                break;
            } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
                const age = await fs.stat(lock).then(s => Date.now() - s.mtimeMs, () => 0);
                if (age > DIRECTORY_LOCK_STALE_MS) { await fs.remove(lock); continue; }
                if (attempt > 200) throw new Error(`cloud store: ${lock} stayed locked`);
                await new Promise(r => setTimeout(r, 25));
            }
        }
        try {
            return await run();
        } finally {
            await fs.remove(lock);
        }
    }

    async putFile(key: string, file: string, opts: PutFileOptions = {}): Promise<'stored' | 'exists'> {
        const target = this.objectPath(key);
        if (opts.onlyIfAbsent && await fs.pathExists(target)) return 'exists';
        await this.write(target, file, opts.metadata ?? {});
        return 'stored';
    }

    async downloadVersioned(key: string, file: string): Promise<string | undefined> {
        const source = this.objectPath(key);
        return this.locked(source, async () => {
            const generation = await this.generationOf(source);
            if (generation === undefined) return undefined;
            await fs.copyFile(source, file);
            return generation;
        });
    }

    async putFileIfGeneration(key: string, file: string, generation: string, opts: Omit<PutFileOptions, 'onlyIfAbsent'> = {}): Promise<{ generation: string } | 'conflict'> {
        const target = this.objectPath(key);
        return this.locked(target, async () => {
            if ((await this.generationOf(target) ?? NO_GENERATION) !== generation) return 'conflict';
            return { generation: await this.write(target, file, opts.metadata ?? {}) };
        });
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
