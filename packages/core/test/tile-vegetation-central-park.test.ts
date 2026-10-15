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
 * -73.96558; 250 m radius), the request that failed at planting twice (a budget of half the tile's triangles could not
 * hold the trees; with a larger one, "crown 657 did not grow into its measured crown").
 *
 * What the pipeline says is checked against what it delivers, measured here from its outputs with code of this suite's
 * own: every rebuilt tree's leaf masses against its measured crown (read back from the trees GLB), every trunk base
 * against the mounted remeshed clay (a vertical line through the stem), and the scan of anything kept as scanned against
 * the raw extraction.
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
import { crownSurfaceAboveBase, foliageReach, readTreeFoliage } from './helpers/foliage-reach';

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

/** Heights at which vertical lines meet a mesh (2 m buckets over its triangles). */
function verticalProbe(t: GlbTriangles): (x: number, z: number) => number[] {
    const P = t.positions, I = t.indices, cell = 2;
    const buckets = new Map<string, number[]>();
    for (let f = 0; f < I.length / 3; f++) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let j = 0; j < 3; j++) { const v = I[3 * f + j]; x0 = Math.min(x0, P[3 * v]); x1 = Math.max(x1, P[3 * v]); z0 = Math.min(z0, P[3 * v + 2]); z1 = Math.max(z1, P[3 * v + 2]); }
        for (let a = Math.floor(x0 / cell); a <= Math.floor(x1 / cell); a++) {
            for (let b = Math.floor(z0 / cell); b <= Math.floor(z1 / cell); b++) {
                const k = `${a},${b}`;
                (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(f);
            }
        }
    }
    return (x, z) => {
        const out: number[] = [];
        for (const f of buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
            const [a, b, c] = [I[3 * f], I[3 * f + 1], I[3 * f + 2]];
            const ax = P[3 * a], az = P[3 * a + 2], bx = P[3 * b], bz = P[3 * b + 2], cx = P[3 * c], cz = P[3 * c + 2];
            const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
            if (Math.abs(d) < 1e-12) continue;
            const w1 = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / d, w2 = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / d, w0 = 1 - w1 - w2;
            if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
            out.push(w0 * P[3 * a + 1] + w1 * P[3 * b + 1] + w2 * P[3 * c + 1]);
        }
        return out;
    };
}

/** Is (x, z) inside a crown's footprint (its 16 sector radii around the stem), shrunk by `inset` metres? */
function insideFootprint(c: any, x: number, z: number, inset = 0): boolean {
    const dx = x - c.stem[0], dz = z - c.stem[1];
    const s = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * 16) & 15;
    return Math.hypot(dx, dz) <= c.sectorRadii[s] - inset;
}

/** Triangles (as sorted vertex-position keys) whose centroid lies inside a crown's footprint (inset) and above minY. */
function trianglesInCrown(t: GlbTriangles, c: any, inset: number, minY: number): Set<string> {
    const out = new Set<string>();
    const r = Math.max(...c.sectorRadii);
    for (let i = 0; i < t.indices.length; i += 3) {
        const v = [0, 1, 2].map(j => t.indices[i + j] * 3);
        const cx = v.reduce((a, o) => a + t.positions[o], 0) / 3, cy = v.reduce((a, o) => a + t.positions[o + 1], 0) / 3, cz = v.reduce((a, o) => a + t.positions[o + 2], 0) / 3;
        if (Math.abs(cx - c.stem[0]) > r || Math.abs(cz - c.stem[1]) > r || cy <= minY || !insideFootprint(c, cx, cz, inset)) continue;
        out.add(v.map(o => [t.positions[o], t.positions[o + 1], t.positions[o + 2]].map(n => n.toFixed(3)).join(',')).sort().join('|'));
    }
    return out;
}

describe.skipIf(!haveTile)('tile vegetation on the Central Park photo extraction', () => {
    let root: string;
    let pipeline: LocationClayResult;
    let crownsDoc: any;
    let strip: TileVegetationStripResult;
    const ms: Record<string, number> = {};
    const report: Record<string, unknown> = {};

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
        if (pipeline) {
            fs.mkdirSync(path.dirname(REPORT), { recursive: true });
            fs.writeFileSync(REPORT, JSON.stringify({ tile: path.basename(TILE), timingsMs: pipeline?.timingsMs, pipelineMs: ms.pipeline, ...report, summary: pipeline ? describeLocationClay(pipeline, 'clay') : undefined }, null, 2));
        }
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('rebuilds the measured trees without a budget of its own; any tree it could not regrow is left as scanned and named', () => {
        const t = pipeline.trees!;
        const trees = crownsDoc.crowns.filter((c: any) => c.status === 'tree');
        const kept = crownsDoc.crowns.filter((c: any) => c.status === 'not_regrowable');
        expect(t.measured).toBe(trees.length + kept.length);
        expect(t.count).toBe(trees.length);
        expect(t.notRegrowable).toBe(kept.length);
        expect(t.measured).toBeGreaterThan(900);
        // nearly all regrow (with the perception radius spanning the kill reach, every one of these does, on any seed);
        // any that does not is named with its reason, and the summary says so
        expect(kept.length).toBeLessThanOrEqual(Math.ceil(0.01 * t.measured));
        expect(t.keptAsScanned.map(k => k.crownId).sort((a, b) => a - b)).toEqual(kept.map((c: any) => c.id).sort((a: number, b: number) => a - b));
        for (const k of t.keptAsScanned) expect(k.reason.length).toBeGreaterThan(20);
        expect(t.outcome.startsWith(`${t.count.toLocaleString()} of ${t.measured.toLocaleString()} trees rebuilt as SB-Veggie; ${kept.length} left as scanned`)).toBe(true);
        expect(describeLocationClay(pipeline, 'clay')).toContain(` ${t.outcome}.`);
        // the crowns that failed before regrow now: 657 and 846 (the trunk stopped short of the crown), and 1139 (kept
        // as scanned at 89 % with the tile's seed and regrown at 99.5 % with others: colonisation stranded attractors it
        // could no longer see; it also hung 27 m below the canopy it was measured standing on)
        for (const id of [657, 846, 1139]) expect(trees.some((c: any) => c.id === id)).toBe(true);
        // the budget: from the measured crowns, within the scene's cap, never from the remeshed tile
        expect(t.triangleBudgetSource).toMatch(/^crown_targets/);
        expect(t.triangleBudget).toBe(Math.min(t.targetTriangles!, SCENE_TREE_TRIANGLE_CAP));
        expect(t.triangles).toBeLessThanOrEqual(SCENE_TREE_TRIANGLE_CAP);
        expect(t.triangles).toBeGreaterThan(t.count * 120);
        report.outcome = t.outcome;
        report.keptAsScanned = t.keptAsScanned;
        Object.assign(report, { measured: t.measured, rebuilt: t.count, triangles: t.triangles, triangleBudget: t.triangleBudget, triangleBudgetSource: t.triangleBudgetSource, targetTriangles: t.targetTriangles });
    });

    it('stands crowns that hang below the canopy they were measured on on the ground the scan has under them', () => {
        const t = pipeline.trees!;
        const under = crownsDoc.crowns.filter((c: any) => c.supportSource === 'under_stem');
        expect(t.supportedUnderStem).toBe(under.length);
        // Central Park's continuous canopy: level patches of canopy tops around a crown are no ground
        expect(under.length).toBeGreaterThanOrEqual(50);
        let hung = 0, onlyGround = 0;
        for (const c of under) {
            // either its crown hung below the level patches around it, or under its stem the scan has nothing standable
            // between its crown and the ground the terrain model has there
            if (/^\d+% of its measured crown lies more than 1\.0 m below the surface measured around it/.test(c.supportNote)) hung++;
            else {
                expect(c.supportNote).toMatch(/^the surfaces around it stand at -?[\d.]+ m, but under its stem the scan has nothing standable between its crown and the ground/);
                expect(Math.abs(c.supportY - c.terrainY)).toBeLessThanOrEqual(2);
                onlyGround++;
            }
            // the crown does not hang below what it stands on now
            const below = c.samples.filter((s: number[]) => s[1] < c.supportY - 1).length / c.samples.length;
            expect(below).toBeLessThanOrEqual(0.1);
        }
        expect(hung).toBeGreaterThan(0);
        expect(onlyGround).toBeGreaterThan(0);
        report.supportedUnderStemHung = hung;
        report.supportedUnderStemOnlyGround = onlyGround;
        // crown 704 (support measured on canopy at 25.45 m, its own crown down to 8.2 m, ground under its stem at -0.2 m)
        const c704 = crownsDoc.crowns.find((c: any) => c.id === 704);
        expect(c704.supportSource).toBe('under_stem');
        expect(c704.supportY).toBeLessThan(1);
        report.supportedUnderStem = under.length;
        report.noMeasuredGround = t.noMeasuredGround;
        report.hangingBelowSupport = t.hangingBelowSupport;
    });

    it('delivers each tree into its measured crown: its leaf masses, read from the trees model, reach it as the result says', () => {
        const t = pipeline.trees!;
        const glb = path.join(root, 'public', t.url!);
        const byId = new Map<number, any>(crownsDoc.crowns.map((c: any) => [c.id, c]));
        const ratio = crownsDoc.growth.crownBaseRatio;
        const short = new Set(t.shortOfCrown.map(k => k.crownId));
        let lowest = 1, worstTop = -Infinity, worstAgree = 0, below90 = 0;
        const foliage = readTreeFoliage(fs.readFileSync(glb));
        expect(foliage).toHaveLength(t.count);
        for (const f of foliage) {
            const c = byId.get(f.crownId);
            expect(c.status).toBe('tree');
            const d = foliageReach(f, f.extras.foliageClumps, crownSurfaceAboveBase(c, ratio), f.extras.reachM);
            lowest = Math.min(lowest, d.share);
            worstTop = Math.max(worstTop, c.apex[1] - (d.topY + f.extras.reachM));
            worstAgree = Math.max(worstAgree, Math.abs(d.share - f.extras.crownSurfaceReached));
            const fills = d.share >= crownsDoc.growth.minSurfaceReached && d.topY + f.extras.reachM >= c.apex[1];
            if (d.share < 0.9) below90++;
            // a tree short of its crown is reported, and only then
            expect(short.has(f.crownId)).toBe(!fills);
        }
        expect(worstAgree).toBeLessThan(0.02);
        // no budget given and room under the cap for what the leaves need: every tree's leaves fill its crown
        expect(t.shortOfCrown).toEqual([]);
        expect(below90).toBe(0);
        expect(lowest).toBeGreaterThanOrEqual(0.9);
        expect(worstTop).toBeLessThanOrEqual(0);
        expect(t.lowestCrownSurfaceReached).toBeGreaterThanOrEqual(0.9);
        Object.assign(report, { lowestDeliveredCrownSurfaceReached: lowest, worstLeavesTopShortOfApexM: worstTop, deliveredVsReportedMaxDiff: worstAgree });
    });

    it('measures every trunk base against the mounted clay, and reports each one off it', () => {
        const t = pipeline.trees!;
        const grown = readGlbTriangles(fs.readFileSync(path.join(root, 'public', t.url!)));
        const mounted = readGlbTriangles(fs.readFileSync(path.join(root, 'public', pipeline.url)));
        const heightsAt = verticalProbe(mounted);
        const byId = new Map<number, any>(crownsDoc.crowns.map((c: any) => [c.id, c]));
        const tol = t.groundToleranceM ?? 0.5;
        const reported = new Map(t.offGround.map(k => [k.crownId, k.gapM]));
        let floating = 0, buried = 0, none = 0, disagreements = 0, worstBase = 0;
        const gaps: number[] = [];
        for (const range of grown.nodeRanges) {
            const c = byId.get(range.extras.crownId);
            // the trunk stands at its measured stem, on its measured support ...
            let minY = Infinity, base: number[] = [];
            for (const v of nodeVertices(grown, range)) if (v[1] < minY) { minY = v[1]; base = v; }
            worstBase = Math.max(worstBase, Math.abs(minY - c.supportY));
            expect(Math.hypot(base[0] - c.stem[0], base[2] - c.stem[1])).toBeLessThan(1.0);
            // ... and that support against the clay that is mounted, under the stem
            const hs = heightsAt(c.stem[0], c.stem[1]);
            const gap = hs.length ? hs.map(h => c.supportY - h).reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)) : null;
            if (gap === null) none++;
            else { gaps.push(Math.abs(gap)); if (gap > tol) floating++; if (gap < -tol) buried++; }
            const off = gap === null || Math.abs(gap) > tol;
            // the pipeline's own measurement agrees (away from the tolerance's edge, where float rounding decides)
            if (gap === null || Math.abs(Math.abs(gap) - tol) > 0.02) {
                if (off !== reported.has(c.id)) disagreements++;
                if (off && gap !== null && reported.get(c.id) !== null) expect(Math.abs((reported.get(c.id) as number) - gap)).toBeLessThan(0.02);
            }
        }
        expect(worstBase).toBeLessThan(0.6);
        expect(disagreements).toBe(0);
        // every tree off the mounted ground is named in the outcome (the first five, then the rest by crown id)
        if (t.offGround.length) {
            expect(t.outcome).toContain(`${t.offGround.length.toLocaleString()} rebuilt tree${t.offGround.length === 1 ? ' stands' : 's stand'} more than ${tol} m off the mounted model`);
            const named = new Set<number>();
            for (const m of t.outcome.matchAll(/crown (\d+) \(/g)) named.add(Number(m[1]));
            for (const m of t.outcome.matchAll(/\(crowns ([\d, ]+)\)/g)) for (const id of m[1].split(', ')) named.add(Number(id));
            for (const k of t.offGround) expect(named.has(k.crownId)).toBe(true);
        }
        gaps.sort((a, b) => a - b);
        Object.assign(report, {
            offMountedGround: { reported: t.offGround.length, floatingAbove: floating, buriedUnder: buried, noSurfaceUnderStem: none, toleranceM: tol,
                p90GapM: gaps[Math.floor(0.9 * (gaps.length - 1))], maxGapM: gaps[gaps.length - 1] },
            worstBaseOffSupportM: worstBase
        });
    });

    it('keeps the scan of any tree it could not regrow in the tile, untouched, and names the side closed beside it', () => {
        const kept = crownsDoc.crowns.filter((c: any) => c.status === 'not_regrowable');
        if (!kept.length) return;
        const raw = readGlbTriangles(fs.readFileSync(path.join(root, 'central_park.glb')));
        const devegetated = readGlbTriangles(fs.readFileSync(path.join(path.dirname(pipeline.trees!.crownsJson), 'devegetated.glb')));
        for (const c of kept) {
            // every raw triangle over its footprint (1 m in from its edge) and above its ground is still there, unchanged
            const scanned = trianglesInCrown(raw, c, 1, c.supportY + 0.5);
            const after = trianglesInCrown(devegetated, c, 1, c.supportY + 0.5);
            expect(scanned.size).toBeGreaterThan(10);
            for (const k of scanned) expect(after.has(k)).toBe(true);
            const entry = pipeline.trees!.keptAsScanned.find(k => k.crownId === c.id)!;
            if (c.keptSkirt) expect(entry.closedSide).toEqual({ areaM2: c.keptSkirt.areaM2, topY: c.keptSkirt.topY, bottomY: c.keptSkirt.bottomY });
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
        // a close look, from the side, at single trees (in orange, the other trees left out so they do not hide it):
        // the two that failed before, one that hung below the canopy it was measured on, and the tree furthest off
        // the mounted ground
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
            ['central_park_crown_846_side.png', renderClayPng(alone(846), { kind: 'aerial', width: 1200, height: 800, region: at(846, 30), bearingDeg: 200, elevationDeg: 8 })],
            ['central_park_crown_704_side.png', renderClayPng(alone(704), { kind: 'aerial', width: 1200, height: 800, region: at(704, 35), bearingDeg: 200, elevationDeg: 8 })]
        ];
        const worst = [...t.offGround].sort((a, b) => (b.gapM === null ? Infinity : Math.abs(b.gapM)) - (a.gapM === null ? Infinity : Math.abs(a.gapM)))[0];
        if (worst) shots.push([`central_park_off_ground_crown_${worst.crownId}_side.png`, renderClayPng(alone(worst.crownId), { kind: 'aerial', width: 1200, height: 800, region: at(worst.crownId, 30), bearingDeg: 200, elevationDeg: 8 })]);
        for (const k of t.keptAsScanned.slice(0, 3)) {
            shots.push([`central_park_kept_as_scanned_${k.crownId}_aerial.png`, renderClayPng(tinted, { kind: 'aerial', width: 1280, height: 860, region: at(k.crownId, 40), bearingDeg: 200, elevationDeg: 45 })]);
        }
        for (const [name, png] of shots) {
            fs.writeFileSync(path.join(SHOTS, name), png);
            expect(png.readUInt32BE(0)).toBe(0x89504e47);
            expect(png.length).toBeGreaterThan(20_000);
        }
        report.screenshots = shots.map(([name]) => path.join(SHOTS, name));
        report.treesGlbBytes = fs.statSync(path.join(root, 'public', t.url!)).size;
        report.remesh = { triangles: pipeline.remesh.triangles, inputTriangles: pipeline.remesh.inputTriangles };
        report.skirts = t.strip;
    });
});
