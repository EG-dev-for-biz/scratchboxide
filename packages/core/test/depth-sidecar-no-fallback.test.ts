/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The depth sidecar (tools/depth/panorama_depth.py) either measures depth with the depth model or fails: no
 * synthetic room, no invented 30 m fill, no default eye height. The real sidecar script runs here under a Python
 * with torch and numpy; test/helpers/depth-sidecar-stubs stands in for Pillow and for transformers (a constant
 * planar depth when STUB_DEPTH_METERS is set, a missing module otherwise), so no model weights are downloaded.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/texture-processing';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';
import { SplatService } from '../src/node/3d-engine/splat-service';
import { GeneratorFailedError } from '../src/common/errors/pipeline-errors';
import { REPO_ROOT, requirePythonModules, withReason } from './helpers/requirements';

const PYTHON = process.env.SCRATCHBOX_PYTHON || 'python3';
const torchPython = requirePythonModules(PYTHON, ['torch', 'numpy']);
const SIDECAR = path.join(REPO_ROOT, 'tools/depth/panorama_depth.py');
const STUBS = path.join(__dirname, 'helpers/depth-sidecar-stubs');
const DEPTH_MODEL = 'depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf';

function writeGradientPng(file: string, width: number, height: number): void {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            rgba[i] = (x * 255) / width; rgba[i + 1] = (y * 255) / height; rgba[i + 2] = 128; rgba[i + 3] = 255;
        }
    }
    fs.outputFileSync(file, encodePng(width, height, rgba));
}

/** Environment for the sidecar: the stubs on PYTHONPATH, and the stub depth model only when `depthMeters` is set. */
function sidecarEnv(depthMeters?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: STUBS };
    delete env.STUB_DEPTH_METERS;
    if (depthMeters !== undefined) env.STUB_DEPTH_METERS = String(depthMeters);
    return env;
}

describe.skipIf(!torchPython.ok)(withReason('Depth sidecar: measured depth or a failure, never a stand-in', torchPython), () => {
    let work = '';
    let pano = '';
    let tinyPano = '';
    let photo = '';

    beforeAll(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-depth-sidecar-'));
        pano = path.join(work, 'pano.png');
        tinyPano = path.join(work, 'tiny_pano.png');
        photo = path.join(work, 'photo.png');
        writeGradientPng(pano, 64, 32);
        writeGradientPng(tinyPano, 16, 8);
        writeGradientPng(photo, 48, 36);
    });

    afterAll(async () => {
        await fs.remove(work);
    });

    it('the sidecar exits non-zero and writes no depth when the depth model cannot load (there is no synthetic room)', () => {
        const out = path.join(work, 'direct');
        const run = spawnSync(PYTHON, [SIDECAR, '--input', pano, '--output-depth', `${out}.depth.f32`, '--output-preview', `${out}.png`,
            '--output-json', `${out}.json`, '--device', 'cpu'], { env: sidecarEnv(), encoding: 'utf8' });
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain(`the depth model ${DEPTH_MODEL} could not be loaded`);
        expect(`${run.stdout}${run.stderr}`).not.toMatch(/synthetic|fallback/i);
        expect(fs.existsSync(`${out}.json`)).toBe(false);
        expect(fs.existsSync(`${out}.depth.f32`)).toBe(false);
    });

    it('PanoramaDepthService fails with the sidecar\'s error when the depth model cannot load', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv() });
        const run = service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-fail'), device: 'cpu' });
        await expect(run).rejects.toBeInstanceOf(GeneratorFailedError);
        await expect(service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-fail'), device: 'cpu' })).rejects.toThrow(/could not be loaded/);
        expect(fs.readdirSync(path.join(work, 'svc-fail')).filter(f => f.endsWith('.json'))).toEqual([]);
    });

    it('reports the eye height and depth range the sidecar measured from the model\'s depth', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(4) });
        const res = await service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-ok'), device: 'cpu' });
        expect(res.modelUsed).toBe(DEPTH_MODEL);
        expect(res.floorFitApplied).toBe(true);
        expect(res.eyeHeightInferred).toBe(true);
        // A constant 4 m planar depth per face puts the floor band ~3.9 m below the camera: measured, not 1.70.
        expect(res.eyeHeight).toBeGreaterThan(3.5);
        expect(res.eyeHeight).toBeLessThan(4.1);
        expect(res.groundY).toBeCloseTo(-res.eyeHeight, 6);
        expect(res.scaleCorrection).toBe(1);
        expect(res.minDepth).toBeGreaterThan(3.5);
        expect(res.maxDepth).toBeGreaterThan(res.minDepth);
        const depth = new Float32Array((await fs.readFile(res.depthPath)).buffer.slice(0));
        expect(depth.length).toBe(64 * 32);
        expect(Math.min(...depth)).toBeCloseTo(res.minDepth, 4);
    });

    it('fails rather than assume an eye height when the floor cannot be measured', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(4) });
        await expect(service.generatePanoramaDepth(tinyPano, { outDir: path.join(work, 'svc-tiny'), device: 'cpu' }))
            .rejects.toThrow(/eye height cannot be measured/);
    });

    it('fails when the given eye height disagrees with the measured floor by more than 4x, instead of clamping', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(4) });
        await expect(service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-eye'), device: 'cpu', eyeHeight: 0.5 }))
            .rejects.toThrow(/more than 4x/);
    });

    it('perspective photos get the model\'s planar depth at the photo\'s own size', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(2.5) });
        const res = await service.generateImageDepth(photo, { outDir: path.join(work, 'svc-photo'), device: 'cpu' });
        expect([res.width, res.height]).toEqual([48, 36]);
        expect(res.depthKind).toBe('planar-z');
        expect(res.modelUsed).toBe(DEPTH_MODEL);
        expect(res.depths.length).toBe(48 * 36);
        expect(Array.from(res.depths).every(d => Math.abs(d - 2.5) < 1e-5)).toBe(true);
    });

    describe('single_image_to_3dgs', () => {
        const saved: Record<string, string | undefined> = {};
        const keys = ['SCRATCHBOX_DEPTH_PYTHON', 'PYTHONPATH', 'STUB_DEPTH_METERS'];
        beforeAll(() => { for (const k of keys) saved[k] = process.env[k]; });
        afterAll(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

        it('lifts every pixel to the model\'s depth: a 4 m planar depth puts every splat on the z = -4 plane', async () => {
            Object.assign(process.env, { SCRATCHBOX_DEPTH_PYTHON: PYTHON, PYTHONPATH: STUBS, STUB_DEPTH_METERS: '4' });
            const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const outDir = path.join(work, 'splats');
            const res = await spatialHandlers.single_image_to_3dgs({ inputImagePath: photo, fovDegrees: 60, stride: 1, outDir }, { workspaceRoot: work });
            const payload = res.resultPayload as any;
            expect(payload.depthModel).toBe(DEPTH_MODEL);
            expect(payload.fovAssumed).toBe(false);
            expect(res.summaryResult).toContain(DEPTH_MODEL);
            const splats = SplatService.parseSplatBuffer(await fs.readFile(payload.splatPath));
            expect(splats.length).toBe(48 * 36);
            for (const s of splats) expect(s.position[2]).toBeCloseTo(-4, 3);
            // The image corners spread out by the pinhole rays: x at the left edge ~ -tan(30 deg) * 4 * 48/36.
            const xs = splats.map(s => s.position[0]);
            expect(Math.min(...xs)).toBeCloseTo(-4 * Math.tan(Math.PI / 6) * (48 / 36), 1);
        });

        it('says when the field of view was assumed', async () => {
            Object.assign(process.env, { SCRATCHBOX_DEPTH_PYTHON: PYTHON, PYTHONPATH: STUBS, STUB_DEPTH_METERS: '4' });
            const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const res = await spatialHandlers.single_image_to_3dgs({ inputImagePath: photo, stride: 4, outDir: path.join(work, 'splats-fov') }, { workspaceRoot: work });
            expect((res.resultPayload as any).fovAssumed).toBe(true);
            expect(res.summaryResult).toMatch(/assumed vertical FOV of 65/);
        });

        it('fails, writing no splats, when the depth model cannot run (no depth is guessed from the pixels)', async () => {
            Object.assign(process.env, { SCRATCHBOX_DEPTH_PYTHON: PYTHON, PYTHONPATH: STUBS });
            delete process.env.STUB_DEPTH_METERS;
            const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const outDir = path.join(work, 'splats-none');
            await expect(spatialHandlers.single_image_to_3dgs({ inputImagePath: photo, stride: 2, outDir }, { workspaceRoot: work }))
                .rejects.toBeInstanceOf(GeneratorFailedError);
            expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
        });
    });
});

describe('PanoramaDepthService refuses incomplete sidecar output', () => {
    it('metadata that omits the measurements fails instead of reporting zeros and default heights', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-depth-partial-'));
        try {
            // A sidecar that writes a depth file, a preview and only some of the metadata (stdlib only).
            const fake = path.join(work, 'fake_sidecar.py');
            fs.writeFileSync(fake, [
                'import json, sys',
                'a = dict(zip(sys.argv[1::2], sys.argv[2::2]))',
                'open(a["--output-depth"], "wb").write(bytes(4 * 4 * 2))',
                'open(a["--output-preview"], "wb").write(b"png")',
                'json.dump({"width": 4, "height": 2, "modelUsed": "m", "eyeHeight": 2.4}, open(a["--output-json"], "w"))'
            ].join('\n'));
            const img = path.join(work, 'pano.png');
            fs.writeFileSync(img, 'x');
            const service = new PanoramaDepthService(fake, { pythonExecutable: 'python3' });
            await expect(service.generatePanoramaDepth(img, { outDir: path.join(work, 'out'), eyeHeight: 2.4 }))
                .rejects.toThrow(/does not report minDepth, maxDepth, averageDepth, groundY, scaleCorrection, floorFitApplied/);
        } finally {
            await fs.remove(work);
        }
    });
});
