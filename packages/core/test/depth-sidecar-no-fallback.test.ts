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
 * synthetic room, no invented fill, no default eye height. The model (Depth Anything V2 Small) predicts relative
 * disparity, so a panorama needs the eye height for its metric scale and a photo is relative unless a median depth is
 * given. The real sidecar script runs here under a Python with torch and numpy; test/helpers/depth-sidecar-stubs
 * stands in for Pillow and for transformers (a constant disparity when STUB_DISPARITY is set, a missing module
 * otherwise), so no model weights are downloaded.
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
const DEPTH_MODEL_ID = 'depth-anything/Depth-Anything-V2-Small-hf';

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

/** Environment for the sidecar: the stubs on PYTHONPATH, and the stub depth model only when `disparity` is set. */
function sidecarEnv(disparity?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: STUBS };
    delete env.STUB_DISPARITY;
    if (disparity !== undefined) env.STUB_DISPARITY = String(disparity);
    return env;
}

function runSidecar(args: string[], env: NodeJS.ProcessEnv, out: string) {
    return spawnSync(PYTHON, [SIDECAR, '--output-depth', `${out}.depth.f32`, '--output-preview', `${out}.png`,
        '--output-json', `${out}.json`, '--device', 'cpu', ...args], { env, encoding: 'utf8' });
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
        const run = runSidecar(['--input', pano, '--eye-height', '1.7'], sidecarEnv(), out);
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain(`the depth model ${DEPTH_MODEL_ID} could not be loaded`);
        expect(`${run.stdout}${run.stderr}`).not.toMatch(/synthetic|fallback/i);
        expect(fs.existsSync(`${out}.json`)).toBe(false);
        expect(fs.existsSync(`${out}.depth.f32`)).toBe(false);
    });

    it('the sidecar refuses a panorama without an eye height: relative depth cannot measure one', () => {
        for (const extra of [[], ['--eye-height', 'auto']]) {
            const out = path.join(work, `noeye${extra.length}`);
            const run = runSidecar(['--input', pano, ...extra], sidecarEnv(0.25), out);
            expect(run.status).toBe(2);
            expect(run.stderr).toContain('--eye-height is required');
            expect(fs.existsSync(`${out}.json`)).toBe(false);
        }
    });

    it('PanoramaDepthService fails with the sidecar\'s error when the depth model cannot load', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv() });
        const run = service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-fail'), device: 'cpu', eyeHeight: 1.7 });
        await expect(run).rejects.toBeInstanceOf(GeneratorFailedError);
        await expect(service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-fail'), device: 'cpu', eyeHeight: 1.7 })).rejects.toThrow(/could not be loaded/);
        expect(fs.readdirSync(path.join(work, 'svc-fail')).filter(f => f.endsWith('.json'))).toEqual([]);
    });

    it('PanoramaDepthService refuses a call without the eye height before running the model', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(0.25) });
        await expect(service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-noeye'), device: 'cpu' } as any))
            .rejects.toThrow(/eye height in metres is required/);
    });

    it('fits the floor to the given eye height, which makes the relative depth metric', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(0.25) });
        const res = await service.generatePanoramaDepth(pano, { outDir: path.join(work, 'svc-ok'), device: 'cpu', eyeHeight: 1.7 });
        expect(res.modelUsed).toContain(DEPTH_MODEL_ID);
        expect(res.modelUsed).toContain('Apache-2.0');
        expect(res.floorFitApplied).toBe(true);
        expect(res.eyeHeightInferred).toBe(false);
        expect(res.eyeHeight).toBe(1.7);
        expect(res.groundY).toBeCloseTo(-1.7, 6);
        expect(res.farPlanePixels).toBe(0);
        const meta = await fs.readJson(res.metadataPath);
        expect(meta.depthUnits).toBe('metres');
        expect(meta.modelLicense).toBe('Apache-2.0');
        const depth = new Float32Array((await fs.readFile(res.depthPath)).buffer.slice(0));
        expect(depth.length).toBe(64 * 32);
        // The floor band (rows 80-95%, central half) sits 1.7 m below the camera after the fit: median drop = 1.7.
        const drops: number[] = [];
        for (let y = Math.floor(0.8 * 32); y < Math.floor(0.95 * 32); y++) {
            const ry = Math.sin((0.5 - (y + 0.5) / 32) * Math.PI);
            if (ry >= -0.05) continue;
            for (let x = 16; x < 48; x++) drops.push(-ry * depth[y * 64 + x]);
        }
        drops.sort((a, b) => a - b);
        expect(drops[Math.floor(drops.length / 2)]).toBeCloseTo(1.7, 1);
        expect(Math.min(...depth)).toBeCloseTo(res.minDepth, 4);
    });

    it('fails rather than invent a scale when the floor cannot be measured', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(0.25) });
        await expect(service.generatePanoramaDepth(tinyPano, { outDir: path.join(work, 'svc-tiny'), device: 'cpu', eyeHeight: 1.7 }))
            .rejects.toThrow(/floor cannot be measured/);
    });

    it('perspective photos get relative planar depth (median 1) at the photo\'s own size, or metres from a given median', async () => {
        const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: PYTHON, env: sidecarEnv(0.4) });
        const rel = await service.generateImageDepth(photo, { outDir: path.join(work, 'svc-photo'), device: 'cpu' });
        expect([rel.width, rel.height]).toEqual([48, 36]);
        expect(rel.depthKind).toBe('planar-z');
        expect(rel.depthUnits).toBe('relative');
        expect(rel.modelUsed).toContain(DEPTH_MODEL_ID);
        expect(rel.depths.length).toBe(48 * 36);
        expect(Array.from(rel.depths).every(d => Math.abs(d - 1) < 1e-5)).toBe(true);
        const metric = await service.generateImageDepth(photo, { outDir: path.join(work, 'svc-photo-m'), device: 'cpu', medianDepthMeters: 2.5 });
        expect(metric.depthUnits).toBe('metres');
        expect(Array.from(metric.depths).every(d => Math.abs(d - 2.5) < 1e-5)).toBe(true);
    });

    describe('single_image_to_3dgs', () => {
        const saved: Record<string, string | undefined> = {};
        const keys = ['SCRATCHBOX_DEPTH_PYTHON', 'PYTHONPATH', 'STUB_DISPARITY'];
        beforeAll(() => { for (const k of keys) saved[k] = process.env[k]; });
        afterAll(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

        it('lifts every pixel to the model\'s depth: a 4 m median depth puts every splat on the z = -4 plane', async () => {
            Object.assign(process.env, { SCRATCHBOX_DEPTH_PYTHON: PYTHON, PYTHONPATH: STUBS, STUB_DISPARITY: '0.25' });
            const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const outDir = path.join(work, 'splats');
            const res = await spatialHandlers.single_image_to_3dgs({ inputImagePath: photo, fovDegrees: 60, stride: 1, outDir, medianDepthMeters: 4 }, { workspaceRoot: work });
            const payload = res.resultPayload as any;
            expect(payload.depthModel).toContain(DEPTH_MODEL_ID);
            expect(payload.depthUnits).toBe('metres');
            expect(payload.fovAssumed).toBe(false);
            expect(res.summaryResult).toContain(DEPTH_MODEL_ID);
            const splats = SplatService.parseSplatBuffer(await fs.readFile(payload.splatPath));
            expect(splats.length).toBe(48 * 36);
            for (const s of splats) expect(s.position[2]).toBeCloseTo(-4, 3);
            // The image corners spread out by the pinhole rays: x at the left edge ~ -tan(30 deg) * 4 * 48/36.
            const xs = splats.map(s => s.position[0]);
            expect(Math.min(...xs)).toBeCloseTo(-4 * Math.tan(Math.PI / 6) * (48 / 36), 1);
        });

        it('says when the field of view was assumed and when the depth is relative', async () => {
            Object.assign(process.env, { SCRATCHBOX_DEPTH_PYTHON: PYTHON, PYTHONPATH: STUBS, STUB_DISPARITY: '0.25' });
            const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
            const res = await spatialHandlers.single_image_to_3dgs({ inputImagePath: photo, stride: 4, outDir: path.join(work, 'splats-fov') }, { workspaceRoot: work });
            expect((res.resultPayload as any).fovAssumed).toBe(true);
            expect((res.resultPayload as any).depthUnits).toBe('relative');
            expect(res.summaryResult).toMatch(/assumed vertical FOV of 65/);
            expect(res.summaryResult).toMatch(/relative units, median 1/);
        });

        it('fails, writing no splats, when the depth model cannot run (no depth is guessed from the pixels)', async () => {
            Object.assign(process.env, { SCRATCHBOX_DEPTH_PYTHON: PYTHON, PYTHONPATH: STUBS });
            delete process.env.STUB_DISPARITY;
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
                '# The sidecar runs in a persistent worker, which calls main() per request.',
                'def main():',
                '    a = dict(zip(sys.argv[1::2], sys.argv[2::2]))',
                '    open(a["--output-depth"], "wb").write(bytes(4 * 4 * 2))',
                '    open(a["--output-preview"], "wb").write(b"png")',
                '    json.dump({"width": 4, "height": 2, "modelUsed": "m", "eyeHeight": 2.4}, open(a["--output-json"], "w"))'
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
