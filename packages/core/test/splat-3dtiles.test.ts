/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Gaussian splats -> OGC 3D Tiles (KHR_gaussian_splatting + KHR_gaussian_splatting_compression_spz_2).
 *
 * Interoperability is the whole point, so the SPZ assertions below decode with an independent
 * reference decoder transcribed from nianticlabs/spz `load-spz.cc` (not from our codec):
 *   header 16 B: magic 0x5053474e, version 2, numPoints, shDegree, fractionalBits, flags, reserved
 *   body (SoA):  positions 24-bit fixed (9n) | alphas u8 (n) | colors u8 (3n) | scales u8 (3n) | rotations u8 (3n)
 *   position = int24 / 2^fractionalBits;   scale = exp(byte/16 - 10)
 *   rgb      = ((byte/255 - 0.5)/0.15) * 0.2820948 + 0.5   (SH-DC encoding)
 *   quat xyz = byte/127.5 - 1, w = sqrt(1 - |xyz|^2) >= 0;  opacity = byte/255
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as zlib from 'zlib';
import { SplatService } from '../src/node/3d-engine/splat-service';
import { Splat3DTilesService } from '../src/node/spatial/Splat3DTilesService';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import type { BakedGaussian } from '../src/common/geospatial-4d-protocol';

const SH_C0 = 0.28209479177387814;
const COLOR_SCALE = 0.15;

interface RefSplat { position: number[]; scale: number[]; quaternion: number[]; colorRgb: number[]; opacity: number }

/** Independent reference decoder (Niantic SPZ v2, SH degree 0). */
function referenceDecodeNianticSpz(gz: Buffer): { header: any; splats: RefSplat[] } {
    const raw = zlib.gunzipSync(gz);
    const header = {
        magic: raw.readUInt32LE(0), version: raw.readUInt32LE(4), numPoints: raw.readUInt32LE(8),
        shDegree: raw.readUInt8(12), fractionalBits: raw.readUInt8(13), flags: raw.readUInt8(14), reserved: raw.readUInt8(15)
    };
    const n = header.numPoints;
    let off = 16;
    const posOff = off; off += 9 * n;
    const alphaOff = off; off += n;
    const colorOff = off; off += 3 * n;
    const scaleOff = off; off += 3 * n;
    const rotOff = off; off += 3 * n;
    expect(raw.length).toBe(off); // degree 0: nothing after rotations
    const posScale = 1 / (1 << header.fractionalBits);
    const splats: RefSplat[] = [];
    for (let i = 0; i < n; i++) {
        const position = [0, 1, 2].map(k => {
            const b = posOff + (i * 3 + k) * 3;
            let v = raw[b] | (raw[b + 1] << 8) | (raw[b + 2] << 16);
            if (v & 0x800000) v |= 0xff000000; // sign-extend 24 -> 32
            return v * posScale;
        });
        const scale = [0, 1, 2].map(k => Math.exp(raw[scaleOff + i * 3 + k] / 16 - 10));
        const xyz = [0, 1, 2].map(k => raw[rotOff + i * 3 + k] / 127.5 - 1);
        const w = Math.sqrt(Math.max(0, 1 - (xyz[0] ** 2 + xyz[1] ** 2 + xyz[2] ** 2)));
        const colorRgb = [0, 1, 2].map(k => {
            const sh = (raw[colorOff + i * 3 + k] / 255 - 0.5) / COLOR_SCALE;
            return sh * SH_C0 + 0.5;
        });
        splats.push({ position, scale, quaternion: [...xyz, w], colorRgb, opacity: raw[alphaOff + i] / 255 });
    }
    return { header, splats };
}

const SAMPLE: BakedGaussian[] = [
    { position: [1.25, -2.5, 3.75], scale: [0.05, 0.08, 0.02], quaternion: [0, 0, 0, 1], colorRgb: [255, 128, 64], opacity: 0.85 },
    { position: [-0.5, 1.0, -1.5], scale: [0.1, 0.1, 0.1], quaternion: [0, 0.7071, 0, 0.7071], colorRgb: [32, 200, 255], opacity: 0.95 },
    // w negative: encoder must flip the sign so w >= 0 (spec) and the decoded rotation is equivalent
    { position: [12.0, 0.25, -40.0], scale: [0.3, 0.02, 0.6], quaternion: [0.5, -0.5, 0.5, -0.5], colorRgb: [10, 10, 10], opacity: 0.2 }
];

describe('Niantic SPZ v2 codec (spec-exact, interoperable)', () => {
    it('TS encoder output decodes with the independent reference decoder', () => {
        const gz = SplatService.serializeSpzBuffer(SAMPLE);
        const { header, splats } = referenceDecodeNianticSpz(gz);
        expect(header.magic).toBe(0x5053474e);
        expect(header.version).toBe(2);
        expect(header.numPoints).toBe(3);
        expect(header.shDegree).toBe(0);
        expect(header.fractionalBits).toBe(12);
        expect(header.reserved).toBe(0);

        for (let i = 0; i < SAMPLE.length; i++) {
            const s = SAMPLE[i], d = splats[i];
            for (let k = 0; k < 3; k++) {
                expect(d.position[k]).toBeCloseTo(s.position[k], 3);          // 1/4096 m
                expect(d.scale[k] / s.scale[k]).toBeGreaterThan(0.93);        // 1/16 in log space
                expect(d.scale[k] / s.scale[k]).toBeLessThan(1.07);
                expect(d.colorRgb[k] * 255).toBeCloseTo(s.colorRgb[k], -1);   // SH-DC u8 round trip ~ +/-3
            }
            expect(d.opacity).toBeCloseTo(s.opacity, 2);
            // Rotation equivalence up to sign: |dot| ~ 1
            const q = s.quaternion!; const qn = Math.hypot(...q);
            const dot = q.reduce((acc, v, k) => acc + (v / qn) * d.quaternion[k], 0);
            expect(Math.abs(dot)).toBeGreaterThan(0.995);
            expect(d.quaternion[3]).toBeGreaterThanOrEqual(0);
        }
    });

    it('TS decoder reads spec files and still reads the legacy SPZ1 layout', () => {
        const gz = SplatService.serializeSpzBuffer(SAMPLE);
        const back = SplatService.parseSpzBuffer(gz);
        expect(back.length).toBe(3);
        expect(back[0].position[0]).toBeCloseTo(1.25, 3);
        expect(back[2].colorRgb[0]).toBeLessThan(20);

        // Legacy SPZ1 (interleaved 22 B records) must remain decodable
        const legacy = Buffer.alloc(16 + 22);
        legacy.writeUInt32LE(0x315a5053, 0); legacy.writeUInt32LE(1, 4); legacy.writeUInt32LE(1, 8); legacy.writeUInt8(12, 12);
        legacy.writeInt32LE(Math.round(2.0 * 4096), 16); legacy.writeInt32LE(0, 20); legacy.writeInt32LE(0, 24);
        legacy.writeInt8(0, 28); legacy.writeInt8(0, 29); legacy.writeInt8(0, 30);
        legacy.writeInt8(0, 31); legacy.writeInt8(0, 32); legacy.writeInt8(0, 33);
        legacy.writeUInt8(255, 34); legacy.writeUInt8(0, 35); legacy.writeUInt8(0, 36); legacy.writeUInt8(255, 37);
        const l = SplatService.parseSpzBuffer(zlib.gzipSync(legacy));
        expect(l.length).toBe(1);
        expect(l[0].position[0]).toBeCloseTo(2.0, 3);
    });
});

describe('Splat -> 3D Tiles (octree, KHR_gaussian_splatting GLB tiles, tileset.json)', () => {
    const outDir = path.resolve(process.cwd(), 'build/test_splat_tiles');
    const inputSplat = path.join(outDir, 'input.splat');
    const N = 20000;
    let service: Splat3DTilesService;
    let result: Awaited<ReturnType<Splat3DTilesService['convert']>>;

    beforeAll(async () => {
        await fs.emptyDir(outDir);
        // Deterministic synthetic cloud: 3 clusters + a sparse shell so the octree is unbalanced
        const splats: BakedGaussian[] = [];
        let seed = 42;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        for (let i = 0; i < N; i++) {
            const c = i % 3;
            const cx = [-20, 0, 25][c], cz = [-10, 30, 5][c];
            const r = i < N * 0.9 ? 4 : 60;
            splats.push({
                position: [cx + (rnd() - 0.5) * r, (rnd()) * 6, cz + (rnd() - 0.5) * r],
                scale: [0.05 + rnd() * 0.05, 0.05 + rnd() * 0.05, 0.02],
                quaternion: [0, 0, 0, 1],
                colorRgb: [rnd() * 255, rnd() * 255, rnd() * 255],
                opacity: 0.6 + rnd() * 0.4
            });
        }
        await fs.outputFile(inputSplat, SplatService.serializeSplatBuffer(splats));
        service = new Splat3DTilesService();
        result = await service.convert({
            inputPath: inputSplat,
            outDir,
            maxDepth: 7,
            leafCapacity: 2000,
            origin: { lat: 41.8986, lng: 12.4768, alt: 20 } // Pantheon, Rome
        });
    }, 180000);

    it('emits a tileset.json with REPLACE refinement, box volumes and gltf content extensions', async () => {
        expect(result.success).toBe(true);
        const tileset = await fs.readJson(result.tilesetPath);
        expect(tileset.asset.version).toBe('1.1');
        expect(tileset.extensionsUsed).toContain('3DTILES_content_gltf');
        expect(tileset.extensions['3DTILES_content_gltf'].extensionsUsed).toEqual(
            expect.arrayContaining(['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'])
        );
        expect(tileset.root.refine).toBe('REPLACE');
        expect(tileset.root.boundingVolume.box).toHaveLength(12);
        expect(tileset.root.geometricError).toBeGreaterThan(0);
        expect(Array.isArray(tileset.root.transform)).toBe(true);
        expect(tileset.root.transform).toHaveLength(16);
    });

    it('root.transform places the ENU frame on the WGS-84 ellipsoid (translation == ECEF of origin, Y-up -> Z-up)', async () => {
        const tileset = await fs.readJson(result.tilesetPath);
        const T = tileset.root.transform as number[]; // column-major
        const ltp = new LocalTangentPlane({ lat: 41.8986, lng: 12.4768, alt: 20 });
        // A point 1 m east of the origin in Three.js space (x=1,y=0,z=0) must land ~1 m from origin in ECEF
        const originEcef = (ltp as any).geodeticToEcef(41.8986 * Math.PI / 180, 12.4768 * Math.PI / 180, 20) as number[];
        expect(T[12]).toBeCloseTo(originEcef[0], 3);
        expect(T[13]).toBeCloseTo(originEcef[1], 3);
        expect(T[14]).toBeCloseTo(originEcef[2], 3);
        // Rotation columns are unit length and orthogonal
        const col = (i: number) => [T[i * 4], T[i * 4 + 1], T[i * 4 + 2]];
        for (let i = 0; i < 3; i++) expect(Math.hypot(...col(i))).toBeCloseTo(1, 6);
        const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(dot(col(0), col(1))).toBeCloseTo(0, 6);
        expect(dot(col(0), col(2))).toBeCloseTo(0, 6);
        // Tileset frame is ENU (Z-up): column 2 (tileset Z) must be the ellipsoid normal at the origin
        const upEcef = col(2);
        const n = originEcef.map(v => v / Math.hypot(...originEcef));
        expect(dot(upEcef, n)).toBeGreaterThan(0.99);
        // Column 0 (tileset X = east) is tangent to the ellipsoid and has no component along ECEF Z
        expect(Math.abs(col(0)[2])).toBeLessThan(1e-9);
        expect(dot(col(0), n)).toBeCloseTo(0, 6);
    });

    it('bounding boxes are written in the Z-up tileset frame (glTF y -> tileset z, glTF z -> tileset -y)', async () => {
        const tileset = await fs.readJson(result.tilesetPath);
        const tree = await fs.readJson(result.treePath);
        const box = tileset.root.boundingVolume.box as number[];
        const min = tree.root.contentMin as number[], max = tree.root.contentMax as number[];
        const cG = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        expect(box[0]).toBeCloseTo(cG[0], 4);
        expect(box[1]).toBeCloseTo(-cG[2], 4);
        expect(box[2]).toBeCloseTo(cG[1], 4);
        expect(box[3]).toBeCloseTo((max[0] - min[0]) / 2, 4);   // X half-extent
        expect(box[7]).toBeCloseTo((max[2] - min[2]) / 2, 4);   // tileset Y half-extent from glTF z
        expect(box[11]).toBeCloseTo((max[1] - min[1]) / 2, 4);  // tileset Z half-extent from glTF y
    });

    it('octree invariants: every splat lands in exactly one leaf, leaves respect capacity, children inside parents', async () => {
        const tree = await fs.readJson(result.treePath);
        let leafTotal = 0;
        const walk = (node: any, parent?: any) => {
            if (parent) {
                for (let k = 0; k < 3; k++) {
                    expect(node.min[k]).toBeGreaterThanOrEqual(parent.min[k] - 1e-4);
                    expect(node.max[k]).toBeLessThanOrEqual(parent.max[k] + 1e-4);
                }
                expect(node.geometricError).toBeLessThan(parent.geometricError);
            }
            if (!node.children || node.children.length === 0) {
                expect(node.leafSplatCount).toBeLessThanOrEqual(2000 * 1.0001 + 1);
                expect(node.leafSplatCount).toBeGreaterThan(0);
                leafTotal += node.leafSplatCount;
            } else {
                expect(node.children.length).toBeLessThanOrEqual(8);
                node.children.forEach((c: any) => walk(c, node));
            }
        };
        walk(tree.root);
        expect(leafTotal).toBe(N);
        expect(result.tileCount).toBeGreaterThan(1);
        expect(result.levels).toBeGreaterThan(1);
    });

    it('each tile GLB is a KHR_gaussian_splatting POINTS primitive whose SPZ payload decodes with the reference decoder', async () => {
        const tileset = await fs.readJson(result.tilesetPath);
        const uris: string[] = [];
        const collect = (t: any) => { if (t.content?.uri) uris.push(t.content.uri); (t.children || []).forEach(collect); };
        collect(tileset.root);
        expect(uris.length).toBe(result.tileCount);

        let decodedTotal = 0;
        for (const uri of uris) {
            const glb = await fs.readFile(path.join(path.dirname(result.tilesetPath), uri));
            expect(glb.toString('utf8', 0, 4)).toBe('glTF');
            const jsonLen = glb.readUInt32LE(12);
            const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
            expect(json.extensionsUsed).toEqual(expect.arrayContaining(['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2']));
            expect(json.extensionsRequired).toEqual(expect.arrayContaining(['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2']));
            const prim = json.meshes[0].primitives[0];
            expect(prim.mode).toBe(0);
            for (const a of ['POSITION', 'COLOR_0', 'KHR_gaussian_splatting:SCALE', 'KHR_gaussian_splatting:ROTATION', 'KHR_gaussian_splatting:OPACITY']) {
                expect(prim.attributes[a]).toBeTypeOf('number');
                expect(json.accessors[prim.attributes[a]].bufferView).toBeUndefined(); // data lives in the SPZ blob
            }
            expect(json.meshes[0].primitives[0].extensions.KHR_gaussian_splatting.extensions.KHR_gaussian_splatting_compression_spz_2.bufferView).toBe(0);
            const posAcc = json.accessors[prim.attributes.POSITION];
            expect(posAcc.min).toHaveLength(3); expect(posAcc.max).toHaveLength(3);

            const binLen = glb.readUInt32LE(20 + jsonLen);
            const bin = glb.subarray(28 + jsonLen, 28 + jsonLen + binLen);
            const bv = json.bufferViews[0];
            const spz = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
            const { header, splats } = referenceDecodeNianticSpz(Buffer.from(spz));
            expect(header.numPoints).toBe(posAcc.count);
            // Positions inside the accessor bounds (and thus inside the tile's bounding box)
            for (const s of splats) for (let k = 0; k < 3; k++) {
                expect(s.position[k]).toBeGreaterThanOrEqual(posAcc.min[k] - 1e-3);
                expect(s.position[k]).toBeLessThanOrEqual(posAcc.max[k] + 1e-3);
            }
            decodedTotal += splats.length;
        }
        // Interior LOD tiles add simplified splats on top of the N leaf splats
        expect(decodedTotal).toBeGreaterThanOrEqual(N);
    });
});
