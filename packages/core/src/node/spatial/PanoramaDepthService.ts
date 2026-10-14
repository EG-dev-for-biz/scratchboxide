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
import { exec } from 'child_process';
import { promisify } from 'util';
import { GeneratorFailedError } from '../../common/errors/pipeline-errors';

const execAsync = promisify(exec);

export interface PanoramaDepthOptions {
    sceneType?: 'indoor' | 'outdoor';
    /** Metres, or 'auto' (default) to infer the capture height from the metric floor. */
    eyeHeight?: number | 'auto';
    device?: string;
    /** Tests only: the sidecar's own --mock geometry (labelled in modelUsed), not depth from the model. */
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
    scaleCorrection: number;
    /** True when eyeHeight was inferred from the metric floor rather than supplied. */
    eyeHeightInferred: boolean;
    modelUsed: string;
}

/**
 * Service to orchestrate the high-fidelity 360 panorama depth extraction pipeline.
 * Spawns the local Python sidecar utilizing Depth Anything V2/V3 Metric models. When the model cannot run, the call
 * fails with the sidecar's error; no depth is invented in its place.
 */
export class PanoramaDepthService {
    private sidecarPath: string;

    constructor(customSidecarPath?: string) {
        if (customSidecarPath) {
            this.sidecarPath = customSidecarPath;
        } else {
            this.sidecarPath = path.resolve(process.cwd(), 'tools/depth/panorama_depth.py');
        }
    }

    /**
     * Executes the depth extraction pipeline on a 360 equirectangular panorama image.
     */
    public async generatePanoramaDepth(
        inputImagePath: string,
        options: PanoramaDepthOptions = {}
    ): Promise<PanoramaDepthResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/depth_output');
        await fs.ensureDir(outDir);

        const timestamp = Date.now();
        const baseName = path.basename(inputImagePath, path.extname(inputImagePath));
        
        const outDepth = path.join(outDir, `${baseName}_${timestamp}.depth.f32`);
        const outPreview = path.join(outDir, `${baseName}_${timestamp}_preview.png`);
        const outJson = path.join(outDir, `${baseName}_${timestamp}_meta.json`);

        const sceneType = options.sceneType || 'outdoor';
        const forceMock = options.mock ?? false;
        // Mock geometry is built at a fixed height; real depth infers it unless the caller knows it.
        const eyeHeightArg: number | 'auto' = options.eyeHeight ?? (forceMock ? 1.70 : 'auto');
        const eyeHeight = typeof eyeHeightArg === 'number' ? eyeHeightArg : 1.70;
        const device = options.device || 'auto';

        const args: string[] = [
            `--input "${inputImagePath}"`,
            `--output-depth "${outDepth}"`,
            `--output-preview "${outPreview}"`,
            `--output-json "${outJson}"`,
            `--scene-type ${sceneType}`,
            `--eye-height ${eyeHeightArg}`,
            `--device ${device}`
        ];

        if (forceMock) {
            args.push('--mock');
        }

        const cmd = `python3 "${this.sidecarPath}" ${args.join(' ')}`;

        try {
            console.log(`[PanoramaDepthService] Spawning sidecar: ${cmd}`);
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: process.cwd(),
                timeout: 120000, // 2 minutes timeout
                maxBuffer: 10 * 1024 * 1024
            });

            console.log(`[PanoramaDepthService] Sidecar stdout:\n${stdout}`);
            if (stderr) {
                console.warn(`[PanoramaDepthService] Sidecar stderr:\n${stderr}`);
            }

            // Read the generated JSON metadata
            if (await fs.pathExists(outJson)) {
                const metaContent = await fs.readJson(outJson);
                const missing = ['width', 'height', 'modelUsed', ...(eyeHeightArg === 'auto' ? ['eyeHeight'] : [])]
                    .filter(key => metaContent[key] === undefined || metaContent[key] === null || metaContent[key] === '');
                if (missing.length) {
                    throw new Error(`the sidecar's metadata ${outJson} does not report ${missing.join(', ')}`);
                }
                return {
                    success: true,
                    depthPath: outDepth,
                    previewPath: outPreview,
                    metadataPath: outJson,
                    width: metaContent.width ?? 0,
                    height: metaContent.height ?? 0,
                    minDepth: metaContent.minDepth ?? 0,
                    maxDepth: metaContent.maxDepth ?? 0,
                    averageDepth: metaContent.averageDepth ?? 0,
                    eyeHeight: metaContent.eyeHeight ?? eyeHeight,
                    groundY: metaContent.groundY ?? -eyeHeight,
                    scaleCorrection: metaContent.scaleCorrection ?? 1.0,
                    eyeHeightInferred: metaContent.eyeHeightInferred === true,
                    modelUsed: metaContent.modelUsed
                };
            } else {
                throw new Error('Sidecar completed but output JSON was not found');
            }

        } catch (err: any) {
            throw new GeneratorFailedError('python', `Panorama depth model failed for ${inputImagePath}: ${err?.message || err}`);
        }
    }
}
