/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * In-memory GLB access for the texture pass (UV atlas and textured twin): parse the chunks of GLB bytes, read accessors
 * as typed arrays, gather an accessor's raw element bytes in a new vertex order (so attributes of any component type are
 * copied bit-for-bit), and walk the node tree with world matrices. No files.
 */

export interface ParsedGlb { json: any; bin: Uint8Array }

export const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function parseGlbBytes(bytes: Uint8Array): ParsedGlb {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a binary glTF (missing glTF magic)');
    if (dv.getUint32(4, true) !== 2) throw new Error('not a glTF 2.0 GLB');
    let json: any;
    let bin: Uint8Array = new Uint8Array(0);
    let sawBin = false;
    for (let o = 12; o + 8 <= bytes.byteLength;) {
        const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
        const data = bytes.subarray(o + 8, o + 8 + len);
        if (type === CHUNK_JSON) json = JSON.parse(Buffer.from(data).toString('utf8'));
        else if (type === CHUNK_BIN && !sawBin) { bin = data; sawBin = true; }
        o += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (!json) throw new Error('the GLB has no JSON chunk');
    return { json, bin };
}

function accessorLayout(json: any, index: number): { base: number; stride: number; elementBytes: number; count: number; comps: number; componentType: number; viewEnd: number } {
    const a = json.accessors?.[index];
    if (!a) throw new Error(`accessor ${index} does not exist`);
    if (a.sparse) throw new Error(`accessor ${index} is sparse, which the texture pass does not read`);
    if (a.bufferView === undefined) throw new Error(`accessor ${index} has no bufferView`);
    const view = json.bufferViews[a.bufferView];
    const comps = TYPE_COMPONENTS[a.type];
    const size = COMPONENT_BYTES[a.componentType];
    if (!comps || !size) throw new Error(`accessor ${index}: unsupported type ${a.type}/${a.componentType}`);
    const elementBytes = comps * size;
    const stride = view.byteStride || elementBytes;
    const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return { base, stride, elementBytes, count: a.count, comps, componentType: a.componentType, viewEnd: (view.byteOffset ?? 0) + view.byteLength };
}

/** Reads an accessor as numbers (normalised integers stay raw integers; the texture pass reads positions, normals and indices). */
export function readAccessor(glb: ParsedGlb, index: number): { data: Float64Array; comps: number; count: number } {
    const l = accessorLayout(glb.json, index);
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const size = COMPONENT_BYTES[l.componentType];
    const out = new Float64Array(l.count * l.comps);
    for (let e = 0; e < l.count; e++) {
        for (let c = 0; c < l.comps; c++) {
            const p = l.base + e * l.stride + c * size;
            let v: number;
            switch (l.componentType) {
                case 5126: v = dv.getFloat32(p, true); break;
                case 5125: v = dv.getUint32(p, true); break;
                case 5123: v = dv.getUint16(p, true); break;
                case 5122: v = dv.getInt16(p, true); break;
                case 5121: v = dv.getUint8(p); break;
                default: v = dv.getInt8(p);
            }
            out[e * l.comps + c] = v;
        }
    }
    return { data: out, comps: l.comps, count: l.count };
}

/** The POSITION accessor as float32, bit-exact (bytes copied, never re-rounded). */
export function readPositionsExact(glb: ParsedGlb, index: number): Float32Array {
    const l = accessorLayout(glb.json, index);
    if (l.componentType !== 5126 || l.comps !== 3) throw new Error('POSITION must be float32 VEC3');
    return new Float32Array(gatherElements(glb, index, undefined).buffer);
}

/** Raw element bytes of an accessor, in `order` (source element indices) or in the stored order; tightly packed. */
export function gatherElements(glb: ParsedGlb, index: number, order: ArrayLike<number> | undefined): Uint8Array {
    const l = accessorLayout(glb.json, index);
    const n = order ? order.length : l.count;
    const out = new Uint8Array(n * l.elementBytes);
    for (let i = 0; i < n; i++) {
        const src = order ? order[i] : i;
        if (src >= l.count) throw new Error(`accessor ${index}: element ${src} past its count ${l.count}`);
        const o = l.base + src * l.stride;
        if (o + l.elementBytes > l.viewEnd) throw new Error(`accessor ${index}: element ${src} runs past its bufferView`);
        out.set(glb.bin.subarray(o, o + l.elementBytes), i * l.elementBytes);
    }
    return out;
}

export type Mat4 = Float64Array;

function identity(): Mat4 { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
function multiply(a: Mat4, b: Mat4): Mat4 {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}
function localMatrix(node: any): Mat4 {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
    const t = node.translation ?? [0, 0, 0], q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
    const [x, y, z, w] = q;
    const m = identity();
    m[0] = (1 - 2 * (y * y + z * z)) * s[0]; m[1] = 2 * (x * y + z * w) * s[0]; m[2] = 2 * (x * z - y * w) * s[0];
    m[4] = 2 * (x * y - z * w) * s[1]; m[5] = (1 - 2 * (x * x + z * z)) * s[1]; m[6] = 2 * (y * z + x * w) * s[1];
    m[8] = 2 * (x * z + y * w) * s[2]; m[9] = 2 * (y * z - x * w) * s[2]; m[10] = (1 - 2 * (x * x + y * y)) * s[2];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
}

/** World matrix of every node (column-major), identity for nodes outside the scene tree. */
export function nodeWorldMatrices(json: any): Mat4[] {
    const nodes: any[] = json.nodes ?? [];
    const world: Array<Mat4 | undefined> = new Array(nodes.length);
    const visit = (i: number, parent: Mat4) => {
        if (world[i]) return;
        world[i] = multiply(parent, localMatrix(nodes[i]));
        for (const c of nodes[i].children ?? []) visit(c, world[i]!);
    };
    const roots = new Set<number>(nodes.map((_, i) => i));
    for (const n of nodes) for (const c of n.children ?? []) roots.delete(c);
    for (const r of roots) visit(r, identity());
    return world.map(m => m ?? identity());
}

export function isIdentity(m: Mat4): boolean {
    for (let i = 0; i < 16; i++) if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-12) return false;
    return true;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** Assembles GLB bytes from a glTF JSON object and its binary chunk. */
export function assembleGlb(json: unknown, bin: Uint8Array): Buffer {
    const pad = (b: Buffer, fill: number) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
    const jsonBuf = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
    const binBuf = pad(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), 0);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(GLB_MAGIC, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + (binBuf.length ? 8 + binBuf.length : 0), 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(CHUNK_JSON, 4);
    if (!binBuf.length) return Buffer.concat([header, jh, jsonBuf]);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(CHUNK_BIN, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, binBuf]);
}
