/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A finished district build kept as a world (scripts/publish_district_world.ts, and after every finished district build):
 * its scene with the models it names moved under the world's folder, so `/api/worlds/<slug>/scene` and a starter button
 * open it like a splat world, and a copy in the world cache (world-cache.ts storeWorld), so a machine without it fetches
 * it from the cloud (world-scenes.ts openWorld).
 */

import * as fs from 'fs';
import * as path from 'path';
import { WORLD_SCENE_FILE } from './world-scenes';
import { storeWorld, worldCacheKey, WORLD_SLUG } from './world-cache';
import type { CloudBucket } from './cloud-bucket';

export const DISTRICT_WORLD_VERSION = 'district-world/1';

/**
 * The scene with every `/models/<file>` it names moved under the world's folder, and the files it names. It opens textured
 * when its layers have textured twins (AGENTS.md: textured by default, clay on request; a build saved mid-way or replayed
 * in clay keeps its twins), under `title` when one is given.
 */
export function districtWorldScene(artifact: { data?: Record<string, unknown> }, slug: string, opts: { title?: string } = {}): { scene: Record<string, unknown>; models: string[] } {
    if (!artifact.data || typeof artifact.data !== 'object') throw new Error('the artifact has no scene data');
    const models = new Set<string>();
    const text = JSON.stringify(artifact.data).replace(/"\/models\/([^"\\]+)"/g, (_m, file: string) => {
        models.add(file);
        return JSON.stringify(`/tilesets/${slug}/models/${file}`);
    });
    const scene = JSON.parse(text) as Record<string, any>;
    const textured = Array.isArray(scene.stagedBuild?.layers) && scene.stagedBuild.layers.some((l: { textured?: unknown }) => !!l.textured);
    return { scene: { ...scene, ...(textured ? { renderMode: 'pbr' } : {}), ...(opts.title ? { title: opts.title } : {}), world: { slug } }, models: [...models].sort() };
}


function link(target: string, at: string): void {
    try {
        const st = fs.lstatSync(at);
        if (!st.isSymbolicLink()) throw new Error(`${at} exists and is not a link; not replaced`);
        fs.unlinkSync(at);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
}

export interface PublishedDistrictWorld { slug: string; dir: string; models: number; bytes: number; linked: string[]; stored?: { key: string; files: number; bucket: string } }

/**
 * Keeps a finished district build as the world `slug`: `<worldsDir>/<slug>/scene3d.json` (districtWorldScene) beside a
 * `models` folder linking each model the scene names where the build left it (in `modelsDir`), the world linked into each
 * of `linkInto` (a folder that serves /tilesets), and with `bucket` stored in the world cache under a key of the slug and
 * `runId`, its folder name indexed so openWorld fetches it on a machine without it. Every model the scene names must be in
 * `modelsDir`, or nothing is written.
 */
export async function publishDistrictWorld(input: { artifact: { data?: Record<string, unknown> }; modelsDir: string; slug: string; worldsDir: string; title?: string; runId?: string; linkInto?: string[]; bucket?: CloudBucket; log?: (m: string) => void }): Promise<PublishedDistrictWorld> {
    const { slug, modelsDir } = input;
    if (!WORLD_SLUG.test(slug)) throw new Error(`not a world name: ${slug}`);
    const { scene, models } = districtWorldScene(input.artifact, slug, input.title ? { title: input.title } : {});
    const missing = models.filter(f => !fs.existsSync(path.join(modelsDir, f)));
    if (missing.length) throw new Error(`${missing.length} of the ${models.length} models the scene names are not in ${modelsDir} (${missing.slice(0, 3).join(', ')}...); nothing written`);
    const dir = path.join(input.worldsDir, slug), modelsOut = path.join(dir, 'models');
    fs.mkdirSync(dir, { recursive: true });
    // a folder of links, one per model the scene names (not the build's whole folder: its other versions stay out)
    try { if (fs.lstatSync(modelsOut).isSymbolicLink()) fs.unlinkSync(modelsOut); } catch { /* none yet */ }
    fs.mkdirSync(modelsOut, { recursive: true });
    for (const f of fs.readdirSync(modelsOut)) if (!models.includes(f)) fs.unlinkSync(path.join(modelsOut, f));
    for (const f of models) link(path.join(path.resolve(modelsDir), f), path.join(modelsOut, f));
    fs.writeFileSync(path.join(dir, WORLD_SCENE_FILE), `${JSON.stringify(scene)}\n`);
    const bytes = models.reduce((a, f) => a + fs.statSync(path.join(modelsDir, f)).size, 0);
    input.log?.(`[district-world] ${slug}: ${dir} (${models.length} models, ${(bytes / 1e9).toFixed(2)} GB, left in ${modelsDir})`);
    const linked: string[] = [];
    for (const into of input.linkInto ?? []) {
        const at = path.join(into, slug);
        link(dir, at);
        linked.push(at);
        input.log?.(`[district-world] linked into ${at}`);
    }
    if (!input.bucket) return { slug, dir, models: models.length, bytes, linked };
    const key = worldCacheKey({ kind: 'district', version: DISTRICT_WORLD_VERSION, slug, run: input.runId });
    input.log?.(`[district-world] ${slug}: storing ${models.length + 1} files (${(bytes / 1e9).toFixed(2)} GB) in ${input.bucket.label} as ${key}`);
    const files = await storeWorld(input.bucket, key, dir, { kind: 'district', slug, ...(input.runId ? { runId: input.runId } : {}), title: (scene as { title?: string }).title });
    input.log?.(`[district-world] ${slug}: stored (${files} files)`);
    return { slug, dir, models: models.length, bytes, linked, stored: { key, files, bucket: input.bucket.label } };
}
