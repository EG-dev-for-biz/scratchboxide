/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Keeps a finished district build as a world (cloud-store/district-world.ts publishDistrictWorld), so a starter button (studio/starterPrompts.ts `world`) opens it at once
 * instead of building a district again:
 *
 *   1. the run's scene (its `artifact.json`: the staged scene artifact, `data` its Scene3DData) is written as
 *      `<worlds>/<slug>/scene3d.json`, every `/models/<file>` it names rewritten to `/tilesets/<slug>/models/<file>`;
 *   2. `<worlds>/<slug>/models` links each model the scene names in the run's own `public/models` (they stay there);
 *   3. `<checkout>/public/tilesets/<slug>` links to `<worlds>/<slug>`, so that checkout's app serves it;
 *   4. with --upload, the world is stored in the cloud world cache and indexed, so a machine without it fetches it.
 *
 * Every model the scene names must be there, or nothing is written. The scene is the build's own: its staged objects,
 * labels, weather and camera as the run left them.
 *
 *   npx vite-node scripts/publish_district_world.ts <run folder> <slug> [--title <title>] [--worlds <dir>] [--link <checkout>]... [--upload]
 *
 * The run folder holds artifact.json and public/models (e.g. /Volumes/3DTESTING/Scratchbox-drive/kd-penn-c81d307d-replay).
 * --worlds defaults to the run folder's parent's `worlds`; --link defaults to this checkout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { defaultWorldCacheBucket } from '../packages/core/src/node/cloud-store/world-cache';
import { publishDistrictWorld } from '../packages/core/src/node/cloud-store/district-world';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const opt = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
    const [runDir, slug] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
    if (!runDir || !slug) throw new Error('usage: publish_district_world.ts <run folder> <slug> [--title <title>] [--worlds <dir>] [--link <checkout>]... [--upload]');
    const run = path.resolve(runDir);
    const artifact = JSON.parse(fs.readFileSync(path.join(run, 'artifact.json'), 'utf8'));
    const bucket = args.includes('--upload') ? defaultWorldCacheBucket() : undefined;
    if (args.includes('--upload') && !bucket) throw new Error('--upload: no world cache bucket is configured (SCRATCHBOX_WORLD_CACHE_BUCKET, or worldCacheBucket in cloud-store.json)');
    const title = opt('--title')[0];
    const checkouts = opt('--link').length ? opt('--link') : [path.resolve(__dirname, '..')];
    await publishDistrictWorld({
        artifact, modelsDir: path.join(run, 'public', 'models'), slug,
        worldsDir: path.resolve(opt('--worlds')[0] ?? path.join(path.dirname(run), 'worlds')),
        ...(title ? { title } : {}), runId: artifact.data?.stagedBuild?.runId,
        linkInto: checkouts.map(c => path.join(path.resolve(c), 'public', 'tilesets')),
        ...(bucket ? { bucket } : {}), log: m => console.log(m)
    });
}

main().catch(err => { console.error(err); process.exit(1); });
