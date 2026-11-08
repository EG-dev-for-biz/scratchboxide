/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A build ranks the texture library from the committed statistics bundle alone (texture-library.ts localLibraryStatsAllowed):
 * a checkout's own measured files are read, and sets measured, only under SCRATCHBOX_LIBRARY_LOCAL_STATS=1, the
 * maintainer's `npm run library:stats` flow. Found 2026-11-08: two checkouts shortlisted the same class differently
 * because one held 2,451 local files over the bundle.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { libraryEntryMeasured, loadTextureLibraryIndex, measureLibraryEntries } from '../src/node/3d-engine/texture-library';

function checkout(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lib-stats-'));
    const lib = path.join(root, 'assets', 'textures', 'library'), local = path.join(root, 'build', 'texture-library', 'stats');
    fs.mkdirSync(lib, { recursive: true }); fs.mkdirSync(local, { recursive: true });
    const entry = (id: string) => ({ id, publisher: 'ambientCG', maps: { color: `${id}/c.png`, normal: `${id}/n.png`, roughness: `${id}/r.png` }, realSizeM: [2, 2], provenance: 'library', appearance: id, tags: [] });
    fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ schema: 'scratchbox.texture-library/1', bucket: 'test', builtAt: '2026-11-08', sets: [entry('Bundled'), entry('LocalOnly')] }));
    const colour = (L: number) => ({ meanLinearRgb: [0.2, 0.2, 0.2], spreadLinearRgb: [0.01, 0.01, 0.01], meanLab: [L, 0, 0], spreadLab: [1, 0, 0] });
    const stats = (L: number) => ({ colour: colour(L), roughnessMean: 0.8, roughnessSpread: 0.02, metallic: 0, metalnessMeasured: true, metalShare: 0, metalnessP95: 0, normalTiltRmsDeg: 3, version: 2, statsSource: 'test', sourceSize: [1024, 1024] });
    // the bundle knows Bundled at lightness 50; the checkout's own files say Bundled is 70 and know LocalOnly
    fs.writeFileSync(path.join(lib, 'stats.json'), JSON.stringify({ version: 2, sets: { Bundled: stats(50) } }));
    fs.writeFileSync(path.join(local, 'Bundled.json'), JSON.stringify(stats(70)));
    fs.writeFileSync(path.join(local, 'LocalOnly.json'), JSON.stringify(stats(40)));
    return root;
}

describe('texture library statistics in a build', () => {
    const prior = process.env.SCRATCHBOX_LIBRARY_LOCAL_STATS;
    afterEach(() => { if (prior === undefined) delete process.env.SCRATCHBOX_LIBRARY_LOCAL_STATS; else process.env.SCRATCHBOX_LIBRARY_LOCAL_STATS = prior; });

    it('reads the committed bundle alone, ignores the checkout\'s own files, and measures nothing locally', async () => {
        delete process.env.SCRATCHBOX_LIBRARY_LOCAL_STATS;
        const root = checkout();
        const index = loadTextureLibraryIndex(root)!;
        const bundled = index.sets.find(e => e.id === 'Bundled')!, localOnly = index.sets.find(e => e.id === 'LocalOnly')!;
        expect(bundled.colour?.meanLab[0]).toBe(50);
        expect(localOnly.colour).toBeUndefined();
        expect(libraryEntryMeasured(root, 'Bundled')).toBe(true);
        expect(libraryEntryMeasured(root, 'LocalOnly')).toBe(false);
        const r = await measureLibraryEntries([localOnly], { repoRoot: root });
        expect(r.measured).toEqual([]);
        expect(r.failed).toEqual([{ id: 'LocalOnly', reason: expect.stringMatching(/builds do not measure sets locally/) }]);
    });

    it('with SCRATCHBOX_LIBRARY_LOCAL_STATS=1 (the maintainer\'s bundling flow) the checkout\'s own files win over the bundle', () => {
        process.env.SCRATCHBOX_LIBRARY_LOCAL_STATS = '1';
        const root = checkout();
        const index = loadTextureLibraryIndex(root)!;
        expect(index.sets.find(e => e.id === 'Bundled')!.colour?.meanLab[0]).toBe(70);
        expect(index.sets.find(e => e.id === 'LocalOnly')!.colour?.meanLab[0]).toBe(40);
        expect(libraryEntryMeasured(root, 'LocalOnly')).toBe(true);
    });
});
