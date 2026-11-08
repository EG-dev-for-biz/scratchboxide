/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Measures the texture library ahead of the builds and commits the result: every set of a facade's scale (a colour,
 * normal and roughness map and a real size of at most FACADE_TILE.maxM, metal or not) not yet measured is measured with
 * the engine on its publisher's free 1K previews (texture-library.ts measureLibraryEntries; no bucket download, no model
 * call), then every set's statistics at the current version are written to assets/textures/library/stats.json, which
 * every checkout, worktree and cloud job reads (loadTextureLibraryIndex). A build never measures the library itself.
 *
 *   npm run library:stats            measure what is missing, then write the bundle
 *   npm run library:stats -- --write write the bundle from what is measured here, measuring nothing
 */

import * as fs from 'fs';
import * as path from 'path';
// the maintainer's flow measures sets into this checkout and bundles them; builds read the bundle alone (texture-library.ts localLibraryStatsAllowed)
process.env.SCRATCHBOX_LIBRARY_LOCAL_STATS = '1';
import { LIBRARY_STATS_BUNDLE, libraryEntryMeasured, loadTextureLibraryIndex, measureLibraryEntries, measuredLibraryStats } from '../packages/core/src/node/3d-engine/texture-library';
import { FACADE_TILE } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/material-sets';

async function main(): Promise<void> {
    const repoRoot = path.resolve(__dirname, '..');
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error('the texture library index has not been built (npx vite-node scripts/build_texture_library_index.ts)');
    if (!process.argv.includes('--write')) {
        const todo = index.sets.filter(e => !!e.maps.color && !!e.maps.normal && !!(e.maps.roughness || e.maps.arm) && !!e.realSizeM && Math.max(...e.realSizeM) <= FACADE_TILE.maxM && !libraryEntryMeasured(repoRoot, e.id));
        console.log(`[library:stats] ${todo.length} sets of a facade's scale not yet measured`);
        for (let i = 0; i < todo.length; i += 64) {
            const r = await measureLibraryEntries(todo.slice(i, i + 64), { repoRoot });
            console.log(`[library:stats] ${Math.min(i + 64, todo.length)} of ${todo.length}: ${r.measured.length} measured, ${r.failed.length} failed`);
        }
    }
    const bundle = measuredLibraryStats(repoRoot);
    const file = path.join(repoRoot, 'assets', 'textures', 'library', LIBRARY_STATS_BUNDLE);
    fs.writeFileSync(file, `${JSON.stringify(bundle)}\n`);
    const n = Object.keys(bundle.sets).length, failed = Object.values(bundle.sets).filter(s => s.error).length;
    console.log(`[library:stats] wrote ${path.relative(repoRoot, file)}: ${n} sets (${failed} failed to measure) at stats version ${bundle.version}`);
}

main().catch(err => { console.error(err); process.exit(1); });
