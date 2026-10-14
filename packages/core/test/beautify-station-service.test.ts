/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import * as BeautifyModule from '../src/node/spatial/BeautifyStationService';
import { BeautifyStationService, createDefaultStationImageGenerator, createGoogleStationImageGenerator, ensureStationPng, warpStationImage, type StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { encode as encodeJpeg } from 'jpeg-js';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

const ANCHOR: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };
// Self-contained fixture: this suite used to load build/test_survey_render/box_ground.glb written by
// survey-station-render.test.ts, which made it order-dependent (and racy: that suite empties the
// directory in its beforeAll). Generate the same box + ground mesh into a private temp dir instead.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-beautify-station-'));
const GLB = path.join(WORK_DIR, 'box_ground.glb');
const SHOTS = path.join(WORK_DIR, 'screenshots'); // proof images; kept out of docs/
const OPTICS = { focalLengthMm: 28, sensorWidthMm: 36 };

/** Minimal GLB writer: axis-aligned box [min,max] plus a ground quad, indexed triangles, no node transform. */
function writeBoxGroundGlb(file: string, boxMin: number[], boxMax: number[], groundHalf: number): void {
    const V: number[] = [], I: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        const base = V.length / 3;
        V.push(...a, ...b, ...c, ...d);
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const [x0, y0, z0] = boxMin, [x1, y1, z1] = boxMax;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -Z
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +X
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -X
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +Y top
    // Ground as a 20x20 grid: the software rasterizer has no near-plane clipping, so large
    // triangles straddling the camera plane would be dropped (real tile meshes are finely tessellated)
    const g = groundHalf, N = 20, cell = (2 * g) / N;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const xa = -g + i * cell, xb = xa + cell, za = -g + j * cell, zb = za + cell;
        quad([xa, 0, zb], [xb, 0, zb], [xb, 0, za], [xa, 0, za]);
    }
    const pos = new Float32Array(V), idx = new Uint32Array(I);
    const posBytes = Buffer.from(pos.buffer), idxBytes = Buffer.from(idx.buffer);
    const bin = Buffer.concat([posBytes, idxBytes]);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], V[i + k]); max[k] = Math.max(max[k], V[i + k]); }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: V.length / 3, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5125, count: I.length, type: 'SCALAR' }
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.length }, { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length }],
        buffers: [{ byteLength: bin.length }]
    };
    let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
    let bb = bin; while (bb.length % 4) bb = Buffer.concat([bb, Buffer.alloc(1)]);
    const total = 12 + 8 + js.length + 8 + bb.length;
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(total, 8);
    const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
    const bc = Buffer.alloc(8); bc.writeUInt32LE(bb.length, 0); bc.writeUInt32LE(0x004e4942, 4);
    fs.outputFileSync(file, Buffer.concat([h, jc, js, bc, bb]));
}

/** Mock "Nano Banana": returns the blockout recoloured (warm stone), optionally shifted horizontally by `shiftPx`. */
function mockGenerator(shiftPx = 0, calls: any[] = []): StationImageGenerator {
    return {
        name: `mock(shift=${shiftPx})`,
        async generate(args) {
            calls.push({ prompt: args.prompt, hasReference: !!args.referencePng, hasMask: !!args.maskPng, aspectRatio: args.aspectRatio });
            const b = decodePng(args.blockoutPng);
            const out = Buffer.alloc(b.rgba.length);
            for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
                const sx = Math.min(b.width - 1, Math.max(0, x - shiftPx));
                const si = (y * b.width + sx) * 4, di = (y * b.width + x) * 4;
                const isSky = b.rgba[si + 2] > 170 && b.rgba[si] < 140;
                if (isSky) { out[di] = 135; out[di + 1] = 170; out[di + 2] = 215; }
                else { const l = b.rgba[si]; out[di] = Math.min(255, l * 1.15 + 20); out[di + 1] = l * 0.95 + 10; out[di + 2] = l * 0.75; }
                out[di + 3] = 255;
            }
            return encodePng(b.width, b.height, out);
        }
    };
}

describe('BeautifyStationService: render -> prompt -> generate -> QC -> aligned pose', () => {
    let renderer: SurveyStationRenderService;
    beforeAll(async () => {
        // 10 m cube centred at origin (x,z in [-5,5]), 20 m tall, on a 200 m ground plane (same as survey-station-render.test.ts)
        writeBoxGroundGlb(GLB, [-5, 0, -5], [5, 20, 5], 100);
        renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
    });
    afterAll(() => {
        fs.removeSync(WORK_DIR);
    });

    it('accepts a geometry-preserving generation: QC passes, aligned pose stays within tolerance, prompt is station-grounded', async () => {
        const station = renderer.enrichStations([stationFromLookAt(1, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)], { isoDate: '2026-06-21T02:00:00Z' })[0];
        const calls: any[] = [];
        const svc = new BeautifyStationService(renderer, mockGenerator(0, calls));
        const res = await svc.beautify(station, { locationName: 'Test Box', moodPromptContext: 'Clear noon. ', styleSuffix: ' Photo.' }, { width: 640, height: 360 });
        expect(res.accepted).toBe(true);
        expect(res.attempts).toBe(1);
        expect(res.qc.deltaYawDeg).toBeLessThan(0.15);
        expect(res.qc.deltaPitchDeg).toBeLessThan(0.15);
        expect(res.qc.deltaPositionM).toBeLessThan(0.3);
        expect(res.prompt).toContain('Camera lock: 28mm lens');
        expect(res.prompt).toContain('Sun: azimuth');
        expect(res.prompt).toContain('Subject distance: approximately 40 meters');
        expect(calls[0].aspectRatio).toBe('16:9');
        expect(calls[0].hasReference).toBe(false);
        expect(decodePng(res.imagePng).width).toBe(640);
        await fs.ensureDir(SHOTS);
        await fs.outputFile(path.join(SHOTS, '35_beautify_station_mock_accepted.png'), res.imagePng);
    });

    it('rejects a generation that moved the geometry beyond tolerance and reports the recovered shift', async () => {
        const station = renderer.enrichStations([stationFromLookAt(2, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)])[0];
        // 40 px shift at fx ~ 497 px (640 wide, 65.5 deg) = ~4.6 deg of yaw
        const svc = new BeautifyStationService(renderer, mockGenerator(40));
        const res = await svc.beautify(station, { locationName: 'Test Box' }, { width: 640, height: 360, maxRerolls: 1 });
        expect(res.accepted).toBe(false);
        expect(res.attempts).toBe(2);
        expect(res.qc.deltaYawDeg).toBeGreaterThan(1.5);
        expect(res.qc.reason).toMatch(/yaw|position|translation/i);
    });

    it('chained mode: warps the previous accepted image into the new station with a disocclusion mask and passes both to the generator', async () => {
        const a = renderer.enrichStations([stationFromLookAt(1, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)])[0];
        const b = renderer.enrichStations([stationFromLookAt(2, [20, 10, 42], [0, 10, 0], OPTICS, ANCHOR)])[0];
        const calls: any[] = [];
        const svc = new BeautifyStationService(renderer, mockGenerator(0, calls));
        const first = await svc.beautify(a, { locationName: 'Test Box' }, { width: 640, height: 360 });
        const second = await svc.beautify(b, { locationName: 'Test Box' }, { width: 640, height: 360, reference: first });
        expect(second.accepted).toBe(true);
        expect(calls[1].hasReference).toBe(true);
        expect(calls[1].hasMask).toBe(true);
        expect(calls[1].prompt).toContain('reference photograph');
        expect(second.warp).toBeDefined();
        // The warp must cover a large part of the frame but leave disocclusion holes
        expect(second.warp!.coveredFraction).toBeGreaterThan(0.3);
        expect(second.warp!.coveredFraction).toBeLessThan(0.98);
        await fs.outputFile(path.join(SHOTS, '36_beautify_station_chained_warp.png'), second.warp!.warpedPng);
    });

    it('warp correctness: a coloured pixel on the box face lands where the target camera projects that 3D point', () => {
        const a = stationFromLookAt(1, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR);
        const b = stationFromLookAt(2, [15, 10, 42], [0, 10, 0], OPTICS, ANCHOR);
        const W = 320, H = 180;
        const ra = renderer.renderStationBlockout(a, { width: W, height: H });
        const rb = renderer.renderStationBlockout(b, { width: W, height: H });
        // Paint the centre pixel of A red; it sees the box face at (0, 10, 5) 40 m ahead
        const img = Buffer.from(ra.rgba);
        const ci = ((H / 2) * W + W / 2) * 4; img[ci] = 255; img[ci + 1] = 0; img[ci + 2] = 0;
        const warp = warpStationImage({ rgba: img, depth: ra.depth, width: W, height: H, intrinsics: ra.intrinsics, station: a }, { intrinsics: rb.intrinsics, station: b, width: W, height: H });
        // Find the red pixel in the warp
        let rx = -1, ry = -1;
        for (let y = 0; y < H && rx < 0; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (warp.rgba[i] > 200 && warp.rgba[i + 1] < 60) { rx = x; ry = y; break; } }
        expect(rx).toBeGreaterThanOrEqual(0);
        // Analytic projection of world point P = (0, 10, 5) into camera B
        const P = [0, 10, 5];
        const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(b, W, H);
        const f = [pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z]; const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
        const up = [0, 1, 0]; const r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]]; const rl = Math.hypot(...r); r[0] /= rl; r[1] /= rl; r[2] /= rl;
        const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
        const d = [P[0] - pose.x, P[1] - pose.y, P[2] - pose.z];
        const cx = d[0] * r[0] + d[1] * r[1] + d[2] * r[2], cy = d[0] * u[0] + d[1] * u[1] + d[2] * u[2], cz = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
        const px = intrinsics.cx + intrinsics.fx * cx / cz, py = intrinsics.cy - intrinsics.fy * cy / cz;
        expect(Math.abs(rx - px)).toBeLessThan(2.5);
        expect(Math.abs(ry - py)).toBeLessThan(2.5);
    });

    it('draft mode: fast 1-shot turnaround for aligned plate, verifies single-render initMetrics overlap >= 85%', async () => {
        // High pitch station (> 25 deg upward look) -> auto aspect ratio resolves to 9:16 portrait
        const steepStation = renderer.enrichStations([stationFromLookAt(3, [0, 2, 20], [0, 25, 0], OPTICS, ANCHOR)])[0];
        const calls: any[] = [];
        // Generator with 0px shift: perfectly aligned with blockout silhouette
        const svc = new BeautifyStationService(renderer, mockGenerator(0, calls));
        const res = await svc.beautify(
            steepStation,
            { locationName: 'High Pitch Test' },
            { draft: true, aspectRatio: 'auto' }
        );

        expect(res.accepted).toBe(true);
        expect(res.attempts).toBe(1);
        expect(res.qc.passed).toBe(true);
        expect(res.qc.overlapPercent).toBeGreaterThanOrEqual(85);
        expect(res.qc.deltaYawDeg).toBe(0);
        expect(res.qc.deltaPitchDeg).toBe(0);
        expect(calls.length).toBe(1);
        expect(calls[0].aspectRatio).toBe('9:16');
        const decoded = decodePng(res.imagePng);
        expect(decoded.width).toBe(768);
        expect(decoded.height).toBe(Math.round(768 / (9 / 16))); // 1365
    });

    it('draft mode cheap QC: rerolls once below 85% overlap with zero optimizer iterations', async () => {
        const steepStation = renderer.enrichStations([stationFromLookAt(4, [0, 2, 20], [0, 25, 0], OPTICS, ANCHOR)])[0];
        const calls: any[] = [];
        // Generator with 60px shift: severely misaligned, overlap drops well below 85%
        const svc = new BeautifyStationService(renderer, mockGenerator(60, calls));
        const res = await svc.beautify(
            steepStation,
            { locationName: 'Misaligned Draft Test' },
            { draft: true, aspectRatio: 'auto' }
        );

        // Should reroll once (total 2 attempts), and reject
        expect(res.attempts).toBe(2);
        expect(res.accepted).toBe(false);
        expect(res.qc.passed).toBe(false);
        expect(res.qc.overlapPercent).toBeLessThan(85);
        expect(calls.length).toBe(2);
    });

    it('names the image model that produced the kept picture, and says so when a generator names none', async () => {
        const station = renderer.enrichStations([stationFromLookAt(5, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)])[0];
        const recolour = mockGenerator(0);
        const naming: StationImageGenerator = {
            name: 'naming-mock',
            async generate(args) {
                return { png: (await recolour.generate(args)) as Buffer, modelUsed: 'gemini-3-pro-image', modelNote: 'Generated with gemini-3-pro-image, not the requested gemini-3.1-flash-image: skipped gemini-3.1-flash-image (not served: 404).' };
            }
        };
        const named = await new BeautifyStationService(renderer, naming).beautify(station, { locationName: 'Test Box' }, { width: 320, height: 180, draft: true, maxRerolls: 0 });
        expect(named.modelUsed).toBe('gemini-3-pro-image');
        expect(BeautifyModule.describeStationImageSource(named)).toContain('not the requested gemini-3.1-flash-image');

        const anonymous = await new BeautifyStationService(renderer, mockGenerator(0)).beautify(station, { locationName: 'Test Box' }, { width: 320, height: 180, draft: true, maxRerolls: 0 });
        expect(anonymous.modelUsed).toBeUndefined();
        expect(BeautifyModule.describeStationImageSource(anonymous)).toBe('Generated by the mock(shift=0) generator, which names no model.');
    });
});

describe('Station image generators', () => {
    it('the Google generator passes on the model the media service says answered', async () => {
        const png = encodePng(4, 4, Buffer.alloc(64, 200));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-station-gen-'));
        try {
            const generator = createGoogleStationImageGenerator({
                mediaService: { generateImage: async () => ({ asset: 'answer.png', modelUsed: 'gemini-2.5-flash-image', modelNote: 'Generated with gemini-2.5-flash-image.' }) },
                assetStore: { put: async () => 'ref.png', resolve: (_root: string, asset: string) => path.join(dir, asset) },
                workspaceRoot: dir
            });
            fs.writeFileSync(path.join(dir, 'answer.png'), png);
            const answer = await generator.generate({ prompt: 'p', blockoutPng: png, aspectRatio: '1:1', width: 4, height: 4 });
            expect(answer).toEqual({ png, modelUsed: 'gemini-2.5-flash-image', modelNote: 'Generated with gemini-2.5-flash-image.' });
        } finally {
            fs.removeSync(dir);
        }
    });

    it('there is no offline procedural painter: the default generator is always the image model', () => {
        expect((BeautifyModule as any).createArchitecturalStationGenerator).toBeUndefined();
        const generator = createDefaultStationImageGenerator({ mediaService: { generateImage: async () => { throw new Error('not called'); } }, allowProceduralGenerator: true } as any);
        expect(generator.name).toBe('google-nano-banana');
    });
});

describe('ensureStationPng: image models may answer with JPEG', () => {
    it('converts a JPEG into a PNG with the same size and colours (works without ffmpeg)', async () => {
        // 64x32: left half red, right half blue (flat blocks survive JPEG compression almost exactly)
        const W = 64, H = 32;
        const rgba = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            rgba[i] = x < W / 2 ? 220 : 20; rgba[i + 1] = 30; rgba[i + 2] = x < W / 2 ? 20 : 210; rgba[i + 3] = 255;
        }
        const jpeg = encodeJpeg({ data: rgba, width: W, height: H }, 95).data;
        expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');

        const png = await ensureStationPng(Buffer.from(jpeg));
        fs.ensureDirSync(SHOTS);
        fs.writeFileSync(path.join(SHOTS, 'station_png_from_jpeg.png'), png);
        const img = decodePng(png);
        expect([img.width, img.height]).toEqual([W, H]);
        const at = (x: number, y: number) => Array.from(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
        for (const [got, want] of [[at(8, 16), [220, 30, 20]], [at(56, 16), [20, 30, 210]]] as const) {
            got.forEach((v, k) => expect(Math.abs(v - want[k])).toBeLessThan(12));
        }
    });

    it('passes PNG through untouched and rejects bytes that are no image, naming the format', async () => {
        const png = encodePng(2, 2, Buffer.alloc(16, 255));
        expect(await ensureStationPng(png)).toBe(png);
        await expect(ensureStationPng(Buffer.from('not an image at all'))).rejects.toThrow(/could not be converted to PNG \(6e6f7420\): .*unrecognised image format/);
    });
});
