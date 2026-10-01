/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { HeadlessMeshSilhouetteRenderer, RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { encodePng } from '../texture-processing';
import { createDefaultStationImageGenerator, StationImageGenerator } from './BeautifyStationService';
import { buildBlockoutNanoBananaPrompt } from '../../browser/generative-canvas/services/video/omniVideoPromptService';

export interface RenderPasses {
    width: number;
    height: number;
    clay: Buffer;
    depth: Float32Array;
    mist: Buffer; // PNG encoded depth
    normal: Buffer; // PNG encoded camera-space or world-space normals
}

export interface NativeAiRenderEngineServiceOptions {
    generator?: StationImageGenerator;
    workspaceRoot?: string;
}

export class NativeAiRenderEngineService {
    private generator: StationImageGenerator;
    private workspaceRoot: string;

    constructor(options?: NativeAiRenderEngineServiceOptions) {
        this.workspaceRoot = options?.workspaceRoot || process.cwd();
        this.generator = options?.generator || createDefaultStationImageGenerator({
            workspaceRoot: this.workspaceRoot,
            allowProceduralGenerator: true
        });
    }

    /**
     * Extracts multi-pass geometry buffers (clay shading, metric depth, PNG mist/normalized depth, normal pass)
     * directly from scene mesh geometry under a given 6-DOF camera pose.
     */
    public extractRenderPasses(
        mesh: RenderMesh3D,
        pose: CameraPose6DOF,
        width: number = 640,
        height: number = 480,
        options?: {
            clayColor?: [number, number, number];
            bgColor?: [number, number, number, number];
            lightDir?: [number, number, number];
        }
    ): RenderPasses {
        // 1. Extract clay pass and depth from software rasterizer
        const shadedResult = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, width, height, {
            clayColor: options?.clayColor,
            bgColor: options?.bgColor,
            lightDir: options?.lightDir,
            clipNearPlane: true
        });

        const { rgba: clayRgba, depthBuffer: depth } = shadedResult;

        // 2. Generate normalized Mist pass (depth map)
        const size = width * height;
        const mistRgba = Buffer.alloc(size * 4);

        let minDepth = Infinity;
        let maxDepth = -Infinity;

        // Find actual min/max depth excluding background/infinity (1e9)
        for (let i = 0; i < size; i++) {
            const d = depth[i];
            if (d < 1e8) {
                if (d < minDepth) minDepth = d;
                if (d > maxDepth) maxDepth = d;
            }
        }

        const depthRange = maxDepth - minDepth;

        for (let i = 0; i < size; i++) {
            const d = depth[i];
            let grayscale = 0; // default black background/infinity

            if (d < 1e8) {
                // Linear normalization: near is white (255), far is dark gray/black (0)
                const norm = depthRange > 1e-4 ? (d - minDepth) / depthRange : 0;
                grayscale = Math.round(255 * (1.0 - norm));
            }

            mistRgba[i * 4] = grayscale;
            mistRgba[i * 4 + 1] = grayscale;
            mistRgba[i * 4 + 2] = grayscale;
            mistRgba[i * 4 + 3] = 255;
        }

        const mistPng = encodePng(width, height, mistRgba);

        // 3. Generate Normal pass
        // Map vertex/face orientation to RGB. Since renderShadedMesh already does Lambertian dot product
        // based on normal and light, we can synthesize a high-contrast normal-colored shading pass by
        // rendering the same geometry with three orthogonal lighting directions as R, G, B channels!
        // This is a standard photometric normal mapping/shading technique.
        const normalRgba = Buffer.alloc(size * 4);
        
        // Render 3 passes with cardinal lighting to capture x, y, z normals in R, G, B
        const passX = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, width, height, {
            clayColor: [255, 0, 0],
            bgColor: [0, 0, 0, 255],
            lightDir: [1, 0, 0],
            clipNearPlane: true
        });
        const passY = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, width, height, {
            clayColor: [0, 255, 0],
            bgColor: [0, 0, 0, 255],
            lightDir: [0, 1, 0],
            clipNearPlane: true
        });
        const passZ = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, width, height, {
            clayColor: [0, 0, 255],
            bgColor: [0, 0, 0, 255],
            lightDir: [0, 0, 1],
            clipNearPlane: true
        });

        // Composite the normal channels
        for (let i = 0; i < size; i++) {
            if (shadedResult.silhouetteBuffer[i] > 0) {
                normalRgba[i * 4] = passX.rgba[i * 4];
                normalRgba[i * 4 + 1] = passY.rgba[i * 4 + 1];
                normalRgba[i * 4 + 2] = passZ.rgba[i * 4 + 2];
                normalRgba[i * 4 + 3] = 255;
            } else {
                normalRgba[i * 4] = options?.bgColor?.[0] ?? 18;
                normalRgba[i * 4 + 1] = options?.bgColor?.[1] ?? 22;
                normalRgba[i * 4 + 2] = options?.bgColor?.[2] ?? 28;
                normalRgba[i * 4 + 3] = options?.bgColor?.[3] ?? 255;
            }
        }

        const normalPng = encodePng(width, height, normalRgba);

        return {
            width,
            height,
            clay: encodePng(width, height, clayRgba),
            depth,
            mist: mistPng,
            normal: normalPng
        };
    }

    /**
     * Renders and restyles the viewport passes using Gemini/Nano Banana into a photorealistic,
     * geometrically registered image.
     */
    public async renderAiBeautyFrame(request: {
        mesh: RenderMesh3D;
        pose: CameraPose6DOF;
        prompt: string;
        stylePreset?: string;
        width?: number;
        height?: number;
        clayColor?: [number, number, number];
        bgColor?: [number, number, number, number];
    }): Promise<{ image: Buffer; width: number; height: number; passes: RenderPasses }> {
        const width = request.width || 640;
        const height = request.height || 480;

        // 1. Extract geometry passes
        const passes = this.extractRenderPasses(request.mesh, request.pose, width, height, {
            clayColor: request.clayColor,
            bgColor: request.bgColor
        });

        // 2. Synthesize Nano Banana prompt using blockout details
        const beautifyPrompt = buildBlockoutNanoBananaPrompt({
            locationName: request.prompt,
            heading: request.pose.fov, // Use fov as virtual heading/sensor context
            aspectRatio: `${width}:${height}`,
            styleSuffix: request.stylePreset ? ` Style: ${request.stylePreset}.` : ''
        });

        // 3. Call generator with blockout PNG and synthesized prompt
        const image = await this.generator.generate({
            stationId: 1,
            prompt: beautifyPrompt,
            blockoutPng: passes.clay,
            depthPng: passes.mist,
            visualPrompt: beautifyPrompt,
            beautify: {
                locationName: request.prompt,
                styleSuffix: request.stylePreset || ''
            },
            aspectRatio: `${width}:${height}`,
            width,
            height
        } as any);

        return {
            image,
            width,
            height,
            passes
        };
    }
}
