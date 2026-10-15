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
 * synthetic photo-textured tile and tile_refine stubbed (another suite owns it; its stats keep their real shape, and
 * the real TileRefineService checks the publish names). A stage that fails fails the whole request with that stage's
 * name, and nothing is published after it; a stopped request kills the native stage that is running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runLocationClayPipeline, describeLocationClay, describeTreeOutcome, locationPublishBase, glbMeshCounts, type LocationClayDeps } from '../src/node/3d-engine/location-clay-pipeline';
import { TileExtractionError } from '../src/common/errors/pipeline-errors';
import { SCENE_TREE_TRIANGLE_CAP, TileVegetationService, type TileVegetationPlantRequest, type TileVegetationStripRequest } from '../src/node/3d-engine/tile-vegetation-service';
import { TileRefineService, type TileRefineRequest, type TileRefineResult } from '../src/node/3d-engine/tile-refine-service';
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
            stats: { triangles: { input: 14_000, hidden: 0, droppedDegenerate: 0, kept: 14_000 }, outputs: { triangles: opts.outputTriangles ?? 20_000 } },
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

beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'location-clay-')));
    fs.writeFileSync(path.join(root, 'district.glb'), buildSyntheticTile(SPEC));
    fs.writeFileSync(path.join(root, 'bare.glb'), buildSyntheticTile({ ...SPEC, trees: [] }));
    fs.writeFileSync(path.join(root, 'corrupt.glb'), buildSyntheticTile({ ...SPEC, corruptTexture: true }));
    vegetation = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO });
    // the native build (or the wait for another worker's) is not part of any one test's time
    await vegetation.ensureBinary();
}, 900_000);

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
        // the budget comes from the measured trees (a target per crown), within the scene's cap: not from the buildings
        expect(r.trees).toMatchObject({ measured: 3, count: 3, notRegrowable: 0, keptAsScanned: [], cutAtBoundary: 0, belowMinHeight: 0, notOnStructure: 0, url: '/models/district_sbveggie_trees.glb' });
        expect(r.trees).toMatchObject({ triangleBudgetSource: 'crown_targets', sceneTriangleCap: SCENE_TREE_TRIANGLE_CAP });
        expect(r.trees!.triangleBudget).toBe(r.trees!.targetTriangles);
        expect(r.trees!.triangleBudget).toBeGreaterThanOrEqual(3 * 120);
        expect(r.trees!.triangles).toBeLessThanOrEqual(r.trees!.triangleBudget);
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
        expect(r.trees!.outcome).toBe('3 of 3 trees rebuilt as SB-Veggie; 0 left as scanned');
        expect(describeLocationClay(r, 'clay')).toContain(' 3 of 3 trees rebuilt as SB-Veggie; 0 left as scanned. The rebuilt trees (space colonisation, studio clay) fill');
        expect(describeLocationClay(r, 'clay')).toContain('(sized from the measured crowns)');
        // tile_refine reports its input as an object; the count, and the mounted model's own counts, are numbers
        expect(r.remesh.inputTriangles).toBe(14_000);
        expect(r.mounted).toEqual(glbMeshCounts(String(stub.calls[0].tilePath)));
        expect(describeLocationClay(r, 'clay')).toContain(`(14,000 -> ${r.mounted.triangles.toLocaleString()} triangles)`);
        expect(describeLocationClay(r, 'clay')).not.toContain('[object Object]');
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
        expect(err.message).toBe('Tile extraction failed at remesh: tile_refine did not converge');
        expect(publishedTrees()).toEqual(before);
    });

    it('fails at the vegetation stage, and never remeshes, when a photo texture is corrupt', async () => {
        const stub = refineStub();
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'corrupt.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'corrupt' }, deps(stub)).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.stage).toBe('vegetation');
        expect(err.message).toContain('Tile extraction failed at vegetation: photo texture');
        // and says how to get the location without its trees
        expect(err.message).toContain('ask again with trees false for the remeshed tiles without rebuilt trees');
        expect(stub.calls).toHaveLength(0);
    });

    it('rebuilds the trees of a hillside with no level surface, and returns a treeless hillside with zero trees', async () => {
        const slope = 0.36; // 20 degrees: every surface tilted, so the tile has no level ground or roof anywhere
        fs.writeFileSync(path.join(root, 'hillside.glb'), buildSyntheticTile({ ...SPEC, trees: SPEC.trees.slice(0, 2), slope }));
        fs.writeFileSync(path.join(root, 'hillside_bare.glb'), buildSyntheticTile({ ...SPEC, trees: [], slope }));
        const stub = refineStub();
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'hillside.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'hillside' }, deps(stub));
        expect(stub.calls).toHaveLength(1);
        expect(r.trees).toMatchObject({ measured: 2, count: 2, url: '/models/hillside_sbveggie_trees.glb' });
        // each tree stands on the slope where it was measured
        const crowns = JSON.parse(fs.readFileSync(r.trees!.crownsJson, 'utf8')).crowns;
        for (const c of crowns) expect(Math.abs(c.supportY - slope * c.stem[0])).toBeLessThan(0.1);
        expect(describeLocationClay(r, 'clay')).toContain('2 of 2 trees rebuilt as SB-Veggie; 0 left as scanned');
        const bare = await runLocationClayPipeline({ rawTilePath: path.join(root, 'hillside_bare.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'hillside_bare' }, deps(refineStub()));
        expect(bare.trees).toMatchObject({ measured: 0, count: 0, canopyAreaM2: 0 });
        expect(describeLocationClay(bare, 'clay')).toContain('No tree canopy was measured in the photo tiles, so no trees were added.');
    });

    it('sizes the trees\' budget from the measured trees, however few triangles the remeshed tile has', async () => {
        // the budget used to be half the remeshed tile's triangles: 150 here, which cannot hold 3 trees
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'few_building_triangles' },
            deps(refineStub({ outputTriangles: 300 })));
        expect(r.trees).toMatchObject({ count: 3, triangleBudgetSource: 'crown_targets' });
        expect(r.trees!.triangleBudget).toBeGreaterThan(300);
    });

    it('fails at the planting stage when the measured trees need more than the scene cap, and says how to ask for fewer or a budget', async () => {
        const before = publishedTrees();
        // the real native plant, held to a cap of 300 triangles (the scene cap is 1,500,000: it takes 12,501 trees to
        // exceed it), so its own message is the one the pipeline explains
        const capped: LocationClayDeps = {
            vegetation: { strip: req => vegetation.strip(req), plant: (req: TileVegetationPlantRequest) => vegetation.plant({ ...req, sceneTriangleCap: req.sceneTriangleCap === undefined ? undefined : 300 }) },
            refine: refineStub().refine
        };
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'over_cap' }, capped).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.stage).toBe('planting');
        expect(err.message).toBe("Tile extraction failed at planting: the 3 measured trees need at least 360 triangles at 120 each, more than the scene's cap of 300 triangles for trees. Ask again with a smaller radiusMeters (fewer trees), or with treeTriangleBudget set to at least that many triangles to go over the cap, or with trees false.");
        expect(publishedTrees()).toEqual(before);
    });

    it('keeps a measured tree it cannot regrow as scanned, says which and why, and still mounts the scene', async () => {
        // the strip regrows every tree before removing anything; with the crown base inferred at 99 % of each tree's
        // height, the two lower crowns have no measured surface above it, so no tree can be grown into them
        const stub = refineStub();
        const kept: LocationClayDeps = {
            vegetation: { strip: (req: TileVegetationStripRequest) => vegetation.strip({ ...req, params: { crownBaseRatio: 0.99 } }), plant: req => vegetation.plant(req) },
            refine: stub.refine
        };
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'kept_scanned' }, kept);
        expect(r.url).toBe('/models/kept_scanned_sbveggie_refined_clay.glb');
        expect(r.trees).toMatchObject({ measured: 3, count: 1, notRegrowable: 2, url: '/models/kept_scanned_sbveggie_trees.glb' });
        expect(r.trees!.keptAsScanned).toHaveLength(2);
        for (const k of r.trees!.keptAsScanned) {
            expect(k.reasonCode).toBe('no_crown_above_base');
            expect(k.reason).toContain('above its inferred crown base');
            expect(k.colonisation).toBeUndefined();
        }
        const ids = r.trees!.keptAsScanned.map(k => k.crownId);
        expect(r.trees!.outcome).toMatch(new RegExp(`^1 of 3 trees rebuilt as SB-Veggie; 2 left as scanned: crown ${ids[0]} \\(\\d+ m², [\\d.]+ m tall\\), (none|only)`));
        expect(r.trees!.outcome).toContain(`; crown ${ids[1]} (`);
        const text = describeLocationClay(r, 'clay');
        expect(text).toContain(` ${r.trees!.outcome}.`);
        // a scanned tree is never described as rebuilt: one tree model node, the trees left in the scan in the remesh input
        expect(readGlbTriangles(fs.readFileSync(path.join(root, 'public', 'models', 'kept_scanned_sbveggie_trees.glb'))).nodeRanges).toHaveLength(1);
        const crowns = JSON.parse(fs.readFileSync(r.trees!.crownsJson, 'utf8')).crowns;
        expect(crowns.filter((c: any) => c.status === 'not_regrowable').map((c: any) => c.id).sort()).toEqual([...ids].sort());
    });

    it('returns the tiles with every tree as scanned, and says so, when none can be regrown', async () => {
        const stub = refineStub();
        const none: LocationClayDeps = {
            vegetation: { strip: (req: TileVegetationStripRequest) => vegetation.strip({ ...req, params: { crownBaseRatio: 0.9999 } }), plant: req => vegetation.plant(req) },
            refine: stub.refine
        };
        const before = publishedTrees();
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'none_regrown' }, none);
        expect(r.url).toBe('/models/none_regrown_sbveggie_refined_clay.glb');
        expect(r.trees).toMatchObject({ count: 0, notRegrowable: r.trees!.measured });
        expect(r.trees!.measured).toBeGreaterThan(0);
        expect(r.trees!.url).toBeUndefined();
        expect(r.trees!.strip.removedTriangles).toBe(0);
        expect(publishedTrees()).toEqual(before);
        const text = describeLocationClay(r, 'clay');
        expect(text).toContain(` 0 of ${r.trees!.measured} trees rebuilt as SB-Veggie; ${r.trees!.measured} left as scanned: crown `);
        expect(text).toContain('No trees model was added.');
        expect(text).not.toContain('Where trees were taken out');
    });

    it('plants within the budget the request gives (treeTriangleBudget) instead of the share of the remeshed tile', async () => {
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'own_budget', treeTriangleBudget: 2_400 },
            deps(refineStub({ outputTriangles: 300 })));
        expect(r.trees).toMatchObject({ count: 3, triangleBudget: 2_400 });
        expect(r.trees!.triangles).toBeLessThanOrEqual(2_400);
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'own_budget_small', treeTriangleBudget: 200 },
            deps(refineStub())).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.message).toContain('the budget was the treeTriangleBudget asked for');
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
        // what the request is about is the structure: measured counts the trees standing on it, and the summary (and the
        // artifact summary, which carries only the outcome) says how many in the district do not
        expect(r.trees).toMatchObject({ measured: 1, count: 1, notOnStructure: 2, onIsolatedStructure: true, keptAsScanned: [] });
        expect(r.trees!.outcome).toBe('1 of 1 trees on the isolated structure rebuilt as SB-Veggie; 0 left as scanned; 2 measured trees in the extracted district do not stand on it');
        expect(describeLocationClay(r, 'clay')).toContain(` ${r.trees!.outcome}.`);
        // the canopy reported for the trees is the planted tree's own measured crown, not the district's
        const measured = JSON.parse(fs.readFileSync(r.trees!.crownsJson, 'utf8')).crowns.filter((c: any) => c.status === 'tree');
        const plantedCrown = measured.reduce((best: any, c: any) => (Math.hypot(c.stem[0], c.stem[1]) < Math.hypot(best.stem[0], best.stem[1]) ? c : best));
        expect(r.trees!.treeCanopyAreaM2).toBeCloseTo(plantedCrown.areaM2, 6);
        expect(r.trees!.measuredTreeCanopyAreaM2).toBeCloseTo(measured.reduce((a: number, c: any) => a + c.areaM2, 0), 6);
        expect(r.trees!.treeCanopyAreaM2).toBeLessThan(0.6 * r.trees!.measuredTreeCanopyAreaM2);
        expect(describeLocationClay(r, 'clay')).toContain(`fill ${Math.round(plantedCrown.areaM2)} m² of measured crown`);
        // what was measured and closed over the whole extraction is said to be about the district, not the structure
        expect(describeLocationClay(r, 'clay')).toContain('In the extracted district around it: Where trees were taken out, the ground was rebuilt');

        // a structure with no measured tree on it: the summary says so, and does not claim no crown measures as a tree
        const away = path.join(root, 'isolated_away.glb');
        fs.writeFileSync(away, buildSyntheticTile({ halfSize: 3, spacing: 1, trees: [] }));
        const none = await runLocationClayPipeline({ rawTilePath: shifted, workspaceRoot: root, isolate: true, trees: true, flavour: 'clay', publishBase: 'iso_none' },
            deps(refineStub({ clayGlb: shiftPatch(away, 40, 40) })));
        expect(none.trees).toMatchObject({ measured: 0, count: 0, notOnStructure: 3 });
        expect(none.trees!.outcome).toBe('none of the 3 measured trees in the extracted district stands on the isolated structure, so no trees were added to it');
        const text = describeLocationClay(none, 'clay');
        expect(text).toContain('The photo tiles show 3 measured trees in the extracted district, none standing on the isolated structure, so no trees were added to it.');
        expect(text).not.toContain('no crown that measures as a tree');
    });

    it('isolate: names only the trees kept as scanned that stand on the isolated structure', async () => {
        // the strip keeps the two lower crowns as scanned (no measured surface above a crown base at 99 % of their
        // height); only the one at the origin stands on the 12 m patch, and only it is named
        const patch = path.join(root, 'isolated_patch_kept.glb');
        fs.writeFileSync(patch, buildSyntheticTile({ halfSize: 6, spacing: 1, trees: [] }));
        const shifted = path.join(root, 'shifted_district_kept.glb');
        fs.writeFileSync(shifted, buildSyntheticTile({ ...SPEC, trees: SPEC.trees.map(t => ({ ...t, x: t.x + 12, z: t.z + 10 })), building: undefined }));
        const kept: LocationClayDeps = {
            vegetation: { strip: (req: TileVegetationStripRequest) => vegetation.strip({ ...req, params: { crownBaseRatio: 0.99 } }), plant: req => vegetation.plant(req) },
            refine: refineStub({ clayGlb: patch }).refine
        };
        const r = await runLocationClayPipeline({ rawTilePath: shifted, workspaceRoot: root, isolate: true, trees: true, flavour: 'clay', publishBase: 'iso_kept' }, kept);
        const crowns = JSON.parse(fs.readFileSync(r.trees!.crownsJson, 'utf8')).crowns;
        const onPatch = crowns.filter((c: any) => (c.status === 'tree' || c.status === 'not_regrowable') && Math.abs(c.stem[0]) < 6 && Math.abs(c.stem[1]) < 6);
        expect(onPatch).toHaveLength(1);
        expect(onPatch[0].status).toBe('not_regrowable');
        expect(r.trees!.keptAsScanned.map(k => k.crownId)).toEqual([onPatch[0].id]);
        expect(r.trees).toMatchObject({ measured: 1, count: 0, notRegrowable: 1, notOnStructure: 2 });
        expect(r.trees!.outcome).toMatch(new RegExp(`^0 of 1 trees on the isolated structure rebuilt as SB-Veggie; 1 left as scanned: crown ${onPatch[0].id} \\(.*; 2 measured trees in the extracted district do not stand on it$`));
        for (const c of crowns.filter((k: any) => k.id !== onPatch[0].id)) expect(r.trees!.outcome).not.toContain(`crown ${c.id} (`);
    });

    it('publishes under names tile_refine accepts, whatever the extraction was called', async () => {
        const refineRule = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
        const names = [
            'district',
            'flatiron_building_40.74110_-73.98970_r250_textured',             // W1's default (lat/lng key)
            'flatiron_building_175_5th_ave_new_york_ny_10010_usa_textured',   // a long address
            '..__weird name__..'
        ];
        const seen = new Set<string>();
        for (const n of names) {
            for (const [isolate, trees] of [[false, false], [false, true], [true, true]] as const) {
                const base = locationPublishBase(n, isolate, trees);
                expect(base).toMatch(refineRule);
                seen.add(base);
            }
        }
        expect(seen.size).toBe(names.length * 3);
        expect(locationPublishBase('district', false, true)).toBe('district_sbveggie');

        // the real TileRefineService validates the name before anything runs; a run that gets past it stops at an
        // impossible timeout instead, so no binary is built and nothing is remeshed here
        const real = new TileRefineService({ workspaceRoot: root, repoRoot: REPO });
        const probe: LocationClayDeps = { vegetation, refine: { refine: req => real.refine({ ...req, timeoutMs: 0 }) } };
        for (const n of names.slice(1)) {
            const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'district.glb'), workspaceRoot: root, isolate: true, trees: true, flavour: 'clay', publishBase: n }, probe).catch(e => e);
            expect(err).toBeInstanceOf(TileExtractionError);
            expect(err.stage).toBe('remesh');
            expect(err.message).toContain('timeoutMs must be > 0');
            expect(err.message).not.toContain('publishAs');
        }
    });

    it('reports what happens at the extraction edge and how the ground was closed', async () => {
        const edgeSpec: SyntheticTileSpec = {
            halfSize: 30, spacing: 0.75,
            trees: [
                { x: -24, z: -18, height: 12, radius: 6.5 },   // runs past the edge, top inside: rebuilt up to the edge
                { x: 20, z: 12, height: 12, radius: 5.5 },     // joined at height to the next one
                { x: 29.5, z: 12, height: 12, radius: 6 },     // top on the edge: cut, joined to a removed tree: taken
                { x: 2, z: 28.5, height: 9, radius: 4 }        // top on the edge, alone: kept as scanned
            ]
        };
        fs.writeFileSync(path.join(root, 'edge.glb'), buildSyntheticTile(edgeSpec));
        const r = await runLocationClayPipeline({ rawTilePath: path.join(root, 'edge.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'edge' }, deps(refineStub()));
        expect(r.trees).toMatchObject({ measured: 2, count: 2, reachingBoundary: 1, cutAtBoundary: 1, cutRemoved: 1 });
        expect(r.trees!.cutCanopyRemovedM2).toBeGreaterThan(20);
        const text = describeLocationClay(r, 'clay');
        expect(text).toContain('2 of 2 trees rebuilt as SB-Veggie; 0 left as scanned. The rebuilt trees (space colonisation, studio clay) fill');
        expect(text).toContain("(1 of them runs to the extraction's edge and was rebuilt up to it)");
        expect(text).toContain('Kept as scanned: 1 crown cut by the extraction boundary (its top lies outside it)');
        expect(text).toContain('Taken out with the trees it was joined to, and not rebuilt (its trunk lies outside the extraction): 1 cut crown');
        // nothing stood over the rebuilt ground here, so nothing was continued down to it
        expect(text).toContain('Where trees were taken out, the ground was rebuilt on the surface they stood on.');
        expect(text).not.toContain('continued straight down');
    });

    it('says when it continued walls the trees hid down to the rebuilt ground, and how much', () => {
        const base = { url: '/models/x_refined_clay.glb', glbPath: 'x', isolate: false, mounted: { vertices: 4, triangles: 2 }, remesh: { publishAs: 'x', ms: 1000, cached: false, stats: {} }, timingsMs: { remesh: 1, total: 1 } };
        const trees = {
            measured: 1, count: 1, triangles: 500, triangleBudget: 1000, canopyAreaM2: 40, measuredTreeCanopyAreaM2: 30, treeCanopyAreaM2: 30, reachingBoundary: 0,
            cutAtBoundary: 0, cutRemoved: 0, cutCanopyRemovedM2: 0, belowMinHeight: 1, notOnStructure: 0, smallCanopyPatches: 0, canopyTakenWithTreesM2: 0, crownsJson: 'c', inferred: {},
            strip: { removedTriangles: 900, skirtAreaM2: { onWalls: 120.4, onLevelSurfaces: 0, onKeptCanopy: 3.2, onOther: 400 }, skirtMaxHeightM: { onWalls: 18.04, onLevelSurfaces: 0, onKeptCanopy: 2.5, onOther: 26.3 } },
            ms: { strip: 1, plant: 1 }, url: '/models/x_trees.glb'
        };
        const text = describeLocationClay({ ...base, trees } as any, 'clay');
        // each skirt is named for what it hangs on: only the ones on walls are called walls
        expect(text).toContain('walls and building sides the trees hid were continued straight down to that ground (120 m², up to 18.0 m tall; not in the scan)');
        expect(text).toContain('the edges of other surfaces left standing over it were closed down to it (400 m², up to 26.3 m tall; not in the scan)');
        expect(text).toContain('the sides of plantings and trees kept as scanned were closed down to it (3 m², up to 2.5 m tall; not in the scan)');
        expect(text).not.toContain('level surfaces left standing');
    });

    it('reports crowns kept as scanned because no ground could be measured around them', () => {
        const base = { url: '/models/x_refined_clay.glb', glbPath: 'x', isolate: false, mounted: { vertices: 4, triangles: 2 }, remesh: { publishAs: 'x', ms: 1000, cached: false, stats: {} }, timingsMs: { remesh: 1, total: 1 } };
        const trees = {
            measured: 0, count: 0, triangles: 0, triangleBudget: 0, canopyAreaM2: 40, measuredTreeCanopyAreaM2: 0, treeCanopyAreaM2: 0, reachingBoundary: 0,
            cutAtBoundary: 0, cutRemoved: 0, cutCanopyRemovedM2: 0, belowMinHeight: 0, noMeasuredGround: 2, notOnStructure: 0, smallCanopyPatches: 0, canopyTakenWithTreesM2: 0, crownsJson: 'c', inferred: {},
            strip: { removedTriangles: 0 }, ms: { strip: 1, plant: 1 }
        };
        const text = describeLocationClay({ ...base, trees } as any, 'clay');
        expect(text).toContain('Kept as scanned: 2 crowns with no ground measurable around them (no surface gentle enough to stand on, such as a steep slope).');
        // crowns hanging below the level patches measured around them (canopy tops) with nothing standable under them
        const hanging = describeLocationClay({ ...base, trees: { ...trees, noMeasuredGround: 3, hangingBelowSupport: 2, supportedUnderStem: 5 } } as any, 'clay');
        expect(hanging).toContain('Kept as scanned: 3 crowns with no ground measurable for them: 1 with no surface gentle enough to stand on around it, such as a steep slope; 2 hanging below the level surfaces measured around them (canopy tops, not ground) with nothing standable under their stems.');
        expect(hanging).toContain('5 crowns stand on the ground the scan has under their stems, not on the level surfaces measured around them: those were canopy tops (their crowns hung below them, or nothing standable lay between them and the ground).');
    });

    it('names, by crown, a tree kept as scanned with the side closed beside it, and rebuilt trees short of their crown or off the mounted ground', () => {
        const outcome = describeTreeOutcome({
            count: 2, measured: 3,
            keptAsScanned: [{ crownId: 230, reasonCode: 'crown_not_reached', reason: "the regrown tree's leaves reach 47% of its measured crown surface", areaM2: 84.25, heightM: 5.87, closedSide: { areaM2: 284.7, topY: 9.48, bottomY: -0.53 } }],
            shortOfCrown: [{ crownId: 12, crownSurfaceReached: 0.776, budget: 120, reason: 'within its budget of 120 triangles its 5 leaf masses reach 77.6% of its measured crown surface' }],
            offGround: [{ crownId: 40, gapM: 0.8 }, { crownId: 41, gapM: -2.25 }, { crownId: 42, gapM: null }, { crownId: 43, gapM: 17.7 }],
            groundToleranceM: 0.5
        });
        expect(outcome).toBe("2 of 3 trees rebuilt as SB-Veggie; 1 left as scanned: crown 230 (84 m², 5.9 m tall), the regrown tree's leaves reach 47% of its measured crown surface; "
            + 'where the trees beside it were taken out, its side was closed down to their ground with 285 m² of clay wall from 9.5 m down to -0.5 m (not in the scan); '
            + '1 rebuilt tree does not fill its measured crown within its budget: crown 12, within its budget of 120 triangles its 5 leaf masses reach 77.6% of its measured crown surface; '
            + '4 rebuilt trees stand more than 0.5 m off the mounted model at their trunk bases, measured under each stem: '
            + 'crown 42 (no mounted surface under its stem), crown 43 (17.7 m above it), crown 41 (2.3 m under it), crown 40 (0.8 m above it)');
    });

    it('a stopped request stops only itself: another request sharing the same native run still gets its result', async () => {
        const shared = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO, cacheDir: 'cache_shared' });
        await shared.ensureBinary();
        fs.writeFileSync(path.join(root, 'shared.glb'), buildSyntheticTile({ ...SPEC, halfSize: 100, spacing: 0.5 }));
        const stopA = new AbortController();
        const a = shared.strip({ tilePath: 'shared.glb', signal: stopA.signal }).catch(e => e);
        const b = shared.strip({ tilePath: 'shared.glb' });
        setTimeout(() => stopA.abort(), 250);
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra?.name).toBe('AbortError');
        expect(rb.cached).toBe(false);
        expect(fs.existsSync(rb.devegetatedGlb)).toBe(true);
        expect(rb.stats.ok).toBe(true);

        // when every request on a run stops, the run is killed, and the next identical request starts its own
        const solo = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO, cacheDir: 'cache_shared_all' });
        const c1 = new AbortController(), c2 = new AbortController();
        const p1 = solo.strip({ tilePath: 'shared.glb', signal: c1.signal }).catch(e => e);
        const p2 = solo.strip({ tilePath: 'shared.glb', signal: c2.signal }).catch(e => e);
        setTimeout(() => { c1.abort(); c2.abort(); }, 250);
        expect((await p1)?.name).toBe('AbortError');
        expect((await p2)?.name).toBe('AbortError');
        const again = await solo.strip({ tilePath: 'shared.glb' });
        expect(again.cached).toBe(false);
        expect(again.stats.ok).toBe(true);
    }, 300_000);

    it('a stopped request kills the running native stage and publishes nothing', async () => {
        const fresh = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO, cacheDir: 'cache_abort' });
        await fresh.ensureBinary();
        // a large tile (about 320,000 triangles), so the native strip is still running when the request stops
        fs.writeFileSync(path.join(root, 'abort.glb'), buildSyntheticTile({ ...SPEC, halfSize: 100, spacing: 0.5 }));
        const controller = new AbortController();
        const stub = refineStub();
        const started = Date.now();
        setTimeout(() => controller.abort(), 250);
        const err = await runLocationClayPipeline({ rawTilePath: path.join(root, 'abort.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'abort', signal: controller.signal },
            { vegetation: fresh, refine: stub.refine }).catch(e => e);
        expect(err?.name).toBe('AbortError');
        expect(stub.calls).toHaveLength(0);
        // the strip was killed, not run to the end: no finished cache entry
        const cacheDir = path.join(root, 'cache_abort');
        const finished = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter(d => fs.existsSync(path.join(cacheDir, d, 'done.json'))) : [];
        expect(finished).toEqual([]);
        expect(Date.now() - started).toBeLessThan(5_000);
    });
});

/** A copy of a GLB moved by (dx, dz) through its root node, so a support patch can be placed away from the trees. */
function shiftPatch(file: string, dx: number, dz: number): string {
    const buf = fs.readFileSync(file);
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
    const binStart = 20 + jsonLength;
    // move the positions themselves (the native reader takes positions as written)
    const bin = Buffer.from(buf.subarray(binStart + 8));
    for (const mesh of json.meshes) {
        for (const prim of mesh.primitives) {
            const acc = json.accessors[prim.attributes.POSITION];
            const view = json.bufferViews[acc.bufferView];
            const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
            for (let v = 0; v < acc.count; v++) {
                bin.writeFloatLE(bin.readFloatLE(off + v * 12) + dx, off + v * 12);
                bin.writeFloatLE(bin.readFloatLE(off + v * 12 + 8) + dz, off + v * 12 + 8);
            }
            acc.min = [acc.min[0] + dx, acc.min[1], acc.min[2] + dz];
            acc.max = [acc.max[0] + dx, acc.max[1], acc.max[2] + dz];
        }
    }
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'latin1');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    const out = file.replace(/\.glb$/, `_shifted_${dx}_${dz}.glb`);
    fs.writeFileSync(out, Buffer.concat([header, jh, jsonBuf, bh, bin]));
    return out;
}
