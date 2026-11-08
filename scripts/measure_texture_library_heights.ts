/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Estimates the real depth of every texture library set's height map and commits the result
 * (assets/textures/library/heights.json; texture-library-heights.ts has the method): for each set with a height map, a
 * normal map and a real size, and no depth from its publisher, the depth at which its height map's slopes equal its
 * normal map's, measured on the publisher's free 1K previews (no bucket download, no model call). Sets already in the
 * file are kept; a set that cannot be estimated is recorded with the reason and draws no height.
 *
 *   npm run library:heights             estimate what is missing, then write the file
 *   npm run library:heights -- --redo   estimate every set again
 */

import * as fs from 'fs';
import * as path from 'path';
import { libraryPreview, loadTextureLibraryIndex } from '../packages/core/src/node/3d-engine/texture-library';
import { estimateHeightDepth, LIBRARY_HEIGHTS_FILE, LIBRARY_HEIGHTS_VERSION, loadLibraryHeights, type LibraryHeights } from '../packages/core/src/node/3d-engine/texture-library-heights';
import { decodeImageInMemory } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';

async function main(): Promise<void> {
    const repoRoot = path.resolve(__dirname, '..');
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error('the texture library index has not been built (npx vite-node scripts/build_texture_library_index.ts)');
    const file = path.join(repoRoot, 'assets', 'textures', 'library', LIBRARY_HEIGHTS_FILE);
    const prior = process.argv.includes('--redo') ? undefined : loadLibraryHeights(repoRoot);
    const sets: LibraryHeights['sets'] = { ...(prior?.sets ?? {}) };
    const want = index.sets.filter(e => !!e.maps.height && !!e.maps.normal && !!e.realSizeM && !/metadata$/.test(e.heightDepthSource ?? ''));
    const todo = want.filter(e => !sets[e.id]);
    console.log(`[library:heights] ${want.length} sets with a height map, a normal map and a real size; ${todo.length} to estimate`);
    let next = 0, done = 0;
    const failed: string[] = [];
    const write = () => {
        const doc: LibraryHeights = {
            schema: 'scratchbox.texture-library-heights/1', version: LIBRARY_HEIGHTS_VERSION,
            about: 'The estimated real depth (metres, black to white) of each texture library set\'s height map: the depth at which the height map\'s slopes equal the normal map\'s over the tile\'s real size, measured on the publishers\' preview maps (texture-library-heights.ts). Estimates, labelled generated wherever they are drawn; a set with an error draws no height.',
            measuredAt: new Date().toISOString(),
            sets: Object.fromEntries(Object.entries(sets).sort(([a], [b]) => a.localeCompare(b)))
        };
        fs.writeFileSync(file, JSON.stringify({ ...doc, sets: {} }, null, 1).replace('"sets": {}', `"sets": {\n${Object.entries(doc.sets).map(([id, v]) => `  ${JSON.stringify(id)}: ${JSON.stringify(v)}`).join(',\n')}\n }`) + '\n');
    };
    await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < todo.length) {
            const e = todo[next++];
            try {
                const [h, n] = await Promise.all([libraryPreview(e, 'height', repoRoot), libraryPreview(e, 'normal', repoRoot)]);
                sets[e.id] = !h || !n ? { error: `its publisher has no ${!h ? 'height' : 'normal'} preview` } : estimateHeightDepth(decodeImageInMemory(h), decodeImageInMemory(n), e.realSizeM!);
            } catch (err) {
                // a download or decode that failed is not a property of the set: left out, and estimated on the next run
                failed.push(`${e.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (++done % 100 === 0) { console.log(`[library:heights] ${done} of ${todo.length}`); write(); }
        }
    }));
    write();
    if (failed.length) console.log(`[library:heights] ${failed.length} sets could not be read and are left for the next run: ${failed.slice(0, 5).join('; ')}`);
    const ok = Object.values(sets).filter(v => !('error' in v)) as Array<{ depthM: number }>;
    const d = ok.map(v => v.depthM).sort((a, b) => a - b);
    console.log(`[library:heights] wrote ${path.relative(repoRoot, file)}: ${ok.length} estimated (median ${d.length ? (d[d.length >> 1] * 1000).toFixed(1) : '-'} mm, 10th-90th percentile ${d.length ? (d[Math.floor(d.length * 0.1)] * 1000).toFixed(1) : '-'}-${d.length ? (d[Math.floor(d.length * 0.9)] * 1000).toFixed(1) : '-'} mm), ${Object.keys(sets).length - ok.length} without an estimate`);
}

main().catch(err => { console.error(err); process.exit(1); });
