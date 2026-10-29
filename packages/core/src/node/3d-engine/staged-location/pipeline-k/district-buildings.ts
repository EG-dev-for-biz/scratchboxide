/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D: which of a district's buildings a point stands in, by Google's vector footprints (vector-first-paint.ts
 * PaintBuilding, plan x and z in the scan's frame). A point is in a building when it lies inside one of its parts' outer
 * rings or within `marginM` of one (a facade's photo lies on the wall, a hair outside or inside the traced footprint); of
 * two such, the one it is deepest inside (or nearest to) wins. The footprints are bucketed on a plan grid, so a lookup
 * tests only the few buildings whose box reaches the point's cell.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { signedFootprintDistance } from './base-cleanup';

export const DISTRICT_BUILDINGS_PARAMS = {
    /** A point this close outside a footprint (m) still belongs to it: the wall's photo, the eaves. */
    marginM: 1.5,
    /** The plan grid's cell (m). */
    cellM: 20
};

export interface DistrictFootprint { id: string; loops: Vec2[][] }

/** The lookup: building index (into `buildings`) of a plan point, -1 when it is in none (street, square, ground). */
export function districtBuildingIndex(buildings: DistrictFootprint[], P = DISTRICT_BUILDINGS_PARAMS): (x: number, z: number) => number {
    const grid = new Map<string, number[]>();
    const key = (i: number, j: number) => `${i},${j}`;
    buildings.forEach((b, k) => {
        const pts = b.loops.flat();
        if (!pts.length) return;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        for (let i = Math.floor((x0 - P.marginM) / P.cellM); i <= Math.floor((x1 + P.marginM) / P.cellM); i++)
            for (let j = Math.floor((z0 - P.marginM) / P.cellM); j <= Math.floor((z1 + P.marginM) / P.cellM); j++) {
                const c = grid.get(key(i, j));
                if (c) c.push(k); else grid.set(key(i, j), [k]);
            }
    });
    return (x: number, z: number) => {
        const c = grid.get(key(Math.floor(x / P.cellM), Math.floor(z / P.cellM)));
        if (!c) return -1;
        // signedFootprintDistance: negative inside, positive outside
        let best = -1, bestD = P.marginM;
        for (const k of c) { const d = signedFootprintDistance(x, z, buildings[k].loops); if (d <= bestD) { bestD = d; best = k; } }
        return best;
    };
}

/** A district's footprints from its vector buildings: each building's parts' outer rings. */
export function districtFootprints(buildings: Array<{ id: string; parts: Array<{ loops: Vec2[][] }> }>): DistrictFootprint[] {
    return buildings.map(b => ({ id: b.id, loops: b.parts.map(p => p.loops[0]).filter(l => l && l.length >= 3) })).filter(b => b.loops.length);
}
