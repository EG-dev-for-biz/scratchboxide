/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Isolating one ordinary structure in a staged-location build, on synthetic scans with known truth:
 *
 * - touching masses: a building joined to the next one by a one-cell diagonal link (a leftover rim of crown), and to a
 *   third by an alley the scan melted shut at a lower height, is picked alone (an 8-connected region of tall cells took
 *   all three);
 * - the terrain is the walkable street, not the river beside it (a low percentile of the surface took the water as the
 *   ground and every raised street as structure);
 * - tile_refine isolates exactly the shared pick (its footprint and terrain), so the two cannot disagree: the lower
 *   neighbour built against the tower stays out, where tile_refine's own footprint rule takes it along;
 * - a roof garden whose roof the scan replaced with the planting, over a hollow building mesh, is kept as scanned with
 *   its reason, not regrown as a street tree as tall as the building.
 *
 * Screenshots: test-results/screenshots/isolation_fix/.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    checkIsolate, pickStructure, writeIsolationPick, PICK_OTHER, PICK_LOW_ATTACHMENT, PICK_STRUCTURE
} from '../src/node/3d-engine/staged-location/extraction-sizing';
import { evidenceLookup, type VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { buildGroundModel, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { renderClayPng, readGlbTriangles } from './helpers/clay-glb-render';
import { buildSyntheticTile } from './helpers/synthetic-textured-tile';
import { type Chunk, flat, quad, writeGlb, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/isolation_fix');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-isolation-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Tri = [number, number, number, number, number, number, number, number, number];

function quadTris(a: number[], b: number[], c: number[], d: number[]): Tri[] {
    return [[...a, ...b, ...c] as Tri, [...a, ...c, ...d] as Tri];
}

/** A closed box (walls subdivided every 2 m, a roof grid) from `y0` up to `h`. */
function boxTris(x0: number, x1: number, z0: number, z1: number, h: number, y0 = 0): Tri[] {
    const out: Tri[] = [];
    const wall = (ax: number, az: number, bx: number, bz: number) => {
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let i = 0; i < n; i++) {
            const p = ax + ((bx - ax) * i) / n, q = az + ((bz - az) * i) / n, r = ax + ((bx - ax) * (i + 1)) / n, s = az + ((bz - az) * (i + 1)) / n;
            for (let y = y0; y < h; y += 2) out.push(...quadTris([p, y, q], [r, y, s], [r, Math.min(h, y + 2), s], [p, Math.min(h, y + 2), q]));
        }
    };
    wall(x0, z0, x1, z0); wall(x1, z0, x1, z1); wall(x1, z1, x0, z1); wall(x0, z1, x0, z0);
    for (let x = x0; x < x1; x += 2) for (let z = z0; z < z1; z += 2) out.push(...quadTris([x, h, z], [Math.min(x1, x + 2), h, z], [Math.min(x1, x + 2), h, Math.min(z1, z + 2)], [x, h, Math.min(z1, z + 2)]));
    return out;
}

/** A level surface at height y over [x0, x1] x [z0, z1], in 4 m quads. */
function plane(x0: number, x1: number, z0: number, z1: number, y: number): Tri[] {
    const out: Tri[] = [];
    for (let x = x0; x < x1; x += 4) for (let z = z0; z < z1; z += 4) out.push(...quadTris([x, y, z], [Math.min(x1, x + 4), y, z], [Math.min(x1, x + 4), y, Math.min(z1, z + 4)], [x, y, Math.min(z1, z + 4)]));
    return out;
}

function writeTris(file: string, tris: Tri[]): string {
    writeStagedGlbFile(file, [{ positions: Float32Array.from(tris.flat()) }]);
    return file;
}

/** Aerial screenshot of a scene with the picked cells raised over it in blue. */
function shotWithPick(name: string, scene: Tri[], cells: Set<string>, liftY: number, region: [number, number, number, number]): void {
    const pts: number[] = [];
    for (const k of cells) {
        const [x, z] = k.split(',').map(Number);
        pts.push(x, liftY, z, x + 1, liftY, z, x + 1, liftY, z + 1, x, liftY, z, x + 1, liftY, z + 1, x, liftY, z + 1);
    }
    const flatScene = scene.flat();
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), renderClayPng([
        { positions: Float32Array.from(flatScene), indices: Uint32Array.from({ length: flatScene.length / 3 }, (_, i) => i) },
        ...(pts.length ? [{ positions: Float32Array.from(pts), indices: Uint32Array.from({ length: pts.length / 3 }, (_, i) => i), color: [0.0, 0.45, 0.7] as [number, number, number] }] : [])
    ], { kind: 'aerial', width: 900, height: 600, region, bearingDeg: 200, elevationDeg: 50 }));
}

describe('the structure pick separates touching masses', () => {
    // A: the building at the place. B: diagonally off its north-east corner, joined to it only by a one-cell diagonal chain
    // (a rim of crown the canopy mask left). C: north of it across a 4 m alley the scan melted shut at 7 m.
    const A = boxTris(-24, -2, -12, 12, 20);
    const B = boxTris(1, 23, 15, 37, 20);
    const link = [...boxTris(-2, -1, 12, 13, 12), ...boxTris(-1, 0, 13, 14, 12), ...boxTris(0, 1, 14, 15, 12)];
    const C = boxTris(-24, -2, 16, 40, 20);
    const melted = boxTris(-24, -2, 12, 16, 7);
    const scene = [...plane(-60, 60, -60, 60, 0), ...A, ...B, ...link, ...C, ...melted];

    it('picks the building at the place alone, without the diagonal neighbour or the one across the melted alley', () => {
        const scan = loadScanMesh(writeTris(path.join(TMP, 'touching.glb'), scene));
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        expect(ground.terrainMethod).toBe('walkable-surface');
        const pick = pickStructure(scan, ground, { anchor: { x: -10, z: 0 } })!;
        shotWithPick('pick_touching_buildings', scene, pick.cells, 21, [-40, -25, 40, 50]);
        // A is 22 x 24 m (its walls rasterise one more column and row)
        expect(pick.areaM2).toBeGreaterThan(22 * 24 * 0.95);
        expect(pick.areaM2).toBeLessThan(23 * 25 * 1.05);
        expect(pick.bounds.maxX).toBeLessThanOrEqual(0);
        expect(pick.bounds.maxZ).toBeLessThanOrEqual(14);
        // the cells left out say why: the melted alley is a low attachment, B and C are other structures
        const at = (x: number, z: number) => pick.footprintMask[ground.cellIndex(x + 0.5, z + 0.5)];
        expect(at(-12, 14)).toBe(PICK_LOW_ATTACHMENT);
        expect(at(-12, 30)).toBe(PICK_OTHER);
        expect(at(12, 26)).toBe(PICK_OTHER);
        expect(at(-12, 0)).toBe(PICK_STRUCTURE);
    });
});

describe('the terrain is the walkable street, not the water beside it', () => {
    // a street at 0 along a 70 m wide river 6 m below it (the embankment wall at x = 10), a building on the street, and a
    // terrace of houses across the street from it
    const scene = [
        ...plane(-60, 10, -60, 60, 0), ...plane(10, 80, -60, 60, -6),
        ...boxTris(-20, -4, -10, 10, 15), ...boxTris(-56, -36, -40, 40, 12)
    ];

    it('measures the ground on the street, so the street is not structure and the building stands alone', () => {
        const scan = loadScanMesh(writeTris(path.join(TMP, 'riverside.glb'), scene));
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        expect(ground.terrainMethod).toBe('walkable-surface');
        // the street reads as ground, the river below it
        expect(Math.abs(ground.groundAt(0, -30))).toBeLessThan(0.5);
        expect(Math.abs(ground.groundAt(30, 0))).toBeLessThan(1.5);
        expect(ground.open[ground.cellIndex(0.5, -30.5)]).toBe(1);
        expect(ground.open[ground.cellIndex(40.5, 0.5)]).toBe(0);
        const pick = pickStructure(scan, ground, { anchor: { x: -12, z: 0 } })!;
        shotWithPick('pick_riverside_street', scene, pick.cells, 16, [-60, -50, 60, 50]);
        expect(pick.areaM2).toBeGreaterThan(16 * 20 * 0.95);
        expect(pick.areaM2).toBeLessThan(17 * 21 * 1.05);
        expect(pick.heightM).toBeGreaterThan(14);
        expect(pick.heightM).toBeLessThan(16);
    });
});

describe('tile_refine isolates the shared pick', () => {
    const WORK = path.join(TMP, 'refine');
    const BIN = path.join(REPO, 'test-results/isolation-fix/tile_refine');

    /** Walls (facing out) and roof of an axis-aligned box. */
    function box(x0: number, x1: number, z0: number, z1: number, y1: number, skip?: '-x'): Chunk[] {
        const n = 6;
        const walls: Array<[string, Chunk]> = [
            ['+x', quad([x1, 0, z0], [0, 0, z1 - z0], [0, y1, 0], n, n)], ['-x', quad([x0, 0, z1], [0, 0, z0 - z1], [0, y1, 0], n, n)],
            ['+z', quad([x1, 0, z1], [x0 - x1, 0, 0], [0, y1, 0], n, n)], ['-z', quad([x0, 0, z0], [x1 - x0, 0, 0], [0, y1, 0], n, n)]
        ];
        return [...walls.filter(([s]) => s !== skip).map(([, c]) => c), flat(x0, x1, z0, z1, y1, n)];
    }

    it('keeps the lower neighbour built against the tower out, where its own footprint rule takes it along', () => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(path.dirname(BIN), { recursive: true });
        buildTileRefine(REPO, BIN);
        const scene = path.join(WORK, 'scene.glb');
        // a 24 m tower and a 9 m neighbour built against its east wall
        writeGlb(scene, [flat(-60, 60, -60, 60, 0, 60), ...box(-10, 2, -6, 6, 24), ...box(2, 12, -5, 5, 9, '-x')]);
        const scan = loadScanMesh(scene);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const pick = pickStructure(scan, ground, { anchor: { x: -4, z: 0 } })!;
        expect(pick.bounds.maxX).toBeLessThanOrEqual(3);
        const sbip = writeIsolationPick(path.join(WORK, 'pick.sbip'), pick, ground);
        const run = (name: string, extra: string[]) => {
            execFileSync(BIN, ['--input', scene, '--isolate', '--anchor', '-4,0', '--threads', '4', '--no-relief', '--out-textured', path.join(WORK, `${name}_t.glb`),
                '--out-clay', path.join(WORK, `${name}_clay.glb`), '--out-raw-clay', path.join(WORK, `${name}_raw.glb`), '--stats', path.join(WORK, `${name}_stats.json`), ...extra], { stdio: 'pipe', timeout: 300_000 });
            return path.join(WORK, `${name}_raw.glb`);
        };
        const own = run('own', []);
        const shared = run('shared', ['--isolate-pick', sbip]);
        const raisedEast = (glb: string) => {
            const t = readGlbTriangles(fs.readFileSync(glb));
            let n = 0;
            for (let i = 0; i < t.indices.length; i += 3) {
                let cx = 0, cy = 0;
                for (let k = 0; k < 3; k++) { cx += t.positions[3 * t.indices[i + k]]; cy += t.positions[3 * t.indices[i + k] + 1]; }
                if (cy / 3 > 2.5 && cx / 3 > 4) n++;
            }
            return n;
        };
        // tile_refine's own rule (footprint over 3 m, 4-connected) takes the neighbour; given the pick it does not
        expect(raisedEast(own)).toBeGreaterThan(20);
        expect(raisedEast(shared)).toBe(0);
        const check = checkIsolate(shared, pick, ground);
        expect(check.ok).toBe(true);
        expect(check.recall).toBeGreaterThan(0.95);
        const stats = JSON.parse(fs.readFileSync(path.join(WORK, 'shared_stats.json'), 'utf8')).isolate;
        // its footprint is the pick's cells its own surface model shows raised: the pick, less at most its outer ring
        expect(stats.sharedPick).toBe(true);
        expect(stats.footprintCells).toBeLessThanOrEqual(pick.cells.size);
        expect(stats.footprintCells).toBeGreaterThan(0.7 * pick.cells.size);
        fs.mkdirSync(SHOTS, { recursive: true });
        const tri = (glb: string, color: [number, number, number]) => { const t = readGlbTriangles(fs.readFileSync(glb)); return { positions: t.positions, indices: t.indices, color }; };
        fs.writeFileSync(path.join(SHOTS, 'tile_refine_own_rule.png'), renderClayPng([tri(own, [0.7, 0.4, 0.3])], { kind: 'aerial', width: 900, height: 600, region: [-20, -15, 20, 15], bearingDeg: 200, elevationDeg: 35 }));
        fs.writeFileSync(path.join(SHOTS, 'tile_refine_shared_pick.png'), renderClayPng([tri(shared, [0.3, 0.5, 0.7])], { kind: 'aerial', width: 900, height: 600, region: [-20, -15, 20, 15], bearingDeg: 200, elevationDeg: 35 }));
    }, 600_000);
});

describe('a roof garden over a hollow building mesh', () => {
    it('is kept as scanned with its reason, not regrown from the street the hollow mesh holds under it', async () => {
        const work = path.join(TMP, 'veg');
        fs.mkdirSync(work, { recursive: true });
        const building = { x0: 4, z0: -16, x1: 16, z1: -4, height: 15, roofBump: { x: 10, z: -10, height: 3.5, radius: 3 }, hollow: true };
        fs.writeFileSync(path.join(work, 'tile.glb'), buildSyntheticTile({ halfSize: 30, spacing: 0.75, trees: [{ x: -14, z: 10, height: 9, radius: 3.5 }], building }));
        const svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        const strip = await svc.strip({ tilePath: 'tile.glb', topDown: true });
        const crowns = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns as any[];
        const garden = crowns.find(c => Math.hypot(c.stem[0] - building.roofBump.x, c.stem[1] - building.roofBump.z) < 2);
        expect(garden).toBeDefined();
        expect(garden.status).toBe('no_measured_ground');
        expect(garden.ground.reasonCode).toBe('raised_level_not_under_it');
        expect(garden.ground.reason).toMatch(/kept as scanned/);
        // the street tree is still a tree standing on the street
        const street = crowns.find(c => Math.hypot(c.stem[0] + 14, c.stem[1] - 10) < 1.5);
        expect(street.status).toBe('tree');
        expect(Math.abs(street.supportY)).toBeLessThan(0.3);
        // nothing as tall as the building is planted
        expect(crowns.filter(c => c.status === 'tree' && c.apexAboveSupport > building.height)).toEqual([]);
        if (strip.topDownPng) { fs.mkdirSync(SHOTS, { recursive: true }); fs.copyFileSync(strip.topDownPng, path.join(SHOTS, 'roof_garden_kept_as_scanned_topdown.png')); }
    }, 600_000);
});

describe('Google vector data as evidence', () => {
    const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

    it('separates two buildings of one height at their party wall by the vector footprint, and the scan decides the shape', () => {
        // a terrace of two 15 m houses built wall to wall at x = 0: the scan alone sees one mass
        const scene = [...plane(-60, 60, -60, 60, 0), ...boxTris(-14, 0, -8, 8, 15), ...boxTris(0, 16, -8, 8, 15)];
        const scan = loadScanMesh(writeTris(path.join(TMP, 'terrace.glb'), scene));
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const alone = pickStructure(scan, ground, { anchor: { x: -7, z: 0 } })!;
        expect(alone.footprintSource).toBe('scan-geometry');
        expect(alone.bounds.maxX).toBeGreaterThan(14);   // both houses
        // the vector footprints, 0.6 m off the scan (registration), the requested house's drawn a little short
        const ev: VectorEvidence = { buildings: [{ id: 'west', parts: [[rect(-13.4, -7.4, 0.6, 7.4)]] }, { id: 'east', parts: [[rect(0.6, -7.4, 16.6, 8.6)]] }], water: [], roads: [], tiles: 1, zoom: 17 };
        const L = evidenceLookup(ev, 60);
        const pick = pickStructure(scan, ground, { anchor: { x: -7, z: 0 }, footprints: { buildingAt: L.buildingAt, buildings: ev.buildings } })!;
        shotWithPick('pick_vector_footprint_party_wall', scene, pick.cells, 16, [-30, -20, 30, 20]);
        expect(pick.footprintSource).toBe('vector-footprint');
        expect(pick.vectorFootprint).toMatchObject({ used: true, featureIds: ['west'] });
        expect(pick.vectorFootprint!.raisedShare).toBeGreaterThan(0.9);
        expect(pick.vectorFootprint!.iou).toBeGreaterThan(0.7);
        // the scan's raised cells within the tolerance of the footprint: the west house, its full width, not the east one
        expect(pick.bounds.minX).toBeLessThanOrEqual(-14);
        expect(pick.bounds.maxX).toBeLessThanOrEqual(3);
        expect(pick.areaM2).toBeGreaterThan(14 * 16 * 0.95);
        expect(pick.areaM2).toBeLessThan(17 * 17);
        expect(pick.footprintMask[ground.cellIndex(10.5, 0.5)]).toBe(PICK_OTHER);
    });

    it('keeps the geometric rule, with the reason, where the vector footprint disagrees with the scan', () => {
        const scene = [...plane(-60, 60, -60, 60, 0), ...boxTris(-14, 0, -8, 8, 15)];
        const scan = loadScanMesh(writeTris(path.join(TMP, 'disagree.glb'), scene));
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        // a footprint drawn where the scan has open ground, nearest the place
        const ev: VectorEvidence = { buildings: [{ id: 'elsewhere', parts: [[rect(1, 9, 12, 20)]] }], water: [], roads: [], tiles: 1, zoom: 17 };
        const L = evidenceLookup(ev, 60);
        const pick = pickStructure(scan, ground, { anchor: { x: 2, z: 8 }, footprints: { buildingAt: L.buildingAt, buildings: ev.buildings } })!;
        expect(pick.footprintSource).toBe('scan-geometry');
        expect(pick.vectorFootprint!.used).toBe(false);
        expect(pick.vectorFootprint!.reason).toMatch(/disagree/);
        expect(pick.areaM2).toBeGreaterThan(14 * 16 * 0.95);
    });

    it('never takes water as the ground: a river with buildings rising straight from it, a narrow quay street', () => {
        // the river (at -6) is wider than the street and the buildings stand in it; only the vector water polygon says it is water
        const scene = [
            ...plane(-60, -20, -60, 60, 0), ...plane(-20, 60, -60, 60, -6),
            ...boxTris(-50, -30, -40, -10, 14), ...boxTris(-50, -30, 10, 40, 14),
            ...boxTris(-14, 6, -50, -30, 12, -6), ...boxTris(-14, 6, -20, 0, 12, -6), ...boxTris(-14, 6, 10, 30, 12, -6), ...boxTris(20, 40, -40, -10, 12, -6), ...boxTris(20, 40, 10, 40, 12, -6)
        ];
        const scan = loadScanMesh(writeTris(path.join(TMP, 'canal.glb'), scene));
        const ev: VectorEvidence = { buildings: [], water: [[rect(-20, -70, 70, 70)]], roads: [[[-25, -60], [-25, 60]]], tiles: 1, zoom: 17 };
        const L = evidenceLookup(ev, 60);
        // without the water polygon the water, with more structure rising from it, reads as the ground
        expect(buildGroundModel(scan, { cellMeters: 1 }).groundAt(-25, 0)).toBeLessThan(-5);
        const ground = buildGroundModel(scan, { cellMeters: 1, water: L.waterAt, road: L.roadAt });
        expect(Math.abs(ground.groundAt(-25, 0))).toBeLessThan(0.5);
        expect(ground.walkable![ground.cellIndex(0.5, 5.5)]).toBe(0);
        const pick = pickStructure(scan, ground, { anchor: { x: -40, z: -25 } })!;
        expect(pick.areaM2).toBeLessThan(21 * 31 * 1.05);
        expect(pick.heightM).toBeGreaterThan(13);
    });
});
