/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The terrain around a staged place: a fine-then-coarse grid out to the terrain radius, each height put into the tile
 * frame through the geoid and the frame origin's height, the triangles under the tiles left out, and a GLB with the
 * measured counts.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    TERRAIN_HERO_GAP_M, TERRAIN_INNER_RADIUS_M, TERRAIN_INNER_STEP_M, TERRAIN_OUTER_STEP_M, TERRAIN_RADIUS_M,
    buildTerrainMesh, coverageHole, planTerrainGrid, terrainAxis, terrainHeroGapM, writeTerrainGlb
} from '../src/node/3d-engine/staged-location/terrain-surround';
import { mslToTileY } from '../src/node/3d-engine/staged-location/pipeline-e/solar-roof';
import { measureGlbMeshCounts } from '../src/common/glb-mesh-counts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-terrain-'));
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

describe('terrain-surround', () => {
    it('lays a symmetric grid, fine near the place and coarse to the terrain radius', () => {
        const axis = terrainAxis();
        expect(axis[0]).toBe(-TERRAIN_RADIUS_M);
        expect(axis[axis.length - 1]).toBe(TERRAIN_RADIUS_M);
        expect(axis).toContain(0);
        expect(axis).toEqual([...axis].sort((a, b) => a - b));
        const steps = axis.slice(1).map((v, i) => v - axis[i]);
        expect(steps.slice(0, 3)).toEqual([TERRAIN_OUTER_STEP_M, TERRAIN_OUTER_STEP_M, TERRAIN_OUTER_STEP_M]);
        const mid = Math.floor(axis.length / 2);
        expect(steps[mid]).toBe(TERRAIN_INNER_STEP_M);
        expect(axis.filter(v => Math.abs(v) <= TERRAIN_INNER_RADIUS_M).length).toBe(2 * TERRAIN_INNER_RADIUS_M / TERRAIN_INNER_STEP_M + 1);
        // 81 x 81 points: thirteen Elevation API requests of up to 512
        expect(axis.length * axis.length).toBe(6561);
    });

    it('puts measured heights into the tile frame, leaves the tiles\' footprint out, and writes a GLB with the counts', () => {
        const origin = { lat: 51.508039, lng: -0.128069, heightMeters: 53.2 };
        const axis = terrainAxis(300, 100, 50, 100); // a small grid: 9 x 9
        const plan = planTerrainGrid(origin, axis);
        expect(plan.points.length).toBe(81);
        // the centre point is the place itself
        const centre = plan.points[40];
        expect(centre.lat).toBeCloseTo(origin.lat, 6);
        expect(centre.lng).toBeCloseTo(origin.lng, 6);
        // a slope rising to the east: 10 m + 0.01 m per metre of x
        const heights = plan.points.map((_, i) => 10 + 0.01 * axis[i % 9]);
        const mesh = buildTerrainMesh(origin, plan, heights, 120);
        // x east, z south, y from mean sea level through the geoid and the frame origin's height
        const i = 4 * 9 + 8; // centre row, easternmost column
        expect(mesh.positions[i * 3]).toBeCloseTo(300, 0);
        expect(Math.abs(mesh.positions[i * 3 + 2])).toBeLessThan(1);
        expect(mesh.positions[i * 3 + 1]).toBeCloseTo(mslToTileY(13, plan.points[i].lat, plan.points[i].lng, origin.heightMeters), 3);
        expect(mesh.maxY - mesh.minY).toBeCloseTo(6, 1);
        // every triangle that touches the 120 m disc is left out, so no kept triangle has a corner within it
        expect(mesh.holeTriangles).toBeGreaterThan(0);
        expect(mesh.indices.length / 3 + mesh.holeTriangles).toBe(8 * 8 * 2);
        for (let k = 0; k < mesh.indices.length; k++) {
            const v = mesh.indices[k];
            expect(Math.hypot(mesh.positions[v * 3], mesh.positions[v * 3 + 2])).toBeGreaterThan(120);
        }
        const file = path.join(WORK, 'terrain.glb');
        const written = writeTerrainGlb(file, mesh, { radiusM: 300 });
        expect(written.bytes).toBeGreaterThan(1000);
        const counts = measureGlbMeshCounts(fs.readFileSync(file));
        expect(counts.vertexCount).toBe(81);
        expect(counts.triangleCount).toBe(mesh.indices.length / 3);
    });

    it('keeps the terrain a clear gap away from the ground the tiles actually occupy, not a disc', () => {
        const origin = { lat: 0, lng: 0, heightMeters: 0 };
        const axis = terrainAxis(400, 400, 50, 50); // 17 x 17, 50 m cells
        const plan = planTerrainGrid(origin, axis);
        const heights = plan.points.map(() => 0);
        // the tiles: a 100 m x 200 m block of ground offset to the east, reaching x in [0, 100], z in [-100, 100]
        const tiles: number[] = [];
        for (let x = 0; x <= 100; x += 5) for (let z = -100; z <= 100; z += 5) tiles.push(x, 3, z);
        const hole = coverageHole(tiles, { cellM: 10, gapM: TERRAIN_HERO_GAP_M });
        expect(hole.describe()).toMatchObject({ kind: 'tile-coverage', gapM: TERRAIN_HERO_GAP_M });
        expect(hole.covers(50, 0)).toBe(true);
        expect(hole.covers(110, 0)).toBe(true);   // within the 15 m gap of the tiles' east edge
        expect(hole.covers(-30, 0)).toBe(false);  // 30 m west of the tiles: terrain
        expect(hole.covers(0, 140)).toBe(false);
        const mesh = buildTerrainMesh(origin, plan, heights, hole);
        expect(mesh.holeTriangles).toBeGreaterThan(0);
        // no kept triangle has a corner on the tiles or within the gap, and the far west of the grid is all kept
        const nearest = { d: Infinity };
        for (let k = 0; k < mesh.indices.length; k++) {
            const v = mesh.indices[k];
            const x = mesh.positions[v * 3], z = mesh.positions[v * 3 + 2];
            expect(hole.covers(x, z)).toBe(false);
            if (Math.abs(z) <= 100) nearest.d = Math.min(nearest.d, x <= 0 ? -x : x - 100);
        }
        expect(nearest.d).toBeGreaterThanOrEqual(TERRAIN_HERO_GAP_M);
        expect(nearest.d).toBeLessThanOrEqual(TERRAIN_HERO_GAP_M + 50); // one grid cell past the gap at most
        // a disc reaching the tiles' farthest corner (what a radius must do to clear them) takes the terrain west of
        // the place as well, where there are no tiles
        const disc = buildTerrainMesh(origin, plan, heights, Math.hypot(100, 100));
        expect(disc.holeTriangles).toBeGreaterThan(mesh.holeTriangles * 1.5);
        expect(() => coverageHole([], {})).toThrow(/no vertices/);
    });

    it('reads the gap from the environment, continuous, never negative', () => {
        expect(terrainHeroGapM({})).toBe(TERRAIN_HERO_GAP_M);
        expect(terrainHeroGapM({ SCRATCHBOX_TERRAIN_HERO_GAP_M: '7.5' })).toBe(7.5);
        expect(terrainHeroGapM({ SCRATCHBOX_TERRAIN_HERO_GAP_M: '-3' })).toBe(TERRAIN_HERO_GAP_M);
        expect(terrainHeroGapM({ SCRATCHBOX_TERRAIN_HERO_GAP_M: 'wide' })).toBe(TERRAIN_HERO_GAP_M);
    });

    it('refuses a height count that does not match the grid', () => {
        const origin = { lat: 0, lng: 0, heightMeters: 0 };
        const plan = planTerrainGrid(origin, terrainAxis(100, 50, 50, 50));
        expect(() => buildTerrainMesh(origin, plan, [1, 2, 3], 0)).toThrow(/heights for a/);
    });
});
