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
import { encodePng } from '../src/node/texture-processing';
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
