/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A GLB's nodes as plain arrays (name, positions, indices, node extras), for the staged layers the server recuts: the
 * pass-through layer without the regions a figure replaced, the figures' own nodes. Triangle meshes with one primitive
 * per node (what the staged writers emit); anything else in the file is ignored.
 */

import * as fs from 'fs';

export interface GlbNode {
    name: string;
    positions: Float32Array;
    indices?: Uint32Array;
    extras?: unknown;
}

const COMPONENT: Record<number, { size: number; read: (dv: DataView, o: number) => number }> = {
    5121: { size: 1, read: (dv, o) => dv.getUint8(o) },
    5123: { size: 2, read: (dv, o) => dv.getUint16(o, true) },
    5125: { size: 4, read: (dv, o) => dv.getUint32(o, true) },
    5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true) }
};
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function parseGlbNodes(buf: Buffer): GlbNode[] {
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a binary glTF (missing glTF magic)');
    let json: any;
    let bin: Buffer | undefined;
    for (let o = 12; o + 8 <= buf.length;) {
        const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
        const data = buf.subarray(o + 8, o + 8 + len);
        if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
        else if (type === 0x004e4942 && !bin) bin = data;
        o += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json || !bin) throw new Error('the GLB has no JSON or no binary chunk');
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const accessor = (index: number): { data: number[]; count: number; width: number } => {
        const a = json.accessors[index];
        const view = json.bufferViews[a.bufferView];
        const comp = COMPONENT[a.componentType];
        const width = TYPE_COUNT[a.type];
        const stride = view.byteStride || comp.size * width;
        const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
        const out: number[] = new Array(a.count * width);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < width; c++) out[i * width + c] = comp.read(dv, base + i * stride + c * comp.size);
        return { data: out, count: a.count, width };
    };
    const nodes: GlbNode[] = [];
    for (const n of json.nodes ?? []) {
        if (n.mesh === undefined) continue;
        const prim = json.meshes[n.mesh]?.primitives?.[0];
        if (!prim || prim.attributes?.POSITION === undefined || (prim.mode !== undefined && prim.mode !== 4)) continue;
        const pos = accessor(prim.attributes.POSITION);
        nodes.push({
            name: n.name ?? json.meshes[n.mesh].name ?? `node${nodes.length}`,
            positions: Float32Array.from(pos.data),
            ...(prim.indices !== undefined ? { indices: Uint32Array.from(accessor(prim.indices).data) } : {}),
            ...(n.extras !== undefined ? { extras: n.extras } : {})
        });
    }
    return nodes;
}

export function readGlbNodes(file: string): GlbNode[] {
    return parseGlbNodes(fs.readFileSync(file));
}
