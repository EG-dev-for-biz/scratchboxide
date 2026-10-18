/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { measureGlbEdgeManifold } from '../src/node/3d-engine/glb-edge-manifold';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

/** One-primitive GLB from positions + indices, optionally under a translated node. */
function glb(positions: number[], indices: number[], translation?: number[]): Buffer {
    const pb = Buffer.from(new Float32Array(positions).buffer), ib = Buffer.from(new Uint32Array(indices).buffer);
    const bin = Buffer.concat([pb, ib]);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, ...(translation ? { translation } : {}) }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' }, { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: ib.length }],
        buffers: [{ byteLength: bin.length }]
    };
    let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + js.length + bin.length, 8);
    const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
    const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([h, jc, js, bc, bin]);
}

/** Unit cube with split vertices per face (24 vertices, as a flat-shaded exporter writes it), 12 triangles. */
function splitCube(dropFaces = 0): { positions: number[]; indices: number[] } {
    const faces = [
        [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
        [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
        [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]
    ].slice(0, 6 - dropFaces);
    const positions: number[] = [], indices: number[] = [];
    for (const f of faces) {
        const b = positions.length / 3;
        for (const v of f) positions.push(...v);
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    return { positions, indices };
}

describe('measureGlbEdgeManifold: welded edges each used exactly twice', () => {
    it('a closed cube with split face vertices is manifold after welding, also under a node transform', () => {
        const c = splitCube();
        const r = measureGlbEdgeManifold(glb(c.positions, c.indices, [3.25, -1, 7]));
        expect(r).toMatchObject({ isManifold: true, triangles: 12, weldedVertices: 8, edges: 18, boundaryEdges: 0, nonManifoldEdges: 0 });
    });

    it('an open box (one face missing) is not: its rim edges are used once', () => {
        const c = splitCube(1);
        const r = measureGlbEdgeManifold(glb(c.positions, c.indices));
        expect(r.isManifold).toBe(false);
        expect(r.boundaryEdges).toBe(4);
    });

    it('a fin sharing an edge with the cube makes that edge non-manifold', () => {
        const c = splitCube();
        const b = c.positions.length / 3;
        c.positions.push(0, 1, 1, 1, 1, 1, 0.5, 2, 1, 0.5, 2, 1.0001);
        c.indices.push(b, b + 1, b + 2, b + 1, b, b + 3);
        const r = measureGlbEdgeManifold(glb(c.positions, c.indices));
        expect(r.isManifold).toBe(false);
        expect(r.nonManifoldEdges).toBe(1);
    });

    it('the box on a ground grid (open box, open plane) is not manifold; bytes that are not a GLB throw', () => {
        const file = path.join(os.tmpdir(), `sb_manifold_${process.pid}.glb`);
        writeBoxGroundGlb(file, [-5, 0, -5], [5, 20, 5], 100);
        const r = measureGlbEdgeManifold(fs.readFileSync(file));
        fs.unlinkSync(file);
        expect(r.triangles).toBe(810);
        expect(r.isManifold).toBe(false);
        expect(() => measureGlbEdgeManifold(Buffer.from('glTF but not really a glb file'))).toThrow();
    });
});
