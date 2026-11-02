/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every plane photographed face on (pipeline-k/plane-orthos.ts): a scan of a 16 m wall and a 16 m flat roof gives both
 * planes when no facade orthophoto covers them, the roof alone when the wall's does; a wall's t axis is up, a roof's
 * photo is filled from its own texels; a second call is the file as it was.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planeOrthos, PLANES_FILE } from '../src/node/3d-engine/staged-location/pipeline-k/plane-orthos';
import { decodePng } from '../src/node/texture-processing';
import { syntheticMaterialScan } from './helpers/synthetic-material-scan';

describe('pipeline K plane orthophotos', () => {
    it('photographs the planes no facade orthophoto covers, roofs included, once', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plane-orthos-'));
        try {
            const { glbPath } = await syntheticMaterialScan(work);
            const orthos = path.join(work, 'orthos');
            fs.mkdirSync(orthos);
            fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ facades: [] }));
            const all = await planeOrthos(glbPath, orthos);
            expect(all.cached).toBe(false);
            const kinds = all.file.planes.map(p => p.kind).sort();
            expect(kinds).toEqual(['roof', 'wall']);
            const wall = all.file.planes.find(p => p.kind === 'wall')!, roof = all.file.planes.find(p => p.kind === 'roof')!;
            expect(Math.abs(wall.axisT[1])).toBeGreaterThan(0.99);
            expect(Math.abs(roof.normal[1])).toBeGreaterThan(0.99);
            expect(roof.areaM2).toBe(256);
            expect(roof.width * roof.pixel).toBeCloseTo(16, 0);
            expect(roof.coverage).toBeGreaterThan(0.95);
            const img = decodePng(fs.readFileSync(path.join(orthos, roof.image)));
            expect([img.width, img.height]).toEqual([roof.width, roof.height]);
            // the roof's photo is its tile (dark red), filled
            const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
            expect(img.rgba[mid + 3]).toBe(255);
            expect(img.rgba[mid]).toBeGreaterThan(img.rgba[mid + 2] + 40);
            expect((await planeOrthos(glbPath, orthos)).cached).toBe(true);
            // the wall covered by a facade orthophoto: only the roof is photographed
            const covered = path.join(work, 'covered');
            fs.mkdirSync(covered);
            fs.writeFileSync(path.join(covered, 'facades.json'), JSON.stringify({ facades: [{ facadeId: 0, centroid: [8, 8, 0], normal: wall.normal, axisS: wall.axisS, axisT: wall.axisT, sMin: -8, sMax: 8, tMin: -8, tMax: 8 }] }));
            const some = await planeOrthos(glbPath, covered);
            expect(some.file.planes.map(p => p.kind)).toEqual(['roof']);
            expect(some.file.skipped.covered).toBe(1);
            expect(fs.existsSync(path.join(covered, PLANES_FILE))).toBe(true);
        } finally { fs.rmSync(work, { recursive: true, force: true }); }
    });
});
