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
import { dist2Seg, signedFootprintDistance } from './base-cleanup';

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
    // each building's plan box grown by the margin: a point outside it is farther than the margin from the building
    const box = new Float64Array(buildings.length * 4);
    buildings.forEach((b, k) => {
        const pts = b.loops.flat();
        if (!pts.length) return;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        box.set([x0 - P.marginM, z0 - P.marginM, x1 + P.marginM, z1 + P.marginM], k * 4);
        for (let i = Math.floor((x0 - P.marginM) / P.cellM); i <= Math.floor((x1 + P.marginM) / P.cellM); i++)
            for (let j = Math.floor((z0 - P.marginM) / P.cellM); j <= Math.floor((z1 + P.marginM) / P.cellM); j++) {
                const c = grid.get(key(i, j));
                if (c) c.push(k); else grid.set(key(i, j), [k]);
            }
    });
    if (P.marginM <= 0) return insideOnly(buildings, grid, box, P);
    return (x: number, z: number) => {
        const c = grid.get(key(Math.floor(x / P.cellM), Math.floor(z / P.cellM)));
        if (!c) return -1;
        // signedFootprintDistance: negative inside, positive outside
        let best = -1, bestD = P.marginM;
        for (const k of c) {
            if (x < box[k * 4] || z < box[k * 4 + 1] || x > box[k * 4 + 2] || z > box[k * 4 + 3]) continue;
            const d = signedFootprintDistance(x, z, buildings[k].loops);
            if (d <= bestD) { bestD = d; best = k; }
        }
        return best;
    };
}

/**
 * The lookup with no margin (the chunk ownership's), the same answers as the signed distance gives, without measuring a
 * distance for most points: whether a point is inside a building needs only the edges that span its z, so each building's
 * edges are filed by the 1 m row they cross; a point exactly on an edge (distance 0) is found among the same edges; the
 * full signed distance is measured only when the point is inside two or more buildings, where the deepest wins. A large
 * footprint (a station block of hundreds of edges) otherwise cost its whole outline for every point near it.
 */
function insideOnly(buildings: DistrictFootprint[], grid: Map<string, number[]>, box: Float64Array, P: typeof DISTRICT_BUILDINGS_PARAMS): (x: number, z: number) => number {
    // per building: its edges by row of ROW_M (an edge in every row its z range touches), each with its loop
    const ROW_M = 1;
    type Edge = { a: Vec2; b: Vec2; loop: number };
    const rows = buildings.map(b => {
        const byRow = new Map<number, Edge[]>();
        b.loops.forEach((loop, li) => {
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const a = loop[i], e = loop[j];
                for (let r = Math.floor(Math.min(a[1], e[1]) / ROW_M); r <= Math.floor(Math.max(a[1], e[1]) / ROW_M); r++) {
                    const l = byRow.get(r);
                    if (l) l.push({ a, b: e, loop: li }); else byRow.set(r, [{ a, b: e, loop: li }]);
                }
            }
        });
        return byRow;
    });
    const parity = new Uint8Array(Math.max(1, ...buildings.map(b => b.loops.length)));
    // each building's edges in a grid of NEAR_CELL_M cells (made when first needed): the nearest edge is found ring by ring
    // outward, stopping once no edge in a farther ring can be nearer; the same minimum the whole outline gives
    const NEAR_CELL_M = 2;
    const near: Array<{ x0: number; z0: number; nx: number; nz: number; cells: Map<number, number[]>; a: Vec2[]; b: Vec2[]; seen: Int32Array } | undefined> = [];
    let query = 0;
    return (x: number, z: number) => {
        const c = grid.get(`${Math.floor(x / P.cellM)},${Math.floor(z / P.cellM)}`);
        if (!c) return -1;
        // signedFootprintDistance <= 0, in order, the last of the least winning: a point inside and off every edge (negative)
        // beats one on an edge (0, or -0 inside: equal); among those on an edge the last wins
        let onEdge = -1;
        const inside: number[] = [];
        for (const k of c) {
            if (x < box[k * 4] || z < box[k * 4 + 1] || x > box[k * 4 + 2] || z > box[k * 4 + 3]) continue;
            const edges = rows[k].get(Math.floor(z / ROW_M));
            if (!edges) continue;
            parity.fill(0, 0, buildings[k].loops.length);
            let touches = false;
            for (const { a, b, loop } of edges) {
                if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) parity[loop] ^= 1;
                if (!touches && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) && z >= Math.min(a[1], b[1]) && z <= Math.max(a[1], b[1]) && dist2Seg(x, z, a, b) === 0) touches = true;
            }
            let isInside = false;
            for (let l = 0; l < buildings[k].loops.length; l++) if (parity[l]) isInside = true;
            if (touches) onEdge = k;
            else if (isInside) inside.push(k);
        }
        if (!inside.length) return onEdge;
        if (inside.length === 1) return inside[0];
        // inside overlapping footprints (a complex drawn as overlapping parts): the deepest, the last of equals
        let best = -1, bestD = 0;
        for (const k of inside) { const d = -nearestEdge(k, x, z); if (d <= bestD) { bestD = d; best = k; } }
        return best;
    };

    function nearestEdge(k: number, x: number, z: number): number {
        let g = near[k];
        if (!g) {
            const a: Vec2[] = [], b: Vec2[] = [];
            for (const loop of buildings[k].loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { a.push(loop[i]); b.push(loop[j]); }
            const x0 = box[k * 4], z0 = box[k * 4 + 1], nx = Math.floor((box[k * 4 + 2] - x0) / NEAR_CELL_M) + 1, nz = Math.floor((box[k * 4 + 3] - z0) / NEAR_CELL_M) + 1;
            const cells = new Map<number, number[]>();
            a.forEach((p, e) => {
                const q = b[e];
                for (let i = Math.floor((Math.min(p[0], q[0]) - x0) / NEAR_CELL_M); i <= Math.floor((Math.max(p[0], q[0]) - x0) / NEAR_CELL_M); i++)
                    for (let j = Math.floor((Math.min(p[1], q[1]) - z0) / NEAR_CELL_M); j <= Math.floor((Math.max(p[1], q[1]) - z0) / NEAR_CELL_M); j++) {
                        const l = cells.get(i * nz + j);
                        if (l) l.push(e); else cells.set(i * nz + j, [e]);
                    }
            });
            g = near[k] = { x0, z0, nx, nz, cells, a, b, seen: new Int32Array(a.length) };
        }
        query++;
        const ci = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / NEAR_CELL_M))), cj = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / NEAR_CELL_M)));
        let best = Infinity;
        const visit = (i: number, j: number) => {
            if (i < 0 || j < 0 || i >= g!.nx || j >= g!.nz) return;
            for (const e of g!.cells.get(i * g!.nz + j) ?? []) {
                if (g!.seen[e] === query) continue;
                g!.seen[e] = query;
                best = Math.min(best, dist2Seg(x, z, g!.a[e], g!.b[e]));
            }
        };
        for (let r = 0; r <= Math.max(g.nx, g.nz); r++) {
            if (r === 0) visit(ci, cj);
            else {
                for (let i = ci - r; i <= ci + r; i++) { visit(i, cj - r); visit(i, cj + r); }
                for (let j = cj - r + 1; j <= cj + r - 1; j++) { visit(ci - r, j); visit(ci + r, j); }
            }
            // an edge only in cells r + 1 or more rings out is at least r cells away
            if (best <= r * NEAR_CELL_M) break;
        }
        return best;
    }
}

/** A district's footprints from its vector buildings: each building's parts' outer rings. */
export function districtFootprints(buildings: Array<{ id: string; parts: Array<{ loops: Vec2[][] }> }>): DistrictFootprint[] {
    return buildings.map(b => ({ id: b.id, loops: b.parts.map(p => p.loops[0]).filter(l => l && l.length >= 3) })).filter(b => b.loops.length);
}
