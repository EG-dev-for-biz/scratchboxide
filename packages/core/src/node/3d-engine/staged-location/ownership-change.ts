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
 * surface of the two isolates together (3%: a cornice, a neighbour's party wall or a tree crown, not a few stray slivers).
 */
export const OWNERSHIP_MATERIAL_SHARE = 0.03;

export interface OwnershipChange {
    /** Area (m²) in the first isolate only, in the second only, and in both. */
    onlyFirstM2: number;
    onlySecondM2: number;
    bothM2: number;
    /** (onlyFirst + onlySecond) / (onlyFirst + onlySecond + both). */
    share: number;
    material: boolean;
}

function triangles(file: string): Map<string, number> {
    const out = new Map<string, number>();
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
            const key = `${Math.round(((ax + p[b * 3] + p[c * 3]) / 3) * 100)},${Math.round(((ay + p[b * 3 + 1] + p[c * 3 + 1]) / 3) * 100)},${Math.round(((az + p[b * 3 + 2] + p[c * 3 + 2]) / 3) * 100)}`;
            out.set(key, (out.get(key) ?? 0) + area);
        }
    }
    return out;
}

/** The change between two isolates of the same scan (GLB files of their raw clay). */
export function ownershipChange(firstGlb: string, secondGlb: string, materialShare = OWNERSHIP_MATERIAL_SHARE): OwnershipChange {
    const a = triangles(firstGlb), b = triangles(secondGlb);
    let onlyFirstM2 = 0, onlySecondM2 = 0, bothM2 = 0;
    for (const [k, area] of a) { if (b.has(k)) bothM2 += Math.max(area, b.get(k)!); else onlyFirstM2 += area; }
    for (const [k, area] of b) if (!a.has(k)) onlySecondM2 += area;
    const total = onlyFirstM2 + onlySecondM2 + bothM2;
    const share = total > 0 ? (onlyFirstM2 + onlySecondM2) / total : 0;
    return { onlyFirstM2, onlySecondM2, bothM2, share, material: share >= materialShare };
}
