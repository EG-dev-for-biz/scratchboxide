/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Plane first, inside and on top of a rebuilt building (follows wall-plane-fit.ts):
 *   - Courtyards and light wells: where the scan's top surface inside a footprint lies far below the part's roof over a real,
 *     enclosed area, the part gets an inner ring there (its walls then fitted like any other) and, when the scan's floor of the
 *     void stands above the part's base, a floor part up to it. The ring is the simplest shape that fills the void: a
 *     rectangle (in the building's own frame or the void's) or a regular polygon for a round one.
 *   - Rooftop solids: a connected region of the scan standing clearly over the part's roof (plant rooms, lift overruns, a
 *     lantern) becomes one fitted prism of the same simple shapes, from the roof to the height the scan measures there,
 *     labelled generated with its fit.
 *   - Roof debris: residual clusters that are splinters (thin in two directions) or lie on a rebuilt roof (within its band) are
 *     the scan's noise about the roof plane and are dropped; the roof plane and the fitted solids stand for them.
 * Nothing is named: regions are cells and numbers, shapes are rectangles and polygons chosen by how well they fill.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { inLoops, roofAt, type RoofPlaneSpec } from './pipeline-e/massing-spec';
import type { ResidualCluster } from './wall-plane-fit';

export const ROOF_AND_VOIDS_VERSION = 'roof-and-voids/1';

/** The provenance tokens the native tool passes through to these parts' nodes. */
export const ROOFTOP_SOLID_TOKEN = 'rooftop-solid-fitted';
export const COURTYARD_FLOOR_TOKEN = 'courtyard-floor-measured';

export const VOID_PARAMS = {
    /** A cell is void when the scan's top there lies this far under the part's roof (and this share of the part's height). */
    minDepthM: 4,
    minDepthShare: 0.25,
    /** Enclosed: every void cell at least this far inside the part's outer ring (a gap reaching the edge is a setback). */
    edgeClearM: 2,
    minAreaM2: 20,
    minSideM: 3,
    /** The fitted shape must fill at least this share of the void (and the void this share of the shape). */
    minFill: 0.6,
    /** Enclosed by the roof: of the part's cells within enclosureM of the void, at least this share stand near the roof (a
     * pitched roof's eaves or an aisle against the footprint's edge are not enclosed). */
    enclosureM: 3,
    minEnclosedShare: 0.75,
    /** A floor part when the void's floor stands at least this far over the part's base. */
    minFloorM: 1
};

export const ROOFTOP_PARAMS = {
    /** A cell stands on the roof when the scan's top there is this far over the part's roof. */
    minHeightM: 1.2,
    /** At least this far inside the part's outer ring (parapets and the neighbour's wall are not rooftop objects). */
    edgeClearM: 1,
    minAreaM2: 4,
    /** A region over this share of the part's plan is a tier the massing missed, never a rooftop object. */
    maxPartShare: 0.35,
    minFill: 0.55
};

export const DEBRIS_PARAMS = {
    /** A splinter: its second principal extent under this (thin in two directions), and under maxSplinterAreaM2. */
    splinterM: 0.5,
    maxSplinterAreaM2: 15,
    /** On a roof: this share of its area within roofBandM of a rebuilt part's roof, inside its plan. */
    roofBandM: 1.0,
    roofShare: 0.7,
    /** Inside the rebuilt solid: this share of its area under a part's roof band, inside its plan. */
    hiddenShare: 0.6
};

type PartLike = { id: string; baseY: number; topY: number; loops: Vec2[][]; planes: RoofPlaneSpec[] };

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
const ringDist = (p: Vec2, ring: Vec2[]) => { let d = Infinity; for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i], ring[(i + 1) % ring.length])); return d; };
const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

/** The simplest shape filling a set of 1 m cells: a rectangle in one of the given frames, or a regular 16-gon. */
export interface FittedShape { loop: Vec2[]; kind: 'rectangle' | 'polygon'; fill: number; areaM2: number; sidesM: [number, number] }

export function fitCellShape(cells: Vec2[], frames: number[]): FittedShape | undefined {
    if (!cells.length) return undefined;
    const n = cells.length;
    let best: FittedShape | undefined;
    const pca = (() => {
        const cx = cells.reduce((t, c) => t + c[0], 0) / n, cz = cells.reduce((t, c) => t + c[1], 0) / n;
        let a = 0, b = 0, c2 = 0;
        for (const c of cells) { a += (c[0] - cx) ** 2; b += (c[0] - cx) * (c[1] - cz); c2 += (c[1] - cz) ** 2; }
        return 0.5 * Math.atan2(2 * b, a - c2);
    })();
    for (const phi of [...frames, pca]) {
        const cs = Math.cos(phi), sn = Math.sin(phi);
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const c of cells) { const u = c[0] * cs + c[1] * sn, v = -c[0] * sn + c[1] * cs; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
        u0 -= 0.5; u1 += 0.5; v0 -= 0.5; v1 += 0.5;
        const area = (u1 - u0) * (v1 - v0), fill = n / area;
        if (best && fill <= best.fill) continue;
        const back = (u: number, v: number): Vec2 => [u * cs - v * sn, u * sn + v * cs];
        best = { loop: [back(u0, v0), back(u1, v0), back(u1, v1), back(u0, v1)], kind: 'rectangle', fill: r3(fill), areaM2: r3(area), sidesM: [r3(u1 - u0), r3(v1 - v0)] };
    }
    // a round one: the equal-area circle about the centroid, scored by intersection over union
    const cx = cells.reduce((t, c) => t + c[0], 0) / n, cz = cells.reduce((t, c) => t + c[1], 0) / n;
    const r = Math.sqrt(n / Math.PI);
    const inside = cells.filter(c => Math.hypot(c[0] - cx, c[1] - cz) <= r).length;
    const iou = inside / (n + Math.PI * r * r - inside);
    if (best && iou > best.fill + 0.05) {
        const loop: Vec2[] = Array.from({ length: 16 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 8), cz + r * Math.sin((k * Math.PI) / 8)] as Vec2);
        best = { loop, kind: 'polygon', fill: r3(iou), areaM2: r3(Math.PI * r * r), sidesM: [r3(2 * r), r3(2 * r)] };
    }
    return best;
}

/** The angle of a ring's longest edge (the building's own frame). */
export function longestEdgeAngle(ring: Vec2[]): number {
    let best = 0, ang = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); }
    }
    return ang;
}

/** A component with its enclosed holes filled (a hollow lantern's interior is part of it). */
function fillHoles(comp: Array<[number, number]>): Array<[number, number]> {
    const has = new Set(comp.map(([x, z]) => `${x},${z}`));
    const xs = comp.map(c => c[0]), zs = comp.map(c => c[1]);
    const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1, z0 = Math.min(...zs) - 1, z1 = Math.max(...zs) + 1;
    const outside = new Set<string>([`${x0},${z0}`]), stack: Array<[number, number]> = [[x0, z0]];
    while (stack.length) {
        const [x, z] = stack.pop()!;
        for (const [a, b] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
            if (a < x0 || a > x1 || b < z0 || b > z1) continue;
            const k = `${a},${b}`;
            if (has.has(k) || outside.has(k)) continue;
            outside.add(k);
            stack.push([a, b]);
        }
    }
    const out = comp.slice();
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const k = `${x},${z}`; if (!has.has(k) && !outside.has(k)) out.push([x, z]); }
    return out;
}

/** 4-connected components of a set of integer cells ("x,z"). */
function components(cells: Set<string>): Array<Array<[number, number]>> {
    const seen = new Set<string>(), out: Array<Array<[number, number]>> = [];
    for (const k of cells) {
        if (seen.has(k)) continue;
        seen.add(k);
        const stack = [k], comp: Array<[number, number]> = [];
        while (stack.length) {
            const [x, z] = stack.pop()!.split(',').map(Number);
            comp.push([x, z]);
            for (const q of [`${x + 1},${z}`, `${x - 1},${z}`, `${x},${z + 1}`, `${x},${z - 1}`]) if (cells.has(q) && !seen.has(q)) { seen.add(q); stack.push(q); }
        }
        out.push(comp);
    }
    return out;
}

/** The 1 m cells inside a part's plan (centres), at least `clear` inside its outer ring, not inside `exclude`. */
function partCells(part: PartLike, clear: number, exclude: (x: number, z: number) => boolean): Array<[number, number]> {
    const ring = part.loops[0];
    const xs = ring.map(q => q[0]), zs = ring.map(q => q[1]);
    const out: Array<[number, number]> = [];
    for (let z = Math.floor(Math.min(...zs)); z <= Math.ceil(Math.max(...zs)); z++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        const p: Vec2 = [x + 0.5, z + 0.5];
        if (!inLoops(p[0], p[1], part.loops) || exclude(p[0], p[1]) || ringDist(p, ring) < clear) continue;
        out.push([x, z]);
    }
    return out;
}

// ------------------------------------------------------------------------------------------------
// courtyards and light wells
// ------------------------------------------------------------------------------------------------

export interface VoidRecord { part: string; holeLoop: number; shape: FittedShape['kind']; areaM2: number; fill: number; depthM: number; floorY: number; floorPart?: string; cells: number }

/**
 * Each part's enclosed voids carved as inner rings (VOID_PARAMS), with a floor part where the void's floor stands over the
 * part's base. `otherCover(part, x, z)` says another part of the building stands there over this part (its plan is not
 * this part's roof). Returns the parts with their new rings, the floor parts (their ring is the hole's: after the walls are
 * fitted, set each floor's loop to its host's ring), and the records.
 */
export function carveCourtyards<P extends PartLike>(parts: P[], scanTop: (x: number, z: number) => number, P = VOID_PARAMS): { parts: P[]; floors: Array<{ floor: P; host: string; holeLoop: number }>; voids: VoidRecord[] } {
    const out: P[] = [], floors: Array<{ floor: P; host: string; holeLoop: number }> = [], voids: VoidRecord[] = [];
    for (const part of parts) {
        const H = part.topY - part.baseY;
        const deep = Math.max(P.minDepthM, P.minDepthShare * H);
        if (H < deep + 1) { out.push(part); continue; }
        const covered = (x: number, z: number) => parts.some(o => o !== part && o.topY > part.topY && inLoops(x, z, o.loops));
        const cells = new Set<string>();
        for (const [x, z] of partCells(part, P.edgeClearM, covered)) {
            const t = scanTop(x + 0.5, z + 0.5);
            if (Number.isFinite(t) && t < roofAt(part, x + 0.5, z + 0.5) - deep) cells.add(`${x},${z}`);
        }
        const loops = part.loops.slice();
        for (const comp of components(cells)) {
            if (comp.length < P.minAreaM2) continue;
            // enclosed: the part's cells around the void stand near the roof (and the void is not at the footprint's edge)
            const own = new Set(comp.map(([x, z]) => `${x},${z}`));
            const around = new Set<string>();
            const R = Math.ceil(P.enclosureM);
            for (const [x, z] of comp) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) { const k = `${x + dx},${z + dz}`; if (!own.has(k)) around.add(k); }
            let high = 0, n = 0;
            for (const k of around) {
                const [x, z] = k.split(',').map(Number);
                n++;
                if (!inLoops(x + 0.5, z + 0.5, part.loops)) continue;  // outside the plan: open to the street, not enclosed
                const t = scanTop(x + 0.5, z + 0.5);
                if (Number.isFinite(t) && t >= roofAt(part, x + 0.5, z + 0.5) - deep / 2) high++;
            }
            if (!n || high / n < P.minEnclosedShare) continue;
            const shape = fitCellShape(comp.map(([x, z]) => [x + 0.5, z + 0.5] as Vec2), [longestEdgeAngle(part.loops[0])]);
            if (!shape || shape.fill < P.minFill || Math.min(...shape.sidesM) < P.minSideM) continue;
            // the ring stays inside the outer ring and clear of the existing holes
            if (!shape.loop.every(q => inLoops(q[0], q[1], loops) && ringDist(q, part.loops[0]) >= 0.5)) continue;
            const floorY = median(comp.map(([x, z]) => scanTop(x + 0.5, z + 0.5)));
            loops.push(shape.loop);
            const rec: VoidRecord = { part: part.id, holeLoop: loops.length - 1, shape: shape.kind, areaM2: shape.areaM2, fill: shape.fill, depthM: r3(part.topY - floorY), floorY: r3(floorY), cells: comp.length };
            if (floorY - part.baseY >= P.minFloorM) {
                const floor = { ...part, id: `${part.id}/c${loops.length - 1}`, topY: floorY, loops: [shape.loop], planes: [], provenance: COURTYARD_FLOOR_TOKEN } as P;
                floors.push({ floor, host: part.id, holeLoop: loops.length - 1 });
                rec.floorPart = floor.id;
            }
            voids.push(rec);
        }
        out.push(loops.length === part.loops.length ? part : { ...part, loops });
    }
    return { parts: out, floors, voids };
}

// ------------------------------------------------------------------------------------------------
// rooftop solids
// ------------------------------------------------------------------------------------------------

export interface RooftopRecord { part: string; solid: string; shape: FittedShape['kind']; areaM2: number; fill: number; heightM: number; topRmsM: number; cells: number }

/** Substantial regions of the scan standing over each part's roof, each as one fitted prism (ROOFTOP_PARAMS). */
export function fitRooftopSolids<P extends PartLike>(parts: P[], scanTop: (x: number, z: number) => number, P = ROOFTOP_PARAMS): { solids: P[]; records: RooftopRecord[] } {
    const solids: P[] = [], records: RooftopRecord[] = [];
    for (const part of parts) {
        const covered = (x: number, z: number) => parts.some(o => o !== part && o.topY > part.topY - 0.5 && inLoops(x, z, o.loops));
        const all = partCells(part, P.edgeClearM, covered);
        const cells = new Set<string>();
        for (const [x, z] of all) {
            const t = scanTop(x + 0.5, z + 0.5);
            if (Number.isFinite(t) && t > roofAt(part, x + 0.5, z + 0.5) + P.minHeightM) cells.add(`${x},${z}`);
        }
        let k = 0;
        for (const ring of components(cells)) {
            const comp = fillHoles(ring);
            if (comp.length < P.minAreaM2 || comp.length > P.maxPartShare * Math.max(1, all.length)) continue;
            const shape = fitCellShape(comp.map(([x, z]) => [x + 0.5, z + 0.5] as Vec2), [longestEdgeAngle(part.loops[0])]);
            if (!shape || shape.fill < P.minFill) continue;
            // the top from the region's own raised cells (a hollow one's interior is inside the prism, not its top)
            const tops = ring.map(([x, z]) => scanTop(x + 0.5, z + 0.5)).sort((a, b) => a - b);
            // the solid's top: the median of the region's upper half (a sloped or peaked top is not its spike)
            const top = median(tops.slice(tops.length >> 1));
            const base = Math.min(...shape.loop.map(q => roofAt(part, q[0], q[1]))) - 0.05;
            if (top - base < P.minHeightM) continue;
            const rms = Math.sqrt(tops.reduce((t, v) => t + (v - top) ** 2, 0) / tops.length);
            const id = `${part.id}/r${k++}`;
            solids.push({ ...part, id, baseY: base, topY: top, loops: [shape.loop], planes: [], provenance: ROOFTOP_SOLID_TOKEN } as P);
            records.push({ part: part.id, solid: id, shape: shape.kind, areaM2: shape.areaM2, fill: shape.fill, heightM: r3(top - base), topRmsM: r3(rms), cells: comp.length });
        }
    }
    return { solids, records };
}

// ------------------------------------------------------------------------------------------------
// roof debris
// ------------------------------------------------------------------------------------------------

/** The two largest principal extents of a point set (x, y, z flattened): the range of the points along each axis. */
export function principalExtents(points: number[]): [number, number] {
    const n = points.length / 3;
    if (n < 2) return [0, 0];
    const m = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m[k] += points[i * 3 + k] / n;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) { const d = [0, 1, 2].map(k => points[i * 3 + k] - m[k]); for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b]; }
    // the main axis by power iteration, the second as the main axis of what is left
    const power = (M: number[][], seed: number[]): number[] => {
        let v = seed;
        for (let it = 0; it < 40; it++) { const w = [0, 1, 2].map(a => M[a][0] * v[0] + M[a][1] * v[1] + M[a][2] * v[2]); const l = Math.hypot(...w) || 1; v = w.map(x => x / l); }
        return v;
    };
    const v1 = power(C, [1, 0.7, 0.3]);
    const l1 = [0, 1, 2].reduce((t, a) => t + v1[a] * [0, 1, 2].reduce((u, b) => u + C[a][b] * v1[b], 0), 0);
    const C2 = C.map((row, a) => row.map((c, b) => c - l1 * v1[a] * v1[b]));
    let v2 = power(C2, [0.3, 1, 0.6]);
    const dot = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
    v2 = v2.map((x, k) => x - dot * v1[k]);
    const l2 = Math.hypot(...v2) || 1;
    v2 = v2.map(x => x / l2);
    const range = (v: number[]) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const p = points[i * 3] * v[0] + points[i * 3 + 1] * v[1] + points[i * 3 + 2] * v[2]; lo = Math.min(lo, p); hi = Math.max(hi, p); } return hi - lo; };
    return [range(v1), range(v2)];
}

/**
 * The decision dropResidualClusters (wall-plane-fit.ts) takes for roof debris: a splinter (thin in two directions, small), or
 * a cluster lying mostly within the roof band of a rebuilt part (inside its plan), is dropped with that reason.
 */
export function roofDebrisDecider(parts: PartLike[], P = DEBRIS_PARAMS): (cl: ResidualCluster) => string | undefined {
    return cl => {
        const [, e2] = principalExtents(cl.points);
        if (e2 < P.splinterM && cl.areaM2 < P.maxSplinterAreaM2) return 'splinter';
        let onRoof = 0, inside = 0;
        for (const t of cl.tris) {
            const [x, y, z] = t.c;
            const host = parts.filter(p => inLoops(x, z, p.loops));
            if (host.some(p => y >= p.baseY - 0.5 && y <= roofAt(p, x, z) - P.roofBandM)) inside += t.area;
            else if (host.some(p => Math.abs(y - roofAt(p, x, z)) <= P.roofBandM)) onRoof += t.area;
        }
        if (cl.areaM2 <= 0) return undefined;
        // the scan inside the rebuilt solid (it cannot be seen; what pokes through the roof plane is splinters)
        if (inside >= P.hiddenShare * cl.areaM2) return 'hidden';
        return onRoof + inside >= P.roofShare * cl.areaM2 ? 'roof' : undefined;
    };
}
