/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The terrain around a staged place: a heightfield of the real ground, measured by the Google Elevation API (the app's
 * elevation standard, heights above mean sea level, EGM96), in the tile frame (x east, y up, z south; the frame
 * origin's ellipsoidal height taken out, as mslToTileY does), reaching TERRAIN_RADIUS_M in every direction. The grid
 * is fine near the place and coarser outward, and the triangles under the extracted tiles are left out, so the
 * tiles' own ground is what shows there and the terrain carries on from its edge.
 *
 * Measured geometry: the surface is the API's samples, nothing invented between them beyond straight triangles.
 */

import { mslToTileY } from './pipeline-e/solar-roof';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../../spatial/StreetViewSurveyPlanner';
import { writeStagedGlbFile } from './staged-glb-writer';

/** How far the terrain reaches from the place, in every direction. */
export const TERRAIN_RADIUS_M = 4000;
/** Within this distance the grid is TERRAIN_INNER_STEP_M; beyond it TERRAIN_OUTER_STEP_M. */
export const TERRAIN_INNER_RADIUS_M = 1000;
export const TERRAIN_INNER_STEP_M = 50;
export const TERRAIN_OUTER_STEP_M = 150;

export interface TerrainPlan {
    /** The grid's axis values (metres from the place), the same along x and z; symmetric, increasing. */
    axis: number[];
    /** Every grid point's geodetic position, row-major (z outer, x inner). */
    points: Array<{ lat: number; lng: number }>;
}

/** The axis of a grid that is `innerStep` out to `innerRadius` and `outerStep` out to `radius`, both ways from 0. */
export function terrainAxis(radius = TERRAIN_RADIUS_M, innerRadius = TERRAIN_INNER_RADIUS_M, innerStep = TERRAIN_INNER_STEP_M, outerStep = TERRAIN_OUTER_STEP_M): number[] {
    const half: number[] = [];
    for (let v = innerStep; v <= innerRadius + 1e-6; v += innerStep) half.push(v);
    for (let v = innerRadius + outerStep; v <= radius + 1e-6; v += outerStep) half.push(v);
    if (half[half.length - 1] < radius - 1e-6) half.push(radius);
    return [...half.map(v => -v).reverse(), 0, ...half];
}

/** The grid's points as geodetic coordinates in the extraction's frame. */
export function planTerrainGrid(origin: GeodeticOrigin, axis = terrainAxis()): TerrainPlan {
    const points: Array<{ lat: number; lng: number }> = [];
    for (const z of axis) {
        for (const x of axis) {
            const g = scanToGeodetic(origin, x, 0, z);
            points.push({ lat: g.lat, lng: g.lng });
        }
    }
    return { axis, points };
}

export interface TerrainMesh {
    positions: Float32Array;
    indices: Uint32Array;
    /** Tile-frame y range of the surface. */
    minY: number;
    maxY: number;
    /** Triangles left out under the tiles. */
    holeTriangles: number;
}

/**
 * The heightfield mesh from the grid's heights (metres above mean sea level, one per point, row-major), with every
 * triangle whose three corners lie within `holeRadiusM` of the place left out.
 */
export function buildTerrainMesh(origin: GeodeticOrigin, plan: TerrainPlan, heightsMsl: ArrayLike<number>, holeRadiusM: number): TerrainMesh {
    const n = plan.axis.length;
    if (heightsMsl.length !== n * n) throw new Error(`terrain: ${heightsMsl.length} heights for a ${n} x ${n} grid`);
    const positions = new Float32Array(n * n * 3);
    let minY = Infinity, maxY = -Infinity;
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const i = r * n + c;
            const p = plan.points[i];
            const local = geodeticToScan(origin, p.lat, p.lng);
            const y = mslToTileY(heightsMsl[i], p.lat, p.lng, origin.heightMeters);
            positions[i * 3] = local.x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = local.z;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    const inHole = (i: number) => Math.hypot(positions[i * 3], positions[i * 3 + 2]) <= holeRadiusM;
    const indices: number[] = [];
    let holeTriangles = 0;
    for (let r = 0; r < n - 1; r++) {
        for (let c = 0; c < n - 1; c++) {
            const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
            for (const tri of [[a, d, b], [b, d, e]]) {
                if (inHole(tri[0]) && inHole(tri[1]) && inHole(tri[2])) { holeTriangles++; continue; }
                indices.push(tri[0], tri[1], tri[2]);
            }
        }
    }
    return { positions, indices: new Uint32Array(indices), minY, maxY, holeTriangles };
}

/** Writes the terrain as a staged GLB (one node, normals computed) and returns its size. */
export function writeTerrainGlb(file: string, mesh: TerrainMesh, extras: Record<string, unknown>): { path: string; bytes: number } {
    return writeStagedGlbFile(file, [{ name: 'terrain', positions: mesh.positions, indices: mesh.indices, extras }], {
        rootExtras: { sbTerrain: extras },
        generator: 'scratchbox staged-location terrain-surround'
    });
}
