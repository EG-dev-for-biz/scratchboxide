/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Independent model calls run at once. Every client here is a fake that waits a fixed delay per call and records
 * how many calls were in flight together, so the tests show real overlap (wall time ~ one call, not the sum) and
 * that a Stop (or one call failing) ends every call still running. No test reaches a real model.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mapBounded, allAbortable } from '../src/common/async/bounded-concurrency';
import { encodePng, decodePng } from '../src/node/texture-processing';
import { MeshAiTextureBakingService } from '../src/node/spatial/MeshAiTextureBakingService';
import { MultiPerspectivePanoramaSynthesisService } from '../src/node/spatial/MultiPerspectivePanoramaSynthesisService';
import { SceneKeyframeVideoService } from '../src/node/spatial/SceneKeyframeVideoService';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import type { CameraPose6DOF } from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';

const DELAY_MS = 150;

/** Records calls in flight; `wait` resolves after `ms` unless the signal fires first (then rejects AbortError). */
function flightRecorder() {
    const rec = { inFlight: 0, maxInFlight: 0, started: 0, aborted: 0, completed: 0 };
    const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        rec.started++;
        rec.inFlight++;
        rec.maxInFlight = Math.max(rec.maxInFlight, rec.inFlight);
        const done = () => { rec.inFlight--; signal?.removeEventListener('abort', onAbort); };
        const timer = setTimeout(() => { done(); rec.completed++; resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); done(); rec.aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    return { rec, wait };
}

function solidPng(width: number, height: number, level = 120): Buffer {
    const rgba = Buffer.alloc(width * height * 4, level);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return encodePng(width, height, rgba);
}

/** A station image generator that answers a flat image at the asked size after DELAY_MS, honouring the signal. */
function delayedGenerator(wait: (ms: number, s?: AbortSignal) => Promise<void>, onCall?: (n: number) => void): StationImageGenerator {
    let n = 0;
    return {
        name: 'delayed-fake',
        async generate(a) {
            onCall?.(n++);
            await wait(DELAY_MS, a.signal);
            return { png: solidPng(a.width, a.height), modelUsed: 'fake-image-model' };
        }
    };
}

describe('mapBounded / allAbortable', () => {
    it('overlaps calls up to the limit, keeps input order, and wall time is ~max not sum', async () => {
        const { rec, wait } = flightRecorder();
        const t0 = Date.now();
        const out = await mapBounded([5, 4, 3, 2, 1, 0], async (x, _i, s) => { await wait(DELAY_MS - x * 10, s); return x * 2; });
        const wall = Date.now() - t0;
        expect(out).toEqual([10, 8, 6, 4, 2, 0]);
        expect(rec.maxInFlight).toBe(6);
        expect(wall).toBeLessThan(DELAY_MS * 2.5); // sequential would be ~6 x DELAY_MS

        const limited = flightRecorder();
        await mapBounded([1, 2, 3, 4, 5], async (_x, _i, s) => limited.wait(20, s), { limit: 2 });
        expect(limited.rec.maxInFlight).toBe(2);
        expect(limited.rec.completed).toBe(5);
    });

    it('a caller abort cancels every in-flight call and starts no more', async () => {
        const { rec, wait } = flightRecorder();
        const ctl = new AbortController();
        const p = mapBounded([1, 2, 3, 4, 5, 6], async (_x, _i, s) => wait(5_000, s), { limit: 3, signal: ctl.signal });
        setTimeout(() => ctl.abort(), 30);
        const t0 = Date.now();
        await expect(p).rejects.toThrow();
        expect(Date.now() - t0).toBeLessThan(1_000);
        expect(rec.started).toBe(3);
        expect(rec.aborted).toBe(3);
        expect(rec.inFlight).toBe(0);
    });

    it('the first failure aborts its siblings and is the error reported', async () => {
        const { rec, wait } = flightRecorder();
        const p = allAbortable([
            async (s: AbortSignal) => { await wait(5_000, s); return 1; },
            async () => { await new Promise(r => setTimeout(r, 20)); throw new Error('quota exceeded'); },
            async (s: AbortSignal) => { await wait(5_000, s); return 3; }
        ] as const);
        await expect(p).rejects.toThrow('quota exceeded');
        expect(rec.aborted).toBe(2);
        expect(rec.inFlight).toBe(0);
    });
});

describe('mesh_bake_ai_textures: six views at once', () => {
    it('restyles the six views concurrently (wall ~ one call), in rig order, and a Stop cancels every view', async () => {
        const { writeFixtureGlb, uvCubeMesh } = await import('./helpers/mesh-glb-fixtures');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-par-bake-'));
        try {
            const glbPath = writeFixtureGlb(path.join(dir, 'cube.glb'), uvCubeMesh(2));
            const { rec, wait } = flightRecorder();
            const prompts: string[] = [];
            const gen = delayedGenerator(wait);
            const recording: StationImageGenerator = { name: gen.name, generate: a => { prompts.push(a.prompt); return gen.generate(a); } };
            const service = new MeshAiTextureBakingService({ generator: recording, workspaceRoot: dir });
            const t0 = Date.now();
            const result = await service.bakeMeshTexturesWithAi({ glbPath, stylePrompt: 'bronze', width: 32, height: 32, outGlbPath: path.join(dir, 'out.glb'), resolution: 64 });
            const wall = Date.now() - t0;
            expect(rec.maxInFlight).toBe(6);
            expect(rec.completed).toBe(6);
            expect(prompts.map(p => p.match(/View direction: (\w+)/)?.[1])).toEqual(['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom']);
            expect(result.views.map(v => v.name)).toEqual(['Front', 'Back', 'Left', 'Right', 'Top', 'Bottom']);
            // Six sequential calls would take >= 6 x DELAY_MS of model time alone.
            expect(wall).toBeLessThan(6 * DELAY_MS);

            const stop = flightRecorder();
            const ctl = new AbortController();
            const stopped = new MeshAiTextureBakingService({ generator: delayedGenerator((ms, s) => stop.wait(ms * 40, s)), workspaceRoot: dir });
            const p = stopped.bakeMeshTexturesWithAi({ glbPath, stylePrompt: 'bronze', width: 32, height: 32, outGlbPath: path.join(dir, 'out2.glb'), signal: ctl.signal });
            setTimeout(() => ctl.abort(), 50);
            await expect(p).rejects.toThrow();
            expect(stop.rec.started).toBe(6);
            expect(stop.rec.aborted).toBe(6);
            expect(fs.existsSync(path.join(dir, 'out2.glb'))).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('panorama_generate_perspectives: views after the first at once', () => {
    function delayedCredentials(wait: (ms: number, s?: AbortSignal) => Promise<void>, order: string[]) {
        const png = solidPng(24, 24, 90);
        return {
            createClient: async () => ({
                models: {
                    generateContent: async ({ contents, config }: any) => {
                        const view = String(contents[0].text).match(/\b(right|back|left|top|bottom)\b/i)?.[1] ?? '?';
                        order.push(`start:${view}`);
                        await wait(DELAY_MS, config?.abortSignal);
                        order.push(`end:${view}`);
                        return { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] };
                    }
                }
            })
        } as any;
    }

    it('asks the first view alone (it fixes the model), then the other four together', async () => {
        const { rec, wait } = flightRecorder();
        const order: string[] = [];
        const svc = new MultiPerspectivePanoramaSynthesisService(delayedCredentials(wait, order));
        const t0 = Date.now();
        const out = await svc.synthesizePerspectivesWithNanoBanana(Buffer.alloc(16 * 16 * 4, 128), 16, { model: 'gemini-3.1-flash-image' });
        const wall = Date.now() - t0;
        expect(order[0]).toMatch(/^start:/);
        expect(order[1]).toMatch(/^end:/);                 // the first view finished before any other started
        expect(order.slice(2, 6).every(e => e.startsWith('start:'))).toBe(true);
        expect(rec.maxInFlight).toBe(4);
        expect(Object.keys(out.perspectives)).toEqual(['front', 'right', 'back', 'left', 'top', 'bottom']);
        expect(wall).toBeLessThan(4 * DELAY_MS);          // sequential: 5 x DELAY_MS

        const stop = flightRecorder();
        const ctl = new AbortController();
        const slow = new MultiPerspectivePanoramaSynthesisService(delayedCredentials((ms, s) => stop.wait(ms === DELAY_MS && stop.rec.started === 0 ? 10 : 10_000, s), []));
        const p = slow.synthesizePerspectivesWithNanoBanana(Buffer.alloc(16 * 16 * 4, 128), 16, { model: 'gemini-3.1-flash-image', signal: ctl.signal });
        setTimeout(() => ctl.abort(), 150);
        await expect(p).rejects.toThrow();
        expect(stop.rec.started).toBe(5);
        expect(stop.rec.aborted).toBe(4);
        expect(stop.rec.inFlight).toBe(0);
    });
});

describe('spatial_keyframe_video_interpolation: both stills at once', () => {
    const mesh: RenderMesh3D = { vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const pose: CameraPose6DOF = { x: 0, y: 0, z: 5, targetX: 0, targetY: 0, targetZ: 0, up: [0, 1, 0], fov: 60 };

    it('restyles start and end together, sends only the two stills, names them as first/last frame, and asks a served aspect', async () => {
        const { rec, wait } = flightRecorder();
        let request: any;
        const client = {
            interactions: {
                create: async (req: any) => {
                    request = req;
                    return { steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: Buffer.from('mp4').toString('base64') }] }] };
                }
            }
        };
        const svc = new SceneKeyframeVideoService({ client, generator: delayedGenerator(wait) });
        const t0 = Date.now();
        const out = await svc.synthesizeKeyframeInterpolationVideo({ mesh, startPose: pose, endPose: { ...pose, x: 2 }, prompt: 'a temple', width: 64, height: 48 });
        expect(Date.now() - t0).toBeLessThan(2 * DELAY_MS);
        expect(rec.maxInFlight).toBe(2);
        expect(out.aspectRatio).toBe('16:9');
        expect([out.width, out.height]).toEqual([64, 36]);
        expect(request.response_format.aspect_ratio).toBe('16:9');
        const text = request.input[0].text as string;
        expect(text).toContain('<FIRST_FRAME>');
        expect(text).toContain('<LAST_FRAME>');
        expect(text).not.toContain('VIDEO_REF');
        expect(request.input.filter((p: any) => p.type === 'image')).toHaveLength(2);
        expect(request.input.some((p: any) => p.type === 'video')).toBe(false);

        expect(SceneKeyframeVideoService.keyframeVideoFrame(720, 1280)).toEqual({ aspectRatio: '9:16', width: 720, height: 1280 });
    });

    it('a Stop cancels both stills before the video call', async () => {
        const stop = flightRecorder();
        let videoCalls = 0;
        const svc = new SceneKeyframeVideoService({ client: { interactions: { create: async () => { videoCalls++; return {}; } } }, generator: delayedGenerator((ms, s) => stop.wait(ms * 50, s)) });
        const ctl = new AbortController();
        const p = svc.synthesizeKeyframeInterpolationVideo({ mesh, startPose: pose, endPose: { ...pose, x: 2 }, prompt: 'x', width: 64, height: 36, signal: ctl.signal });
        setTimeout(() => ctl.abort(), 30);
        await expect(p).rejects.toThrow();
        expect(stop.rec.aborted).toBe(2);
        expect(videoCalls).toBe(0);
    });
});

describe('cullMeshToView', () => {
    it('renders pixel-identical depth from poses near the culling pose, with far fewer triangles', () => {
        // A 40 x 40 grid of quads on the ground, 200 m across; the camera stands near one edge looking out over it.
        const verts: number[] = [];
        const idx: number[] = [];
        const N = 40, S = 5;
        for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) verts.push(i * S - 100, Math.sin(i) * 0.5 + Math.cos(j) * 0.5, j * S - 100);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
            idx.push(a, b, d, a, d, c);
        }
        const mesh: RenderMesh3D = { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
        const pose: CameraPose6DOF = { x: 40, y: 8, z: 0, targetX: 70, targetY: 0, targetZ: 5, up: [0, 1, 0], fov: 50 };
        const culled = HeadlessMeshSilhouetteRenderer.cullMeshToView(mesh, pose, 160, 120);
        expect(culled.indices.length).toBeLessThan(mesh.indices.length * 0.6);
        for (const p of [pose, { ...pose, x: pose.x + 2, targetX: pose.targetX + 3 }, { ...pose, y: pose.y + 1.5, targetZ: pose.targetZ - 4 }]) {
            const full = HeadlessMeshSilhouetteRenderer.renderMesh(mesh, p, 160, 120, { clipNearPlane: true });
            const part = HeadlessMeshSilhouetteRenderer.renderMesh(culled, p, 160, 120, { clipNearPlane: true });
            expect(Buffer.from(part.depthBuffer.buffer).equals(Buffer.from(full.depthBuffer.buffer))).toBe(true);
        }
    });
});

describe('panorama: crops for local edits, seam and nadir at once, 4K delegation', () => {
    const RATIOS: Record<string, number> = { '9:16': 9 / 16, '2:3': 2 / 3, '3:4': 3 / 4, '4:5': 4 / 5, '1:1': 1, '5:4': 5 / 4, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '21:9': 21 / 9 };
    /** Answers every image call with a flat colour at the asked ratio (height 256) after `delay`, honouring the signal. */
    function panoClient(wait: (ms: number, s?: AbortSignal) => Promise<void>, delay: number, log: Array<{ aspect: string; w: number; h: number }>) {
        return {
            createClient: async () => ({
                models: {
                    generateContent: async (req: any) => {
                        const aspect = req.config.imageConfig.aspectRatio as string;
                        const sent = req.contents.find((c: any) => c.inlineData);
                        const dims = sent ? decodePng(Buffer.from(sent.inlineData.data, 'base64')) : { width: 0, height: 0 };
                        log.push({ aspect, w: dims.width, h: dims.height });
                        await wait(delay, req.config.abortSignal);
                        const h = 512, w = Math.round(h * RATIOS[aspect]);
                        return { candidates: [{ content: { parts: [{ inlineData: { data: solidPng(w, h, 200).toString('base64'), mimeType: 'image/png' } }] } }] };
                    }
                }
            })
        } as any;
    }
    function gradientPano(w: number, h: number): Buffer {
        const rgba = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; rgba[i] = x % 256; rgba[i + 1] = y % 256; rgba[i + 2] = 60; rgba[i + 3] = 255; }
        return encodePng(w, h, rgba);
    }

    it('heals the seam from a 9:16 crop around the band, leaving every pixel outside the band unchanged', async () => {
        const { Google360PanoramaPipelineService } = await import('../src/node/spatial/Google360PanoramaPipelineService');
        const log: Array<{ aspect: string; w: number; h: number }> = [];
        const svc = new Google360PanoramaPipelineService(panoClient(async () => {}, 0, log));
        const input = gradientPano(2048, 1024);
        const res = await svc.healPanoramaSeam({ inputImageBuffer: input });
        expect(log).toHaveLength(1);
        expect(log[0].aspect).toBe('9:16');
        expect(log[0].h).toBe(1024);
        expect(log[0].w).toBeLessThan(2048 * 0.3);     // the full frame would be sent widened to 21:9 (2389 px)
        expect(res.summary).toMatch(/region at \d+,0 was sent, not the whole image/);
        const a = decodePng(input).rgba, b = decodePng(res.outputBuffer).rgba;
        // Columns far from the wrap seam (x = 0 / 2047) are untouched.
        for (const x of [300, 1024, 1700]) for (const y of [0, 500, 1023]) {
            const i = (y * 2048 + x) * 4;
            expect([b[i], b[i + 1], b[i + 2]]).toEqual([a[i], a[i + 1], a[i + 2]]);
        }
    });

    it('generate: seam heal and nadir infill run at once on the base; a Stop cancels both', async () => {
        const { Google360PanoramaPipelineService } = await import('../src/node/spatial/Google360PanoramaPipelineService');
        const { rec, wait } = flightRecorder();
        const log: Array<{ aspect: string; w: number; h: number }> = [];
        const svc = new Google360PanoramaPipelineService(panoClient(wait, DELAY_MS, log));
        const t0 = Date.now();
        const res = await svc.generate360Panorama({ prompt: 'salt flats', width: 512, height: 256, inpaintNadir: true });
        const wall = Date.now() - t0;
        expect(log.map(l => l.aspect)[0]).toBe('21:9');     // the base
        expect(log).toHaveLength(3);
        expect(rec.maxInFlight).toBe(2);                      // seam + nadir together
        expect(wall).toBeLessThan(3 * DELAY_MS);              // sequential: 3 x DELAY_MS
        expect(res.seamHealed).toBe(true);
        expect(res.summary).toContain('Nadir infill');
        expect(res.summary).toContain('nothing was squeezed');

        const stop = flightRecorder();
        const ctl = new AbortController();
        const slow = new Google360PanoramaPipelineService(panoClient((ms, s) => stop.wait(stop.rec.started === 0 ? 5 : 10_000, s), 0, []));
        const p = slow.generate360Panorama({ prompt: 'salt flats', width: 512, height: 256, inpaintNadir: true, signal: ctl.signal });
        setTimeout(() => ctl.abort(), 120);
        await expect(p).rejects.toThrow();
        expect(stop.rec.started).toBe(3);
        expect(stop.rec.aborted).toBe(2);
    });

    it('the 4K path passes the Stop to its model call and still makes a nadir infill asked for', async () => {
        const { Google360PanoramaPipelineService } = await import('../src/node/spatial/Google360PanoramaPipelineService');
        const log: Array<{ aspect: string; w: number; h: number }> = [];
        const stop = flightRecorder();
        const ctl = new AbortController();
        const svc = new Google360PanoramaPipelineService(panoClient((ms, s) => stop.wait(10_000, s), 0, log));
        const p = svc.generate360Panorama({ prompt: 'nave', width: 4096, height: 2048, signal: ctl.signal });
        setTimeout(() => ctl.abort(), 40);
        await expect(p).rejects.toThrow();
        expect(stop.rec.aborted).toBe(1);

        const ok = new Google360PanoramaPipelineService(panoClient(async () => {}, 0, log));
        log.length = 0;
        const res = await ok.generate360Panorama({ prompt: 'nave', width: 4096, height: 2048, inpaintNadir: true, maxModelUpscale: 8 });
        expect(log).toHaveLength(2);
        expect(res.summary).toContain('Nadir infill');
    }, 60_000);
});

describe('spatial_smart_point_inpaint: sends the region around the point', () => {
    it('sends a crop around a small mask, blends only inside the mask, and reports the region', async () => {
        const { SpatialSmartPointInpaintService } = await import('../src/node/spatial/SpatialSmartPointInpaintService');
        const W = 1024, H = 768;
        const base = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) { base[i * 4] = 40; base[i * 4 + 1] = 120; base[i * 4 + 2] = 200; base[i * 4 + 3] = 255; }
        const mask = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const v = Math.hypot(x - 700, y - 300) <= 20 ? 255 : 0;
            mask.fill(v, (y * W + x) * 4, (y * W + x) * 4 + 3); mask[(y * W + x) * 4 + 3] = 255;
        }
        const sent: Array<{ w: number; h: number; aspect: string }> = [];
        const client = {
            models: {
                generateContent: async (req: any) => {
                    const img = decodePng(Buffer.from(req.contents[0].inlineData.data, 'base64'));
                    sent.push({ w: img.width, h: img.height, aspect: req.config.imageConfig.aspectRatio });
                    return { candidates: [{ content: { parts: [{ inlineData: { data: solidPng(img.width, img.height, 250).toString('base64'), mimeType: 'image/png' } }] } }] };
                }
            }
        };
        const svc = new SpatialSmartPointInpaintService({ client });
        const res = await svc.executeSpatialInpaint({ image: encodePng(W, H, base), mask: encodePng(W, H, mask), prompt: 'a brass bollard', model: 'gemini-3.1-flash-image' });
        expect(sent).toHaveLength(1);
        expect(sent[0].w * sent[0].h).toBeLessThan(W * H * 0.1);
        expect(res.sentRegion).toBeDefined();
        const out = decodePng(res.image).rgba;
        const px = (x: number, y: number) => Array.from(out.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
        expect(px(700, 300)).toEqual([250, 250, 250]);   // inside the mask: the model's edit
        expect(px(700, 330)).toEqual([40, 120, 200]);    // in the crop, outside the mask: the input
        expect(px(100, 100)).toEqual([40, 120, 200]);    // outside the crop: the input
    });
});

describe('vision calls get images no larger than they need', () => {
    it('downscaleForVision area-averages a large image to a 1024 px long edge and leaves a small one as it is', async () => {
        const { downscaleForVision } = await import('../src/node/vision-image-downscale');
        const W = 3000, H = 2000;
        const rgba = Buffer.alloc(W * H * 4);
        // A 1 px checkerboard: an area average is mid grey; a point sample would alias to black or white.
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = (x + y) % 2 ? 255 : 0; const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255; }
        const big = await downscaleForVision(encodePng(W, H, rgba), 'image/png');
        expect([big.width, big.height, big.downscaled]).toEqual([1024, 683, true]);
        const px = decodePng(big.data).rgba;
        expect(Math.abs(px[(300 * 1024 + 500) * 4] - 128)).toBeLessThan(30);
        const smallPng = solidPng(640, 480);
        const small = await downscaleForVision(smallPng, 'image/png');
        expect(small.downscaled).toBe(false);
        expect(small.data).toBe(smallPng);
    });

    it('style deconstruction sends the downscaled image and asks for pixel measures at the original size', async () => {
        const { AdaptiveStyleDeconstructionService } = await import('../src/node/spatial/AdaptiveStyleDeconstructionService');
        let sent: any;
        const client = { models: { generateContent: async (req: any) => { sent = req; throw new Error('stop after recording'); } } };
        const svc = new AdaptiveStyleDeconstructionService({ client });
        await svc.deconstructStyle(solidPng(2400, 1600), undefined, { client } as any).catch(() => undefined);
        const parts = sent.contents;
        const img = decodePng(Buffer.from(parts[0].inlineData.data, 'base64'));
        expect([img.width, img.height]).toEqual([1024, 683]);
        expect(String(parts[1])).toContain('downscaled from 2400x1600 to 1024x683');
    });
});
