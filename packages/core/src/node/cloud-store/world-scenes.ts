/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A cached world opened and saved as a scene (user ask, 2026-10-30: the whole scene read and write, its splats included).
 * The world's built files stay as the build left them (world-cache.ts); what a user changes is the scene: its objects,
 * camera and light, and its splat edits (brush strokes replayed over the built splat, common/spatial/splat-edits.ts).
 * Every save is a new version beside the world, `worlds/<cache version>/<key>/scenes/<version>.json`, and
 * `scenes/latest.json` names the newest. A rebuild of the same world keeps them: its strokes name places, not splats.
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CloudBucket } from './cloud-bucket';
import { WORLD_CACHE_PREFIX, WORLD_SLUG, fetchWorld, readWorldIndex } from './world-cache';

/** The scene file a world's build writes beside its splats (location_generate_3dgs). */
export const WORLD_SCENE_FILE = 'scene3d.json';
const LATEST = 'latest.json';

/** A saved version: the scene as saved, and when. */
export interface WorldSceneVersion<S = Record<string, unknown>> {
    version: string;
    savedAt: string;
    scene: S;
}

/** What opening a world gives: its scene, and whether it is a saved version (cloud) or the build's own (local). */
export interface OpenedWorld<S = Record<string, unknown>> {
    scene: S;
    source: 'cloud' | 'local';
    version?: string;
    savedAt?: string;
    /** Set when the world's files were fetched from the cache into the local folder for this open. */
    fetchedFiles?: number;
}

const scenesPrefix = (key: string) => `${WORLD_CACHE_PREFIX}/${key}/scenes`;

async function withTmp<T>(run: (file: string) => Promise<T>): Promise<T> {
    const file = path.join(os.tmpdir(), `sb-world-scene-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
        return await run(file);
    } finally {
        await fs.remove(file);
    }
}

/** The newest saved version of the world `key`, or undefined when none was saved. */
export async function loadWorldScene<S>(bucket: CloudBucket, key: string): Promise<WorldSceneVersion<S> | undefined> {
    return withTmp(async tmp => {
        if (!(await bucket.download(`${scenesPrefix(key)}/${LATEST}`, tmp))) return undefined;
        return await fs.readJson(tmp) as WorldSceneVersion<S>;
    });
}

/** Saves `scene` as a new version of the world `key` (the version file first, then latest). */
export async function saveWorldScene<S>(bucket: CloudBucket, key: string, scene: S, now = new Date()): Promise<WorldSceneVersion<S>> {
    const savedAt = now.toISOString();
    const version = `${savedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${Math.random().toString(36).slice(2, 6)}`;
    const entry: WorldSceneVersion<S> = { version, savedAt, scene };
    await withTmp(async tmp => {
        await fs.writeJson(tmp, entry);
        await bucket.putFile(`${scenesPrefix(key)}/${version}.json`, tmp, { contentType: 'application/json', metadata: { world: key } });
        await bucket.putFile(`${scenesPrefix(key)}/${LATEST}`, tmp, { contentType: 'application/json', metadata: { world: key } });
    });
    return entry;
}

/** Every saved version of the world `key`, newest first (names and times only). */
export async function listWorldScenes(bucket: CloudBucket, key: string): Promise<string[]> {
    const objects = await bucket.list(`${scenesPrefix(key)}/`);
    return objects.map(o => path.basename(o.key, '.json')).filter(v => v !== 'latest').sort().reverse();
}

/**
 * Opens the world kept in `tilesetsDir/<slug>`: when the folder is missing here, its files come from the cache first;
 * then the newest saved version of its scene, else the build's own scene file. Throws when neither exists.
 */
export async function openWorld<S>(slug: string, tilesetsDir: string, bucket: CloudBucket | undefined): Promise<OpenedWorld<S>> {
    if (!WORLD_SLUG.test(slug)) throw new Error(`Not a world name: ${JSON.stringify(slug)}`);
    const dir = path.join(tilesetsDir, slug);
    const key = bucket ? await readWorldIndex(bucket, slug) : undefined;
    let fetchedFiles: number | undefined;
    if (bucket && key && !(await fs.pathExists(path.join(dir, WORLD_SCENE_FILE)))) {
        const hit = await fetchWorld(bucket, key, dir);
        if (hit) fetchedFiles = hit.files.length;
    }
    if (bucket && key) {
        const saved = await loadWorldScene<S>(bucket, key);
        if (saved) return { scene: saved.scene, source: 'cloud', version: saved.version, savedAt: saved.savedAt, ...(fetchedFiles ? { fetchedFiles } : {}) };
    }
    const local = path.join(dir, WORLD_SCENE_FILE);
    if (!(await fs.pathExists(local))) {
        throw new Error(`The world ${slug} is not on this machine${bucket ? (key ? ' and its cached copy could not be fetched' : ' and the world cache has no entry for it') : ' and no world cache bucket is configured'}`);
    }
    return { scene: await fs.readJson(local) as S, source: 'local', ...(fetchedFiles ? { fetchedFiles } : {}) };
}

/** Saves `scene` as a new version of the world `slug`; throws when the cache does not hold that world. */
export async function saveWorld<S>(slug: string, scene: S, bucket: CloudBucket | undefined): Promise<WorldSceneVersion<S> & { key: string }> {
    if (!bucket) throw new Error('No world cache bucket is configured (worldCacheBucket in ~/.scratchbox/cloud-store.json), so the world cannot be saved to the cloud');
    if (!WORLD_SLUG.test(slug)) throw new Error(`Not a world name: ${JSON.stringify(slug)}`);
    const key = await readWorldIndex(bucket, slug);
    if (!key) throw new Error(`The world cache (${bucket.label}) has no entry for ${slug}: build it (or let its build finish storing) before saving it`);
    return { ...(await saveWorldScene(bucket, key, scene)), key };
}
