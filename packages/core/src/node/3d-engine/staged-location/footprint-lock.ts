/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The footprint lock's check on a built layer (user decision, 2026-10-22: the building footprint is the source of truth
 * for every rebuild). Each vertex of the built mesh is measured in plan against the footprint the massing was built on:
 * how far it stands outside. Walls stand on the footprint; only projections (cornices, bands, sills, members) may reach
 * out, at most FOOTPRINT_MAX_PROJECTION_M.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { parseGlbBytes } from './glb-bytes';
import { applyRemeshEdits, REMESH_CLEANUP_PARAMS, weldGlb, type RemeshEdits } from './remesh-cleanup';

/** A vertex this far outside the footprint is a projection, not a wall off its line. */
export const FOOTPRINT_WALL_TOLERANCE_M = 0.3;
/** The furthest a projection may reach out of the footprint. */
export const FOOTPRINT_MAX_PROJECTION_M = 1.5;
/** The GLB `asset.extras` key and version the clamp pass stamps on a layer it corrected. */
export const FOOTPRINT_CLAMP_VERSION = 'footprint-lock-clamp/1';

export interface FootprintConformance {
    vertices: number;
    /** Share of the vertices more than FOOTPRINT_WALL_TOLERANCE_M outside the footprint. */
    outsideShare: number;
    /** The furthest any vertex stands outside, metres. */
    maxOutsideM: number;
    /** Vertices beyond FOOTPRINT_MAX_PROJECTION_M. */
    beyondLimit: number;
    ok: boolean;
}

function inLoops(x: number, z: number, loops: Vec2[][]): boolean {
    let inside = false;
    for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        if ((l[i][1] > z) !== (l[j][1] > z) && x < (l[j][0] - l[i][0]) * (z - l[i][1]) / (l[j][1] - l[i][1]) + l[i][0]) inside = !inside;
    }
    return inside;
}

/** The closest point to (x, z) on any loop's boundary, and the distance to it. */
function nearestOnLoops(x: number, z: number, loops: Vec2[][]): { x: number; z: number; dist: number } {
    let best = Infinity, bx = x, bz = z;
    for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        const ax = l[j][0], az = l[j][1], dx = l[i][0] - ax, dz = l[i][1] - az, len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        const px = ax + t * dx, pz = az + t * dz, d = Math.hypot(x - px, z - pz);
        if (d < best) { best = d; bx = px; bz = pz; }
    }
    return { x: bx, z: bz, dist: best };
}

function distToLoops(x: number, z: number, loops: Vec2[][]): number {
    return nearestOnLoops(x, z, loops).dist;
}

/** How a built mesh (xyz vertices, y up) stands against the footprint `loops` (one or more rings, plan x, z). */
export function footprintConformance(vertices: ArrayLike<number>, loops: Vec2[][]): FootprintConformance {
    const n = Math.floor(vertices.length / 3);
    let outside = 0, beyond = 0, maxOut = 0;
    for (let k = 0; k < n; k++) {
        const x = vertices[k * 3], z = vertices[k * 3 + 2];
        if (inLoops(x, z, loops)) continue;
        const d = distToLoops(x, z, loops);
        if (d > FOOTPRINT_WALL_TOLERANCE_M) outside++;
        if (d > FOOTPRINT_MAX_PROJECTION_M) beyond++;
        maxOut = Math.max(maxOut, d);
    }
    return { vertices: n, outsideShare: n ? outside / n : 0, maxOutsideM: Math.round(maxOut * 100) / 100, beyondLimit: beyond, ok: beyond === 0 };
}

export interface FootprintClampResult {
    /** The clamped clay GLB, and the same edits applied to every GLB passed as `others` (its textured twin). */
    clay: Buffer;
    others: Buffer[];
    /** Vertices pulled back; 0 means nothing breached and `clay`/`others` are untouched copies of the input bytes. */
    pulled: number;
    /** The furthest any pulled vertex stood outside before the clamp, metres. */
    maxOutBeforeM: number;
}

/** A vertex is pulled to this far short of `limit`, so a conformance re-check (after the position is rounded to a GLB's
 * float32 storage) reads it as within the limit rather than landing a hair over it from rounding alone. */
const FOOTPRINT_CLAMP_MARGIN_M = 0.01;

/**
 * Pulls every vertex of a welded mesh standing more than `limit` outside `loops` back to just inside `limit` (by
 * FOOTPRINT_CLAMP_MARGIN_M, to survive float32 rounding), along the line from the nearest footprint edge through the
 * vertex (plan only; height untouched) -- the same clamp-and-rewrite shape as remesh-cleanup's clamp-to-scan pass
 * (cleanupEdits), just toward the footprint boundary instead of toward the pre-smoothing scan position. A vertex
 * already within `limit` (walls on the footprint, short projections) is untouched.
 */
export function footprintClampEdits(mesh: { positions: Float64Array; keys: string[] }, loops: Vec2[][], limit = FOOTPRINT_MAX_PROJECTION_M): { shift: Map<string, [number, number, number]>; pulled: number; maxOutBeforeM: number } {
    const shift = new Map<string, [number, number, number]>();
    const V = mesh.positions.length / 3;
    const target = Math.max(0, limit - FOOTPRINT_CLAMP_MARGIN_M);
    let pulled = 0, maxOutBefore = 0;
    for (let v = 0; v < V; v++) {
        const x = mesh.positions[v * 3], z = mesh.positions[v * 3 + 2];
        if (inLoops(x, z, loops)) continue;
        const near = nearestOnLoops(x, z, loops);
        if (near.dist <= limit) continue;
        maxOutBefore = Math.max(maxOutBefore, near.dist);
        const dx = x - near.x, dz = z - near.z, scale = near.dist > 1e-9 ? target / near.dist : 0;
        shift.set(mesh.keys[v], [near.x + dx * scale - x, 0, near.z + dz * scale - z]);
        pulled++;
    }
    return { shift, pulled, maxOutBeforeM: Math.round(maxOutBefore * 100) / 100 };
}

/**
 * Re-fits a breached layer instead of committing it as built: pulls `clayBytes` (and its textured twin(s) `others`, the
 * same vertices split by photo material) back onto the footprint `loops`, wherever a vertex stands more than `limit`
 * outside it. Reuses `applyRemeshEdits`'s proven parse/patch/reserialize path (positions and normals rewritten in place,
 * accessor bounds updated) rather than inventing new GLB plumbing; stamps its own `sbFootprintLockClamp` extras tag so
 * the correction is distinguishable from remesh-cleanup's unrelated scan-smoothing clamp.
 */
export function clampToFootprint(clayBytes: Uint8Array, others: Uint8Array[], loops: Vec2[][], limit = FOOTPRINT_MAX_PROJECTION_M): FootprintClampResult {
    const mesh = weldGlb(parseGlbBytes(clayBytes));
    const { shift, pulled, maxOutBeforeM } = footprintClampEdits(mesh, loops, limit);
    if (!pulled) return { clay: Buffer.from(clayBytes), others: others.map(b => Buffer.from(b)), pulled: 0, maxOutBeforeM: 0 };
    // RemeshEdits.stats is remesh-cleanup's own shape; this pass stamps its own extras below instead of reading it back,
    // so these fields are unused placeholders, not a claim that a remesh-cleanup pass ran.
    const edits: RemeshEdits = {
        shift, removed: new Set(),
        stats: { vertices: mesh.positions.length / 3, triangles: 0, pieces: 0, piecesRemoved: 0, trianglesRemoved: 0, areaRemovedM2: 0, meanShiftM: 0, p95ShiftM: 0, maxShiftM: 0, clampedVertices: pulled }
    };
    const extras = { key: 'sbFootprintLockClamp', value: { version: FOOTPRINT_CLAMP_VERSION, pulled, maxOutBeforeM, limitM: limit } };
    return {
        clay: applyRemeshEdits(clayBytes, edits, REMESH_CLEANUP_PARAMS.weldM, extras).glb,
        others: others.map(b => applyRemeshEdits(b, edits, REMESH_CLEANUP_PARAMS.weldM, extras).glb),
        pulled, maxOutBeforeM
    };
}
