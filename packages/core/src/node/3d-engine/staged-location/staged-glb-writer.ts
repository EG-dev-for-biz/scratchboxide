/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A small binary glTF 2.0 writer for staged layers the server writes itself: one node per StagedGlbNode (TRIANGLES,
 * POSITION + NORMAL, optional extra float attributes), one studio clay material, node extras and root extras. Used for
 * the scanned trees put back after a failed tree stage (l5x): the raw scan triangles strip removed, written as they
 * were downloaded, in clay. It writes geometry it is given; it makes none.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface StagedGlbNode {
    name?: string;
    /** Tile-frame positions (x east, y up, z south), 3 per vertex. */
    positions: Float32Array;
    /** Triangle indices; omitted = consecutive triples. */
    indices?: Uint32Array;
    /** Unit normals, 3 per vertex; computed from the triangles when omitted. */
    normals?: Float32Array;
    /** Extra per-vertex float attributes (scalar), by glTF attribute name ("_FOO"). */
    attributes?: Record<string, Float32Array>;
    /** Node extras (StagedNodeExtras for staged layers). */
    extras?: unknown;
}

export interface StagedGlbOptions {
    /** Root (scene) extras: StagedGlbRootExtras beside the frame extras. */
    rootExtras?: Record<string, unknown>;
    /** asset.extras. */
    assetExtras?: Record<string, unknown>;
    copyright?: string;
    generator?: string;
}

function pad4(buf: Buffer, fill = 0): Buffer {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
}

/** Area-weighted vertex normals of an indexed triangle mesh. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const n = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
        if (l > 1e-20) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i + 1] = 1; }
    }
    return n;
}

export function writeStagedGlb(nodes: StagedGlbNode[], options: StagedGlbOptions = {}): Buffer {
    const chunks: Buffer[] = [];
    let binLength = 0;
    const bufferViews: any[] = [];
    const accessors: any[] = [];
    const meshes: any[] = [];
    const gltfNodes: any[] = [{ name: 'staged', children: [] as number[], ...(options.rootExtras ? { extras: options.rootExtras } : {}) }];
    const addView = (data: Buffer, target?: number): number => {
        bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.length, ...(target ? { target } : {}) });
        const padded = pad4(data);
        chunks.push(padded);
        binLength += padded.length;
        return bufferViews.length - 1;
    };
    const f32 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    for (const node of nodes) {
        const count = node.positions.length / 3;
        if (!Number.isInteger(count)) throw new Error('staged GLB: positions must hold 3 numbers per vertex');
        const indices = node.indices ?? Uint32Array.from({ length: count - (count % 3) }, (_, i) => i);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < node.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], node.positions[i + k]); max[k] = Math.max(max[k], node.positions[i + k]); }
        }
        const attributes: Record<string, number> = {};
        accessors.push({ bufferView: addView(f32(node.positions), 34962), componentType: 5126, count, type: 'VEC3', ...(count ? { min, max } : {}) });
        attributes.POSITION = accessors.length - 1;
        const normals = node.normals ?? vertexNormals(node.positions, indices);
        accessors.push({ bufferView: addView(f32(normals), 34962), componentType: 5126, count, type: 'VEC3' });
        attributes.NORMAL = accessors.length - 1;
        for (const [name, values] of Object.entries(node.attributes ?? {})) {
            if (values.length !== count) throw new Error(`staged GLB: attribute ${name} has ${values.length} values for ${count} vertices`);
            accessors.push({ bufferView: addView(f32(values), 34962), componentType: 5126, count, type: 'SCALAR' });
            attributes[name] = accessors.length - 1;
        }
        accessors.push({ bufferView: addView(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength), 34963), componentType: 5125, count: indices.length, type: 'SCALAR' });
        meshes.push({ primitives: [{ attributes, indices: accessors.length - 1, mode: 4, material: 0 }] });
        gltfNodes.push({ name: node.name ?? `node_${meshes.length - 1}`, mesh: meshes.length - 1, ...(node.extras !== undefined ? { extras: node.extras } : {}) });
        gltfNodes[0].children.push(gltfNodes.length - 1);
    }
    const json = {
        asset: {
            version: '2.0', generator: options.generator ?? 'scratchbox-staged-location',
            ...(options.copyright ? { copyright: options.copyright } : {}),
            ...(options.assetExtras ? { extras: options.assetExtras } : {})
        },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: gltfNodes,
        meshes,
        materials: [{ name: 'StudioGreyClay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
        accessors,
        bufferViews,
        buffers: [{ byteLength: binLength }]
    };
    const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
    const bin = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'utf8');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBuf.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, bin]);
}

/** Writes the GLB through a temp file and a rename. */
export function writeStagedGlbFile(file: string, nodes: StagedGlbNode[], options: StagedGlbOptions = {}): { path: string; bytes: number } {
    const glb = writeStagedGlb(nodes, options);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, glb);
    fs.renameSync(tmp, file);
    return { path: file, bytes: glb.length };
}
