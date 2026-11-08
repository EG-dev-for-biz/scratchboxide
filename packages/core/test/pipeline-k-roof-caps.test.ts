/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Seal caps over a roof left out of the textured twin (pipeline-k/roof-caps.ts): a cap facing up with a roof close beneath
 * it is made degenerate; a cap over nothing, one far above the roof, and an upright piece of the seal are kept; nothing
 * but the seal is touched.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { appendNode } from '../src/node/3d-engine/staged-location/pipeline-k/inner-core';
import { dropRoofCaps } from '../src/node/3d-engine/staged-location/pipeline-k/roof-caps';

/** A horizontal square [x0, x1] x [z0, z1] at height y, facing up (two triangles). */
function square(x0: number, x1: number, z0: number, z1: number, y: number): number[] {
    return [x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1];
}
function prim(tris: number[]) { const positions = Float32Array.from(tris); return { positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i), material: { name: 'm', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } } }; }
/** The triangles of a node left with three distinct corners. */
function liveTriangles(glb: Buffer, name: string): number {
    const g = parseGlbBytes(glb), n = (g.json.nodes as any[]).find(x => x.name === name);
    let live = 0;
    for (const p of g.json.meshes[n.mesh].primitives) { const idx = readAccessor(g, p.indices).data; for (let t = 0; t + 2 < idx.length; t += 3) if (!(idx[t] === idx[t + 1] && idx[t + 1] === idx[t + 2])) live++; }
    return live;
}

describe('roof caps', () => {
    it('leaves a cap close over a roof out of the twin and keeps a cap over nothing, one far above, and the seal\'s walls', () => {
        let glb: Buffer = assembleGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [] }, new Uint8Array(0));
        // the roof: 10 x 10 m at 10 m
        glb = appendNode(glb, [prim(square(0, 10, 0, 10, 10))], 'relief_m0', {});
        // the seal: a cap 1.5 m over the roof (dropped), a cap over nothing (kept), a cap 4 m over the roof (kept), a wall (kept)
        const wall = [20, 0, 0, 20, 5, 0, 20, 0, 5];
        glb = appendNode(glb, [prim([...square(1, 9, 1, 9, 11.5), ...square(20, 28, 1, 9, 11.5), ...square(1, 9, 1, 9, 14), ...wall])], 'Seal', {});
        const before = liveTriangles(glb, 'Seal');
        const r = dropRoofCaps(glb);
        expect(r.report.capsDropped).toBe(2);
        expect(r.report.areaM2).toBeCloseTo(64, 0);
        expect(r.report.capsKept).toBe(4);
        expect(liveTriangles(r.glb, 'Seal')).toBe(before - 2);
        // the roof itself untouched
        expect(liveTriangles(r.glb, 'relief_m0')).toBe(2);
        // nothing to drop: the same bytes back
        const none = dropRoofCaps(appendNode(assembleGlb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [], materials: [] }, new Uint8Array(0)), [prim(square(0, 10, 0, 10, 10))], 'relief_m0', {}));
        expect(none.report.capsDropped).toBe(0);
    });
});
