/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Metal path tracer against the CPU reference. Both backends of scripts/sbvg_pathtracer.mm trace
 * the same LOD cut of the same .sbvg with the same per-pixel PCG32 sample stream, so their images
 * agree to sampling noise: block averages (8x8 pixels of 64 samples) expose any wrong term while
 * single pixels only show noise. Runs on macOS with a ray tracing Metal device; skips elsewhere.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deflateSync } from 'zlib';
import { MetalPathTracerService, MetalPathTracerError, readLinearColor, type MetalDeviceInfo, type MetalPathTraceResult } from '../src/node/3d-engine/metal-path-tracer-service';
import { VirtualGeometryBuildService } from '../src/node/3d-engine/virtual-geometry-service';
import { requireAsset, withReason } from './helpers/requirements';

const FLATIRON_GLB = 'desktop-app/public/models/flatiron_building_40.7411_-73.9897_full_texture.glb';
const flatironGlb = requireAsset(FLATIRON_GLB, 'a Google Photorealistic 3D Tiles capture of the Flatiron district (needs Google Map Tiles API access)');

/** An 8-bit RGB PNG (one IDAT, filter 0 on every row). */
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const crc = (buf: Buffer) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body), 0);
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * A UV sphere as a GLB: positions, indices, a lat-long TEXCOORD_0 and, with `textured`, a
 * metallic-roughness material whose base colour is a checkerboard PNG. The always-available fixture.
 */
function writeSphereGlb(file: string, textured = false, radius = 1, rings = 48, segments = 96): void {
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    for (let r = 0; r <= rings; r++) {
        const phi = Math.PI * r / rings;
        for (let s = 0; s <= segments; s++) {
            const th = 2 * Math.PI * s / segments;
            pos.push(radius * Math.sin(phi) * Math.cos(th), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(th));
            uvs.push(s / segments, r / rings);
        }
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
        const a = r * (segments + 1) + s, b = a + segments + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const p = new Float32Array(pos), t = new Float32Array(uvs), i = new Uint32Array(idx);
    const pb = Buffer.from(p.buffer), tb = Buffer.from(t.buffer), ib = Buffer.from(i.buffer);
    const chunks = [pb, tb, ib];
    const bufferViews: any[] = [];
    let offset = 0;
    for (const c of chunks) { bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: c.length }); offset += c.length; }
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, ...(textured ? { material: 0 } : {}) }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: p.length / 3, type: 'VEC3', min: [-radius, -radius, -radius], max: [radius, radius, radius] },
            { bufferView: 1, componentType: 5126, count: t.length / 2, type: 'VEC2' },
            { bufferView: 2, componentType: 5125, count: i.length, type: 'SCALAR' }],
        bufferViews,
        buffers: [{ byteLength: 0 }]
    };
    if (textured) {
        const size = 64;
        const rgb = new Uint8Array(size * size * 3);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const light = ((x >> 3) + (y >> 3)) % 2 === 0;
            rgb.set(light ? [230, 200, 120] : [40, 60, 160], (y * size + x) * 3);
        }
        const png = encodePng(size, size, rgb);
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
        chunks.push(png);
        offset += png.length;
        json.images = [{ bufferView: bufferViews.length - 1, mimeType: 'image/png' }];
        json.samplers = [{ wrapS: 10497, wrapT: 33071 }];
        json.textures = [{ source: 0, sampler: 0 }];
        json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.1, roughnessFactor: 0.6 } }];
    }
    const bin = Buffer.concat(chunks.map(c => Buffer.concat([c, Buffer.alloc((4 - c.length % 4) % 4)])));
    // Pad each view's offset the same way the chunks were padded.
    let padded = 0;
    for (let k = 0; k < bufferViews.length; k++) {
        bufferViews[k].byteOffset = padded;
        padded += bufferViews[k].byteLength + (4 - bufferViews[k].byteLength % 4) % 4;
    }
    json.buffers[0].byteLength = bin.length;
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(file, Buffer.concat([header, jh, js, bh, bin]));
}

const luminance = (c: Float32Array, i: number) => 0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2];

interface ImageAgreement {
    meanRatio: number;
    /** Mean over 8x8 blocks of |meanA - meanB| / meanB. */
    blockMeanRelDiff: number;
    /** Share of 8x8 blocks whose means differ by more than 2%. */
    blocksOver2pct: number;
    pixelRmsRelToMean: number;
}

function compareLinear(a: MetalPathTraceResult, b: MetalPathTraceResult): ImageAgreement {
    const A = readLinearColor(a), B = readLinearColor(b);
    const w = a.stats.width, h = a.stats.height;
    expect(b.stats.width).toBe(w);
    expect(b.stats.height).toBe(h);
    const n = w * h;
    const la = new Float64Array(n), lb = new Float64Array(n);
    let sumA = 0, sumB = 0, sumSq = 0;
    for (let p = 0; p < n; p++) {
        la[p] = luminance(A, p * 3);
        lb[p] = luminance(B, p * 3);
        expect(Number.isFinite(la[p]) && Number.isFinite(lb[p])).toBe(true);
        sumA += la[p];
        sumB += lb[p];
        sumSq += (la[p] - lb[p]) ** 2;
    }
    const meanB = sumB / n;
    const bs = 8, bw = Math.floor(w / bs), bh = Math.floor(h / bs);
    let blockAbs = 0, over = 0, blocks = 0;
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let sa = 0, sb = 0;
        for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) {
            const p = (by * bs + y) * w + bx * bs + x;
            sa += la[p];
            sb += lb[p];
        }
        const rel = Math.abs(sa - sb) / Math.max(sb, 0.02 * meanB * bs * bs);
        blockAbs += rel;
        if (rel > 0.02) over++;
        blocks++;
    }
    return { meanRatio: sumA / sumB, blockMeanRelDiff: blockAbs / blocks, blocksOver2pct: over / blocks, pixelRmsRelToMean: Math.sqrt(sumSq / n) / meanB };
}

function pngSize(file: string): { width: number; height: number } {
    const buf = fs.readFileSync(file);
    expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe.skipIf(process.platform !== 'darwin')('Metal path tracer (hardware ray tracing against the CPU reference)', () => {
    const service = new MetalPathTracerService();
    const builder = new VirtualGeometryBuildService();
    let tmp = '';
    let device: MetalDeviceInfo;
    let sphereSbvg = '';
    let texturedGlb = '';
    let texturedSbvg = '';
    const sunLighting = { sun: { elevationDeg: 42, azimuthDeg: 150 } } as const;
    const sphereCamera = { position: [0, 0.5, 4] as [number, number, number], target: [0, 0, 0] as [number, number, number], verticalFovDeg: 35 };

    beforeAll(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-metal-pt-'));
        device = await service.probe();
        if (!device.raytracing) return;
        const glb = path.join(tmp, 'sphere.glb');
        writeSphereGlb(glb);
        sphereSbvg = path.join(tmp, 'sphere.sbvg');
        const built = await builder.build(glb, sphereSbvg);
        expect(built.stats.leafTriangleCount).toBeGreaterThan(8000);
        texturedGlb = path.join(tmp, 'checker.glb');
        writeSphereGlb(texturedGlb, true);
        texturedSbvg = path.join(tmp, 'checker.sbvg');
        const textured = await builder.build(texturedGlb, texturedSbvg);
        // Re-textured coarse levels: most triangles share their atlas cell with an edge neighbour, and each level
        // has a normal atlas beside its colour atlas.
        expect(textured.stats.atlases.length).toBeGreaterThanOrEqual(5);
        for (const atlas of textured.stats.atlases) {
            expect(atlas.pairedCells).toBeGreaterThan(0.7 * atlas.cells);
            expect(fs.existsSync(path.join(tmp, `checker.atlas${atlas.level}.png`))).toBe(true);
            expect(fs.existsSync(path.join(tmp, `checker.normal${atlas.level}.png`))).toBe(true);
        }
    });

    it('probe names the device and says whether it ray traces', async () => {
        expect(typeof device.raytracing).toBe('boolean');
        if (device.raytracing) {
            expect(device.device).toBeTruthy();
            expect(device.appleFamily).toBeGreaterThanOrEqual(7);
        } else {
            expect(device.error || device.device).toBeTruthy();
        }
    });

    it('renders the sphere under the studio dome with no energy gain, counting its rays', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const res = await service.render({
            sbvgPath: sphereSbvg, outputDir: path.join(tmp, 'furnace'),
            width: 160, height: 160, samplesPerPixel: 64, maxBounces: 8, clampIndirect: 0, seed: 7,
            lighting: { studio: { radiance: [1, 1, 1] } },
            material: { albedo: [1, 1, 1], roughness: 1, metallic: 0 },
            camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDeg: 35 }
        });
        expect(res.stats.backend).toBe('metal');
        expect(res.stats.device).toBe(device.device);
        expect(res.stats.lighting).toBe('studio');
        expect(res.stats.nanSamples).toBe(0);
        expect(res.stats.cut.triangles).toBeGreaterThan(1000);
        expect(res.stats.cut.clusters).toBeLessThan(res.stats.file.clusters);
        expect(res.stats.geometryCoverage).toBeGreaterThan(0.4);
        expect(res.stats.geometryCoverage).toBeLessThan(0.6);
        // Every pixel traces at least 64 camera rays; hits add bounce rays.
        expect(res.stats.rays).toBeGreaterThan(160 * 160 * 64);
        expect(res.stats.renderMs).toBeGreaterThan(0);
        expect(pngSize(res.beautyPngPath)).toEqual({ width: 160, height: 160 });

        const color = readLinearColor(res);
        let sum = 0, count = 0;
        for (let i = 0; i < color.length; i += 3) {
            const l = luminance(color, i);
            if (Math.abs(l - 1) < 1e-6) continue; // dome pixels return the dome exactly
            sum += l;
            count++;
        }
        const mean = sum / count;
        // A convex white body under a unit dome: Lambert returns 1; single-scatter GGX at roughness 1
        // loses some energy (no multiple-scattering term), never gains any.
        expect(count).toBeGreaterThan(0.4 * 160 * 160);
        expect(mean).toBeGreaterThan(0.85);
        expect(mean).toBeLessThan(1.02);
    });

    it('agrees with the CPU reference on the sphere under the sun', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const common = { sbvgPath: sphereSbvg, width: 320, height: 240, samplesPerPixel: 64, maxBounces: 4, seed: 3, lighting: sunLighting, camera: sphereCamera };
        const gpu = await service.render({ ...common, outputDir: path.join(tmp, 'sphere_gpu'), backend: 'metal' });
        const cpu = await service.render({ ...common, outputDir: path.join(tmp, 'sphere_cpu'), backend: 'cpu' });
        expect(gpu.stats.cut).toEqual(cpu.stats.cut);
        expect(gpu.stats.lighting).toBe('sky');
        expect(cpu.stats.backend).toBe('cpu');
        // Same sample stream, so the same paths up to intersection tie-breaks.
        expect(Math.abs(gpu.stats.rays - cpu.stats.rays) / cpu.stats.rays).toBeLessThan(0.005);
        expect(Math.abs(gpu.stats.geometryCoverage - cpu.stats.geometryCoverage)).toBeLessThan(0.002);
        const agreement = compareLinear(gpu, cpu);
        expect(Math.abs(agreement.meanRatio - 1)).toBeLessThan(0.01);
        expect(agreement.blockMeanRelDiff).toBeLessThan(0.01);
        expect(agreement.blocksOver2pct).toBeLessThan(0.03);
    });

    it('shades the GLB materials: a checkerboard texture agrees between GPU and CPU and differs from clay', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const common = {
            sbvgPath: texturedSbvg, width: 320, height: 240, samplesPerPixel: 64, maxBounces: 4, seed: 5, lighting: sunLighting, camera: sphereCamera,
            materials: { glbPath: texturedGlb }
        };
        const gpu = await service.render({ ...common, outputDir: path.join(tmp, 'checker_gpu'), backend: 'metal' });
        const cpu = await service.render({ ...common, outputDir: path.join(tmp, 'checker_cpu'), backend: 'cpu' });
        // One glTF material and texture, plus a colour and a normal atlas per re-textured level; the cpu backend uploads nothing.
        const atlasImages = 2 * gpu.stats.file.atlases;
        expect(gpu.stats.materials).toMatchObject({ source: 'glb', count: 1, images: 1 + atlasImages, imagesDecoded: 1 + atlasImages, texturesUploaded: 1 + atlasImages });
        expect(gpu.stats.materials.atlasMaterials).toBe(gpu.stats.file.atlases);
        expect(cpu.stats.materials).toMatchObject({ source: 'glb', count: 1, texturesUploaded: 0 });
        expect(gpu.stats.file.leafTriangles).toBeGreaterThan(8000);
        expect(Math.abs(gpu.stats.rays - cpu.stats.rays) / cpu.stats.rays).toBeLessThan(0.005);
        const agreement = compareLinear(gpu, cpu);
        expect(Math.abs(agreement.meanRatio - 1)).toBeLessThan(0.01);
        expect(agreement.blockMeanRelDiff).toBeLessThan(0.01);
        expect(agreement.blocksOver2pct).toBeLessThan(0.03);

        // The texture shows: the sphere's first-hit albedo takes two colours, not the one clay albedo.
        const clay = await service.render({ ...common, materials: undefined, outputDir: path.join(tmp, 'checker_clay'), backend: 'metal' });
        const texturedColor = readLinearColor(gpu), clayColor = readLinearColor(clay);
        let differing = 0, geometry = 0;
        for (let i = 0; i < texturedColor.length; i += 3) {
            if (clayColor[i] === texturedColor[i] && clayColor[i + 1] === texturedColor[i + 1]) continue; // sky pixels agree exactly
            geometry++;
            const hueA = texturedColor[i] / Math.max(texturedColor[i + 2], 1e-6), hueB = clayColor[i] / Math.max(clayColor[i + 2], 1e-6);
            if (Math.abs(hueA - hueB) > 0.2) differing++;
        }
        expect(geometry).toBeGreaterThan(0.3 * 320 * 240);
        expect(differing / geometry).toBeGreaterThan(0.5);
    });

    it.skipIf(!flatironGlb.ok)(withReason('agrees with the CPU reference on a real textured tile and traces it faster', flatironGlb), async ctx => {
        if (!device.raytracing) return ctx.skip();
        const sbvg = path.join(tmp, 'flatiron.sbvg');
        const built = await builder.build(path.resolve(FLATIRON_GLB), sbvg);
        expect(built.stats.levelCount).toBeGreaterThanOrEqual(3);
        const common = {
            sbvgPath: sbvg, width: 640, height: 360, samplesPerPixel: 32, maxBounces: 4, seed: 1, lighting: sunLighting,
            materials: { glbPath: path.resolve(FLATIRON_GLB) },
            camera: { auto: { verticalFovDeg: 40, pitchDeg: 12, headingDeg: 30, distanceScale: 0.45 } }
        };
        const gpu = await service.render({ ...common, outputDir: path.join(tmp, 'flatiron_gpu'), backend: 'metal' });
        const cpu = await service.render({ ...common, outputDir: path.join(tmp, 'flatiron_cpu'), backend: 'cpu' });
        expect(gpu.stats.cut).toEqual(cpu.stats.cut);
        expect(gpu.stats.cut.triangles).toBeGreaterThan(100_000);
        expect(gpu.stats.cut.triangles).toBeLessThan(gpu.stats.file.leafTriangles);
        expect(gpu.stats.materials.count).toBeGreaterThan(100);
        expect(gpu.stats.materials.texturesUploaded).toBe(gpu.stats.materials.imagesDecoded);
        expect(gpu.stats.geometryCoverage).toBeGreaterThan(0.4);
        expect(Math.abs(gpu.stats.rays - cpu.stats.rays) / cpu.stats.rays).toBeLessThan(0.002);
        const agreement = compareLinear(gpu, cpu);
        expect(Math.abs(agreement.meanRatio - 1)).toBeLessThan(0.005);
        expect(agreement.blockMeanRelDiff).toBeLessThan(0.003);
        expect(agreement.blocksOver2pct).toBeLessThan(0.005);
        // eslint-disable-next-line no-console
        console.log(`[metal-path-tracer] ${device.device}: ${(gpu.stats.raysPerSecond / 1e6).toFixed(1)} M rays/s GPU vs ${(cpu.stats.raysPerSecond / 1e6).toFixed(1)} M rays/s CPU; block diff ${(agreement.blockMeanRelDiff * 100).toFixed(3)}%`);
        expect(gpu.stats.raysPerSecond).toBeGreaterThan(cpu.stats.raysPerSecond);
    });

    it('denoises on the GPU exactly as the CPU a-trous filter does', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const res = await service.render({
            sbvgPath: texturedSbvg, outputDir: path.join(tmp, 'denoise'), width: 320, height: 240, samplesPerPixel: 8, maxBounces: 4, seed: 9,
            lighting: sunLighting, camera: sphereCamera, materials: { glbPath: texturedGlb }, denoise: true, denoiseCheck: true
        });
        expect(res.stats.denoised).toBe(true);
        expect(res.stats.denoiseBackend).toBe('metal');
        expect(res.stats.denoiseMs).toBeGreaterThan(0);
        const gpu = readLinearColor(res, 'denoised'), cpu = readLinearColor(res, 'denoisedCpu'), raw = readLinearColor(res, 'color');
        let maxRel = 0, sumRel = 0, changed = 0;
        for (let i = 0; i < gpu.length; i++) {
            expect(Number.isFinite(gpu[i])).toBe(true);
            const rel = Math.abs(gpu[i] - cpu[i]) / Math.max(Math.abs(cpu[i]), 1e-3);
            maxRel = Math.max(maxRel, rel);
            sumRel += rel;
            if (Math.abs(gpu[i] - raw[i]) > 1e-6) changed++;
        }
        // Same algorithm on the same raw frame: differences are float rounding (measured 1.8e-5 max).
        expect(maxRel).toBeLessThan(1e-3);
        expect(sumRel / gpu.length).toBeLessThan(1e-5);
        // And it did filter: most geometry samples moved.
        expect(changed).toBeGreaterThan(0.2 * gpu.length);
    });

    it('the scrambled Halton sampler converges to the PCG image with lower error per sample', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const common = { sbvgPath: texturedSbvg, width: 160, height: 120, maxBounces: 4, seed: 11, lighting: sunLighting, camera: sphereCamera, materials: { glbPath: texturedGlb } };
        const reference = await service.render({ ...common, outputDir: path.join(tmp, 'ref512'), samplesPerPixel: 512 });
        const err = (r: MetalPathTraceResult) => {
            const a = readLinearColor(r), b = readLinearColor(reference);
            let sq = 0;
            for (let i = 0; i < a.length; i++) sq += (a[i] - b[i]) ** 2;
            return Math.sqrt(sq / a.length);
        };
        const pcg8 = await service.render({ ...common, outputDir: path.join(tmp, 'pcg8'), samplesPerPixel: 8 });
        const sobol8 = await service.render({ ...common, outputDir: path.join(tmp, 'sobol8'), samplesPerPixel: 8, optimizations: { sampler: 'sobol' } });
        const sobol64 = await service.render({ ...common, outputDir: path.join(tmp, 'sobol64'), samplesPerPixel: 64, optimizations: { sampler: 'sobol' } });
        expect(sobol8.stats.optimizations.sampler).toBe('sobol');
        expect(err(sobol8)).toBeLessThan(err(pcg8));
        // Unbiased: more samples bring it to the reference, not to a different image.
        expect(err(sobol64)).toBeLessThan(0.5 * err(sobol8));
        expect(Math.abs(sobol64.stats.meanLinearLuminance / reference.stats.meanLinearLuminance - 1)).toBeLessThan(0.01);
    });

    it('coarse levels carry their own baked atlases and render the checkerboard without the fine geometry', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const common = {
            sbvgPath: texturedSbvg, width: 320, height: 240, samplesPerPixel: 32, maxBounces: 4, seed: 5, lighting: sunLighting, camera: sphereCamera,
            materials: { glbPath: texturedGlb }
        };
        const fine = await service.render({ ...common, outputDir: path.join(tmp, 'atlas_fine'), lod: { thresholdPx: 1, finestLevel: 0 } });
        const coarse = await service.render({ ...common, outputDir: path.join(tmp, 'atlas_coarse'), lod: { thresholdPx: 1, finestLevel: 3 } });
        // The re-textured file: one glTF material, one atlas material per coarse level with a colour and a normal PNG, all uploaded.
        expect(fine.stats.file.atlases).toBeGreaterThanOrEqual(5);
        expect(fine.stats.materials.count).toBe(1);
        expect(fine.stats.materials.imagesDecoded).toBe(1 + 2 * fine.stats.file.atlases);
        expect(fine.stats.materials.texturesUploaded).toBe(1 + 2 * fine.stats.file.atlases);
        expect(coarse.stats.cut.triangles).toBeLessThan(0.5 * fine.stats.cut.triangles);
        // Level 3 of the sphere is a few thousand triangles with a 3 cm error: the baked checkerboard agrees with
        // the full-detail render to a few percent in block means (silhouettes move, the texture does not).
        const agreement = compareLinear(coarse, fine);
        expect(Math.abs(agreement.meanRatio - 1)).toBeLessThan(0.02);
        expect(agreement.blockMeanRelDiff).toBeLessThan(0.08);
        // And it is the checkerboard, not clay: hue varies across the sphere as in the fine render.
        const c = readLinearColor(coarse), f = readLinearColor(fine);
        let coarseDiffers = 0, fineDiffers = 0, n = 0;
        for (let i = 0; i < c.length; i += 3) {
            if (c[i] === 1 && c[i + 1] === 1) continue;
            n++;
            if (Math.abs(c[i] / Math.max(c[i + 2], 1e-6) - 1) > 0.5) coarseDiffers++;
            if (Math.abs(f[i] / Math.max(f[i + 2], 1e-6) - 1) > 0.5) fineDiffers++;
        }
        expect(coarseDiffers / n).toBeGreaterThan(0.5 * (fineDiffers / n));
    });

    it('runs a resident session: frames accumulate for a view, a new view restarts them, close ends the process', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const session = await service.openSession({ sbvgPath: texturedSbvg, glbPath: texturedGlb, lighting: sunLighting }, { dir: path.join(tmp, 'session') });
        try {
            expect(session.alive).toBe(true);
            expect(session.opened).toMatchObject({ device: device.device, materials: { source: 'glb', count: 1 } });
            // The glTF texture plus a colour and a normal atlas per re-textured level.
            expect(session.opened!.materials.texturesUploaded).toBe(1 + 2 * session.opened!.file.atlases);
            expect(session.opened!.file.atlases).toBeGreaterThanOrEqual(5);
            expect(session.opened!.file.leafTriangles).toBeGreaterThan(8000);
            expect(session.latestFrame()).toBeNull();

            const view = { width: 160, height: 120, camera: sphereCamera, targetSpp: 12 };
            const started = await session.setView(view);
            expect(started).toMatchObject({ seq: 1, width: 160, height: 120, renderWidth: 160, renderHeight: 120, renderScale: 1, sampler: 'sobol', lighting: 'sky', targetSpp: 12 });
            expect(started.cut.rebuilt).toBe(true);
            expect(started.cut.triangles).toBeGreaterThan(1000);

            const frames: number[] = [];
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`no finished frame; got spp ${frames.join(',')}`)), 20_000);
                session.on('frame', f => {
                    frames.push(f.spp);
                    if (f.done) { clearTimeout(timer); resolve(); }
                });
            });
            expect(frames[frames.length - 1]).toBe(12);
            for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeGreaterThan(frames[i - 1]);
            const read = session.readFrame();
            expect(read).not.toBeNull();
            expect(read!.rgba.length).toBe(160 * 120 * 4);
            expect(read!.meta).toMatchObject({ seq: 1, spp: 12, done: true, denoised: true, historyPixels: 0 });
            expect(read!.meta.denoiseMs).toBeGreaterThan(0);
            // Display-ready pixels: opaque, and the lit sphere is not all one value.
            let alphaOk = true, distinct = new Set<number>();
            for (let i = 0; i < read!.rgba.length; i += 4) {
                if (read!.rgba[i + 3] !== 255) alphaOk = false;
                distinct.add(read!.rgba[i]);
            }
            expect(alphaOk).toBe(true);
            expect(distinct.size).toBeGreaterThan(32);

            // A small camera move keeps the cut (it is within a tenth of the scene radius), restarts the samples.
            const moved = await session.setView({ ...view, camera: { ...sphereCamera, position: [0.02, 0.5, 4] } });
            expect(moved.seq).toBe(2);
            expect(moved.cut.rebuilt).toBe(false);
            expect(session.latestFrame()).toBeNull();
            const first = await new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no frame after the camera move')), 20_000);
                session.on('frame', f => { if (f.seq === 2) { clearTimeout(timer); resolve(f); } });
            });
            expect(session.latestFrame()!.seq).toBe(2);
            // Temporal reuse: after a tiny move most of the sphere's pixels take the previous view's illumination.
            const geometryPixels = Math.round(0.52 * 160 * 120);
            expect(first.historyPixels).toBeGreaterThan(0.6 * geometryPixels);
            expect(first.historyPixels).toBeLessThanOrEqual(160 * 120);
            // Without temporal reuse nothing is taken over.
            const plain = await session.setView({ ...view, camera: { ...sphereCamera, position: [0.04, 0.5, 4] }, temporal: false });
            const plainFrame = await new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no frame without temporal reuse')), 20_000);
                session.on('frame', f => { if (f.seq === plain.seq) { clearTimeout(timer); resolve(f); } });
            });
            expect(plainFrame.historyPixels).toBe(0);
            // Half-size tracing with a MetalFX upscale still delivers the view-sized frame.
            const scaled = await session.setView({ ...view, renderScale: 0.5, sampler: 'pcg' });
            expect(scaled).toMatchObject({ renderWidth: 80, renderHeight: 60, renderScale: 0.5, sampler: 'pcg', width: 160, height: 120 });
            const scaledFrame = await new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no upscaled frame')), 20_000);
                session.on('frame', f => { if (f.seq === scaled.seq && f.done) { clearTimeout(timer); resolve(f); } });
            });
            expect(scaledFrame).toMatchObject({ renderWidth: 80, renderHeight: 60, width: 160, height: 120 });
            expect(scaledFrame.upscaleMs).toBeGreaterThan(0);
            expect(session.readFrame()!.rgba.length).toBe(160 * 120 * 4);
            // A view with a bad size is refused without killing the session.
            await expect(session.setView({ ...view, width: 2 })).rejects.toThrow(/between 8 and 8192/);
            expect(session.alive).toBe(true);
        } finally {
            session.close();
        }
        await new Promise<void>(resolve => { if (!session.alive) resolve(); else session.on('exit', () => resolve()); });
        expect(session.alive).toBe(false);
    });

    it('refuses GLB materials for a .sbvg without material ids and a GLB with fewer materials than the file', async ctx => {
        if (!device.raytracing) return ctx.skip();
        // The plain sphere GLB has no materials, the checker .sbvg was built with one.
        await expect(service.render({ sbvgPath: texturedSbvg, outputDir: path.join(tmp, 'mismatch'), width: 16, height: 16, samplesPerPixel: 1, camera: sphereCamera, materials: { glbPath: path.join(tmp, 'sphere.glb') } }))
            .rejects.toThrow(/built from a GLB with 1 materials/);
    });

    it('fails plainly on a file that is not .sbvg and on a CPU reference without a sun', async ctx => {
        if (!device.raytracing) return ctx.skip();
        const bad = path.join(tmp, 'bad.sbvg');
        fs.writeFileSync(bad, Buffer.alloc(256, 7));
        await expect(service.render({ sbvgPath: bad, outputDir: path.join(tmp, 'bad'), width: 16, height: 16, samplesPerPixel: 1, camera: sphereCamera }))
            .rejects.toThrow(/not an \.sbvg file/);
        await expect(service.render({ sbvgPath: sphereSbvg, outputDir: path.join(tmp, 'cpu_studio'), backend: 'cpu', width: 16, height: 16, samplesPerPixel: 1, camera: sphereCamera }))
            .rejects.toThrow(/needs config\.lighting\.sun/);
        await expect(service.render({ sbvgPath: path.join(tmp, 'missing.sbvg'), outputDir: path.join(tmp, 'missing') })).rejects.toBeInstanceOf(MetalPathTracerError);
    });
});
