/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The location pipeline on a real Google Photorealistic 3D Tiles photo extraction of Central Park (40.78256,
 * -73.96558; 250 m radius): 941 measured trees on 172,388 triangles of remeshed tile, the request that failed at
 * planting twice (a budget of half the tile's triangles could not hold the trees; with a larger one, "crown 657 did
 * not grow into its measured crown").
 *
 * The extraction is not in the repository (Google Maps Platform content). The suite reads it, without modifying it,
 * from SCRATCHBOX_CENTRAL_PARK_PHOTO_TILE, else public/models/central_park_40.78256_-73.96558_r250_textured.glb in this
 * checkout (gitignored) or in the main checkout this worktree belongs to, and is skipped when none exists. It copies
 * the tile into a temporary workspace, runs the whole location pipeline for real (tile_vegetation strip, tile_refine,
 * plant) with no budget given, and writes top-down and aerial clay screenshots to
 * test-results/screenshots/tile_vegetation/central_park_*.png plus a report to
 * test-results/tile_vegetation/central_park_report.json.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SCENE_TREE_TRIANGLE_CAP, TileVegetationService, type TileVegetationStripResult } from '../src/node/3d-engine/tile-vegetation-service';
import { TileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { describeLocationClay, runLocationClayPipeline, type LocationClayResult } from '../src/node/3d-engine/location-clay-pipeline';
import { readGlbTriangles, renderClayPng, type GlbTriangles } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const TILE_NAME = 'public/models/central_park_40.78256_-73.96558_r250_textured.glb';

/** The main checkout of this repository (a worktree's shared git directory's parent), when git can say. */
function mainCheckout(): string | undefined {
    try {
        const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
        return common ? path.dirname(common) : undefined;
    } catch {
        return undefined;
    }
}

const TILE = [process.env.SCRATCHBOX_CENTRAL_PARK_PHOTO_TILE, path.join(REPO, TILE_NAME), ...[mainCheckout()].filter(Boolean).map(m => path.join(m!, TILE_NAME))]
    .find((p): p is string => !!p && fs.existsSync(p)) ?? path.join(REPO, TILE_NAME);
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_vegetation');
const REPORT = path.join(REPO, 'test-results/tile_vegetation/central_park_report.json');
const haveTile = fs.existsSync(TILE);

/** Vertices of one node range of a GLB read with readGlbTriangles. */
function nodeVertices(t: GlbTriangles, range: { firstTriangle: number; triangleCount: number }): number[][] {
    const out: number[][] = [];
    for (let i = range.firstTriangle * 3; i < (range.firstTriangle + range.triangleCount) * 3; i++) {
        const v = t.indices[i];
        out.push([t.positions[v * 3], t.positions[v * 3 + 1], t.positions[v * 3 + 2]]);
    }
    return out;
}

/** Triangles whose centroid lies within `r` (horizontally) of (x, z) and above `minY`. */
function trianglesNear(t: GlbTriangles, x: number, z: number, r: number, minY: number): number {
    let n = 0;
    for (let i = 0; i < t.indices.length; i += 3) {
        let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < 3; j++) { const v = t.indices[i + j]; cx += t.positions[v * 3] / 3; cy += t.positions[v * 3 + 1] / 3; cz += t.positions[v * 3 + 2] / 3; }
        if (Math.abs(cx - x) <= r && Math.abs(cz - z) <= r && Math.hypot(cx - x, cz - z) <= r && cy > minY) n++;
    }
    return n;
}

describe.skipIf(!haveTile)('tile vegetation on the Central Park photo extraction (941 measured trees)', () => {
    let root: string;
    let pipeline: LocationClayResult;
    let crownsDoc: any;
    let strip: TileVegetationStripResult;
    const ms: Record<string, number> = {};

    beforeAll(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'central-park-veg-')));
        fs.copyFileSync(TILE, path.join(root, 'central_park.glb'));
        const vegetation = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO });
        const refine = new TileRefineService({ workspaceRoot: root, repoRoot: REPO });
        // the native builds are not part of the pipeline's time
        await vegetation.ensureBinary();
        const t0 = Date.now();
        pipeline = await runLocationClayPipeline({ rawTilePath: path.join(root, 'central_park.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'central_park' },
            { vegetation, refine });
        ms.pipeline = Date.now() - t0;
        crownsDoc = JSON.parse(fs.readFileSync(pipeline.trees!.crownsJson, 'utf8'));
        // the same strip again, cached, with its top-down measurement (a separate cache entry: measured once more)
        strip = await vegetation.strip({ tilePath: 'central_park.glb', topDown: true });
    }, 1_800_000);

    afterAll(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('rebuilds the measured trees without a budget of its own, each tree it could not regrow left as scanned and named', () => {
        const t = pipeline.trees!;
        const trees = crownsDoc.crowns.filter((c: any) => c.status === 'tree');
        const kept = crownsDoc.crowns.filter((c: any) => c.status === 'not_regrowable');
        // the measurement: 941 crowns measured as trees in this extraction
        expect(t.measured).toBe(941);
        expect(t.measured).toBe(trees.length + kept.length);
        expect(t.count).toBe(trees.length);
        expect(t.notRegrowable).toBe(kept.length);
        // nearly all regrow; any that does not is named with its reason, and the summary says so
        expect(kept.length).toBeLessThanOrEqual(Math.ceil(0.01 * t.measured));
        expect(t.keptAsScanned.map(k => k.crownId).sort((a, b) => a - b)).toEqual(kept.map((c: any) => c.id).sort((a: number, b: number) => a - b));
        for (const k of t.keptAsScanned) {
            expect(k.reason.length).toBeGreaterThan(20);
            expect(k.colonisation ?? k.reasonCode).toBeTruthy();
        }
        expect(t.outcome.startsWith(`${t.count} of ${t.measured} trees rebuilt as SB-Veggie; ${kept.length} left as scanned`)).toBe(true);
        const text = describeLocationClay(pipeline, 'clay');
        expect(text).toContain(` ${t.outcome}.`);
        // the crowns that failed before regrow now (657 and 846: the trunk stopped short of the crown)
        for (const id of [657, 846]) expect(trees.some((c: any) => c.id === id)).toBe(true);
        // the budget: from the measured crowns, within the scene's cap, never from the remeshed tile
        expect(t.triangleBudgetSource).toMatch(/^crown_targets/);
        expect(t.triangleBudget).toBe(Math.min(t.targetTriangles!, SCENE_TREE_TRIANGLE_CAP));
        expect(t.triangles).toBeLessThanOrEqual(SCENE_TREE_TRIANGLE_CAP);
        expect(t.triangles).toBeGreaterThan(941 * 120);
    });

    it('grows each tree at its measured spot, on its ground, into its measured crown', () => {
        const t = pipeline.trees!;
        const grown = readGlbTriangles(fs.readFileSync(path.join(root, 'public', t.url!)));
        const byId = new Map<number, any>(crownsDoc.crowns.map((c: any) => [c.id, c]));
        expect(grown.nodeRanges).toHaveLength(t.count);
        let worstBase = 0, worstTop = 0, worstSpread = 0, lowestShare = 1;
        for (const range of grown.nodeRanges) {
            const c = byId.get(range.extras.crownId);
            expect(c.status).toBe('tree');
            const verts = nodeVertices(grown, range);
            let minY = Infinity, maxY = -Infinity, maxR = 0, base: number[] = [];
            for (const v of verts) {
                if (v[1] < minY) { minY = v[1]; base = v; }
                maxY = Math.max(maxY, v[1]);
                maxR = Math.max(maxR, Math.hypot(v[0] - c.stem[0], v[2] - c.stem[1]));
            }
            // the trunk stands on the measured ground at the measured stem
            worstBase = Math.max(worstBase, Math.abs(minY - c.supportY));
            expect(Math.hypot(base[0] - c.stem[0], base[2] - c.stem[1])).toBeLessThan(1.0);
            // the leaves reach the measured apex, and no further
            worstTop = Math.max(worstTop, c.apex[1] - maxY);
            expect(maxY).toBeLessThan(c.apex[1] + 0.5);
            // and the tree stays within its measured footprint
            worstSpread = Math.max(worstSpread, maxR - Math.max(...c.sectorRadii));
            lowestShare = Math.min(lowestShare, range.extras.crownSurfaceReached);
        }
        expect(worstBase).toBeLessThan(0.6);
        expect(worstTop).toBeLessThan(3.0);
        expect(worstSpread).toBeLessThan(1.5);
        expect(lowestShare).toBeGreaterThanOrEqual(0.9);
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, JSON.stringify({
            tile: path.basename(TILE), outcome: t.outcome, keptAsScanned: t.keptAsScanned, measured: t.measured, rebuilt: t.count,
            triangles: t.triangles, triangleBudget: t.triangleBudget, triangleBudgetSource: t.triangleBudgetSource, targetTriangles: t.targetTriangles,
            treesGlbBytes: fs.statSync(path.join(root, 'public', t.url!)).size, remesh: { triangles: pipeline.remesh.triangles, inputTriangles: pipeline.remesh.inputTriangles },
            timingsMs: pipeline.timingsMs, worstBaseOffGroundM: worstBase, worstTopBelowApexM: worstTop, worstSpreadBeyondFootprintM: worstSpread, lowestCrownSurfaceReached: lowestShare,
            summary: describeLocationClay(pipeline, 'clay')
        }, null, 2));
    });

    it('keeps the scan of a tree it could not regrow in the tile, untouched', () => {
        const kept = crownsDoc.crowns.filter((c: any) => c.status === 'not_regrowable');
        if (!kept.length) return;
        const raw = readGlbTriangles(fs.readFileSync(path.join(root, 'central_park.glb')));
        const devegetated = readGlbTriangles(fs.readFileSync(path.join(path.dirname(pipeline.trees!.crownsJson), 'devegetated.glb')));
        for (const c of kept) {
            const r = 0.5 * Math.min(...c.sectorRadii);
            const scanned = trianglesNear(raw, c.stem[0], c.stem[1], r, c.supportY + 1);
            expect(scanned).toBeGreaterThan(10);
            expect(trianglesNear(devegetated, c.stem[0], c.stem[1], r, c.supportY + 1)).toBe(scanned);
        }
    });

    it('writes top-down and aerial clay screenshots of the rebuilt park', () => {
        const t = pipeline.trees!;
        const clay = readGlbTriangles(fs.readFileSync(path.join(root, 'public', pipeline.url)));
        const grown = readGlbTriangles(fs.readFileSync(path.join(root, 'public', t.url!)));
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.copyFileSync(strip.topDownPng!, path.join(SHOTS, 'central_park_topdown_measurement.png'));
        // trees tinted green to tell them apart from the remeshed tile; as mounted both are studio clay
        const tinted = [{ positions: clay.positions, indices: clay.indices }, { positions: grown.positions, indices: grown.indices, color: [0.45, 0.55, 0.45] as [number, number, number] }];
        const allClay = [{ positions: clay.positions, indices: clay.indices }, { positions: grown.positions, indices: grown.indices }];
        // a close look, from the side, at the trees that failed before (657 and 846, in orange, the other trees left
        // out so they do not hide it), and at whatever stays as scanned (nothing grown there)
        const at = (id: number, half: number): [number, number, number, number] => {
            const c = crownsDoc.crowns.find((k: any) => k.id === id);
            return [c.stem[0] - half, c.stem[1] - half, c.stem[0] + half, c.stem[1] + half];
        };
        const alone = (id: number) => {
            const range = grown.nodeRanges.find(r => r.extras?.crownId === id)!;
            const idx = grown.indices.slice(range.firstTriangle * 3, (range.firstTriangle + range.triangleCount) * 3);
            return [{ positions: clay.positions, indices: clay.indices }, { positions: grown.positions, indices: idx, color: [0.85, 0.55, 0.25] as [number, number, number] }];
        };
        const shots: Array<[string, Buffer]> = [
            ['central_park_rebuilt_top.png', renderClayPng(tinted, { kind: 'top', width: 1400, height: 1400 })],
            ['central_park_rebuilt_aerial.png', renderClayPng(tinted, { kind: 'aerial', width: 1600, height: 1000, bearingDeg: 200, elevationDeg: 35 })],
            ['central_park_all_clay_aerial.png', renderClayPng(allClay, { kind: 'aerial', width: 1600, height: 1000, bearingDeg: 200, elevationDeg: 35 })],
            ['central_park_crown_657_side.png', renderClayPng(alone(657), { kind: 'aerial', width: 1200, height: 800, region: at(657, 30), bearingDeg: 160, elevationDeg: 8 })],
            ['central_park_crown_846_side.png', renderClayPng(alone(846), { kind: 'aerial', width: 1200, height: 800, region: at(846, 30), bearingDeg: 200, elevationDeg: 8 })]
        ];
        for (const k of t.keptAsScanned.slice(0, 3)) {
            shots.push([`central_park_kept_as_scanned_${k.crownId}_aerial.png`, renderClayPng(tinted, { kind: 'aerial', width: 1280, height: 860, region: at(k.crownId, 40), bearingDeg: 200, elevationDeg: 45 })]);
        }
        for (const [name, png] of shots) {
            fs.writeFileSync(path.join(SHOTS, name), png);
            expect(png.readUInt32BE(0)).toBe(0x89504e47);
            expect(png.length).toBeGreaterThan(20_000);
        }
    });
});
