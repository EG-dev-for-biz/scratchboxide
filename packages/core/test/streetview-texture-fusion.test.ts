/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * StreetViewTextureFusion: synthetic recovery of a known painted facade pattern from plates,
 * byte-identical fallback images, shared-material cloning, orphan removal, exposure recovery,
 * robust occluder rejection, size budget, and zero default-colour texels.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    StreetViewTextureFusion,
    compactGlb,
    deltaE2000,
    upsampleBicubic3,
    maskedChamferDistance,
    type StreetViewTextureFusionResult
} from '../src/node/spatial/StreetViewTextureFusion';
import { SurveyTextureUnprojector, type StationPlate } from '../src/node/spatial/SurveyTextureUnprojector';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { encodePng } from '../src/node/texture-processing';
import { decodeImageToRgba, encodeRgbaToJpeg, readImageDimensions, resolveFfmpegPath } from '../src/node/image-codec-ffmpeg';
import { findBinary, HOW_TO, withReason, type Requirement } from './helpers/requirements';

/** encodeRgbaToJpeg spawns resolveFfmpegPath() (FFMPEG_PATH, else `ffmpeg` on PATH). */
const ffmpeg: Requirement = findBinary(resolveFfmpegPath()) !== null
    ? { ok: true, reason: '' }
    : { ok: false, reason: `\`${resolveFfmpegPath()}\` not found (set FFMPEG_PATH or ${HOW_TO.ffmpeg})` };

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test-results/screenshots');
const WORK_DIR = path.resolve(process.cwd(), 'build/test_streetview_texture_fusion');

const toLin = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb8 = (v: number): number => { const c = Math.min(1, Math.max(0, v)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255); };

/** Ground-truth painted pattern on the front facade (linear RGB): low-frequency tint x 0.5 m checker. */
function frontPattern(x: number, y: number): [number, number, number] {
    const base: [number, number, number] = [0.30 + 0.10 * (y / 16), 0.25 + 0.05 * ((x + 8) / 16), 0.20];
    const k = (Math.floor(x / 0.5) + Math.floor(y / 0.5)) & 1;
    const f = k ? 1.5 : 0.55;
    return [base[0] * f, base[1] * f, base[2] * f];
}
/** Side facade pattern (linear RGB): horizontal bands. */
function sidePattern(z: number, y: number): [number, number, number] {
    const f = (Math.floor(y / 0.6) & 1) ? 1.4 : 0.6;
    return [0.22 * f, 0.30 * f, 0.26 + 0.004 * z];
}
/** Front-facade texel (u, v) -> world (x, y) on z = 8. */
const frontUvToXy = (u: number, v: number): [number, number] => [-8 + 16 * u, 16 * (1 - v)];

/** Box-filtered ground truth for a front-facade texel of a W x H atlas (n x n supersamples). */
function frontTexelTruth(i: number, j: number, W: number, H: number, n = 4): [number, number, number] {
    const acc = [0, 0, 0];
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const [x, y] = frontUvToXy((i + (a + 0.5) / n) / W, (j + (b + 0.5) / n) / H);
        const c = frontPattern(x, y);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    return [acc[0] / (n * n), acc[1] / (n * n), acc[2] / (n * n)];
}

interface SyntheticScene {
    glb: Buffer;
    frontTile: Buffer; // 32x32 RGBA (blurry tile texture)
    images: Buffer[];  // encoded image bytes by input image index
}

/**
 * Builds a GLB with 4 primitives (front z=+8, back z=-8, side x=+8, roof y=16) in separate meshes:
 *   prim 0 front -> material 0 -> image 0 (blurry 32x32 tile of frontPattern)
 *   prim 1 back  -> material 1 -> image 1
 *   prim 2 side  -> material 2 -> image 2 (shared atlas: side in u < 0.5)
 *   prim 3 roof  -> material 2 -> image 2 (roof in u > 0.5), UNSIGNED_BYTE indices
 *   image 3 is an orphan (no texture).
 * Materials are KHR_materials_unlit, metallicFactor 0, like Google 3D Tiles scans.
 */
async function buildSyntheticScene(): Promise<SyntheticScene> {
    const T = 32;
    const frontTile = Buffer.alloc(T * T * 4);
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
        // Blurry tile: 1 m box average around the texel centre (removes the 0.5 m checker).
        const [cx, cy] = frontUvToXy((i + 0.5) / T, (j + 0.5) / T);
        const acc = [0, 0, 0];
        for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) {
            const c = frontPattern(cx - 0.5 + (a + 0.5) / 8, cy - 0.5 + (b + 0.5) / 8);
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
        const o = (j * T + i) * 4;
        frontTile[o] = toSrgb8(acc[0] / 64); frontTile[o + 1] = toSrgb8(acc[1] / 64); frontTile[o + 2] = toSrgb8(acc[2] / 64); frontTile[o + 3] = 255;
    }
    const flat = (r: number, g: number, b: number, w: number, h: number): Buffer => {
        const out = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255; }
        return out;
    };
    const images = [
        await encodeRgbaToJpeg(frontTile, T, T, { quality: 95 }),
        await encodeRgbaToJpeg(flat(90, 80, 70, 16, 16), 16, 16, { quality: 90 }),
        await encodeRgbaToJpeg(flat(110, 130, 120, 32, 16), 32, 16, { quality: 90 }),
        await encodeRgbaToJpeg(flat(10, 200, 10, 8, 8), 8, 8, { quality: 90 })
    ];

    type Quad = { p: number[][]; uv: number[][]; byteIdx?: boolean };
    const quads: Quad[] = [
        { p: [[-8, 0, 8], [8, 0, 8], [8, 16, 8], [-8, 16, 8]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
        { p: [[8, 0, -8], [-8, 0, -8], [-8, 16, -8], [8, 16, -8]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
        { p: [[8, 0, 8], [8, 0, -8], [8, 16, -8], [8, 16, 8]], uv: [[0, 1], [0.5, 1], [0.5, 0], [0, 0]] },
        { p: [[-8, 16, 8], [8, 16, 8], [8, 16, -8], [-8, 16, -8]], uv: [[0.5, 1], [1, 1], [1, 0], [0.5, 0]], byteIdx: true }
    ];
    const chunks: Buffer[] = [];
    let len = 0;
    const bufferViews: any[] = [];
    const addView = (b: Buffer): number => {
        const pad = (4 - (len % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; }
        bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length });
        chunks.push(b); len += b.length;
        return bufferViews.length - 1;
    };
    const accessors: any[] = [];
    const meshes: any[] = [];
    quads.forEach((q, qi) => {
        const pos = new Float32Array(q.p.flat());
        const uv = new Float32Array(q.uv.flat());
        const idxArr = [0, 1, 2, 0, 2, 3];
        const idx = q.byteIdx ? Buffer.from(Uint8Array.from(idxArr)) : Buffer.from(new Uint16Array(idxArr).buffer);
        const min = [0, 1, 2].map(k => Math.min(...q.p.map(v => v[k])));
        const max = [0, 1, 2].map(k => Math.max(...q.p.map(v => v[k])));
        accessors.push({ bufferView: addView(Buffer.from(pos.buffer)), componentType: 5126, count: 4, type: 'VEC3', min, max });
        accessors.push({ bufferView: addView(Buffer.from(uv.buffer)), componentType: 5126, count: 4, type: 'VEC2' });
        accessors.push({ bufferView: addView(idx), componentType: q.byteIdx ? 5121 : 5123, count: 6, type: 'SCALAR' });
        meshes.push({ primitives: [{ attributes: { POSITION: qi * 3, TEXCOORD_0: qi * 3 + 1 }, indices: qi * 3 + 2, material: qi === 3 ? 2 : qi, mode: 4 }] });
    });
    const imageViews = images.map(b => addView(b));
    const bin = Buffer.concat(chunks, len);
    const unlitMat = (tex: number) => ({ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.9, baseColorTexture: { index: tex, texCoord: 0 } }, extensions: { KHR_materials_unlit: {} } });
    const json = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'root', children: [1, 2, 3, 4] }, { mesh: 0 }, { mesh: 1 }, { mesh: 2 }, { mesh: 3 }],
        meshes,
        accessors,
        bufferViews,
        buffers: [{ byteLength: bin.length }],
        materials: [unlitMat(0), unlitMat(1), unlitMat(2)],
        textures: [{ sampler: 0, source: 0 }, { sampler: 0, source: 1 }, { sampler: 0, source: 2 }],
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
        images: imageViews.map(bv => ({ mimeType: 'image/jpeg', bufferView: bv })),
        extensionsUsed: ['KHR_materials_unlit']
    };
    return { glb: AlgorithmicUvEngine.serializeGlb(json, bin), frontTile, images };
}

interface PlateSpec { eye: [number, number, number]; target: [number, number, number]; gain: number; occluder?: { cx: number; cy: number; r: number } }

const PLATE_SIZE = 256;
const PLATE_FOV = 60;

function poseOf(spec: PlateSpec) {
    return { x: spec.eye[0], y: spec.eye[1], z: spec.eye[2], targetX: spec.target[0], targetY: spec.target[1], targetZ: spec.target[2], fov: PLATE_FOV };
}

/** Camera basis + projection matching SurveyTextureUnprojector.prepareCameras. */
function cameraBasis(spec: PlateSpec) {
    const f = spec.target.map((v, k) => v - spec.eye[k]);
    const fl = Math.hypot(f[0], f[1], f[2]);
    const fw = f.map(v => v / fl);
    let r = [fw[1] * 0 - fw[2] * 1, fw[2] * 0 - fw[0] * 0, fw[0] * 1 - fw[1] * 0];
    const rl = Math.hypot(r[0], r[1], r[2]);
    r = r.map(v => v / rl);
    const u = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
    const P11 = 1 / Math.tan((PLATE_FOV * Math.PI) / 360);
    return { fw, r, u, P00: P11, P11 };
}

function projectToPlate(spec: PlateSpec, p: [number, number, number]): [number, number] | null {
    const { fw, r, u, P00, P11 } = cameraBasis(spec);
    const d = [p[0] - spec.eye[0], p[1] - spec.eye[1], p[2] - spec.eye[2]];
    const z = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
    if (z <= 0.1) return null;
    const x = d[0] * r[0] + d[1] * r[1] + d[2] * r[2], y = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    return [(P00 * x / z + 1) * PLATE_SIZE / 2, (1 - P11 * y / z) * PLATE_SIZE / 2];
}

/** Analytic ray-cast photo of the painted building (front + side facades) with exposure gain. */
function renderPlate(spec: PlateSpec, glb: Buffer, id: number): StationPlate {
    const { fw, r, u, P00, P11 } = cameraBasis(spec);
    const W = PLATE_SIZE, H = PLATE_SIZE;
    const rgba = Buffer.alloc(W * H * 4);
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
        const nx = (px + 0.5) / (W / 2) - 1, ny = 1 - (py + 0.5) / (H / 2);
        const dir = [0, 1, 2].map(k => fw[k] + r[k] * (nx / P00) + u[k] * (ny / P11));
        let col: [number, number, number] = [0.45, 0.6, 0.85]; // sky
        let best = Infinity;
        const tFront = (8 - spec.eye[2]) / dir[2];
        if (tFront > 0) {
            const x = spec.eye[0] + dir[0] * tFront, y = spec.eye[1] + dir[1] * tFront;
            if (x >= -8 && x <= 8 && y >= 0 && y <= 16 && spec.eye[2] > 8) { best = tFront; col = frontPattern(x, y); }
        }
        const tSide = (8 - spec.eye[0]) / dir[0];
        if (tSide > 0 && tSide < best && spec.eye[0] > 8) {
            const z = spec.eye[2] + dir[2] * tSide, y = spec.eye[1] + dir[1] * tSide;
            if (z >= -8 && z <= 8 && y >= 0 && y <= 16) { best = tSide; col = sidePattern(z, y); }
        }
        const o = (py * W + px) * 4;
        rgba[o] = toSrgb8(col[0] * spec.gain); rgba[o + 1] = toSrgb8(col[1] * spec.gain); rgba[o + 2] = toSrgb8(col[2] * spec.gain); rgba[o + 3] = 255;
        if (spec.occluder && Math.hypot(px + 0.5 - spec.occluder.cx, py + 0.5 - spec.occluder.cy) <= spec.occluder.r) {
            rgba[o] = 255; rgba[o + 1] = 0; rgba[o + 2] = 255; // unmasked magenta occluder
        }
    }
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glb);
    const depth = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, poseOf(spec) as any, W, H, { clipNearPlane: true }).depthBuffer;
    return {
        station: { id, name: `plate_${id}` } as any,
        rgba,
        width: W,
        height: H,
        depth: new Float32Array(depth),
        pose: poseOf(spec) as any,
        intrinsics: {} as any
    };
}

const PLATES: PlateSpec[] = [
    { eye: [0, 6, 24], target: [0, 8, 8], gain: 1.0 },
    { eye: [-5, 4, 22], target: [-1, 8, 8], gain: 0.75 },
    { eye: [5, 7, 23], target: [1, 8, 8], gain: 1.3, occluder: { cx: 128, cy: 128, r: 22 } },
    { eye: [22, 8, 2], target: [8, 8, 0], gain: 1.0 }
];

function outputImageForPrimitive(glb: Buffer, primIndex: number): { bytes: Buffer; imageIndex: number; materialIndex: number; material: any; json: any } {
    const { json, bin } = AlgorithmicUvEngine.parseGlb(glb);
    const prims: any[] = [];
    for (const m of json.meshes) for (const p of m.primitives) prims.push(p);
    const materialIndex = prims[primIndex].material;
    const material = json.materials[materialIndex];
    const imageIndex = json.textures[material.pbrMetallicRoughness.baseColorTexture.index].source;
    const bv = json.bufferViews[json.images[imageIndex].bufferView];
    return { bytes: Buffer.from(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)), imageIndex, materialIndex, material, json };
}

function psnr(se: number, n: number): number {
    return n > 0 ? 10 * Math.log10((255 * 255) / Math.max(1e-9, se / n)) : 0;
}

// The synthetic scene's textures are JPEG-encoded with ffmpeg.
describe.skipIf(!ffmpeg.ok)(withReason('StreetViewTextureFusion: Street View detail fused onto scan textures', ffmpeg), () => {
    let scene: SyntheticScene;
    let plates: StationPlate[];
    let result: StreetViewTextureFusionResult;
    let resultNoRobust: StreetViewTextureFusionResult;

    beforeAll(async () => {
        await fs.ensureDir(WORK_DIR);
        await fs.ensureDir(SCREENSHOT_DIR);
        scene = await buildSyntheticScene();
        await fs.writeFile(path.join(WORK_DIR, 'synthetic_building.glb'), scene.glb);
        plates = PLATES.map((p, k) => renderPlate(p, scene.glb, k));
        result = await StreetViewTextureFusion.fuse({
            glbBuffer: scene.glb,
            plates,
            options: {
                outGlbPath: path.join(WORK_DIR, 'synthetic_building_fused.glb'),
                returnConfidenceMaps: true,
                minConfidentSourceTexels: 4,
                unprojectorOverrides: { defaultColor: [255, 0, 255] }
            }
        });
        resultNoRobust = await StreetViewTextureFusion.fuse({
            glbBuffer: scene.glb,
            plates,
            options: { robust: false, returnConfidenceMaps: true, minConfidentSourceTexels: 4, unprojectorOverrides: { defaultColor: [255, 0, 255] } }
        });
    }, 240000);

    it('recovers the painted facade pattern far better than the upsampled tile (PSNR gate)', async () => {
        const front = result.primitives.find(p => p.primitiveIndex === 0)!;
        expect(front.replaced).toBe(true);
        expect(front.scale).toBe(4);
        expect(front.width).toBe(128);
        expect(front.height).toBe(128);

        const out = await decodeImageToRgba(outputImageForPrimitive(result.glbBuffer, 0).bytes);
        expect(out.width).toBe(128);
        const tileLin = new Float32Array(32 * 32 * 3);
        for (let i = 0; i < 32 * 32; i++) for (let ch = 0; ch < 3; ch++) tileLin[i * 3 + ch] = toLin(scene.frontTile[i * 4 + ch]);
        const tileUp = upsampleBicubic3(tileLin, 32, 32, 4);
        const c = front.maps!.confidence;

        let seFused = 0, seTile = 0, n = 0;
        const strip = Buffer.alloc(128 * 4 * 128 * 4);
        for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) {
            const k = j * 128 + i;
            const truth = frontTexelTruth(i, j, 128, 128).map(toSrgb8);
            const fused = [out.rgba[k * 4], out.rgba[k * 4 + 1], out.rgba[k * 4 + 2]];
            const tile = [0, 1, 2].map(ch => toSrgb8(tileUp[k * 3 + ch]));
            const put = (col: number, rgb: number[]) => { const o = (j * 512 + col * 128 + i) * 4; strip[o] = rgb[0]; strip[o + 1] = rgb[1]; strip[o + 2] = rgb[2]; strip[o + 3] = 255; };
            put(0, truth); put(1, tile); put(2, fused); put(3, [Math.round(c[k] * 255), Math.round(c[k] * 255), Math.round(c[k] * 255)]);
            if (c[k] < 0.9) continue;
            for (let ch = 0; ch < 3; ch++) {
                seFused += (fused[ch] - truth[ch]) ** 2;
                seTile += (tile[ch] - truth[ch]) ** 2;
            }
            n += 3;
        }
        await fs.writeFile(path.join(SCREENSHOT_DIR, 'streetview_texture_fusion_synthetic_facade.png'), encodePng(512, 128, strip));
        const psnrFused = psnr(seFused, n), psnrTile = psnr(seTile, n);
        console.log(`[fusion test] confident texels ${n / 3}, PSNR fused ${psnrFused.toFixed(2)} dB vs bicubic tile ${psnrTile.toFixed(2)} dB`);
        expect(n / 3).toBeGreaterThan(128 * 128 * 0.5);
        expect(psnrFused).toBeGreaterThan(30);
        expect(psnrFused - psnrTile).toBeGreaterThan(12);
    });

    it('keeps byte-identical images for unobserved primitives and clones shared materials', () => {
        // Back facade: never observed -> original bytes.
        const back = outputImageForPrimitive(result.glbBuffer, 1);
        expect(Buffer.compare(back.bytes, scene.images[1])).toBe(0);
        const backReport = result.primitives.find(p => p.primitiveIndex === 1)!;
        expect(backReport.replaced).toBe(false);

        // Roof shares material/image with the side facade; it is not observed and keeps the original.
        const roof = outputImageForPrimitive(result.glbBuffer, 3);
        expect(Buffer.compare(roof.bytes, scene.images[2])).toBe(0);
        const roofReport = result.primitives.find(p => p.primitiveIndex === 3)!;
        expect(roofReport.skippedReason).toBe('not observed with a resolution gain'); // uint8 indices decoded

        // Side facade was observed by plate 3 -> cloned material with a new image.
        const side = outputImageForPrimitive(result.glbBuffer, 2);
        expect(result.primitives.find(p => p.primitiveIndex === 2)!.replaced).toBe(true);
        expect(side.materialIndex).not.toBe(roof.materialIndex);
        expect(Buffer.compare(side.bytes, scene.images[2])).not.toBe(0);
        expect(readImageDimensions(side.bytes)!.width).toBeGreaterThan(32);
    });

    it('removes the orphan image, keeps unlit, and never writes metallic materials', () => {
        expect(result.imagesRemoved).toBe(1);
        const { json } = AlgorithmicUvEngine.parseGlb(result.glbBuffer);
        expect(json.images.length).toBe(4); // front (in place), back, shared, side clone
        expect(json.extensionsUsed).toContain('KHR_materials_unlit');
        for (const m of json.materials) {
            expect(m.extensions?.KHR_materials_unlit).toBeDefined();
            expect(m.pbrMetallicRoughness.metallicFactor ?? 1).toBe(0);
        }
        // Every buffer view is referenced and every image decodes.
        const used = new Set<number>();
        for (const a of json.accessors) used.add(a.bufferView);
        for (const im of json.images) used.add(im.bufferView);
        expect(used.size).toBe(json.bufferViews.length);
        const fused = fs.readFileSync(path.join(WORK_DIR, 'synthetic_building_fused.glb'));
        expect(Buffer.compare(fused, result.glbBuffer)).toBe(0);
        expect(fused.readUInt32LE(0)).toBe(0x46546c67);
    });

    it('never leaves default-colour (magenta) texels in fused images', async () => {
        expect(result.totals.defaultColorTexels).toBe(0);
        for (const prim of [0, 2]) {
            const img = await decodeImageToRgba(outputImageForPrimitive(result.glbBuffer, prim).bytes);
            let magenta = 0;
            for (let i = 0; i < img.width * img.height; i++) {
                if (img.rgba[i * 4] > 200 && img.rgba[i * 4 + 1] < 60 && img.rgba[i * 4 + 2] > 200) magenta++;
            }
            expect(magenta).toBe(0);
        }
    });

    it('recovers relative plate exposure gains', () => {
        const g = result.plateExposure.map(e => e.gain[1]);
        // Applied gains invert the synthetic exposures 1.0 / 0.75 / 1.3 (relative to plate 0).
        expect(g[1] / g[0]).toBeGreaterThan((1 / 0.75) * 0.9);
        expect(g[1] / g[0]).toBeLessThan((1 / 0.75) * 1.1);
        expect(g[2] / g[0]).toBeGreaterThan((1 / 1.3) * 0.9);
        expect(g[2] / g[0]).toBeLessThan((1 / 1.3) * 1.1);
        // Gains are normalised to a geometric mean of 1 over plates and channels.
        const logs = result.plateExposure.flatMap(e => e.gain.map(v => Math.log(v)));
        expect(logs.reduce((a, b) => a + b, 0) / logs.length).toBeCloseTo(0, 6);
    });

    it('rejects an unmasked occluder through robust re-weighting', async () => {
        const occ = PLATES[2].occluder!;
        const measure = async (res: StreetViewTextureFusionResult): Promise<{ meanDe: number; n: number }> => {
            const front = res.primitives.find(p => p.primitiveIndex === 0)!;
            const img = await decodeImageToRgba(outputImageForPrimitive(res.glbBuffer, 0).bytes);
            const P = front.maps!.worldPositions;
            let sum = 0, n = 0;
            for (let k = 0; k < img.width * img.height; k++) {
                const pr = projectToPlate(PLATES[2], [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
                if (!pr || Math.hypot(pr[0] - occ.cx, pr[1] - occ.cy) > occ.r - 3) continue;
                const i = k % img.width, j = Math.floor(k / img.width);
                const truth = frontTexelTruth(i, j, img.width, img.height).map(toSrgb8);
                const d = [0, 1, 2].map(ch => img.rgba[k * 4 + ch] - truth[ch]);
                sum += Math.hypot(d[0], d[1], d[2]);
                n++;
            }
            return { meanDe: sum / Math.max(1, n), n };
        };
        const robust = await measure(result);
        const plain = await measure(resultNoRobust);
        console.log(`[fusion test] occluder region: RGB error robust ${robust.meanDe.toFixed(1)} vs plain ${plain.meanDe.toFixed(1)} over ${robust.n} texels`);
        expect(robust.n).toBeGreaterThan(100);
        expect(robust.meanDe).toBeLessThan(plain.meanDe * 0.4);
        expect(robust.meanDe).toBeLessThan(15);
    });

    it('keeps the seam band consistent with the tile low band', () => {
        for (const p of result.primitives.filter(r => r.replaced)) {
            expect(p.seamDeltaE00Mean).toBeLessThan(3);
        }
    });

    it('enforces the output size budget by downscaling fused images', async () => {
        const budgetBytes = result.bytes - 4000;
        const small = await StreetViewTextureFusion.fuse({ glbBuffer: scene.glb, plates, options: { maxOutputBytes: budgetBytes, minConfidentSourceTexels: 4 } });
        expect(small.budgetDownscales).toBeGreaterThan(0);
        expect(small.bytes).toBeLessThanOrEqual(budgetBytes);
    }, 120000);

    it('never softens the tile: blurry photos leave the tile image untouched (detail mode fine + sharpness rule)', async () => {
        // Photos blurred far below the tile's resolution carry no detail the tile lacks
        const blurBox = (pl: StationPlate, r: number): StationPlate => {
            const W = pl.width, H = pl.height, src = Buffer.from(pl.rgba), out = Buffer.alloc(src.length);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const acc = [0, 0, 0]; let n = 0;
                for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)), k = (yy * W + xx) * 4;
                    acc[0] += src[k]; acc[1] += src[k + 1]; acc[2] += src[k + 2]; n++;
                }
                const o = (y * W + x) * 4;
                out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = 255;
            }
            return { ...pl, rgba: out };
        };
        const blurry = await StreetViewTextureFusion.fuse({ glbBuffer: scene.glb, plates: plates.map(p => blurBox(p, 8)), options: { minConfidentSourceTexels: 4 } });
        for (const r of blurry.primitives.filter(p => p.observedTexels > 0)) {
            if (r.replaced) expect(r.textureSharpnessGain).toBeGreaterThanOrEqual(1.1);
            else expect(r.skippedReason ?? '').toMatch(/sharpness|confidence|source texels|resolution/);
        }
        // and the sharp photos do get through, on the same primitives
        expect(result.primitives.find(p => p.primitiveIndex === 0)!.tileBlurSigmaTexels).toBeGreaterThan(0);
    }, 120000);

    it('accepts any GLB path and reports nothing to do without plates', async () => {
        const res = await StreetViewTextureFusion.fuse({ glbPath: path.join(WORK_DIR, 'synthetic_building.glb'), plates: [] });
        expect(res.imagesReplaced).toBe(0);
        // Only the orphan image is dropped; every referenced image keeps its bytes.
        expect(res.imagesRemoved).toBe(1);
        for (const prim of [0, 1, 2, 3]) {
            const img = outputImageForPrimitive(res.glbBuffer, prim);
            const original = prim === 0 ? scene.images[0] : prim === 1 ? scene.images[1] : scene.images[2];
            expect(Buffer.compare(img.bytes, original)).toBe(0);
        }
    });
});

describe('StreetViewTextureFusion helpers and SurveyTextureUnprojector opt-in modes', () => {
    it('CIEDE2000 matches the Sharma et al. reference pair', () => {
        expect(deltaE2000(50, 2.6772, -79.7751, 50, 0, -82.7485)).toBeCloseTo(2.0425, 3);
        expect(deltaE2000(50, 0, 0, 50, -1, 2)).toBeCloseTo(2.3669, 3);
    });

    it('bicubic upsampling preserves constants and is centre-aligned', () => {
        const src = new Float32Array(4 * 4 * 3).fill(0.4);
        const up = upsampleBicubic3(src, 4, 4, 4);
        expect(up.length).toBe(16 * 16 * 3);
        for (const v of up) expect(v).toBeCloseTo(0.4, 6);
        // A horizontal ramp stays a symmetric ramp (centre alignment).
        const ramp = new Float32Array(4 * 1 * 3);
        for (let x = 0; x < 4; x++) ramp.fill(x, x * 3, x * 3 + 3);
        const r = upsampleBicubic3(ramp, 4, 1, 2);
        expect(r[3 * 3] + r[4 * 3]).toBeCloseTo(3, 5);
    });

    it('masked chamfer distance never crosses gaps between charts', () => {
        const w = 10, h = 1;
        const domain = Uint8Array.from([1, 1, 1, 0, 0, 1, 1, 1, 1, 1]);
        const source = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const d = maskedChamferDistance(source, domain, w, h);
        expect(d[2]).toBe(2);
        expect(d[5]).toBe(Infinity); // separate chart: no feather leak across the gutter
    });

    it.skipIf(!ffmpeg.ok)(withReason('compactGlb drops orphan images and keeps referenced bytes verbatim', ffmpeg), async () => {
        const scene = await buildSyntheticScene();
        const { json, bin } = AlgorithmicUvEngine.parseGlb(scene.glb);
        const compact = compactGlb(json, bin);
        expect(compact.imagesRemoved).toBe(1);
        expect(compact.bufferViewsRemoved).toBe(1);
        const out = AlgorithmicUvEngine.serializeGlb(compact.json, compact.bin);
        for (let p = 0; p < 4; p++) {
            const expected = p === 0 ? scene.images[0] : p === 1 ? scene.images[1] : scene.images[2];
            expect(Buffer.compare(outputImageForPrimitive(out, p).bytes, expected)).toBe(0);
        }
    });

    it.skipIf(!ffmpeg.ok)(withReason('returns accumulators with GL texel centres and face incidence without encoding textures', ffmpeg), async () => {
        const scene = await buildSyntheticScene();
        const plate = renderPlate(PLATES[0], scene.glb, 0);
        const { primitives } = SurveyTextureUnprojector.loadMeshPrimitives(scene.glb, 512, { decodeAllIndexTypes: true });
        expect(Math.max(...primitives[3].indices)).toBe(3); // uint8 indices decoded when opted in
        const cams = SurveyTextureUnprojector.prepareCameras([plate]);
        const sub = await SurveyTextureUnprojector.unprojectPrimitiveToAtlas(primitives[0], 0, cams, {
            returnAccumulators: true, encodeTextures: false, skipPbrDecomposition: true,
            texelCenter: 'gl', incidenceNormal: 'face', perTriangleCameraCulling: true, minCosIncidence: 0.3
        }, 64, 32);
        expect(sub.width).toBe(64);
        expect(sub.height).toBe(32);
        expect(sub.albedoPng.length).toBe(0);
        const acc = sub.accumulators!;
        let covered = 0, observed = 0;
        for (let i = 0; i < 64 * 32; i++) {
            covered += acc.coverage[i];
            if (acc.weightSum[i] > 0) {
                observed++;
                expect(acc.worldNormals[i * 3 + 2]).toBeCloseTo(1, 6); // face normal of the z = +8 facade
                expect(Number.isFinite(acc.minFootprintMeters[i])).toBe(true);
                expect(acc.maxCosIncidence[i]).toBeGreaterThanOrEqual(0.3);
            }
        }
        expect(covered).toBe(64 * 32); // full quad, GL centres stay inside the chart
        expect(observed).toBeGreaterThan(64 * 32 * 0.5);
        // Texel edge on the surface: 16 m / 64 texels horizontally, 16 m / 32 vertically -> sqrt(0.25 * 0.5)
        expect(acc.texelSizeMeters[100]).toBeCloseTo(Math.sqrt(0.25 * 0.5), 4);
    }, 60000);
});
