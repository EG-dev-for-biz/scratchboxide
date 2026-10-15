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
import { SCENE_TREE_TRIANGLE_CAP, TileVegetationService, type TileVegetationStripResult } from '../src/node/3d-engine/tile-vegetation-service';
import { TileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { describeLocationClay, runLocationClayPipeline, type LocationClayResult } from '../src/node/3d-engine/location-clay-pipeline';
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

/**
 * Near-vertical surface (|n.y| < 0.3) whose centroid lies inside a measured tree's footprint and whose top rises at
 * least 2 m above that tree's support: the walls a removal can leave standing where the tree was.
 */
function steepInsideTreeFootprints(t: GlbTriangles, trees: any[], range?: { first: number; count: number }): { areaM2: number; over10m: number } {
    const P = t.positions;
    let areaM2 = 0, over10m = 0;
    const from = range ? range.first : 0, to = range ? range.first + range.count : t.indices.length / 3;
    for (let f = from; f < to; f++) {
        const a = t.indices[3 * f] * 3, b = t.indices[3 * f + 1] * 3, c = t.indices[3 * f + 2] * 3;
        const cx = (P[a] + P[b] + P[c]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
        const tree = trees.find(tr => Math.abs(cx - tr.stem[0]) < 25 && Math.abs(cz - tr.stem[1]) < 25 && insideFootprint(tr, cx, cz, 0));
        if (!tree) continue;
        const top = Math.max(P[a + 1], P[b + 1], P[c + 1]);
        if (top - tree.supportY < 2) continue;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9 || Math.abs(ny / len) >= 0.3) continue;
        areaM2 += len / 2;
        if (top - Math.min(P[a + 1], P[b + 1], P[c + 1]) > 10) over10m++;
    }
    return { areaM2, over10m };
}

/**
 * 0.5 m cells within `reachM` of the tile's outer edge: seen from above, the cells the tile does not cover that are
 * connected to the border of its bounding box (outside the extraction), grown by `reachM`.
 */
function outerEdgeCells(t: GlbTriangles, reachM: number): Set<string> {
    const P = t.positions;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < P.length; v += 3) { minX = Math.min(minX, P[v]); maxX = Math.max(maxX, P[v]); minZ = Math.min(minZ, P[v + 2]); maxZ = Math.max(maxZ, P[v + 2]); }
    const j0 = Math.floor(minX / 0.5) - 2, k0 = Math.floor(minZ / 0.5) - 2;
    const W = Math.floor(maxX / 0.5) + 3 - j0, H = Math.floor(maxZ / 0.5) + 3 - k0;
    const cov = new Uint8Array(W * H);
    for (let i = 0; i < t.indices.length; i += 3) {
        const a = t.indices[i] * 3, b = t.indices[i + 1] * 3, c = t.indices[i + 2] * 3;
        const d = (P[b] - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (P[b + 2] - P[a + 2]);
        if (Math.abs(d) < 1e-12) continue;
        const i0 = Math.floor(Math.min(P[a], P[b], P[c]) / 0.5), i1 = Math.floor(Math.max(P[a], P[b], P[c]) / 0.5);
        const q0 = Math.floor(Math.min(P[a + 2], P[b + 2], P[c + 2]) / 0.5), q1 = Math.floor(Math.max(P[a + 2], P[b + 2], P[c + 2]) / 0.5);
        for (let k = q0; k <= q1; k++) {
            for (let j = i0; j <= i1; j++) {
                const x = (j + 0.5) * 0.5, z = (k + 0.5) * 0.5;
                const w1 = ((x - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (z - P[a + 2])) / d;
                const w2 = ((P[b] - P[a]) * (z - P[a + 2]) - (x - P[a]) * (P[b + 2] - P[a + 2])) / d;
                if (w1 >= -1e-9 && w2 >= -1e-9 && 1 - w1 - w2 >= -1e-9) cov[(k - k0) * W + (j - j0)] = 1;
            }
        }
    }
    const dist = new Int32Array(W * H).fill(-1);
    const queue: number[] = [];
    for (let k = 0; k < H; k++) for (let j = 0; j < W; j++) {
        if ((k === 0 || j === 0 || k === H - 1 || j === W - 1) && !cov[k * W + j]) { dist[k * W + j] = 0; queue.push(k * W + j); }
    }
    // outside: uncovered cells connected to the border; then everything within reach of it
    for (let q = 0; q < queue.length; q++) {
        const c = queue[q], j = c % W, k = (c - j) / W;
        for (const [dj, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const jj = j + dj, kk = k + dk;
            if (jj < 0 || kk < 0 || jj >= W || kk >= H) continue;
            const n = kk * W + jj;
            if (dist[n] >= 0 || cov[n]) continue;
            dist[n] = 0;
            queue.push(n);
        }
    }
    const reach = Math.ceil(reachM / 0.5);
    for (let q = 0; q < queue.length; q++) {
        const c = queue[q], j = c % W, k = (c - j) / W;
        if (dist[c] >= reach) continue;
        for (const [dj, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const jj = j + dj, kk = k + dk;
            if (jj < 0 || kk < 0 || jj >= W || kk >= H) continue;
            const n = kk * W + jj;
            if (dist[n] >= 0) continue;
            dist[n] = dist[c] + 1;
            queue.push(n);
        }
    }
    const out = new Set<string>();
    for (let c = 0; c < W * H; c++) if (dist[c] >= 0) out.add(`${(c % W) + j0},${Math.floor(c / W) + k0}`);
    return out;
}

/** The scan in clay, with the strip's skirts in red and caps in blue. */
function closingLayers(t: GlbTriangles): Array<{ positions: Float32Array; indices: Uint32Array; color?: [number, number, number] }> {
    const scan: number[] = [], skirts: number[] = [], caps: number[] = [];
    for (const r of t.nodeRanges) {
        const into = r.name === 'vegetation_removed_skirt' ? skirts : r.name === 'vegetation_removed_cap' ? caps : scan;
        for (let f = r.firstTriangle; f < r.firstTriangle + r.triangleCount; f++) into.push(t.indices[3 * f], t.indices[3 * f + 1], t.indices[3 * f + 2]);
    }
    return [
        { positions: t.positions, indices: Uint32Array.from(scan) },
        { positions: t.positions, indices: Uint32Array.from(skirts), color: [0.85, 0.2, 0.15] },
        { positions: t.positions, indices: Uint32Array.from(caps), color: [0.35, 0.55, 0.9] }
    ];
}

function insideFootprint(c: any, x: number, z: number, margin = 0.5): boolean {
    const dx = x - c.stem[0], dz = z - c.stem[1];
    const s = Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * 16) & 15;
    return Math.hypot(dx, dz) <= c.sectorRadii[s] + margin;
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
        const rawTris = readGlbTriangles(fs.readFileSync(path.join(root, 'flatiron.glb')));
        const outTris = readGlbTriangles(fs.readFileSync(strip.devegetatedGlb));
        const before = coveredCells(rawTris, cells);
        const after = coveredCells(outTris, cells);
        // the extraction's own outer edge is not a hole: where a removed crown overhung it, the edge stays where the
        // ground it stood on ends (the strip patches no ground beyond the extraction); cells within 1.5 m of it are
        // reported, not judged
        const edge = outerEdgeCells(rawTris, 1.5);
        const openedAtEdge = [...before].filter(k => !after.has(k) && edge.has(k)).length;
        const openedCells = [...before].filter(k => !after.has(k) && !edge.has(k));
        expect(before.size).toBeGreaterThan(5000);
        // no footprint cell the scan covered is open seen from above, but for single cells where a cap edge and this
        // test's cell grid disagree by a hair: under 0.2% of the cells, and no hole of a square metre (4 cells)
        const openSet = new Set(openedCells), seen = new Set<string>();
        let largest = 0;
        for (const k of openedCells) {
            if (seen.has(k)) continue;
            let n = 0;
            const queue = [k];
            seen.add(k);
            while (queue.length) {
                const [j, i] = queue.pop()!.split(',').map(Number);
                n++;
                for (const [dj, di] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nk = `${j + dj},${i + di}`;
                    if (openSet.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk); }
                }
            }
            largest = Math.max(largest, n);
        }
        expect(openedCells.length / before.size).toBeLessThan(0.002);
        expect(largest).toBeLessThan(4);

        // ... and closed on the ground, not with walls hung from what stays:
        // - no cap face climbs (it follows the level surface the tree stood on, within the 1.5 m support band);
        const cap = outTris.nodeRanges.find(r => r.name === 'vegetation_removed_cap')!;
        let capRise = 0;
        for (let f = cap.firstTriangle; f < cap.firstTriangle + cap.triangleCount; f++) {
            const ys = [0, 1, 2].map(j => outTris.positions[outTris.indices[3 * f + j] * 3 + 1]);
            capRise = Math.max(capRise, Math.max(...ys) - Math.min(...ys));
        }
        expect(capRise).toBeLessThanOrEqual(3.0);
        expect(strip.stats.holes.capMaxRiseM).toBeLessThanOrEqual(3.0);
        // - canopy that stays never stands over a hole: cut canopy joined to a removed tree went with it, and the only
        //   canopy a skirt closes is a low planting (under 3 m above what it stands on, beside a cap within the 1.5 m band);
        expect(strip.stats.crowns.cutAtBoundaryRemoved).toBeGreaterThanOrEqual(1);
        //   a tree kept as scanned because no regrown tree fills its crown is canopy that stays too: where trees beside
        //   it were removed, its side is closed down to their ground, never taller than its top above that ground
        const keptTrees = crownsDoc.crowns.filter((c: any) => c.status === 'not_regrowable');
        const keptTreeSide = Math.max(0, ...keptTrees.map((k: any) => k.apex[1] - Math.min(k.supportY, ...trees
            .filter((c: any) => Math.hypot(c.stem[0] - k.stem[0], c.stem[1] - k.stem[1]) < 20).map((c: any) => c.supportY))));
        expect(strip.stats.skirts.maxHeightByHangM.onKeptCanopy).toBeLessThanOrEqual(Math.max(5, keptTreeSide));
        // - no tall skirt anywhere near a crown that stays cut (where the previous strip hung 20-30 m curtains);
        const skirt = outTris.nodeRanges.find(r => r.name === 'vegetation_removed_skirt')!;
        const keptCut = crownsDoc.crowns.filter((c: any) => c.status === 'cut_at_boundary');
        let tallNearKeptCut = 0, tallSkirts = 0;
        for (let f = skirt.firstTriangle; f < skirt.firstTriangle + skirt.triangleCount; f++) {
            const v = [0, 1, 2].map(j => outTris.indices[3 * f + j] * 3);
            const ys = v.map(o => outTris.positions[o + 1]);
            if (Math.max(...ys) - Math.min(...ys) <= 5) continue;
            tallSkirts++;
            const cx = v.reduce((a, o) => a + outTris.positions[o], 0) / 3, cz = v.reduce((a, o) => a + outTris.positions[o + 2], 0) / 3;
            if (keptCut.some((c: any) => insideFootprint(c, cx, cz, 3))) tallNearKeptCut++;
        }
        expect(tallNearKeptCut).toBe(0);
        // - pieces of a tree's scan the removal left in the air went with it, rather than standing on new walls;
        expect(strip.stats.drape.fragmentsTaken).toBeGreaterThanOrEqual(1);
        // - and the removal leaves less near-vertical surface standing in the trees' footprints than the scan had
        //   there (the crowns' own sides), with almost none of it in the cap
        const rawSteep = steepInsideTreeFootprints(rawTris, trees);
        const outSteep = steepInsideTreeFootprints(outTris, trees);
        const capSteep = steepInsideTreeFootprints(outTris, trees, { first: cap.firstTriangle, count: cap.triangleCount });
        const skirtSteep = steepInsideTreeFootprints(outTris, trees, { first: skirt.firstTriangle, count: skirt.triangleCount });
        expect(rawSteep.areaM2).toBeGreaterThan(1000);
        expect(outSteep.areaM2).toBeLessThan(rawSteep.areaM2);
        expect(capSteep.areaM2).toBeLessThan(0.01 * strip.stats.treeCanopyAreaM2);
        const wallReport = {
            openedCells: openedCells.length, openedAtExtractionEdge: openedAtEdge, coveredCells: before.size, largestOpenRun: largest, capMaxRiseM: capRise,
            rawSteepInTreeFootprintsM2: rawSteep.areaM2, outSteepInTreeFootprintsM2: outSteep.areaM2, skirtSteepInTreeFootprintsM2: skirtSteep.areaM2,
            skirtsTallerThan5m: tallSkirts, tallSkirtsNearKeptCutCrowns: tallNearKeptCut, skirts: strip.stats.skirts, drape: strip.stats.drape,
            crowns: strip.stats.crowns, cutCanopyRemovedM2: strip.stats.cutCanopyRemovedM2, treeCanopyAreaM2: strip.stats.treeCanopyAreaM2
        };
        if (fs.existsSync(REPORT)) fs.writeFileSync(REPORT, JSON.stringify({ ...JSON.parse(fs.readFileSync(REPORT, 'utf8')), walls: wallReport }, null, 2));
    });

    it('runs the whole location pipeline: remeshed clay plus SB-Veggie trees within budget, with screenshots', () => {
        expect(pipeline.trees!.count).toBe(trees.length);
        expect(pipeline.trees!.measured).toBe(trees.length + pipeline.trees!.notRegrowable);
        expect(pipeline.trees!.triangles).toBeLessThanOrEqual(pipeline.trees!.triangleBudget);
        // sized from the measured crowns, within the scene's cap (not from the remeshed tile)
        expect(pipeline.trees!.triangleBudgetSource).toMatch(/^crown_targets/);
        expect(pipeline.trees!.triangleBudget).toBe(Math.min(pipeline.trees!.targetTriangles!, SCENE_TREE_TRIANGLE_CAP));
        const clayFile = path.join(root, 'public', pipeline.url);
        const treesFile = path.join(root, 'public', pipeline.trees!.url!);
        const clay = readGlbTriangles(fs.readFileSync(clayFile));
        const grown = readGlbTriangles(fs.readFileSync(treesFile));
        expect(grown.nodeRanges).toHaveLength(trees.length);
        // the summary the model relays says what closing the ground added, named by what each skirt hangs on
        const text = describeLocationClay(pipeline, 'clay');
        expect(text).toMatch(/(walls and building sides the trees hid were continued straight down to that ground|the edges of (level|other) surfaces left standing over it were closed down to it) \([\d,]+ m², up to [\d.]+ m tall; not in the scan\)/);
        expect(text).toContain(`Taken out with the trees`);
        if (fs.existsSync(REPORT)) fs.writeFileSync(REPORT, JSON.stringify({ ...JSON.parse(fs.readFileSync(REPORT, 'utf8')), summary: text }, null, 2));

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
        // trees tinted green to tell them apart from the scan; the GLB itself is studio clay
        const layers = [{ positions: clay.positions, indices: clay.indices }, { positions: grown.positions, indices: grown.indices, color: [0.45, 0.55, 0.45] as [number, number, number] }];
        const allClay = [{ positions: clay.positions, indices: clay.indices }, { positions: grown.positions, indices: grown.indices }];
        const shots: Array<[string, Buffer]> = [
            ['flatiron_park_clay_trees_aerial.png', renderClayPng(layers, { kind: 'aerial', width: 1280, height: 860, region: park, bearingDeg: 300, elevationDeg: 55 })],
            ['flatiron_park_clay_trees_top.png', renderClayPng(layers, { kind: 'top', width: 1000, height: 1000, region: park })],
            ['flatiron_district_clay_trees_aerial.png', renderClayPng(layers, { kind: 'aerial', width: 1280, height: 860, bearingDeg: 200, elevationDeg: 40 })],
            // as mounted: remeshed tiles and trees both in studio clay
            ['flatiron_park_all_clay_aerial.png', renderClayPng(allClay, { kind: 'aerial', width: 1280, height: 860, region: park, bearingDeg: 200, elevationDeg: 30 })],
            ['flatiron_park_all_clay_top.png', renderClayPng(allClay, { kind: 'top', width: 1000, height: 1000, region: park })],
            // the devegetated photo tile before remeshing: what closing the ground added, skirts red and caps blue
            ['flatiron_park_devegetated_skirts_aerial.png', renderClayPng(closingLayers(readGlbTriangles(fs.readFileSync(strip.devegetatedGlb))), { kind: 'aerial', width: 1280, height: 860, region: park, bearingDeg: 220, elevationDeg: 50 })]
        ];
        for (const [name, png] of shots) {
            fs.writeFileSync(path.join(SHOTS, name), png);
            expect(png.length).toBeGreaterThan(20_000);
        }
    });
});
