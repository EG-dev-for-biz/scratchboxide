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

/** A vertex this far outside the footprint is a projection, not a wall off its line. */
export const FOOTPRINT_WALL_TOLERANCE_M = 0.3;
/** The furthest a projection may reach out of the footprint. */
export const FOOTPRINT_MAX_PROJECTION_M = 1.5;

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

function distToLoops(x: number, z: number, loops: Vec2[][]): number {
    let best = Infinity;
    for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
        const ax = l[j][0], az = l[j][1], dx = l[i][0] - ax, dz = l[i][1] - az, len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
    }
    return best;
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
