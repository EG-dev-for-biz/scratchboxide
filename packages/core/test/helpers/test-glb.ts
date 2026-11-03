/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { assembleGlb } from '../../src/node/3d-engine/staged-location/glb-bytes';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

/** A primitive: positions, triangles, and either UVs with a PNG or a flat colour. */
export interface TestPrim { positions: number[]; indices: number[]; uvs?: number[]; png?: Buffer }
/** A node: its primitives (one mesh), its translation and its extras. */
export interface TestNode { prims: TestPrim[]; translation?: [number, number, number]; extras?: Record<string, unknown> }

/** A small GLB of the nodes, every node a scene root. */
export function testGlb(nodes: TestNode[]): Uint8Array {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], materials: [], textures: [], images: [] };
    const parts: Buffer[] = [];
    let offset = 0;
    const view = (buf: Buffer, target?: number) => {
        json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
        const pad = (4 - (buf.length % 4)) % 4;
        parts.push(buf, Buffer.alloc(pad));
        offset += buf.length + pad;
        return json.bufferViews.length - 1;
    };
    const accessor = (data: number[], type: 'VEC3' | 'VEC2' | 'SCALAR', target: number) => {
        const isIndex = type === 'SCALAR';
        const buf = isIndex ? Buffer.from(new Uint32Array(data).buffer) : Buffer.from(new Float32Array(data).buffer);
        const comps = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
        const a: any = { bufferView: view(buf, target), componentType: isIndex ? 5125 : 5126, count: data.length / comps, type };
        if (type === 'VEC3') {
            a.min = [0, 1, 2].map(c => Math.min(...data.filter((_, i) => i % 3 === c)));
            a.max = [0, 1, 2].map(c => Math.max(...data.filter((_, i) => i % 3 === c)));
        }
        json.accessors.push(a);
        return json.accessors.length - 1;
    };
    for (const node of nodes) {
        const primitives = node.prims.map(p => {
            const attributes: any = { POSITION: accessor(p.positions, 'VEC3', 34962) };
            if (p.uvs) attributes.TEXCOORD_0 = accessor(p.uvs, 'VEC2', 34962);
            let material: any = { pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1] } };
            if (p.png) {
                json.images.push({ bufferView: view(p.png), mimeType: 'image/png' });
                json.textures.push({ source: json.images.length - 1 });
                material = { pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 } } };
            }
            json.materials.push(material);
            return { attributes, indices: accessor(p.indices, 'SCALAR', 34963), material: json.materials.length - 1 };
        });
        json.meshes.push({ primitives });
        json.nodes.push({ mesh: json.meshes.length - 1, ...(node.translation ? { translation: node.translation } : {}), ...(node.extras ? { extras: node.extras } : {}) });
    }
    json.buffers[0].byteLength = offset;
    return assembleGlb(json, Buffer.concat(parts));
}

type Face = 'top' | 'bottom' | 'west' | 'east' | 'north' | 'south';

/** An axis-aligned box with shared corners, wound outward (y up), less the faces named. */
export function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, without: Face[] = []): TestPrim {
    const positions = [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1];
    const faces: Record<Face, number[]> = {
        bottom: [0, 1, 2, 0, 2, 3], top: [4, 6, 5, 4, 7, 6],
        north: [0, 4, 5, 0, 5, 1], south: [3, 2, 6, 3, 6, 7],
        west: [0, 3, 7, 0, 7, 4], east: [1, 5, 6, 1, 6, 2]
    };
    const indices = (Object.keys(faces) as Face[]).filter(f => !without.includes(f)).flatMap(f => faces[f]);
    return { positions, indices };
}

/** A horizontal quad at height y, its UVs across it (u along x, v along z), facing up. */
export function quad(x0: number, z0: number, x1: number, z1: number, y = 0, png?: Buffer): TestPrim {
    return { positions: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], indices: [0, 2, 1, 0, 3, 2], uvs: [0, 0, 1, 0, 1, 1, 0, 1], ...(png ? { png } : {}) };
}
