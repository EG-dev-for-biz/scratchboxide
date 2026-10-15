/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GeneratorFailedError } from '../../common/errors/pipeline-errors';

const execFileAsync = promisify(execFile);

export interface PanoramaDepthOptions {
    sceneType?: 'indoor' | 'outdoor';
    /** Metres, or 'auto' (default) to measure the capture height from the metric floor. */
    eyeHeight?: number | 'auto';
    device?: string;
    /** Tests only: the sidecar's --mock room geometry at the given eyeHeight (modelUsed says so), not model depth. */
    mock?: boolean;
    outDir?: string;
}

export interface PanoramaDepthResult {
    success: boolean;
    depthPath: string;     // Absolute path to the *.depth.f32 binary file
    previewPath: string;   // Path to the colormapped PNG preview
    metadataPath: string;  // Path to the JSON metadata
    width: number;
    height: number;
    minDepth: number;
    maxDepth: number;
    averageDepth: number;
    eyeHeight: number;
    groundY: number;
    /** Factor the depth was rescaled by to put the floor at the given eye height (1 when it was not rescaled). */
    scaleCorrection: number;
    /** True when the floor fit ran (it measures eyeHeight in auto mode, or rescales depth to a given eyeHeight). */
    floorFitApplied: boolean;
    /** True when eyeHeight was measured from the metric floor rather than supplied. */
    eyeHeightInferred: boolean;
    modelUsed: string;
}

/** Planar (z) metric depth for an ordinary perspective photo, from the same depth model. */
export interface ImageDepthResult {
    depthPath: string;
    previewPath: string;
    metadataPath: string;
    width: number;
    height: number;
    /** Depth along the camera axis (z), not along each pixel's ray. */
    depthKind: 'planar-z';
    /** Row-major width x height metres. */
    depths: Float32Array;
    minDepth: number;
    maxDepth: number;
    averageDepth: number;
    modelUsed: string;
}

export interface PanoramaDepthServiceOptions {
    /** Python interpreter with torch, numpy, PIL and transformers (default: SCRATCHBOX_DEPTH_PYTHON, else `python3` on PATH). */
    pythonExecutable?: string;
    /** Environment for the sidecar (default: this process's environment). */
    env?: NodeJS.ProcessEnv;
}

/**
 * Runs the local depth sidecar (tools/depth/panorama_depth.py, Depth Anything V2 Metric). When the model cannot run,
 * the sidecar exits non-zero and the call fails with its error (GeneratorFailedError); no depth is invented in its
 * place, and every reported figure comes from the sidecar's own measurement.
 */
export class PanoramaDepthService {
    private sidecarPath: string;
    private pythonExecutable: string;
    private env?: NodeJS.ProcessEnv;

    constructor(customSidecarPath?: string, options: PanoramaDepthServiceOptions = {}) {
        this.sidecarPath = customSidecarPath || path.resolve(process.cwd(), 'tools/depth/panorama_depth.py');
        this.pythonExecutable = options.pythonExecutable || process.env.SCRATCHBOX_DEPTH_PYTHON || 'python3';
        this.env = options.env;
    }

    /** Runs the sidecar and returns its metadata JSON, checking that it reports every key in `required`. */
    private async runSidecar(inputImagePath: string, outDir: string, extraArgs: string[], required: string[]): Promise<{
        meta: Record<string, any>; depthPath: string; previewPath: string; metadataPath: string;
    }> {
        await fs.ensureDir(outDir);
        const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const baseName = path.basename(inputImagePath, path.extname(inputImagePath));
        const depthPath = path.join(outDir, `${baseName}_${stamp}.depth.f32`);
        const previewPath = path.join(outDir, `${baseName}_${stamp}_preview.png`);
        const metadataPath = path.join(outDir, `${baseName}_${stamp}_meta.json`);
        const args = [
            this.sidecarPath,
            '--input', inputImagePath,
            '--output-depth', depthPath,
            '--output-preview', previewPath,
            '--output-json', metadataPath,
            ...extraArgs
        ];
        try {
            const { stdout, stderr } = await execFileAsync(this.pythonExecutable, args, {
                cwd: process.cwd(),
                env: this.env,
                timeout: 120000,
                maxBuffer: 10 * 1024 * 1024
            });
            console.log(`[PanoramaDepthService] Sidecar stdout:\n${stdout}`);
            if (stderr) console.warn(`[PanoramaDepthService] Sidecar stderr:\n${stderr}`);
        } catch (err: any) {
            const detail = String(err?.stderr || '').trim() || err?.message || String(err);
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: ${detail}`);
        }
        if (!(await fs.pathExists(metadataPath))) {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: the sidecar wrote no metadata (${metadataPath})`);
        }
        const meta = await fs.readJson(metadataPath);
        const missing = required.filter(key => meta[key] === undefined || meta[key] === null || meta[key] === ''
            || (typeof meta[key] === 'number' && !Number.isFinite(meta[key])));
        if (missing.length) {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: the sidecar's metadata ${metadataPath} does not report ${missing.join(', ')}`);
        }
        const expectedBytes = Number(meta.width) * Number(meta.height) * 4;
        const depthBytes = (await fs.pathExists(depthPath)) ? (await fs.stat(depthPath)).size : -1;
        if (depthBytes !== expectedBytes) {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: the depth file ${depthPath} has ${depthBytes} bytes, not ${expectedBytes} for ${meta.width}x${meta.height}`);
        }
        if (!(await fs.pathExists(previewPath))) {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: the sidecar wrote no preview (${previewPath})`);
        }
        return { meta, depthPath, previewPath, metadataPath };
    }

    /**
     * Metric radial depth for a 360 equirectangular panorama. Throws GeneratorFailedError when the depth model
     * cannot run or its output is incomplete.
     */
    public async generatePanoramaDepth(
        inputImagePath: string,
        options: PanoramaDepthOptions = {}
    ): Promise<PanoramaDepthResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/depth_output');
        const eyeHeightArg: number | 'auto' = options.eyeHeight ?? 'auto';
        const extraArgs = [
            '--projection', 'equirect',
            '--scene-type', options.sceneType || 'outdoor',
            '--eye-height', String(eyeHeightArg),
            '--device', options.device || 'auto',
            ...(options.mock ? ['--mock'] : [])
        ];
        const { meta, depthPath, previewPath, metadataPath } = await this.runSidecar(inputImagePath, outDir, extraArgs, [
            'width', 'height', 'modelUsed', 'minDepth', 'maxDepth', 'averageDepth', 'eyeHeight', 'groundY', 'scaleCorrection', 'floorFitApplied'
        ]);
        return {
            success: true,
            depthPath,
            previewPath,
            metadataPath,
            width: meta.width,
            height: meta.height,
            minDepth: meta.minDepth,
            maxDepth: meta.maxDepth,
            averageDepth: meta.averageDepth,
            eyeHeight: meta.eyeHeight,
            groundY: meta.groundY,
            scaleCorrection: meta.scaleCorrection,
            floorFitApplied: meta.floorFitApplied === true,
            eyeHeightInferred: meta.eyeHeightInferred === true,
            modelUsed: meta.modelUsed
        };
    }

    /**
     * Planar metric depth for an ordinary (perspective) photo at the photo's own size. Throws GeneratorFailedError
     * when the depth model cannot run or its output is incomplete.
     */
    public async generateImageDepth(
        inputImagePath: string,
        options: { sceneType?: 'indoor' | 'outdoor'; device?: string; outDir?: string } = {}
    ): Promise<ImageDepthResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/depth_output');
        const { meta, depthPath, previewPath, metadataPath } = await this.runSidecar(inputImagePath, outDir, [
            '--projection', 'perspective',
            '--scene-type', options.sceneType || 'outdoor',
            '--device', options.device || 'auto'
        ], ['width', 'height', 'modelUsed', 'minDepth', 'maxDepth', 'averageDepth', 'depthKind']);
        if (meta.depthKind !== 'planar-z') {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: expected planar-z depth, the sidecar reported ${meta.depthKind}`);
        }
        const raw = await fs.readFile(depthPath);
        const depths = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
        return {
            depthPath,
            previewPath,
            metadataPath,
            width: meta.width,
            height: meta.height,
            depthKind: 'planar-z',
            depths,
            minDepth: meta.minDepth,
            maxDepth: meta.maxDepth,
            averageDepth: meta.averageDepth,
            modelUsed: meta.modelUsed
        };
    }
}
