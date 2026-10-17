/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The fitted solid: the union of the fitted primitives, each its own closed shell (the same union the native builder tests penetration
 * against, scratchbox_ornament.hpp FittedSolid). Read from the fit's own GLB, one named node per fitted surface, grouped by primitive.
 */

import * as fs from 'fs';
import { readGlbScene } from '../../spatial/StreetViewPoseRegistrar';
import type { StructureFit, Vec3 } from '../../../common/spatial/staged-location-contracts';

export interface Shell { id: string; positions: Float32Array; indices: Uint32Array; min: Vec3; max: Vec3 }

/** The fitted solid: one closed shell per primitive. */
export interface FittedShells { shells: Shell[] }

function glbNodeNames(file: string): string[] {
    const buf = fs.readFileSync(file);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
    return (json.nodes ?? []).filter((n: { mesh?: number }) => n.mesh !== undefined).map((n: { name?: string }) => n.name ?? '');
}

/**
 * The fitted solid read from the fit's own GLB (one named node per fitted surface), grouped by primitive. Undefined when the
 * nodes cannot be matched to surfaces (then exposure is unknown, and the caller says so).
 */
export function readFittedShells(fit: Pick<StructureFit, 'surfaces' | 'outputs'>): FittedShells | undefined {
    const file = fit.outputs.fittedGlb;
    if (!file || !fs.existsSync(file)) return undefined;
    const names = glbNodeNames(file);
    const prims = readGlbScene(file);
    if (names.length !== prims.length) return undefined;
    const primitiveOf = new Map(fit.surfaces.map(s => [s.id, s.primitiveId || s.id]));
    const groups = new Map<string, Array<{ positions: Float32Array; indices: Uint32Array }>>();
    prims.forEach((p, i) => {
        const key = primitiveOf.get(names[i]);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(p);
    });
    if (!groups.size) return undefined;
    const shells: Shell[] = [];
    for (const [id, parts] of groups) {
        const nv = parts.reduce((n, p) => n + p.positions.length, 0), ni = parts.reduce((n, p) => n + p.indices.length, 0);
        const positions = new Float32Array(nv), indices = new Uint32Array(ni);
        let ov = 0, oi = 0;
        for (const p of parts) {
            positions.set(p.positions, ov);
            for (let k = 0; k < p.indices.length; k++) indices[oi + k] = p.indices[k] + ov / 3;
            ov += p.positions.length; oi += p.indices.length;
        }
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < positions.length; k += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], positions[k + c]); max[c] = Math.max(max[c], positions[k + c]); }
        shells.push({ id, positions, indices, min, max });
    }
    return { shells };
}

const DIRS: Vec3[] = [[0.267, 0.535, 0.802], [-0.702, 0.302, 0.644], [0.12, -0.97, 0.21]].map(d => {
    const l = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / l, d[1] / l, d[2] / l] as Vec3;
});

/** Triangles a ray from `o` along `d` crosses (Möller-Trumbore, both sides). */
function crossings(shell: Shell, o: Vec3, d: Vec3): number {
    const P = shell.positions, I = shell.indices;
    let n = 0;
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (s > 1e-6) n++;
    }
    return n;
}

/** True when the point lies inside the closed shell of any primitive (parity of three rays, two of three agreeing). */
export function insideSolid(solid: FittedShells, p: Vec3, tolM = 0): boolean {
    for (const sh of solid.shells) {
        if (p[0] < sh.min[0] - tolM || p[0] > sh.max[0] + tolM || p[1] < sh.min[1] - tolM || p[1] > sh.max[1] + tolM || p[2] < sh.min[2] - tolM || p[2] > sh.max[2] + tolM) continue;
        let votes = 0;
        for (const d of DIRS) votes += crossings(sh, p, d) % 2;
        if (votes >= 2) return true;
    }
    return false;
}
