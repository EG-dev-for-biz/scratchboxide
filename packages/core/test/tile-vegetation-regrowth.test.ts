/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Regrowing measured crowns (growCrown in scratchbox_tile_vegetation.hpp, space colonisation in scratchbox_nature.hpp),
 * compiled with clang++ and run through TileVegetationService, on synthetic crowns with known shape:
 *
 * - a tall narrow crown measured only near its top (as the scan sees a 30 m tree from above) must grow into it: the
 *   trunk stopped at the inferred crown base, more than a perception radius below the measured crown, and nothing grew;
 * - the regrowth check must measure how much of the measured crown the regrown leaves reach, not how high one meshed
 *   leaf mass sits: a crown with a lobe no branch can reach used to pass with half of it empty;
 * - every crown that cannot be regrown is named with its reason, not only the first;
 * - what a tree delivers is measured on its meshed leaf masses (read back here from the trees GLB), not on its
 *   skeleton: a budget too small for its leaves to fill its crown is reported for that tree, and not called filled;
 * - strip regrows every tree before removing anything and keeps a tree it cannot regrow as scanned, its scan untouched;
 * - without a budget of the caller's own, each tree's budget comes from its crown and what its leaf masses need,
 *   within the scene's cap.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationError, TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { buildSyntheticTile, type SyntheticTileSpec } from './helpers/synthetic-textured-tile';
import { parseGlb, readGlbTriangles, type GlbTriangles } from './helpers/clay-glb-render';
import { crownSurfaceAboveBase, foliageReach, readTreeFoliage } from './helpers/foliage-reach';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));

type Vec3 = [number, number, number];

/** A crown as crowns.json carries it; samples are its measured top surface (what a scan sees from above). */
function crown(id: number, stem: [number, number], supportY: number, apexY: number, radii: number[], samples: Vec3[]) {
    const r = radii.reduce((a, b) => a + b, 0) / radii.length;
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * r * r, sectorRadii: radii, samples
    };
}

/** Top surface of a dome of radius r whose edge lies `drop` metres under its apex, on a 0.7 m grid (the strip's sample spacing). */
function domeSamples(cx: number, cz: number, apexY: number, r: number, drop: number): Vec3[] {
    const out: Vec3[] = [];
    const n = Math.ceil(r / 0.7);
    for (let i = -n; i <= n; i++) {
        for (let k = -n; k <= n; k++) {
            const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
            if (d > r) continue;
            out.push([cx + dx, apexY - drop * (d / r) ** 2, cz + dz]);
        }
    }
    return out;
}

/** A tall tree (32 m) with a 2.5 m crown whose measured surface lies within its top 2 m (crowns 657 and 846 in Central Park). */
function tallNarrow(id: number, x: number, z: number, height = 32) {
    return crown(id, [x, z], 0, height, new Array(16).fill(2.5), domeSamples(x, z, height, 2.5, 2));
}

/** Every tree of a trees GLB: its delivered leaves measured independently against its crown, and what its extras say. */
function deliveredReach(glbFile: string, crowns: any[], crownBaseRatio = 0.35) {
    return readTreeFoliage(fs.readFileSync(glbFile)).map(f => {
        const c = crowns.find(k => k.id === f.crownId);
        const measured = foliageReach(f, f.extras.foliageClumps, crownSurfaceAboveBase(c, crownBaseRatio), f.extras.reachM);
        return { crownId: f.crownId, apexY: c.apex[1], reachM: f.extras.reachM, share: measured.share, topY: measured.topY, extras: f.extras };
    });
}

/** One measured crown made of two 3 m lobes 12 m apart, its stem under the first: no branch can cross to the second. */
function twoLobes(id: number, x: number, z: number) {
    const radii = new Array(16).fill(3);
    radii[7] = radii[8] = 15;
    return crown(id, [x, z], 0, 10, radii, [...domeSamples(x, z, 10, 3, 5), ...domeSamples(x + 12, z, 10, 3, 5)]);
}

let work: string;
let svc: TileVegetationService;

function writeCrowns(name: string, crowns: any[]): string {
    fs.writeFileSync(path.join(work, name), JSON.stringify({ version: 1, frame: null, params: { sampleSpacing: 0.7 }, crowns }));
    return name;
}

/** Foliage (the second primitive of each tree mesh) positions in the tile frame, per tree node (quantised or not). */
function foliageOf(glbFile: string): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>();
    for (const f of readTreeFoliage(fs.readFileSync(glbFile))) out.set(f.crownId, f.positions);
    return out;
}

/** Share of `samples` with a foliage vertex within `d` metres. */
function covered(samples: Vec3[], foliage: Float32Array, d: number): number {
    let n = 0;
    for (const s of samples) {
        for (let v = 0; v < foliage.length; v += 3) {
            if ((foliage[v] - s[0]) ** 2 + (foliage[v + 1] - s[1]) ** 2 + (foliage[v + 2] - s[2]) ** 2 <= d * d) { n++; break; }
        }
    }
    return n / samples.length;
}

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tile-regrowth-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('regrowing a measured crown', () => {
    it('grows a tall narrow crown measured only near its top: the trunk reaches the crown, the leaves reach its apex', async () => {
        // Before: the trunk stopped at the inferred crown base (11.2 m), the shell of attractors under the measured
        // surface began about 15 m up, more than the 3.3 m perception radius away, so colonisation never started. The
        // perception radius now spans the kill reach as well (4.5 m), which sees across that gap; under a 45 m tree
        // measured in its top 2 m the gap is 5.5 m, and its trunk grows on towards the crown until it is in sight.
        for (const [height, seeks] of [[32, false], [45, true]] as const) {
            for (const seed of ['abc', '1', '2']) {
                const planted = await svc.plant({ crownsPath: writeCrowns('tall.json', [tallNarrow(0, 0, 0, height)]), triangleBudget: 3000, seed });
                expect(planted.stats.trees).toBe(1);
                const t = planted.stats.perTree[0];
                if (seeks) expect(t.colonisation.trunkSeekSteps).toBeGreaterThanOrEqual(1);
                expect(t.colonisation.iterations).toBeGreaterThan(5);
                expect(t.grownSurfaceReached).toBeGreaterThanOrEqual(0.9);
                expect(t.crownSurfaceReached).toBeGreaterThanOrEqual(0.9);
                expect(planted.stats.shortOfCrown).toEqual([]);
                const [lo, hi] = t.bounds as number[][];
                expect(lo[1]).toBeLessThan(0.3);                // stands on its ground ...
                expect(hi[1]).toBeGreaterThan(height - 1.5);    // ... and its leaves reach the measured apex
                expect(hi[1]).toBeLessThan(height + 0.5);
                // the delivered leaf masses, read back from the GLB, reach the measured top surface as the stats say
                const [d] = deliveredReach(planted.treesGlb, [tallNarrow(0, 0, 0, height)]);
                expect(d.share).toBeGreaterThanOrEqual(0.9);
                expect(Math.abs(d.share - t.crownSurfaceReached)).toBeLessThan(0.02);
            }
        }
        for (const seed of ['abc', '1', '2']) {
            const planted = await svc.plant({ crownsPath: writeCrowns('tall.json', [tallNarrow(0, 0, 0)]), triangleBudget: 3000, seed });
            const t = planted.stats.perTree[0];
            const [lo, hi] = t.bounds as number[][];
            expect(lo[1]).toBeLessThan(0.3);            // stands on its ground ...
            expect(hi[1]).toBeGreaterThan(32 - 1.5);    // ... and its leaves reach the measured apex
            expect(hi[1]).toBeLessThan(32 + 0.5);
            // the leaves cover the measured top surface
            const foliage = foliageOf(planted.treesGlb).get(0)!;
            expect(covered(domeSamples(0, 0, 32, 2.5, 2), foliage, 1.5)).toBeGreaterThanOrEqual(0.9);
        }
    });

    it('rejects a tree whose leaves reach only part of the measured crown, saying how much', async () => {
        // Before: the check asked only whether the meshed leaves rose above the lower third of the crown, so a tree
        // filling the first lobe, with the second left empty, was planted as the measured tree.
        const err = await svc.plant({ crownsPath: writeCrowns('lobes.json', [twoLobes(0, 0, 0)]), triangleBudget: 3000, seed: 'abc' }).catch(e => e);
        expect(err).toBeInstanceOf(TileVegetationError);
        expect(err.code).toBe('plant_failed');
        expect(err.message).toMatch(/^1 of 1 trees did not regrow into their measured crowns: crown 0: the regrown tree's leaves reach (4\d|5\d)% of its measured crown surface \(\d+ of \d+ samples within [\d.]+ m; 90% needed\)/);
        expect(err.message).toContain('colonisation:');
    });

    it('names every crown that cannot be regrown, not only the first', async () => {
        const err = await svc.plant({ crownsPath: writeCrowns('mixed.json', [twoLobes(4, 0, 0), tallNarrow(7, 40, 0), twoLobes(9, 0, 40)]), triangleBudget: 9000, seed: 'abc' }).catch(e => e);
        expect(err).toBeInstanceOf(TileVegetationError);
        expect(err.message).toContain('2 of 3 trees did not regrow into their measured crowns');
        expect(err.message).toContain('crown 4: the regrown tree');
        expect(err.message).toContain('crown 9: the regrown tree');
        expect(err.message).not.toContain('crown 7:');
    });
});

describe('the triangle budget of the trees', () => {
    // three crowns of different sizes: 3 m, 5 m and 8 m radius
    const sized = () => writeCrowns('sized.json', [
        crown(1, [0, 0], 0, 8, new Array(16).fill(3), domeSamples(0, 0, 8, 3, 3)),
        crown(2, [30, 0], 0, 12, new Array(16).fill(5), domeSamples(30, 0, 12, 5, 4)),
        crown(3, [0, 30], 0, 16, new Array(16).fill(8), domeSamples(0, 30, 16, 8, 5))
    ]);

    it('without a budget of the caller\'s own, gives each tree its own budget: a target that grows with its crown, never under what its leaves need', async () => {
        const planted = await svc.plant({ crownsPath: sized(), sceneTriangleCap: 1_500_000, seed: 'abc' });
        const s = planted.stats;
        expect(s.trees).toBe(3);
        expect(s.triangleBudgetSource).toBe('crown_targets');
        const per = [1, 2, 3].map(id => s.perTree.find((t: any) => t.crownId === id));
        for (const t of per) {
            expect(t.budget).toBe(t.ownBudget);
            expect(t.ownBudget).toBe(Math.max(t.target, t.neededTriangles));
            expect(t.target).toBeGreaterThanOrEqual(120);
            expect(t.triangles).toBeLessThanOrEqual(t.budget);
            // at its own budget every leaf mass its crown surface needs fits, and its leaves fill its crown
            expect(t.surfaceMasses).toBe(t.surfaceMassesNeeded);
            expect(t.crownSurfaceReached).toBeGreaterThanOrEqual(0.9);
        }
        expect(s.shortOfCrown).toEqual([]);
        expect(per[0].target).toBeLessThan(per[1].target);
        expect(per[1].target).toBeLessThan(per[2].target);
        expect(s.targetTriangles).toBe(per.reduce((a: number, t: any) => a + t.ownBudget, 0));
        for (const d of deliveredReach(planted.treesGlb, JSON.parse(fs.readFileSync(path.join(work, 'sized.json'), 'utf8')).crowns)) {
            expect(d.share).toBeGreaterThanOrEqual(0.9);
            expect(d.topY + d.reachM).toBeGreaterThanOrEqual(d.apexY);
        }
        expect(s.triangleBudget).toBe(s.targetTriangles);
        expect(s.triangles).toBeLessThanOrEqual(s.triangleBudget);
    });

    it('scales the targets down to the scene cap, never under 120 triangles a tree', async () => {
        const full = await svc.plant({ crownsPath: sized(), sceneTriangleCap: 1_500_000, seed: 'abc' });
        const cap = Math.floor(0.5 * full.stats.targetTriangles);
        const capped = await svc.plant({ crownsPath: sized(), sceneTriangleCap: cap, seed: 'abc' });
        const s = capped.stats;
        expect(s.triangleBudgetSource).toBe('crown_targets_capped');
        expect(s.triangleBudget).toBe(cap);
        expect(s.triangles).toBeLessThanOrEqual(cap);
        const per = [1, 2, 3].map(id => s.perTree.find((t: any) => t.crownId === id));
        for (const t of per) {
            expect(t.budget).toBeGreaterThanOrEqual(120);
            expect(t.budget).toBeLessThanOrEqual(t.ownBudget);
            // what the leaf masses need comes first
            if (cap >= s.neededTriangles) expect(t.budget).toBeGreaterThanOrEqual(t.neededTriangles);
        }
        expect(per[0].budget).toBeLessThanOrEqual(per[1].budget);
        expect(per[1].budget).toBeLessThanOrEqual(per[2].budget);
        expect(per.reduce((a: number, t: any) => a + t.budget, 0)).toBeLessThanOrEqual(cap);
    });

    it('fails only when the minimum over all trees exceeds the cap, saying how many trees there are', async () => {
        const err = await svc.plant({ crownsPath: sized(), sceneTriangleCap: 300, seed: 'abc' }).catch(e => e);
        expect(err).toBeInstanceOf(TileVegetationError);
        expect(err.code).toBe('budget_too_small');
        expect(err.message).toBe("the 3 measured trees need at least 360 triangles at 120 each, more than the scene's cap of 300 triangles for trees");
        // exactly the minimum fits
        const tight = await svc.plant({ crownsPath: sized(), sceneTriangleCap: 360, seed: 'abc' });
        expect(tight.stats.trees).toBe(3);
        expect(tight.stats.triangles).toBeLessThanOrEqual(360);
    });

    it('spends an explicit budget, whatever the cap, and still fails clearly when it cannot hold the trees', async () => {
        const planted = await svc.plant({ crownsPath: sized(), triangleBudget: 50_000, seed: 'abc' });
        expect(planted.stats.triangleBudgetSource).toBe('explicit');
        expect(planted.stats.triangleBudget).toBe(50_000);
        expect(planted.stats.triangles).toBeLessThanOrEqual(50_000);
        const budgets = planted.stats.perTree.map((t: any) => t.budget);
        expect(budgets.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0.99 * 50_000);
        const err = await svc.plant({ crownsPath: sized(), triangleBudget: 300, seed: 'abc' }).catch(e => e);
        expect(err.code).toBe('budget_too_small');
        expect(err.message).toBe('a triangle budget of 300 cannot hold 3 trees at 120 triangles each (they need at least 360)');
        // a budget that holds the trees but not every leaf mass their crowns need (40 triangles a tree: one leaf mass):
        // planted, and each tree that falls short is named with what its leaves reach, which the GLB confirms; none is
        // called filled
        const tight = await svc.plant({ crownsPath: sized(), triangleBudget: 120, seed: 'abc', params: { minTrianglesPerTree: 40 } });
        expect(tight.stats.trees).toBe(3);
        expect(tight.stats.shortOfCrown.length).toBeGreaterThanOrEqual(1);
        const delivered = deliveredReach(tight.treesGlb, JSON.parse(fs.readFileSync(path.join(work, 'sized.json'), 'utf8')).crowns);
        for (const d of delivered) {
            const short = tight.stats.shortOfCrown.find((k: any) => k.crownId === d.crownId);
            const fills = d.share >= 0.9 && d.topY + d.reachM >= d.apexY;
            expect(Math.abs(d.share - d.extras.crownSurfaceReached)).toBeLessThan(0.02);
            expect(!!short).toBe(!fills);
            expect(!!d.extras.shortOfCrown).toBe(!fills);
            if (short) expect(short.reason).toMatch(/^within its budget of \d+ triangles its (\d+ leaf mass(es)? reach(es)? [\d.]+% of its measured crown surface|leaves reach [\d.]+ m above its ground)/);
        }
        const both = await svc.plant({ crownsPath: sized(), triangleBudget: 3000, sceneTriangleCap: 3000, seed: 'abc' }).catch(e => e);
        expect(both.code).toBe('bad_request');
        const neither = await svc.plant({ crownsPath: sized(), seed: 'abc' }).catch(e => e);
        expect(neither.code).toBe('bad_request');
    });
});

/** Triangles whose centroid lies within `r` (horizontally) of (x, z) and above `minY`. */
function trianglesNear(t: GlbTriangles, x: number, z: number, r: number, minY: number): number {
    let n = 0;
    for (let i = 0; i < t.indices.length; i += 3) {
        let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < 3; j++) { const v = t.indices[i + j]; cx += t.positions[v * 3] / 3; cy += t.positions[v * 3 + 1] / 3; cz += t.positions[v * 3 + 2] / 3; }
        if (Math.hypot(cx - x, cz - z) <= r && cy > minY) n++;
    }
    return n;
}

describe('strip keeps a tree it cannot regrow as scanned', () => {
    const TREES = [
        { x: -12, z: -10, height: 11, radius: 4.5 },
        { x: 10, z: 12, height: 8, radius: 3.5 },
        { x: -14, z: 14, height: 14, radius: 5.5 }
    ];
    const SPEC: SyntheticTileSpec = { halfSize: 30, spacing: 0.75, trees: TREES, building: { x0: 4, z0: -16, x1: 16, z1: -4, height: 15 } };

    beforeAll(() => {
        fs.writeFileSync(path.join(work, 'district.glb'), buildSyntheticTile(SPEC));
    });

    it('regrows every tree before removing anything, records how, and plants the same trees', async () => {
        const strip = await svc.strip({ tilePath: 'district.glb' });
        const doc = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'));
        // the growth the removal was decided with, for plant to grow the same trees
        expect(doc.growth).toEqual({ seed: strip.tileSha256.slice(0, 16), crownBaseRatio: 0.35, trunkRadiusPerHeight: 0.016, shellDepth: 0.8, minSurfaceReached: 0.9, crownBaseSpread: 0.1, branchAngleSpreadRad: 0.2, trunkLeanShare: 0.45, apicalDominance: 0.5, branchAngleMeanRad: 0.80795, internodeLengthM: 0 });
        const trees = doc.crowns.filter((c: any) => c.status === 'tree');
        expect(trees).toHaveLength(3);
        for (const c of trees) {
            expect(c.regrowth.surfaceShare).toBeGreaterThanOrEqual(0.9);
            expect(c.regrowth.reason).toBeUndefined();
        }
        expect(strip.stats.crowns.notRegrowable).toBe(0);
        expect(strip.stats.notRegrowable).toEqual([]);
        const planted = await svc.plant({ crownsPath: strip.crownsJson, sceneTriangleCap: 1_500_000, seed: strip.tileSha256.slice(0, 16) });
        expect(planted.stats.trees).toBe(3);
        for (const t of planted.stats.perTree) {
            const c = trees.find((k: any) => k.id === t.crownId);
            // the same skeleton, and at the tree's own budget (no budget of the caller's, room under the cap) the very
            // mesh strip checked
            expect(t.grownSurfaceReached).toBeCloseTo(c.regrowth.surfaceShare, 6);
            expect(t.budget).toBe(c.regrowth.ownBudget);
            expect(t.crownSurfaceReached).toBeCloseTo(c.regrowth.leaves.surfaceShare, 6);
            expect(c.regrowth.leaves.surfaceShare).toBeGreaterThanOrEqual(0.9);
        }
        // planting with growth ratios other than the ones the removal was decided with is refused
        const other = await svc.plant({ crownsPath: strip.crownsJson, sceneTriangleCap: 1_500_000, seed: strip.tileSha256.slice(0, 16), params: { crownBaseRatio: 0.5 } }).catch(e => e);
        expect(other).toBeInstanceOf(TileVegetationError);
        expect(other.code).toBe('bad_request');
        expect(other.message).toContain('--crown-base-ratio 0.5 differs from the 0.35 the measurement regrew its trees with');
    });

    it('keeps the crowns it cannot regrow in the scan, untouched, each with its reason, and removes only the others', async () => {
        // With the crown base inferred at 99 % of a tree's height, the two lower crowns have no measured surface above
        // it: no tree can be grown into them. They stay exactly as scanned; the third is removed and replanted.
        const strip = await svc.strip({ tilePath: 'district.glb', params: { crownBaseRatio: 0.99, crownBaseSpread: 0 } });
        const crowns = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns;
        const kept = crowns.filter((c: any) => c.status === 'not_regrowable');
        const rebuilt = crowns.filter((c: any) => c.status === 'tree');
        expect(kept).toHaveLength(2);
        expect(rebuilt).toHaveLength(1);
        for (const c of kept) {
            expect(c.regrowth.reasonCode).toBe('no_crown_above_base');
            expect(c.regrowth.reason).toMatch(/^(none of its \d+ measured surface samples lies|only \d of its \d+ measured surface samples lie) above its inferred crown base at [\d.]+ m above its ground, too few to grow a crown into$/);
        }
        expect(strip.stats.crowns).toMatchObject({ tree: 1, notRegrowable: 2 });
        expect(strip.stats.notRegrowable.map((k: any) => k.crownId).sort()).toEqual(kept.map((c: any) => c.id).sort());
        const raw = readGlbTriangles(fs.readFileSync(path.join(work, 'district.glb')));
        const out = readGlbTriangles(fs.readFileSync(strip.devegetatedGlb));
        for (const c of kept) {
            const t = TREES.find(tr => Math.hypot(tr.x - c.stem[0], tr.z - c.stem[1]) < tr.radius)!;
            const scanned = trianglesNear(raw, t.x, t.z, 0.8 * t.radius, 1);
            expect(scanned).toBeGreaterThan(20);
            expect(trianglesNear(out, t.x, t.z, 0.8 * t.radius, 1)).toBe(scanned);
        }
        const gone = TREES.find(tr => Math.hypot(tr.x - rebuilt[0].stem[0], tr.z - rebuilt[0].stem[1]) < tr.radius)!;
        expect(trianglesNear(out, gone.x, gone.z, 0.8 * gone.radius, 1)).toBe(0);
        // plant takes the recorded growth and grows the one tree that was removed
        const planted = await svc.plant({ crownsPath: strip.crownsJson, sceneTriangleCap: 1_500_000, seed: strip.tileSha256.slice(0, 16) });
        expect(planted.stats.trees).toBe(1);
        expect(planted.stats.perTree[0].crownId).toBe(rebuilt[0].id);
        expect(planted.stats.inferred.crownBaseRatio).toBe(0.99);
    });

    it('keeps every crown as scanned when none can be regrown, removing nothing', async () => {
        const strip = await svc.strip({ tilePath: 'district.glb', params: { crownBaseRatio: 0.9999, crownBaseSpread: 0 } });
        const crowns = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns;
        expect(crowns.length).toBeGreaterThan(0);
        expect(crowns.every((c: any) => c.status === 'not_regrowable')).toBe(true);
        expect(strip.stats.crowns).toMatchObject({ tree: 0, notRegrowable: crowns.length });
        expect(strip.stats.triangles).toMatchObject({ removed: 0, cap: 0, skirt: 0 });
        expect(readGlbTriangles(fs.readFileSync(strip.devegetatedGlb)).indices.length).toBe(readGlbTriangles(fs.readFileSync(path.join(work, 'district.glb'))).indices.length);
    });
});
