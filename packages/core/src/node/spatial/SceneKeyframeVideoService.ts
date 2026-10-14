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
            workspaceRoot: this.workspaceRoot
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
    }): Promise<{ video: Buffer; startImage: Buffer; endImage: Buffer; videoModel: string; imageSources: string[] }> {
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
        const omniPromptText = buildMinimalOmniVideoPrompt({
            blockoutVideoRef: '<VIDEO_REF_0>',
            primarySubject: request.prompt
        });

        // 4. Dispatch video generation via Interactions API
        // Input must be a flat array: text first, then inline image parts
        const inputPayload = [
            { type: 'text', text: omniPromptText },
            { type: 'image', mime_type: 'image/png', data: startBeauty.image.toString('base64') },
            { type: 'image', mime_type: 'image/png', data: endBeauty.image.toString('base64') }
        ];

        const client = await this.getClient();
        const videoModel = 'gemini-omni-1.1-flash-preview';
        const response = await client.interactions.create({
            model: videoModel,
            input: inputPayload,
            generation_config: {
                video_config: {
                    task: 'image_to_video'
                }
            },
            response_format: {
                aspect_ratio: `${width}:${height}`,
                duration: `${durationSeconds}s`
            }
        });

        // Parse video output: iterate steps for model_output, then content for video part
        let videoPart: { data?: string; uri?: string; mime_type?: string; mimeType?: string } | undefined;
        for (const step of response?.steps ?? []) {
            if (step?.type !== 'model_output') continue;
            for (const part of step?.content ?? []) {
                const mime = part?.mime_type ?? part?.mimeType ?? '';
                if ((part?.type === 'video' || mime.startsWith('video/')) && (part?.data || part?.uri)) {
                    videoPart = part;
                    break;
                }
            }
            if (videoPart) break;
        }

        if (!videoPart) {
            throw new Error('No video data returned from Gemini Omni Interactions API');
        }

        let videoData: Buffer;
        if (videoPart.data) {
            videoData = Buffer.from(videoPart.data, 'base64');
        } else {
            // URI-based download: strip any trailing :download token before constructing the URL
            const rawUri = videoPart.uri as string;
            const fileId = rawUri.split('/').pop()?.split('?')[0]?.replace(':download', '') ?? '';
            const apiKey = (client as any)._apiKey ?? process.env.GEMINI_API_KEY ?? '';
            const downloadUrl = `https://generativelanguage.googleapis.com/v1beta/files/${fileId}:download?alt=media&key=${apiKey}`;
            const res = await fetch(downloadUrl);
            if (!res.ok) throw new Error(`Failed to download video from Omni API: ${res.status} ${res.statusText}`);
            videoData = Buffer.from(await res.arrayBuffer());
        }

        return {
            video: videoData,
            startImage: startBeauty.image,
            endImage: endBeauty.image,
            videoModel,
            imageSources: Array.from(new Set([startBeauty.imageSource, endBeauty.imageSource]))
        };
    }
}
