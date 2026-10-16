/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Synthetic photogrammetric scans of single structures, with the truth they were built from. Like a tile, each is a
 * set of large flat faces (no interior, no underside where nothing was seen), every vertex carries 1.5 cm of noise, and a
 * ground apron surrounds it. The scenes:
 *
 *   segmentalArch   two piers carrying a block over a segmental opening, a cornice slab and a parapet, turned by a yaw
 *   arcade          a slab on four round columns at an equal pitch (three bays), turned
 *   lPlan           an L-shaped plan in two bands, the upper one carrying a projecting cornice band
 *   triangle        a triangular plan (no right angle anywhere)
 *   plaza           two blocks either side of a plaza, the anchor between them
 *   treeTouching    a block with a tree crown against one wall
 *
 * Coordinates are the tile frame: x east, y up, z south, metres; every scan stands on y = 0 with the anchor at the origin.
 */

import * as path from 'path';
import { encodePng, writeGlb, type Chunk, type V3 } from './synthetic-scan-glb';

/** A deterministic generator (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type P2 = [number, number];

export interface SyntheticScan {
    name: string;
    /** The untextured scan (what tile_refine's isolate would hand the fitter). */
    glb: string;
    /** The same scan with a photo texture, when the scene has one. */
    textured?: string;
    anchor: P2;
    truth: Record<string, number | number[] | string>;
}

class Scene {
    chunks: Chunk[] = [];
    private rand: () => number;
    constructor(private readonly seed: number, private readonly yawDeg: number, private readonly sigma = 0.015) { this.rand = rng(seed); }

    private gauss(): number { return Math.sqrt(-2 * Math.log(Math.max(1e-12, this.rand()))) * Math.cos(2 * Math.PI * this.rand()); }

    /** The noise at a position: a function of the position alone, so faces that meet at a vertex still meet there (one mesh). */
    private noiseAt(p: V3, axis: number): number {
        const h = rng(Math.imul(Math.round(p[0] * 1000) | 0, 73856093) ^ Math.imul(Math.round(p[1] * 1000) | 0, 19349663) ^ Math.imul(Math.round(p[2] * 1000) | 0, 83492791) ^ (axis * 2654435761) ^ this.seed);
        h();
        return this.sigma * Math.sqrt(-2 * Math.log(Math.max(1e-12, h()))) * Math.cos(2 * Math.PI * h());
    }

    /** A local point (x, y, z) turned by the yaw about the vertical axis through the origin. */
    private world(p: V3): V3 {
        const a = (this.yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
    }

    /** Adds a chunk from local positions and indices: turned, with noise on every vertex. */
    add(positions: V3[], indices: number[], noise = true): void {
        const out: number[] = [];
        for (const p of positions) {
            const w = this.world(p);
            for (let k = 0; k < 3; k++) out.push(w[k] + (noise ? this.noiseAt(p, k) : 0));
        }
        this.chunks.push({ positions: out, indices });
    }

    /** A flat polygon (local x, z at height y) as triangles by ear clipping; `up` is the side it faces. */
    polygon(poly: P2[], y: number, up: boolean, n = 1): void {
        const pts = this.subdivide(poly, n);
        const idx = earClip(pts);
        const area = pts.reduce((s, p, i) => s + (p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1]), 0);
        const positions: V3[] = pts.map(p => [p[0], y, p[1]]);
        // earClip returns triangles counter-clockwise in (x, z); the up normal of (a, b, c) is (b - a) x (c - a) . y
        const flipIt = (area > 0) === up ? false : true;
        const tri = idx.slice();
        for (let t = 0; t < tri.length; t += 3) {
            const [a, b, c] = [positions[tri[t]], positions[tri[t + 1]], positions[tri[t + 2]]];
            const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
            if ((ny > 0) !== up) { const tmp = tri[t + 1]; tri[t + 1] = tri[t + 2]; tri[t + 2] = tmp; }
        }
        void flipIt;
        this.add(positions, tri);
    }

    private subdivide(poly: P2[], n: number): P2[] {
        return poly;
        void n;
    }

    /** A vertical face over the local segment a to b from y0 to y1, facing `outward` (a point on the side it looks at). */
    wall(a: P2, b: P2, y0: number, y1: number, outward: P2, cell = 3): void {
        let [p, q] = [a, b];
        const nz = (q[0] - p[0]), nx = -(q[1] - p[1]);  // the normal of o = p, u = q - p, v = up is (-dz, 0, dx)
        const mid: P2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (nx * (outward[0] - mid[0]) + nz * (outward[1] - mid[1]) < 0) [p, q] = [q, p];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const nu = Math.max(1, Math.ceil(len / cell)), nv = Math.max(1, Math.ceil((y1 - y0) / cell));
        const positions: V3[] = [], indices: number[] = [];
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) positions.push([p[0] + ((q[0] - p[0]) * i) / nu, y0 + ((y1 - y0) * j) / nv, p[1] + ((q[1] - p[1]) * i) / nu]);
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a0 = j * (nu + 1) + i, b0 = a0 + 1, c0 = a0 + nu + 1, d0 = c0 + 1; indices.push(a0, b0, d0, a0, d0, c0); }
        this.add(positions, indices);
    }

    /** A prism over a polygon: its walls facing out and its roof; `underside` adds the face looking down (an overhang's). */
    prism(poly: P2[], y0: number, y1: number, underside = false, cell = 3): void {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
            const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
            // the side of the edge that is not inside the polygon (a concave plan has no centre to measure from)
            const n: P2 = [-dz / l, dx / l];
            const outward: P2 = pointInPolygon([mx + n[0] * 0.05, mz + n[1] * 0.05], poly) ? [mx - n[0], mz - n[1]] : [mx + n[0], mz + n[1]];
            this.wall(a, b, y0, y1, outward, cell);
        }
        this.polygon(poly, y1, true);
        if (underside) this.polygon(poly, y0, false);
    }

    /** A solid of revolution about a vertical axis: a closed r(y) profile, `seg` sides (no base). */
    column(c: P2, r: number, y0: number, y1: number, seg = 28): void {
        const positions: V3[] = [], indices: number[] = [];
        const rows = Math.max(1, Math.ceil((y1 - y0) / 2.5));
        for (let j = 0; j <= rows; j++) for (let i = 0; i <= seg; i++) {
            const t = (2 * Math.PI * i) / seg;
            positions.push([c[0] + r * Math.cos(t), y0 + ((y1 - y0) * j) / rows, c[1] + r * Math.sin(t)]);
        }
        for (let j = 0; j < rows; j++) for (let i = 0; i < seg; i++) {
            const a = j * (seg + 1) + i, b = a + 1, c0 = a + seg + 1, d = c0 + 1;
            // the normal of (a, b, d): (b - a) x (d - a); pointing out of the axis
            indices.push(a, d, b, a, c0, d);
        }
        // orient outward: check the first triangle against the radial direction
        const p = (k: number) => positions[indices[k]];
        const n = cross(sub(p(1), p(0)), sub(p(2), p(0)));
        const radial: V3 = [positions[indices[0]][0] - c[0], 0, positions[indices[0]][2] - c[1]];
        if (n[0] * radial[0] + n[2] * radial[2] < 0) for (let t = 0; t < indices.length; t += 3) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
        this.add(positions, indices);
    }

    /** A blob (a tree crown): a squashed sphere, outward. */
    blob(c: V3, rx: number, ry: number, rz: number, seg = 18): void {
        const positions: V3[] = [], indices: number[] = [];
        for (let j = 0; j <= seg; j++) for (let i = 0; i <= 2 * seg; i++) {
            const th = (Math.PI * j) / seg, ph = (Math.PI * i) / seg;
            positions.push([c[0] + rx * Math.sin(th) * Math.cos(ph), c[1] + ry * Math.cos(th), c[2] + rz * Math.sin(th) * Math.sin(ph)]);
        }
        for (let j = 0; j < seg; j++) for (let i = 0; i < 2 * seg; i++) {
            const a = j * (2 * seg + 1) + i, b = a + 1, c0 = a + 2 * seg + 1, d = c0 + 1;
            indices.push(a, b, d, a, d, c0);
        }
        const n = cross(sub(positions[indices[1]], positions[indices[0]]), sub(positions[indices[2]], positions[indices[0]]));
        const outward = sub(positions[indices[0]], c);
        if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) for (let t = 0; t < indices.length; t += 3) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
        this.add(positions, indices);
    }

    /**
     * The ground apron: a band of up-facing quads `m` metres wide along every edge of a footprint, its inner corners the
     * footprint's own vertices, so the ground and the walls that stand on it are one welded mesh.
     */
    apron(poly: P2[], m = 4, pieces = 1): void {
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
            let n: P2 = [-dz / l, dx / l];
            const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            if (pointInPolygon([mid[0] + n[0] * 0.05, mid[1] + n[1] * 0.05], poly)) n = [-n[0], -n[1]];
            this.polygon([a, b, [b[0] + n[0] * m, b[1] + n[1] * m], [a[0] + n[0] * m, a[1] + n[1] * m]], 0, true, pieces);
        }
    }

    save(file: string): void { writeGlb(file, this.chunks); }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function pointInPolygon(p: P2, poly: P2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Ear clipping of a simple polygon (x, z), counter-clockwise or clockwise; triangles as index triples. */
function earClip(pts: P2[]): number[] {
    const n = pts.length;
    const area = pts.reduce((s, p, i) => s + (p[0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * p[1]), 0);
    const idx = [...Array(n).keys()];
    if (area < 0) idx.reverse();
    const out: number[] = [];
    const cr = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
        let clipped = false;
        for (let i = 0; i < idx.length; i++) {
            const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
            if (cr(pts[a], pts[b], pts[c]) <= 1e-12) continue;
            let inside = false;
            for (const q of idx) {
                if (q === a || q === b || q === c) continue;
                const d1 = cr(pts[a], pts[b], pts[q]), d2 = cr(pts[b], pts[c], pts[q]), d3 = cr(pts[c], pts[a], pts[q]);
                if (d1 >= 0 && d2 >= 0 && d3 >= 0) { inside = true; break; }
            }
            if (inside) continue;
            out.push(a, b, c);
            idx.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped) break;
    }
    if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
    return out;
}

/** A circular arc's points from angle a0 to a1 (radians) about (cx, cy), n + 1 of them. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): P2[] {
    const out: P2[] = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
}

/** A texture of vertical stripes and a circle, so the photo has contrast where the scene has detail (and none elsewhere). */
function stripedPng(size = 256, stripePx = 16, blank = false): Buffer {
    const rgb = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const stripe = !blank && Math.floor(x / stripePx) % 2 === 0;
        const v = blank ? 170 : stripe ? 210 : 120;
        rgb.set([v, v, v], (y * size + x) * 3);
    }
    return encodePng(size, size, rgb);
}

// ------------------------------------------------------------------------------------------------------------------

/** The elevation polygon of a block over an opening: (s, y), counter-clockwise, the notch an arc through (sL, yL) and (sR, yR). */
function elevationWithArch(sMin: number, sMax: number, y1: number, sL: number, sR: number, spring: number, rise: number): P2[] {
    const half = (sR - sL) / 2, r = (half * half + rise * rise) / (2 * rise), cy = spring + rise - r, cx = (sL + sR) / 2;
    const a0 = Math.atan2(spring - cy, sL - cx), a1 = Math.atan2(spring - cy, sR - cx);
    const e: P2[] = [[sMin, 0], [sL, 0], [sL, spring]];
    // the arc from the left springing over the top to the right springing (a0 > a1: clockwise in (s, y))
    for (const p of arc(cx, cy, r, a0, a1, 40).slice(1, -1)) e.push(p);
    e.push([sR, spring], [sR, 0], [sMax, 0], [sMax, y1], [sMin, y1]);
    return e;
}

export function segmentalArch(dir: string, yawDeg = 33): SyntheticScan {
    const span = 8.0, pier = 3.2, depth = 5.0, spring = 8.0, rise = 3.0, h = 14.0;
    const sMin = -(span / 2 + pier), sMax = span / 2 + pier;
    const sc = new Scene(11, yawDeg);
    const t0 = -depth / 2, t1 = depth / 2;
    const E = elevationWithArch(sMin, sMax, h, -span / 2, span / 2, spring, rise);
    // the elevation faces (front and back), each a polygon in (s, y) at constant t
    const face = (t: number, front: boolean) => {
        const idx = earClip(E);
        const positions: V3[] = E.map(p => [p[0], p[1], t]);
        for (let k = 0; k < idx.length; k += 3) {
            const [a, b, c] = [positions[idx[k]], positions[idx[k + 1]], positions[idx[k + 2]]];
            const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);  // the (x, y) winding: + faces +z
            if ((nz > 0) !== front) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
        }
        sc.add(positions, idx);
    };
    face(t1, true);
    face(t0, false);
    // the opening's jambs and soffit, and the piers' ends and roof
    sc.wall([-span / 2, t0], [-span / 2, t1], 0, spring, [0, 0]);
    sc.wall([span / 2, t0], [span / 2, t1], 0, spring, [0, 0]);
    {
        const half = span / 2, r = (half * half + rise * rise) / (2 * rise), cy = spring + rise - r;
        const a0 = Math.atan2(spring - cy, -half), a1 = Math.atan2(spring - cy, half);
        const pts = arc(0, cy, r, a0, a1, 40);
        const positions: V3[] = [], indices: number[] = [];
        for (const p of pts) { positions.push([p[0], p[1], t0]); positions.push([p[0], p[1], t1]); }
        for (let i = 0; i + 1 < pts.length; i++) { const a = 2 * i, b = a + 1, c = a + 2, d = a + 3; indices.push(a, c, d, a, d, b); }
        // the soffit looks down into the opening: its normal points toward the arc's centre
        const n = cross(sub(positions[indices[1]], positions[indices[0]]), sub(positions[indices[2]], positions[indices[0]]));
        if (n[1] > 0) for (let t = 0; t < indices.length; t += 3) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
        sc.add(positions, indices);
    }
    sc.wall([sMin, t0], [sMin, t1], 0, h, [sMin - 1, 0]);
    sc.wall([sMax, t0], [sMax, t1], 0, h, [sMax + 1, 0]);
    sc.polygon([[sMin, t0], [sMax, t0], [sMax, t1], [sMin, t1]], h, true);
    sc.apron([[sMin, t0], [sMax, t0], [sMax, t1], [sMin, t1]]);
    const glb = path.join(dir, 'synthetic_arch.glb');
    sc.save(glb);
    const springY = spring;
    return { name: 'segmental arch', glb, anchor: [0, 0], truth: { spanM: span, pierWidthM: pier, depthM: depth, springingM: springY, riseM: rise, riseToSpan: rise / span, heightM: h, yawDeg, widthM: sMax - sMin } };
}

export function arcade(dir: string, yawDeg = 21): SyntheticScan {
    const r = 0.45, pitch = 3.6, n = 4, h = 5.0, slabT = 0.6, depth = 3.0;
    const x0 = -((n - 1) * pitch) / 2;
    const sc = new Scene(23, yawDeg);
    const centres: P2[] = [];
    for (let i = 0; i < n; i++) centres.push([x0 + i * pitch, 0]);
    for (const c of centres) sc.column(c, r, 0, h);
    const sx0 = x0 - 0.9, sx1 = -x0 + 0.9;
    sc.prism([[sx0, -depth / 2], [sx1, -depth / 2], [sx1, depth / 2], [sx0, depth / 2]], h, h + slabT, true);
    sc.apron([[sx0, -depth / 2], [sx1, -depth / 2], [sx1, depth / 2], [sx0, depth / 2]]);
    const glb = path.join(dir, 'synthetic_arcade.glb');
    sc.save(glb);
    return { name: 'three-bay arcade', glb, anchor: [0, 0], truth: { columns: n, pitchM: pitch, radiusM: r, heightM: h, slabThicknessM: slabT, yawDeg } };
}

export function lPlan(dir: string, yawDeg = 12): SyntheticScan {
    // an L: 20 x 10 with a 10 x 10 corner removed; two bands (0..9, 9..14), a cornice band projecting 0.8 m at 9..9.4
    const L: P2[] = [[-10, -5], [10, -5], [10, 5], [0, 5], [0, 15], [-10, 15]];
    const sc = new Scene(37, yawDeg);
    sc.prism(L, 0, 9);
    // the cornice slab: the plan grown by 0.8 m (offset by hand: the corners pushed along their diagonals)
    const g = 0.8;
    const C: P2[] = [[-10 - g, -5 - g], [10 + g, -5 - g], [10 + g, 5 + g], [0 + g, 5 + g], [0 + g, 15 + g], [-10 - g, 15 + g]];
    sc.prism(C, 9, 9.4, true);
    // the band above is the plan itself again
    sc.prism(L, 9.4, 14);
    sc.apron(L, 3);
    const glb = path.join(dir, 'synthetic_lplan.glb');
    sc.save(glb);
    return { name: 'L-plan with a cornice band', glb, anchor: [5, 0], truth: { areaM2: 20 * 10 + 10 * 10, heightM: 14, corniceBottomM: 9, corniceTopM: 9.4, corniceProjectionM: g, vertices: 6, yawDeg } };
}

export function triangle(dir: string, yawDeg = 0): SyntheticScan {
    const T: P2[] = [[-8, -6], [9, -3], [-2, 11]];
    const sc = new Scene(41, yawDeg);
    sc.prism(T, 0, 11);
    sc.apron(T, 3);
    const glb = path.join(dir, 'synthetic_triangle.glb');
    sc.save(glb);
    const area = Math.abs((T[1][0] - T[0][0]) * (T[2][1] - T[0][1]) - (T[2][0] - T[0][0]) * (T[1][1] - T[0][1])) / 2;
    return { name: 'triangular plan', glb, anchor: [0, 0], truth: { areaM2: area, vertices: 3, heightM: 11 } };
}

export function plaza(dir: string, yawDeg = 0): SyntheticScan {
    // two blocks 18 m apart; the geocoded anchor stands in the plaza, nearer the east block
    const west: P2[] = [[-24, -8], [-8, -8], [-8, 8], [-24, 8]], east: P2[] = [[10, -6], [24, -6], [24, 6], [10, 6]];
    const sc = new Scene(53, yawDeg);
    sc.prism(west, 0, 18);
    sc.prism(east, 0, 12);
    sc.apron(west, 3);
    sc.apron(east, 3);
    const glb = path.join(dir, 'synthetic_plaza.glb');
    sc.save(glb);
    return { name: 'two blocks around a plaza', glb, anchor: [4, 0], truth: { westAreaM2: 16 * 16, eastAreaM2: 14 * 12, westHeightM: 18, eastHeightM: 12 } };
}

export function treeTouching(dir: string, yawDeg = 0): SyntheticScan {
    const B: P2[] = [[-7, -5], [7, -5], [7, 5], [-7, 5]];
    const sc = new Scene(67, yawDeg);
    sc.prism(B, 0, 10);
    sc.blob([9.2, 6.0, 0], 3.4, 3.6, 3.4);
    sc.apron(B, 3);
    const glb = path.join(dir, 'synthetic_tree.glb');
    sc.save(glb);
    return { name: 'block with a tree crown against it', glb, anchor: [0, 0], truth: { areaM2: 14 * 10, heightM: 10 } };
}

/**
 * A block with scan-melt fragments standing on its apron: three thin upright shards, 0.9 m tall and 0.5 m wide, 2 m from the wall,
 * their feet on the apron's own (welded) vertices, 0.11 m2 each (a tile's melt leaves nothing as large as the 0.25 m2 under which no attachment is built), so they belong to the scan's one mesh as they do in a tile. Nothing the fit
 * builds explains them (they are not part of the block), and they are too small to be a structure of their own.
 */
export function blockWithFragments(dir: string): SyntheticScan & { fragments: Array<{ lo: V3; hi: V3 }> } {
    const B: P2[] = [[-7, -5], [7, -5], [7, 5], [-7, 5]];
    const sc = new Scene(71, 0);
    sc.prism(B, 0, 10);
    sc.apron(B, 2, 28);
    const fragments: Array<{ lo: V3; hi: V3 }> = [];
    for (const x0 of [-4, 0, 4]) {
        // the apron's outer edge on the +z side is at z = 7, its vertices half a metre apart: a shard stands on two of them
        sc.add([[x0, 0, 7], [x0 + 0.5, 0, 7], [x0 + 0.25, 0.9, 7]], [0, 1, 2]);
        fragments.push({ lo: [x0, 0, 7], hi: [x0 + 0.5, 0.9, 7] });
    }
    const glb = path.join(dir, 'synthetic_fragments.glb');
    sc.save(glb);
    return { name: 'block with scan-melt fragments on its apron', glb, anchor: [0, 0], truth: { areaM2: 14 * 10, heightM: 10, fragments: 3 }, fragments };
}

/**
 * A segmental arch's textured twin: its elevation faces carry a photo (vertical stripes, or blank), so a test can tell what
 * the photo shows. Only the two elevation faces are textured; the rest is the plain scan.
 */
export function texturedFacade(dir: string, blank: boolean): { glb: string; textured: string; anchor: P2; widthM: number; heightM: number } {
    // a single 20 x 10 facade facing +z, textured over its whole face, in front of a ground apron
    const sc = new Scene(71, 0, 0.0);
    sc.prism([[-10, -1], [10, -1], [10, 1], [-10, 1]], 0, 10);
    sc.apron([[-10, -1], [10, -1], [10, 1], [-10, 1]], 3);
    const glb = path.join(dir, `facade_${blank ? 'blank' : 'stripes'}.glb`);
    sc.save(glb);
    // the textured twin: the same scan with the +z wall replaced by one carrying the texture
    const twin = new Scene(71, 0, 0.0);
    twin.wall([-10, -1], [10, -1], 0, 10, [0, -9]);
    twin.wall([-10, -1], [-10, 1], 0, 10, [-20, 0]);
    twin.wall([10, -1], [10, 1], 0, 10, [20, 0]);
    twin.polygon([[-10, -1], [10, -1], [10, 1], [-10, 1]], 10, true);
    twin.apron([[-10, -1], [10, -1], [10, 1], [-10, 1]], 3);
    const front: Chunk = { positions: [], indices: [] };
    const nu = 8, nv = 4;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) front.positions.push(-10 + (20 * i) / nu, (10 * j) / nv, 1);
    front.uvs = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) front.uvs.push((i / nu) * 4, 1 - j / nv);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; front.indices.push(a, b, d, a, d, c); }
    front.image = 0;
    const textured = path.join(dir, `facade_${blank ? 'blank' : 'stripes'}_textured.glb`);
    writeGlb(textured, [front, ...twin.chunks], [stripedPng(256, 16, blank)]);
    return { glb, textured, anchor: [0, 0], widthM: 20, heightM: 10 };
}
