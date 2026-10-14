/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Synthetic scans for the tile_refine tests: triangle chunks written as an untextured binary glTF (one primitive per
 * chunk, as a photogrammetric tile arrives in pieces), and the tile_refine CLI compiled on demand.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type V3 = [number, number, number];
export interface Chunk { positions: number[]; indices: number[] }

/** A planar quad from corner o along u and v, split into nu x nv cells (two triangles each, normal u x v). */
export function quad(o: V3, u: V3, v: V3, nu: number, nv: number): Chunk {
    const positions: number[] = [], indices: number[] = [];
    for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++)
            for (let c = 0; c < 3; c++) positions.push(o[c] + (u[c] * i) / nu + (v[c] * j) / nv);
    for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
            const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
            indices.push(a, b, d, a, d, c);
        }
    return { positions, indices };
}

/** An upward-facing horizontal rectangle. */
export const flat = (x0: number, x1: number, z0: number, z1: number, y: number, n = 4) => quad([x0, y, z1], [x1 - x0, 0, 0], [0, 0, z0 - z1], n, n);

export function writeGlb(file: string, chunks: Chunk[]): void {
    const parts: Buffer[] = [];
    let offset = 0;
    const bufferViews: object[] = [], accessors: object[] = [], primitives: object[] = [];
    const push = (b: Buffer, target: number) => {
        const pad = (4 - (b.length % 4)) % 4;
        parts.push(b, Buffer.alloc(pad));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target });
        offset += b.length + pad;
        return bufferViews.length - 1;
    };
    for (const ch of chunks) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        ch.positions.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], Math.fround(v)); max[i % 3] = Math.max(max[i % 3], Math.fround(v)); });
        const pv = push(Buffer.from(new Float32Array(ch.positions).buffer), 34962);
        accessors.push({ bufferView: pv, componentType: 5126, count: ch.positions.length / 3, type: 'VEC3', min, max });
        const iv = push(Buffer.from(new Uint32Array(ch.indices).buffer), 34963);
        accessors.push({ bufferView: iv, componentType: 5125, count: ch.indices.length, type: 'SCALAR' });
        primitives.push({ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, mode: 4 });
    }
    const bin = Buffer.concat(parts);
    const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews, accessors, meshes: [{ primitives }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
    let js = Buffer.from(JSON.stringify(doc));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4);
    fs.writeFileSync(file, Buffer.concat([header, jh, js, bh, bin]));
}

/** Compiles scripts/tile_refine.cpp to `bin` unless it is newer than the CLI and every engine header. */
export function buildTileRefine(repo: string, bin: string): void {
    const include = path.join(repo, 'packages/core/src/native/3d-engine/include');
    const sources = [path.join(repo, 'scripts/tile_refine.cpp'), ...fs.readdirSync(include).map(f => path.join(include, f))];
    const newest = Math.max(...sources.map(f => fs.statSync(f).mtimeMs));
    if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= newest) return;
    execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-pthread', '-I', include, path.join(repo, 'scripts/tile_refine.cpp'), '-o', bin, '-lz'],
        { stdio: 'pipe', timeout: 600_000 });
}
