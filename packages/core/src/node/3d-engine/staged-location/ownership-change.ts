/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How much the multi-view ownership vote changed an isolated structure: the scan triangles (tile_refine's raw clay of the
 * isolate, so the vertices are the scan's own and match exactly between runs) that one isolate holds and the other does
 * not, as a share of the area of both together. The staged build shows the geometric isolate first and replaces it with
 * the voted one only when this share reaches OWNERSHIP_MATERIAL_SHARE.
 */

import * as fs from 'fs';
import { parseGlbNodes } from './glb-nodes';

/**
 * The vote changes the structure materially when the triangles it moves in or out make up at least this share of the
 * surface of the two isolates together: 5%, a neighbour's party wall or a tree crown, not the edges of the footprint.
 * Measured live (Haughwout Building, 2026-10-20): the vote moved 3.0% (95 m² left, 27 m² joined, of 3,980 m²); at a 3%
 * threshold that replaced the isolate and ran grammar, fit and textures a second time, +85 s to the finish for that 3%.
 */
export const OWNERSHIP_MATERIAL_SHARE = 0.05;

export interface OwnershipChange {
    /** Area (m²) in the first isolate only, in the second only, and in both. */
    onlyFirstM2: number;
    onlySecondM2: number;
    bothM2: number;
    /** (onlyFirst + onlySecond) / (onlyFirst + onlySecond + both). */
    share: number;
    material: boolean;
    /** The centroids (x y z, metres, the scan frame) of the triangles in one isolate only: where the vote moved the structure. */
    moved: Float64Array;
    /** Their areas (m²), one per centroid. */
    movedAreas: Float64Array;
}

function triangles(file: string): Map<string, { area: number; c: [number, number, number] }> {
    const out = new Map<string, { area: number; c: [number, number, number] }>();
    for (const n of parseGlbNodes(fs.readFileSync(file))) {
        const p = n.positions;
        const count = n.indices ? n.indices.length : p.length / 3;
        for (let t = 0; t + 2 < count; t += 3) {
            const a = n.indices ? n.indices[t] : t, b = n.indices ? n.indices[t + 1] : t + 1, c = n.indices ? n.indices[t + 2] : t + 2;
            const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
            const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
            const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
            const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            // the centroid to a centimetre: the same scan triangle in both isolates
            const cx = (ax + p[b * 3] + p[c * 3]) / 3, cy = (ay + p[b * 3 + 1] + p[c * 3 + 1]) / 3, cz = (az + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
            const key = `${Math.round(cx * 100)},${Math.round(cy * 100)},${Math.round(cz * 100)}`;
            const was = out.get(key);
            if (was) was.area += area; else out.set(key, { area, c: [cx, cy, cz] });
        }
    }
    return out;
}

/** The change between two isolates of the same scan (GLB files of their raw clay). */
export function ownershipChange(firstGlb: string, secondGlb: string, materialShare = OWNERSHIP_MATERIAL_SHARE): OwnershipChange {
    const a = triangles(firstGlb), b = triangles(secondGlb);
    let onlyFirstM2 = 0, onlySecondM2 = 0, bothM2 = 0;
    const moved: number[] = [], movedAreas: number[] = [];
    for (const [k, t] of a) { const o = b.get(k); if (o) bothM2 += Math.max(t.area, o.area); else { onlyFirstM2 += t.area; moved.push(...t.c); movedAreas.push(t.area); } }
    for (const [k, t] of b) if (!a.has(k)) { onlySecondM2 += t.area; moved.push(...t.c); movedAreas.push(t.area); }
    const total = onlyFirstM2 + onlySecondM2 + bothM2;
    const share = total > 0 ? (onlyFirstM2 + onlySecondM2) / total : 0;
    return { onlyFirstM2, onlySecondM2, bothM2, share, material: share >= materialShare, moved: Float64Array.from(moved), movedAreas: Float64Array.from(movedAreas) };
}
