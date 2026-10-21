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

import * as fs from 'fs';
import { mslToTileY } from './pipeline-e/solar-roof';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../../spatial/StreetViewSurveyPlanner';
import { writeStagedGlbFile } from './staged-glb-writer';
import { parseGlb, readSceneGeometry } from '../glb-geometry-patcher';

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

/**
 * The clear space the terrain leaves around the tiles' own ground, in metres, so the two surfaces never share a
 * patch of ground and fight there. Continuous; SCRATCHBOX_TERRAIN_HERO_GAP_M overrides it.
 */
export const TERRAIN_HERO_GAP_M = 15;
export function terrainHeroGapM(env: NodeJS.ProcessEnv = process.env): number {
    const v = Number(env.SCRATCHBOX_TERRAIN_HERO_GAP_M);
    return Number.isFinite(v) && v >= 0 ? v : TERRAIN_HERO_GAP_M;
}

/** Where the terrain must leave the ground to something else: a point test in the tile frame's ground plane. */
export interface TerrainHole {
    /** True where the terrain must not be (under the tiles, or within the gap around them). */
    covers(x: number, z: number): boolean;
    /** What the hole was made from, for the GLB extras and the build report. */
    describe(): Record<string, number | string>;
}

/** A disc of `radiusM` around the place, grown by `gapM`. */
export function radialHole(radiusM: number, gapM = 0): TerrainHole {
    const r = radiusM + gapM;
    return { covers: (x, z) => Math.hypot(x, z) <= r, describe: () => ({ kind: 'radius', radiusM, gapM }) };
}

/**
 * The ground the tiles actually occupy: their vertices binned into `cellM` ground cells, grown by `gapM` on every
 * side. A leaf tile is kept whole, so the tiles reach past the covered radius by up to a leaf; measuring their
 * vertices instead of assuming a disc is what keeps the terrain off the real tile edge.
 */
export function coverageHole(tilePositions: ArrayLike<number>, opts: { cellM?: number; gapM?: number } = {}): TerrainHole {
    const cellM = opts.cellM ?? 10;
    const gapM = opts.gapM ?? 0;
    const n = Math.floor(tilePositions.length / 3);
    if (n === 0) throw new Error('terrain: the tiles have no vertices to measure their ground from');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = tilePositions[i * 3], z = tilePositions[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const grow = Math.ceil(gapM / cellM);
    const x0 = minX - grow * cellM, z0 = minZ - grow * cellM;
    const cols = Math.floor((maxX - x0) / cellM) + 1 + grow, rows = Math.floor((maxZ - z0) / cellM) + 1 + grow;
    const occupied = new Uint8Array(cols * rows);
    let occupiedCells = 0;
    for (let i = 0; i < n; i++) {
        const c = Math.floor((tilePositions[i * 3] - x0) / cellM), r = Math.floor((tilePositions[i * 3 + 2] - z0) / cellM);
        const k = r * cols + c;
        if (!occupied[k]) { occupied[k] = 1; occupiedCells++; }
    }
    // grow by the gap: a cell is covered when an occupied cell's nearest point lies within gapM of its centre
    const covered = new Uint8Array(cols * rows);
    let coveredCells = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            let hit = false;
            for (let dr = -grow; dr <= grow && !hit; dr++) {
                const rr = r + dr; if (rr < 0 || rr >= rows) continue;
                for (let dc = -grow; dc <= grow; dc++) {
                    const cc = c + dc; if (cc < 0 || cc >= cols || !occupied[rr * cols + cc]) continue;
                    const ddx = Math.max(0, Math.abs(dc) - 1) * cellM, ddz = Math.max(0, Math.abs(dr) - 1) * cellM;
                    if (Math.hypot(ddx, ddz) <= gapM) { hit = true; break; }
                }
            }
            if (hit) { covered[r * cols + c] = 1; coveredCells++; }
        }
    }
    return {
        covers: (x, z) => {
            const c = Math.floor((x - x0) / cellM), r = Math.floor((z - z0) / cellM);
            return c >= 0 && c < cols && r >= 0 && r < rows && covered[r * cols + c] === 1;
        },
        describe: () => ({ kind: 'tile-coverage', cellM, gapM, tileVertices: n, occupiedCells, coveredCells })
    };
}

/** The coverage hole of an extraction's geometry GLB (every rendered vertex, in the tile frame). */
export function coverageHoleFromGlb(file: string, opts: { cellM?: number; gapM?: number } = {}): TerrainHole {
    const { positions } = readSceneGeometry(parseGlb(fs.readFileSync(file)));
    return coverageHole(positions, opts);
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
 * triangle that touches the hole (any corner or its centre) left out, so no terrain triangle reaches onto the
 * tiles' ground. A plain number is a disc of that radius.
 */
export function buildTerrainMesh(origin: GeodeticOrigin, plan: TerrainPlan, heightsMsl: ArrayLike<number>, hole: number | TerrainHole): TerrainMesh {
    const h = typeof hole === 'number' ? radialHole(hole) : hole;
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
    const inHole = (i: number) => h.covers(positions[i * 3], positions[i * 3 + 2]);
    const centreInHole = (t: number[]) => h.covers(
        (positions[t[0] * 3] + positions[t[1] * 3] + positions[t[2] * 3]) / 3,
        (positions[t[0] * 3 + 2] + positions[t[1] * 3 + 2] + positions[t[2] * 3 + 2]) / 3);
    const indices: number[] = [];
    let holeTriangles = 0;
    for (let r = 0; r < n - 1; r++) {
        for (let c = 0; c < n - 1; c++) {
            const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
            for (const tri of [[a, d, b], [b, d, e]]) {
                if (inHole(tri[0]) || inHole(tri[1]) || inHole(tri[2]) || centreInHole(tri)) { holeTriangles++; continue; }
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
