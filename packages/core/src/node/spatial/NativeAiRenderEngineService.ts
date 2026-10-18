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
import { createDefaultStationImageGenerator, describeStationImageSource, toStationImageAnswer, StationImageGenerator } from './BeautifyStationService';
import { nearestImageAspectRatio } from '../../common/media-generation-protocol';

export interface RenderPasses {
    width: number;
    height: number;
    clay: Buffer;
    depth: Float32Array;
    mist: Buffer; // PNG encoded depth
    /** PNG of the three-light normal-shading pass; only rendered when asked for (includeNormal), as no restyle call uses it. */
    normal?: Buffer;
}

export interface NativeAiRenderEngineServiceOptions {
    generator?: StationImageGenerator;
    workspaceRoot?: string;
}

/**
 * The restyle prompt for a render of a mesh: the subject the caller describes, the frame's aspect ratio and the
 * framing rules. A mesh render has no place, heading or coordinates, so the prompt names none (it is not a
 * photograph of a real location, and must not be told it is one).
 */
export function buildMeshRenderRestylePrompt(subject: string, aspectRatio: string, styleSuffix = ''): string {
    return `Transform this 3D clay rendering into a photorealistic image of: ${subject}. `
        + `CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly ${aspectRatio} aspect ratio, matching the reference image canvas. `
        + '(2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. '
        + '(3) Every part of the subject must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. '
        + '(4) Do not invent or add objects or features that are not visible in the reference. '
        + `Add realistic materials, surface texture, lighting and fine detail.${styleSuffix}`;
}

export class NativeAiRenderEngineService {
    private generator: StationImageGenerator;
    private workspaceRoot: string;

    constructor(options?: NativeAiRenderEngineServiceOptions) {
        this.workspaceRoot = options?.workspaceRoot || process.cwd();
        this.generator = options?.generator || createDefaultStationImageGenerator({
            workspaceRoot: this.workspaceRoot
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
            /** Render the normal-shading pass (three extra rasterisations). Default true. */
            includeNormal?: boolean;
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

        let normalPng: Buffer | undefined;
        if (options?.includeNormal !== false) {
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

            normalPng = encodePng(width, height, normalRgba);
        }

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
        /** The caller's Stop, handed to the image model call. */
        signal?: AbortSignal;
    }): Promise<{ image: Buffer; width: number; height: number; passes: RenderPasses; modelUsed?: string; imageSource: string }> {
        const width = request.width || 640;
        const height = request.height || 480;

        // 1. Extract geometry passes
        const passes = this.extractRenderPasses(request.mesh, request.pose, width, height, {
            clayColor: request.clayColor,
            bgColor: request.bgColor,
            // No restyle call reads the normal pass; skip its three extra rasterisations.
            includeNormal: false
        });

        // 2. The restyle prompt: the caller's subject and the frame, with no invented place, coordinates or heading
        const aspectRatio = nearestImageAspectRatio(width, height);
        const beautifyPrompt = buildMeshRenderRestylePrompt(request.prompt, aspectRatio, request.stylePreset ? ` Style: ${request.stylePreset}.` : '');

        // 3. Call generator with blockout PNG and the prompt
        const answer = toStationImageAnswer(await this.generator.generate({
            prompt: beautifyPrompt,
            blockoutPng: passes.clay,
            aspectRatio,
            width,
            height,
            signal: request.signal
        }));

        return {
            image: answer.png,
            width,
            height,
            passes,
            modelUsed: answer.modelUsed,
            imageSource: describeStationImageSource({ ...answer, generator: this.generator.name })
        };
    }
}
