/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Synthetic scanned surfaces for the surface infill's tests (surface-infill.test.ts) and its proof sheet: a ground mesh
 * 30 m square on a 0.25 m grid, photo-textured at 5 cm a texel (PNG, so texel statistics are exact), with a lump standing
 * where something was (draped into the surface, its own colour), and the ground truth of the surface under it.
 */

import { assembleGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

export const HALF = 15, STEP = 0.25, TEX = 600;
export type Rgb = [number, number, number];

/** Deterministic value noise in [-1, 1] at cell `s` metres. */
export function noise(x: number, z: number, s: number, seed = 1): number {
    const h = (i: number, k: number) => { let n = (i * 374761393 + k * 668265263 + seed * 2147483647) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295 * 2 - 1; };
    const fx = x / s, fz = z / s, i = Math.floor(fx), k = Math.floor(fz), ax = fx - i, az = fz - k;
    const sx = ax * ax * (3 - 2 * ax), sz = az * az * (3 - 2 * az);
    return (1 - sz) * ((1 - sx) * h(i, k) + sx * h(i + 1, k)) + sz * ((1 - sx) * h(i, k + 1) + sx * h(i + 1, k + 1));
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const grain = (x: number, z: number, amp: number, seed = 1) => amp * (0.6 * noise(x, z, 0.05, seed) + 0.4 * noise(x, z, 0.2, seed + 7));

export interface Lump { cx: number; cz: number; ax: number; az: number; h: number; colour: Rgb }
export const inLump = (l: Lump, x: number, z: number, pad = 0) => ((x - l.cx) / (l.ax + pad)) ** 2 + ((z - l.cz) / (l.az + pad)) ** 2 < 1;
export const lumpBump = (l: Lump, x: number, z: number) => { const q = ((x - l.cx) / l.ax) ** 2 + ((z - l.cz) / l.az) ** 2; return q < 1 ? l.h * Math.cos((Math.PI / 2) * q) ** 0.5 : 0; };

export interface Scene {
    name: string;
    /** The surface (ground truth) and its photo without anything on it. */
    ground(x: number, z: number): number;
    truth(x: number, z: number): Rgb;
    lumps: Lump[];
}

/** The scan: the ground with the lumps draped in, their colour painted over them (and a few cm past their edge). */
export function sceneGlb(s: Scene): Buffer {
    const n = Math.round((2 * HALF) / STEP) + 1;
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const x = -HALF + i * STEP, z = -HALF + k * STEP;
        pos.push(x, s.ground(x, z) + s.lumps.reduce((m, l) => Math.max(m, lumpBump(l, x, z)), 0), z); nor.push(0, 1, 0); uv.push((x + HALF) / (2 * HALF), (z + HALF) / (2 * HALF));
    }
    for (let k = 0; k + 1 < n; k++) for (let i = 0; i + 1 < n; i++) { const a = k * n + i, b = a + 1, c = a + n, d = c + 1; idx.push(a, c, b, b, c, d); }
    const rgba = new Uint8Array(TEX * TEX * 4);
    for (let k = 0; k < TEX; k++) for (let i = 0; i < TEX; i++) {
        const x = -HALF + ((i + 0.5) / TEX) * 2 * HALF, z = -HALF + ((k + 0.5) / TEX) * 2 * HALF;
        const l = s.lumps.find(q => inLump(q, x, z, 0.1));
        const c = l ? l.colour : s.truth(x, z);
        rgba.set([c[0], c[1], c[2], 255], (k * TEX + i) * 4);
    }
    const parts: Buffer[] = [];
    const views: any[] = [];
    let off = 0;
    const add = (b: Buffer, target?: number) => { const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(target ? { target } : {}) }); parts.push(b); off += b.length; return views.length - 1; };
    const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
    const vPos = add(f32(pos), 34962), vNor = add(f32(nor), 34962), vUv = add(f32(uv), 34962), vIdx = add(Buffer.from(new Uint32Array(idx).buffer), 34963);
    const ys = pos.filter((_, j) => j % 3 === 1);
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, mode: 4, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
        accessors: [
            { bufferView: vPos, componentType: 5126, count: n * n, type: 'VEC3', min: [-HALF, Math.min(...ys), -HALF], max: [HALF, Math.max(...ys), HALF] },
            { bufferView: vNor, componentType: 5126, count: n * n, type: 'VEC3' },
            { bufferView: vUv, componentType: 5126, count: n * n, type: 'VEC2' },
            { bufferView: vIdx, componentType: 5125, count: idx.length, type: 'SCALAR' }
        ],
        bufferViews: views
    };
    const vImg = add(encodePng(TEX, TEX, rgba, 4));
    json.images = [{ bufferView: vImg, mimeType: 'image/png' }];
    json.textures = [{ source: 0, sampler: 0 }];
    json.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }];
    json.buffers = [{ byteLength: off }];
    return assembleGlb(json, Buffer.concat(parts));
}

/** A lump's footprint (and `padM` of skirt) as world triangles on the ground: a plan cell grid of `cellM`. */
export function lumpHole(s: Scene, l: Lump, padM: number, cellM = 0.1): Float32Array {
    const out: number[] = [];
    for (let z = l.cz - l.az - padM - cellM; z <= l.cz + l.az + padM + cellM; z += cellM) for (let x = l.cx - l.ax - padM - cellM; x <= l.cx + l.ax + padM + cellM; x += cellM) {
        if (!inLump(l, x + cellM / 2, z + cellM / 2, padM)) continue;
        const y = s.ground(x, z);
        out.push(x, y, z, x, y, z + cellM, x + cellM, y, z, x + cellM, y, z, x, y, z + cellM, x + cellM, y, z + cellM);
    }
    return Float32Array.from(out);
}

/** The measured ring: the scan's grid vertices between `fromM` and `toM` outside the lump's padded footprint. */
export function lumpRing(s: Scene, l: Lump, padM: number, fromM = 0.2, toM = 1.5): Float32Array {
    const out: number[] = [];
    for (let z = -HALF; z <= HALF + 1e-9; z += STEP) for (let x = -HALF; x <= HALF + 1e-9; x += STEP) {
        if (inLump(l, x, z, padM + fromM) || !inLump(l, x, z, padM + toM)) continue;
        if (s.lumps.some(q => lumpBump(q, x, z) > 0)) continue;
        out.push(x, s.ground(x, z), z);
    }
    return Float32Array.from(out);
}

const LANE_Z = 0, DASH_Z = 3, LINE_HALF = 0.075, DASH_M = 3;
/** A street: asphalt grain, a solid lane line along x at z = 0, a dashed one at z = 3 (1.5 m dash every 3 m); a car on the solid line, a box on the dashes. */
export const laneStreet: Scene = {
    name: 'lane street',
    ground: x => 0.02 * x,
    truth(x, z) {
        if (Math.abs(z - LANE_Z) < LINE_HALF) return [228 + grain(x, z, 6), 228 + grain(x, z, 6), 222 + grain(x, z, 6)].map(clamp) as Rgb;
        if (Math.abs(z - DASH_Z) < LINE_HALF && ((x % DASH_M) + DASH_M) % DASH_M < DASH_M / 2) return [226 + grain(x, z, 6), 226 + grain(x, z, 6), 220 + grain(x, z, 6)].map(clamp) as Rgb;
        const g = grain(x, z, 14);
        return [clamp(84 + g), clamp(86 + g), clamp(90 + g)];
    },
    lumps: [{ cx: 0.3, cz: 0.2, ax: 2.2, az: 0.9, h: 1.4, colour: [200, 30, 30] }, { cx: 1.2, cz: 3.1, ax: 1.6, az: 0.6, h: 0.8, colour: [40, 60, 200] }]
};
export const isDash = (x: number) => ((x % DASH_M) + DASH_M) % DASH_M < DASH_M / 2;

const TILE = 0.5, JOINT = 0.03;
/** A plaza: 0.5 m square stone tiles (each its own shade) with 3 cm joints; a kiosk stood in the middle. */
export const pavingPlaza: Scene = {
    name: 'paving plaza',
    ground: (x, z) => 0.01 * z,
    truth(x, z) {
        const fx = ((x % TILE) + TILE) % TILE, fz = ((z % TILE) + TILE) % TILE;
        if (fx < JOINT || fz < JOINT) { const g = grain(x, z, 5, 3); return [clamp(92 + g), clamp(88 + g), clamp(84 + g)]; }
        const shade = 14 * noise(Math.floor(x / TILE) * 7.3, Math.floor(z / TILE) * 5.1, 1, 9);
        const g = grain(x, z, 6, 4);
        return [clamp(178 + shade + g), clamp(170 + shade + g), clamp(158 + shade + g)];
    },
    lumps: [{ cx: 0.1, cz: -0.2, ax: 1.4, az: 1.3, h: 2.2, colour: [30, 120, 60] }]
};
export const isJoint = (x: number, z: number) => { const fx = ((x % TILE) + TILE) % TILE, fz = ((z % TILE) + TILE) % TILE; return fx < JOINT || fz < JOINT; };

/** A park path: loose gravel (stones of 3-8 cm in browns and greys over a fine base); a bench stood on it. */
export const gravelPark: Scene = {
    name: 'gravel park',
    ground: (x, z) => 0.03 * noise(x, z, 6, 11),
    truth(x, z) {
        // stones: a jittered 6 cm lattice, each cell's stone a disc of its own size and colour
        const c = 0.06, i = Math.floor(x / c), k = Math.floor(z / c);
        let best: Rgb | undefined;
        for (let dk = -1; dk <= 1 && !best; dk++) for (let di = -1; di <= 1 && !best; di++) {
            const ii = i + di, kk = k + dk;
            const ox = (noise(ii * 1.7, kk * 2.3, 1, 21) * 0.5 + 0.5) * c, oz = (noise(ii * 3.1, kk * 1.3, 1, 22) * 0.5 + 0.5) * c, r = 0.015 + 0.025 * (noise(ii * 2.9, kk * 4.1, 1, 23) * 0.5 + 0.5);
            if (Math.hypot(x - (ii * c + ox), z - (kk * c + oz)) < r) {
                const t = noise(ii * 5.7, kk * 6.1, 1, 24);
                best = [clamp(140 + 40 * t), clamp(126 + 30 * t), clamp(110 + 12 * t)];
            }
        }
        if (best) return best;
        const g = grain(x, z, 10, 25);
        return [clamp(96 + g), clamp(86 + g), clamp(74 + g)];
    },
    lumps: [{ cx: -0.2, cz: 0.4, ax: 1.1, az: 0.5, h: 0.9, colour: [120, 70, 30] }]
};

/** A street with a kerb: the road at a 1 % grade, the sidewalk 0.15 m up beyond z = 2; a van parked half on it. */
export const KERB_Z = 2, KERB_RISE = 0.15;
export const kerbStreet: Scene = {
    name: 'kerb street',
    ground: (x, z) => 0.01 * x + (z > KERB_Z ? KERB_RISE : 0),
    truth(x, z) {
        if (z > KERB_Z) { const g = grain(x, z, 8, 31); return [clamp(168 + g), clamp(166 + g), clamp(160 + g)]; }
        if (z > KERB_Z - 0.2) { const g = grain(x, z, 6, 32); return [clamp(140 + g), clamp(140 + g), clamp(138 + g)]; }
        const g = grain(x, z, 12, 33);
        return [clamp(78 + g), clamp(80 + g), clamp(84 + g)];
    },
    lumps: [{ cx: 0, cz: 2, ax: 2.4, az: 1.0, h: 1.8, colour: [230, 230, 240] }]
};

export const luma = (c: ArrayLike<number>, o = 0) => 0.299 * c[o] + 0.587 * c[o + 1] + 0.114 * c[o + 2];
