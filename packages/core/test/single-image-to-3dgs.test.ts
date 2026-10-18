/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { spatialHandlers } from '../src/node/gemini/tools/spatial-tools';
import { encodePng } from '../src/node/texture-processing';
import { requirePythonModules, withReason } from './helpers/requirements';

// Depth comes from the depth sidecar (Depth Anything V2 Metric). Here it runs under a Python with torch and numpy,
// with test/helpers/depth-sidecar-stubs standing in for Pillow and for the model (a constant planar depth).
const PYTHON = process.env.SCRATCHBOX_PYTHON || 'python3';
const torchPython = requirePythonModules(PYTHON, ['torch', 'numpy']);
const STUB_ENV: Record<string, string> = {
    SCRATCHBOX_DEPTH_PYTHON: PYTHON,
    PYTHONPATH: path.join(__dirname, 'helpers/depth-sidecar-stubs'),
    STUB_DISPARITY: '0.5'
};

/**
 * Writes a small photo-like PNG (sky gradient over textured ground with a lit block) as the input.
 * The tool only needs some RGB image; this used to read a machine-specific render under ~/.gemini.
 */
function writeFixtureImage(file: string, width = 320, height = 240): void {
    const rgba = Buffer.alloc(width * height * 4);
    const horizon = Math.round(height * 0.45);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            let r: number, g: number, b: number;
            if (y < horizon) {
                const t = y / horizon;
                r = 110 + 60 * t; g = 150 + 50 * t; b = 225 - 10 * t;
            } else {
                const t = (y - horizon) / (height - horizon);
                const grain = ((x * 37 + y * 91) % 23) - 11;
                r = 95 + 60 * t + grain; g = 90 + 45 * t + grain; b = 80 + 30 * t + grain;
            }
            if (x > width * 0.3 && x < width * 0.6 && y > height * 0.2 && y < horizon + 20) {
                const shade = x < width * 0.45 ? 1.0 : 0.7;
                r = 200 * shade; g = 185 * shade; b = 160 * shade;
            }
            rgba[i] = Math.max(0, Math.min(255, Math.round(r)));
            rgba[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
            rgba[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
            rgba[i + 3] = 255;
        }
    }
    fs.outputFileSync(file, encodePng(width, height, rgba));
}

describe.skipIf(!torchPython.ok)(withReason('Single Image to 3DGS Pipeline Tool', torchPython), () => {
    let workDir = '';
    let testImgPath = '';
    let testOutDir = '';
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(() => {
        for (const [k, v] of Object.entries(STUB_ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-single-image-3dgs-'));
        testImgPath = path.join(workDir, 'input', 'scene_2_photorealistic_final.png');
        testOutDir = path.join(workDir, 'temp_test_splats');
        writeFixtureImage(testImgPath);
    });

    afterAll(async () => {
        for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        await fs.remove(workDir);
    });

    it('converts a single 2D image into valid .splat and .spz files', async () => {
        expect(await fs.pathExists(testImgPath)).toBe(true);

        const res = await spatialHandlers.single_image_to_3dgs({
            inputImagePath: testImgPath,
            fovDegrees: 65,
            stride: 4, // Fast stride for test
            outDir: testOutDir
        }, { workspaceRoot: process.cwd() });

        expect(res).toBeDefined();
        const payload = res.resultPayload as any;
        expect(payload.success).toBe(true);
        expect(payload.splatCount).toBeGreaterThan(1000);
        expect(payload.splatPath).toBeDefined();
        expect(payload.spzPath).toBeDefined();
        expect(payload.splatUrl).toBeDefined();

        expect(await fs.pathExists(payload.splatPath)).toBe(true);
        expect(await fs.pathExists(payload.spzPath)).toBe(true);

        // Standard 32-byte splat format check
        const splatStat = await fs.stat(payload.splatPath);
        expect(splatStat.size).toBe(payload.splatCount * 32);

        // SPZ is compressed and must be smaller than raw .splat
        const spzStat = await fs.stat(payload.spzPath);
        expect(spzStat.size).toBeLessThan(splatStat.size);

        // Cleanup
        await fs.remove(testOutDir);
    });

    it('generates production splat into public/splats for Scene3DPrimitive consumption', async () => {
        // No outDir: exercise the tool's default placement (<workspaceRoot>/public/splats), with a
        // temp workspace root so the test never writes into the repository's public/ folder.
        const workspaceRoot = path.join(workDir, 'workspace');
        const publicSplatsDir = path.join(workspaceRoot, 'public', 'splats');

        const res = await spatialHandlers.single_image_to_3dgs({
            inputImagePath: testImgPath,
            fovDegrees: 65,
            stride: 2 // 2x subsampled high-density splats
        }, { workspaceRoot });

        expect(res).toBeDefined();
        const payload = res.resultPayload as any;
        expect(payload.success).toBe(true);
        expect(payload.splatPath).toBe(path.join(publicSplatsDir, 'scene_2_photorealistic_final.splat'));
        expect(payload.spzPath).toBe(path.join(publicSplatsDir, 'scene_2_photorealistic_final.spz'));
        expect(payload.splatUrl).toBe('/splats/scene_2_photorealistic_final.splat');
        expect(payload.spzUrl).toBe('/splats/scene_2_photorealistic_final.spz');

        const splatStat = await fs.stat(payload.splatPath);
        const spzStat = await fs.stat(payload.spzPath);
        console.log(`[Production Splat Generated] Splat Count: ${payload.splatCount.toLocaleString()}, .splat size: ${(splatStat.size / 1024 / 1024).toFixed(2)} MB, .spz size: ${(spzStat.size / 1024 / 1024).toFixed(2)} MB`);
    });
});
