/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tree measurement and SB-Veggie rebuilding on a real Google Photorealistic 3D Tiles photo extraction around the
 * Flatiron Building and Madison Square Park (40.7411, -73.9897; 120 m), checked against the NYC Parks Forestry tree
 * inventory (vendored trimmed subset: fixtures/nyc-forestry-trees-flatiron.json, provenance inside).
 *
 * The extraction is not in the repository (Google Maps Platform content). The suite reads it, without modifying it,
 * from SCRATCHBOX_FLATIRON_PHOTO_TILE, else public/models/flatiron_building_40.7411_-73.9897_120m.glb in this checkout
 * or in the main checkout this worktree belongs to, and is skipped when none exists. It copies the tile into a
 * temporary workspace, runs the whole location pipeline for real (tile_vegetation strip, tile_refine, plant) and writes
 * top-down and aerial clay screenshots to test-results/screenshots/tile_vegetation/ plus a measurement report to
 * test-results/tile_vegetation/flatiron_report.json.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationService, type TileVegetationStripResult } from '../src/node/3d-engine/tile-vegetation-service';
import { TileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { runLocationClayPipeline, type LocationClayResult } from '../src/node/3d-engine/location-clay-pipeline';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { readGlbTriangles, renderClayPng, type GlbTriangles } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const TILE_NAME = 'public/models/flatiron_building_40.7411_-73.9897_120m.glb';

/** The main checkout of this repository (a worktree's shared git directory's parent), when git can say. */
function mainCheckout(): string | undefined {
    try {
        const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
        return common ? path.dirname(common) : undefined;
    } catch {
        return undefined;
    }
}

const TILE = [process.env.SCRATCHBOX_FLATIRON_PHOTO_TILE, path.join(REPO, TILE_NAME), ...[mainCheckout()].filter(Boolean).map(m => path.join(m!, TILE_NAME))]
    .find((p): p is string => !!p && fs.existsSync(p)) ?? path.join(REPO, TILE_NAME);
const INVENTORY = path.join(__dirname, 'fixtures/nyc-forestry-trees-flatiron.json');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_vegetation');
const REPORT = path.join(REPO, 'test-results/tile_vegetation/flatiron_report.json');
const haveTile = fs.existsSync(TILE);

interface Trunk { x: number; z: number; dbhIn: number | null }

/** Inventory trunks in the tile frame (inverse of the extraction's localToEcef at its ground height). */
function trunksInTileFrame(frame: any): Trunk[] {
    const M: number[] = frame.localToEcef;
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
    const h = frame.anchor.ellipsoidalHeightM;
    const doc = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
    return doc.trees.filter((t: any) => t.condition !== 'Dead').map((t: any) => {
        const p = (t.lat * Math.PI) / 180, l = (t.lng * Math.PI) / 180;
        const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
        const E = [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - e2) + h) * Math.sin(p)];
        const d = [E[0] - M[12], E[1] - M[13], E[2] - M[14]];
        return { x: d[0] * M[0] + d[1] * M[1] + d[2] * M[2], z: d[0] * M[8] + d[1] * M[9] + d[2] * M[10], dbhIn: t.dbhIn };
    });
}

/** 0.5 m cells, inside the given cells, whose centre a triangle covers seen from above. */
function coveredCells(t: GlbTriangles, cells: Set<string>): Set<string> {
    const out = new Set<string>();
    const P = t.positions;
    for (let i = 0; i < t.indices.length; i += 3) {
        const a = t.indices[i] * 3, b = t.indices[i + 1] * 3, c = t.indices[i + 2] * 3;
        const d = (P[b] - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (P[b + 2] - P[a + 2]);
        if (Math.abs(d) < 1e-12) continue;
        const i0 = Math.floor(Math.min(P[a], P[b], P[c]) / 0.5), i1 = Math.floor(Math.max(P[a], P[b], P[c]) / 0.5);
        const k0 = Math.floor(Math.min(P[a + 2], P[b + 2], P[c + 2]) / 0.5), k1 = Math.floor(Math.max(P[a + 2], P[b + 2], P[c + 2]) / 0.5);
        for (let k = k0; k <= k1; k++) {
            for (let j = i0; j <= i1; j++) {
                const key = `${j},${k}`;
                if (!cells.has(key) || out.has(key)) continue;
                const x = (j + 0.5) * 0.5, z = (k + 0.5) * 0.5;
                const w1 = ((x - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (z - P[a + 2])) / d;
                const w2 = ((P[b] - P[a]) * (z - P[a + 2]) - (x - P[a]) * (P[b + 2] - P[a + 2])) / d;
                if (w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9) out.add(key);
            }
        }
    }
    return out;
}

function insideFootprint(c: any, x: number, z: number): boolean {
    const dx = x - c.stem[0], dz = z - c.stem[1];
    const s = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * 16) & 15;
    return Math.hypot(dx, dz) <= c.sectorRadii[s] + 0.5;
}

describe.skipIf(!haveTile)('tile vegetation on the Flatiron / Madison Square Park photo extraction', () => {
    let root: string;
    let strip: TileVegetationStripResult;
    let crownsDoc: any;
    let trees: any[];
    let trunks: Trunk[];
    let pipeline: LocationClayResult;

    beforeAll(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flatiron-veg-')));
        fs.copyFileSync(TILE, path.join(root, 'flatiron.glb'));
        const vegetation = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO });
        strip = await vegetation.strip({ tilePath: 'flatiron.glb', topDown: true });
        crownsDoc = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'));
        trees = crownsDoc.crowns.filter((c: any) => c.status === 'tree');
        // inventory trunks well inside the extraction (it reaches about 120 m from the anchor)
        trunks = trunksInTileFrame(crownsDoc.frame).filter(t => Math.hypot(t.x, t.z) <= 110);
        pipeline = await runLocationClayPipeline({ rawTilePath: path.join(root, 'flatiron.glb'), workspaceRoot: root, isolate: false, trees: true, flavour: 'clay', publishBase: 'flatiron' },
            { vegetation, refine: new TileRefineService({ workspaceRoot: root, repoRoot: REPO }) });
    }, 900_000);

    afterAll(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('measures crowns that register with the city tree inventory', () => {
        expect(crownsDoc.frame?.localToEcef).toHaveLength(16);
        expect(trees.length).toBeGreaterThanOrEqual(30);
        expect(trunks.length).toBeGreaterThanOrEqual(50);
        // registration: shifting the inventory in any direction (within 12 m) never fits the crowns better than
        // leaving it where it is, give or take 3 m (crowns are 5-15 m across and trunks rarely sit at their centre)
        let best = { dx: 0, dz: 0, n: -1 };
        const counts: number[] = [];
        for (let dx = -12; dx <= 12; dx++) {
            for (let dz = -12; dz <= 12; dz++) {
                const n = trunks.filter(t => trees.some(c => insideFootprint(c, t.x + dx, t.z + dz))).length;
                counts.push(n);
                if (n > best.n || (n === best.n && Math.hypot(dx, dz) < Math.hypot(best.dx, best.dz))) best = { dx, dz, n };
            }
        }
        counts.sort((a, b) => a - b);
        const atZero = trunks.filter(t => trees.some(c => insideFootprint(c, t.x, t.z))).length;
        expect(Math.hypot(best.dx, best.dz)).toBeLessThanOrEqual(3);
        expect(atZero).toBeGreaterThan(1.3 * counts[Math.floor(counts.length / 2)]);

        // one-to-one trunk <-> crown matching (a crown holding two trunks matches one)
        const pairs: Array<[number, number, number]> = [];
        trunks.forEach((t, i) => trees.forEach((c, j) => { if (insideFootprint(c, t.x, t.z)) pairs.push([Math.hypot(t.x - c.stem[0], t.z - c.stem[1]), i, j]); }));
        pairs.sort((a, b) => a[0] - b[0]);
        const ui = new Set<number>(), uj = new Set<number>();
        const offsets: number[] = [];
        const matchedHeights: number[] = [];
        for (const [d, i, j] of pairs) {
            if (ui.has(i) || uj.has(j)) continue;
            ui.add(i); uj.add(j);
            offsets.push(d);
            matchedHeights.push(trees[j].apexAboveSupport);
        }
        // precision over the crowns inside the same 110 m circle as the inventory trunks
        const treesInside = trees.filter(c => Math.hypot(c.stem[0], c.stem[1]) <= 110).length;
        const precision = ui.size / treesInside, recall = ui.size / trunks.length;
        const f1 = (2 * precision * recall) / (precision + recall);
        offsets.sort((a, b) => a - b);
        matchedHeights.sort((a, b) => a - b);
        const report = {
            tile: path.basename(TILE), trunks: trunks.length, trees: trees.length, crowns: crownsDoc.crowns.length,
            matched: ui.size, precision, recall, f1,
            medianStemOffsetM: offsets[Math.floor(offsets.length / 2)],
            medianMatchedHeightM: matchedHeights[Math.floor(matchedHeights.length / 2)],
            registrationBestShiftM: [best.dx, best.dz], trunksInsideTreeFootprints: atZero,
            strip: strip.stats
        };
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
        // floors under the values measured on 2026-10-14 (see the report): many inventory trees are
        // street saplings the photogrammetry never captured, and dense park canopy merges crowns
        expect(precision).toBeGreaterThanOrEqual(0.35);
        expect(recall).toBeGreaterThanOrEqual(0.25);
        expect(report.medianStemOffsetM).toBeLessThan(3);
        expect(report.medianMatchedHeightM).toBeGreaterThan(10);
        expect(report.medianMatchedHeightM).toBeLessThan(30);
    });

    it('measures every tree against the surface it stands on, and keeps the tile closed', () => {
        for (const c of crownsDoc.crowns) {
            expect(c.apexAboveSupport).toBeGreaterThanOrEqual(0);
            if (c.status === 'tree') expect(c.apexAboveSupport).toBeGreaterThanOrEqual(3);
        }
        // trees on roofs (support well above the terrain) exist only when they rise the minimum height above the roof
        const onRoofs = trees.filter(c => c.supportY - c.terrainY > 3);
        for (const c of onRoofs) expect(c.apexAboveSupport).toBeGreaterThanOrEqual(3);
        expect(strip.stats.openEdges.after).toBeLessThanOrEqual(strip.stats.openEdges.before);
        expect(strip.stats.triangles.removed).toBeGreaterThan(1000);

        // seen from above, the ground under every removed tree is closed: no footprint cell the scan covered is open
        // (open-edge counts alone miss a hole whose removal also took old tile seams with it)
        const cells = new Set<string>();
        for (const c of trees) {
            const r = Math.max(...c.sectorRadii) + 1;
            for (let k = Math.floor((c.stem[1] - r) / 0.5); k <= Math.floor((c.stem[1] + r) / 0.5); k++) {
                for (let j = Math.floor((c.stem[0] - r) / 0.5); j <= Math.floor((c.stem[0] + r) / 0.5); j++) {
                    if (insideFootprint(c, (j + 0.5) * 0.5, (k + 0.5) * 0.5)) cells.add(`${j},${k}`);
                }
            }
        }
        const before = coveredCells(readGlbTriangles(fs.readFileSync(path.join(root, 'flatiron.glb'))), cells);
        const after = coveredCells(readGlbTriangles(fs.readFileSync(strip.devegetatedGlb)), cells);
        const opened = [...before].filter(k => !after.has(k)).length;
        expect(before.size).toBeGreaterThan(5000);
        expect(opened / before.size).toBeLessThan(0.002);
    });

    it('runs the whole location pipeline: remeshed clay plus SB-Veggie trees within budget, with screenshots', () => {
        expect(pipeline.trees!.count).toBe(trees.length);
        expect(pipeline.trees!.triangles).toBeLessThanOrEqual(pipeline.trees!.triangleBudget);
        expect(pipeline.trees!.triangleBudget).toBe(Math.floor(pipeline.remesh.triangles! * 0.5));
        const clayFile = path.join(root, 'public', pipeline.url);
        const treesFile = path.join(root, 'public', pipeline.trees!.url!);
        const clay = readGlbTriangles(fs.readFileSync(clayFile));
        const grown = readGlbTriangles(fs.readFileSync(treesFile));
        expect(grown.nodeRanges).toHaveLength(trees.length);

        fs.mkdirSync(SHOTS, { recursive: true });
        // top-down measurement with the inventory trunks in cyan
        const img = decodePng(fs.readFileSync(strip.topDownPng!));
        const td = strip.stats.topDown;
        for (const t of trunks) {
            const i0 = Math.floor((t.x - td.x0) / td.cell), k0 = Math.floor((t.z - td.z0) / td.cell);
            for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
                const i = i0 + di, k = k0 + dk;
                if (i < 0 || k < 0 || i >= img.width || k >= img.height) continue;
                const o = (k * img.width + i) * 4;
                img.rgba[o] = 0; img.rgba[o + 1] = 255; img.rgba[o + 2] = 255;
            }
        }
        fs.writeFileSync(path.join(SHOTS, 'flatiron_topdown_measurement_vs_inventory.png'), encodePng(img.width, img.height, img.rgba));
        const park: [number, number, number, number] = [35, -120, 135, -15];
        const layers = [{ positions: clay.positions, indices: clay.indices }, { positions: grown.positions, indices: grown.indices, color: [0.45, 0.55, 0.45] as [number, number, number] }];
        const shots: Array<[string, Buffer]> = [
            ['flatiron_park_clay_trees_aerial.png', renderClayPng(layers, { kind: 'aerial', width: 1280, height: 860, region: park, bearingDeg: 300, elevationDeg: 55 })],
            ['flatiron_park_clay_trees_top.png', renderClayPng(layers, { kind: 'top', width: 1000, height: 1000, region: park })],
            ['flatiron_district_clay_trees_aerial.png', renderClayPng(layers, { kind: 'aerial', width: 1280, height: 860, bearingDeg: 200, elevationDeg: 40 })]
        ];
        for (const [name, png] of shots) {
            fs.writeFileSync(path.join(SHOTS, name), png);
            expect(png.length).toBeGreaterThan(20_000);
        }
    });
});
