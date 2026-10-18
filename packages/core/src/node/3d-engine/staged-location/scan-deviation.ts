/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How far a fitted layer's surface stands from the scan, per atlas texel.
 *
 * The photos show the real surface, which the scan follows and a fitted solid only approximates (a flat face over carved relief,
 * a moulding fitted a few centimetres proud). A photo projected onto a fitted texel that is off the real surface lands where the
 * views disagree by parallax: each view paints the relief at a different place. For a texel farther than a tolerance from the
 * scan, the photos are therefore sampled at the scan's surface under it (its nearest scan point), where every view sees the same
 * thing, and the colour is carried to the fitted texel; one with no scan near it is not projected (tile photo or clay tier).
 * Exact point-to-triangle distance against the scan's triangles in a uniform grid.
 */

import type { UvAtlas } from '../../../common/spatial/texture-pass-contracts';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';

/** Tolerance (m) past which a fitted texel is off the scan: about the scan's own noise on a stone wall. */
export const FIT_SCAN_TOLERANCE_M = 0.08;
/** How far (m) under an off texel the scan's surface is looked for; farther, the texel has no scan to take the photos from. */
export const FIT_SCAN_SNAP_M = 0.6;

export interface ScanDeviation {
    /** 1 where the texel is farther than the tolerance from the scan (covered, non-gutter texels only). */
    off: Uint8Array;
    tolM: number;
    /** Texels checked, and those off the scan. */
    checked: number;
    offTexels: number;
    /** Distance (m) of the off texels from the scan (sampled, capped at `capM`): median and 95th percentile. */
    offMedianM: number | null;
    offP95M: number | null;
    capM: number;
    /**
     * For the off texels: the point of the scan under them (nearest scan point within `snapM`, the offset shared by 3 x 3 texel
     * blocks), where the photos show the surface; `noScan` marks off texels with no scan within `snapM` (an opening the fit closed,
     * a part the scan lacks).
     */
    onScan: Float32Array;
    noScan: Uint8Array;
    noScanTexels: number;
    snapM: number;
    ms: number;
}

type V3 = [number, number, number];

/** Squared distance from p to triangle (a, b, c) (Ericson, Real-Time Collision Detection 5.1.5). */
const CP: [number, number, number] = [0, 0, 0];
function pointTriangleDist2(px: number, py: number, pz: number, v: ArrayLike<number>, ia: number, ib: number, ic: number): number {
    const ax = v[ia], ay = v[ia + 1], az = v[ia + 2], bx = v[ib], by = v[ib + 1], bz = v[ib + 2], cx = v[ic], cy = v[ic + 1], cz = v[ic + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const q = (x: number, y: number, z: number) => { CP[0] = x; CP[1] = y; CP[2] = z; return (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2; };
    if (d1 <= 0 && d2 <= 0) return q(ax, ay, az);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return q(bx, by, bz);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return q(ax + t * abx, ay + t * aby, az + t * abz); }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return q(cx, cy, cz);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return q(ax + t * acx, ay + t * acy, az + t * acz); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return q(bx + t * (cx - bx), by + t * (cy - by), bz + t * (cz - bz)); }
    const den = 1 / (va + vb + vc), s = vb * den, t = vc * den;
    return q(ax + abx * s + acx * t, ay + aby * s + acy * t, az + abz * s + acz * t);
}

/** Triangles of a mesh binned in a uniform grid (a triangle goes in every cell its box touches). */
class TriangleGrid {
    private readonly cells = new Map<number, number[]>();
    private readonly big: number[] = [];
    constructor(readonly mesh: RenderMesh3D, readonly cell: number, readonly lo: V3) {
        const v = mesh.vertices, ix = mesh.indices;
        for (let t = 0; t < ix.length; t += 3) {
            const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
            const k0 = [0, 1, 2].map(k => Math.floor((Math.min(v[a + k], v[b + k], v[c + k]) - lo[k]) / cell));
            const k1 = [0, 1, 2].map(k => Math.floor((Math.max(v[a + k], v[b + k], v[c + k]) - lo[k]) / cell));
            if ((k1[0] - k0[0] + 1) * (k1[1] - k0[1] + 1) * (k1[2] - k0[2] + 1) > 4096) { this.big.push(t); continue; } // a huge triangle (a ground slab) is checked for every point
            for (let x = k0[0]; x <= k1[0]; x++) for (let y = k0[1]; y <= k1[1]; y++) for (let z = k0[2]; z <= k1[2]; z++) {
                const key = this.key(x, y, z);
                let l = this.cells.get(key);
                if (!l) { l = []; this.cells.set(key, l); }
                l.push(t);
            }
        }
    }
    key(x: number, y: number, z: number): number { return ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096); }
    /** Distance from p to the nearest triangle within `r` (r when none is nearer); the nearest point goes to `at` when given. */
    nearest(p: V3, r: number, at?: V3): number {
        const v = this.mesh.vertices, ix = this.mesh.indices, c = this.cell;
        const k0 = [0, 1, 2].map(k => Math.floor((p[k] - r - this.lo[k]) / c)), k1 = [0, 1, 2].map(k => Math.floor((p[k] + r - this.lo[k]) / c));
        let best = r * r;
        for (const t of this.big) { const d = pointTriangleDist2(p[0], p[1], p[2], v, ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3); if (d < best) { best = d; if (at) { at[0] = CP[0]; at[1] = CP[1]; at[2] = CP[2]; } } }
        for (let x = k0[0]; x <= k1[0]; x++) for (let y = k0[1]; y <= k1[1]; y++) for (let z = k0[2]; z <= k1[2]; z++) {
            const l = this.cells.get(this.key(x, y, z));
            if (!l) continue;
            for (const t of l) {
                const d = pointTriangleDist2(p[0], p[1], p[2], v, ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3);
                if (d < best) { best = d; if (at) { at[0] = CP[0]; at[1] = CP[1]; at[2] = CP[2]; } }
            }
        }
        return Math.sqrt(best);
    }
}

/** Per texel of a fitted layer's atlas: whether it stands farther than `tolM` from the scan, and how far the off ones are. */
export function measureScanDeviation(atlas: UvAtlas, scan: RenderMesh3D, tolM = FIT_SCAN_TOLERANCE_M, capM = 1, snapM = FIT_SCAN_SNAP_M): ScanDeviation {
    const t0 = Date.now();
    const n = atlas.width * atlas.height;
    const { covered, gutter, position } = atlas.texels;
    const off = new Uint8Array(n);
    const onScan = new Float32Array(n * 3), noScan = new Uint8Array(n);
    if (!scan.indices.length) return { off, tolM, checked: 0, offTexels: 0, offMedianM: null, offP95M: null, capM, onScan, noScan, noScanTexels: 0, snapM, ms: 0 };
    const lo: V3 = [Infinity, Infinity, Infinity];
    for (let i = 0; i < scan.vertices.length; i += 3) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], scan.vertices[i + k]);
    const near = new TriangleGrid(scan, Math.max(0.05, tolM), [lo[0] - 1, lo[1] - 1, lo[2] - 1]);
    let checked = 0, offTexels = 0;
    const offIdx: number[] = [];
    const p: V3 = [0, 0, 0];
    for (let t = 0; t < n; t++) {
        if (!covered[t] || gutter[t]) continue;
        checked++;
        p[0] = position[t * 3]; p[1] = position[t * 3 + 1]; p[2] = position[t * 3 + 2];
        if (near.nearest(p, tolM) >= tolM) { off[t] = 1; offTexels++; if ((offTexels & 7) === 0 || offTexels < 64) offIdx.push(t); }
    }
    // how far the off texels are (a sample, against a coarser grid)
    let offMedianM: number | null = null, offP95M: number | null = null;
    if (offIdx.length) {
        const far = new TriangleGrid(scan, 0.25, [lo[0] - 1, lo[1] - 1, lo[2] - 1]);
        const step = Math.max(1, Math.floor(offIdx.length / 3000));
        const d: number[] = [];
        for (let i = 0; i < offIdx.length; i += step) { const t = offIdx[i]; d.push(far.nearest([position[t * 3], position[t * 3 + 1], position[t * 3 + 2]], capM)); }
        d.sort((a, b) => a - b);
        offMedianM = Math.round(d[d.length >> 1] * 1000) / 1000;
        offP95M = Math.round(d[Math.min(d.length - 1, Math.floor(d.length * 0.95))] * 1000) / 1000;
    }
    // the scan under the off texels: one nearest-point query per 3 x 3 block of a map, its offset shared by the block's off texels
    let noScanTexels = 0;
    if (offTexels) {
        const snap = new TriangleGrid(scan, 0.2, [lo[0] - 1, lo[1] - 1, lo[2] - 1]);
        const W = atlas.width, { mapIndex } = atlas.texels;
        const blockOffset = new Map<number, V3 | null>();
        const at: V3 = [0, 0, 0];
        for (let t = 0; t < n; t++) {
            if (!off[t]) continue;
            const x = t % W, y = (t - x) / W;
            const key = (Math.floor(y / 3) * Math.ceil(W / 3) + Math.floor(x / 3)) * 65536 + mapIndex[t];
            let o = blockOffset.get(key);
            if (o === undefined) {
                p[0] = position[t * 3]; p[1] = position[t * 3 + 1]; p[2] = position[t * 3 + 2];
                o = snap.nearest(p, snapM, at) < snapM ? [at[0] - p[0], at[1] - p[1], at[2] - p[2]] : null;
                blockOffset.set(key, o);
            }
            if (!o) { noScan[t] = 1; noScanTexels++; continue; }
            for (let k = 0; k < 3; k++) onScan[t * 3 + k] = position[t * 3 + k] + o[k];
        }
    }
    return { off, tolM, checked, offTexels, offMedianM, offP95M, capM, onScan, noScan, noScanTexels, snapM, ms: Date.now() - t0 };
}
