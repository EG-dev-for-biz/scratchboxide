/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Request-sized extraction and the one structure pick: a canopy-masked footprint, the containment loop and its cap,
 * the district fallbacks, and the IoU check against the structure tile_refine isolated. Synthetic scans with known
 * truth; the "extraction" keeps the triangles whose centroid lies within the square a crawl of whole leaves would
 * reach (radius + 10 m), cutting anything longer, as leaves do. Screenshot: the plaza and the structure picked.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    containmentRadius, footprintIoU, grownOutline, isolatedStructureCells, pickStructure, sizeExtraction, touchesEdge,
    CONTAINMENT_MAX_RADIUS_M, NO_STRUCTURE_DISTRICT_RADIUS_M
} from '../src/node/3d-engine/staged-location/extraction-sizing';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { buildGroundModel, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { CanopyMask } from '../src/common/spatial/staged-location-contracts';
import { renderClayPng } from './helpers/clay-glb-render';
import { STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-sizing-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Tri = [number, number, number, number, number, number, number, number, number];

function quad(a: number[], b: number[], c: number[], d: number[]): Tri[] {
    return [[...a, ...b, ...c] as Tri, [...a, ...c, ...d] as Tri];
}

/** A closed box (4 walls subdivided every 2 m, a roof): a building. */
function building(x0: number, x1: number, z0: number, z1: number, h: number): Tri[] {
    const out: Tri[] = [];
    const steps = (a: number, b: number) => Math.max(1, Math.ceil(Math.abs(b - a) / 2));
    const wall = (ax: number, az: number, bx: number, bz: number) => {
        const n = steps(0, Math.hypot(bx - ax, bz - az));
        for (let i = 0; i < n; i++) {
            const p = ax + ((bx - ax) * i) / n, q = az + ((bz - az) * i) / n, r = ax + ((bx - ax) * (i + 1)) / n, s = az + ((bz - az) * (i + 1)) / n;
            for (let y = 0; y < h; y += 2) out.push(...quad([p, y, q], [r, y, s], [r, Math.min(h, y + 2), s], [p, Math.min(h, y + 2), q]));
        }
    };
    wall(x0, z0, x1, z0); wall(x1, z0, x1, z1); wall(x1, z1, x0, z1); wall(x0, z1, x0, z0);
    for (let x = x0; x < x1; x += 2) for (let z = z0; z < z1; z += 2) out.push(...quad([x, h, z], [Math.min(x1, x + 2), h, z], [Math.min(x1, x + 2), h, Math.min(z1, z + 2)], [x, h, Math.min(z1, z + 2)]));
    return out;
}

/** A tree crown: a dome of quads over a disc. */
function crown(cx: number, cz: number, r: number, h: number): Tri[] {
    const out: Tri[] = [];
    const y = (x: number, z: number) => { const d = Math.hypot(x - cx, z - cz); return d >= r ? 0.2 : 2 + h * Math.sqrt(1 - (d / r) ** 2); };
    for (let x = cx - r; x < cx + r; x += 1) for (let z = cz - r; z < cz + r; z += 1) {
        if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > r) continue;
        out.push(...quad([x, y(x, z), z], [x + 1, y(x + 1, z), z], [x + 1, y(x + 1, z + 1), z + 1], [x, y(x, z + 1), z + 1]));
    }
    return out;
}

function groundGrid(half: number): Tri[] {
    const out: Tri[] = [];
    for (let x = -half; x < half; x += 4) for (let z = -half; z < half; z += 4) out.push(...quad([x, 0, z], [x + 4, 0, z], [x + 4, 0, z + 4], [x, 0, z + 4]));
    return out;
}

function writeTris(file: string, tris: Tri[]): string {
    const positions = Float32Array.from(tris.flat());
    writeStagedGlbFile(file, [{ positions }]);
    return file;
}

/** An extractor over a synthetic world: whole triangles whose centroid lies within radius + 10 m (a leaf's reach). */
function worldExtractor(world: Tri[], name: string) {
    const calls: number[] = [];
    return {
        calls,
        extract: async (radiusM: number) => {
            calls.push(radiusM);
            const reach = radiusM + 10;
            const kept = world.filter(t => Math.abs((t[0] + t[3] + t[6]) / 3) <= reach && Math.abs((t[2] + t[5] + t[8]) / 3) <= reach);
            return { texturedGlb: writeTris(path.join(TMP, `${name}_r${radiusM}.glb`), kept), radiusM };
        }
    };
}

describe('pickStructure and the IoU check: the plaza', () => {
    // two buildings around a plaza, the geocoded point (0, 0) in between and nearer the west one
    const west = building(-24, -6, -10, 10, 18);
    const east = building(9, 27, -10, 10, 22);
    const scanFile = writeTris(path.join(TMP, 'plaza.glb'), [...groundGrid(60), ...west, ...east]);

    it('picks the nearest structure by tile_refine\'s rule, and tile_refine\'s isolate of the same one agrees (IoU >= 0.7)', () => {
        const scan = loadScanMesh(scanFile);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const pick = pickStructure(scan, ground)!;
        expect(pick).toBeDefined();
        // the west building's east face is at x = -6, rasterised into the cell [-6, -5): its centre is 5.5 m away
        expect(pick.seed.x).toBeLessThan(-5);
        expect(pick.geocodeToStructureM).toBeCloseTo(5.5, 0);
        expect(pick.bounds.maxX).toBeLessThanOrEqual(-5);
        expect(pick.areaM2).toBeGreaterThan(18 * 20 * 0.9);
        expect(pick.areaM2).toBeLessThan(18 * 20 * 1.3);
        expect(pick.heightM).toBeCloseTo(18, 0);
        expect(pick.facadeHeadingsDeg.length).toBeGreaterThanOrEqual(4);

        // tile_refine isolated the same building: its raw_clay holds it with an apron
        const isoSame = writeTris(path.join(TMP, 'iso_west.glb'), [...groundGrid(30).map(t => t.map((v, i) => (i % 3 === 0 ? v - 15 : v)) as Tri).filter(t => t[0] < -1), ...west]);
        const same = isolatedStructureCells(isoSame, pick.seed);
        expect(footprintIoU(pick.cells, same.cells)).toBeGreaterThanOrEqual(0.7);
        // forced to the other building, the IoU says the pick does not match (isolate_mismatch)
        const isoOther = writeTris(path.join(TMP, 'iso_east.glb'), [...groundGrid(40), ...east]);
        const other = isolatedStructureCells(isoOther, { x: 9.5, z: 0 });
        expect(footprintIoU(pick.cells, other.cells)).toBeLessThan(0.1);

        // screenshot: the plaza, the picked structure's cells raised in blue
        const cells: number[] = [];
        for (const k of pick.cells) {
            const [x, z] = k.split(',').map(Number);
            cells.push(x, 19, z, x + 1, 19, z, x + 1, 19, z + 1, x, 19, z, x + 1, 19, z + 1, x, 19, z + 1);
        }
        const scanTris = [...groundGrid(60), ...west, ...east].flat();
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'sizing_plaza_pick.png'), renderClayPng([
            { positions: Float32Array.from(scanTris), indices: Uint32Array.from({ length: scanTris.length / 3 }, (_, i) => i) },
            { positions: Float32Array.from(cells), indices: Uint32Array.from({ length: cells.length / 3 }, (_, i) => i), color: [0.0, 0.45, 0.7] }
        ], { kind: 'aerial', width: 900, height: 600, region: [-40, -30, 40, 30], bearingDeg: 200, elevationDeg: 50 }));
    });

    it('masks tree canopy out of the footprint when the classifier marks it, and keeps a touching crown without a mask', () => {
        const tree = crown(-24 - 5.5, 0, 6, 8); // its crown overlaps the west wall
        const file = writeTris(path.join(TMP, 'plaza_tree.glb'), [...groundGrid(60), ...west, ...tree]);
        const scan = loadScanMesh(file);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const unmasked = pickStructure(scan, ground)!;
        expect(unmasked.bounds.minX).toBeLessThan(-30); // the crown joined the footprint
        // the canopy classifier's mask: the crown's disc
        const x0 = -60, z0 = -60, nx = 120, nz = 120;
        const flags: number[] = [];
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) flags.push(Math.hypot(x0 + i + 0.5 + 29.5, z0 + k + 0.5) <= 7 && x0 + i + 0.5 < -24 ? 1 : 0);
        const runs: number[] = [];
        let cur = 0, len = 0;
        for (const f of flags) { if (f === cur) len++; else { runs.push(len); cur = f; len = 1; } }
        runs.push(len);
        const mask: CanopyMask = { schema: 'scratchbox.canopy-mask/1', cellM: 1, x0, z0, nx, nz, runs, canopyCells: flags.filter(Boolean).length, ms: 1 };
        return sizeExtraction({ extract: async () => ({ texturedGlb: file }), canopy: async () => mask }).then(r => {
            expect(r.sizedTo).toBe('structure');
            expect(r.structure!.bounds.minX).toBeGreaterThanOrEqual(-25);
            expect(r.structure!.canopyCellsMasked).toBeGreaterThan(50);
            expect(r.notes).toEqual([]);
        });
    });
});

describe('the containment loop', () => {
    it('grows the extraction until a long structure is contained, recording the rounds', async () => {
        const world = [...groundGrid(200), ...building(-2, 60, -10, 10, 15)];
        const ex = worldExtractor(world, 'long60');
        const r = await sizeExtraction({ extract: ex.extract, canopy: undefined });
        expect(r.sizedTo).toBe('structure');
        expect(ex.calls[0]).toBe(25);
        expect(ex.calls.length).toBe(r.rounds);
        expect(r.rounds).toBeGreaterThan(1);
        expect(ex.calls).toEqual([...ex.calls].sort((a, b) => a - b));
        expect(r.structure!.bounds.maxX).toBeGreaterThanOrEqual(59);
        expect(touchesEdge(r.structure!, r.ground!)).toBe(false);
        expect(r.notes.map(n => n.reasonCode)).toEqual(['canopy_not_masked']);
    });

    it('falls back to the district at the last radius when the structure still touches the edge after 3 rounds', async () => {
        const world = [...groundGrid(220), ...building(-2, 210, -10, 10, 15)];
        const ex = worldExtractor(world, 'long210');
        const r = await sizeExtraction({ extract: ex.extract });
        expect(r.sizedTo).toBe('district-fallback');
        expect(r.structure).toBeUndefined();
        expect(ex.calls.length).toBeLessThanOrEqual(4);
        expect(Math.max(...ex.calls)).toBeLessThanOrEqual(CONTAINMENT_MAX_RADIUS_M);
        expect(r.radiusM).toBe(ex.calls[ex.calls.length - 1]);
        expect(r.notes.find(n => n.reasonCode === 'containment_failed')?.reason).toBe(`the structure extends past ${r.radiusM} m; showing the district around it without a rebuild`);
    });

    it('shows the area at 60 m when no structure stands at the place, and goes on when the canopy mask fails', async () => {
        // a low planting (under 3 m): no structure
        const ex = worldExtractor([...groundGrid(100), ...crown(0, 0, 3, 0.4)], 'park');
        const r = await sizeExtraction({ extract: ex.extract, canopy: async () => { throw new Error('canopy subcommand exited 1'); } });
        expect(r.sizedTo).toBe('district-fallback');
        expect(r.radiusM).toBe(NO_STRUCTURE_DISTRICT_RADIUS_M);
        expect(ex.calls).toEqual([25, 60]);
        expect(r.notes.map(n => n.reasonCode)).toEqual(['canopy_not_masked', 'no_structure_at_anchor']);
        expect(r.notes[0].error).toBe('canopy subcommand exited 1');
    });

    it('sizes the next radius from the footprint and grows the outline for the strip ROI', () => {
        expect(containmentRadius({ bounds: { minX: -10, maxX: 30, minZ: -5, maxZ: 5 } })).toBe(Math.ceil(Math.hypot(30, 5) + Math.max(8, 0.25 * Math.hypot(40, 10))));
        const grown = grownOutline([[0, 0], [10, 0], [10, 10], [0, 10]], 12);
        for (const [x, z] of grown) {
            const dx = Math.max(0, -x, x - 10), dz = Math.max(0, -z, z - 10);
            expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(12 - 1e-6);
            expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(12 / Math.cos(Math.PI / 12) + 1e-3); // rounded to the millimetre
        }
    });
});
