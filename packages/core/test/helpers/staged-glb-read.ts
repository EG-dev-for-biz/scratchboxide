/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reads a staged layer GLB (scratchbox_staged_glb.hpp) the way the viewport's loader sees it: each node's name and
 * `extras.sb`, and each primitive's mode, positions, normals, indices, `_REVEAL` (VEC2, normalised u16), `_DISP` (VEC3) and
 * COLOR_0, all as numbers. KHR_mesh_quantization's normalised integers are decoded by readAccessor.
 */

import * as fs from 'fs';
import { parseGlb, readAccessor } from './clay-glb-render';

export interface StagedPrimitiveRead {
    mode: number;
    positions: Float64Array;
    normals?: Float64Array;
    indices: Float64Array;
    reveal?: Float64Array;
    disp?: Float64Array;
    colors?: Float64Array;
    attributes: string[];
}

export interface StagedNodeRead {
    index: number;
    name: string;
    extras: any;
    sb: any;
    primitives: StagedPrimitiveRead[];
    children: number[];
    /** Of a tree with levels: its three level nodes by level (and the wood mesh level 2 shares with level 0 is the first primitive of both). */
    translation?: number[];
    scale?: number[];
}

export interface StagedGlbRead {
    json: any;
    bin: Buffer;
    root: any;
    nodes: StagedNodeRead[];
    byName: (name: string) => StagedNodeRead;
    /** A tree node's level child (0 near, 1 mid, 2 far), or undefined for a tree without levels. */
    level: (tree: StagedNodeRead, level: number) => StagedNodeRead | undefined;
}

export function readStagedGlb(file: string): StagedGlbRead {
    const { json, bin } = parseGlb(fs.readFileSync(file));
    const nodes: StagedNodeRead[] = (json.nodes ?? []).map((n: any, index: number) => {
        const primitives: StagedPrimitiveRead[] = n.mesh === undefined ? [] : json.meshes[n.mesh].primitives.map((p: any) => ({
            mode: p.mode ?? 4,
            positions: readAccessor(json, bin, p.attributes.POSITION).data,
            normals: p.attributes.NORMAL !== undefined ? readAccessor(json, bin, p.attributes.NORMAL).data : undefined,
            indices: p.indices !== undefined ? readAccessor(json, bin, p.indices).data : new Float64Array(0),
            reveal: p.attributes._REVEAL !== undefined ? readAccessor(json, bin, p.attributes._REVEAL).data : undefined,
            disp: p.attributes._DISP !== undefined ? readAccessor(json, bin, p.attributes._DISP).data : undefined,
            colors: p.attributes.COLOR_0 !== undefined ? readAccessor(json, bin, p.attributes.COLOR_0).data : undefined,
            attributes: Object.keys(p.attributes)
        }));
        return { index, name: n.name ?? '', extras: n.extras, sb: n.extras?.sb, primitives, children: n.children ?? [], translation: n.translation, scale: n.scale };
    });
    return {
        json, bin, root: json.extras, nodes,
        level: (tree: StagedNodeRead, level: number) => tree.children.map(i => nodes[i]).find(c => c.extras?.sbLod?.level === level),
        byName: (name: string) => {
            const n = nodes.find(x => x.name === name);
            if (!n) throw new Error(`no node named ${name} in ${file}: ${nodes.map(x => x.name).join(', ')}`);
            return n;
        }
    };
}

/** Signed volume of a closed triangle mesh (positive when the winding faces outward). */
export function signedVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
    let v = 0;
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ax = positions[a], ay = positions[a + 1], az = positions[a + 2], bx = positions[b], by = positions[b + 1], bz = positions[b + 2], cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
        v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return v;
}

/**
 * Edge use of a triangle mesh by position (vertices that coincide are one): how many edges are used once (open boundary),
 * more than twice (non-manifold), and the total.
 */
export function edgeUse(positions: ArrayLike<number>, indices: ArrayLike<number>, quantumM = 1e-5): { boundary: number; nonManifold: number; edges: number } {
    const key = (i: number) => `${Math.round(positions[3 * i] / quantumM)},${Math.round(positions[3 * i + 1] / quantumM)},${Math.round(positions[3 * i + 2] / quantumM)}`;
    const uses = new Map<string, number>();
    for (let t = 0; t + 2 < indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = key(indices[t + e]), b = key(indices[t + (e + 1) % 3]);
            if (a === b) continue;
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            uses.set(k, (uses.get(k) ?? 0) + 1);
        }
    }
    let boundary = 0, nonManifold = 0;
    for (const n of uses.values()) { if (n === 1) boundary++; else if (n > 2) nonManifold++; }
    return { boundary, nonManifold, edges: uses.size };
}
