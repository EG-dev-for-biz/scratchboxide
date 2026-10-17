/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Analytic photo-textured tile GLBs for the tile transfer tests (task D). Each sheet is a planar grid with its own
 * PNG baseColor texture (synthesised in code), wound so its geometric normal is the requested one, like a tile leaf
 * of Google Photorealistic 3D Tiles (TEXCOORD_0 per primitive, image embedded). No bytes are committed.
 */

import { encodePng } from '../../src/node/texture-processing';
import type { Vec3 } from '../../src/common/spatial/staged-location-contracts';
import { FACADE, facadeAlbedo } from './texture-pass-fixtures';

export interface TileSheet {
    /** Corner of the sheet; `u` and `v` are unit in-plane axes, metric extents widthM x heightM. */
    origin: Vec3; u: Vec3; v: Vec3; widthM: number; heightM: number;
    /** Normal the sheet must face (it is wound so cross(e1, e2) points this way). */
    facing: Vec3;
    /** Texture texels; texel (px, py) covers metric u in [px, px+1] * widthM / w, v from the top. */
    texture: { width: number; height: number; rgba: Uint8Array };
    /** Grid segments per side (default 4 x 4). */
    segments?: number;
}

/** The texture of a sheet whose texel centres take `colour(u, v)` (metric). */
export function analyticTexture(widthM: number, heightM: number, texelM: number, colour: (u: number, v: number) => Vec3): { width: number; height: number; rgba: Uint8Array } {
    const width = Math.round(widthM / texelM), height = Math.round(heightM / texelM);
    const rgba = new Uint8Array(width * height * 4);
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
        const c = colour(((px + 0.5) / width) * widthM, (1 - (py + 0.5) / height) * heightM);
        const o = (py * width + px) * 4;
        rgba[o] = Math.round(c[0]); rgba[o + 1] = Math.round(c[1]); rgba[o + 2] = Math.round(c[2]); rgba[o + 3] = 255;
    }
    return { width, height, rgba };
}

export function buildTileGlb(sheets: TileSheet[]): Uint8Array {
    const chunks: Buffer[] = [];
    let offset = 0;
    const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], nodes: any[] = [], images: any[] = [], textures: any[] = [], materials: any[] = [];
    const push = (buf: Buffer): number => {
        const pad = (4 - (buf.length % 4)) % 4;
        chunks.push(buf, Buffer.alloc(pad));
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
        offset += buf.length + pad;
        return bufferViews.length - 1;
    };
    sheets.forEach((s, k) => {
        const seg = s.segments ?? 4;
        const pos: number[] = [], uv: number[] = [], idx: number[] = [];
        for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
            const a = (i / seg) * s.widthM, b = (j / seg) * s.heightM;
            pos.push(s.origin[0] + a * s.u[0] + b * s.v[0], s.origin[1] + a * s.u[1] + b * s.v[1], s.origin[2] + a * s.u[2] + b * s.v[2]);
            uv.push(i / seg, 1 - j / seg);
        }
        const n: Vec3 = [s.u[1] * s.v[2] - s.u[2] * s.v[1], s.u[2] * s.v[0] - s.u[0] * s.v[2], s.u[0] * s.v[1] - s.u[1] * s.v[0]];
        const flip = n[0] * s.facing[0] + n[1] * s.facing[1] + n[2] * s.facing[2] < 0;
        for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
            const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
            if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
        }
        const p = Float32Array.from(pos);
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.length; i += 3) for (let q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], p[i + q]); mx[q] = Math.max(mx[q], p[i + q]); }
        accessors.push({ bufferView: push(Buffer.from(p.buffer)), componentType: 5126, count: p.length / 3, type: 'VEC3', min: mn, max: mx });
        const posAcc = accessors.length - 1;
        accessors.push({ bufferView: push(Buffer.from(Float32Array.from(uv).buffer)), componentType: 5126, count: uv.length / 2, type: 'VEC2' });
        const uvAcc = accessors.length - 1;
        accessors.push({ bufferView: push(Buffer.from(Uint16Array.from(idx).buffer)), componentType: 5123, count: idx.length, type: 'SCALAR' });
        const idxAcc = accessors.length - 1;
        images.push({ bufferView: push(encodePng(s.texture.width, s.texture.height, Buffer.from(s.texture.rgba))), mimeType: 'image/png' });
        textures.push({ source: images.length - 1, sampler: 0 });
        materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0 }, extensions: { KHR_materials_unlit: {} } });
        meshes.push({ primitives: [{ attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc }, indices: idxAcc, material: materials.length - 1 }] });
        nodes.push({ name: `tile_${k}`, mesh: meshes.length - 1 });
    });
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, textures, images,
        samplers: [{ wrapS: 33071, wrapT: 33071 }], accessors, bufferViews, buffers: [{ byteLength: offset }], extensionsUsed: ['KHR_materials_unlit']
    };
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return new Uint8Array(Buffer.concat([header, jh, jsonBuf, bh, bin]));
}

/** The tile's photo of the fixture facade: FACADE's analytic albedo at 0.154 m texels, `offsetM` toward the street. */
export function facadeTileSheet(offsetM = 0.05, colour: (u: number, v: number) => Vec3 = facadeAlbedo, texelM = 0.154): TileSheet {
    return {
        origin: [FACADE.origin[0], FACADE.origin[1], FACADE.origin[2] - offsetM], u: FACADE.u, v: FACADE.v,
        widthM: FACADE.widthM, heightM: FACADE.heightM, facing: FACADE.normal,
        texture: analyticTexture(FACADE.widthM, FACADE.heightM, texelM, colour)
    };
}
