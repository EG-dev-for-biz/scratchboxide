/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Finished splat worlds kept in Google Cloud Storage, so the same world is not built from scratch again (user ask,
 * 2026-10-29). A world is stored under `worlds/<version>/<key>/`: every file of its output folder except the per-station work
 * (`stations/`), then `world.json` last, which marks the copy complete and holds what the result needs to be rebuilt
 * without the build (the viewer, the anchor, the station reports).
 *
 * The key is a hash of what decides the world (the place after the sidewalk snap, the heading, the station counts, the
 * prompt's style words, the pipeline version): a different ask is a different world. Nothing here holds a Street View
 * photograph: they never reach the output folder (street-view-stations.ts).
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs-extra';
import * as path from 'path';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { scratchboxHome } from '../asset-store/scratchbox-home';
import { GcsCloudBucket, type CloudBucket } from './cloud-bucket';

/** Bumped when a change to the pipeline makes worlds built before it not worth reusing. */
export const WORLD_CACHE_VERSION = 'v2';
export const WORLD_CACHE_PREFIX = `worlds/${WORLD_CACHE_VERSION}`;
/** The manifest, written last: a world without it is an interrupted upload and is not used. */
export const WORLD_MANIFEST = 'world.json';
/** Where a world's folder name points at its key: `<WORLD_INDEX_PREFIX>/<folder name>.json` holds { key, version }. */
export const WORLD_INDEX_PREFIX = 'worlds/index';
/** A world folder's name as the index and the world routes take it. */
export const WORLD_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/** This machine's copy of a world's saved scenes, beside its built files (world-scenes.ts). */
export const WORLD_SCENES_DIR = 'scenes';
/** Per-station work in the output folder, and the local copy of its saved scenes: not built files, so not stored. */
const SKIPPED_DIRS = new Set(['stations', WORLD_SCENES_DIR]);

/** The world cache bucket: SCRATCHBOX_WORLD_CACHE_BUCKET (`off` disables), else `worldCacheBucket` in cloud-store.json. */
export function resolveWorldCacheBucketName(): string | undefined {
    const fromEnv = process.env.SCRATCHBOX_WORLD_CACHE_BUCKET?.trim();
    if (fromEnv) return fromEnv === 'off' ? undefined : fromEnv;
    try {
        const bucket = fs.readJsonSync(path.join(scratchboxHome(), 'cloud-store.json'))?.worldCacheBucket;
        return typeof bucket === 'string' && bucket.trim() ? bucket.trim() : undefined;
    } catch {
        return undefined;
    }
}

let shared: { name: string; bucket: CloudBucket } | undefined;

/** The process-wide world cache bucket, or undefined when none is configured (worlds are then always built). */
export function defaultWorldCacheBucket(): CloudBucket | undefined {
    const name = resolveWorldCacheBucketName();
    if (!name) return undefined;
    if (shared?.name !== name) {
        const storage = new GoogleMediaCredentialsService().createStorageClient();
        shared = { name, bucket: new GcsCloudBucket(storage.bucket(name)) };
    }
    return shared.bucket;
}

/** The key of a world: a hash of the values that decide it, in a stable order. */
export function worldCacheKey(parts: Record<string, string | number | boolean | undefined>): string {
    const stable = Object.keys(parts).sort().filter(k => parts[k] !== undefined).map(k => [k, parts[k]]);
    return crypto.createHash('sha256').update(JSON.stringify([WORLD_CACHE_VERSION, stable])).digest('hex').slice(0, 24);
}

/** What `world.json` holds besides the file list: whatever the caller needs to rebuild its result. */
export type WorldManifest<T> = { key: string; files: string[]; storedAt: string; result: T };

async function filesUnder(dir: string, rel = ''): Promise<string[]> {
    const out: string[] = [];
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!(rel === '' && SKIPPED_DIRS.has(e.name))) out.push(...await filesUnder(dir, r)); }
        else if (e.isFile() && e.name !== WORLD_MANIFEST) out.push(r);
    }
    return out;
}

/** Points the world folder name `slug` at `key`, so the world can be opened (and saved) by its folder name alone. */
export async function writeWorldIndex(bucket: CloudBucket, slug: string, key: string): Promise<void> {
    if (!WORLD_SLUG.test(slug)) throw new Error(`world cache: bad world name ${JSON.stringify(slug)}`);
    const tmp = path.join(os.tmpdir(), `sb-world-index-${process.pid}-${Date.now()}.json`);
    await fs.writeJson(tmp, { key, version: WORLD_CACHE_VERSION });
    try {
        await bucket.putFile(`${WORLD_INDEX_PREFIX}/${slug}.json`, tmp, { contentType: 'application/json' });
    } finally {
        await fs.remove(tmp);
    }
}

/** The key the world folder name `slug` points at in this cache version, or undefined. */
export async function readWorldIndex(bucket: CloudBucket, slug: string): Promise<string | undefined> {
    if (!WORLD_SLUG.test(slug)) return undefined;
    const tmp = path.join(os.tmpdir(), `sb-world-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
        if (!(await bucket.download(`${WORLD_INDEX_PREFIX}/${slug}.json`, tmp))) return undefined;
        const entry = await fs.readJson(tmp) as { key?: string; version?: string };
        return entry.version === WORLD_CACHE_VERSION && typeof entry.key === 'string' ? entry.key : undefined;
    } finally {
        await fs.remove(tmp);
    }
}

/** Stores the world built in `outDir` under `key`, the manifest last, then its folder name in the index. Returns the number of files stored. */
export async function storeWorld<T>(bucket: CloudBucket, key: string, outDir: string, result: T): Promise<number> {
    const files = await filesUnder(outDir);
    for (const f of files) await bucket.putFile(`${WORLD_CACHE_PREFIX}/${key}/${f}`, path.join(outDir, f), { metadata: { world: key } });
    const manifest: WorldManifest<T> = { key, files, storedAt: new Date().toISOString(), result };
    const tmp = path.join(outDir, `.${WORLD_MANIFEST}.${process.pid}`);
    await fs.writeJson(tmp, manifest);
    try {
        await bucket.putFile(`${WORLD_CACHE_PREFIX}/${key}/${WORLD_MANIFEST}`, tmp, { contentType: 'application/json', metadata: { world: key } });
    } finally {
        await fs.remove(tmp);
    }
    const slug = path.basename(outDir);
    if (WORLD_SLUG.test(slug)) await writeWorldIndex(bucket, slug, key);
    return files.length;
}

/** Fetches the world stored under `key` into `outDir`; undefined when there is none (or only an interrupted copy). */
export async function fetchWorld<T>(bucket: CloudBucket, key: string, outDir: string): Promise<WorldManifest<T> | undefined> {
    await fs.ensureDir(outDir);
    const manifestFile = path.join(outDir, `.${WORLD_MANIFEST}.${process.pid}`);
    try {
        if (!(await bucket.download(`${WORLD_CACHE_PREFIX}/${key}/${WORLD_MANIFEST}`, manifestFile))) return undefined;
        const manifest = await fs.readJson(manifestFile) as WorldManifest<T>;
        for (const f of manifest.files) {
            const target = path.join(outDir, ...f.split('/'));
            await fs.ensureDir(path.dirname(target));
            if (!(await bucket.download(`${WORLD_CACHE_PREFIX}/${key}/${f}`, target))) return undefined;
        }
        return manifest;
    } finally {
        await fs.remove(manifestFile);
    }
}
