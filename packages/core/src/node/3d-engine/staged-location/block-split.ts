/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A block of buildings split into one scan mesh per building: the geometry of location_split_block.
 *
 *  1. Ownership on the 1 m ground-model grid: each building's cells are those its structure pick took (extraction-sizing.ts
 *     pickStructure with the Google vector footprint as the prior: the scan's raised cells within the footprint grown
 *     FOOTPRINT_TOLERANCE_M into the open, never into another footprint). A cell two picks both took (a melted alley, a
 *     wall standing in the tolerance band of both) goes to the building whose vector footprint is nearer.
 *  2. Every triangle of the scan gets exactly one label (a building, or 0: unassigned), by its centroid: raised surfaces
 *     and walls over a building's cells are that building's; a raised triangle in the open within ISOLATE_CORE_GROW_M of a
 *     building (a cornice, a facade standing just outside the grid line) is the nearest building's; a wall rising above
 *     its cell's owner's roof belongs to the neighbour whose roof it reaches; ground, trees, street furniture and raised
 *     scan no footprint owns stay unassigned. Pieces of a building's triangles not connected to its body (welded at 1 cm)
 *     and small are returned to unassigned: no output holds fragments.
 *  3. The boundaries: each building's party walls with each neighbour (the grid edges between their cells, chained and
 *     simplified to segments) and its exterior, each edge with the evidence that decided it: the vector footprint (the
 *     edge lies on a vector outline), a height jump (a storey or more between the two sides), the mask vote (a decisive
 *     multi-view vote moved triangles there), or the scan geometry alone (raised against open ground).
 *
 * All thresholds are continuous lengths; nothing depends on what kind of building it is.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { FOOTPRINT_TOLERANCE_M, ISOLATE_CORE_GROW_M, openMask, STRUCTURE_MIN_HEIGHT_M, STRUCTURE_PART_STEP_M } from './extraction-sizing';

/** Surfaces this far above the terrain are raised (a kerb, a step and the ground's own noise are not). */
export const SPLIT_RAISED_ABOVE_M = 0.5;
/** Triangles whose normal is within this of horizontal (|n.y| below it) are walls. */
export const SPLIT_WALL_NY = 0.7;
/** A raised triangle in the open within this of a building's cells is that building's (tile_refine's core grow). */
export const SPLIT_WALL_REACH_M = ISOLATE_CORE_GROW_M;
/** A wall in reach of a building (outside its cells) faces it when |cos| between its normal and the way to it is at least this. */
export const SPLIT_FACING_MIN = 0.5;
/** A wall more than this above its cell's owner's roof belongs to a neighbour whose roof it reaches. */
export const SPLIT_ROOF_CLEARANCE_M = 1.0;
/** A piece of a building not joined to its body is kept when it has at least this surface, or this share of the building's. */
export const SPLIT_PIECE_MIN_M2 = 25;
export const SPLIT_PIECE_MIN_SHARE = 0.05;
/** A boundary edge within this of a vector outline was decided by the vector footprint. */
export const SPLIT_VECTOR_EDGE_M = 1.5;
/** Party-wall chains are simplified to this tolerance (m). */
export const SPLIT_SEGMENT_TOLERANCE_M = 0.75;

/** What decided a boundary edge (open literal: diagnostic only). */
export type BoundarySource = 'vector-footprint' | 'height-jump' | 'mask-vote' | 'scan-geometry' | (string & {});

/** Why a triangle carries its label (diagnostic codes, counted in the result). */
export const TRI_GROUND = 0, TRI_OWNED_CELL = 1, TRI_WALL_REACH = 2, TRI_TREE = 3, TRI_RAISED_UNOWNED = 4, TRI_BELOW_GROUND = 5, TRI_DETACHED = 6, TRI_WALL_OF_NEIGHBOUR = 7, TRI_OUTSIDE_GRID = 8, TRI_VOTE_MOVED = 9;
export const TRIANGLE_KIND_NAMES = ['ground', 'owned-cell', 'wall-reach', 'tree', 'raised-unowned', 'below-ground', 'detached-piece', 'wall-of-neighbour', 'outside-grid', 'mask-vote'];

type Grid = Pick<GroundModel, 'x0' | 'z0' | 'nx' | 'nz' | 'cellMeters' | 'top' | 'ground' | 'canopy' | 'cellIndex' | 'groundAt'>;

// ----------------------------------------------------------------------------------------------------------------
// polygons
// ----------------------------------------------------------------------------------------------------------------

/** Even-odd containment over a part's loops (outer ring and holes). */
export function insideLoops(x: number, z: number, loops: Vec2[][]): boolean {
    let inside = false;
    for (const r of loops) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, zi] = r[i], [xj, zj] = r[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Distance from a point to the nearest edge of any loop. */
export function distanceToLoops(x: number, z: number, loops: Vec2[][]): number {
    let best = Infinity;
    for (const r of loops) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ax, az] = r[j], [bx, bz] = r[i];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-12;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
    }
    return best;
}

/** Distance from a point to a building's footprint (its parts, each a set of loops): 0 inside. */
export function distanceToFootprint(x: number, z: number, parts: Vec2[][][]): number {
    let best = Infinity;
    for (const loops of parts) {
        if (insideLoops(x, z, loops)) return 0;
        best = Math.min(best, distanceToLoops(x, z, loops));
    }
    return best;
}

/** Cells of the grid whose centre lies in the footprint. */
export function footprintCells(g: Pick<Grid, 'x0' | 'z0' | 'nx' | 'nz' | 'cellMeters'>, parts: Vec2[][][]): Uint8Array {
    const m = new Uint8Array(g.nx * g.nz);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const loops of parts) for (const r of loops) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const i0 = Math.max(0, Math.floor((x0 - g.x0) / g.cellMeters)), i1 = Math.min(g.nx - 1, Math.ceil((x1 - g.x0) / g.cellMeters));
    const k0 = Math.max(0, Math.floor((z0 - g.z0) / g.cellMeters)), k1 = Math.min(g.nz - 1, Math.ceil((z1 - g.z0) / g.cellMeters));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const x = g.x0 + (i + 0.5) * g.cellMeters, z = g.z0 + (k + 0.5) * g.cellMeters;
        if (parts.some(loops => insideLoops(x, z, loops))) m[k * g.nx + i] = 1;
    }
    return m;
}

// ----------------------------------------------------------------------------------------------------------------
// 1. ownership
// ----------------------------------------------------------------------------------------------------------------

export interface OwnershipClaim {
    /** The building's label (1-based). */
    label: number;
    /** Cells its pick took (1). */
    cells: Uint8Array;
    /** Its vector footprint parts (scan frame), for settling cells two picks took. */
    parts: Vec2[][][];
}

export interface Ownership {
    /** Per cell: the owning building's label, 0 none. */
    owner: Int32Array;
    /** Cells two or more picks took (settled by the nearer vector footprint). */
    contested: Uint8Array;
    contestedCells: number;
}

export function resolveOwnership(g: Pick<Grid, 'x0' | 'z0' | 'nx' | 'nz' | 'cellMeters'>, claims: OwnershipClaim[]): Ownership {
    const N = g.nx * g.nz;
    const owner = new Int32Array(N), contested = new Uint8Array(N);
    let contestedCells = 0;
    const first = new Int32Array(N).fill(-1);
    claims.forEach((cl, ci) => {
        for (let c = 0; c < N; c++) {
            if (!cl.cells[c]) continue;
            if (first[c] < 0) { first[c] = ci; owner[c] = cl.label; continue; }
            // contested: the nearer vector footprint takes it (ties: the one already holding it)
            if (!contested[c]) { contested[c] = 1; contestedCells++; }
            const x = g.x0 + ((c % g.nx) + 0.5) * g.cellMeters, z = g.z0 + (((c / g.nx) | 0) + 0.5) * g.cellMeters;
            const held = claims.find(o => o.label === owner[c])!;
            if (distanceToFootprint(x, z, cl.parts) < distanceToFootprint(x, z, held.parts)) owner[c] = cl.label;
        }
    });
    return { owner, contested, contestedCells };
}

/**
 * Raised masses that stand outside every vector footprint and are too wide to be a facade standing past its drawn outline:
 * the raised cells (STRUCTURE_MIN_HEIGHT_M or more, not canopy) in no footprint, opened by a disc of FOOTPRINT_TOLERANCE_M
 * (a strip narrower than twice the tolerance, a facade's overshoot or a melted alley, vanishes; a structure with no footprint
 * stays). A pick may take raised cells up to the tolerance past its outline; those that lie in such a mass are not its own
 * (trimBand), so the vector outline decides there.
 */
export function unmappedMasses(g: Pick<Grid, 'nx' | 'nz' | 'cellMeters' | 'top' | 'ground' | 'canopy'>, inAnyFootprint: Uint8Array): Uint8Array {
    const N = g.nx * g.nz;
    const raised = new Uint8Array(N);
    for (let c = 0; c < N; c++) raised[c] = !inAnyFootprint[c] && !g.canopy?.[c] && g.top[c] === g.top[c] && g.ground[c] === g.ground[c] && g.top[c] - g.ground[c] >= STRUCTURE_MIN_HEIGHT_M ? 1 : 0;
    const opened = openMask(raised, g.nx, g.nz, Math.max(1, Math.round(FOOTPRINT_TOLERANCE_M / g.cellMeters)));
    // the disc rounds the masses' corners off: raised cells beside a mass (8-neighbours) are the mass's too
    const out = Uint8Array.from(opened);
    for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
        const c = k * g.nx + i;
        if (opened[c] || !raised[c]) continue;
        search: for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, kk = k + dk;
            if (ii >= 0 && kk >= 0 && ii < g.nx && kk < g.nz && opened[kk * g.nx + ii]) { out[c] = 1; break search; }
        }
    }
    return out;
}

/** A pick's cells less those past its footprint that lie in an unmapped mass (unmappedMasses). */
export function trimBand(cells: Uint8Array, footprint: Uint8Array, masses: Uint8Array): { cells: Uint8Array; dropped: number } {
    const out = Uint8Array.from(cells);
    let dropped = 0;
    for (let c = 0; c < cells.length; c++) if (cells[c] && !footprint[c] && masses[c]) { out[c] = 0; dropped++; }
    return { cells: out, dropped };
}

// ----------------------------------------------------------------------------------------------------------------
// 2. triangles
// ----------------------------------------------------------------------------------------------------------------

/** For each cell, the nearest owned cell's label within `reachM` (chamfer distance), 0 beyond. */
export function nearestOwner(g: Pick<Grid, 'nx' | 'nz' | 'cellMeters'>, owner: Int32Array, reachM: number): { label: Int32Array; dist: Float32Array; source: Int32Array } {
    const { nx, nz, cellMeters: cell } = g;
    const N = nx * nz;
    const dist = new Float32Array(N).fill(Infinity), label = new Int32Array(N), source = new Int32Array(N).fill(-1);
    for (let c = 0; c < N; c++) if (owner[c]) { dist[c] = 0; label[c] = owner[c]; source[c] = c; }
    const s1 = cell, s2 = cell * Math.SQRT2;
    const relax = (c: number, n: number, w: number) => { if (dist[n] + w < dist[c]) { dist[c] = dist[n] + w; label[c] = label[n]; source[c] = source[n]; } };
    for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            const c = k * nx + i;
            if (i > 0) relax(c, c - 1, s1);
            if (k > 0) { relax(c, c - nx, s1); if (i > 0) relax(c, c - nx - 1, s2); if (i < nx - 1) relax(c, c - nx + 1, s2); }
        }
        for (let k = nz - 1; k >= 0; k--) for (let i = nx - 1; i >= 0; i--) {
            const c = k * nx + i;
            if (i < nx - 1) relax(c, c + 1, s1);
            if (k < nz - 1) { relax(c, c + nx, s1); if (i < nx - 1) relax(c, c + nx + 1, s2); if (i > 0) relax(c, c + nx - 1, s2); }
        }
    }
    for (let c = 0; c < N; c++) if (dist[c] > reachM) { label[c] = 0; source[c] = -1; }
    return { label, dist, source };
}

/**
 * Each building's roof level: the 95th percentile of the surface over its interior cells (those whose four neighbours it
 * also owns: an edge cell's surface holds the top of whatever wall stands on its line, a taller neighbour's included), or
 * over all its cells when it has no interior.
 */
export function roofLevels(g: Grid, owner: Int32Array, labels: number): Float64Array {
    const per: number[][] = Array.from({ length: labels + 1 }, () => []);
    const edge: number[][] = Array.from({ length: labels + 1 }, () => []);
    const { nx, nz } = g;
    for (let c = 0; c < owner.length; c++) {
        const l = owner[c];
        if (!l || !(g.top[c] === g.top[c])) continue;
        const i = c % nx, k = (c / nx) | 0;
        const interior = i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && owner[c - 1] === l && owner[c + 1] === l && owner[c - nx] === l && owner[c + nx] === l;
        (interior ? per : edge)[l].push(g.top[c]);
    }
    const out = new Float64Array(labels + 1).fill(NaN);
    per.forEach((v0, l) => { const v = v0.length ? v0 : edge[l]; if (v.length) { v.sort((a, b) => a - b); out[l] = v[Math.min(v.length - 1, Math.floor(0.95 * (v.length - 1)))]; } });
    return out;
}

export interface TriangleLabels {
    labels: Int32Array;
    kind: Uint8Array;
}

/**
 * The label of every triangle (0 unassigned), by its centroid on the ownership grid. `isTree(t)` marks triangles the
 * tree strip took out (never a building's).
 */
export function labelTriangles(scan: Pick<ScanMesh, 'triCount' | 'triCentroid' | 'triNormal'>, g: Grid, owner: Int32Array, opts: { labels: number; isTree?: (t: number) => boolean }): TriangleLabels {
    const T = scan.triCount;
    const labels = new Int32Array(T), kind = new Uint8Array(T);
    const near = nearestOwner(g, owner, SPLIT_WALL_REACH_M);
    const roof = roofLevels(g, owner, opts.labels);
    const { nx, nz, cellMeters: cell } = g;
    for (let t = 0; t < T; t++) {
        const x = scan.triCentroid[t * 3], y = scan.triCentroid[t * 3 + 1], z = scan.triCentroid[t * 3 + 2];
        const i = Math.floor((x - g.x0) / cell), k = Math.floor((z - g.z0) / cell);
        if (i < 0 || k < 0 || i >= nx || k >= nz) { kind[t] = TRI_OUTSIDE_GRID; continue; }
        const c = k * nx + i;
        const gr = g.ground[c];
        const above = gr === gr ? y - gr : y - g.groundAt(x, z);
        if (above < -0.3) { kind[t] = TRI_BELOW_GROUND; continue; }
        if (opts.isTree?.(t) && above > SPLIT_RAISED_ABOVE_M) { kind[t] = TRI_TREE; continue; }
        const wall = Math.abs(scan.triNormal[t * 3 + 1]) < SPLIT_WALL_NY;
        const raised = above > SPLIT_RAISED_ABOVE_M;
        let l = owner[c];
        if (l) {
            if (!raised && !wall) { kind[t] = TRI_GROUND; continue; }
            kind[t] = TRI_OWNED_CELL;
        } else {
            l = raised ? near.label[c] : 0;
            if (!l) { kind[t] = raised ? TRI_RAISED_UNOWNED : TRI_GROUND; continue; }
            // a wall in reach is the building's own facade only when it faces it: the way to the building's nearest cell runs
            // along the wall's normal (a wall running away from the building, the side of something beside it, is not)
            if (wall) {
                const sc = near.source[c];
                const dx = g.x0 + ((sc % nx) + 0.5) * cell - x, dz = g.z0 + (((sc / nx) | 0) + 0.5) * cell - z;
                const dl = Math.hypot(dx, dz);
                const nxz = Math.hypot(scan.triNormal[t * 3], scan.triNormal[t * 3 + 2]) || 1;
                if (dl > 0.75 * cell && Math.abs(dx * scan.triNormal[t * 3] + dz * scan.triNormal[t * 3 + 2]) / (dl * nxz) < SPLIT_FACING_MIN) { kind[t] = TRI_RAISED_UNOWNED; continue; }
            }
            kind[t] = TRI_WALL_REACH;
        }
        if (y > roof[l] + SPLIT_ROOF_CLEARANCE_M) {
            // above this building's roof: a wall there belongs to the neighbour whose roof it reaches (the face of a taller
            // building above a lower one's roof, at their party wall)
            let best = 0, bestRoof = -Infinity, massReaches = false;
            const r = kind[t] === TRI_WALL_REACH ? 2 : 1;
            for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const q = kk * nx + ii, o = owner[q];
                if (o && o !== l && roof[o] >= y - SPLIT_ROOF_CLEARANCE_M && roof[o] > bestRoof) { best = o; bestRoof = roof[o]; }
                if (!o && !g.canopy?.[q] && g.top[q] - g.ground[q] >= STRUCTURE_MIN_HEIGHT_M && g.top[q] >= y - SPLIT_ROOF_CLEARANCE_M) massReaches = true;
            }
            if (wall && best) { l = best; kind[t] = TRI_WALL_OF_NEIGHBOUR; }
            // outside its cells a surface above its roof is not its own; in its cells, a wall a taller unowned mass beside it
            // reaches is that mass's (a building with no footprint)
            else if (kind[t] === TRI_WALL_REACH || (wall && massReaches)) { kind[t] = TRI_RAISED_UNOWNED; continue; }
        } else if (kind[t] === TRI_WALL_REACH && !wall && y < roof[l] - STRUCTURE_PART_STEP_M) {
            // a roof well below this building's beside it (a shed, an annex) is not its cornice
            kind[t] = TRI_RAISED_UNOWNED;
            continue;
        }
        labels[t] = l;
    }
    return { labels, kind };
}

/** Welded vertex ids (1 cm lattice within 300 m of the origin), so pieces that meet at a seam between chunks are one piece. */
export function weldVertices(vertices: Float32Array): Uint32Array {
    const n = vertices.length / 3;
    const out = new Uint32Array(n);
    const map = new Map<number, number>();
    const Q = 60001, H = 30000;
    for (let v = 0; v < n; v++) {
        const qx = Math.max(-H, Math.min(H, Math.round(vertices[v * 3] * 100))) + H;
        const qy = Math.max(-H, Math.min(H, Math.round(vertices[v * 3 + 1] * 100))) + H;
        const qz = Math.max(-H, Math.min(H, Math.round(vertices[v * 3 + 2] * 100))) + H;
        const key = (qx * Q + qy) * Q + qz;
        let id = map.get(key);
        if (id === undefined) { id = map.size; map.set(key, id); }
        out[v] = id;
    }
    return out;
}

/**
 * Pieces of each building not joined to its body: connected components of its triangles over welded vertices; all but
 * the largest that are smaller than SPLIT_PIECE_MIN_M2 and SPLIT_PIECE_MIN_SHARE of the building go back to unassigned.
 * Returns, per label, the surface returned.
 */
export function detachPieces(scan: Pick<ScanMesh, 'triCount' | 'triArea' | 'mesh'>, tl: TriangleLabels, labels: number): { returnedM2: Float64Array; returnedTriangles: Int32Array } {
    const T = scan.triCount;
    const I = scan.mesh.indices as Uint32Array;
    const weld = weldVertices(scan.mesh.vertices as Float32Array);
    const parent = new Int32Array(T);
    for (let t = 0; t < T; t++) parent[t] = t;
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const firstAt = new Map<number, number>();
    for (let t = 0; t < T; t++) {
        const l = tl.labels[t];
        if (!l) continue;
        for (let k = 0; k < 3; k++) {
            const key = weld[I[t * 3 + k]] * (labels + 1) + l;
            const o = firstAt.get(key);
            if (o === undefined) firstAt.set(key, t);
            else { const a = find(o), b = find(t); if (a !== b) parent[a] = b; }
        }
    }
    const compArea = new Map<number, number>();
    const total = new Float64Array(labels + 1);
    for (let t = 0; t < T; t++) {
        const l = tl.labels[t];
        if (!l) continue;
        const r = find(t);
        compArea.set(r, (compArea.get(r) ?? 0) + scan.triArea[t]);
        total[l] += scan.triArea[t];
    }
    const largest = new Map<number, { root: number; area: number }>();
    for (let t = 0; t < T; t++) {
        const l = tl.labels[t];
        if (!l) continue;
        const r = find(t), a = compArea.get(r)!;
        const cur = largest.get(l);
        if (!cur || a > cur.area) largest.set(l, { root: r, area: a });
    }
    const returnedM2 = new Float64Array(labels + 1), returnedTriangles = new Int32Array(labels + 1);
    for (let t = 0; t < T; t++) {
        const l = tl.labels[t];
        if (!l) continue;
        const r = find(t);
        if (r === largest.get(l)!.root) continue;
        const a = compArea.get(r)!;
        if (a >= SPLIT_PIECE_MIN_M2 || a >= SPLIT_PIECE_MIN_SHARE * total[l]) continue;
        tl.labels[t] = 0;
        tl.kind[t] = TRI_DETACHED;
        returnedM2[l] += scan.triArea[t];
        returnedTriangles[l]++;
    }
    return { returnedM2, returnedTriangles };
}

// ----------------------------------------------------------------------------------------------------------------
// 3. boundaries
// ----------------------------------------------------------------------------------------------------------------

export interface BoundarySegment {
    from: Vec2;
    to: Vec2;
    lengthM: number;
    /** The evidence that decided the grid edges this segment covers. */
    decidedBy: BoundarySource[];
}

export interface PartyWall {
    /** The neighbour's label. */
    neighbour: number;
    lengthM: number;
    segments: BoundarySegment[];
    /** Length of the wall decided by each source (an edge decided by two counts for both). */
    decidedByM: Record<string, number>;
}

export interface BuildingBoundary {
    partyWalls: PartyWall[];
    exteriorM: number;
    exteriorDecidedByM: Record<string, number>;
}

interface UnitEdge { u: number; v: number; sources: BoundarySource[] }

/** Douglas-Peucker on a polyline: the indices kept. */
function simplify(pts: Vec2[], tol: number): number[] {
    if (pts.length <= 2) return pts.map((_, i) => i);
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop()!;
        const [ax, az] = pts[a], [bx, bz] = pts[b];
        const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
        let worst = -1, wd = 0;
        for (let i = a + 1; i < b; i++) {
            const d = l < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - az) : Math.abs(dx * (az - pts[i][1]) - dz * (ax - pts[i][0])) / l;
            if (d > wd) { wd = d; worst = i; }
        }
        if (worst >= 0 && wd > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    const out: number[] = [];
    keep.forEach((k, i) => { if (k) out.push(i); });
    return out;
}

/** Chains unit edges into polylines and simplifies them; each segment carries the sources of the edges it covers. */
function chainSegments(edges: UnitEdge[], corner: (vid: number) => Vec2, tol: number): BoundarySegment[] {
    const adj = new Map<number, number[]>();
    edges.forEach((e, i) => { for (const v of [e.u, e.v]) { const l = adj.get(v); if (l) l.push(i); else adj.set(v, [i]); } });
    const used = new Uint8Array(edges.length);
    const out: BoundarySegment[] = [];
    const walk = (start: number) => {
        for (const first of adj.get(start)!) {
            if (used[first]) continue;
            const verts = [start], path: number[] = [];
            let cur = start, e = first;
            for (;;) {
                used[e] = 1;
                path.push(e);
                const nxt = edges[e].u === cur ? edges[e].v : edges[e].u;
                verts.push(nxt);
                cur = nxt;
                const opts = adj.get(cur)!;
                if (opts.length !== 2) break;
                const n = opts.find(o => !used[o]);
                if (n === undefined) break;
                e = n;
            }
            const pts = verts.map(corner);
            const kept = simplify(pts, tol);
            for (let s = 0; s + 1 < kept.length; s++) {
                const a = kept[s], b = kept[s + 1];
                const src = new Set<BoundarySource>();
                let len = 0;
                for (let q = a; q < b; q++) { for (const x of edges[path[q]].sources) src.add(x); len += Math.hypot(pts[q + 1][0] - pts[q][0], pts[q + 1][1] - pts[q][1]); }
                const r = (v: number) => Math.round(v * 1000) / 1000;
                out.push({ from: [r(pts[a][0]), r(pts[a][1])], to: [r(pts[b][0]), r(pts[b][1])], lengthM: r(len), decidedBy: [...src].sort() });
            }
        }
    };
    for (const [v, l] of adj) if (l.length !== 2) walk(v);
    for (const [v] of adj) walk(v);  // closed loops
    return out;
}

/**
 * Party walls and exteriors of every building on the ownership grid. `nearVector(label, x, z)` says whether a point lies
 * within SPLIT_VECTOR_EDGE_M of that building's vector outline; `voteCells` marks cells where the mask vote moved triangles.
 */
export function boundaries(g: Grid, owner: Int32Array, labels: number, opts: { nearVector: (label: number, x: number, z: number) => boolean; voteCells?: Uint8Array }): Map<number, BuildingBoundary> {
    const { nx, nz, cellMeters: cell } = g;
    const above = (c: number) => (g.top[c] === g.top[c] && g.ground[c] === g.ground[c] ? g.top[c] - g.ground[c] : 0);
    const vid = (i: number, k: number) => k * (nx + 1) + i;
    const corner = (v: number): Vec2 => [g.x0 + (v % (nx + 1)) * cell, g.z0 + Math.floor(v / (nx + 1)) * cell];
    const party = new Map<string, UnitEdge[]>();
    const out = new Map<number, BuildingBoundary>();
    for (let l = 1; l <= labels; l++) out.set(l, { partyWalls: [], exteriorM: 0, exteriorDecidedByM: {} });
    const sourcesOf = (a: number, b: number, mx: number, mz: number, la: number, lb: number): BoundarySource[] => {
        const s: BoundarySource[] = [];
        if (opts.nearVector(la, mx, mz) || (lb && opts.nearVector(lb, mx, mz))) s.push('vector-footprint');
        const bRaised = b >= 0 && above(b) >= STRUCTURE_MIN_HEIGHT_M && !g.canopy?.[b];
        if ((lb || bRaised) && b >= 0 && Math.abs(above(a) - above(b)) >= STRUCTURE_PART_STEP_M) s.push('height-jump');
        if (opts.voteCells && (opts.voteCells[a] || (b >= 0 && opts.voteCells[b]))) s.push('mask-vote');
        if (!s.length) s.push('scan-geometry');
        return s;
    };
    const visit = (a: number, b: number, u: number, v: number, mx: number, mz: number) => {
        const la = owner[a], lb = b >= 0 ? owner[b] : 0;
        if (la === lb) return;
        for (const [x, y, nb] of [[la, lb, b], [lb, la, a]] as Array<[number, number, number]>) {
            if (!x || y) continue;
            // the exterior of x (the other side is no building's)
            const src = sourcesOf(x === la ? a : b, nb, mx, mz, x, 0);
            const rec = out.get(x)!;
            rec.exteriorM += cell;
            for (const s of src) rec.exteriorDecidedByM[s] = (rec.exteriorDecidedByM[s] ?? 0) + cell;
        }
        if (la && lb) {
            const key = la < lb ? `${la}|${lb}` : `${lb}|${la}`;
            const e: UnitEdge = { u, v, sources: sourcesOf(a, b, mx, mz, la, lb) };
            const l = party.get(key);
            if (l) l.push(e); else party.set(key, [e]);
        }
    };
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const a = k * nx + i;
        // the edge to the east and to the south of each cell (and the grid's west and north borders)
        visit(a, i + 1 < nx ? a + 1 : -1, vid(i + 1, k), vid(i + 1, k + 1), g.x0 + (i + 1) * cell, g.z0 + (k + 0.5) * cell);
        visit(a, k + 1 < nz ? a + nx : -1, vid(i, k + 1), vid(i + 1, k + 1), g.x0 + (i + 0.5) * cell, g.z0 + (k + 1) * cell);
        if (i === 0) visit(a, -1, vid(0, k), vid(0, k + 1), g.x0, g.z0 + (k + 0.5) * cell);
        if (k === 0) visit(a, -1, vid(i, 0), vid(i + 1, 0), g.x0 + (i + 0.5) * cell, g.z0);
    }
    for (const [key, edges] of party) {
        const [la, lb] = key.split('|').map(Number);
        const segments = chainSegments(edges, corner, SPLIT_SEGMENT_TOLERANCE_M);
        const decidedByM: Record<string, number> = {};
        for (const e of edges) for (const s of e.sources) decidedByM[s] = (decidedByM[s] ?? 0) + cell;
        const lengthM = edges.length * cell;
        out.get(la)!.partyWalls.push({ neighbour: lb, lengthM, segments, decidedByM });
        out.get(lb)!.partyWalls.push({ neighbour: la, lengthM, segments, decidedByM });
    }
    for (const rec of out.values()) rec.partyWalls.sort((p, q) => q.lengthM - p.lengthM);
    return out;
}

// ----------------------------------------------------------------------------------------------------------------
// what no footprint owns
// ----------------------------------------------------------------------------------------------------------------

export interface UnmappedStructure {
    areaM2: number;
    heightM: number;
    centroid: Vec2;
    /** Labels of the buildings it touches. */
    touches: number[];
}

/** Raised masses (STRUCTURE_MIN_HEIGHT_M or more, not tree canopy) no building owns, at least `minAreaM2`, largest first. */
export function unmappedStructures(g: Grid, owner: Int32Array, minAreaM2 = 6): UnmappedStructure[] {
    const { nx, nz, cellMeters: cell } = g;
    const N = nx * nz;
    const raised = (c: number) => !owner[c] && !g.canopy?.[c] && g.top[c] === g.top[c] && g.ground[c] === g.ground[c] && g.top[c] - g.ground[c] >= STRUCTURE_MIN_HEIGHT_M;
    const seen = new Uint8Array(N);
    const out: UnmappedStructure[] = [];
    for (let s = 0; s < N; s++) {
        if (seen[s] || !raised(s)) continue;
        const st = [s];
        seen[s] = 1;
        let n = 0, h = 0, sx = 0, sz = 0;
        const touches = new Set<number>();
        while (st.length) {
            const c = st.pop()!;
            n++;
            h = Math.max(h, g.top[c] - g.ground[c]);
            const i = c % nx, k = (c / nx) | 0;
            sx += g.x0 + (i + 0.5) * cell; sz += g.z0 + (k + 0.5) * cell;
            for (const [ii, kk] of [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]]) {
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const q = kk * nx + ii;
                if (owner[q]) touches.add(owner[q]);
                else if (!seen[q] && raised(q)) { seen[q] = 1; st.push(q); }
            }
        }
        const area = n * cell * cell;
        if (area >= minAreaM2) out.push({ areaM2: area, heightM: Math.round(h * 100) / 100, centroid: [Math.round((sx / n) * 100) / 100, Math.round((sz / n) * 100) / 100], touches: [...touches].sort((a, b) => a - b) });
    }
    return out.sort((a, b) => b.areaM2 - a.areaM2);
}
