/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The real depth model (Depth Anything V2 Small, Apache-2.0, local weights) on real imagery in the repo: a Street View
 * panorama made metric by the floor fit, a photo in relative units, and DepthBox's depth-ray prediction on a decoded
 * photo. Runs only when the .venv carries torch + transformers and the weights are in the model cache
 * (`.venv/bin/python tools/depth/fetch_depth_model.py`). The depth previews are written to
 * test-results/screenshots/ for inspection.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';
import { DepthBoxInferenceService } from '../src/node/3d-engine/depthbox-inference-service';
import { shutdownAllPythonWorkerPools } from '../src/node/process/persistent-python-worker';
import { decodeImageToRgba } from '../src/node/image-codec-ffmpeg';
import { REPO_ROOT, requireFile, requirePythonModules, withReason } from './helpers/requirements';

const VENV_PYTHON = path.join(REPO_ROOT, '.venv/bin/python');
const SIDECAR = path.join(REPO_ROOT, 'tools/depth/panorama_depth.py');
const PANO = path.join(REPO_ROOT, 'public/panoramas/streetview_colosseum_rome_4k.png');
const PHOTO = path.join(REPO_ROOT, 'public/images/ref_video_samples/ref_t0.jpg');
const SHOTS = path.join(REPO_ROOT, 'test-results/screenshots');

const python = requirePythonModules(VENV_PYTHON, ['torch', 'transformers', 'PIL']);
const weights = requireFile('.model-cache/huggingface/models--depth-anything--Depth-Anything-V2-Small-hf',
    'model weights; download them with `.venv/bin/python tools/depth/fetch_depth_model.py`');
const images = requireFile(PANO);
const ready = python.ok && weights.ok && images.ok;
const reason = !python.ok ? python : !weights.ok ? weights : images;

describe.skipIf(!ready)(withReason('Depth Anything V2 Small on real imagery', reason), () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-da2-real-'));
    const service = new PanoramaDepthService(SIDECAR, { pythonExecutable: VENV_PYTHON, timeoutMs: 300_000 });
    afterAll(async () => {
        shutdownAllPythonWorkerPools();
        await fs.remove(work);
    });

    it('a Street View panorama: metric radial depth with the floor at the given eye height', async () => {
        const res = await service.generatePanoramaDepth(PANO, { eyeHeight: 2.5, outDir: work });
        expect(res.modelUsed).toMatch(/Depth-Anything-V2-Small-hf@5426e4f0 \(Apache-2\.0\)/);
        expect(res.floorFitApplied).toBe(true);
        expect(res.eyeHeight).toBe(2.5);
        // Real structure: something within a few metres, the far plane (sky) well beyond, and a real spread between.
        expect(res.minDepth).toBeGreaterThan(0.3);
        expect(res.minDepth).toBeLessThan(5);
        expect(res.maxDepth).toBeGreaterThan(50);
        expect(res.farPlanePixels).toBeGreaterThan(0);
        expect(res.farPlanePixels).toBeLessThan(res.width * res.height * 0.6);
        await fs.ensureDir(SHOTS);
        await fs.copy(res.previewPath, path.join(SHOTS, 'depth_anything_small_colosseum_panorama.png'));
    }, 300_000);

    it('a photo: relative planar depth, median 1, with near and far parts of the scene apart', async () => {
        const res = await service.generateImageDepth(PHOTO, { outDir: work });
        expect(res.depthUnits).toBe('relative');
        const sorted = Float32Array.from(res.depths).sort();
        expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(0.9);
        expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(1.1);
        expect(sorted[Math.floor(sorted.length * 0.95)] / sorted[Math.floor(sorted.length * 0.05)]).toBeGreaterThan(1.3);
        await fs.copy(res.previewPath, path.join(SHOTS, 'depth_anything_small_photo.png'));
    }, 300_000);

    it('DepthBox predicts depth and rays for decoded pixels through the model, in metres when a median is given', async () => {
        const decoded = await decodeImageToRgba(await fs.readFile(PHOTO));
        const depthbox = new DepthBoxInferenceService({ fovDegrees: 60 }, service);
        const res = await depthbox.predictDepthAndRays(decoded.rgba, decoded.width, decoded.height, { stride: 16, channels: 4, medianDepthMeters: 30 });
        expect(res.modelUsed).toContain('Depth-Anything-V2-Small-hf');
        expect(res.depthUnits).toBe('metres');
        expect(res.metricDepths.length).toBe(decoded.width * decoded.height);
        expect(res.maxDepth).toBeGreaterThan(res.minDepth * 1.3);
        // P = d * r: every point lies at its depth along its unit ray.
        for (const p of res.pointCloud.slice(0, 50)) expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(p.depth, 3);
    }, 300_000);
});
