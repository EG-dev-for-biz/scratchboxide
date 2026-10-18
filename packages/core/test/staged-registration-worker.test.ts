/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { renderFrameDepth, ZERO_CORRECTION, type PoseCorrection } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import type { Registration, RegView } from '../src/node/3d-engine/staged-location/pano-registration';
import { runPanoRegistration, runPanoRegistrationOffThread, type PanoRegistrationJob } from '../src/node/3d-engine/staged-location/pano-registration-run';
import { encodeRgbaToJpeg } from '../src/node/image-codec-ffmpeg';
import { writeGlb } from './helpers/synthetic-scan-glb';

/**
 * The evidence stage's registration (edges, then jointly) runs in a worker thread: the same poses as on the main thread,
 * and the main thread is free meanwhile (live it was held ~107 s in one block while vision calls were in flight).
 */
const W = 640, H = 480, COURSE = 0.5, BLOCK = 1.0;

function addBox(v: number[], ix: number[], lo: [number, number, number], hi: [number, number, number]): void {
    const b = v.length / 3;
    for (let k = 0; k < 8; k++) v.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
    for (const [a, c, d, e] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) ix.push(b + a, b + c, b + d, b + a, b + d, b + e);
}

function facade(): { mesh: RenderMesh3D; v: number[]; ix: number[] } {
    const v: number[] = [], ix: number[] = [];
    addBox(v, ix, [-60, -0.3, -60], [60, 0, 60]);
    addBox(v, ix, [-6, 0, -1], [-2, 10, 0]);
    addBox(v, ix, [2, 0, -1], [6, 10, 0]);
    addBox(v, ix, [-2, 6, -1], [2, 10, 0]);
    addBox(v, ix, [-3, 10, -0.8], [3, 11.5, -0.2]);
    return { mesh: { vertices: new Float32Array(v), indices: new Uint32Array(ix) }, v, ix };
}

function stone(p: [number, number, number]): number {
    if (p[1] < 0.001) return 120 + ((Math.floor(p[0] * 3) * 7 + Math.floor(p[2] * 3) * 13) % 9);
    const k = Math.floor(p[1] / COURSE);
    const along = Math.abs(p[2]) < 0.01 || Math.abs(p[2] + 1) < 0.01 ? p[0] : p[2];
    const off = (((k % 2) + 2) % 2) * BLOCK / 2;
    const jy = ((p[1] % COURSE) + COURSE) % COURSE, jx = (((along + off) % BLOCK) + BLOCK) % BLOCK;
    return jy < 0.05 || jx < 0.05 ? 95 : 190 + (Math.abs(p[2]) < 0.01 ? 0 : -25);
}

function photo(mesh: RenderMesh3D, v: RegView, truth: PoseCorrection): Buffer {
    const cam = castCamera({ ...v, correction: truth });
    const depth = renderFrameDepth(mesh, cam);
    const rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, d = depth[i];
        let r: number, g: number, b: number;
        if (d < 1e8) {
            const u = (x + 0.5 - cam.cx) / cam.fx, w = (y + 0.5 - cam.cy) / cam.fy;
            const p = [0, 1, 2].map(k => cam.eye[k] + d * (cam.fwd[k] + u * cam.right[k] - w * cam.up[k])) as [number, number, number];
            r = g = b = stone(p);
        } else { r = 105 + y / 12; g = 155 + y / 14; b = 225; }
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

async function job(): Promise<PanoRegistrationJob> {
    const { mesh, v, ix } = facade();
    const dir = path.resolve(__dirname, '../../../test-results/registration-worker');
    fs.mkdirSync(dir, { recursive: true });
    const meshFile = path.join(dir, 'facade.glb');
    writeGlb(meshFile, [{ positions: v, indices: ix }]);
    const truths: Record<string, PoseCorrection> = { panoA: { ...ZERO_CORRECTION, dx: BLOCK / 2, dy: COURSE }, panoB: { ...ZERO_CORRECTION, dx: -BLOCK / 2, dy: -COURSE } };
    const views: RegView[] = [
        { panoId: 'panoA', eye: [-3, 1.7, 20], headingDeg: 8, pitchDeg: 14, fovDeg: 60, widthPx: W, heightPx: H },
        { panoId: 'panoB', eye: [4, 1.7, 21], headingDeg: -10, pitchDeg: 14, fovDeg: 60, widthPx: W, heightPx: H }
    ];
    const images = await Promise.all(views.map(async vw => ({ id: vw.panoId, bytes: await encodeRgbaToJpeg(photo(mesh, vw, truths[vw.panoId]), W, H, { quality: 95 }), widthPx: W, heightPx: H, view: vw })));
    const prior: Registration = {
        corrections: new Map([['panoA', ZERO_CORRECTION], ['panoB', ZERO_CORRECTION]]),
        perPano: views.map(vw => ({ panoId: vw.panoId, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 1, beforeRmsM: 1.3, afterRmsM: 1.3 })),
        setAside: [], pairs: [], beforeRmsM: 1.3, afterRmsM: 1.3, used: 1, rejected: 0
    } as Registration;
    return { images, meshFiles: [meshFile], prior, correspondences: [], faces: [], joint: false, edgeBudgetMs: 120_000 };
}

async function longestBlock(work: () => Promise<unknown> | unknown): Promise<number> {
    let last = performance.now(), worst = 0;
    const t = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
    last = performance.now();
    await work();
    await new Promise(r => setTimeout(r, 20));
    clearInterval(t);
    return worst;
}

describe('pano registration off the main thread', () => {
    it('gives the same poses in a worker thread, and the main thread stays free', async () => {
        const j = await job();
        let inline: ReturnType<typeof runPanoRegistration> | undefined;
        const blockInline = await longestBlock(() => { inline = runPanoRegistration(j); });
        const logs: string[] = [];
        let off: ReturnType<typeof runPanoRegistration> | undefined;
        const blockOff = await longestBlock(async () => { off = await runPanoRegistrationOffThread(j, { log: m => logs.push(m) }); });
        expect(inline!.edge!.panos.map(p => p.chosen)).toEqual(['edges', 'edges']);
        // the same poses, bit for bit (the corrections are plain numbers; the Map survives the structured clone)
        expect([...off!.registration!.corrections.entries()]).toEqual([...inline!.registration!.corrections.entries()]);
        expect(off!.edge!.panos.map(p => p.edge)).toEqual(inline!.edge!.panos.map(p => p.edge));
        expect(logs[0]).toMatch(/registering 2 panos/);
        expect(blockInline).toBeGreaterThan(300);
        expect(blockOff).toBeLessThan(150);
    }, 180_000);

    it('a stop ends the thread and rejects with the reason', async () => {
        const j = await job();
        const ac = new AbortController();
        const p = runPanoRegistrationOffThread(j, { signal: ac.signal });
        setTimeout(() => ac.abort(new Error('stopped by the user')), 50);
        await expect(p).rejects.toThrow('stopped by the user');
    }, 60_000);
});
