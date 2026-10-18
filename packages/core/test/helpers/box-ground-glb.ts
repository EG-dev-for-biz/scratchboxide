/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';

/** Minimal GLB writer: axis-aligned box [min,max] plus a ground quad, indexed triangles, no node transform. */
export function writeBoxGroundGlb(file: string, boxMin: number[], boxMax: number[], groundHalf: number): void {
    const V: number[] = [], I: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        const base = V.length / 3;
        V.push(...a, ...b, ...c, ...d);
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const [x0, y0, z0] = boxMin, [x1, y1, z1] = boxMax;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y top
    // Ground as a 20x20 grid: the software rasterizer has no near-plane clipping, so large
    // triangles straddling the camera plane would be dropped (real tile meshes are finely tessellated)
    const g = groundHalf, N = 20, cell = (2 * g) / N;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const xa = -g + i * cell, xb = xa + cell, za = -g + j * cell, zb = za + cell;
        quad([xa, 0, zb], [xb, 0, zb], [xb, 0, za], [xa, 0, za]);
    }
    const pos = new Float32Array(V), idx = new Uint32Array(I);
    const posBytes = Buffer.from(pos.buffer), idxBytes = Buffer.from(idx.buffer);
    const bin = Buffer.concat([posBytes, idxBytes]);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], V[i + k]); max[k] = Math.max(max[k], V[i + k]); }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: V.length / 3, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5125, count: I.length, type: 'SCALAR' }
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.length }, { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length }],
        buffers: [{ byteLength: bin.length }]
    };
    let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
    let bb = bin; while (bb.length % 4) bb = Buffer.concat([bb, Buffer.alloc(1)]);
    const total = 12 + 8 + js.length + 8 + bb.length;
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(total, 8);
    const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
    const bc = Buffer.alloc(8); bc.writeUInt32LE(bb.length, 0); bc.writeUInt32LE(0x004e4942, 4);
    fs.outputFileSync(file, Buffer.concat([h, jc, js, bc, bb]));
}
