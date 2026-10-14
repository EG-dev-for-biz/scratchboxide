/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * MaterialDetailBaker on a synthetic textured scan:
 *   A  facade whose tile (0.5 m texels) is a box-filtered ground truth with fine joints and grain; the library holds a
 *      swatch of that material at 3 cm/px. The bake must recover the ground truth's high band (above the tile Nyquist)
 *      at 4x while leaving the low band (colour, tint) of the tile unchanged.
 *   B  roof with an unrelated colour: no material, image and geometry byte-identical.
 *   C  facade whose tile is already as sharp as it can be (1-texel checker): local sharpness must never drop.
 * Plus: unlit kept, no metallic, JPEG output, budget enforcement, plane clustering.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
    loadBaseScan, buildPlaneClusters, describeClusters, classifyClusters, bakeMaterialDetail, LinearImageCache, buildDetailMap,
    type BakeResult, type BaseScan
} from '../src/node/spatial/MaterialDetailBaker';
import type { MaterialLibrary, MaterialLibrarySample } from '../src/node/spatial/StreetViewMaterialHarvester';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { encodePng } from '../src/node/texture-processing';
import { encodeRgbaToJpeg, decodeImageToRgba } from '../src/node/image-codec-ffmpeg';
import { upsampleBicubic3 } from '../src/node/spatial/StreetViewTextureFusion';
import { linearRgbToLab, luminance8 } from '../src/node/spatial/StreetViewStage3Metrics';
import { HOW_TO, requireBinary, withReason } from './helpers/requirements';

// The synthetic scan's tiles are JPEGs: encodeRgbaToJpeg / decodeImageToRgba run ffmpeg (FFMPEG_PATH or PATH).
const ffmpeg = requireBinary(process.env.FFMPEG_PATH || 'ffmpeg', HOW_TO.ffmpeg);

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test-results/screenshots');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-matbake-'));

type V3 = [number, number, number];
const toSrgb8 = (v: number) => { const c = Math.min(1, Math.max(0, v)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255); };
const toLin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

const BASE: V3 = [0.50, 0.45, 0.38];
const distToGrid = (x: number, p: number) => { const r = ((x % p) + p) % p; return Math.min(r, p - r); };
/** Fine material detail (mean ~1), symmetric about every multiple of 0.5 m so a mirrored projection is identical. */
function detail(x: number, y: number): number {
    const jx = Math.exp(-((distToGrid(x, 0.5) / 0.025) ** 2)), jy = Math.exp(-((distToGrid(y, 0.25) / 0.025) ** 2));
    return (1 - 0.45 * jx) * (1 - 0.45 * jy) * (1 + 0.12 * Math.cos(2 * Math.PI * x / 0.125) * Math.cos(2 * Math.PI * y / 0.125));
}
/** Ground truth on facade A (linear RGB): base x low-frequency tint (resolvable by the tile) x fine detail. */
function truthA(x: number, y: number): V3 {
    const tint = 1 + 0.15 * Math.cos(2 * Math.PI * x / 8) * Math.cos(2 * Math.PI * y / 8);
    const d = detail(x, y) * tint;
    return [BASE[0] * d, BASE[1] * d, BASE[2] * d];
}
/** Box-filtered W x H image of fn over [x0, x0 + size] x [y0, y0 + size] (row 0 = top), n x n supersamples. */
function boxImage(W: number, H: number, sizeX: number, sizeY: number, fn: (x: number, y: number) => V3, n = 12, x0 = 0, y0 = 0): Float32Array {
    const out = new Float32Array(W * H * 3);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const acc = [0, 0, 0];
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            const c = fn(x0 + (i + (a + 0.5) / n) / W * sizeX, y0 + sizeY - (j + (b + 0.5) / n) / H * sizeY);
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
        for (let k = 0; k < 3; k++) out[(j * W + i) * 3 + k] = acc[k] / (n * n);
    }
    return out;
}
const toRgba8 = (lin: Float32Array, n: number) => { const b = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) b[i * 4 + c] = toSrgb8(lin[i * 3 + c]); b[i * 4 + 3] = 255; } return b; };

interface SynthPrim { positions: number[]; uvs: number[]; indices: number[]; image: Buffer }

function packSyntheticGlb(prims: SynthPrim[]): Buffer {
    const views: Buffer[] = [];
    const gltf: any = {
        asset: { version: '2.0', generator: 'synthetic' }, scene: 0, scenes: [{ nodes: prims.map((_, i) => i) }],
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

/** Quad (two CCW triangles seen from the +normal side) with UV (0,0) at the top-left corner. */
function quad(p00: V3, p10: V3, p11: V3, p01: V3): { positions: number[]; uvs: number[]; indices: number[] } {
    return { positions: [...p00, ...p10, ...p11, ...p01], uvs: [0, 1, 1, 1, 1, 0, 0, 0], indices: [0, 1, 2, 0, 2, 3] };
}

function gauss1(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
    const r = Math.ceil(3 * sigma), k: number[] = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { k.push(Math.exp(-(i * i) / (2 * sigma * sigma))); ks += k[k.length - 1]; }
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -r; d <= r; d++) s += k[d + r] * src[y * W + Math.min(W - 1, Math.max(0, x + d))]; tmp[y * W + x] = s / ks; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -r; d <= r; d++) s += k[d + r] * tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x]; out[y * W + x] = s / ks; }
    return out;
}
const lumaLin = (rgb: Float32Array, n: number) => { const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]; return Y; };
function corr(a: Float32Array, b: Float32Array, idx: number[]): number {
    let ma = 0, mb = 0;
    for (const i of idx) { ma += a[i]; mb += b[i]; }
    ma /= idx.length; mb /= idx.length;
    let num = 0, va = 0, vb = 0;
    for (const i of idx) { num += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return num / Math.sqrt(va * vb);
}
function energy(a: Float32Array, idx: number[]): number { let m = 0; for (const i of idx) m += a[i]; m /= idx.length; let v = 0; for (const i of idx) v += (a[i] - m) ** 2; return v / idx.length; }

async function imageOf(glb: Buffer, imageIndex: number): Promise<{ bytes: Buffer; width: number; height: number; rgba: Buffer; mime: string }> {
    const { json, bin } = AlgorithmicUvEngine.parseGlb(glb);
    const v = json.bufferViews[json.images[imageIndex].bufferView];
    const bytes = Buffer.from(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
    const d = await decodeImageToRgba(bytes);
    return { bytes, width: d.width, height: d.height, rgba: d.rgba, mime: json.images[imageIndex].mimeType };
}
function accessorBytes(glb: Buffer, accessor: number): Buffer {
    const { json, bin } = AlgorithmicUvEngine.parseGlb(glb);
    const v = json.bufferViews[json.accessors[accessor].bufferView];
    return Buffer.from(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!ffmpeg.ok)(withReason('MaterialDetailBaker', ffmpeg), () => {
    const TILE = 32, SIZE = 16; // 0.5 m tile texels
    let glbIn: Buffer;
    let tileA: Float32Array;
    let library: MaterialLibrary;
    let result: BakeResult;
    let scan: BaseScan;
    const libDir = path.join(WORK, 'lib');

    beforeAll(async () => {
        tileA = boxImage(TILE, TILE, SIZE, SIZE, truthA, 16);
        // C: already-sharp 1-texel checker with the same mean colour as A
        let mean: V3 = [0, 0, 0];
        for (let i = 0; i < TILE * TILE; i++) for (let c = 0; c < 3; c++) mean[c] += tileA[i * 3 + c] / (TILE * TILE);
        const tileC = new Float32Array(TILE * TILE * 3);
        for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) { const f = (i + j) & 1 ? 1.4 : 0.6; for (let c = 0; c < 3; c++) tileC[(j * TILE + i) * 3 + c] = mean[c] * f; }
        const tileB = new Float32Array(TILE * TILE * 3);
        for (let i = 0; i < TILE * TILE; i++) { tileB[i * 3] = 0.25; tileB[i * 3 + 1] = 0.04; tileB[i * 3 + 2] = 0.03; }
        const jpeg = (lin: Float32Array) => encodeRgbaToJpeg(toRgba8(lin, TILE * TILE), TILE, TILE, { quality: 95, chroma: '444' });
        glbIn = packSyntheticGlb([
            { ...quad([0, 0, 0], [SIZE, 0, 0], [SIZE, SIZE, 0], [0, SIZE, 0]), image: await jpeg(tileA) },
            { ...quad([0, SIZE, 0], [SIZE, SIZE, 0], [SIZE, SIZE, -SIZE], [0, SIZE, -SIZE]), image: await jpeg(tileB) },
            { ...quad([20, 0, 0], [20 + SIZE, 0, 0], [20 + SIZE, SIZE, 0], [20, SIZE, 0]), image: await jpeg(tileC) }
        ]);
        const glbPath = path.join(WORK, 'base.glb');
        fs.writeFileSync(glbPath, glbIn);
        // library: a 256 px swatch (8 m at 3.125 cm/px) of the detail on the base colour
        fs.mkdirSync(path.join(libDir, 'swatches'), { recursive: true });
        const SW = 256, mpp = 8 / SW;
        const sw = new Float32Array(SW * SW * 3);
        for (let j = 0; j < SW; j++) for (let i = 0; i < SW; i++) {
            let acc = 0;
            for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) acc += detail((i + (a + 0.5) / 4) * mpp, -(j + (b + 0.5) / 4) * mpp);
            for (let c = 0; c < 3; c++) sw[(j * SW + i) * 3 + c] = BASE[c] * acc / 16;
        }
        fs.writeFileSync(path.join(libDir, 'swatches', 's0_albedo.png'), encodePng(SW, SW, toRgba8(sw, SW * SW)));
        // the sample's source-tile colour is A's tile colour (as the harvester would measure it)
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
        library = { version: 1, createdAt: '', segmentation: { model: 'synthetic', promptVersion: 1 }, samples: [sample], rejected: [] };
        scan = loadBaseScan(glbPath);
        const { triCluster, clusters } = buildPlaneClusters(scan);
        const images = new LinearImageCache(scan);
        await describeClusters(scan, triCluster, clusters, images);
        const assignments = classifyClusters(clusters, library);
        result = await bakeMaterialDetail(scan, triCluster, clusters, assignments, library, libDir, images, { maxScale: 4 });
        fs.writeFileSync(path.join(WORK, 'out.glb'), result.glb);
    }, 170_000);

    it('clusters coplanar connected triangles and keeps separate surfaces apart', () => {
        const { triCluster, clusters } = buildPlaneClusters(scan);
        expect(clusters).toHaveLength(3);
        expect(triCluster[0]).toBe(triCluster[1]);
        expect(triCluster[0]).not.toBe(triCluster[2]);
        expect(triCluster[4]).not.toBe(triCluster[0]); // C is coplanar with A but not connected
        const a = clusters[triCluster[0]];
        expect(a.area).toBeCloseTo(256, 3);
        expect(a.tiltDeg).toBeCloseTo(90, 3);
        expect(clusters[triCluster[2]].tiltDeg).toBeCloseTo(0, 3);
    });

    it('recovers the ground-truth high band on A at 4x and keeps the tile low band', async () => {
        const repA = result.reports.find(r => r.imageIndex === 0)!;
        expect(repA.replaced).toBe(true);
        expect(repA.scale).toBe(4);
        const out = await imageOf(result.glb, 0);
        expect(out.mime).toBe('image/jpeg');
        expect([out.width, out.height]).toEqual([128, 128]);
        const n = 128 * 128;
        const outLin = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) outLin[i * 3 + c] = toLin(out.rgba[i * 4 + c]);
        const inA = await imageOf(glbIn, 0);
        const inLin = new Float32Array(TILE * TILE * 3);
        for (let i = 0; i < TILE * TILE; i++) for (let c = 0; c < 3; c++) inLin[i * 3 + c] = toLin(inA.rgba[i * 4 + c]);
        const up = upsampleBicubic3(inLin, TILE, TILE, 4);
        const truth = boxImage(128, 128, SIZE, SIZE, truthA, 6);
        const Yo = lumaLin(outLin, n), Yu = lumaLin(up, n), Yt = lumaLin(truth, n);
        const hp = (Y: Float32Array) => { const L = gauss1(Y, 128, 128, 2); return Y.map((v, i) => v - L[i]); };
        const Ho = hp(Yo), Hu = hp(Yu), Ht = hp(Yt);
        const idx: number[] = [];
        for (let y = 6; y < 122; y++) for (let x = 6; x < 122; x++) idx.push(y * 128 + x);
        const cOut = corr(Ho, Ht, idx), cUp = corr(Hu, Ht, idx);
        const eRatio = energy(Ho, idx) / energy(Ht, idx), eUp = energy(Hu, idx) / energy(Ht, idx);
        expect(cOut).toBeGreaterThan(0.6);
        expect(cUp).toBeLessThan(0.3);
        expect(eRatio).toBeGreaterThan(0.4);
        expect(eRatio).toBeLessThan(2.5);
        expect(eUp).toBeLessThan(0.2);
        // low band (colour and the 8 m tint) unchanged
        const lowO = gauss1(Yo, 128, 128, 6), lowU = gauss1(Yu, 128, 128, 6);
        let mad = 0;
        for (const i of idx) mad += Math.abs(lowO[i] - lowU[i]);
        expect(mad / idx.length).toBeLessThan(0.01);
        expect(repA.sharpness!.ratio).toBeGreaterThan(2);
        expect(repA.coverageFraction).toBeGreaterThan(0.8);
        // visual record: bicubic tile | baked | ground truth
        const W3 = 128 * 3 + 16, sheet = Buffer.alloc(W3 * 128 * 4, 255);
        [toRgba8(up, n), out.rgba, toRgba8(truth, n)].forEach((im, k) => { for (let y = 0; y < 128; y++) im.copy(sheet, (y * W3 + k * 136) * 4, y * 512, (y + 1) * 512); });
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCREENSHOT_DIR, 'material_detail_bake_synthetic_recovery.png'), encodePng(W3, 128, sheet));
    });

    it('never reduces local sharpness where the tile is already sharp (C)', async () => {
        const repC = result.reports.find(r => r.imageIndex === 2)!;
        expect(repC.blocksWithSharpnessLoss).toBe(0);
        const inC = await imageOf(glbIn, 2);
        const outC = await imageOf(result.glb, 2);
        if (!repC.replaced) { expect(sha(outC.bytes)).toBe(sha(inC.bytes)); return; }
        const s = outC.width / TILE;
        const lin = new Float32Array(TILE * TILE * 3);
        for (let i = 0; i < TILE * TILE; i++) for (let c = 0; c < 3; c++) lin[i * 3 + c] = toLin(inC.rgba[i * 4 + c]);
        const up = upsampleBicubic3(lin, TILE, TILE, s);
        const W = outC.width, n = W * W;
        const Yb = luminance8(toRgba8(up.map(v => Math.min(1, Math.max(0, v))), n), n), Yo = luminance8(outC.rgba, n);
        const B = 4 * s;
        for (let by = 0; by < W / B; by++) for (let bx = 0; bx < W / B; bx++) {
            let eb = 0, eo = 0;
            for (let y = Math.max(1, by * B); y < Math.min(W - 1, (by + 1) * B); y++) for (let x = Math.max(1, bx * B); x < Math.min(W - 1, (bx + 1) * B); x++) {
                const i = y * W + x;
                eb += (Yb[i - 1] + Yb[i + 1] + Yb[i - W] + Yb[i + W] - 4 * Yb[i]) ** 2;
                eo += (Yo[i - 1] + Yo[i + 1] + Yo[i - W] + Yo[i + W] - 4 * Yo[i]) ** 2;
            }
            expect(eo).toBeGreaterThanOrEqual(0.97 * eb);
        }
    });

    it('leaves unmatched primitives byte-identical and keeps materials unlit and non-metallic', async () => {
        const repB = result.reports.find(r => r.imageIndex === 1)!;
        expect(repB.replaced).toBe(false);
        expect(sha((await imageOf(result.glb, 1)).bytes)).toBe(sha((await imageOf(glbIn, 1)).bytes));
        for (let a = 0; a < 9; a++) expect(sha(accessorBytes(result.glb, a))).toBe(sha(accessorBytes(glbIn, a)));
        const jIn = AlgorithmicUvEngine.parseGlb(glbIn).json, jOut = AlgorithmicUvEngine.parseGlb(result.glb).json;
        expect(jOut.materials).toEqual(jIn.materials);
        expect(jOut.images).toHaveLength(jIn.images.length);
        expect(jOut.extensionsUsed).toEqual(['KHR_materials_unlit']);
        for (const m of jOut.materials) { expect(m.pbrMetallicRoughness.metallicFactor).toBe(0); expect(m.extensions.KHR_materials_unlit).toBeDefined(); }
        expect(result.glb.readUInt32LE(8)).toBe(result.glb.length);
    });

    it('respects the byte budget (downgrade, then drop)', async () => {
        const { triCluster, clusters } = buildPlaneClusters(scan);
        const images = new LinearImageCache(scan);
        await describeClusters(scan, triCluster, clusters, images);
        const assignments = classifyClusters(clusters, library);
        const tight = await bakeMaterialDetail(scan, triCluster, clusters, assignments, library, libDir, images, { maxScale: 4, budgetBytes: glbIn.length + 1500 });
        expect(tight.glb.length).toBeLessThanOrEqual(glbIn.length + 1500);
        const repA = tight.reports.find(r => r.imageIndex === 0)!;
        expect(repA.scale === 2 || !repA.replaced).toBe(true);
    });

    it('keeps an atlas byte-identical when the measured sharpness gain is below the gate', async () => {
        const { triCluster, clusters } = buildPlaneClusters(scan);
        const images = new LinearImageCache(scan);
        await describeClusters(scan, triCluster, clusters, images);
        const r = await bakeMaterialDetail(scan, triCluster, clusters, classifyClusters(clusters, library), library, libDir, images, { maxScale: 4, minSharpnessGain: 1e6 });
        expect(r.reports.every(x => !x.replaced)).toBe(true);
        expect(r.reports.find(x => x.imageIndex === 0)!.reason).toMatch(/sharpness gain/);
        for (let i = 0; i < 3; i++) expect(sha((await imageOf(r.glb, i)).bytes)).toBe(sha((await imageOf(glbIn, i)).bytes));
    });
});

// buildDetailMap is pure math on in-memory buffers: it needs neither ffmpeg nor the synthetic scan above.
describe('MaterialDetailBaker detail maps', () => {
    it('detail maps are band-limited ratios around 1', () => {
        const W = 64, Y = new Float32Array(W * W);
        for (let i = 0; i < W * W; i++) Y[i] = 0.4 * detail((i % W) / 32, Math.floor(i / W) / 32);
        const dm = buildDetailMap(Y, W, W, 1 / 32, 1 / 32, 0.5, 4);
        let m = 0, lo = Infinity, hi = -Infinity;
        for (const v of dm.ratio) { m += v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
        expect(m / dm.ratio.length).toBeGreaterThan(0.95);
        expect(m / dm.ratio.length).toBeLessThan(1.05);
        expect(lo).toBeGreaterThanOrEqual(0.45);
        expect(hi).toBeLessThanOrEqual(1.9);
        expect(hi - lo).toBeGreaterThan(0.15);
        // fine detail only (periods below 2 tile texels): full weight
        expect(dm.structureWeight).toBeGreaterThan(0.9);
        // a composite swatch with a 2 m window grid on a 0.5 m tile: the tile resolves the grid, so the swatch's sharp
        // window edges would double the tile's own grid -> strongly down-weighted
        const G = new Float32Array(W * W);
        for (let i = 0; i < W * W; i++) { const x = (i % W) / 32, y = Math.floor(i / W) / 32; G[i] = (x % 1 < 0.45 && y % 1 < 0.6) ? 0.08 : 0.5; }
        const dg = buildDetailMap(G, W, W, 1 / 32, 1 / 32, 0.25, 4);
        expect(dg.resolvableStructureContrast).toBeGreaterThan(0.25);
        expect(dg.structureWeight).toBeLessThan(0.1);
    });
});
