/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import { GoogleGenAI } from '@google/genai';
import {
    IMAGE_MODEL_PRIORITY,
    IMAGE_MODEL_PRIORITY_DRAFT,
    ImageGenerationRequest,
    MediaCapabilities,
    MediaGenerationError,
    MediaGenerationResult,
    TextureMatrixCandidate,
    TextureMatrixRequest,
    TextureMatrixResult,
    VIDEO_MODEL_PRIORITY,
    VideoGenerationRequest,
    classifyMediaGenerationError,
    validateMediaGenerationRequest
} from '../common/media-generation-protocol';
import { GoogleMediaCredentialsService } from './google-media-credentials-service';
import { MediaAssetStore } from './media-asset-store';
import { decodePng, decomposeRgbaToPbr, generateProceduralTextureBuffer } from './texture-processing';

export interface GoogleMediaGenerationOptions {
    pollIntervalMs?: number;
    maxPollAttempts?: number;
}

export type GoogleMediaClientFactory = () => Promise<GoogleGenAI>;
export type MediaGenerationStage = 'running' | 'downloading';

/** Calls per model before an answer with no image part counts as a failure. */
const EMPTY_IMAGE_RESPONSE_ATTEMPTS = 3;

export class GoogleMediaGenerationService {
    protected readonly credentials?: GoogleMediaCredentialsService;

    constructor(
        private readonly assetStore: MediaAssetStore,
        private readonly clientFactory?: GoogleMediaClientFactory,
        private readonly options: GoogleMediaGenerationOptions = {}
    ) {}

    async detectCapabilities(models: string[] = [...IMAGE_MODEL_PRIORITY, ...VIDEO_MODEL_PRIORITY]): Promise<MediaCapabilities> {
        const client = await this.getClient();
        const sdk = {
            generateContent: typeof client.models?.generateContent === 'function',
            generateVideos: typeof client.models?.generateVideos === 'function',
            getVideosOperation: typeof client.operations?.getVideosOperation === 'function',
            download: typeof client.files?.download === 'function'
        };
        const capabilities: MediaCapabilities = { sdk, models: {} };

        await Promise.all(models.map(async model => {
            try {
                const info = await client.models.get({ model });
                const actions = info.supportedActions || [];
                capabilities.models[model] = {
                    available: true,
                    supportedActions: actions
                };
            } catch (error) {
                capabilities.models[model] = {
                    available: false,
                    supportedActions: [],
                    error: classifyMediaGenerationError(error, model)
                };
            }
        }));
        return capabilities;
    }

    async generateImage(request: ImageGenerationRequest): Promise<MediaGenerationResult> {
        validateMediaGenerationRequest(request);
        const client = await this.getClient();
        if (typeof client.models?.generateContent !== 'function') {
            throw this.asServiceError({
                code: 'unsupported',
                message: 'Installed Google Gen AI SDK does not support generateContent',
                retryable: false
            });
        }

        const contents: any[] = [{ text: request.prompt }];
        if (request.sourceAsset) {
            const sourceBytes = await fs.readFile(this.assetStore.resolve(request.workspaceRoot, request.sourceAsset));
            contents.push({
                inlineData: {
                    data: sourceBytes.toString('base64'),
                    mimeType: request.sourceAsset.mimeType
                }
            });
        }
        for (const reference of (request.referenceAssets || []).slice(0, 14)) {
            const bytes = await fs.readFile(this.assetStore.resolve(request.workspaceRoot, reference));
            contents.push({
                inlineData: {
                    data: bytes.toString('base64'),
                    mimeType: reference.mimeType
                }
            });
        }

        const isDraft = request.fidelity === 'draft' || request.draft === true;
        const defaultPriority = isDraft ? IMAGE_MODEL_PRIORITY_DRAFT : IMAGE_MODEL_PRIORITY;
        const models = this.modelPriority(request.modelPriority, defaultPriority);
        const resolvedImageSize = request.imageSize ?? (isDraft ? '1K' : undefined);
        let lastUnsupported: MediaGenerationError | undefined;
        for (const model of models) {
            try {
                let response: any;
                let parts: any[] = [];
                let imagePart: any;
                // Image models sometimes finish (STOP) with no image part; ask again before giving up on the model.
                for (let attempt = 0; attempt < EMPTY_IMAGE_RESPONSE_ATTEMPTS && !imagePart; attempt++) {
                    response = await client.models.generateContent({
                        model,
                        contents,
                        config: {
                            responseModalities: ['TEXT', 'IMAGE'],
                            imageConfig: {
                                aspectRatio: request.aspectRatio,
                                imageSize: resolvedImageSize
                            }
                        }
                    } as any);
                    if (response.promptFeedback?.blockReason) {
                        throw new Error(`Safety filter blocked prompt: ${response.promptFeedback.blockReason}`);
                    }
                    parts = response.candidates?.[0]?.content?.parts || [];
                    imagePart = parts.find(part => part.inlineData?.data);
                }
                if (!imagePart) {
                    const finishReason = response.candidates?.[0]?.finishReason;
                    throw new Error(finishReason
                        ? `Image generation returned no image (${finishReason})`
                        : 'Image generation returned no image');
                }
                const mimeType = imagePart.inlineData.mimeType || 'image/png';
                const asset = await this.assetStore.put(
                    request.workspaceRoot,
                    Buffer.from(imagePart.inlineData.data, 'base64'),
                    mimeType
                );
                return {
                    asset,
                    modelUsed: response.modelVersion || model,
                    responseText: parts.map(part => part.text || '').filter(Boolean).join('\n') || undefined,
                    createdAt: new Date().toISOString()
                };
            } catch (error) {
                const classified = classifyMediaGenerationError(error, model);
                if (classified.code === 'unsupported') {
                    lastUnsupported = classified;
                    continue;
                }
                throw this.asServiceError(classified);
            }
        }
        throw this.asServiceError(lastUnsupported || {
            code: 'unsupported',
            message: 'No configured image generation model is available',
            retryable: false
        });
    }

    async generateVideo(
        request: VideoGenerationRequest,
        onStage?: (stage: MediaGenerationStage, operationName?: string, model?: string) => void | Promise<void>
    ): Promise<MediaGenerationResult> {
        validateMediaGenerationRequest(request);
        const client = await this.getClient();
        if (typeof client.models?.generateVideos !== 'function' ||
            typeof client.operations?.getVideosOperation !== 'function') {
            throw this.asServiceError({
                code: 'unsupported',
                message: 'Installed Google Gen AI SDK does not support Veo long-running operations',
                retryable: false
            });
        }

        const seedAsset = request.sourceAsset || (request.referenceAssets && request.referenceAssets[0]);
        const sourceImage = seedAsset
            ? {
                imageBytes: (await fs.readFile(this.assetStore.resolve(request.workspaceRoot, seedAsset))).toString('base64'),
                mimeType: seedAsset.mimeType
            }
            : undefined;
        const models = this.modelPriority(request.modelPriority, VIDEO_MODEL_PRIORITY);
        let lastUnsupported: MediaGenerationError | undefined;

        for (const model of models) {
            try {
                let operation: any = await client.models.generateVideos({
                    model,
                    prompt: request.prompt,
                    image: sourceImage,
                    config: {
                        numberOfVideos: 1,
                        durationSeconds: request.durationSeconds,
                        aspectRatio: request.aspectRatio,
                        resolution: request.resolution,
                        generateAudio: request.generateAudio !== false,
                        negativePrompt: request.negativePrompt
                    }
                } as any);
                await onStage?.('running', operation.name, model);

                const maxAttempts = this.options.maxPollAttempts || 180;
                const interval = this.options.pollIntervalMs === undefined ? 10000 : this.options.pollIntervalMs;
                let attempts = 0;
                while (!operation.done && attempts < maxAttempts) {
                    attempts++;
                    await this.delay(interval);
                    operation = await client.operations.getVideosOperation({ operation });
                }
                if (!operation.done) {
                    throw Object.assign(new Error('Video generation operation timed out'), { status: 504 });
                }
                if (operation.error) {
                    throw Object.assign(
                        new Error(String(operation.error.message || 'Video generation operation failed')),
                        operation.error
                    );
                }
                const video = operation.response?.generatedVideos?.[0]?.video;
                if (!video) {
                    const reasons = operation.response?.raiMediaFilteredReasons;
                    throw new Error(reasons?.length
                        ? `Responsible AI safety filter: ${reasons.join('; ')}`
                        : 'Video generation completed without a video');
                }

                await onStage?.('downloading', operation.name, model);
                const mimeType = video.mimeType || 'video/mp4';
                let bytes: Buffer;
                if (video.videoBytes) {
                    bytes = Buffer.from(video.videoBytes, 'base64');
                } else {
                    const stagingPath = this.assetStore.stagingPath(
                        request.workspaceRoot,
                        `${operation.name || Date.now()}.mp4`
                    );
                    await fs.ensureDir(require('path').dirname(stagingPath));
                    try {
                        await client.files.download({ file: video, downloadPath: stagingPath });
                        bytes = await fs.readFile(stagingPath);
                    } finally {
                        await fs.remove(stagingPath);
                    }
                }
                const asset = await this.assetStore.put(request.workspaceRoot, bytes, mimeType);
                return {
                    asset,
                    modelUsed: model,
                    operationName: operation.name,
                    createdAt: new Date().toISOString()
                };
            } catch (error) {
                const classified = this.extractOrClassify(error, model);
                if (classified.code === 'unsupported') {
                    lastUnsupported = classified;
                    continue;
                }
                throw this.asServiceError(classified);
            }
        }
        throw this.asServiceError(lastUnsupported || {
            code: 'unsupported',
            message: 'No configured video generation model is available',
            retryable: false
        });
    }

    async generateTextureMatrix(request: TextureMatrixRequest): Promise<TextureMatrixResult> {
        if (!request.basePrompt || !request.basePrompt.trim()) {
            throw new Error('A non-empty basePrompt is required');
        }
        if (!request.workspaceRoot) {
            throw new Error('A workspaceRoot is required');
        }

        const styleVariations = [
            {
                modifier: 'Photorealistic Raw Detail',
                condition: 'raw surface detail, micro-grain realism, 8k texture asset, photorealistic roughness'
            },
            {
                modifier: 'Weathered & Aged Specular',
                condition: 'weathered, aged micro-erosion, subtle surface patina, tactile organic wear'
            },
            {
                modifier: 'Polished Pristine Surface',
                condition: 'clean polished condition, pristine specular balance, minimal micro-abrasion'
            },
            {
                modifier: 'Rough Tactile Relief',
                condition: 'rough high-relief displacement, pronounced tactile structure, deep micro-geometry'
            }
        ];

        const candidates: TextureMatrixCandidate[] = [];

        for (let i = 0; i < styleVariations.length; i++) {
            const style = styleVariations[i];
            const conditionedPrompt = `Top-down flat orthographic albedo texture map of ${request.basePrompt}, ${style.condition}, completely seamless, infinitely tileable, evenly lit flat albedo diffuse, no perspective distortion, no cast shadows, no baked lighting, no specular highlights`;

            let rgbaBuffer: Buffer;
            let width = 256;
            let height = 256;

            try {
                const imgResult = await this.generateImage({
                    kind: 'image',
                    prompt: conditionedPrompt,
                    workspaceRoot: request.workspaceRoot,
                    idempotencyKey: `${request.idempotencyKey}-candidate-${i}`,
                    aspectRatio: '1:1'
                });

                const filePath = this.assetStore.resolve(request.workspaceRoot, imgResult.asset);
                const fileBytes = await fs.readFile(filePath);
                try {
                    const decoded = decodePng(fileBytes);
                    rgbaBuffer = decoded.rgba;
                    width = decoded.width;
                    height = decoded.height;
                } catch {
                    rgbaBuffer = generateProceduralTextureBuffer(width, height, [
                        140 + i * 25,
                        130 + i * 15,
                        110 + i * 20
                    ]);
                }
            } catch {
                rgbaBuffer = generateProceduralTextureBuffer(width, height, [
                    140 + i * 25,
                    130 + i * 15,
                    110 + i * 20
                ]);
            }

            const decomposed = decomposeRgbaToPbr(rgbaBuffer, width, height, {
                isMetallic: request.isMetallic ?? false,
                bumpStrength: request.bumpStrength ?? 3.5,
                featherRatio: 0.15
            });

            const albedoAsset = await this.assetStore.put(request.workspaceRoot, decomposed.albedoPng, 'image/png');
            const normalAsset = await this.assetStore.put(request.workspaceRoot, decomposed.normalPng, 'image/png');
            const roughnessAsset = await this.assetStore.put(request.workspaceRoot, decomposed.roughnessPng, 'image/png');
            const metallicAsset = await this.assetStore.put(request.workspaceRoot, decomposed.metallicPng, 'image/png');
            const aoAsset = await this.assetStore.put(request.workspaceRoot, decomposed.aoPng, 'image/png');
            const ormAsset = await this.assetStore.put(request.workspaceRoot, decomposed.ormPng, 'image/png');

            candidates.push({
                id: `candidate-${i}`,
                prompt: conditionedPrompt,
                styleModifier: style.modifier,
                textures: {
                    albedo: albedoAsset.uri,
                    normal: normalAsset.uri,
                    roughness: roughnessAsset.uri,
                    metallic: metallicAsset.uri,
                    ao: aoAsset.uri,
                    orm: ormAsset.uri,
                    isTileable: true
                },
                meshMappingPreset: 'triplanar'
            });
        }

        return {
            candidates,
            selectedCandidateId: candidates[0]?.id || 'candidate-0',
            targetMeshId: request.targetMeshId
        };
    }

    private async getClient(): Promise<GoogleGenAI> {
        if (this.clientFactory) {
            return this.clientFactory();
        }
        return (this.credentials || new GoogleMediaCredentialsService()).createClient();
    }

    private modelPriority(requested: string[] | undefined, defaults: string[]): string[] {
        const rawList = requested?.length ? requested : defaults;
        const expanded: string[] = [];

        for (const model of rawList) {
            if (!model) continue;
            const m = model.toLowerCase();
            if (m.includes('nano-banana-lite') || m === 'nano-banana-lite') {
                expanded.push(model, 'gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'nano-banana-2');
            } else if (m.includes('nano-banana') || m === 'nano-banana-2' || m === 'google/nano-banana-pro') {
                expanded.push(model, 'gemini-3.1-flash-image', 'imagen-3.0-generate-002', 'gemini-3-pro-image', 'gemini-2.5-flash-image');
            } else if (m.includes('omni') || m === 'google/omni-1.1' || m === 'omni-1.1-video' || m === 'gemini-omni-flash-video' || m === 'omni-product') {
                expanded.push(model, 'veo-3.1-fast-generate-preview', 'veo-3.1-generate-preview', 'veo-3.1-lite-generate-preview');
            } else {
                expanded.push(model);
            }
        }

        // Add fallbacks from defaults
        expanded.push(...defaults);
        return Array.from(new Set(expanded.filter(Boolean)));
    }

    private asServiceError(detail: MediaGenerationError): Error {
        return Object.assign(new Error(detail.message), {
            status: detail.status,
            mediaError: detail
        });
    }

    private extractOrClassify(error: unknown, model?: string): MediaGenerationError {
        return (error as any)?.mediaError || classifyMediaGenerationError(error, model);
    }

    private delay(milliseconds: number): Promise<void> {
        return milliseconds > 0
            ? new Promise(resolve => setTimeout(resolve, milliseconds))
            : Promise.resolve();
    }
}
