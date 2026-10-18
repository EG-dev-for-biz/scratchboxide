/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Crown segmentation in tile_vegetation strip, on a synthetic photo-textured tile with known ground truth:
 * - one tree whose crown top has two bumps 3 m apart (further apart than the local-maximum window, so each bump is a
 *   marker), the lower bump rising ~0.3 m above the saddle between them: one crown, not two;
 * - two trees whose crowns touch, 9 m apart, the saddle between them ~4.6 m under the lower top: two crowns.
 * The top-down measurement image goes to test-results/screenshots/tile_vegetation/ (gitignored).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { buildSyntheticTile, type SyntheticTileSpec, type SyntheticTree } from './helpers/synthetic-textured-tile';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_vegetation');

const BUMPY: SyntheticTree[] = [
    { x: -10, z: 0, height: 10, radius: 5 },
    { x: -7, z: 0, height: 9.8, radius: 4.5 }
];
const PAIR: SyntheticTree[] = [
    { x: 6, z: -6, height: 10, radius: 5 },
    { x: 6, z: 3, height: 9, radius: 5 }
];
const SPEC: SyntheticTileSpec = {
    halfSize: 22,
    spacing: 0.75,
    trees: [...BUMPY, ...PAIR],
    curtains: [],
    anchor: { lat: 40.7411, lng: -73.9897, ellipsoidalHeightM: -22.5 }
};

let work = '';
let trees: any[] = [];

beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-vegetation-segmentation-'));
    fs.writeFileSync(path.join(work, 'tile.glb'), buildSyntheticTile(SPEC));
    const svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    const strip = await svc.strip({ tilePath: 'tile.glb', topDown: true });
    trees = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns.filter((c: any) => c.status === 'tree');
    fs.mkdirSync(SHOTS, { recursive: true });
    if (strip.topDownPng) fs.copyFileSync(strip.topDownPng, path.join(SHOTS, 'crown_segmentation_topdown.png'));
}, 600_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

const near = (t: SyntheticTree, r: number) => trees.filter(c => Math.hypot(c.apex[0] - t.x, c.apex[2] - t.z) < r);

describe('tile_vegetation crown segmentation', () => {
    it('measures one crown, not two, for a crown top with two bumps that barely rise above the saddle between them', () => {
        const cx = (BUMPY[0].x + BUMPY[1].x) / 2;
        const inBumpy = trees.filter(c => Math.hypot(c.stem[0] - cx, c.stem[1]) < 6);
        expect(inBumpy).toHaveLength(1);
        expect(Math.abs(inBumpy[0].apexAboveSupport - BUMPY[0].height)).toBeLessThan(0.8);
    });

    it('keeps two touching trees whose tops rise well above the saddle between them as two crowns', () => {
        for (const t of PAIR) {
            const c = near(t, 2.5);
            expect(c).toHaveLength(1);
            expect(Math.abs(c[0].apexAboveSupport - t.height)).toBeLessThan(0.8);
        }
        expect(trees).toHaveLength(3);
    });
});
