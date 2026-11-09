/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fixtures and an independent software renderer for the UV unwrap / rewrap tests. The renderer shares no code with
 * UvAtlasRewrap.ts or the native engine (its own GLB reader, tangents, sampling and rasteriser), so render comparisons
 * of the input and the rewrapped output compare what any glTF viewer would draw.
 *
 * Renderer conventions (glTF 2.0): UV (0,0) is the image's top-left corner; bilinear sampling with the sampler's wrap
 * modes; KHR_texture_transform applied; the normal map's +Y is the image's up and bitangent = cross(N, T) * w, with T and
 * w from TANGENT, else built per vertex from the normal map's UVs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jpeg from 'jpeg-js';
import { decodePng } from './png-decode';
import { encodeRgbaToPng } from './test-screenshot-helper';

export const UV_REWRAP_SHOT_DIR = path.resolve(__dirname, '../../../..', 'test-results/screenshots/uv_rewrap');

type V3 = [number, number, number];

// =============================================================================
// GLB builder
// =============================================================================

export interface FixturePrimitive {
    positions: number[];
    indices: number[];
    normals?: number[];
    tangents?: number[];
    uvs?: number[][];          // TEXCOORD_n
    material?: number;
    /** The node's name (a part id). */
    name?: string;
}

export interface FixtureScene {
    primitives: FixturePrimitive[];
    materials?: any[];
    textures?: any[];
    images?: Buffer[];          // PNG/JPEG bytes
    samplers?: any[];
    extensionsUsed?: string[];
}

export function buildFixtureGlb(scene: FixtureScene): Buffer {
    const chunks: Buffer[] = [];
    const bufferViews: any[] = [];
    const accessors: any[] = [];
    let offset = 0;
    const push = (b: Buffer, target?: number) => {
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, ...(target ? { target } : {}) });
        chunks.push(b); offset += b.length;
        return bufferViews.length - 1;
    };
    const f32acc = (a: number[], type: string, comps: number, minmax = false) => {
        const b = Buffer.from(new Float32Array(a).buffer);
        const acc: any = { bufferView: push(b, 34962), componentType: 5126, count: a.length / comps, type };
        if (minmax) {
            acc.min = [0, 1, 2].map(c => Math.min(...a.filter((_, i) => i % 3 === c)));
            acc.max = [0, 1, 2].map(c => Math.max(...a.filter((_, i) => i % 3 === c)));
        }
        accessors.push(acc);
        return accessors.length - 1;
    };
    const meshes = scene.primitives.map(p => {
        const attributes: Record<string, number> = { POSITION: f32acc(p.positions, 'VEC3', 3, true) };
        if (p.normals) attributes.NORMAL = f32acc(p.normals, 'VEC3', 3);
        if (p.tangents) attributes.TANGENT = f32acc(p.tangents, 'VEC4', 4);
        (p.uvs ?? []).forEach((uv, k) => { attributes[`TEXCOORD_${k}`] = f32acc(uv, 'VEC2', 2); });
        const ib = Buffer.from(new Uint32Array(p.indices).buffer);
        accessors.push({ bufferView: push(ib, 34963), componentType: 5125, count: p.indices.length, type: 'SCALAR' });
        return { primitives: [{ attributes, indices: accessors.length - 1, ...(p.material !== undefined ? { material: p.material } : {}) }] };
    });
    const images = (scene.images ?? []).map(b => ({ bufferView: push(b), mimeType: b[0] === 0x89 ? 'image/png' : 'image/jpeg' }));
    const json: any = {
        asset: { version: '2.0', generator: 'uv-rewrap-fixtures' },
        scene: 0, scenes: [{ nodes: meshes.map((_, i) => i) }],
        nodes: meshes.map((_, i) => ({ mesh: i, ...(scene.primitives[i].name ? { name: scene.primitives[i].name } : {}) })), meshes, accessors, bufferViews,
        buffers: [{ byteLength: offset }]
    };
    if (scene.materials) json.materials = scene.materials;
    if (scene.textures) json.textures = scene.textures;
    if (images.length) json.images = images;
    if (scene.samplers) json.samplers = scene.samplers;
    if (scene.extensionsUsed) json.extensionsUsed = scene.extensionsUsed;
    const bin = Buffer.concat(chunks);
    const jsonBuf = Buffer.from(JSON.stringify(json));
    const jpad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
    const bpad = Buffer.alloc((4 - (bin.length % 4)) % 4);
    const J = Buffer.concat([jsonBuf, jpad]), B = Buffer.concat([bin, bpad]);
    const head = Buffer.alloc(12);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + B.length, 8);
    const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    return Buffer.concat([head, ch(J.length, 0x4e4f534a), J, ch(B.length, 0x004e4942), B]);
}

// =============================================================================
// Meshes (no UVs unless stated)
// =============================================================================

/** Unit-ish cube with split normals (24 vertices). */
export function cubeMesh(size = 1): FixturePrimitive {
    const h = size / 2;
    const faces: Array<{ n: V3; u: V3; v: V3 }> = [
        { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
        { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
        { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
    ];
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (const f of faces) {
        const b = positions.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            for (let c = 0; c < 3; c++) positions.push(h * (f.n[c] + su * f.u[c] + sv * f.v[c]));
            normals.push(...f.n);
        }
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    return { positions, normals, indices };
}

/** Capped cylinder along +Y, welded side (one ring vertex per angle) and separate caps. */
export function cylinderMesh(radius = 0.5, height = 2, segments = 48, rings = 12): FixturePrimitive {
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (let r = 0; r <= rings; r++) for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        positions.push(radius * Math.cos(a), -height / 2 + (r / rings) * height, -radius * Math.sin(a));
        normals.push(Math.cos(a), 0, -Math.sin(a));
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
        const a = r * segments + s, b = r * segments + (s + 1) % segments, c = a + segments, d = b + segments;
        indices.push(a, b, d, a, d, c);
    }
    for (const [y, ny] of [[height / 2, 1], [-height / 2, -1]]) {
        const centre = positions.length / 3;
        positions.push(0, y, 0); normals.push(0, ny, 0);
        const ring = positions.length / 3;
        for (let s = 0; s < segments; s++) {
            const a = (s / segments) * Math.PI * 2;
            positions.push(radius * Math.cos(a), y, -radius * Math.sin(a)); normals.push(0, ny, 0);
        }
        for (let s = 0; s < segments; s++) {
            const i = ring + s, j = ring + (s + 1) % segments;
            if (ny > 0) indices.push(centre, i, j); else indices.push(centre, j, i);
        }
    }
    return { positions, normals, indices };
}

/** Welded icosphere (smooth normals), `subdivisions` 4 gives 5120 triangles. */
export function icosphereMesh(radius = 1, subdivisions = 4): FixturePrimitive {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts: V3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const norm = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
    verts = verts.map(norm);
    for (let s = 0; s < subdivisions; s++) {
        const mid = new Map<string, number>();
        const m = (a: number, b: number) => {
            const k = a < b ? `${a},${b}` : `${b},${a}`;
            let i = mid.get(k);
            if (i === undefined) { i = verts.length; verts.push(norm([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2])); mid.set(k, i); }
            return i;
        };
        faces = faces.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
    }
    return { positions: verts.flatMap(v => v.map(x => x * radius)), normals: verts.flatMap(v => v), indices: faces.flat() };
}

/** Lat-long UV sphere with a duplicated seam column (TEXCOORD_0 = equirectangular), smooth normals and TANGENT. */
export function uvSphereMesh(radius = 1, lon = 64, lat = 32): FixturePrimitive {
    const positions: number[] = [], normals: number[] = [], uv: number[] = [], tangents: number[] = [], indices: number[] = [];
    for (let j = 0; j <= lat; j++) for (let i = 0; i <= lon; i++) {
        const u = i / lon, v = j / lat;
        const th = u * Math.PI * 2, ph = v * Math.PI;
        const n: V3 = [Math.sin(ph) * Math.cos(th), Math.cos(ph), -Math.sin(ph) * Math.sin(th)];
        positions.push(n[0] * radius, n[1] * radius, n[2] * radius);
        normals.push(...n);
        uv.push(u, v);
        // dP/du direction (east), w so that cross(N, T) * w points to the image's up (-v = toward the north pole)
        const T: V3 = [-Math.sin(th), 0, -Math.cos(th)];
        const B: V3 = [n[1] * T[2] - n[2] * T[1], n[2] * T[0] - n[0] * T[2], n[0] * T[1] - n[1] * T[0]];
        const north: V3 = [-Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
        tangents.push(...T, B[0] * north[0] + B[1] * north[1] + B[2] * north[2] >= 0 ? 1 : -1);
    }
    for (let j = 0; j < lat; j++) for (let i = 0; i < lon; i++) {
        const a = j * (lon + 1) + i, b = a + 1, c = a + lon + 1, d = c + 1;
        if (j > 0) indices.push(a, c, b);
        if (j < lat - 1) indices.push(b, c, d);
    }
    return { positions, normals, indices, uvs: [uv], tangents };
}

// =============================================================================
// Images
// =============================================================================

export function pngOf(width: number, height: number, px: (x: number, y: number) => [number, number, number, number?]): Buffer {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const [r, g, b, a] = px(x, y);
        rgba.set([r, g, b, a ?? 255], (y * width + x) * 4);
    }
    return encodeRgbaToPng(width, height, rgba);
}

/** Two-colour checker with `cells` cells per side and a coloured gradient so mirrored or swapped regions show. */
export function checkerPng(size = 256, cells = 8): Buffer {
    return pngOf(size, size, (x, y) => {
        const on = ((Math.floor(x * cells / size) + Math.floor(y * cells / size)) & 1) === 1;
        const r = Math.round(40 + 180 * x / size), g = Math.round(40 + 180 * y / size);
        return on ? [r, g, 230] : [230 - r / 3, 230 - g / 3, 40];
    });
}

/** Tangent-space normal map of smooth bumps (height h = sin(a x) sin(b y)), glTF convention (+Y = image up). */
export function bumpNormalPng(size = 256, bumps = 6, strength = 0.6): Buffer {
    const k = (bumps * Math.PI * 2) / size;
    return pngOf(size, size, (x, y) => {
        const hx = strength * Math.cos(k * (x + 0.5)) * Math.sin(k * (y + 0.5));
        const hy = strength * Math.sin(k * (x + 0.5)) * Math.cos(k * (y + 0.5));
        // gradient along image y (down) -> tangent-space +Y is up, so dh/d(up) = -dh/dy
        const n: V3 = [-hx, hy, 1];
        const l = Math.hypot(...n);
        return [Math.round((n[0] / l * 0.5 + 0.5) * 255), Math.round((n[1] / l * 0.5 + 0.5) * 255), Math.round((n[2] / l * 0.5 + 0.5) * 255)];
    });
}

// =============================================================================
// Independent reader and renderer
// =============================================================================

interface Img { w: number; h: number; px: Uint8Array }
interface Tex { img: Img; wrapS: number; wrapT: number; texCoord: number; xf?: (u: number, v: number) => [number, number] }
interface RPrim {
    pos: Float64Array; nrm?: Float64Array; tan?: Float64Array; uvs: Float64Array[]; idx: Uint32Array;
    base?: Tex; normal?: Tex; baseFactor: number[]; unlit: boolean;
}

function decodeImage(bytes: Buffer): Img {
    if (bytes[0] === 0x89) {
        const d = decodePng(bytes);
        const px = new Uint8Array(d.width * d.height * 4);
        for (let i = 0; i < d.width * d.height; i++) {
            if (d.channels === 4) px.set(d.pixels.subarray(i * 4, i * 4 + 4), i * 4);
            else if (d.channels === 3) px.set([d.pixels[i * 3], d.pixels[i * 3 + 1], d.pixels[i * 3 + 2], 255], i * 4);
            else px.set([d.pixels[i], d.pixels[i], d.pixels[i], 255], i * 4);
        }
        return { w: d.width, h: d.height, px };
    }
    const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { w: d.width, h: d.height, px: d.data };
}

function readGlb(buf: Buffer) {
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    const bo = 20 + jl;
    const bin = bo + 8 <= buf.length ? buf.subarray(bo + 8, bo + 8 + buf.readUInt32LE(bo)) : Buffer.alloc(0);
    const comps: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const size: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const acc = (i: number): Float64Array => {
        const a = json.accessors[i];
        const c = comps[a.type], s = size[a.componentType];
        const out = new Float64Array(a.count * c);
        if (a.bufferView === undefined) return out;
        const v = json.bufferViews[a.bufferView];
        const stride = v.byteStride || c * s, base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
        for (let e = 0; e < a.count; e++) for (let k = 0; k < c; k++) {
            const p = base + e * stride + k * s;
            let x: number;
            switch (a.componentType) {
                case 5126: x = bin.readFloatLE(p); break;
                case 5125: x = bin.readUInt32LE(p); break;
                case 5123: x = bin.readUInt16LE(p); if (a.normalized) x /= 65535; break;
                case 5121: x = bin.readUInt8(p); if (a.normalized) x /= 255; break;
                case 5122: x = bin.readInt16LE(p); if (a.normalized) x = Math.max(x / 32767, -1); break;
                default: x = bin.readInt8(p); if (a.normalized) x = Math.max(x / 127, -1);
            }
            out[e * c + k] = x;
        }
        return out;
    };
    const images = new Map<number, Img>();
    const image = (i: number) => {
        let im = images.get(i);
        if (!im) {
            const v = json.bufferViews[json.images[i].bufferView];
            im = decodeImage(Buffer.from(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)));
            images.set(i, im);
        }
        return im;
    };
    const tex = (info: any): Tex | undefined => {
        if (!info) return undefined;
        const t = json.textures[info.index];
        const smp = t.sampler !== undefined ? json.samplers[t.sampler] : {};
        const tt = info.extensions?.KHR_texture_transform;
        let xf: Tex['xf'];
        if (tt) {
            const [ox, oy] = tt.offset ?? [0, 0], r = tt.rotation ?? 0, [sx, sy] = tt.scale ?? [1, 1];
            const c = Math.cos(r), s = Math.sin(r);
            xf = (u, v) => [c * sx * u + s * sy * v + ox, -s * sx * u + c * sy * v + oy];
        }
        return { img: image(t.source), wrapS: smp.wrapS ?? 10497, wrapT: smp.wrapT ?? 10497, texCoord: tt?.texCoord ?? info.texCoord ?? 0, xf };
    };
    return { json, acc, tex };
}

function mat4(node: any): number[] {
    if (node.matrix) return node.matrix;
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1], [tx, ty, tz] = node.translation ?? [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}

/** Per-vertex tangents for the renderer (own implementation): T along +u, w so cross(N,T)*w points along -v. */
function rendererTangents(pos: Float64Array, nrm: Float64Array, uv: Float64Array, idx: Uint32Array): Float64Array {
    const n = pos.length / 3;
    const T = new Float64Array(n * 3), B = new Float64Array(n * 3), out = new Float64Array(n * 4);
    for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
        const e1 = [0, 1, 2].map(k => pos[b * 3 + k] - pos[a * 3 + k]), e2 = [0, 1, 2].map(k => pos[c * 3 + k] - pos[a * 3 + k]);
        const s1 = uv[b * 2] - uv[a * 2], t1 = uv[b * 2 + 1] - uv[a * 2 + 1], s2 = uv[c * 2] - uv[a * 2], t2 = uv[c * 2 + 1] - uv[a * 2 + 1];
        const r = s1 * t2 - s2 * t1;
        if (Math.abs(r) < 1e-20) continue;
        for (const v of [a, b, c]) for (let k = 0; k < 3; k++) { T[v * 3 + k] += (e1[k] * t2 - e2[k] * t1) / r; B[v * 3 + k] += (e2[k] * s1 - e1[k] * s2) / r; }
    }
    for (let v = 0; v < n; v++) {
        const N = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
        let t = [T[v * 3], T[v * 3 + 1], T[v * 3 + 2]];
        const d = t[0] * N[0] + t[1] * N[1] + t[2] * N[2];
        t = [t[0] - N[0] * d, t[1] - N[1] * d, t[2] - N[2] * d];
        const l = Math.hypot(t[0], t[1], t[2]) || 1;
        t = t.map(x => x / l);
        const cx = [N[1] * t[2] - N[2] * t[1], N[2] * t[0] - N[0] * t[2], N[0] * t[1] - N[1] * t[0]];
        const w = cx[0] * B[v * 3] + cx[1] * B[v * 3 + 1] + cx[2] * B[v * 3 + 2] > 0 ? -1 : 1;
        out.set([t[0], t[1], t[2], w], v * 4);
    }
    return out;
}

function readScene(buf: Buffer): RPrim[] {
    const { json, acc, tex } = readGlb(buf);
    const prims: RPrim[] = [];
    const visit = (ni: number, parent: number[]) => {
        const node = json.nodes[ni];
        const l = mat4(node);
        const M = new Array(16).fill(0);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) M[c * 4 + r] += parent[k * 4 + r] * l[c * 4 + k];
        if (node.mesh !== undefined) for (const p of json.meshes[node.mesh].primitives) {
            const P = acc(p.attributes.POSITION), n = P.length / 3;
            const pos = new Float64Array(n * 3);
            for (let v = 0; v < n; v++) for (let r = 0; r < 3; r++) pos[v * 3 + r] = M[r] * P[v * 3] + M[4 + r] * P[v * 3 + 1] + M[8 + r] * P[v * 3 + 2] + M[12 + r];
            const idx = p.indices !== undefined ? Uint32Array.from(acc(p.indices)) : Uint32Array.from({ length: n }, (_, i) => i);
            const dirs = (a: Float64Array | undefined, stride: number) => {
                if (!a) return undefined;
                const o = new Float64Array(n * stride);
                for (let v = 0; v < n; v++) {
                    const d = [0, 1, 2].map(r => M[r] * a[v * stride] + M[4 + r] * a[v * stride + 1] + M[8 + r] * a[v * stride + 2]);
                    const ll = Math.hypot(d[0], d[1], d[2]) || 1;
                    o.set(d.map(x => x / ll), v * stride);
                    if (stride === 4) o[v * 4 + 3] = a[v * 4 + 3];
                }
                return o;
            };
            const nrm = dirs(p.attributes.NORMAL !== undefined ? acc(p.attributes.NORMAL) : undefined, 3);
            const uvs: Float64Array[] = [];
            for (let k = 0; p.attributes[`TEXCOORD_${k}`] !== undefined; k++) uvs.push(acc(p.attributes[`TEXCOORD_${k}`]));
            const m = p.material !== undefined ? json.materials[p.material] : {};
            const base = tex(m.pbrMetallicRoughness?.baseColorTexture);
            const normal = tex(m.normalTexture);
            let tan = dirs(p.attributes.TANGENT !== undefined ? acc(p.attributes.TANGENT) : undefined, 4);
            if (!tan && normal && nrm && uvs[normal.texCoord]) {
                const uv = uvs[normal.texCoord];
                const tuv = new Float64Array(uv.length);
                for (let v = 0; v < uv.length / 2; v++) { const r = normal.xf ? normal.xf(uv[v * 2], uv[v * 2 + 1]) : [uv[v * 2], uv[v * 2 + 1]]; tuv[v * 2] = r[0]; tuv[v * 2 + 1] = r[1]; }
                tan = rendererTangents(pos, nrm, tuv, idx);
            }
            prims.push({ pos, nrm, tan, uvs, idx, base, normal, baseFactor: m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1], unlit: !!m.extensions?.KHR_materials_unlit });
        }
        for (const c of node.children ?? []) visit(c, M);
    };
    const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? json.nodes.map((_: any, i: number) => i);
    for (const r of roots) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    return prims;
}

function wrap(i: number, n: number, mode: number) {
    if (mode === 33071) return Math.min(n - 1, Math.max(0, i));
    if (mode === 33648) { const p = 2 * n, m = ((i % p) + p) % p; return m < n ? m : p - 1 - m; }
    return ((i % n) + n) % n;
}

function sample(t: Tex, u: number, v: number, out: number[]) {
    if (t.xf) [u, v] = t.xf(u, v);
    const { w, h, px } = t.img;
    const x = u * w - 0.5, y = v * h - 0.5, fx = Math.floor(x), fy = Math.floor(y), ax = x - fx, ay = y - fy;
    const x0 = wrap(fx, w, t.wrapS), x1 = wrap(fx + 1, w, t.wrapS), y0 = wrap(fy, h, t.wrapT), y1 = wrap(fy + 1, h, t.wrapT);
    for (let c = 0; c < 4; c++) {
        out[c] = ((1 - ax) * (1 - ay) * px[(y0 * w + x0) * 4 + c] + ax * (1 - ay) * px[(y0 * w + x1) * 4 + c]
            + (1 - ax) * ay * px[(y1 * w + x0) * 4 + c] + ax * ay * px[(y1 * w + x1) * 4 + c]) / 255;
    }
}

export interface RenderCamera { eye: V3; target: V3; up?: V3; fovDeg?: number; width?: number; height?: number }
export type RenderShading = 'albedo' | 'lit' | 'normal' | 'checker';
export interface Rendered { width: number; height: number; rgba: Uint8Array; mask: Uint8Array }

/** Orbit camera around the scene's bounding sphere. */
export function orbitCamera(glb: Buffer, azimuthDeg: number, elevationDeg: number, size = 320, distanceScale = 2.6): RenderCamera {
    const prims = readScene(glb);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of prims) for (let v = 0; v < p.pos.length / 3; v++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.pos[v * 3 + k]); mx[k] = Math.max(mx[k], p.pos[v * 3 + k]); }
    const c: V3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const r = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2;
    const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180, d = r * distanceScale;
    return { eye: [c[0] + d * Math.cos(el) * Math.sin(az), c[1] + d * Math.sin(el), c[2] + d * Math.cos(el) * Math.cos(az)], target: c, fovDeg: 45, width: size, height: size };
}

/** Rasterises a GLB with a perspective camera. 'checker' colours UV set `checkerSet` with a 16x16 checker. */
export function renderGlb(glb: Buffer, cam: RenderCamera, shading: RenderShading, opts: { checkerSet?: number; light?: V3 } = {}): Rendered {
    const W = cam.width ?? 320, H = cam.height ?? 320;
    const prims = readScene(glb);
    const up = cam.up ?? [0, 1, 0];
    const f = [cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]); const fw = f.map(x => x / fl);
    let rt = [fw[1] * up[2] - fw[2] * up[1], fw[2] * up[0] - fw[0] * up[2], fw[0] * up[1] - fw[1] * up[0]];
    const rl = Math.hypot(rt[0], rt[1], rt[2]); rt = rt.map(x => x / rl);
    const uu = [rt[1] * fw[2] - rt[2] * fw[1], rt[2] * fw[0] - rt[0] * fw[2], rt[0] * fw[1] - rt[1] * fw[0]];
    const focal = (H / 2) / Math.tan(((cam.fovDeg ?? 45) * Math.PI / 180) / 2);
    const L0 = opts.light ?? [0.4, 0.8, 0.45];
    const ll = Math.hypot(...L0); const L = L0.map(x => x / ll);
    const depth = new Float64Array(W * H).fill(Infinity);
    const rgba = new Uint8Array(W * H * 4), mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) rgba.set([24, 26, 30, 255], i * 4);
    const c4 = [0, 0, 0, 0], n4 = [0, 0, 0, 0];
    for (const p of prims) {
        const n = p.pos.length / 3;
        const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
        for (let v = 0; v < n; v++) {
            const d = [p.pos[v * 3] - cam.eye[0], p.pos[v * 3 + 1] - cam.eye[1], p.pos[v * 3 + 2] - cam.eye[2]];
            const z = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
            sz[v] = z;
            sx[v] = W / 2 + focal * (d[0] * rt[0] + d[1] * rt[1] + d[2] * rt[2]) / z;
            sy[v] = H / 2 - focal * (d[0] * uu[0] + d[1] * uu[1] + d[2] * uu[2]) / z;
        }
        for (let t = 0; t < p.idx.length; t += 3) {
            const a = p.idx[t], b = p.idx[t + 1], c = p.idx[t + 2];
            if (sz[a] < 1e-3 || sz[b] < 1e-3 || sz[c] < 1e-3) continue;
            const den = (sy[b] - sy[c]) * (sx[a] - sx[c]) + (sx[c] - sx[b]) * (sy[a] - sy[c]);
            if (Math.abs(den) < 1e-12) continue;
            const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
            const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                let l0 = ((sy[b] - sy[c]) * (px - sx[c]) + (sx[c] - sx[b]) * (py - sy[c])) / den;
                let l1 = ((sy[c] - sy[a]) * (px - sx[c]) + (sx[a] - sx[c]) * (py - sy[c])) / den;
                let l2 = 1 - l0 - l1;
                if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                // perspective-correct
                const w0 = l0 / sz[a], w1 = l1 / sz[b], w2 = l2 / sz[c], ws = w0 + w1 + w2;
                const zz = 1 / ws;
                const i = y * W + x;
                if (zz >= depth[i]) continue;
                depth[i] = zz;
                l0 = w0 / ws; l1 = w1 / ws; l2 = w2 / ws;
                const I3 = (arr: Float64Array, s: number, k: number) => arr[a * s + k] * l0 + arr[b * s + k] * l1 + arr[c * s + k] * l2;
                const e1 = [0, 1, 2].map(k => p.pos[b * 3 + k] - p.pos[a * 3 + k]), e2 = [0, 1, 2].map(k => p.pos[c * 3 + k] - p.pos[a * 3 + k]);
                let gN = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const gl = Math.hypot(gN[0], gN[1], gN[2]) || 1; gN = gN.map(q => q / gl);
                let N = p.nrm ? [I3(p.nrm, 3, 0), I3(p.nrm, 3, 1), I3(p.nrm, 3, 2)] : gN;
                const nl = Math.hypot(N[0], N[1], N[2]) || 1; N = N.map(q => q / nl);
                if (p.normal && p.tan) {
                    const uv = p.uvs[p.normal.texCoord];
                    sample(p.normal, I3(uv, 2, 0), I3(uv, 2, 1), n4);
                    let ts = [n4[0] * 2 - 1, n4[1] * 2 - 1, n4[2] * 2 - 1];
                    const tl = Math.hypot(ts[0], ts[1], ts[2]) || 1; ts = ts.map(q => q / tl);
                    let T = [I3(p.tan, 4, 0), I3(p.tan, 4, 1), I3(p.tan, 4, 2)];
                    const d = T[0] * N[0] + T[1] * N[1] + T[2] * N[2];
                    T = [T[0] - N[0] * d, T[1] - N[1] * d, T[2] - N[2] * d];
                    const tl2 = Math.hypot(T[0], T[1], T[2]) || 1; T = T.map(q => q / tl2);
                    const w = p.tan[a * 4 + 3] < 0 ? -1 : 1;
                    const B = [(N[1] * T[2] - N[2] * T[1]) * w, (N[2] * T[0] - N[0] * T[2]) * w, (N[0] * T[1] - N[1] * T[0]) * w];
                    N = [0, 1, 2].map(k => ts[0] * T[k] + ts[1] * B[k] + ts[2] * N[k]);
                    const l3 = Math.hypot(N[0], N[1], N[2]) || 1; N = N.map(q => q / l3);
                }
                let col: number[];
                if (shading === 'normal') col = N.map(q => (q * 0.5 + 0.5) * 255);
                else if (shading === 'checker') {
                    const uv = p.uvs[opts.checkerSet ?? 0];
                    const u = uv ? I3(uv, 2, 0) : 0, v = uv ? I3(uv, 2, 1) : 0;
                    const on = ((Math.floor(u * 16) + Math.floor(v * 16)) & 1) === 1;
                    const sh = 0.35 + 0.65 * Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2]);
                    col = (on ? [235, 120, 60] : [70, 160, 235]).map(q => q * sh);
                } else {
                    // glTF: factor (linear) times the sRGB-decoded texture, shown re-encoded to sRGB
                    const lin = [p.baseFactor[0], p.baseFactor[1], p.baseFactor[2]];
                    if (p.base) {
                        const uv = p.uvs[p.base.texCoord];
                        sample(p.base, I3(uv, 2, 0), I3(uv, 2, 1), c4);
                        for (let k = 0; k < 3; k++) lin[k] *= c4[k] <= 0.04045 ? c4[k] / 12.92 : Math.pow((c4[k] + 0.055) / 1.055, 2.4);
                    }
                    const base = lin.map(q => { const c = Math.max(0, Math.min(1, q)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); });
                    const sh = shading === 'lit' && !p.unlit ? 0.3 + 0.7 * Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2]) : 1;
                    col = base.map(q => q * sh);
                }
                rgba.set([Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255].map(q => Math.max(0, Math.min(255, q))), i * 4);
                mask[i] = 1;
            }
        }
    }
    return { width: W, height: H, rgba, mask };
}

export interface RenderDiff { pixels: number; meanAbs: number; rms: number; p99: number; maxAbs: number; over8: number; maskMismatch: number }

/** Per-channel difference (0..255) over pixels both renders cover. */
export function diffRenders(a: Rendered, b: Rendered): RenderDiff {
    const vals: number[] = [];
    let sum = 0, sq = 0, maxAbs = 0, over8 = 0, mism = 0;
    for (let i = 0; i < a.mask.length; i++) {
        if (a.mask[i] !== b.mask[i]) { mism++; continue; }
        if (!a.mask[i]) continue;
        let m = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(a.rgba[i * 4 + c] - b.rgba[i * 4 + c]); sum += d; sq += d * d; m = Math.max(m, d); }
        vals.push(m); maxAbs = Math.max(maxAbs, m); if (m > 8) over8++;
    }
    vals.sort((x, y) => x - y);
    const n = vals.length;
    return { pixels: n, meanAbs: n ? sum / (n * 3) : 0, rms: n ? Math.sqrt(sq / (n * 3)) : 0, p99: n ? vals[Math.floor(n * 0.99)] : 0, maxAbs, over8, maskMismatch: mism };
}

/** Saves renders side by side (with a gap) as one PNG under test-results/screenshots/uv_rewrap/. */
export function saveSideBySide(name: string, renders: Rendered[]): string {
    const gap = 6, W = renders.reduce((a, r) => a + r.width, 0) + gap * (renders.length - 1), H = Math.max(...renders.map(r => r.height));
    const out = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) out.set([255, 255, 255, 255], i * 4);
    let x0 = 0;
    for (const r of renders) {
        for (let y = 0; y < r.height; y++) Buffer.from(r.rgba.buffer, r.rgba.byteOffset + y * r.width * 4, r.width * 4).copy(out, (y * W + x0) * 4);
        x0 += r.width + gap;
    }
    fs.mkdirSync(UV_REWRAP_SHOT_DIR, { recursive: true });
    const file = path.join(UV_REWRAP_SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, encodeRgbaToPng(W, H, out));
    return file;
}

/** The atlas layout: every UV triangle of the GLB's TEXCOORD set filled per chart colour over the given image. */
export function uvLayoutImage(glb: Buffer, set = 0, size = 512, background?: { width: number; height: number; rgba: Uint8Array }): Rendered {
    const { json, acc } = readGlb(glb);
    const rgba = new Uint8Array(size * size * 4), mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (background) {
            const bx = Math.min(background.width - 1, Math.floor(x * background.width / size)), by = Math.min(background.height - 1, Math.floor(y * background.height / size));
            rgba.set(background.rgba.subarray((by * background.width + bx) * 4, (by * background.width + bx) * 4 + 3), i * 4);
            rgba[i * 4 + 3] = 255;
        } else rgba.set([30, 32, 36, 255], i * 4);
    }
    for (const m of json.meshes) for (const p of m.primitives) {
        const uvAcc = p.attributes[`TEXCOORD_${set}`];
        if (uvAcc === undefined) continue;
        const uv = acc(uvAcc);
        const idx = p.indices !== undefined ? acc(p.indices) : Float64Array.from({ length: uv.length / 2 }, (_, i) => i);
        for (let t = 0; t < idx.length; t += 3) {
            const pts = [0, 1, 2].map(k => [uv[idx[t + k] * 2] * size, uv[idx[t + k] * 2 + 1] * size]);
            // outline only, so the baked image shows through
            for (let e = 0; e < 3; e++) {
                const [x0, y0] = pts[e], [x1, y1] = pts[(e + 1) % 3];
                const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
                for (let s = 0; s <= steps; s++) {
                    const x = Math.floor(x0 + (x1 - x0) * s / steps), y = Math.floor(y0 + (y1 - y0) * s / steps);
                    if (x >= 0 && y >= 0 && x < size && y < size) { rgba.set([255, 255, 255, 255], (y * size + x) * 4); mask[y * size + x] = 1; }
                }
            }
        }
    }
    return { width: size, height: size, rgba, mask };
}

/** Writes measured numbers next to the screenshots (test-results/screenshots/uv_rewrap/metrics/<name>.json). */
export function recordMetrics(name: string, data: unknown): void {
    const dir = path.join(UV_REWRAP_SHOT_DIR, 'metrics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 1));
}

/** First embedded image of the GLB that a material's baseColorTexture uses, decoded. */
export function baseColorImage(glb: Buffer, material = 0): { width: number; height: number; rgba: Uint8Array } | undefined {
    const { json, tex } = readGlb(glb);
    const t = tex(json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture);
    return t ? { width: t.img.w, height: t.img.h, rgba: t.img.px } : undefined;
}

/** Texels of the TEXCOORD set claimed by the interiors of two or more triangles (rasterised at `size`). */
export function uvOverlapTexels(glb: Buffer, set = 0, size = 1024): { overlapping: number; covered: number } {
    const { json, acc } = readGlb(glb);
    const count = new Uint16Array(size * size);
    for (const m of json.meshes) for (const p of m.primitives) {
        const uvAcc = p.attributes[`TEXCOORD_${set}`];
        if (uvAcc === undefined) continue;
        const uv = acc(uvAcc);
        const idx = p.indices !== undefined ? acc(p.indices) : Float64Array.from({ length: uv.length / 2 }, (_, i) => i);
        for (let t = 0; t < idx.length; t += 3) {
            const A = [uv[idx[t] * 2] * size, uv[idx[t] * 2 + 1] * size], B = [uv[idx[t + 1] * 2] * size, uv[idx[t + 1] * 2 + 1] * size], C = [uv[idx[t + 2] * 2] * size, uv[idx[t + 2] * 2 + 1] * size];
            const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
            if (Math.abs(den) < 1e-12) continue;
            const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
            const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
                const l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
                const l2 = 1 - l0 - l1;
                // strict interior (shared edges between neighbours are not overlap)
                if (l0 > 1e-6 && l1 > 1e-6 && l2 > 1e-6) count[y * size + x]++;
            }
        }
    }
    let overlapping = 0, covered = 0;
    for (const c of count) { if (c > 0) covered++; if (c > 1) overlapping++; }
    return { overlapping, covered };
}

/** Independent per-triangle distortion of a TEXCOORD set: area-weighted RMS of sigma1/sigma2 and folded area ratio. */
export function measureDistortion(glb: Buffer, set = 0): { stretchRms: number; areaRms: number; flipped: number } {
    const prims = readScene(glb);
    let A = 0, s2 = 0, r2 = 0, flipped = 0;
    const per: Array<{ a: number; st: number; det: number }> = [];
    let uvArea = 0;
    for (const p of prims) {
        const uv = p.uvs[set];
        if (!uv) continue;
        for (let t = 0; t < p.idx.length; t += 3) {
            const [a, b, c] = [p.idx[t], p.idx[t + 1], p.idx[t + 2]];
            const e1 = [0, 1, 2].map(k => p.pos[b * 3 + k] - p.pos[a * 3 + k]), e2 = [0, 1, 2].map(k => p.pos[c * 3 + k] - p.pos[a * 3 + k]);
            const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const area = Math.hypot(nn[0], nn[1], nn[2]) / 2;
            if (area < 1e-14) continue;
            // 2D isometric coordinates of the triangle
            const l1 = Math.hypot(e1[0], e1[1], e1[2]);
            const x2 = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1, y2 = (2 * area) / l1;
            const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1], du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
            // J = [[du1 du2][dv1 dv2]] * inv([[l1 x2][0 y2]])
            const j00 = du1 / l1, j01 = (du2 - du1 * x2 / l1) / y2, j10 = dv1 / l1, j11 = (dv2 - dv1 * x2 / l1) / y2;
            const fro2 = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11, det = j00 * j11 - j01 * j10;
            const disc = Math.sqrt(Math.max(0, fro2 * fro2 / 4 - det * det));
            const s1 = Math.sqrt(fro2 / 2 + disc), s2v = Math.sqrt(Math.max(0, fro2 / 2 - disc));
            per.push({ a: area, st: s2v > 0 ? s1 / s2v : 1e6, det });
            uvArea += Math.abs(det) * area; A += area;
        }
    }
    // the area ratio is relative to the atlas's mean scale here (charts are normalised to one density)
    const scale = uvArea / A;
    const sign = per.reduce((s, x) => s + x.det * x.a, 0) >= 0 ? 1 : -1;
    for (const x of per) {
        const r = Math.abs(x.det) / scale;
        const ar = r > 1e-6 ? Math.max(r, 1 / r) : 1e6;
        s2 += x.a * x.st * x.st; r2 += x.a * ar * ar;
        if (x.det * sign <= 0) flipped++;
    }
    return { stretchRms: Math.sqrt(s2 / A), areaRms: Math.sqrt(r2 / A), flipped };
}

