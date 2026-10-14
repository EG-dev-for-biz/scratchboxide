/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The location clay pipeline (measure trees -> remesh -> plant) with the real native tile_vegetation stages on a
 * synthetic photo-textured tile and tile_refine stubbed (another suite owns it). A stage that fails fails the whole
 * request with that stage's name, and nothing is published after it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLocationClayPipeline, describeLocationClay, TileExtractionError, type LocationClayDeps } from '../src/node/3d-engine/location-clay-pipeline';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import type { TileRefineRequest, TileRefineResult } from '../src/node/3d-engine/tile-refine-service';
import { buildSyntheticTile, type SyntheticTileSpec } from './helpers/synthetic-textured-tile';
import { readGlbTriangles } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SPEC: SyntheticTileSpec = {
    halfSize: 30,
    spacing: 0.75,
    trees: [
        { x: -12, z: -10, height: 11, radius: 4.5 },
        { x: 10, z: 12, height: 8, radius: 3.5 },
        { x: -14, z: 14, height: 14, radius: 5.5 }
    ],
    building: { x0: 4, z0: -16, x1: 16, z1: -4, height: 15 }
};

let root: string;
let vegetation: TileVegetationService;

/** tile_refine stand-in: "remeshes" by returning the tile it was given, with the stats the pipeline reads. */
function refineStub(opts: { outputTriangles?: number; fail?: string; clayGlb?: string } = {}) {
    const calls: TileRefineRequest[] = [];
    const refine = async (req: TileRefineRequest): Promise<TileRefineResult> => {
        calls.push(req);
        if (opts.fail) throw new Error(opts.fail);
        const tile = path.resolve(root, String(req.tilePath));
        return {
            texturedGlb: tile,
            clayGlb: opts.clayGlb ?? tile,
            stats: { triangles: 14_000, outputs: { triangles: opts.outputTriangles ?? 20_000 } },
            cached: false,
            ms: 1_500,
            cacheKey: 'stub',
            published: { urls: { clay: `/models/${req.publishAs}_refined_clay.glb`, textured: `/models/${req.publishAs}_refined.glb` }, backups: [] },
            binary: { path: 'stub', built: false }
        } as TileRefineResult;
    };
    return { refine: { refine }, calls };
}

function deps(stub: ReturnType<typeof refineStub>): LocationClayDeps {
    return { vegetation, refine: stub.refine };
}

function publishedTrees(): string[] {
    const dir = path.join(root, 'public', 'models');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('_trees.glb')) : [];
}

beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'location-clay-')));
    fs.writeFileSync(path.join(root, 'district.glb'), buildSyntheticTile(SPEC));
    fs.writeFileSync(path.join(root, 'bare.glb'), buildSyntheticTile({ ...SPEC, trees: [] }));
    fs.writeFileSync(path.join(root, 'corrupt.glb'), buildSyntheticTile({ ...SPEC, corruptTexture: true }));
    vegetation = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO });
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('runLocationClayPipeline', () => {
    it('measures the trees, remeshes what is left and plants SB-Veggie trees in the same frame', async () => {
        const stub = refineStub();
        const progress: string[] = [];
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'district', reportProgress: m => progress.push(m) }, deps(stub));
        // tile_refine ran on the devegetated tile, not the raw one
        expect(stub.calls).toHaveLength(1);
        expect(String(stub.calls[0].tilePath)).toMatch(/devegetated\.glb$/);
        expect(stub.calls[0].publishAs).toBe('district_sbveggie');
        expect(r.url).toBe('/models/district_sbveggie_refined_clay.glb');
        expect(r.trees).toMatchObject({ count: 3, triangleBudget: 10_000, cutAtBoundary: 0, belowMinHeight: 0, notOnStructure: 0, url: '/models/district_sbveggie_trees.glb' });
        expect(r.trees!.triangles).toBeLessThanOrEqual(10_000);
        expect(r.trees!.canopyAreaM2).toBeGreaterThan(150);
        expect(r.trees!.inferred).toMatchObject({ crownBaseRatio: 0.35, trunkRadiusPerHeight: 0.016 });
        const published = path.join(root, 'public', 'models', 'district_sbveggie_trees.glb');
        const trees = readGlbTriangles(fs.readFileSync(published));
        expect(trees.indices.length / 3).toBe(r.trees!.triangles);
        expect(trees.nodeRanges).toHaveLength(3);
        expect(r.timingsMs.vegetation).toBeGreaterThanOrEqual(0);
        expect(r.timingsMs.planting).toBeGreaterThanOrEqual(0);
        expect(progress.join(' | ')).toContain('Measuring the trees');
        expect(progress.join(' | ')).toContain('Growing 3 SB-Veggie trees');
        expect(describeLocationClay(r, 'clay')).toContain('Rebuilt 3 measured trees as SB-Veggie trees');
    });

    it('reports a tile without canopy as zero trees and publishes no trees model', async () => {
        const before = publishedTrees();
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'bare.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'bare' }, deps(refineStub()));
        expect(r.trees).toMatchObject({ count: 0, canopyAreaM2: 0 });
        expect(r.trees!.url).toBeUndefined();
        expect(publishedTrees()).toEqual(before);
        expect(describeLocationClay(r, 'clay')).toContain('No tree canopy was measured in the photo tiles, so no trees were added.');
    });

    it('fails at the remesh stage, and plants nothing, when tile_refine fails', async () => {
        const before = publishedTrees();
        const stub = refineStub({ fail: 'tile_refine did not converge' });
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'remesh_fail' }, deps(stub)).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.stage).toBe('remesh');
        expect(err.message).toBe('remesh failed: tile_refine did not converge');
        expect(publishedTrees()).toEqual(before);
    });

    it('fails at the vegetation stage, and never remeshes, when a photo texture is corrupt', async () => {
        const stub = refineStub();
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'corrupt.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'corrupt' }, deps(stub)).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.stage).toBe('vegetation');
        expect(err.message).toContain('vegetation failed: photo texture');
        expect(stub.calls).toHaveLength(0);
    });

    it('fails at the planting stage when the remeshed tile leaves too small a budget for the trees', async () => {
        const before = publishedTrees();
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'tiny_budget' }, deps(refineStub({ outputTriangles: 300 }))).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.stage).toBe('planting');
        expect(err.message).toContain('cannot hold 3 trees');
        expect(publishedTrees()).toEqual(before);
    });

    it('skips the trees entirely when they are not asked for', async () => {
        const stub = refineStub();
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: false, flavour: 'textured', publishBase: 'textured_only' }, deps(stub));
        expect(String(stub.calls[0].tilePath)).toBe(path.join(root, 'district.glb'));
        expect(r.trees).toBeUndefined();
        expect(r.url).toBe('/models/textured_only_refined.glb');
    });

    it('isolate: plants only the measured trees that stand on the isolated structure', async () => {
        // the "isolated" remesh is a 12 m ground patch at the origin; the district is moved so that only the first
        // tree (-12, -10) stands on it
        const patch = path.join(root, 'isolated_patch.glb');
        fs.writeFileSync(patch, buildSyntheticTile({ halfSize: 6, spacing: 1, trees: [] }));
        const shifted = path.join(root, 'shifted_district.glb');
        fs.writeFileSync(shifted, buildSyntheticTile({ ...SPEC, trees: SPEC.trees.map(t => ({ ...t, x: t.x + 12, z: t.z + 10 })), building: undefined }));
        const r = await runLocationClayPipeline({ rawTilePath: shifted, workspaceRoot: root, isolate: true, trees: true, flavour: 'clay', publishBase: 'iso' },
            deps(refineStub({ clayGlb: patch })));
        expect(r.isolate).toBe(true);
        expect(r.trees).toMatchObject({ count: 1, notOnStructure: 2 });
        expect(describeLocationClay(r, 'clay')).toContain('2 trees not standing on the isolated structure (left out)');
    });
});
