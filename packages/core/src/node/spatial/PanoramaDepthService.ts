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

const execAsync = promisify(exec);

export interface PanoramaDepthOptions {
    sceneType?: 'indoor' | 'outdoor';
    /** Metres, or 'auto' (default) to infer the capture height from the metric floor. */
    eyeHeight?: number | 'auto';
    device?: string;
    mock?: boolean;
    outDir?: string;
    /** Use the synthetic cylinder-room depth when the depth model cannot run (off by default). */
    allowHeuristicFallback?: boolean;
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
 * Spawns the local Python sidecar utilizing Depth Anything V2/V3 Metric models,
 * with robust fallbacks and ComfyUI Cloud Run L4 Tier 2 routing capability.
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
                    modelUsed: metaContent.modelUsed || 'unknown'
                };
            } else {
                throw new Error('Sidecar completed but output JSON was not found');
            }

        } catch (err: any) {
            if (!options.allowHeuristicFallback) {
                throw new Error(`Panorama depth model failed (${err.message}); set allowHeuristicFallback to accept the synthetic room depth instead.`);
            }
            return this.generateFallbackDepth(inputImagePath, outDepth, outPreview, outJson, eyeHeight);
        }
    }

    /**
     * Local TypeScript fallback that generates a valid synthetic circular room depth field
     * so that the pipeline never crashes during offline/testing scenarios.
     */
    private async generateFallbackDepth(
        inputImagePath: string,
        outDepth: string,
        outPreview: string,
        outJson: string,
        eyeHeight: number
    ): Promise<PanoramaDepthResult> {
        // Assume default panorama size 2048x1024 if we can't inspect the file quickly
        let width = 2048;
        let height = 1024;

        try {
            // Try to extract dimensions if sharp or other utilities are available,
            // otherwise keep 2048x1024 as robust baseline.
            const size = await this.imageSizeFallback(inputImagePath);
            width = size.width;
            height = size.height;
        } catch {
            // Keep default
        }

        const sizeInFloats = width * height;
        const depthBuffer = new Float32Array(sizeInFloats);

        // Simple mathematical fallback: Ground plane + Cylindrical wall at R = 15m + ceiling
        for (let y = 0; y < height; y++) {
            const v = (y + 0.5) / height;
            const pitch = (0.5 - v) * Math.PI;
            const ry = Math.sin(pitch);
            const cosPitch = Math.cos(pitch);

            let d: number;
            if (ry < -0.05) {
                // Floor
                d = -eyeHeight / ry;
            } else if (ry > 0.4) {
                // Ceiling (10m high)
                d = (10.0 - eyeHeight) / ry;
            } else {
                // Wall
                d = 15.0 / cosPitch;
            }

            d = Math.max(0.1, Math.min(80.0, d));

            for (let x = 0; x < width; x++) {
                depthBuffer[y * width + x] = d;
            }
        }

        // Write depth binary file
        await fs.outputFile(outDepth, Buffer.from(depthBuffer.buffer));

        // Write mock colormapped PNG (transparent pixel mock or flat color)
        // Standard PNG 1x1 blank or flat purple to satisfy preview file requirement
        const dummyPng = Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc`\x00\x00\x00\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82', 'binary');
        await fs.outputFile(outPreview, dummyPng);

        // Write metadata JSON
        const metadata = {
            success: true,
            width,
            height,
            minDepth: 0.1,
            maxDepth: 80.0,
            averageDepth: 15.0,
            eyeHeight,
            eyeHeightInferred: false,
            groundY: -eyeHeight,
            scaleCorrection: 1.0,
            modelUsed: 'typescript-fallback-heuristic'
        };
        await fs.outputJson(outJson, metadata, { spaces: 2 });

        return {
            success: true,
            depthPath: outDepth,
            previewPath: outPreview,
            metadataPath: outJson,
            width,
            height,
            minDepth: 0.1,
            maxDepth: 80.0,
            averageDepth: 15.0,
            eyeHeight,
            groundY: -eyeHeight,
            scaleCorrection: 1.0,
            eyeHeightInferred: false,
            modelUsed: 'typescript-fallback-heuristic'
        };
    }

    private async imageSizeFallback(imagePath: string): Promise<{ width: number, height: number }> {
        // Fast binary signature inspection for PNG/JPEG dimensions without heavy library dependencies
        const fd = await fs.open(imagePath, 'r');
        const buffer = Buffer.alloc(30);
        await fs.read(fd, buffer, 0, 30, 0);
        await fs.close(fd);

        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
            // PNG dimensions at offset 16 (IHDR)
            const width = buffer.readUInt32BE(16);
            const height = buffer.readUInt32BE(20);
            return { width, height };
        } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
            // JPEG parser (simplified find SOF0/SOF2 marker)
            const stat = await fs.stat(imagePath);
            const fullBuf = await fs.readFile(imagePath);
            let offset = 2;
            while (offset < fullBuf.length) {
                if (fullBuf[offset] === 0xff && (fullBuf[offset+1] === 0xc0 || fullBuf[offset+1] === 0xc2)) {
                    const height = fullBuf.readUInt16BE(offset + 5);
                    const width = fullBuf.readUInt16BE(offset + 7);
                    return { width, height };
                }
                offset++;
            }
        }
        return { width: 2048, height: 1024 }; // Robust generic fallback
    }
}
