/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Synthetic pass-through pieces for the redundant-scan checks: grid patches, lumps, their area, deterministic noise. */

import type { GlbNode } from '../../src/node/3d-engine/staged-location/glb-nodes';

/** A grid patch in the plane z = z0(x, y), x in [x0, x1], y in [y0, y1], cells of `step` m. */
export function patch(name: string, x0: number, x1: number, y0: number, y1: number, step: number, z: (x: number, y: number) => number): GlbNode {
    const nx = Math.round((x1 - x0) / step), ny = Math.round((y1 - y0) / step);
    const pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { const x = x0 + i * step, y = y0 + j * step; pos.push(x, y, z(x, y)); }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, b, d, a, d, c);
    }
    return { name, positions: Float32Array.from(pos), indices: Uint32Array.from(idx), extras: { regionId: name, sb: { counts: { vertices: pos.length / 3, triangles: idx.length / 3 } } } };
}

/** A lumpy sphere (a statue-sized blob) centred at c. */
export function lump(name: string, c: number[], r: number): GlbNode {
    const pos: number[] = [], idx: number[] = [];
    const nu = 16, nv = 10;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const th = (j / nv) * Math.PI, ph = (i / nu) * 2 * Math.PI;
        const rr = r * (1 + 0.08 * Math.sin(3 * ph) * Math.sin(2 * th));
        pos.push(c[0] + rr * Math.sin(th) * Math.cos(ph), c[1] + rr * Math.cos(th), c[2] + rr * Math.sin(th) * Math.sin(ph));
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, d = a + nu + 2, e = a + nu + 1; idx.push(a, b, d, a, d, e); }
    return { name, positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

export const area = (n: GlbNode) => {
    let s = 0;
    const P = n.positions, I = n.indices!;
    for (let t = 0; t < I.length; t += 3) {
        const a = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        s += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    return s;
};

// deterministic noise of +-2 cm
export const noise = (x: number, y: number) => 0.02 * Math.sin(x * 12.9898 + y * 78.233) * Math.cos(x * 3.1 - y * 5.7);
