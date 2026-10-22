/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, step 1: the building's massing as continuous numbers, from Google's own data, checked against the scan.
 *
 *   - Plan: each extruded part of the building's vector footprint (its loops simplified to clean corners: Douglas-Peucker
 *     at SIMPLIFY_TOLERANCE_M, near-collinear corners dropped), or the modelled 3D volume where Google has one (used as
 *     given: its triangles, on the building's base).
 *   - Height per part: the Solar API's flat roof facets inside it, else the vector height, each taken only when it lies within
 *     HEIGHT_AGREEMENT_M of the scan's roof there; otherwise the scan's roof (median) stands, and the record says so.
 *   - Roof: pitched Solar facets inside a part are planes y = a + b x + c z; the roof is the lower envelope of the kept planes
 *     capped at the top. A facet is kept only when adding it lowers the part's roof error against the scan (greedy, by area).
 *   - The check: the massing's plan against the scan's structure cells (intersection over union) and its roof against the
 *     scan's top (median absolute error). A massing below MIN_MASSING_IOU, or further off than the height limit, is not used:
 *     the build falls back to the current pipeline with these numbers as the reason.
 *
 * No part is named or classified: a part is loops and numbers.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import type { VectorBuilding } from '../vector-footprints';
import type { SolarRoofSegment } from './solar-roof';

export const SIMPLIFY_TOLERANCE_M = 0.25;
export const COLLINEAR_DEG = 6;
export const HEIGHT_AGREEMENT_M = 2.5;
export const MIN_PITCHED_DEG = 10;
export const MIN_MASSING_IOU = 0.6;
/** The roof's median absolute error may be at most this, or this share of the building's height when that is larger. */
export const MAX_HEIGHT_ERROR_M = 3;
export const MAX_HEIGHT_ERROR_SHARE = 0.15;
/** An upper tier stands where the scan reaches its height over at least this share of the tier's own (inset) plan. */
export const MIN_TIER_SUPPORT = 0.6;
/** A tier thinner than this is not a storey of the building: it is left out. */
export const MIN_TIER_THICKNESS_M = 1;

export interface RoofPlaneSpec { a: number; b: number; c: number; tag: string }

export interface MassingPart {
    id: string;
    baseY: number;
    topY: number;
    loops: Vec2[][];
    planes: RoofPlaneSpec[];
    heightSource: 'solar' | 'vector' | 'scan' | (string & {});
    heights: { vectorY?: number; solarY?: number; scanY?: number };
    /** The provenance token the native tool passes through to the part's nodes (default: the spec's). */
    provenance?: string;
}

export interface MassingMesh { id: string; vertices: Array<[number, number, number]>; indices: number[]; /** The provenance token the native tool passes through to the solid's nodes (default: the spec's). */ provenance?: string }

export interface MassingCheck {
    iou: number;
    heightErrMedianM: number;
    heightErrP90M: number;
    massingCells: number;
    scanCells: number;
    ok: boolean;
    reason?: string;
}

export interface Massing {
    parts: MassingPart[];
    meshes: MassingMesh[];
    check: MassingCheck;
    solar: { segments: number; inside: number; pitchedKept: number; pitchedRejected: number; flatUsed: number };
    notes: string[];
}

export interface MassingInputs {
    /** The target building's vector features (the pick's feature ids). */
    buildings: VectorBuilding[];
    /** Street level at the structure (the pick's ground). */
    groundY: number;
    /** The scan's top surface at (x, z) (NaN without data): the ground model's top, canopy masked. */
    scanTop: (x: number, z: number) => number;
    /** The structure's cells in the scan ("floor(x),floor(z)", 1 m). */
    cells: ReadonlySet<string>;
    /** Solar roof facets with their centres and plane heights already in the tile frame. */
    solar?: Array<SolarRoofSegment & { x: number; z: number; y: number }>;
}

// ------------------------------------------------------------------------------------------------
// plan geometry
// ------------------------------------------------------------------------------------------------

export function ringArea(r: Vec2[]): number {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a / 2;
}

export function inRing(x: number, z: number, r: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, zi] = r[i], [xj, zj] = r[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

export function inLoops(x: number, z: number, loops: Vec2[][]): boolean {
    let inside = false;
    for (const l of loops) if (l.length >= 3 && inRing(x, z, l)) inside = !inside;
    return inside;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** A closed ring simplified: duplicate points out, Douglas-Peucker at `tol`, near-collinear corners dropped. */
export function simplifyRing(ring: Vec2[], tol = SIMPLIFY_TOLERANCE_M, collinearDeg = COLLINEAR_DEG): Vec2[] {
    let r = ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 1e-3);
    if (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-3) r = r.slice(0, -1);
    if (r.length < 4) return r;
    // Douglas-Peucker on the open chain from the vertex furthest from the first
    let far = 0, fd = -1;
    for (let i = 1; i < r.length; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
    const dp = (pts: Vec2[]): Vec2[] => {
        if (pts.length <= 2) return pts;
        let idx = 0, dmax = 0;
        for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > dmax) { dmax = d; idx = i; } }
        if (dmax <= tol) return [pts[0], pts[pts.length - 1]];
        return [...dp(pts.slice(0, idx + 1)).slice(0, -1), ...dp(pts.slice(idx))];
    };
    const a = dp(r.slice(0, far + 1)), b = dp([...r.slice(far), r[0]]);
    const out = [...a.slice(0, -1), ...b.slice(0, -1)];
    // near-collinear corners out (repeat until stable)
    for (let changed = true; changed && out.length > 3;) {
        changed = false;
        for (let i = 0; i < out.length && out.length > 3; i++) {
            const p = out[(i + out.length - 1) % out.length], q = out[i], s = out[(i + 1) % out.length];
            const u: Vec2 = [q[0] - p[0], q[1] - p[1]], v: Vec2 = [s[0] - q[0], s[1] - q[1]];
            const lu = Math.hypot(...u), lv = Math.hypot(...v);
            if (lu < 0.05 || lv < 0.05) { out.splice(i, 1); changed = true; break; }
            const ang = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI;
            if (ang < collinearDeg) { out.splice(i, 1); changed = true; break; }
        }
    }
    return out;
}

const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
const quantile = (v: number[], q: number): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

/** Grid sample points (cell centres, 1 m) inside loops. */
function samplesIn(loops: Vec2[][], step = 1): Vec2[] {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of loops[0] ?? []) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const out: Vec2[] = [];
    for (let z = Math.floor(z0) + 0.5; z < z1; z += step) for (let x = Math.floor(x0) + 0.5; x < x1; x += step) if (inLoops(x, z, loops)) out.push([x, z]);
    return out;
}

/** A Solar facet as a plane y = a + b x + c z: through its centre, rising against its azimuth (north = -z, east = +x). */
export function solarPlane(s: { pitchDeg: number; azimuthDeg: number; x: number; z: number; y: number }): RoofPlaneSpec {
    const k = Math.tan((s.pitchDeg * Math.PI) / 180), az = (s.azimuthDeg * Math.PI) / 180;
    const dx = Math.sin(az), dz = -Math.cos(az);  // downslope direction in the frame
    const b = -k * dx, c = -k * dz;
    return { a: s.y - b * s.x - c * s.z, b, c, tag: `solar:${s.pitchDeg.toFixed(1)}deg@${s.azimuthDeg.toFixed(0)}` };
}

export function roofAt(part: Pick<MassingPart, 'topY' | 'baseY' | 'planes'>, x: number, z: number): number {
    let y = part.topY;
    for (const p of part.planes) y = Math.min(y, p.a + p.b * x + p.c * z);
    return Math.max(y, part.baseY + 0.25);
}

/** Highest surface of a triangle mesh per 1 m cell (the cells its triangles' plan covers). */
export function meshTopCells(m: MassingMesh): Map<string, number> {
    const out = new Map<string, number>();
    const V = m.vertices;
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const a = V[m.indices[t]], b = V[m.indices[t + 1]], c = V[m.indices[t + 2]];
        const x0 = Math.floor(Math.min(a[0], b[0], c[0])), x1 = Math.floor(Math.max(a[0], b[0], c[0]));
        const z0 = Math.floor(Math.min(a[2], b[2], c[2])), z1 = Math.floor(Math.max(a[2], b[2], c[2]));
        const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(d) < 1e-9) continue;  // vertical
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, pz = z + 0.5;
            const l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / d, l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / d, l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
            const k = `${x},${z}`;
            if (!(out.get(k)! >= y)) out.set(k, y);
        }
    }
    return out;
}

/**
 * A modelled volume as one closed surface: Google's volumes carry each triangle twice (both windings, drawn double-sided);
 * one copy of a triangle repeated on the same three corners is kept, then every triangle is turned to face out of the volume
 * (`orientOutward`). Choosing the copy that faces away from the volume's centre (rounds 3-6) turned a tower's or a steeple's
 * walls that face the centre inwards: their orthos saw nothing, and they took one flat colour.
 */
export function singleSided(m: MassingMesh): MassingMesh {
    const V = m.vertices;
    const key = (i: number) => V[i].map(c => Math.round(c * 1e5)).join(',');
    const seen = new Set<string>();
    const indices: number[] = [];
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const k = tri.map(key).sort().join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        indices.push(...tri);
    }
    return orientOutward({ ...m, indices }).mesh;
}

/** Ray-triangle hit distance along `dir` from `o` (Möller-Trumbore), or -1. */
export function rayHit(o: number[], dir: number[], a: number[], b: number[], c: number[]): number {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
    if (u < 0 || u > 1) return -1;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) return -1;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    return t > 1e-6 ? t : -1;
}

/**
 * Whether a ray from `o` along `dir` hits any triangle but `skip`, with rayHit's arithmetic, over a median-split bounding
 * volume hierarchy of the triangles' boxes: the same answers as testing every triangle, without the quadratic cost (a
 * modelled volume of a few thousand triangles took minutes to orient: 32 rays from 7 points on each side of every triangle).
 */
export class TriangleRayIndex {
    private readonly tri: Float64Array;
    private readonly lo: Float64Array; private readonly hi: Float64Array;
    /** Node: [box lo xyz, box hi xyz] in nlo/nhi; left child index (or -1 for a leaf), right child, leaf start, leaf count. */
    private readonly nlo: number[] = []; private readonly nhi: number[] = [];
    private readonly left: number[] = []; private readonly right: number[] = []; private readonly start: number[] = []; private readonly count: number[] = [];
    private readonly order: Int32Array;

    constructor(V: ReadonlyArray<ArrayLike<number>>, indices: ArrayLike<number>) {
        const T = Math.floor(indices.length / 3);
        this.tri = new Float64Array(T * 9);
        this.lo = new Float64Array(T * 3); this.hi = new Float64Array(T * 3);
        for (let t = 0; t < T; t++) for (let j = 0; j < 3; j++) {
            const v = V[indices[t * 3 + j]];
            for (let k = 0; k < 3; k++) {
                this.tri[t * 9 + j * 3 + k] = v[k];
                if (j === 0) { this.lo[t * 3 + k] = v[k]; this.hi[t * 3 + k] = v[k]; } else { this.lo[t * 3 + k] = Math.min(this.lo[t * 3 + k], v[k]); this.hi[t * 3 + k] = Math.max(this.hi[t * 3 + k], v[k]); }
            }
        }
        this.order = Int32Array.from({ length: T }, (_, i) => i);
        if (T) this.build(0, T);
    }

    private build(s: number, e: number): number {
        const node = this.left.length;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = s; i < e; i++) { const t = this.order[i]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], this.lo[t * 3 + k]); hi[k] = Math.max(hi[k], this.hi[t * 3 + k]); } }
        this.nlo.push(...lo); this.nhi.push(...hi); this.left.push(-1); this.right.push(-1); this.start.push(s); this.count.push(e - s);
        if (e - s <= 4) return node;
        const axis = [0, 1, 2].sort((a, b) => (hi[b] - lo[b]) - (hi[a] - lo[a]))[0];
        const centre = (t: number) => this.lo[t * 3 + axis] + this.hi[t * 3 + axis];
        const sub = Array.from(this.order.subarray(s, e)).sort((a, b) => centre(a) - centre(b));
        this.order.set(sub, s);
        const m = (s + e) >> 1;
        const l = this.build(s, m), r = this.build(m, e);
        this.left[node] = l; this.right[node] = r;
        return node;
    }

    private boxHit(n: number, o: ArrayLike<number>, d: ArrayLike<number>): boolean {
        let t0 = 0, t1 = Infinity;
        for (let k = 0; k < 3; k++) {
            const lo = this.nlo[n * 3 + k], hi = this.nhi[n * 3 + k];
            if (Math.abs(d[k]) < 1e-15) { if (o[k] < lo || o[k] > hi) return false; continue; }
            let a = (lo - o[k]) / d[k], b = (hi - o[k]) / d[k];
            if (a > b) { const tmp = a; a = b; b = tmp; }
            t0 = Math.max(t0, a); t1 = Math.min(t1, b);
            if (t0 > t1 + 1e-9) return false;
        }
        return true;
    }

    /** rayHit(o, dir, a, b, c) > 0 for some triangle other than `skip`. */
    anyHit(o: ArrayLike<number>, dir: ArrayLike<number>, skip: number): boolean {
        if (!this.left.length) return false;
        const stack = [0];
        const P = this.tri;
        while (stack.length) {
            const n = stack.pop()!;
            if (!this.boxHit(n, o, dir)) continue;
            if (this.left[n] >= 0) { stack.push(this.left[n], this.right[n]); continue; }
            for (let i = this.start[n]; i < this.start[n] + this.count[n]; i++) {
                const t = this.order[i];
                if (t === skip) continue;
                const b = t * 9;
                const e10 = P[b + 3] - P[b], e11 = P[b + 4] - P[b + 1], e12 = P[b + 5] - P[b + 2];
                const e20 = P[b + 6] - P[b], e21 = P[b + 7] - P[b + 1], e22 = P[b + 8] - P[b + 2];
                const p0 = dir[1] * e22 - dir[2] * e21, p1 = dir[2] * e20 - dir[0] * e22, p2 = dir[0] * e21 - dir[1] * e20;
                const det = e10 * p0 + e11 * p1 + e12 * p2;
                if (Math.abs(det) < 1e-12) continue;
                const inv = 1 / det;
                const s0 = o[0] - P[b], s1 = o[1] - P[b + 1], s2 = o[2] - P[b + 2];
                const u = (s0 * p0 + s1 * p1 + s2 * p2) * inv;
                if (u < 0 || u > 1) continue;
                const q0 = s1 * e12 - s2 * e11, q1 = s2 * e10 - s0 * e12, q2 = s0 * e11 - s1 * e10;
                const v = (dir[0] * q0 + dir[1] * q1 + dir[2] * q2) * inv;
                if (v < 0 || u + v > 1) continue;
                const tt = (e20 * q0 + e21 * q1 + e22 * q2) * inv;
                if (tt > 1e-6) return true;
            }
        }
        return false;
    }
}

/** Barycentric sample points over a triangle (its centroid and six points toward its corners and edges). */
const SAMPLE_BARY: Array<[number, number]> = [[1 / 3, 1 / 3], [0.7, 0.15], [0.15, 0.7], [0.15, 0.15], [0.45, 0.45], [0.45, 0.1], [0.1, 0.45]];

/** Unit directions spread evenly over the sphere (Fibonacci lattice). */
function sphereDirections(n: number): number[][] {
    const out: number[][] = [];
    const g = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = g * i;
        out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    return out;
}

/**
 * Turns every triangle of a mesh to face out of the solid it bounds: from just off each side of a triangle, rays in the
 * directions of that side's hemisphere count how many escape the mesh without crossing it. The side more rays escape from is
 * the outside; a triangle whose normal points to the other side is flipped (a triangle no ray escapes from on either side, a
 * partition inside the volume, is left as given). Works on non-convex volumes (a corner tower, an offset steeple) and on
 * volumes made of overlapping or nested shells, where "away from the centre" and ray parity do not. Returns the count flipped.
 */
export function orientOutward(m: MassingMesh, directions = 32): { mesh: MassingMesh; flipped: number } {
    const V = m.vertices;
    const T = Math.floor(m.indices.length / 3);
    const out = m.indices.slice(0, T * 3);
    const dirs = sphereDirections(directions);
    let flipped = 0;
    // flipping a triangle's winding (below) never moves it, so the index over the triangles as given answers every ray
    const index = new TriangleRayIndex(V, out);
    const escapes = (o: number[], side: number[], self: number): number => {
        let n = 0;
        for (const d of dirs) {
            if (d[0] * side[0] + d[1] * side[1] + d[2] * side[2] < 0.05) continue;
            if (!index.anyHit(o, d, self)) n++;
        }
        return n;
    };
    for (let t = 0; t < T; t++) {
        const a = V[out[t * 3]], b = V[out[t * 3 + 1]], c = V[out[t * 3 + 2]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-12) continue;
        const nn = n.map(x => x / len), back = nn.map(x => -x);
        // several points over the triangle: a wall partly buried in another shell (a tower rising out of a lower roof) is
        // decided by the part that stands free
        let front = 0, behind = 0;
        for (const [l1, l2] of SAMPLE_BARY) {
            const l3 = 1 - l1 - l2;
            const p = [0, 1, 2].map(k => l1 * a[k] + l2 * b[k] + l3 * c[k]);
            front += escapes(p.map((x, k) => x + nn[k] * 1e-3), nn, t);
            behind += escapes(p.map((x, k) => x - nn[k] * 1e-3), back, t);
        }
        if (behind > front) { const tmp = out[t * 3 + 1]; out[t * 3 + 1] = out[t * 3 + 2]; out[t * 3 + 2] = tmp; flipped++; }
    }
    return { mesh: { ...m, indices: out }, flipped };
}

// ------------------------------------------------------------------------------------------------
// stepped massing from the scan's own heightfield
// ------------------------------------------------------------------------------------------------
//
// Google's vector data gives most ordinary buildings one footprint and one height per extruded part - true setbacks
// only come through when Google happens to hand over a true 3D "modelled volume" (buildMassing's `b.volumes` branch
// above) or several separate extruded rings. For everything else, a stepped building was being flattened to one box
// even though the scan's own heightfield (already read into every part via `inp.scanTop`, the ground model's DSM)
// shows the real setbacks. This section reads that same heightfield one level further: instead of taking its single
// median as the part's one roof height, it looks for a stepped "hypsometric" profile (plan area shrinking in jumps as
// height increases) and, when one is found, carves the loop into several nested, independently-extruded tiers - a
// "wedding cake" stack - each still the ordinary SE(3) extrusion the four-operator policy (AGENTS.md 1.5) already
// covers; no new geometric primitive, just more of the existing one, placed from measurement instead of guessed.
//
// The scan's own per-tier outline is never used as the tier's shape (that outline is just a noisy, stairstepped 1 m
// raster, nothing an architect drew): it only says how much plan AREA each tier keeps. The tier's actual shape is the
// vector footprint's own clean ring (the building's real corners and orientation), moved inward by the distance that
// measured area implies (`insetRing`, below) - the photo-tile scan informs how much extra shape there is, the vector
// data supplies what that shape is (user decision, 2026-10-21).

/** A simple ring moved inward by `d` on every edge (each edge's own line offset inward along its normal, new corners from
 *  consecutive offset lines' intersection). Undefined if `d` collapses the ring (self-intersects, or area vanishes or
 *  flips sign) - a scan-measured inset too large for this footprint to carry, left to the caller to cap or skip. */
export function insetRing(ring: Vec2[], d: number): Vec2[] | undefined {
    const n = ring.length;
    if (n < 3) return undefined;
    if (d <= 0) return ring;
    const area0 = ringArea(ring);
    if (Math.abs(area0) < 1e-6) return undefined;
    const sign = area0 >= 0 ? 1 : -1;
    // a ring opposite edges are apart by less than 2d would cross past each other: each axis of a box-like ring then
    // flips, and for an even number of flipped axis-pairs (a square, say) the result still reads as a valid,
    // same-winding ring - just the wrong one. The bounding box's own half-extent is a cheap, honest ceiling on any
    // inset this method can carry, well short of that degenerate crossing.
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (d >= 0.49 * Math.min(x1 - x0, z1 - z0)) return undefined;
    const lines: Array<{ p: Vec2; dir: Vec2 }> = [];
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
        const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
        const nx = sign > 0 ? -uz : uz, nz = sign > 0 ? ux : -ux;  // inward normal (rotate the edge direction +90 deg for a CCW/positive-area ring)
        lines.push({ p: [a[0] + nx * d, a[1] + nz * d], dir: [ux, uz] });
    }
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
        const denom = L1.dir[0] * L2.dir[1] - L1.dir[1] * L2.dir[0];
        if (Math.abs(denom) < 1e-9) { out.push(L2.p); continue; }
        const t = ((L2.p[0] - L1.p[0]) * L2.dir[1] - (L2.p[1] - L1.p[1]) * L2.dir[0]) / denom;
        out.push([L1.p[0] + L1.dir[0] * t, L1.p[1] + L1.dir[1] * t]);
    }
    if (sign * ringArea(out) <= Math.abs(area0) * 0.01) return undefined;  // collapsed, self-intersected, or flipped
    return out;
}

/** The inset distance whose ring area matches `targetArea` as closely as insetRing can get it (bisection on the real,
 *  non-linear area-vs-distance curve - a first-order estimate alone is well off once the inset is a sizeable share of
 *  the footprint). Returns 0 when even a zero inset is already at or under the target (a step the ring can't carry). */
function insetDistanceForArea(ring: Vec2[], baseArea: number, targetArea: number): number {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    let lo = 0, hi = 0.48 * Math.min(x1 - x0, z1 - z0);
    const areaAt = (d: number) => { const r = d <= 0 ? ring : insetRing(ring, d); return r ? Math.abs(ringArea(r)) : 0; };
    if (areaAt(hi) >= targetArea || baseArea <= targetArea) return areaAt(hi) >= targetArea ? hi : 0;
    for (let iter = 0; iter < 30 && hi - lo > 1e-3; iter++) {
        const mid = (lo + hi) / 2;
        if (areaAt(mid) >= targetArea) lo = mid; else hi = mid;
    }
    return lo;
}

export interface HeightTier { baseY: number; topY: number; loop: Vec2[]; cells: ReadonlySet<string> }

/** The constants that govern how readily a flat footprint is split into stepped tiers from the scan alone: conservative,
 *  since a wrong tier (an artefact of scan noise or a rooftop object) would understate the building rather than just
 *  under-detail it - MIN_TIER_SAMPLES and MIN_TIER_DROP_SHARE both have to agree a step is real before one is cut. */
const MIN_TIER_SAMPLES = 25;
const MIN_TIER_DROP_SHARE = 0.08;
const MIN_TIER_DROP_M2 = 9;
const MAX_TIERS = 5;

/**
 * Stepped tiers of one flat footprint from the scan's own heightfield (a "hypsometric" cut: plan area at or above a
 * rising height threshold, split where that area drops sharply - a setback). Returns undefined when the footprint's
 * samples are too few or too flat to call a real step rather than noise; the caller then keeps its one-part behaviour.
 */
export function detectHeightTiers(loops: Vec2[][], scanTop: (x: number, z: number) => number, groundBaseY: number): HeightTier[] | undefined {
    // only a single clean ring has one unambiguous shape to inset from; a footprint with a courtyard or a second,
    // disjoint ring is left to the existing one-part behaviour rather than guessed at.
    if (loops.length !== 1) return undefined;
    const baseRing = loops[0];
    const baseArea = Math.abs(ringArea(baseRing)), basePerimeter = baseRing.reduce((p, pt, i) => p + Math.hypot(pt[0] - baseRing[i === 0 ? baseRing.length - 1 : i - 1][0], pt[1] - baseRing[i === 0 ? baseRing.length - 1 : i - 1][1]), 0);
    if (!(baseArea > 1) || !(basePerimeter > 1)) return undefined;
    const samples = samplesIn(loops).map(([x, z]): [number, number, number] => [x, z, scanTop(x, z)]).filter(s => Number.isFinite(s[2]));
    if (samples.length < MIN_TIER_SAMPLES) return undefined;
    const heights = samples.map(s => s[2]);
    const hMin = Math.min(...heights), hMax = Math.max(...heights);
    if (hMax - hMin < HEIGHT_AGREEMENT_M * 1.5) return undefined;
    const totalArea = samples.length;
    const T0 = Math.floor(hMin), T1 = Math.ceil(hMax);
    const areaAt = (T: number) => samples.reduce((n, s) => n + (s[2] >= T ? 1 : 0), 0);
    const boundaries: number[] = [T0];
    let prevArea = areaAt(T0);
    for (let T = T0 + 1; T <= T1 && boundaries.length <= MAX_TIERS; T++) {
        const a = areaAt(T);
        if (prevArea - a >= Math.max(MIN_TIER_DROP_M2, totalArea * MIN_TIER_DROP_SHARE) && a > 0) boundaries.push(T);
        prevArea = a;
    }
    // T0 (the scan's own lowest sample, not a detected step) never counts as a tier boundary on its own; a real step can
    // still land right next to it (a sharp cliff shows up at T0+1). What has to be kept apart is two DETECTED steps -
    // the gap that would make a resulting middle tier too thin to be a real storey rather than scan noise.
    // a step within a storey of the street (part of the footprint scanned at street level: a courtyard, a dip, a hole in
    // the scan) is not a tier of the building: the first tier rises from the ground to the first real step (Federation
    // Square, 2026-10-22: lowest tiers 0-0.9 m thick, and inverted ones where the scan dipped under the measured street)
    const filtered = boundaries.filter((L, i) => i <= 1 || L - boundaries[i - 1] >= HEIGHT_AGREEMENT_M)
        .filter((L, i) => i === 0 || L >= groundBaseY + HEIGHT_AGREEMENT_M);
    if (filtered.length < 2) return undefined;
    // the scan only says how MUCH plan area a tier keeps, not its literal (noisy, stairstepped) outline - the outline
    // itself comes from the vector footprint's own clean ring, moved inward by the distance that same area implies
    // (A(d) ~= A0 - P0*d for a modest inset), so every tier keeps the building's real corners and orientation.
    const tiers: HeightTier[] = [];
    let prevLoop = baseRing;
    for (let i = 0; i < filtered.length; i++) {
        const lo = filtered[i];
        const cells = new Set<string>();
        const atTier: number[] = [];
        let area = 0;
        for (const [x, z, h] of samples) if (h >= lo) { cells.add(`${Math.floor(x)},${Math.floor(z)}`); area++; if (i + 1 >= filtered.length || h < filtered[i + 1]) atTier.push(h); }
        if (cells.size < 4) continue;
        const d = insetDistanceForArea(baseRing, baseArea, area);
        const loop = insetRing(baseRing, d) ?? (i === 0 ? baseRing : undefined);
        if (!loop) continue;
        // a tier can only nest inside the one below it, never grow past it - the inset is monotonic by construction
        // (bigger d for a later tier, since its area is smaller), but guard it explicitly rather than trust that.
        if (Math.abs(ringArea(loop)) >= Math.abs(ringArea(prevLoop)) - 1 && i > 0) continue;
        // the scan must reach the height this tier claims (its top) over most of where the tier is put (the inset middle of the footprint),
        // not only somewhere in the footprint: a taller neighbour's wall scanned along a shared edge raises a strip of edge
        // cells, which by area alone reads as an upper tier and was placed in the middle, 15-30 m over a row building's
        // real roof (Flatiron district, 2026-10-22). An unsupported tier ends the stack.
        const claimedTopY = i + 1 < filtered.length ? filtered[i + 1] : (atTier.length ? quantile(atTier, 0.9) : lo + HEIGHT_AGREEMENT_M);
        if (i > 0) {
            let inside = 0, reach = 0;
            for (const [x, z, h] of samples) if (inRing(x, z, loop)) { inside++; if (h >= claimedTopY - HEIGHT_AGREEMENT_M) reach++; }
            if (!inside || reach / inside < MIN_TIER_SUPPORT) {
                const last = tiers[tiers.length - 1];
                if (last) {
                    const own = samples.filter(([x, z, h]) => inRing(x, z, last.loop) && h >= last.baseY).map(s => s[2]);
                    if (own.length) last.topY = quantile(own, 0.5);
                    if (last.topY - last.baseY < MIN_TIER_THICKNESS_M) tiers.pop();
                }
                break;
            }
        }
        prevLoop = loop;
        const baseY = i === 0 ? groundBaseY : lo;
        if (claimedTopY - baseY < MIN_TIER_THICKNESS_M) continue;
        tiers.push({ baseY, topY: claimedTopY, loop, cells });
    }
    return tiers.length >= 2 ? tiers : undefined;
}

// ------------------------------------------------------------------------------------------------
// the massing
// ------------------------------------------------------------------------------------------------

export function buildMassing(inp: MassingInputs): Massing {
    const notes: string[] = [];
    const parts: MassingPart[] = [];
    const meshes: MassingMesh[] = [];
    const solar = inp.solar ?? [];
    const solarReport = { segments: solar.length, inside: 0, pitchedKept: 0, pitchedRejected: 0, flatUsed: 0 };
    const usedSolar = new Set<number>();
    for (const b of inp.buildings) {
        // the modelled volume, where Google has one, is the massing as given
        for (const [vi, v] of (b.volumes ?? []).entries()) {
            if (v.vertices.length < 4 || v.indices.length < 12) continue;
            meshes.push(singleSided({ id: `${b.id}/v${vi}`, vertices: v.vertices.map(([x, h, z]) => [x, inp.groundY + h, z]), indices: v.indices.slice() }));
        }
        const extruded = (b.extruded ?? []).filter(p => !(p.planOnly && (b.volumes?.length ?? 0) > 0));
        for (const [pi, p] of extruded.entries()) {
            const loops = p.loops.map(l => simplifyRing(l)).filter(l => l.length >= 3 && Math.abs(ringArea(l)) >= 1);
            if (!loops.length) continue;
            const id = `${b.id}/e${pi}`;
            const baseY = inp.groundY + (p.minHeightM ?? 0);
            const samples = samplesIn(loops);
            const tops = samples.map(([x, z]) => inp.scanTop(x, z)).filter(Number.isFinite);
            const scanY = tops.length >= 4 ? median(tops) : undefined;
            const vectorY = p.heightM !== undefined ? inp.groundY + p.heightM : undefined;
            // Solar facets inside the part
            const inside = solar.map((s, k) => ({ s, k })).filter(({ s }) => inLoops(s.x, s.z, loops));
            solarReport.inside += inside.length;
            const flat = inside.filter(({ s }) => s.pitchDeg < MIN_PITCHED_DEG);
            const flatArea = flat.reduce((a, { s }) => a + s.areaM2, 0);
            let solarY: number | undefined;
            if (flat.length) {
                // area-weighted median of the flat facets' heights
                const sorted = [...flat].sort((u, v) => u.s.y - v.s.y);
                let acc = 0;
                for (const { s } of sorted) { acc += s.areaM2; if (acc >= flatArea / 2) { solarY = s.y; break; } }
            }
            const agree = (y: number | undefined) => y !== undefined && scanY !== undefined && Math.abs(y - scanY) <= HEIGHT_AGREEMENT_M;
            let topY: number, heightSource: MassingPart['heightSource'];
            if (agree(solarY)) { topY = solarY!; heightSource = 'solar'; solarReport.flatUsed += flat.length; flat.forEach(f => usedSolar.add(f.k)); }
            else if (agree(vectorY)) { topY = vectorY!; heightSource = 'vector'; }
            else if (scanY !== undefined) {
                topY = scanY; heightSource = 'scan';
                notes.push(`part ${id}: height from the scan (${(scanY - inp.groundY).toFixed(1)} m); vector ${vectorY !== undefined ? (vectorY - inp.groundY).toFixed(1) + ' m' : 'none'}, Solar ${solarY !== undefined ? (solarY - inp.groundY).toFixed(1) + ' m' : 'none'} disagreed by more than ${HEIGHT_AGREEMENT_M} m`);
            } else if (vectorY !== undefined) { topY = vectorY; heightSource = 'vector'; }
            else if (solarY !== undefined) { topY = solarY; heightSource = 'solar'; }
            else { notes.push(`part ${id}: no height from the vector data, Solar or the scan; left out`); continue; }
            const part: MassingPart = { id, baseY, topY, loops, planes: [], heightSource, heights: { ...(vectorY !== undefined ? { vectorY } : {}), ...(solarY !== undefined ? { solarY } : {}), ...(scanY !== undefined ? { scanY } : {}) } };
            // pitched facets: kept one by one (largest first) while each lowers the roof's error against the scan
            const pitched = inside.filter(({ s }) => s.pitchDeg >= MIN_PITCHED_DEG).sort((u, v) => v.s.areaM2 - u.s.areaM2);
            const fitPitched = (target: MassingPart, pts: Vec2[]) => {
                if (!pitched.length || !pts.length) return;
                const ridge = quantile(pts.map(([x, z]) => inp.scanTop(x, z)), 0.97);
                const capped = { ...target, topY: Number.isFinite(ridge) ? Math.max(ridge, target.topY) : target.topY };
                const err = (q: Pick<MassingPart, 'topY' | 'baseY' | 'planes'>) => median(pts.map(([x, z]) => Math.abs(roofAt(q, x, z) - inp.scanTop(x, z))));
                let cur = err(target);
                for (const { s, k } of pitched) {
                    const trial = { ...capped, planes: [...capped.planes, solarPlane(s)] };
                    const e = err(trial);
                    if (e < cur * 0.95 && e < 1.5) { capped.planes = trial.planes; cur = e; solarReport.pitchedKept++; usedSolar.add(k); }
                    else solarReport.pitchedRejected++;
                }
                if (capped.planes.length) { target.planes = capped.planes; target.topY = capped.topY; }
            };
            // a single flat vector footprint can still hide a stepped/setback building (Google's 2.5D tiles rarely carry
            // more than one ring per building); the scan's own heightfield already in hand (scanTop) is read one step
            // further here for a real plan-area step, and only replaces the flat part when one is found - see
            // "stepped massing from the scan's own heightfield" above
            const tiers = heightSource === 'scan' || agree(vectorY) || agree(solarY) ? detectHeightTiers(loops, inp.scanTop, baseY) : undefined;
            if (tiers) {
                for (const [ti, tier] of tiers.entries()) {
                    const tierPart: MassingPart = {
                        id: `${id}/t${ti}`, baseY: tier.baseY, topY: tier.topY, loops: [tier.loop], planes: [],
                        heightSource: 'scan', heights: { scanY: tier.topY },
                    };
                    if (ti === tiers.length - 1) fitPitched(tierPart, samplesIn([tier.loop]).filter(([x, z]) => Number.isFinite(inp.scanTop(x, z))));
                    parts.push(tierPart);
                }
                notes.push(`part ${id}: ${tiers.length} stepped tiers detected from the scan's heightfield (floors at ${tiers.map(t => (t.baseY - inp.groundY).toFixed(1)).join(', ')} m) in place of one flat part`);
                continue;
            }
            fitPitched(part, samples.filter(([x, z]) => Number.isFinite(inp.scanTop(x, z))));
            parts.push(part);
        }
    }
    return { parts, meshes, notes, solar: solarReport, check: checkMassing(parts, meshes, inp) };
}

/** The massing's plan against the scan's structure cells (IoU) and its roof against the scan's top (median, 90th percentile). */
export function checkMassing(parts: MassingPart[], meshes: MassingMesh[], inp: Pick<MassingInputs, 'groundY' | 'scanTop' | 'cells'>): MassingCheck {
    // the check against the scan
    const massingTop = new Map<string, number>();
    for (const p of parts) {
        for (const [x, z] of samplesIn(p.loops)) {
            const k = `${Math.floor(x)},${Math.floor(z)}`;
            massingTop.set(k, Math.max(massingTop.get(k) ?? -Infinity, roofAt(p, x, z)));
        }
    }
    for (const m of meshes) for (const [k, y] of meshTopCells(m)) massingTop.set(k, Math.max(massingTop.get(k) ?? -Infinity, y));
    let inter = 0;
    const errs: number[] = [];
    const heights: number[] = [];
    for (const k of massingTop.keys()) {
        if (!inp.cells.has(k)) continue;
        inter++;
        const [x, z] = k.split(',').map(Number);
        const top = inp.scanTop(x + 0.5, z + 0.5);
        if (Number.isFinite(top)) { errs.push(Math.abs(massingTop.get(k)! - top)); heights.push(top - inp.groundY); }
    }
    const union = massingTop.size + inp.cells.size - inter;
    const iou = union ? inter / union : 0;
    const hMed = median(errs), hP90 = quantile(errs, 0.9);
    const limit = Math.max(MAX_HEIGHT_ERROR_M, MAX_HEIGHT_ERROR_SHARE * (Number.isFinite(median(heights)) ? median(heights) : 0));
    const r2 = (v: number) => Math.round(v * 100) / 100;
    let reason: string | undefined;
    if (!massingTop.size) reason = 'the vector data hold no extruded part or modelled volume for the building';
    else if (iou < MIN_MASSING_IOU) reason = `the massing's plan agrees with the scan's structure on ${r2(iou)} (intersection over union; at least ${MIN_MASSING_IOU} needed)`;
    else if (!(hMed <= limit)) reason = `the massing's roof is ${r2(hMed)} m off the scan's (median; at most ${r2(limit)} m allowed)`;
    return { iou: r2(iou), heightErrMedianM: r2(hMed), heightErrP90M: r2(hP90), massingCells: massingTop.size, scanCells: inp.cells.size, ok: !reason, ...(reason ? { reason } : {}) };
}

// ------------------------------------------------------------------------------------------------
// the native spec
// ------------------------------------------------------------------------------------------------

export interface SweepItem {
    id: string; confidence: number; provenance: string; profile: Array<[number, number]>; faces: string[];
    /** The profile's heights are above each wall's own top (a parapet on a sloping or stepped roof), not absolute y. */
    relativeToTop?: boolean;
}
export interface OpeningItem { id: string; face: string; s0: number; s1: number; t0: number; t1: number; depth: number; scanned: boolean; confidence: number; provenance: string }
/**
 * A profile swept along one axis of a face's own frame (scratchbox_staged_massing.hpp FaceSweepSpec): axis 0 along s with the
 * profile in (offset, t), 1 along t with it in (offset, s); offset(c) >= 0 at increasing c; each placement [a0, a1, dc]
 * sweeps it from a0 to a1 with c shifted by dc, capped.
 */
export interface FaceSweepItem { id: string; confidence: number; provenance: string; face: string; axis: 0 | 1; profile: Array<[number, number]>; placements: Array<[number, number, number]> }

const tok = (s: string) => s.replace(/\s+/g, '_') || '_';
const n6 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(6)).toString() : '0');

/** The spec text scripts/staged_massing.cpp reads (scratchbox_staged_massing.hpp readSpec). */
export function massingSpecText(m: Pick<Massing, 'parts' | 'meshes'>, opts: {
    outDir: string; tile?: string; isolate?: string; params?: Record<string, number>;
    sweeps?: SweepItem[]; openings?: OpeningItem[]; faceSweeps?: FaceSweepItem[]; provenance?: string;
}): string {
    const L: string[] = ['# scratchbox staged massing spec v1'];
    if (opts.tile) L.push(`tile ${opts.tile}`);
    if (opts.isolate) L.push(`isolate ${opts.isolate}`);
    L.push(`out ${opts.outDir}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) L.push(`param ${k} ${n6(v)}`);
    const prov = tok(opts.provenance ?? 'massing');
    for (const p of m.parts) {
        L.push(`part ${tok(p.id)} ${n6(p.baseY)} ${n6(p.topY)} ${p.provenance ? tok(p.provenance) : prov}`);
        for (const l of p.loops) L.push(`loop ${l.length} ${l.map(([x, z]) => `${n6(x)} ${n6(z)}`).join(' ')}`);
        for (const pl of p.planes) L.push(`plane ${n6(pl.a)} ${n6(pl.b)} ${n6(pl.c)} ${tok(pl.tag)}`);
    }
    for (const mesh of m.meshes) {
        L.push(`mesh ${tok(mesh.id)} ${mesh.vertices.length} ${mesh.indices.length / 3} ${mesh.provenance ? tok(mesh.provenance) : prov}`);
        for (const [x, y, z] of mesh.vertices) L.push(`v ${n6(x)} ${n6(y)} ${n6(z)}`);
        for (let i = 0; i + 2 < mesh.indices.length; i += 3) L.push(`t ${mesh.indices[i]} ${mesh.indices[i + 1]} ${mesh.indices[i + 2]}`);
    }
    for (const s of opts.sweeps ?? []) L.push(`sweep ${tok(s.id)} ${n6(s.confidence)} ${tok(s.provenance)} ${s.profile.length} ${s.profile.map(([o, y]) => `${n6(o)} ${n6(y)}`).join(' ')} ${s.faces.length} ${s.faces.map(tok).join(' ')}${s.relativeToTop ? ' top' : ''}`);
    for (const w of opts.faceSweeps ?? []) L.push(`facesweep ${tok(w.id)} ${n6(w.confidence)} ${tok(w.provenance)} ${tok(w.face)} ${w.axis} ${w.profile.length} ${w.profile.map(([o, c]) => `${n6(o)} ${n6(c)}`).join(' ')} ${w.placements.length} ${w.placements.map(q => q.map(n6).join(' ')).join(' ')}`);
    for (const o of opts.openings ?? []) L.push(`opening ${tok(o.id)} ${tok(o.face)} ${n6(o.s0)} ${n6(o.s1)} ${n6(o.t0)} ${n6(o.t1)} ${n6(o.depth)} ${o.scanned ? 1 : 0} ${n6(o.confidence)} ${tok(o.provenance)}`);
    return L.join('\n') + '\n';
}
