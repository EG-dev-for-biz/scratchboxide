/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E: how much of a face of the solid faces open air. A modelled volume carries partitions inside it (the walls
 * between its parts), and a wall the tile does not see may be one of those or a real outside wall behind trees; only the
 * second is worth drawing. Points over the face (inside its polygon), a little off it along its normal, march rays over its
 * outward hemisphere through a voxel grid of the solid's own surfaces; a point from which any ray leaves the grid without
 * meeting one is exposed. Neighbouring buildings are not part of the solid: a party wall reads as exposed (its texture
 * is the realism-first directive's "surfaces no source covers").
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MassingFace, MassingNode } from './native-massing';

/** Voxel size of the solid's grid, metres. */
export const EXPOSURE_VOXEL_M = 0.5;
/** Sample points start this far off the face along its normal (clear of its own voxels), metres. */
export const EXPOSURE_OFFSET_M = 0.8;

/** A voxel grid marking the cells the solid's surfaces pass through. */
export interface SolidGrid { lo: [number, number, number]; n: [number, number, number]; cell: number; occ: Uint8Array }

/** The grid of the solid's own surfaces: walls, roofs and bases (not the scanned residual, openings or sweeps). */
export function solidGrid(nodes: MassingNode[], cell = EXPOSURE_VOXEL_M): SolidGrid {
    const solid = nodes.filter(n => n.kind !== 'residual' && n.kind !== 'opening' && n.kind !== 'sweep');
    const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const n of solid) for (let i = 0; i < n.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], n.positions[i + k]); hi[k] = Math.max(hi[k], n.positions[i + k]); }
    if (!Number.isFinite(lo[0])) return { lo: [0, 0, 0], n: [1, 1, 1], cell, occ: new Uint8Array(1) };
    for (let k = 0; k < 3; k++) { lo[k] -= cell; hi[k] += cell; }
    const dims: [number, number, number] = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k] - lo[k]) / cell))) as [number, number, number];
    const occ = new Uint8Array(dims[0] * dims[1] * dims[2]);
    const mark = (p: number[]) => {
        const i = Math.floor((p[0] - lo[0]) / cell), j = Math.floor((p[1] - lo[1]) / cell), k = Math.floor((p[2] - lo[2]) / cell);
        if (i >= 0 && j >= 0 && k >= 0 && i < dims[0] && j < dims[1] && k < dims[2]) occ[(k * dims[1] + j) * dims[0] + i] = 1;
    };
    for (const n of solid) {
        const P = n.positions;
        for (let t = 0; t + 2 < n.indices.length; t += 3) {
            const a = [P[n.indices[t] * 3], P[n.indices[t] * 3 + 1], P[n.indices[t] * 3 + 2]];
            const b = [P[n.indices[t + 1] * 3], P[n.indices[t + 1] * 3 + 1], P[n.indices[t + 1] * 3 + 2]];
            const c = [P[n.indices[t + 2] * 3], P[n.indices[t + 2] * 3 + 1], P[n.indices[t + 2] * 3 + 2]];
            // sample the triangle densely enough to touch every cell it passes through
            const len = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]));
            const steps = Math.max(1, Math.ceil((2 * len) / cell));
            for (let u = 0; u <= steps; u++) for (let v = 0; v <= steps - u; v++) {
                const w1 = u / steps, w2 = v / steps, w0 = 1 - w1 - w2;
                mark([w0 * a[0] + w1 * b[0] + w2 * c[0], w0 * a[1] + w1 * b[1] + w2 * c[1], w0 * a[2] + w1 * b[2] + w2 * c[2]]);
            }
        }
    }
    return { lo, n: dims, cell, occ };
}

/** Whether a ray from `o` along unit `d` leaves the grid without entering an occupied cell (marched at half a cell). */
export function escapes(g: SolidGrid, o: number[], d: number[]): boolean {
    const step = g.cell / 2, maxT = g.cell * (g.n[0] + g.n[1] + g.n[2]);
    for (let t = 0; t <= maxT; t += step) {
        const i = Math.floor((o[0] + d[0] * t - g.lo[0]) / g.cell), j = Math.floor((o[1] + d[1] * t - g.lo[1]) / g.cell), k = Math.floor((o[2] + d[2] * t - g.lo[2]) / g.cell);
        if (i < 0 || j < 0 || k < 0 || i >= g.n[0] || j >= g.n[1] || k >= g.n[2]) return true;
        if (g.occ[(k * g.n[1] + j) * g.n[0] + i]) return false;
    }
    return true;
}

/** Directions over the hemisphere about `n` (n itself and rings at 35 and 70 degrees). */
function hemisphere(n: number[]): number[][] {
    const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    const U = u.map(x => x / ul), V = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]];
    const out = [n.slice()];
    for (const [tilt, count] of [[35, 6], [70, 8]] as const) {
        const st = Math.sin((tilt * Math.PI) / 180), ct = Math.cos((tilt * Math.PI) / 180);
        for (let k = 0; k < count; k++) {
            const ph = (2 * Math.PI * k) / count;
            out.push([0, 1, 2].map(q => ct * n[q] + st * (Math.cos(ph) * U[q] + Math.sin(ph) * V[q])));
        }
    }
    return out;
}

/**
 * The share of a face's sample points (a 7 x 7 grid over its frame, inside its polygon by the native tool's `.inside` mask
 * when it is there) from which some ray over the face's outward hemisphere reaches open air.
 */
export function exposedShare(f: MassingFace, g: SolidGrid, runDir?: string): number {
    let inside: Uint8Array | undefined;
    if (runDir) {
        const file = path.join(runDir, `face_${f.index}.inside`);
        try { if (fs.existsSync(file)) inside = new Uint8Array(fs.readFileSync(file)); } catch { /* the frame only */ }
    }
    const dirs = hemisphere(f.normal);
    let n = 0, open = 0;
    for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) {
        const s = f.sMin + ((a + 0.5) / 7) * (f.sMax - f.sMin), t = f.tMin + ((b + 0.5) / 7) * (f.tMax - f.tMin);
        if (inside && f.width > 0) {
            const x = Math.floor((s - f.orthoSMin) / f.pixel), y = Math.floor((f.orthoTMax - t) / f.pixel);
            if (x < 0 || y < 0 || x >= f.width || y >= f.height || !inside[y * f.width + x]) continue;
        }
        const p = [0, 1, 2].map(k => f.origin[k] + f.axisS[k] * s + f.axisT[k] * t + f.normal[k] * EXPOSURE_OFFSET_M);
        n++;
        if (dirs.some(d => escapes(g, p, d))) open++;
    }
    return n ? open / n : 0;
}
