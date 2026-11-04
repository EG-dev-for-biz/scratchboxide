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
 * tests only the few buildings whose box reaches the point's cell; and the answer is settled once per square of plan
 * (planCells) wherever the whole square has one answer, so most points measure no distance at all.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { dist2Seg } from './base-cleanup';

export const DISTRICT_BUILDINGS_PARAMS = {
    /** A point this close outside a footprint (m) still belongs to it: the wall's photo, the eaves. */
    marginM: 1.5,
    /** The plan grid's cell (m). */
    cellM: 20,
    /**
     * The squares of plan (m, coarse to fine, each dividing cellM) whose answer is settled once for every point in them:
     * a square still undecided at the finest is measured point by point.
     */
    planCellsM: [4, 1, 0.25]
};

export interface DistrictFootprint { id: string; loops: Vec2[][] }

/**
 * The lookup: building index (into `buildings`) of a plan point, -1 when it is in none (street, square, ground). With a
 * margin, `exact` measures every point (the answers planCells is held to; empty planCellsM does the same).
 */
export function districtBuildingIndex(buildings: DistrictFootprint[], P: { marginM: number; cellM: number; planCellsM?: number[] } = DISTRICT_BUILDINGS_PARAMS, opts: { exact?: boolean } = {}): (x: number, z: number) => number {
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
    const edges = footprintEdges(buildings);
    if (P.marginM <= 0) return insideOnly(buildings, grid, box, P, edges);
    const near: number[] = [], isIn: boolean[] = [];
    const exact = (x: number, z: number) => {
        const c = grid.get(key(Math.floor(x / P.cellM), Math.floor(z / P.cellM)));
        if (!c) return -1;
        near.length = 0; isIn.length = 0;
        let insides = 0;
        for (const k of c) {
            if (x < box[k * 4] || z < box[k * 4 + 1] || x > box[k * 4 + 2] || z > box[k * 4 + 3]) continue;
            near.push(k); isIn.push(edges.inside(k, x, z));
            if (isIn[isIn.length - 1]) insides++;
        }
        // signedFootprintDistance: negative inside, positive outside; the least within the margin, the last of equals. Only
        // what can decide that is measured: an outside building's distance up to the best so far (none once a building is
        // inside by more than 0), and a lone inside building's only as far as 0 (past it, it beats every outside one)
        let best = -1, bestD = P.marginM;
        for (let q = 0; q < near.length; q++) {
            const k = near[q];
            let d: number;
            if (!isIn[q]) {
                if (bestD < 0) continue;
                d = edges.nearest(k, x, z, bestD + PLAN_CELL_SLACK_M);
            } else d = -edges.nearest(k, x, z, insides > 1 ? Infinity : PLAN_CELL_SLACK_M);
            if (d <= bestD) { bestD = d; best = k; }
        }
        return best;
    };
    const levels = opts.exact ? [] : P.planCellsM ?? DISTRICT_BUILDINGS_PARAMS.planCellsM;
    return levels.length ? planCells(exact, edges, grid, box, P, levels) : exact;
}

/** Slack (m) on planCells' bounds: far above the doubles' rounding in a distance or a cell index, far below anything seen. */
const PLAN_CELL_SLACK_M = 1e-6;
const PLAN_CELL_SPLIT = -2;

/**
 * The margin lookup's answers settled per square of plan: a footprint's signed distance changes by at most the distance
 * moved (its sign flips only on an edge, where it is 0), so from the distances at a square's centre, h its half-diagonal,
 * the whole square is in no building when every one is farther than margin + h, and in building k when k's is within
 * margin - h and every other's is more than 2h beyond k's (k then the strict least everywhere in it, as `exact` finds).
 * Otherwise the square is split into the next finer ones, and a point in an undecided finest square is measured by `exact`.
 * A square is decided with the candidates of the grid cell its centre lies in, and used only for points in that cell.
 */
function planCells(exact: (x: number, z: number) => number, edges: FootprintEdges, grid: Map<string, number[]>, box: Float64Array, P: { marginM: number; cellM: number }, sizes: number[]): (x: number, z: number) => number {
    const levels = sizes.map(s => ({ s, h: s * Math.SQRT1_2, answer: new Map<number, number>() }));
    // a square's index pair as one number (|i|, |j| < 2^24: a plan within 4 km at the finest 0.25 m)
    const LIM = 2 ** 24;
    const decide = (i: number, j: number, s: number, h: number) => {
        const cx = (i + 0.5) * s, cz = (j + 0.5) * s;
        const c = grid.get(`${Math.floor(cx / P.cellM)},${Math.floor(cz / P.cellM)}`);
        // distances past the cap decide nothing here: a building outside by more is in no answer, nor the runner-up's
        const cap = P.marginM + 2 * h + 2 * PLAN_CELL_SLACK_M, r = s / 2 + PLAN_CELL_SLACK_M;
        const near: number[] = [], isIn: boolean[] = [];
        let insides = 0;
        for (const k of c ?? []) {
            // a building whose grown box misses the square is skipped by `exact` at every point of it
            if (cx + r < box[k * 4] || cz + r < box[k * 4 + 1] || cx - r > box[k * 4 + 2] || cz - r > box[k * 4 + 3]) continue;
            near.push(k); isIn.push(edges.inside(k, cx, cz));
            if (isIn[isIn.length - 1]) insides++;
        }
        let best = -1, bestD = Infinity, second = Infinity;
        for (let q = 0; q < near.length; q++) {
            const k = near[q];
            // capped, a distance is a lower bound: right for a runner-up outside, and for the one building inside as the
            // best (an upper bound on its negative value); of two or more inside (overlapping parts), each is measured
            const d = isIn[q] ? -edges.nearest(k, cx, cz, insides > 1 ? Infinity : cap) : edges.nearest(k, cx, cz, cap);
            if (d < bestD) { second = bestD; bestD = d; best = k; } else if (d < second) second = d;
        }
        if (bestD - h > P.marginM + PLAN_CELL_SLACK_M) return -1;
        if (bestD + h + PLAN_CELL_SLACK_M <= P.marginM && second - h > bestD + h + PLAN_CELL_SLACK_M) return best;
        return PLAN_CELL_SPLIT;
    };
    return (x: number, z: number) => {
        for (const L of levels) {
            const i = Math.floor(x / L.s), j = Math.floor(z / L.s);
            if (!(Math.abs(i) < LIM && Math.abs(j) < LIM)) return exact(x, z);
            // the point's grid cell must be the one the square was decided with (they differ only by a rounding at its edge)
            if (Math.floor(x / P.cellM) !== Math.floor((i + 0.5) * L.s / P.cellM) || Math.floor(z / P.cellM) !== Math.floor((j + 0.5) * L.s / P.cellM)) return exact(x, z);
            const key = (i + LIM) * 2 * LIM + (j + LIM);
            let a = L.answer.get(key);
            if (a === undefined) L.answer.set(key, (a = decide(i, j, L.s, L.h)));
            if (a !== PLAN_CELL_SPLIT) return a;
        }
        return exact(x, z);
    };
}

/**
 * The lookup with no margin (the chunk ownership's), the same answers as the signed distance gives, without measuring a
 * distance for most points: whether a point is inside a building needs only the edges that span its z (footprintEdges'
 * rows); a point exactly on an edge (distance 0) is found among the same edges; the full signed distance is measured only
 * when the point is inside two or more buildings, where the deepest wins. A large footprint (a station block of hundreds of
 * edges) otherwise cost its whole outline for every point near it.
 */
function insideOnly(buildings: DistrictFootprint[], grid: Map<string, number[]>, box: Float64Array, P: { cellM: number }, edges: FootprintEdges): (x: number, z: number) => number {
    const parity = new Uint8Array(Math.max(1, ...buildings.map(b => b.loops.length)));
    return (x: number, z: number) => {
        const c = grid.get(`${Math.floor(x / P.cellM)},${Math.floor(z / P.cellM)}`);
        if (!c) return -1;
        // signedFootprintDistance <= 0, in order, the last of the least winning: a point inside and off every edge (negative)
        // beats one on an edge (0, or -0 inside: equal); among those on an edge the last wins
        let onEdge = -1;
        const inside: number[] = [];
        for (const k of c) {
            if (x < box[k * 4] || z < box[k * 4 + 1] || x > box[k * 4 + 2] || z > box[k * 4 + 3]) continue;
            const row = edges.row(k, z);
            if (!row) continue;
            parity.fill(0, 0, buildings[k].loops.length);
            let touches = false;
            for (const { a, b, loop } of row) {
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
        for (const k of inside) { const d = -edges.nearest(k, x, z); if (d <= bestD) { bestD = d; best = k; } }
        return best;
    };
}

interface FootprintEdges {
    /** Building k's edges that span plan row z (each with its loop), undefined for none. */
    row(k: number, z: number): Array<{ a: Vec2; b: Vec2; loop: number }> | undefined;
    /** The distance from (x, z) to building k's nearest edge; when it is `cap` or more, any value from `cap` up to it. */
    nearest(k: number, x: number, z: number, cap?: number): number;
    /** Whether (x, z) is inside building k (inside one of its loops), as signedFootprintDistance's sign has it. */
    inside(k: number, x: number, z: number): boolean;
    /** signedFootprintDistance(x, z, buildings[k].loops), value for value, measuring only the edges that can decide it. */
    signed(k: number, x: number, z: number): number;
}

/**
 * Each building's edges, filed when first needed: by the ROW_M row their z range touches (whether a point is inside needs
 * only the edges that span its z: the crossing test holds for no other) and in a tree of boxes (the nearest edge found
 * nearest box first, a box passed over only when it lies farther than the nearest edge so far: the same minimum the whole
 * outline gives, at a few dozen edges for a point deep inside a block of hundreds).
 */
function footprintEdges(buildings: DistrictFootprint[]): FootprintEdges {
    const ROW_M = 1, LEAF = 4;
    // a box passed over is farther than the best edge by this much (the doubles' rounding of a box distance is far less)
    const NEAR_SLACK_M = 1e-6;
    type Edge = { a: Vec2; b: Vec2; loop: number };
    const rows: Array<Map<number, Edge[]> | undefined> = [];
    // per building: its edges' ends (in tree order) and the tree's nodes (box; a leaf's first edge and count, else its children)
    type Tree = { a: Vec2[]; b: Vec2[]; box: Float64Array; first: Int32Array; count: Int32Array; left: Int32Array; right: Int32Array };
    const trees: Array<Tree | undefined> = [];
    const parity = new Uint8Array(Math.max(1, ...buildings.map(b => b.loops.length)));
    const stack: number[] = [];
    const row = (k: number, z: number) => {
        let byRow = rows[k];
        if (!byRow) {
            byRow = rows[k] = new Map();
            buildings[k].loops.forEach((loop, li) => {
                for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                    const a = loop[i], e = loop[j];
                    for (let r = Math.floor(Math.min(a[1], e[1]) / ROW_M); r <= Math.floor(Math.max(a[1], e[1]) / ROW_M); r++) {
                        const l = byRow!.get(r);
                        if (l) l.push({ a, b: e, loop: li }); else byRow!.set(r, [{ a, b: e, loop: li }]);
                    }
                }
            });
        }
        return byRow.get(Math.floor(z / ROW_M));
    };
    const treeOf = (k: number): Tree => {
        let t = trees[k];
        if (t) return t;
        const ends: Array<[Vec2, Vec2]> = [];
        for (const loop of buildings[k].loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) ends.push([loop[i], loop[j]]);
        // a binary tree has fewer nodes than twice its leaves, and it has at most one leaf per edge
        const n = Math.max(1, 2 * ends.length);
        const box = new Float64Array(n * 4), first = new Int32Array(n), count = new Int32Array(n), left = new Int32Array(n), right = new Int32Array(n);
        let nodes = 0;
        const build = (lo: number, hi: number): number => {
            const id = nodes++;
            let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
            for (let e = lo; e < hi; e++) for (const p of ends[e]) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
            box.set([x0, z0, x1, z1], id * 4);
            if (hi - lo <= LEAF) { first[id] = lo; count[id] = hi - lo; return id; }
            // split at the median of the edges' middles along the box's longer side
            const ax = x1 - x0 >= z1 - z0 ? 0 : 1, part = ends.slice(lo, hi).sort((u, v) => (u[0][ax] + u[1][ax]) - (v[0][ax] + v[1][ax]));
            for (let e = lo; e < hi; e++) ends[e] = part[e - lo];
            const mid = (lo + hi) >> 1;
            left[id] = build(lo, mid); right[id] = build(mid, hi);
            return id;
        };
        if (ends.length) build(0, ends.length);
        t = trees[k] = { a: ends.map(e => e[0]), b: ends.map(e => e[1]), box, first, count, left, right };
        return t;
    };
    const boxDist = (t: Tree, id: number, x: number, z: number) => {
        const o = id * 4, dx = Math.max(t.box[o] - x, 0, x - t.box[o + 2]), dz = Math.max(t.box[o + 1] - z, 0, z - t.box[o + 3]);
        return Math.sqrt(dx * dx + dz * dz);
    };
    const nearest = (k: number, x: number, z: number, cap = Infinity): number => {
        const t = treeOf(k);
        let best = Infinity;
        if (!t.a.length) return best;
        stack.length = 0; stack.push(0);
        while (stack.length) {
            const id = stack.pop()!;
            if (boxDist(t, id, x, z) > Math.min(best, cap) + NEAR_SLACK_M) continue;
            if (t.count[id]) { for (let e = t.first[id]; e < t.first[id] + t.count[id]; e++) best = Math.min(best, dist2Seg(x, z, t.a[e], t.b[e])); continue; }
            // the nearer child last, so it is searched first
            const l = t.left[id], r = t.right[id];
            if (boxDist(t, l, x, z) <= boxDist(t, r, x, z)) stack.push(r, l); else stack.push(l, r);
        }
        // below the cap every box that could hold a nearer edge was searched; at or past it, the cap is a lower bound
        return best < cap ? best : cap;
    };
    const inside = (k: number, x: number, z: number) => {
        const loops = buildings[k].loops.length;
        parity.fill(0, 0, loops);
        for (const { a, b, loop } of row(k, z) ?? []) if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) parity[loop] ^= 1;
        for (let l = 0; l < loops; l++) if (parity[l]) return true;
        return false;
    };
    const signed = (k: number, x: number, z: number) => {
        const d = nearest(k, x, z);
        return inside(k, x, z) ? -d : d;
    };
    return { row, nearest, inside, signed };
}

/** A district's footprints from its vector buildings: each building's parts' outer rings. */
export function districtFootprints(buildings: Array<{ id: string; parts: Array<{ loops: Vec2[][] }> }>): DistrictFootprint[] {
    return buildings.map(b => ({ id: b.id, loops: b.parts.map(p => p.loops[0]).filter(l => l && l.length >= 3) })).filter(b => b.loops.length);
}
