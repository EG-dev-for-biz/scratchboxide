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
import * as zlib from 'zlib';

export type V3 = [number, number, number];
/** A primitive; with `uvs` and `image` it is textured by that entry of writeGlb's `images`. */
export interface Chunk { positions: number[]; indices: number[]; uvs?: number[]; image?: number }

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

/** An 8-bit RGB PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
    const crcTable = new Uint32Array(256).map((_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, c]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Writes the chunks as one mesh; `images` (PNG bytes) texture the chunks that name one, the rest are plain grey. With
 * `tiles` (one per chunk), each chunk is a mesh and node of its own, as the tile crawler writes a leaf: its leaf id and
 * stated geometric error (and box) in the node's extras.sb. `rootExtras` become the document's extras (e.g. its frame).
 */
export function writeGlb(file: string, chunks: Chunk[], images: Buffer[] = [], tiles?: Array<{ leafId: string; geometricErrorM?: number; box?: number[] }>, rootExtras?: object): void {
    const parts: Buffer[] = [];
    let offset = 0;
    const bufferViews: object[] = [], accessors: object[] = [], primitives: object[] = [];
    const push = (b: Buffer, target?: number) => {
        const pad = (4 - (b.length % 4)) % 4;
        parts.push(b, Buffer.alloc(pad));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length, ...(target ? { target } : {}) });
        offset += b.length + pad;
        return bufferViews.length - 1;
    };
    for (const ch of chunks) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        ch.positions.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], Math.fround(v)); max[i % 3] = Math.max(max[i % 3], Math.fround(v)); });
        const pv = push(Buffer.from(new Float32Array(ch.positions).buffer), 34962);
        accessors.push({ bufferView: pv, componentType: 5126, count: ch.positions.length / 3, type: 'VEC3', min, max });
        const attributes: Record<string, number> = { POSITION: accessors.length - 1 };
        const textured = ch.uvs !== undefined && ch.image !== undefined;
        if (textured) {
            const tv = push(Buffer.from(new Float32Array(ch.uvs!).buffer), 34962);
            accessors.push({ bufferView: tv, componentType: 5126, count: ch.uvs!.length / 2, type: 'VEC2' });
            attributes.TEXCOORD_0 = accessors.length - 1;
        }
        const iv = push(Buffer.from(new Uint32Array(ch.indices).buffer), 34963);
        accessors.push({ bufferView: iv, componentType: 5125, count: ch.indices.length, type: 'SCALAR' });
        primitives.push({ attributes, indices: accessors.length - 1, mode: 4, ...(images.length ? { material: textured ? ch.image! + 1 : 0 } : {}) });
    }
    const imageViews = images.map(im => push(im));
    const bin = Buffer.concat(parts);
    const textures = images.length ? {
        images: imageViews.map(bufferView => ({ bufferView, mimeType: 'image/png' })),
        samplers: [{ magFilter: 9729, minFilter: 9729 }],
        textures: images.map((_, i) => ({ source: i, sampler: 0 })),
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.7, 1] } }, ...images.map((_, i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } }))]
    } : {};
    const perTile = tiles && tiles.length === chunks.length;
    const meshes = perTile ? primitives.map(p => ({ primitives: [p] })) : [{ primitives }];
    const nodes = perTile
        ? tiles!.map((t, i) => ({ mesh: i, extras: { sb: { ids: { leafId: t.leafId }, ...(t.geometricErrorM !== undefined || t.box ? { tile: { ...(t.geometricErrorM !== undefined ? { geometricErrorM: t.geometricErrorM } : {}), ...(t.box ? { box: t.box } : {}) } } : {}) } } }))
        : [{ mesh: 0 }];
    const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews, accessors, meshes, nodes, scenes: [{ nodes: nodes.map((_, i) => i) }], scene: 0, ...textures, ...(rootExtras ? { extras: rootExtras } : {}) };
    let js = Buffer.from(JSON.stringify(doc));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4);
    fs.writeFileSync(file, Buffer.concat([header, jh, js, bh, bin]));
}

/** A GLB's JSON and its per-primitive float attribute columns. */
export interface Glb { json: any; attribute(name: string): Float32Array[] }

export function readGlb(file: string): Glb {
    const b = fs.readFileSync(file);
    const jsonLen = b.readUInt32LE(12);
    const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
    const bin = b.subarray(20 + jsonLen + 8);
    return {
        json,
        attribute(name: string) {
            const out: Float32Array[] = [];
            for (const m of json.meshes)
                for (const p of m.primitives) {
                    if (p.attributes[name] === undefined) continue;
                    const acc = json.accessors[p.attributes[name]], view = json.bufferViews[acc.bufferView];
                    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type] ?? 1;
                    const start = bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
                    out.push(new Float32Array(bin.buffer.slice(start, start + acc.count * components * 4)));
                }
            return out;
        }
    };
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
