/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A small photo-textured tile in the layout of a Google 3D Tiles district extraction (x east, y up, z south, metres;
 * root extras { frame, anchor, localToEcef }), with known ground truth: flat ground, rough green canopy blobs draped
 * onto it like photogrammetry, and a planar building whose roof may carry a low green bump.
 */

import { encodePng } from '../../src/node/texture-processing';

/**
 * A crown: a rough green dome. `hem` (m) adds what photogrammetry hangs around real crowns: a rough, shadowed, not green
 * drape sloping from `hemHeight` at the crown's edge down to the ground over that distance.
 */
export interface SyntheticTree { x: number; z: number; height: number; radius: number; hem?: number; hemHeight?: number }
/**
 * A flat vertical sheet from the ground up to `belowCanopy` under the canopy above it (a tile-seam curtain: tile
 * leaves are cut along planes and the scan hangs a planar curtain there), in the plane through (x0, z0)-(x1, z1).
 */
export interface SyntheticCurtain { x0: number; z0: number; x1: number; z1: number; belowCanopy: number }
/**
 * A building: planar walls and a flat roof, which may carry a green bump (a roof garden: the bump replaces the roof under
 * it). `hollow`: the ground runs on under the building (a photogrammetric building mesh is a shell over the street).
 */
export interface SyntheticBuilding { x0: number; z0: number; x1: number; z1: number; height: number; roofBump?: { x: number; z: number; height: number; radius: number }; hollow?: boolean }

/** A street: a carriageway `halfWidth` either side of the centreline, sunk `kerb` below the ground around it; an optional raised median along it. */
export interface SyntheticRoad { x0: number; z0: number; x1: number; z1: number; halfWidth: number; kerb: number; median?: { halfWidth: number } }

export interface SyntheticTileSpec {
    /** Ground covers [-halfSize, halfSize] in x and z. */
    halfSize: number;
    /** Streets sunk into the ground by their kerb height, in their own (dark) texture. */
    roads?: SyntheticRoad[];
    /** Paint lane lines into the street texture: a dashed white line along x at z = 0 (5 m on, 5 m off) and a solid one along z at x = 0, 10, 20... */
    roadMarkings?: boolean;
    /** Ground grid spacing (m). */
    spacing: number;
    trees: SyntheticTree[];
    curtains?: SyntheticCurtain[];
    building?: SyntheticBuilding;
    anchor?: { lat: number; lng: number; ellipsoidalHeightM: number };
    /** The foliage image is not a decodable PNG. */
    corruptTexture?: boolean;
    /** No textures at all (a clay extraction). */
    untextured?: boolean;
    /**
     * Tilts the whole tile into a hillside: every vertex is raised by slope * x (ground, crowns, building alike), so the
     * ground is the plane y = slope * x.
     */
    slope?: number;
    /** Colour of the ground texture (default GROUND_RGB, grey paving); a green one makes a lawn. */
    groundRgb?: [number, number, number];
}

export const FOLIAGE_RGB: [number, number, number] = [72, 112, 52];
export const GROUND_RGB: [number, number, number] = [124, 122, 118];
export const FACADE_RGB: [number, number, number] = [168, 150, 128];
/** Shadowed drape: neither green nor dark enough to be left unjudged. */
export const DRAPE_RGB: [number, number, number] = [92, 88, 84];
export const ROAD_RGB: [number, number, number] = [64, 62, 66];

function hash(a: number, b: number, c: number): number {
    let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(c | 0, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function texture(rgb: [number, number, number], seed: number, markings = false): Buffer {
    const W = 32, H = 32;
    const px = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const n = (hash(x, y, seed) - 0.5) * 16;
            const o = (y * W + x) * 4;
            // the UVs are world x 0.1, so one texel is 0.3125 m: row 0 lies along z = 0 (mod 10 m), column 0 along x = 0 (mod 10 m)
            const line = markings && ((y === 0 && x < 16) || x === 0);
            for (let c = 0; c < 3; c++) px[o + c] = line ? 240 : Math.max(0, Math.min(255, Math.round(rgb[c] + n)));
            px[o + 3] = 255;
        }
    }
    return encodePng(W, H, px);
}

/** Dome height of a tree crown at horizontal distance d, with a rough (deterministic) photogrammetric surface. */
function crownHeight(t: SyntheticTree, x: number, z: number): number {
    const d = Math.hypot(x - t.x, z - t.z);
    if (d >= t.radius) return 0;
    const u = 1 - (d / t.radius) ** 2;
    return t.height * Math.pow(u, 0.5);
}

/**
 * Height of a crown's drape hem at (x, z): from hemHeight at the crown's edge down towards the ground at radius + hem,
 * meeting the (flat) ground with a step where it gets lower than 0.4 m, so the ground itself stays exactly level.
 */
function hemHeight(t: SyntheticTree, x: number, z: number): number {
    if (!t.hem) return 0;
    const d = Math.hypot(x - t.x, z - t.z);
    if (d < t.radius || d >= t.radius + t.hem) return 0;
    const h = (t.hemHeight ?? 3) * (1 - (d - t.radius) / t.hem);
    return h < 0.4 ? 0 : h;
}

interface Prim { pos: number[]; uv: number[]; idx: number[] }

export function localToEcef(lat: number, lng: number, h: number): number[] {
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
    const p = (lat * Math.PI) / 180, l = (lng * Math.PI) / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    const origin = [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - e2) + h) * Math.sin(p)];
    const east = [-Math.sin(l), Math.cos(l), 0];
    const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
    const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
    const south = north.map(v => -v);
    return [...east, 0, ...up, 0, ...south, 0, ...origin, 1];
}

/** WGS-84 latitude/longitude of a tile-frame point (inverse of the frame), for checking crown geodesy. */
export function tileToLatLng(m: number[], x: number, y: number, z: number): { lat: number; lng: number } {
    const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
    const lng = Math.atan2(Y, X);
    const p = Math.hypot(X, Y);
    let lat = Math.atan2(Z, p * (1 - e2));
    for (let i = 0; i < 6; i++) {
        const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
        const h = p / Math.cos(lat) - N;
        lat = Math.atan2(Z, p * (1 - (e2 * N) / (N + h)));
    }
    return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
}

export function buildSyntheticTile(spec: SyntheticTileSpec): Buffer {
    const s = spec.spacing, half = spec.halfSize;
    const n = Math.round((2 * half) / s);
    const ground: Prim = { pos: [], uv: [], idx: [] };
    const foliage: Prim = { pos: [], uv: [], idx: [] };
    const facade: Prim = { pos: [], uv: [], idx: [] };
    const drape: Prim = { pos: [], uv: [], idx: [] };
    const road: Prim = { pos: [], uv: [], idx: [] };
    const b = spec.building;
    // a point's street: on a carriageway (not a median) it is sunk by the kerb
    const roadAt = (x: number, z: number): { carriageway: boolean; sunk: number } => {
        let carriageway = false, sunk = 0;
        for (const r of spec.roads ?? []) {
            const dx = r.x1 - r.x0, dz = r.z1 - r.z0, len = Math.hypot(dx, dz);
            if (len < 1e-6) continue;
            const t = ((x - r.x0) * dx + (z - r.z0) * dz) / (len * len);
            if (t < 0 || t > 1) continue;
            const off = Math.abs((x - r.x0) * (-dz / len) + (z - r.z0) * (dx / len));
            if (off > r.halfWidth) continue;
            if (r.median && off <= r.median.halfWidth) continue;
            carriageway = true;
            sunk = Math.max(sunk, r.kerb);
        }
        return { carriageway, sunk };
    };
    const inBuilding = (x: number, z: number) => !!b && !b.hollow && x > b.x0 - 1e-6 && x < b.x1 + 1e-6 && z > b.z0 - 1e-6 && z < b.z1 + 1e-6;

    // ground + canopy heightfield
    const H: number[][] = [];
    for (let i = 0; i <= n; i++) {
        H.push([]);
        for (let k = 0; k <= n; k++) {
            const x = -half + i * s, z = -half + k * s;
            let h = 0;
            for (const t of spec.trees) h = Math.max(h, crownHeight(t, x, z), hemHeight(t, x, z));
            if (h > 0.4) h += (hash(i, k, 7) - 0.5) * 0.7; // rough canopy surface
            H[i].push(h > 0.4 ? Math.max(0, h) : -roadAt(x, z).sunk);
        }
    }
    const slope = spec.slope ?? 0;
    const vid = (p: Prim, x: number, y: number, z: number) => {
        p.pos.push(x, y + slope * x, z);
        p.uv.push(((x * 0.1) % 1 + 1) % 1, ((z * 0.1) % 1 + 1) % 1);
        return p.pos.length / 3 - 1;
    };
    // canopy vertices also wander sideways, as a photogrammetric drape does (shared vertices move together)
    const jx = (i: number, k: number) => (H[i][k] > 0.4 ? (hash(i, k, 13) - 0.5) * 0.5 : 0);
    const jz = (i: number, k: number) => (H[i][k] > 0.4 ? (hash(i, k, 17) - 0.5) * 0.5 : 0);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < n; k++) {
            const x0 = -half + i * s, z0 = -half + k * s, x1 = x0 + s, z1 = z0 + s;
            if (inBuilding(x0, z0) && inBuilding(x1, z1)) continue;
            const hs = [H[i][k], H[i + 1][k], H[i][k + 1], H[i + 1][k + 1]];
            const cx = x0 + s / 2, cz = z0 + s / 2;
            const inCrown = spec.trees.some(t => Math.hypot(cx - t.x, cz - t.z) < t.radius);
            const p = Math.max(...hs) > 0.5 ? (inCrown ? foliage : drape) : roadAt(cx, cz).carriageway ? road : ground;
            const a = vid(p, x0 + jx(i, k), hs[0], z0 + jz(i, k)), bb = vid(p, x1 + jx(i + 1, k), hs[1], z0 + jz(i + 1, k));
            const c = vid(p, x0 + jx(i, k + 1), hs[2], z1 + jz(i, k + 1)), d = vid(p, x1 + jx(i + 1, k + 1), hs[3], z1 + jz(i + 1, k + 1));
            // up-facing winding: (a, c, b) and (b, c, d) in the x-east / z-south frame
            p.idx.push(a, c, bb, bb, c, d);
        }
    }
    // curtains: planar vertical sheets in the drape texture, columns ~0.75 m wide, each up to just under the canopy
    for (const c of spec.curtains ?? []) {
        const len = Math.hypot(c.x1 - c.x0, c.z1 - c.z0);
        const nu = Math.max(1, Math.round(len / 0.75));
        const top = (x: number, z: number) => {
            let h = 0;
            for (const t of spec.trees) h = Math.max(h, crownHeight(t, x, z));
            return Math.max(0.5, h - c.belowCanopy);
        };
        for (let u = 0; u < nu; u++) {
            const ax = c.x0 + ((c.x1 - c.x0) * u) / nu, az = c.z0 + ((c.z1 - c.z0) * u) / nu;
            const bx = c.x0 + ((c.x1 - c.x0) * (u + 1)) / nu, bz = c.z0 + ((c.z1 - c.z0) * (u + 1)) / nu;
            const ta = top(ax, az), tb = top(bx, bz);
            const p0 = vid(drape, ax, 0, az), p1 = vid(drape, bx, 0, bz), p2 = vid(drape, ax, ta, az), p3 = vid(drape, bx, tb, bz);
            drape.idx.push(p0, p1, p2, p1, p3, p2);
        }
    }
    // building: walls subdivided into ~1.5 m quads, a flat roof grid with an optional low green bump
    if (b) {
        const wall = (ax: number, az: number, bx: number, bz: number) => {
            const len = Math.hypot(bx - ax, bz - az);
            const nu = Math.max(1, Math.round(len / 1.5)), nv = Math.max(1, Math.round(b.height / 1.5));
            for (let u = 0; u < nu; u++) {
                for (let v = 0; v < nv; v++) {
                    const t0 = u / nu, t1 = (u + 1) / nu, y0 = (v / nv) * b.height, y1 = ((v + 1) / nv) * b.height;
                    const p0 = vid(facade, ax + (bx - ax) * t0, y0, az + (bz - az) * t0), p1 = vid(facade, ax + (bx - ax) * t1, y0, az + (bz - az) * t1);
                    const p2 = vid(facade, ax + (bx - ax) * t0, y1, az + (bz - az) * t0), p3 = vid(facade, ax + (bx - ax) * t1, y1, az + (bz - az) * t1);
                    facade.idx.push(p0, p1, p2, p1, p3, p2);
                }
            }
        };
        wall(b.x0, b.z0, b.x1, b.z0);
        wall(b.x1, b.z0, b.x1, b.z1);
        wall(b.x1, b.z1, b.x0, b.z1);
        wall(b.x0, b.z1, b.x0, b.z0);
        const rs = 0.5, nx = Math.round((b.x1 - b.x0) / rs), nz = Math.round((b.z1 - b.z0) / rs);
        const roofH = (x: number, z: number, i: number, k: number) => {
            if (!b.roofBump) return b.height;
            const d = Math.hypot(x - b.roofBump.x, z - b.roofBump.z);
            if (d >= b.roofBump.radius) return b.height;
            return b.height + b.roofBump.height * Math.sqrt(1 - (d / b.roofBump.radius) ** 2) + (hash(i, k, 11) - 0.5) * 0.2;
        };
        for (let i = 0; i < nx; i++) {
            for (let k = 0; k < nz; k++) {
                const x0 = b.x0 + i * rs, z0 = b.z0 + k * rs, x1 = x0 + rs, z1 = z0 + rs;
                const hs = [roofH(x0, z0, i, k), roofH(x1, z0, i + 1, k), roofH(x0, z1, i, k + 1), roofH(x1, z1, i + 1, k + 1)];
                const p = Math.max(...hs) > b.height + 0.15 ? foliage : facade;
                const a = vid(p, x0, hs[0], z0), bb = vid(p, x1, hs[1], z0), c = vid(p, x0, hs[2], z1), d = vid(p, x1, hs[3], z1);
                p.idx.push(a, c, bb, bb, c, d);
            }
        }
    }

    // GLB
    const chunks: Buffer[] = [];
    let length = 0;
    const views: any[] = [];
    const accessors: any[] = [];
    const addView = (buf: Buffer, target?: number) => {
        const pad = (4 - (buf.length % 4)) % 4;
        views.push({ buffer: 0, byteOffset: length, byteLength: buf.length, ...(target ? { target } : {}) });
        chunks.push(buf, Buffer.alloc(pad));
        length += buf.length + pad;
        return views.length - 1;
    };
    const images: any[] = [];
    const textures: any[] = [];
    const materials: any[] = [];
    const meshes: any[] = [];
    const nodes: any[] = [{ name: 'district', children: [] as number[] }];
    const prims: Array<[Prim, [number, number, number], number]> = [[ground, spec.groundRgb ?? GROUND_RGB, 1], [foliage, FOLIAGE_RGB, 2], [facade, FACADE_RGB, 3], [drape, DRAPE_RGB, 4], [road, ROAD_RGB, 5]];
    for (const [p, rgb, seed] of prims) {
        if (!p.idx.length) continue;
        let material: number | undefined;
        if (!spec.untextured) {
            const png = spec.corruptTexture && rgb === FOLIAGE_RGB ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 0x5a)]) : texture(rgb, seed, !!spec.roadMarkings && p === road);
            images.push({ bufferView: addView(png), mimeType: 'image/png' });
            textures.push({ source: images.length - 1, sampler: 0 });
            materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: textures.length - 1 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } });
            material = materials.length - 1;
        }
        const pos = new Float32Array(p.pos);
        const nrm = new Float32Array(p.pos.length);
        for (let t = 0; t < p.idx.length; t += 3) {
            const [i0, i1, i2] = [p.idx[t], p.idx[t + 1], p.idx[t + 2]];
            const e1 = [pos[i1 * 3] - pos[i0 * 3], pos[i1 * 3 + 1] - pos[i0 * 3 + 1], pos[i1 * 3 + 2] - pos[i0 * 3 + 2]];
            const e2 = [pos[i2 * 3] - pos[i0 * 3], pos[i2 * 3 + 1] - pos[i0 * 3 + 1], pos[i2 * 3 + 2] - pos[i0 * 3 + 2]];
            const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            for (const v of [i0, i1, i2]) for (let q = 0; q < 3; q++) nrm[v * 3 + q] += c[q];
        }
        for (let v = 0; v < nrm.length; v += 3) {
            const l = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]) || 1;
            nrm[v] /= l; nrm[v + 1] /= l; nrm[v + 2] /= l;
        }
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < pos.length; v += 3) for (let q = 0; q < 3; q++) { min[q] = Math.min(min[q], pos[v + q]); max[q] = Math.max(max[q], pos[v + q]); }
        accessors.push({ bufferView: addView(Buffer.from(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
        const aPos = accessors.length - 1;
        accessors.push({ bufferView: addView(Buffer.from(nrm.buffer), 34962), componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
        const aNrm = accessors.length - 1;
        const uv = new Float32Array(p.uv);
        accessors.push({ bufferView: addView(Buffer.from(uv.buffer), 34962), componentType: 5126, count: uv.length / 2, type: 'VEC2' });
        const aUv = accessors.length - 1;
        const idx = new Uint32Array(p.idx);
        accessors.push({ bufferView: addView(Buffer.from(idx.buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        const aIdx = accessors.length - 1;
        meshes.push({ primitives: [{ attributes: { POSITION: aPos, NORMAL: aNrm, ...(spec.untextured ? {} : { TEXCOORD_0: aUv }) }, indices: aIdx, mode: 4, ...(material !== undefined ? { material } : {}) }] });
        nodes.push({ name: `tile_${meshes.length - 1}`, mesh: meshes.length - 1 });
        nodes[0].children.push(nodes.length - 1);
    }
    const anchor = spec.anchor ?? { lat: 40.7411, lng: -73.9897, ellipsoidalHeightM: -22.5 };
    const json = {
        asset: { version: '2.0', generator: 'synthetic-textured-tile (test)' },
        extensionsUsed: materials.length ? ['KHR_materials_unlit'] : undefined,
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes,
        meshes,
        materials: materials.length ? materials : undefined,
        textures: textures.length ? textures : undefined,
        images: images.length ? images : undefined,
        samplers: textures.length ? [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }] : undefined,
        accessors,
        bufferViews: views,
        buffers: [{ byteLength: length }],
        extras: {
            frame: 'x = east, y = up, z = south (metres)',
            anchor: { lat: anchor.lat, lng: anchor.lng, ellipsoidalHeightM: anchor.ellipsoidalHeightM },
            localToEcef: localToEcef(anchor.lat, anchor.lng, anchor.ellipsoidalHeightM)
        }
    };
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'utf8');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
