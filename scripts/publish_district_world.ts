/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Keeps a finished district build as a world, so a starter button (studio/starterPrompts.ts `world`) opens it at once
 * instead of building a district again:
 *
 *   1. the run's scene (its `artifact.json`: the staged scene artifact, `data` its Scene3DData) is written as
 *      `<worlds>/<slug>/scene3d.json`, every `/models/<file>` it names rewritten to `/tilesets/<slug>/models/<file>`;
 *   2. `<worlds>/<slug>/models` links to the run's own `public/models` (the files stay where the run wrote them);
 *   3. `<checkout>/public/tilesets/<slug>` links to `<worlds>/<slug>`, so that checkout's app serves it.
 *
 * Every model the scene names must be there, or nothing is written. The scene is the build's own: its staged objects,
 * labels, weather and camera as the run left them.
 *
 *   npx vite-node scripts/publish_district_world.ts <run folder> <slug> [--title <title>] [--worlds <dir>] [--link <checkout>]...
 *
 * The run folder holds artifact.json and public/models (e.g. /Volumes/3DTESTING/Scratchbox-drive/kd-penn-c81d307d-replay).
 * --worlds defaults to the run folder's parent's `worlds`; --link defaults to this checkout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WORLD_SCENE_FILE } from '../packages/core/src/node/cloud-store/world-scenes';
import { WORLD_SLUG } from '../packages/core/src/node/cloud-store/world-cache';
import { districtWorldScene } from '../packages/core/src/node/cloud-store/district-world';

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

function main(): void {
    const args = process.argv.slice(2);
    const opt = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
    const [runDir, slug] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
    if (!runDir || !slug) throw new Error('usage: publish_district_world.ts <run folder> <slug> [--title <title>] [--worlds <dir>] [--link <checkout>]...');
    if (!WORLD_SLUG.test(slug)) throw new Error(`not a world name: ${slug}`);
    const run = path.resolve(runDir), modelsDir = path.join(run, 'public', 'models');
    const artifact = JSON.parse(fs.readFileSync(path.join(run, 'artifact.json'), 'utf8'));
    const title = opt('--title')[0];
    const { scene, models } = districtWorldScene(artifact, slug, title ? { title } : {});
    const missing = models.filter(f => !fs.existsSync(path.join(modelsDir, f)));
    if (missing.length) throw new Error(`${missing.length} of the ${models.length} models the scene names are not in ${modelsDir} (${missing.slice(0, 3).join(', ')}...); nothing written`);
    const worlds = path.resolve(opt('--worlds')[0] ?? path.join(path.dirname(run), 'worlds'));
    const dir = path.join(worlds, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, WORLD_SCENE_FILE), `${JSON.stringify(scene)}\n`);
    link(modelsDir, path.join(dir, 'models'));
    const bytes = models.reduce((a, f) => a + fs.statSync(path.join(modelsDir, f)).size, 0);
    console.log(`[district-world] ${slug}: ${dir} (${models.length} models, ${(bytes / 1e9).toFixed(2)} GB, left in ${modelsDir})`);
    const checkouts = opt('--link').length ? opt('--link') : [path.resolve(__dirname, '..')];
    for (const c of checkouts) {
        const at = path.join(path.resolve(c), 'public', 'tilesets', slug);
        link(dir, at);
        console.log(`[district-world] linked into ${at}`);
    }
}

main();
