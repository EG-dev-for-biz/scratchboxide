/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { HeadlessMeshSilhouetteRenderer, RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { NativeAiRenderEngineService, RenderPasses } from './NativeAiRenderEngineService';
import { createDefaultStationImageGenerator, StationImageGenerator } from './BeautifyStationService';
import { buildMinimalOmniVideoPrompt } from '../../browser/generative-canvas/services/video/omniVideoPromptService';
import { GeminiClient } from '../gemini/gemini-client';

export interface KeyframePairCapture {
    start: RenderPasses;
    end: RenderPasses;
}

export interface SceneKeyframeVideoServiceOptions {
    client?: any; // Google GenAI client / Vertex client
    generator?: StationImageGenerator;
    workspaceRoot?: string;
}

export class SceneKeyframeVideoService {
    private client: any;
    private generator: StationImageGenerator;
    private workspaceRoot: string;

    constructor(options?: SceneKeyframeVideoServiceOptions) {
        this.client = options?.client;
        this.workspaceRoot = options?.workspaceRoot || process.cwd();
        this.generator = options?.generator || createDefaultStationImageGenerator({
            workspaceRoot: this.workspaceRoot,
            allowProceduralGenerator: true
        });
    }

    private async getClient() {
        if (this.client) return this.client;
        const gemini = new GeminiClient();
        this.client = await gemini.getGenAIClient();
        if (!this.client) {
            throw new Error('SceneKeyframeVideoService: Failed to resolve Gemini GenAI Client (missing credentials or API key).');
        }
        return this.client;
    }

    /**
     * Captures geometric multi-pass render outputs for both start and end keyframe poses.
     */
    public captureKeyframePair(
        mesh: RenderMesh3D,
        startPose: CameraPose6DOF,
        endPose: CameraPose6DOF,
        width: number = 640,
        height: number = 480
    ): KeyframePairCapture {
        const renderService = new NativeAiRenderEngineService({ generator: this.generator, workspaceRoot: this.workspaceRoot });
        const start = renderService.extractRenderPasses(mesh, startPose, width, height);
        const end = renderService.extractRenderPasses(mesh, endPose, width, height);

        return { start, end };
    }

    /**
     * Synthesizes a photorealistic continuous interpolated video sequence from two 3D keyframe poses.
     * Restyles Frame 1 into a high-res image and uses Gemini Omni 1.1 Interactions API to interpolate.
     */
    public async synthesizeKeyframeInterpolationVideo(request: {
        mesh: RenderMesh3D;
        startPose: CameraPose6DOF;
        endPose: CameraPose6DOF;
        prompt: string;
        width?: number;
        height?: number;
        durationSeconds?: number;
    }): Promise<{ video: Buffer; startImage: Buffer; endImage: Buffer }> {
        const width = request.width || 640;
        const height = request.height || 480;
        const durationSeconds = request.durationSeconds || 6;

        // 1. Capture keyframe passes
        const pair = this.captureKeyframePair(request.mesh, request.startPose, request.endPose, width, height);

        // 2. Restyle keyframe images into photoreal start and end frames
        const renderService = new NativeAiRenderEngineService({ generator: this.generator, workspaceRoot: this.workspaceRoot });
        const startBeauty = await renderService.renderAiBeautyFrame({
            mesh: request.mesh,
            pose: request.startPose,
            prompt: `Start frame: ${request.prompt}`,
            width,
            height
        });

        const endBeauty = await renderService.renderAiBeautyFrame({
            mesh: request.mesh,
            pose: request.endPose,
            prompt: `End frame: ${request.prompt}`,
            width,
            height
        });

        // 3. Compile Omni 1.1 keyframe motion brief
        const omniPrompt = buildMinimalOmniVideoPrompt({
            blockoutVideoRef: '<VIDEO_REF_0>',
            primarySubject: request.prompt
        });

        // 4. Dispatch video generation via Interactions API
        const client = await this.getClient();
        const response = await client.interactions.create({
            model: 'gemini-omni-1.1-flash-preview',
            input: omniPrompt,
            generation_config: {
                video_config: {
                    task: 'image_to_video'
                }
            },
            response_format: {
                aspect_ratio: `${width}:${height}`,
                duration: `${durationSeconds}s`
            },
            // Pass the generated beauties as starting/reference parameters
            images: [
                {
                    inlineData: {
                        mimeType: 'image/png',
                        data: startBeauty.image.toString('base64')
                    }
                },
                {
                    inlineData: {
                        mimeType: 'image/png',
                        data: endBeauty.image.toString('base64')
                    }
                }
            ]
        });

        // Parse video output bytes
        const part = response.steps?.[0]?.model_output?.content?.parts?.[0];
        if (!part || !part.inlineData || !part.inlineData.data) {
            throw new Error('No video data returned from Gemini Omni Interactions API');
        }

        return {
            video: Buffer.from(part.inlineData.data, 'base64'),
            startImage: startBeauty.image,
            endImage: endBeauty.image
        };
    }
}
