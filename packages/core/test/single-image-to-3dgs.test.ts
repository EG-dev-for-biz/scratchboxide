/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { spatialHandlers } from '../src/node/gemini/tools/spatial-tools';

describe('Single Image to 3DGS Pipeline Tool', () => {
    const testImgPath = '/Users/eligreen/.gemini/antigravity/brain/7661fe23-d225-442c-9323-f94362db535b/scene_2_photorealistic_final.png';
    const testOutDir = path.join(process.cwd(), 'temp_test_splats');

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
        const publicSplatsDir = path.join(process.cwd(), 'public', 'splats');
        await fs.mkdirp(publicSplatsDir);

        const res = await spatialHandlers.single_image_to_3dgs({
            inputImagePath: testImgPath,
            fovDegrees: 65,
            stride: 2, // 2x subsampled high-density splats
            outDir: publicSplatsDir
        }, { workspaceRoot: process.cwd() });

        expect(res).toBeDefined();
        const payload = res.resultPayload as any;
        expect(payload.success).toBe(true);
        expect(payload.splatUrl).toBe('/splats/scene_2_photorealistic_final.splat');
        expect(payload.spzUrl).toBe('/splats/scene_2_photorealistic_final.spz');

        const splatStat = await fs.stat(payload.splatPath);
        const spzStat = await fs.stat(payload.spzPath);
        console.log(`[Production Splat Generated] Splat Count: ${payload.splatCount.toLocaleString()}, .splat size: ${(splatStat.size / 1024 / 1024).toFixed(2)} MB, .spz size: ${(spzStat.size / 1024 / 1024).toFixed(2)} MB`);
    });
});
