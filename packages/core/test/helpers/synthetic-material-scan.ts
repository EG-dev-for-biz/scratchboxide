/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A synthetic textured scan and its swatch library, as material-detail-bake.test.ts builds them: facade A (16 m, 0.5 m
 * tile texels, a box-filtered ground truth with fine joints and grain), roof B (an unrelated red), and a library holding
 * a 3.125 cm/px swatch of A's material whose source-tile colour is A's. The tiles are JPEGs (ffmpeg on PATH).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MaterialLibrary, MaterialLibrarySample } from '../../src/node/spatial/StreetViewMaterialHarvester';
import { GltfBinaryPacker } from '../../src/node/3d-engine/gltf-binary-packer';
import { encodePng } from '../../src/node/texture-processing';
import { encodeRgbaToJpeg } from '../../src/node/image-codec-ffmpeg';
import { linearRgbToLab } from '../../src/node/spatial/StreetViewStage3Metrics';

type V3 = [number, number, number];
const toSrgb8 = (v: number) => { const c = Math.min(1, Math.max(0, v)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255); };
const toLin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const BASE: V3 = [0.50, 0.45, 0.38];
const distToGrid = (x: number, p: number) => { const r = ((x % p) + p) % p; return Math.min(r, p - r); };
function detail(x: number, y: number): number {
    const jx = Math.exp(-((distToGrid(x, 0.5) / 0.025) ** 2)), jy = Math.exp(-((distToGrid(y, 0.25) / 0.025) ** 2));
    return (1 - 0.45 * jx) * (1 - 0.45 * jy) * (1 + 0.12 * Math.cos(2 * Math.PI * x / 0.125) * Math.cos(2 * Math.PI * y / 0.125));
}
function truthA(x: number, y: number): V3 {
    const tint = 1 + 0.15 * Math.cos(2 * Math.PI * x / 8) * Math.cos(2 * Math.PI * y / 8);
    const d = detail(x, y) * tint;
    return [BASE[0] * d, BASE[1] * d, BASE[2] * d];
}
function boxImage(W: number, H: number, sizeX: number, sizeY: number, fn: (x: number, y: number) => V3, n = 12): Float32Array {
    const out = new Float32Array(W * H * 3);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const acc = [0, 0, 0];
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            const c = fn((i + (a + 0.5) / n) / W * sizeX, sizeY - (j + (b + 0.5) / n) / H * sizeY);
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
        for (let k = 0; k < 3; k++) out[(j * W + i) * 3 + k] = acc[k] / (n * n);
    }
    return out;
}
const toRgba8 = (lin: Float32Array, n: number) => { const b = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) b[i * 4 + c] = toSrgb8(lin[i * 3 + c]); b[i * 4 + 3] = 255; } return b; };

function packGlb(prims: Array<{ positions: number[]; uvs: number[]; indices: number[]; image: Buffer }>, assetExtras?: unknown): Buffer {
    const views: Buffer[] = [];
    const gltf: any = {
        asset: { version: '2.0', generator: 'synthetic', ...(assetExtras ? { extras: assetExtras } : {}) }, scene: 0, scenes: [{ nodes: prims.map((_, i) => i) }],
        nodes: prims.map((_, i) => ({ mesh: i, name: `mesh_${i}` })), meshes: [], materials: [], textures: [], images: [],
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }], accessors: [], bufferViews: [], extensionsUsed: ['KHR_materials_unlit']
    };
    const addView = (b: Buffer, target?: number) => { views.push(b); gltf.bufferViews.push(target ? { buffer: 0, target } : { buffer: 0 }); return views.length - 1; };
    prims.forEach((p, i) => {
        const pos = Buffer.from(new Float32Array(p.positions).buffer), uv = Buffer.from(new Float32Array(p.uvs).buffer), idx = Buffer.from(new Uint32Array(p.indices).buffer);
        const min = [0, 1, 2].map(k => Math.min(...p.positions.filter((_, j) => j % 3 === k))), max = [0, 1, 2].map(k => Math.max(...p.positions.filter((_, j) => j % 3 === k)));
        gltf.accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: p.positions.length / 3, type: 'VEC3', min, max });
        gltf.accessors.push({ bufferView: addView(uv, 34962), componentType: 5126, count: p.uvs.length / 2, type: 'VEC2' });
        gltf.accessors.push({ bufferView: addView(idx, 34963), componentType: 5125, count: p.indices.length, type: 'SCALAR' });
        gltf.images.push({ mimeType: 'image/jpeg', bufferView: addView(p.image) });
        gltf.textures.push({ sampler: 0, source: i });
        gltf.materials.push({ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.9, baseColorTexture: { index: i, texCoord: 0 } }, extensions: { KHR_materials_unlit: {} } });
        gltf.meshes.push({ primitives: [{ mode: 4, attributes: { POSITION: i * 3, TEXCOORD_0: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
    });
    return GltfBinaryPacker.packGlb(gltf, views, true).glbBuffer;
}
const quad = (p00: V3, p10: V3, p11: V3, p01: V3) => ({ positions: [...p00, ...p10, ...p11, ...p01], uvs: [0, 1, 1, 1, 1, 0, 0, 0], indices: [0, 1, 2, 0, 2, 3] });

/** Writes base.glb and lib/library.json under `work`; `assetExtras` go on the GLB's asset (e.g. a staged twin's sbTexture). */
export async function syntheticMaterialScan(work: string, assetExtras?: unknown): Promise<{ glbPath: string; libraryPath: string; library: MaterialLibrary }> {
    const TILE = 32, SIZE = 16;
    const tileA = boxImage(TILE, TILE, SIZE, SIZE, truthA, 16);
    const tileB = new Float32Array(TILE * TILE * 3);
    for (let i = 0; i < TILE * TILE; i++) { tileB[i * 3] = 0.25; tileB[i * 3 + 1] = 0.04; tileB[i * 3 + 2] = 0.03; }
    const jpeg = (lin: Float32Array) => encodeRgbaToJpeg(toRgba8(lin, TILE * TILE), TILE, TILE, { quality: 95, chroma: '444' });
    fs.mkdirSync(work, { recursive: true });
    const glbPath = path.join(work, 'base.glb');
    fs.writeFileSync(glbPath, packGlb([
        { ...quad([0, 0, 0], [SIZE, 0, 0], [SIZE, SIZE, 0], [0, SIZE, 0]), image: await jpeg(tileA) },
        { ...quad([0, SIZE, 0], [SIZE, SIZE, 0], [SIZE, SIZE, -SIZE], [0, SIZE, -SIZE]), image: await jpeg(tileB) }
    ], assetExtras));
    const libDir = path.join(work, 'lib');
    fs.mkdirSync(path.join(libDir, 'swatches'), { recursive: true });
    const SW = 256, mpp = 8 / SW;
    const sw = new Float32Array(SW * SW * 3);
    for (let j = 0; j < SW; j++) for (let i = 0; i < SW; i++) {
        let acc = 0;
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) acc += detail((i + (a + 0.5) / 4) * mpp, -(j + (b + 0.5) / 4) * mpp);
        for (let c = 0; c < 3; c++) sw[(j * SW + i) * 3 + c] = BASE[c] * acc / 16;
    }
    fs.writeFileSync(path.join(libDir, 'swatches', 's0_albedo.png'), encodePng(SW, SW, toRgba8(sw, SW * SW)));
    let mean: V3 = [0, 0, 0];
    for (let i = 0; i < TILE * TILE; i++) for (let c = 0; c < 3; c++) mean[c] += tileA[i * 3 + c] / (TILE * TILE);
    const labs: V3[] = [];
    for (let i = 0; i < TILE * TILE; i++) labs.push(linearRgbToLab(toLin(toSrgb8(tileA[i * 3])), toLin(toSrgb8(tileA[i * 3 + 1])), toLin(toSrgb8(tileA[i * 3 + 2]))));
    const lm: V3 = [0, 1, 2].map(k => labs.reduce((s, l) => s + l[k], 0) / labs.length) as V3;
    const ls: V3 = [0, 1, 2].map(k => Math.sqrt(labs.reduce((s, l) => s + (l[k] - lm[k]) ** 2, 0) / labs.length)) as V3;
    const sample = {
        id: 'synthetic__s0', label: 'synthetic ashlar', description: 'test material',
        source: { frame: 'synthetic', poseSource: 'synthetic', poseConfidence: 1, polygonPx: [], centreWorld: [8, 8, 0.2] },
        files: { albedo: 'swatches/s0_albedo.png', normal: 'swatches/s0_albedo.png', orm: 'swatches/s0_albedo.png' },
        widthPx: SW, heightPx: SW, metresPerPixel: { u: mpp, v: mpp }, sizeMeters: { u: 8, v: 8 },
        plane: { origin: [8, 8, 0], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0], tiltDeg: 90, method: 'mesh-plane', inlierFraction: 1, quadOrthogonalityErrorDeg: null },
        geometry: { distanceMeters: 30, incidenceCos: 0.9, heightAboveGround: null, photoFootprintMeters: { fine: mpp, coarse: mpp } },
        tile: { texelMeters: 0.5, resolutionGain: 16, lab: { mean: lm, std: ls }, linearRgb: mean, pixels: 1000 },
        albedo: { lab: { mean: linearRgbToLab(...BASE), std: [3, 1, 1] }, linearRgb: BASE, lumaContrast: 0.2 },
        physical: { metalness: 0, roughness: 0.8, surfaceTiltHintDeg: 90 },
        quality: { axisDeviationDeg: 0, lineEvidence: 10, seamResidualBefore: 0, seamResidualAfter: 0, illuminationRange: 1, periodMeters: { u: 0.5, v: 0.25 }, occludedFraction: 0, score: 0.5 },
        kernel: { acceleration: 'node-v8' }
    } as unknown as MaterialLibrarySample;
    const library: MaterialLibrary = { version: 1, createdAt: '', segmentation: { model: 'synthetic', promptVersion: 1 }, samples: [sample], rejected: [] };
    const libraryPath = path.join(libDir, 'library.json');
    fs.writeFileSync(libraryPath, JSON.stringify(library));
    return { glbPath, libraryPath, library };
}
