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
import { getPythonWorkerPool } from '../process/persistent-python-worker';
import * as os from 'os';
import { GeneratorFailedError, InvalidInputError } from '../../common/errors/pipeline-errors';
import { encodePng } from '../texture-processing';


export interface PanoramaDepthOptions {
    /**
     * The camera's height above the floor in metres. Required: the depth model predicts relative depth, and the floor
     * fit to this height is what makes the panorama's depth metric.
     */
    eyeHeight: number;
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
    /** Metres per model unit: the factor that puts the floor at the given eye height. */
    scaleCorrection: number;
    /** True when the floor fit set the metric scale (false only for the sidecar's --mock geometry). */
    floorFitApplied: boolean;
    /** Always false: the eye height is supplied, never measured (relative depth cannot measure it). */
    eyeHeightInferred: boolean;
    /** Pixels the model puts at its far plane (sky, or anything at infinity). */
    farPlanePixels: number;
    modelUsed: string;
}

/** 'metres' when a metric scale was given; 'relative' when the depth is scaled so the median non-far depth is 1. */
export type DepthUnits = 'metres' | 'relative';

/** Planar (z) metric depth for an ordinary perspective photo, from the same depth model. */
export interface ImageDepthResult {
    depthPath: string;
    previewPath: string;
    metadataPath: string;
    width: number;
    height: number;
    /** Depth along the camera axis (z), not along each pixel's ray. */
    depthKind: 'planar-z';
    depthUnits: DepthUnits;
    /** How the scale was set (the given median depth, or median = 1). */
    scaleSource: string;
    /** Row-major width x height depths in depthUnits. */
    depths: Float32Array;
    farPlanePixels: number;
    minDepth: number;
    maxDepth: number;
    averageDepth: number;
    modelUsed: string;
}

export interface PanoramaDepthServiceOptions {
    /** Python interpreter with torch, numpy, PIL and transformers (default: SCRATCHBOX_DEPTH_PYTHON, else the repo's .venv python when present, else `python3` on PATH). */
    pythonExecutable?: string;
    /** Environment for the sidecar (default: this process's environment). */
    env?: NodeJS.ProcessEnv;
    /** Time limit for one depth call, including the first call's model load (default 120 s). */
    timeoutMs?: number;
}

/** The repo's .venv interpreter when it exists (it carries torch and transformers), else `python3`. */
export function defaultDepthPython(): string {
    if (process.env.SCRATCHBOX_DEPTH_PYTHON) return process.env.SCRATCHBOX_DEPTH_PYTHON;
    const venv = path.resolve(process.cwd(), '.venv/bin/python');
    return fs.existsSync(venv) ? venv : 'python3';
}

/**
 * Runs the local depth sidecar (tools/depth/panorama_depth.py, Depth Anything V2 Small, Apache-2.0). The model predicts
 * relative depth: panoramas are made metric by a floor fit to the given eye height, photos are relative (median 1)
 * unless the caller gives the scene's median depth in metres. When the model cannot run,
 * the sidecar exits non-zero and the call fails with its error (GeneratorFailedError); no depth is invented in its
 * place, and every reported figure comes from the sidecar's own measurement.
 */
export class PanoramaDepthService {
    private sidecarPath: string;
    private pythonExecutable: string;
    private env?: NodeJS.ProcessEnv;
    private timeoutMs: number;

    constructor(customSidecarPath?: string, options: PanoramaDepthServiceOptions = {}) {
        this.sidecarPath = customSidecarPath || path.resolve(process.cwd(), 'tools/depth/panorama_depth.py');
        this.pythonExecutable = options.pythonExecutable || defaultDepthPython();
        this.env = options.env;
        this.timeoutMs = options.timeoutMs ?? 120_000;
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
        const argv = [
            '--input', inputImagePath,
            '--output-depth', depthPath,
            '--output-preview', previewPath,
            '--output-json', metadataPath,
            ...extraArgs
        ];
        // A persistent worker keeps the depth model loaded between calls (the first call pays the load).
        const pool = getPythonWorkerPool({
            pythonBinary: this.pythonExecutable,
            scriptPath: this.sidecarPath,
            label: 'the depth sidecar',
            cwd: process.cwd(),
            env: this.env
        });
        let res;
        try {
            res = await pool.run({ argv, timeoutMs: this.timeoutMs });
        } catch (err: any) {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: ${err?.message || String(err)}`);
        }
        if (res.stdout.trim()) console.log(`[PanoramaDepthService] Sidecar stdout:\n${res.stdout}`);
        if (res.exitCode !== 0) {
            const detail = res.stderr.trim() || `the sidecar exited with code ${res.exitCode}`;
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: ${detail}`);
        }
        if (res.stderr.trim()) console.warn(`[PanoramaDepthService] Sidecar stderr:\n${res.stderr}`);
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
        options: PanoramaDepthOptions
    ): Promise<PanoramaDepthResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/depth_output');
        if (!(typeof options.eyeHeight === 'number' && options.eyeHeight > 0)) {
            throw new GeneratorFailedError('python', `Depth model failed for ${inputImagePath}: the camera's eye height in metres is required (the depth model predicts relative depth; the floor fit to the eye height makes it metric)`);
        }
        const extraArgs = [
            '--projection', 'equirect',
            '--eye-height', String(options.eyeHeight),
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
            farPlanePixels: Number(meta.farPlanePixels) || 0,
            modelUsed: meta.modelUsed
        };
    }

    /**
     * Planar depth for an ordinary (perspective) photo at the photo's own size: relative (median 1) unless
     * `medianDepthMeters` gives the scene's median depth, which makes it metres. Throws GeneratorFailedError when the
     * depth model cannot run or its output is incomplete.
     */
    public async generateImageDepth(
        inputImagePath: string,
        options: { medianDepthMeters?: number; device?: string; outDir?: string } = {}
    ): Promise<ImageDepthResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/depth_output');
        const { meta, depthPath, previewPath, metadataPath } = await this.runSidecar(inputImagePath, outDir, [
            '--projection', 'perspective',
            ...(options.medianDepthMeters !== undefined ? ['--median-depth-m', String(options.medianDepthMeters)] : []),
            '--device', options.device || 'auto'
        ], ['width', 'height', 'modelUsed', 'minDepth', 'maxDepth', 'averageDepth', 'depthKind', 'depthUnits', 'scaleSource']);
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
            depthUnits: meta.depthUnits === 'metres' ? 'metres' : 'relative',
            scaleSource: String(meta.scaleSource),
            depths,
            farPlanePixels: Number(meta.farPlanePixels) || 0,
            minDepth: meta.minDepth,
            maxDepth: meta.maxDepth,
            averageDepth: meta.averageDepth,
            modelUsed: meta.modelUsed
        };
    }

    /**
     * Depth for an in-memory RGB or RGBA pixel buffer (a decoded photo or video frame): the buffer is written to a
     * temporary PNG, run through generateImageDepth, and the PNG removed. Returns the planar result plus the depth
     * along each pixel's pinhole ray for the given vertical field of view, which is what the splat lifters consume.
     */
    public async generatePixelBufferDepth(
        pixels: Uint8Array | Buffer,
        width: number,
        height: number,
        options: { channels?: number; fovDegrees: number; medianDepthMeters?: number; device?: string; outDir?: string }
    ): Promise<ImageDepthResult & { rayDepths: Float32Array }> {
        const channels = options.channels ?? 3;
        if (!(width > 0 && height > 0) || pixels.length < width * height * channels) {
            throw new InvalidInputError('generatePixelBufferDepth', 'pixels', `${pixels.length} bytes is not a ${width}x${height} image with ${channels} channels`);
        }
        const rgba = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            rgba[i * 4] = pixels[i * channels];
            rgba[i * 4 + 1] = pixels[i * channels + 1];
            rgba[i * 4 + 2] = pixels[i * channels + 2];
            rgba[i * 4 + 3] = 255;
        }
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-pixel-depth-'));
        const pngPath = path.join(tmpDir, 'frame.png');
        try {
            await fs.writeFile(pngPath, encodePng(width, height, rgba));
            const res = await this.generateImageDepth(pngPath, {
                medianDepthMeters: options.medianDepthMeters,
                device: options.device,
                outDir: options.outDir || tmpDir
            });
            const rayDepths = new Float32Array(width * height);
            const f = 0.5 * height / Math.tan(0.5 * options.fovDegrees * Math.PI / 180);
            const cx = width * 0.5, cy = height * 0.5;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    rayDepths[i] = res.depths[i] * Math.hypot((x - cx) / f, (y - cy) / f, 1);
                }
            }
            return { ...res, rayDepths };
        } finally {
            if (!options.outDir) await fs.remove(tmpDir);
            else await fs.remove(pngPath);
        }
    }
}
