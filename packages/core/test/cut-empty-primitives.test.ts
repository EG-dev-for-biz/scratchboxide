/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { assembleGlb, dropPrimitives, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { hideFootprintInGlb } from '../src/node/3d-engine/staged-location/kept-structure';
import { joinChunkGlb } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';

/** A district of two meshes, each its own node: a tower's two wall triangles over x, z in 0..2 at 20-30 m, and one street triangle at x = 10. */
function district(): Buffer {
    const tower = new Float32Array([0.5, 20, 0.5, 1.5, 20, 0.5, 1.5, 30, 0.5, 0.5, 30, 0.5]), street = new Float32Array([10, 0, 0, 12, 0, 0, 10, 0, 2]);
    const towerIdx = new Uint32Array([0, 1, 2, 0, 2, 3]), streetIdx = new Uint32Array([0, 1, 2]);
    const parts = [tower, towerIdx, street, streetIdx].map(a => new Uint8Array(a.buffer));
    const bin = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    const views: Array<{ buffer: 0; byteOffset: number; byteLength: number }> = [];
    let o = 0; for (const p of parts) { bin.set(p, o); views.push({ buffer: 0, byteOffset: o, byteLength: p.byteLength }); o += p.byteLength; }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
        nodes: [{ name: 'tower', mesh: 0 }, { name: 'street', mesh: 1 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }, { primitives: [{ attributes: { POSITION: 2 }, indices: 3, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0.5, 20, 0.5], max: [1.5, 30, 0.5] }, { bufferView: 1, componentType: 5125, count: 6, type: 'SCALAR' },
            { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3', min: [10, 0, 0], max: [12, 0, 2] }, { bufferView: 3, componentType: 5125, count: 3, type: 'SCALAR' }
        ],
        bufferViews: views, buffers: [{ byteLength: bin.byteLength }]
    };
    return assembleGlb(json, bin);
}

/** What a reader draws: every primitive's triangles by its index list; an index list holding nothing is a fault. */
function drawn(bytes: Uint8Array): { triangles: number; emptyLists: number; meshes: number; nodeMeshes: Array<number | undefined> } {
    const glb = parseGlbBytes(bytes), json = glb.json as any;
    let triangles = 0, emptyLists = 0;
    for (const mesh of json.meshes ?? []) {
        expect(mesh.primitives.length).toBeGreaterThan(0);
        for (const p of mesh.primitives) { const n = json.accessors[p.indices].count; if (!n) emptyLists++; else { expect(readAccessor(glb, p.indices).data.length).toBe(n); triangles += n / 3; } }
    }
    return { triangles, emptyLists, meshes: (json.meshes ?? []).length, nodeMeshes: json.nodes.map((n: any) => n.mesh) };
}

describe('a cut that removes every triangle of a primitive drops the primitive', () => {
    const footprint = { cellM: 1, cells: new Set(['0,0', '1,0', '0,1', '1,1']), baseY: 0, topY: 30 };

    it('hideFootprintInGlb: the structure cut out of the district leaves no empty index list', () => {
        const cut = hideFootprintInGlb(district(), footprint, { keep: 'outside' });
        expect(cut.removedTriangles).toBe(2);
        expect(cut.keptTriangles).toBe(1);
        const d = drawn(cut.glb);
        expect(d).toEqual({ triangles: 1, emptyLists: 0, meshes: 1, nodeMeshes: [undefined, 0] });
        // and turned round: only the structure stays, the street's primitive goes
        const only = hideFootprintInGlb(district(), footprint, { keep: 'inside' });
        expect(drawn(only.glb)).toEqual({ triangles: 2, emptyLists: 0, meshes: 1, nodeMeshes: [0, undefined] });
    });

    it('joinChunkGlb: a layer cut to what a chunk keeps leaves no empty index list', () => {
        const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        for (const compact of [true, false]) {
            const r = joinChunkGlb(district(), I as never, x => x > 5, { compact });
            expect(r.removedTriangles).toBe(2);
            expect(drawn(r.glb)).toEqual({ triangles: 1, emptyLists: 0, meshes: 1, nodeMeshes: [undefined, 0] });
        }
        // nothing cut: the file's triangles are all there
        expect(drawn(joinChunkGlb(district(), I as never, () => true, {}).glb).triangles).toBe(3);
    });

    it('dropPrimitives keeps a mesh that still holds a primitive and renumbers the rest', () => {
        const a = { attributes: { POSITION: 0 } }, b = { attributes: { POSITION: 0 } }, c = { attributes: { POSITION: 0 } };
        const json: any = { meshes: [{ primitives: [a] }, { primitives: [b, c] }, { primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }, { mesh: 1 }, { mesh: 2 }, { mesh: 0 }, {}] };
        expect(dropPrimitives(json, new Set([a, b]))).toBe(2);
        expect(json.meshes.length).toBe(2);
        expect(json.meshes[0].primitives).toEqual([c]);
        expect(json.nodes.map((n: any) => n.mesh)).toEqual([undefined, 0, 1, undefined, undefined]);
        expect(dropPrimitives(json, new Set())).toBe(0);
    });
});
