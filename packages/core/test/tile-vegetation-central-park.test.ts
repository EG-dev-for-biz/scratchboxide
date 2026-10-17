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
import { parseGlb, readAccessor, readGlbTriangles, renderClayPng, type GlbTriangles } from './helpers/clay-glb-render';
import { validateContract } from '../src/common/spatial/staged-location-contracts';
import { readStagedGlb } from './helpers/staged-glb-read';
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

    it('stands every trunk on what the scan shows under its crown, and on the ground rebuilt under its stem', () => {
        const t = pipeline.trees!;
        const tol = crownsDoc.params.groundTolerance ?? 0.5;
        const band = 1.5;
        const trees = crownsDoc.crowns.filter((c: any) => c.status === 'tree');
        const under = crownsDoc.crowns.filter((c: any) => c.supportSource === 'under_stem');
        expect(t.supportedUnderStem).toBe(under.length);
        // Central Park's continuous canopy: the level patches around many crowns are canopy tops, a path below a mound,
        // the street beside a terrace; the scan shows the ground under them
        expect(under.length).toBeGreaterThanOrEqual(50);
        let shownUnder = 0, moved = 0, aroundOnly = 0;
        for (const c of trees) {
            const surfaces: number[][] = c.supportEvidence.surfaces;
            // what it stands on is a surface the scan shows under its footprint (facing up, not canopy) ...
            if (c.supportSource === 'under_stem' || c.supportSource === 'under_footprint') {
                if (c.supportMovedM === undefined) expect(surfaces.some(([y]) => Math.abs(y - c.supportY) < 1e-6)).toBe(true);
                shownUnder++;
            } else {
                expect(c.supportSource).toBe('surrounding_surface');
                aroundOnly++;
            }
            // ... and the ground rebuilt (or kept) under its stem holds it; a trunk stood onto that ground was stood there
            // only where the scan shows that surface under the crown (or around it), within the support band
            expect(Math.abs(c.groundAtStemY - c.supportY)).toBeLessThanOrEqual(tol + 1e-6);
            if (c.supportMovedM !== undefined) {
                moved++;
                const near = (y: number) => Math.abs(y - c.groundAtStemY) <= band;
                expect(surfaces.some(([y]) => near(y)) || (c.surroundingY !== undefined && near(c.surroundingY)) || Math.abs(c.supportMovedM) <= band).toBe(true);
            }
            // the crown does not hang below what it stands on
            const below = c.samples.filter((s: number[]) => s[1] < c.supportY - 1).length / c.samples.length;
            expect(below).toBeLessThanOrEqual(0.1);
        }
        // crown 704 (canopy at 25.45 m around it, its own crown down to 8.2 m): on the ground under its stem
        const c704 = crownsDoc.crowns.find((c: any) => c.id === 704);
        expect(c704.supportSource).toBe('under_stem');
        expect(c704.supportY).toBeLessThan(1);
        // the five furthest off the mounted ground before this criterion (17.7, 17.4, 12.1, 11.3 and 10.4 m above it):
        // each stands on the lowest upward-facing surface the raw scan has under its stem, the ground there
        const rawTiles = readGlbTriangles(fs.readFileSync(path.join(root, 'central_park.glb')));
        const groundUnder = (x: number, z: number): number => {
            const P = rawTiles.positions, I = rawTiles.indices;
            let lowest = Infinity;
            for (let f = 0; f < I.length / 3; f++) {
                const [a, b, cc] = [I[3 * f], I[3 * f + 1], I[3 * f + 2]];
                const ax = P[3 * a], az = P[3 * a + 2], bx = P[3 * b], bz = P[3 * b + 2], cx = P[3 * cc], cz = P[3 * cc + 2];
                if (Math.max(ax, bx, cx) < x || Math.min(ax, bx, cx) > x || Math.max(az, bz, cz) < z || Math.min(az, bz, cz) > z) continue;
                const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
                if (Math.abs(d) < 1e-12) continue;
                const w1 = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / d, w2 = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / d;
                if (w1 < -1e-9 || w2 < -1e-9 || 1 - w1 - w2 < -1e-9) continue;
                const ux = bx - ax, uy = P[3 * b + 1] - P[3 * a + 1], uz = bz - az, vx = cx - ax, vy = P[3 * cc + 1] - P[3 * a + 1], vz = cz - az;
                const ny = uz * vx - ux * vz;
                if (ny / Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) < 0.85) continue;
                lowest = Math.min(lowest, (1 - w1 - w2) * P[3 * a + 1] + w1 * P[3 * b + 1] + w2 * P[3 * cc + 1]);
            }
            return lowest;
        };
        const formerlyFloating: Record<string, unknown> = {};
        for (const id of [949, 964, 764, 813, 798]) {
            const c = crownsDoc.crowns.find((k: any) => k.id === id);
            expect(c.status).toBe('tree');
            const g = groundUnder(c.stem[0], c.stem[1]);
            expect(Math.abs(c.supportY - g)).toBeLessThanOrEqual(1.0);
            formerlyFloating[id] = { supportY: c.supportY, scanGroundUnderStemY: g, supportSource: c.supportSource };
        }
        // a tree whose support the rebuilt ground does not decide stays as scanned, with its reason
        const undecided = crownsDoc.crowns.filter((c: any) => c.ground?.reasonCode === 'support_undecided');
        for (const c of undecided) {
            expect(c.status).toBe('no_measured_ground');
            expect(c.ground.reason).toMatch(/what it stands on is undecided/);
        }
        expect(strip.stats.trunkGround.supportUndecided).toBe(undecided.length);
        Object.assign(report, {
            support: { shownUnderFootprint: shownUnder, surroundingSurfaceOnly: aroundOnly, underStem: under.length, stoodOnRebuiltGround: moved, undecided: undecided.map((c: any) => ({ crownId: c.id, reason: c.ground.reason })) },
            trunkGround: strip.stats.trunkGround,
            formerlyFloating
        });
    });

    it('delivers each tree into its measured crown: its leaf masses, read from the trees model, reach it as the result says', () => {
        const t = pipeline.trees!;
        const glb = path.join(root, 'public', t.url!);
        const byId = new Map<number, any>(crownsDoc.crowns.map((c: any) => [c.id, c]));
        const short = new Set(t.shortOfCrown.map(k => k.crownId));
        let lowest = 1, worstTop = -Infinity, worstAgree = 0, below90 = 0;
        const foliage = readTreeFoliage(fs.readFileSync(glb));
        expect(foliage).toHaveLength(t.count);
        for (const f of foliage) {
            const c = byId.get(f.crownId);
            expect(c.status).toBe('tree');
            const surface = crownSurfaceAboveBase(c, f.extras.inferred.crownBaseRatio);
            const d = foliageReach(f, f.extras.foliageClumps, surface, f.extras.reachM);
            // a sample right on the reach distance can flip on the file's 1 cm quantisation: two samples of a crown's surface are
            // not a disagreement, which matters for a crown measured by a handful
            const oneSample = 2.5 / Math.max(1, surface.length);   // two samples
            lowest = Math.min(lowest, d.share + oneSample);
            worstTop = Math.max(worstTop, c.apex[1] - (d.topY + f.extras.reachM));
            worstAgree = Math.max(worstAgree, Math.max(0, Math.abs(d.share - f.extras.crownSurfaceReached) - oneSample));
            const fills = d.share >= crownsDoc.growth.minSurfaceReached && d.topY + f.extras.reachM >= c.apex[1];
            if (d.share + oneSample < 0.9) below90++;
            // a tree short of its crown is reported, and only then
            if (Math.abs(d.share - f.extras.crownSurfaceReached) > oneSample) expect(short.has(f.crownId), `crown ${f.crownId}`).toBe(!fills);
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
        // every trunk stands on the support the scan shows under its crown, which the ground rebuilt under its stem holds:
        // on the mounted (remeshed) clay, at most the few the remesh itself moved by more than the tolerance (90 before:
        // 68 floating up to 17.7 m and 22 buried)
        expect(t.offGround.length).toBeLessThanOrEqual(3);
        for (const k of t.offGround) expect(k.gapM === null ? Infinity : Math.abs(k.gapM)).toBeLessThan(1.0);
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

    it('writes the trees as a staged layer: each tree grows from its trunk in its real order, and the file is quantised within 1 cm', async () => {
        const t = pipeline.trees!;
        const bytes = fs.readFileSync(path.join(root, 'public', t.url!));
        const { json, bin } = parseGlb(bytes);
        expect(json.extensionsRequired).toContain('KHR_mesh_quantization');
        const q = json.asset.extras.scratchbox.quantization;
        expect(q.positionMaxErrorM).toBeLessThanOrEqual(0.01);
        // the root and every tree say what they are (StagedGlbRootExtras, StagedNodeExtras)
        expect(validateContract('StagedGlbRootExtras', json.extras)).toEqual([]);
        expect(json.scenes[0].extras).toEqual(json.extras);
        const treeNodes = json.nodes.filter((n: any) => n.extras?.sb && n.extras.sb.revealKind === 'grow');
        expect(treeNodes).toHaveLength(t.count);
        let pairs = 0, backwards = 0;
        treeNodes.forEach((n: any, rank: number) => {
            expect(validateContract('StagedNodeExtras', n.extras)).toEqual([]);
            expect(n.extras.sb.provenance.label).toBe('grown to the measured crown');
            expect(n.extras.sb.buildOrder).toBe(rank);
            // wood in level 0 (level 2 shares it), the blob leaf masses in level 2
            const kids = n.children.map((i: number) => json.nodes[i]);
            const lvl0 = kids.find((c: any) => c.extras.sbLod.level === 0), lvl2 = kids.find((c: any) => c.extras.sbLod.level === 2);
            const prims = [json.meshes[lvl0.mesh].primitives[0], ...json.meshes[lvl2.mesh].primitives.slice(1)];
            prims.forEach((pr: any, k: number) => {
                const r = readAccessor(json, bin, pr.attributes._REVEAL).data;
                for (let v = 0; v < r.length; v += 2) {
                    // x: the plant rank over max(1, trees - 1); y: when the vertex grew, in [0, 1]
                    expect(Math.abs(r[v] - rank / Math.max(1, treeNodes.length - 1))).toBeLessThanOrEqual(1 / 65535);
                    expect(r[v + 1]).toBeGreaterThanOrEqual(0);
                    expect(r[v + 1]).toBeLessThanOrEqual(1);
                }
                if (k === 0) {
                    // wood: each branch segment's start ring grew before its end ring (start, end vertices alternate),
                    // and the trunk's first node is the first thing grown
                    let first = Infinity;
                    for (let v = 0; v + 3 < r.length; v += 4) {
                        pairs++;
                        if (r[v + 1] > r[v + 3] + 1e-9) backwards++;
                        first = Math.min(first, r[v + 1]);
                    }
                    expect(first).toBe(0);
                }
            });
        });
        expect(pairs).toBeGreaterThan(100_000);
        expect(backwards).toBe(0);
        // the same planting written unquantised: every position agrees within the error the file reports
        const vegetation = new TileVegetationService({ workspaceRoot: root, repoRoot: REPO });
        const plain = await vegetation.plant({ crownsPath: t.crownsJson, sceneTriangleCap: SCENE_TREE_TRIANGLE_CAP, seed: strip.tileSha256.slice(0, 16), groundMeshPath: pipeline.glbPath, quantize: false });
        const a = readGlbTriangles(bytes), b = readGlbTriangles(fs.readFileSync(plain.treesGlb));
        expect(a.positions.length).toBe(b.positions.length);
        expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
        let worst = 0;
        for (let i = 0; i < a.positions.length; i += 3) {
            worst = Math.max(worst, Math.hypot(a.positions[i] - b.positions[i], a.positions[i + 1] - b.positions[i + 1], a.positions[i + 2] - b.positions[i + 2]));
        }
        expect(worst).toBeLessThanOrEqual(0.01);
        expect(Math.abs(worst - q.positionMaxErrorM)).toBeLessThan(1e-4);
        const plainBytes = fs.statSync(plain.treesGlb).size;
        // the wood and leaf masses are quantised; the instances of the leaf clusters and twigs (translation and scale) are float by the extension's definition
        expect(bytes.length).toBeLessThan(0.85 * plainBytes);
        Object.assign(report, { treesGlb: { bytes: bytes.length, unquantizedBytes: plainBytes, positionMaxErrorM: worst, reportedPositionMaxErrorM: q.positionMaxErrorM, normalMaxErrorDeg: q.normalMaxErrorDeg, beforeThisChangeBytes: 46_920_548 } });
    }, 600_000);

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

    it('puts the scanned trees back as scanned: the removed-trees layer is each removed crown\'s own triangles, labelled as scanned, and a failed tree stage mounts it over the devegetated tile', () => {
        const g = readStagedGlb(strip.removedTreesGlb);
        expect(validateContract('StagedGlbRootExtras', g.root)).toEqual([]);
        expect(g.root.sb.stage).toBe('trees');
        const items = g.nodes.filter(n => n.sb);
        // one node per removed crown: the regrown ones and the ones cut by the extraction's edge (removed, not regrown); none is kept as scanned
        const removedCrowns = crownsDoc.crowns.filter((c: any) => c.status === 'tree' || c.status === 'cut_at_boundary_removed');
        expect(removedCrowns.length).toBeGreaterThan(1000);
        expect(removedCrowns.some((c: any) => c.status === 'cut_at_boundary_removed')).toBe(true);
        expect(items).toHaveLength(removedCrowns.length);
        expect(new Set(items.map(n => n.sb.ids.crownId))).toEqual(new Set(removedCrowns.map((c: any) => c.id)));
        let tris = 0;
        for (const n of items) {
            expect(n.sb.provenance.label).toBe('as-scanned');
            expect(n.sb.provenance.measuredGeometry).toBe(true);
            tris += n.sb.counts.triangles;
        }
        expect(validateContract('StagedNodeExtras', items[0].extras)).toEqual([]);
        // all that the removal took (the strip's own count), and nothing else
        expect(tris).toBe(strip.stats.triangles.removed);
        expect(tris).toBeGreaterThan(100_000);
        // verbatim: a sample of them are the raw tile's own triangles, to the writer's 1 cm quantisation
        const layer = readGlbTriangles(fs.readFileSync(strip.removedTreesGlb));
        expect(layer.indices.length / 3).toBe(tris);
        const raw = readGlbTriangles(fs.readFileSync(path.join(root, 'central_park.glb')));
        const step = Math.floor(tris / 3000), cell = 0.1;
        const centroid = (t: GlbTriangles, f: number): [number, number, number] => {
            let x = 0, y = 0, z = 0;
            for (let j = 0; j < 3; j++) { const v = t.indices[3 * f + j]; x += t.positions[3 * v] / 3; y += t.positions[3 * v + 1] / 3; z += t.positions[3 * v + 2] / 3; }
            return [x, y, z];
        };
        const grid = new Map<string, number[]>();
        const sample: number[] = [];
        for (let f = 0; f < tris; f += step) {
            sample.push(f);
            const c = centroid(layer, f);
            const k = `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)},${Math.floor(c[2] / cell)}`;
            (grid.get(k) ?? grid.set(k, []).get(k)!).push(sample.length - 1);
        }
        const found = new Uint8Array(sample.length);
        const sorted = (t: GlbTriangles, f: number) => [0, 1, 2].map(j => { const v = t.indices[3 * f + j]; return [t.positions[3 * v], t.positions[3 * v + 1], t.positions[3 * v + 2]]; });
        for (let f = 0; f < raw.indices.length / 3; f++) {
            const c = centroid(raw, f);
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
                const list = grid.get(`${Math.floor(c[0] / cell) + a},${Math.floor(c[1] / cell) + b},${Math.floor(c[2] / cell) + d}`);
                if (!list) continue;
                for (const i of list) {
                    if (found[i]) continue;
                    const q = centroid(layer, sample[i]);
                    if (Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) > 0.02) continue;
                    // every corner of the layer's triangle is a corner of this raw triangle, within 1.5 cm
                    const rawCorners = sorted(raw, f), layerCorners = sorted(layer, sample[i]);
                    if (layerCorners.every(p => rawCorners.some(r => Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]) < 0.015))) found[i] = 1;
                }
            }
        }
        const missing = sample.filter((_, i) => !found[i]).length;
        expect(missing, `${missing} of ${sample.length} sampled triangles of the removed-trees layer are not in the raw tile`).toBe(0);
        // put back over the devegetated tile, the park is as scanned where its trees were: the picture
        const devegetated = readGlbTriangles(fs.readFileSync(strip.devegetatedGlb));
        const putBack = [{ positions: devegetated.positions, indices: devegetated.indices }, { positions: layer.positions, indices: layer.indices, color: [0.85, 0.55, 0.25] as [number, number, number] }];
        fs.mkdirSync(SHOTS, { recursive: true });
        const png = renderClayPng(putBack, { kind: 'aerial', width: 1600, height: 1000, bearingDeg: 200, elevationDeg: 35 });
        fs.writeFileSync(path.join(SHOTS, 'central_park_scanned_trees_put_back.png'), png);
        expect(png.length).toBeGreaterThan(20_000);
        const staged = path.resolve(REPO, 'test-results/screenshots/staged');
        fs.mkdirSync(staged, { recursive: true });
        fs.writeFileSync(path.join(staged, 'central_park_scanned_trees_put_back.png'), png);
        report.scannedTreesPutBack = { nodes: items.length, triangles: tris, sampled: sample.length, notInRawTile: missing };
    }, 600_000);

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
