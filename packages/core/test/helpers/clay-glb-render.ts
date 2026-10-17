/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Independent GLB reader and software clay renderer for verification screenshots of tile geometry (top-down
 * orthographic and aerial perspective). It shares no code with the native writers it checks.
 */

import { encodePng } from '../../src/node/texture-processing';

export interface GlbTriangles {
    json: any;
    /** World-space positions (node transforms applied), 3 per vertex. */
    positions: Float32Array;
    indices: Uint32Array;
    /** Triangle range per node that carries triangles, in node order. */
    nodeRanges: Array<{ node: number; name?: string; extras?: any; firstTriangle: number; triangleCount: number }>;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function parseGlb(buffer: Buffer): { json: any; bin: Buffer } {
    if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
    if (buffer.readUInt32LE(4) !== 2) throw new Error('not a glTF 2.0 GLB');
    if (buffer.readUInt32LE(8) !== buffer.length) throw new Error(`GLB length field ${buffer.readUInt32LE(8)} != file size ${buffer.length}`);
    const jsonLength = buffer.readUInt32LE(12);
    if (buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB has no JSON chunk');
    const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
    const binHeader = 20 + jsonLength;
    const bin = binHeader + 8 <= buffer.length ? buffer.subarray(binHeader + 8, binHeader + 8 + buffer.readUInt32LE(binHeader)) : Buffer.alloc(0);
    return { json, bin };
}

export function readAccessor(json: any, bin: Buffer, index: number): { data: Float64Array; comps: number } {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const comps = COMPONENTS[acc.type];
    const size = BYTES[acc.componentType];
    const stride = view.byteStride || size * comps;
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const data = new Float64Array(acc.count * comps);
    for (let e = 0; e < acc.count; e++) {
        for (let c = 0; c < comps; c++) {
            const p = base + e * stride + c * size;
            // normalised integers (KHR_mesh_quantization, COLOR_0) as glTF defines them: max(c / (2^(bits-1) - 1), -1) signed
            switch (acc.componentType) {
                case 5126: data[e * comps + c] = bin.readFloatLE(p); break;
                case 5125: data[e * comps + c] = bin.readUInt32LE(p); break;
                case 5123: data[e * comps + c] = acc.normalized ? bin.readUInt16LE(p) / 65535 : bin.readUInt16LE(p); break;
                case 5122: data[e * comps + c] = acc.normalized ? Math.max(bin.readInt16LE(p) / 32767, -1) : bin.readInt16LE(p); break;
                case 5121: data[e * comps + c] = acc.normalized ? bin.readUInt8(p) / 255 : bin.readUInt8(p); break;
                case 5120: data[e * comps + c] = acc.normalized ? Math.max(bin.readInt8(p) / 127, -1) : bin.readInt8(p); break;
                default: throw new Error(`unsupported componentType ${acc.componentType}`);
            }
        }
    }
    return { data, comps };
}

export function nodeMatrix(node: any): number[] {
    if (Array.isArray(node.matrix)) return node.matrix;
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qw * qz) * sx, 2 * (qx * qz - qw * qy) * sx, 0,
        2 * (qx * qy - qw * qz) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qw * qx) * sy, 0,
        2 * (qx * qz + qw * qy) * sz, 2 * (qy * qz - qw * qx) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
        tx, ty, tz, 1
    ];
}

function mul(a: number[], b: number[]): number[] {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}

/**
 * Every triangle primitive of every node instance, in world space. A trees GLB with levels (scratchbox.trees-lod/1) holds
 * each tree three times (nodes tagged extras.sbLod, instanced leaf clusters under levels 0 and 1): only the `level` asked
 * for is read (default 2, the blob level every tree has whole in the file), its ranges named and tagged as its tree's, and
 * instanced nodes are not expanded (their instances are not triangles of the file).
 */
export function readGlbTriangles(buffer: Buffer, level: 0 | 1 | 2 = 2): GlbTriangles {
    const { json, bin } = parseGlb(buffer);
    const pos: number[] = [];
    const idx: number[] = [];
    const nodeRanges: GlbTriangles['nodeRanges'] = [];
    const nodes = json.nodes ?? [];
    const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_: any, i: number) => i);
    const walk = (n: number, parent: number[], tree?: any) => {
        const node = nodes[n];
        if (node.extensions?.EXT_mesh_gpu_instancing) return;
        if (node.extras?.sbLod && node.extras.sbLod.level !== level) return;
        const world = mul(parent, nodeMatrix(node));
        if (node.mesh !== undefined) {
            const first = idx.length / 3;
            for (const prim of json.meshes[node.mesh].primitives) {
                if ((prim.mode ?? 4) !== 4) continue;
                const p = readAccessor(json, bin, prim.attributes.POSITION).data;
                const base = pos.length / 3;
                for (let v = 0; v < p.length; v += 3) {
                    const x = p[v], y = p[v + 1], z = p[v + 2];
                    pos.push(world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14]);
                }
                if (prim.indices !== undefined) for (const i of readAccessor(json, bin, prim.indices).data) idx.push(base + i);
                else for (let v = 0; v < p.length / 3; v++) idx.push(base + v);
            }
            // nodes with triangles only (a node of LINES alone, such as an outline, holds none)
            if (idx.length / 3 > first) nodeRanges.push({ node: n, name: tree ? tree.name : node.name, extras: tree ? tree.extras : node.extras, firstTriangle: first, triangleCount: idx.length / 3 - first });
        }
        for (const c of node.children ?? []) walk(c, world, node.extras?.sbTree ? node : tree);
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const r of roots) walk(r, identity);
    return { json, positions: Float32Array.from(pos), indices: Uint32Array.from(idx), nodeRanges };
}

export interface ClayLayer { positions: Float32Array; indices: Uint32Array; color?: [number, number, number] }

export interface ClayView {
    kind: 'top' | 'aerial';
    width: number;
    height: number;
    /** Ground region framed, in the tile frame (x east, z south): [minX, minZ, maxX, maxZ]. Default: all geometry. */
    region?: [number, number, number, number];
    /** aerial: compass bearing of the camera from the region centre (deg, 0 = from the south) and elevation (deg). */
    bearingDeg?: number;
    elevationDeg?: number;
}

/** Lambert clay (key light + sky fill) with a z-buffer; returns PNG bytes. */
export function renderClayPng(layers: ClayLayer[], view: ClayView): Buffer {
    const W = view.width, H = view.height;
    const rgba = Buffer.alloc(W * H * 4);
    const depth = new Float32Array(W * H).fill(Infinity);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = 236; rgba[i * 4 + 1] = 237; rgba[i * 4 + 2] = 240; rgba[i * 4 + 3] = 255; }
    let [minX, minZ, maxX, maxZ] = view.region ?? [Infinity, Infinity, -Infinity, -Infinity];
    let minY = Infinity, maxY = -Infinity;
    for (const l of layers) {
        for (let v = 0; v < l.positions.length; v += 3) {
            if (!view.region) {
                minX = Math.min(minX, l.positions[v]); maxX = Math.max(maxX, l.positions[v]);
                minZ = Math.min(minZ, l.positions[v + 2]); maxZ = Math.max(maxZ, l.positions[v + 2]);
            }
            minY = Math.min(minY, l.positions[v + 1]); maxY = Math.max(maxY, l.positions[v + 1]);
        }
    }
    if (!Number.isFinite(minX)) return encodePng(W, H, rgba);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    // aim at the ground of the framed region: a low percentile of the vertex heights inside it
    const inside: number[] = [];
    for (const l of layers) {
        for (let v = 0; v < l.positions.length; v += 3) {
            const x = l.positions[v], z = l.positions[v + 2];
            if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) inside.push(l.positions[v + 1]);
        }
    }
    inside.sort((a, b) => a - b);
    const cy = inside.length ? inside[Math.floor(inside.length * 0.2)] : (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    // camera basis
    let project: (x: number, y: number, z: number) => [number, number, number];
    if (view.kind === 'top') {
        const s = Math.min(W, H) / span;
        project = (x, y, z) => [W / 2 + (x - cx) * s, H / 2 + (z - cz) * s, -y];
    } else {
        const b = ((view.bearingDeg ?? 210) * Math.PI) / 180, e = ((view.elevationDeg ?? 35) * Math.PI) / 180;
        const dist = span * 1.45;
        const dir = [Math.sin(b) * Math.cos(e), Math.sin(e), Math.cos(b) * Math.cos(e)]; // from target to eye (z = south)
        const eye = [cx + dir[0] * dist, cy + dir[1] * dist, cz + dir[2] * dist];
        const fwd = [-dir[0], -dir[1], -dir[2]];
        // right = fwd x worldUp, up = right x fwd (x east, y up, z south)
        const rl = Math.hypot(fwd[2], fwd[0]) || 1;
        const right = [-fwd[2] / rl, 0, fwd[0] / rl];
        const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
        const f = (W / 2) / Math.tan((40 * Math.PI) / 180 / 2);
        project = (x, y, z) => {
            const d = [x - eye[0], y - eye[1], z - eye[2]];
            const cz2 = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
            const cx2 = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
            const cy2 = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
            if (cz2 <= 0.5) return [NaN, NaN, NaN];
            return [W / 2 + (cx2 / cz2) * f, H / 2 - (cy2 / cz2) * f, cz2];
        };
    }
    const L = [-0.45, 0.8, 0.4];
    const ll = Math.hypot(L[0], L[1], L[2]);
    for (const layer of layers) {
        const col = layer.color ?? [0.55, 0.57, 0.6];
        const P = layer.positions, I = layer.indices;
        const sx = new Float32Array(P.length / 3), sy = new Float32Array(P.length / 3), sz = new Float32Array(P.length / 3);
        for (let v = 0; v < P.length / 3; v++) {
            const [a, b, c] = project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
            sx[v] = a; sy[v] = b; sz[v] = c;
        }
        const margin = view.region ? span * 0.15 : Infinity;
        for (let t = 0; t < I.length; t += 3) {
            const i0 = I[t], i1 = I[t + 1], i2 = I[t + 2];
            if (!Number.isFinite(sz[i0]) || !Number.isFinite(sz[i1]) || !Number.isFinite(sz[i2])) continue;
            const gx = (P[i0 * 3] + P[i1 * 3] + P[i2 * 3]) / 3, gz = (P[i0 * 3 + 2] + P[i1 * 3 + 2] + P[i2 * 3 + 2]) / 3;
            if (gx < minX - margin || gx > maxX + margin || gz < minZ - margin || gz > maxZ + margin) continue;
            const ax = P[i1 * 3] - P[i0 * 3], ay = P[i1 * 3 + 1] - P[i0 * 3 + 1], az = P[i1 * 3 + 2] - P[i0 * 3 + 2];
            const bx = P[i2 * 3] - P[i0 * 3], by = P[i2 * 3 + 1] - P[i0 * 3 + 1], bz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
            let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const nl = Math.hypot(nx, ny, nz);
            if (nl < 1e-12) continue;
            nx /= nl; ny /= nl; nz /= nl;
            const lambert = Math.abs(nx * L[0] + ny * L[1] + nz * L[2]) / ll;
            const shade = 0.32 + 0.5 * lambert + 0.18 * Math.abs(ny);
            const r = Math.min(255, col[0] * 255 * shade * 1.35), g = Math.min(255, col[1] * 255 * shade * 1.35), bl = Math.min(255, col[2] * 255 * shade * 1.35);
            const x0 = Math.max(0, Math.floor(Math.min(sx[i0], sx[i1], sx[i2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[i0], sx[i1], sx[i2])));
            const y0 = Math.max(0, Math.floor(Math.min(sy[i0], sy[i1], sy[i2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[i0], sy[i1], sy[i2])));
            const d = (sx[i1] - sx[i0]) * (sy[i2] - sy[i0]) - (sx[i2] - sx[i0]) * (sy[i1] - sy[i0]);
            if (Math.abs(d) < 1e-9) continue;
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const px = x + 0.5, py = y + 0.5;
                    const w1 = ((px - sx[i0]) * (sy[i2] - sy[i0]) - (sx[i2] - sx[i0]) * (py - sy[i0])) / d;
                    const w2 = ((sx[i1] - sx[i0]) * (py - sy[i0]) - (px - sx[i0]) * (sy[i1] - sy[i0])) / d;
                    const w0 = 1 - w1 - w2;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const z = w0 * sz[i0] + w1 * sz[i1] + w2 * sz[i2];
                    const o = y * W + x;
                    if (z >= depth[o]) continue;
                    depth[o] = z;
                    rgba[o * 4] = r; rgba[o * 4 + 1] = g; rgba[o * 4 + 2] = bl;
                }
            }
        }
    }
    return encodePng(W, H, rgba);
}
