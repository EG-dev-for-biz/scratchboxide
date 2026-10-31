/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Point queries against a triangle soup (9 floats a triangle): whether a point lies on the surface (the photo-match judge's
 * onSurfaceFlags and surfaceCoverShare), and the label of the nearest labelled triangle (a splat world labelled by the
 * judge's region labels of the tile it was built on, splat-arm-render.ts).
 */

/** Triangles as 9 floats each (TileTriangles and any other soup). */
export interface TriangleSoup { positions: ArrayLike<number> }

/** Squared distance from p to the triangle (a, b, c) at `o` in P (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDist2(P: ArrayLike<number>, o: number, px: number, py: number, pz: number): number {
    const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d2 = (x: number, y: number, z: number) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    const d1 = abx * apx + aby * apy + abz * apz, e1 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && e1 <= 0) return d2(ax, ay, az);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, e3 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && e3 <= d3) return d2(bx, by, bz);
    const vc = d1 * e3 - d3 * e1;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d2(ax + v * abx, ay + v * aby, az + v * abz); }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d6 = abx * cpx + aby * cpy + abz * cpz, e6 = acx * cpx + acy * cpy + acz * cpz;
    if (e6 >= 0 && d6 <= e6) return d2(cx, cy, cz);
    const vb = d6 * e1 - d1 * e6;
    if (vb <= 0 && e1 >= 0 && e6 <= 0) { const w = e1 / (e1 - e6); return d2(ax + w * acx, ay + w * acy, az + w * acz); }
    const va = d3 * e6 - d6 * e3;
    if (va <= 0 && e3 - d3 >= 0 && d6 - e6 >= 0) { const w = (e3 - d3) / (e3 - d3 + d6 - e6); return d2(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return d2(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** A point query against triangles: whether a point lies within `tol` of any of them (a uniform grid over their bounds). */
export function surfaceIndex(t: TriangleSoup, tol: number, keep?: Uint8Array): (x: number, y: number, z: number) => boolean {
    const CELL = 2, grid = new Map<string, number[]>(), P = t.positions;
    const cell = (v: number) => Math.floor(v / CELL);
    const n = Math.floor(P.length / 9);
    for (let i = 0; i < n; i++) {
        if (keep && !keep[i]) continue;
        const o = i * 9, lo = [0, 1, 2].map(k => cell(Math.min(P[o + k], P[o + 3 + k], P[o + 6 + k]) - tol)), hi = [0, 1, 2].map(k => cell(Math.max(P[o + k], P[o + 3 + k], P[o + 6 + k]) + tol));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const k = `${x},${y},${z}`, list = grid.get(k);
            if (list) list.push(o); else grid.set(k, [o]);
        }
    }
    const tol2 = tol * tol;
    return (x, y, z) => !!grid.get(`${cell(x)},${cell(y)},${cell(z)}`)?.some(o => pointTriangleDist2(P, o, x, y, z) <= tol2);
}

/**
 * The label of the nearest triangle within `maxDist` of a point (point to triangle), or -1 when none is that near.
 * `labels` is one label for every triangle or one per triangle. A uniform grid of `cell` metres; each triangle is entered
 * in every cell within `maxDist` of its bounds, so one cell holds every candidate for a point in it.
 */
export function nearestLabelIndex(t: TriangleSoup, labels: number | ArrayLike<number>, maxDist: number, cell = 1): (x: number, y: number, z: number) => number {
    const P = t.positions, n = Math.floor(P.length / 9);
    const at = (v: number) => Math.floor(v / cell);
    // cells as one exact number: three 17-bit offsets around 2^16 (51 bits; +-65 km at 1 m cells)
    const key = (x: number, y: number, z: number) => ((x + 65536) * 131072 + (y + 65536)) * 131072 + (z + 65536);
    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const o = i * 9;
        const x0 = at(Math.min(P[o], P[o + 3], P[o + 6]) - maxDist), x1 = at(Math.max(P[o], P[o + 3], P[o + 6]) + maxDist);
        const y0 = at(Math.min(P[o + 1], P[o + 4], P[o + 7]) - maxDist), y1 = at(Math.max(P[o + 1], P[o + 4], P[o + 7]) + maxDist);
        const z0 = at(Math.min(P[o + 2], P[o + 5], P[o + 8]) - maxDist), z1 = at(Math.max(P[o + 2], P[o + 5], P[o + 8]) + maxDist);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            const k = key(x, y, z), list = grid.get(k);
            if (list) list.push(i); else grid.set(k, [i]);
        }
    }
    const max2 = maxDist * maxDist;
    const labelOf = typeof labels === 'number' ? () => labels : (i: number) => labels[i];
    return (x, y, z) => {
        const list = grid.get(key(at(x), at(y), at(z)));
        if (!list) return -1;
        let best = max2, label = -1;
        for (const i of list) {
            const d2 = pointTriangleDist2(P, i * 9, x, y, z);
            if (d2 <= best) { best = d2; label = labelOf(i); }
        }
        return label;
    };
}
