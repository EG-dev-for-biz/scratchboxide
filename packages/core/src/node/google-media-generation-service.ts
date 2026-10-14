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
    SkippedMediaModel,
    TextureMatrixCandidate,
    TextureMatrixRequest,
    TextureMatrixResult,
    VIDEO_MODEL_PRIORITY,
    VideoGenerationRequest,
    classifyMediaGenerationError,
    describeModelUsed,
    describeNoModelAnswered,
    resolveRequestedModels,
    validateMediaGenerationRequest
} from '../common/media-generation-protocol';
import { MediaModelUnavailableError } from '../common/errors/pipeline-errors';
import { GoogleMediaCredentialsService } from './google-media-credentials-service';
import { MediaAssetStore } from './media-asset-store';
import { decomposeRgbaToPbr } from './texture-processing';
import { decodeImageToRgba } from './image-codec-ffmpeg';

export interface GoogleMediaGenerationOptions {
    pollIntervalMs?: number;
    maxPollAttempts?: number;
}

export type GoogleMediaClientFactory = () => Promise<GoogleGenAI>;
export type MediaGenerationStage = 'running' | 'downloading';

/** Calls per model before an answer with no image part counts as a failure. */
export const EMPTY_IMAGE_RESPONSE_ATTEMPTS = 3;

/** An image request for {@link generateImageWithModels}: the models to try in order and the generateContent input. */
export interface ImageModelRequest {
    models: string[];
    contents: any[];
    imageConfig?: { aspectRatio?: string; imageSize?: string };
}

/** The image a model produced, which model produced it, and the models skipped before it (with reasons). */
export interface ImageModelAnswer {
    data: Buffer;
    mimeType: string;
    /** The model id that answered (the id asked for, not the dated version string). */
    modelUsed: string;
    /** The version string the API reported for the answer, when it reported one. */
    modelVersion?: string;
    responseText?: string;
    requestedModels: string[];
    skippedModels: SkippedMediaModel[];
    modelNote: string;
}

const REASON_LIMIT = 240;

/** The reason recorded for a model that produced nothing. */
export function skipReason(error: MediaGenerationError): string {
    const message = error.message.length > REASON_LIMIT ? `${error.message.slice(0, REASON_LIMIT)}...` : error.message;
    return error.code === 'unsupported' ? `not served: ${message}` : `${error.code}: ${message}`;
}

/**
 * A MediaModelUnavailableError that also carries the classified error, for the media job service. The carried
 * error's message is the full reason (including any models skipped before this one), so a failed job shows it.
 */
export function mediaModelUnavailable(model: string, reason: string, detail: MediaGenerationError): MediaModelUnavailableError {
    return Object.assign(new MediaModelUnavailableError(model, reason), { status: detail.status, mediaError: { ...detail, message: reason } });
}

/**
 * Adds where a model failure happened (e.g. "station front") to a MediaModelUnavailableError. Any other error is
 * returned unchanged: a bug or a local failure is never relabelled as a model being unavailable.
 */
export function withMediaFailureContext(error: unknown, context: string): unknown {
    if (!(error instanceof MediaModelUnavailableError)) {
        return error;
    }
    const reason = `${error.reason} (${context})`;
    const detail = (error as any).mediaError as MediaGenerationError | undefined;
    return Object.assign(new MediaModelUnavailableError(error.model, reason), {
        status: (error as any).status,
        mediaError: detail ? { ...detail, message: reason } : undefined
    });
}

/**
 * A failure of the model service itself: the SDK call threw, or the model answered without the media asked for.
 * Only these are classified as model failures; any other error (a bug in our own code, a local write) propagates
 * unchanged, so it is never reported as a model being unavailable.
 */
class ModelCallFailure extends Error {
    constructor(readonly original: unknown) {
        super(original instanceof Error ? original.message : String(original));
        this.name = 'ModelCallFailure';
    }
}

/** Runs one model-service call; a failure is marked as a model failure (see {@link ModelCallFailure}). */
async function modelCall<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        throw new ModelCallFailure(error);
    }
}

/** "(after skipping a: why; b: why)" when earlier models were skipped, else empty. */
function skippedSuffix(skipped: readonly SkippedMediaModel[]): string {
    return skipped.length ? ` (after skipping ${skipped.map(s => `${s.model}: ${s.reason}`).join('; ')})` : '';
}

/**
 * Asks each model in `request.models` for an image, in order, and returns the first image with the model that
 * produced it. Only a model that is not served (404) moves the request on to the next model, and each one moved
 * past is recorded with its reason, so the caller can say which model answered and why. A model that answers
 * with no image part is asked again ({@link EMPTY_IMAGE_RESPONSE_ATTEMPTS} times in all). Any other model failure
 * (quota, safety filter, invalid request, no image) ends the request with a MediaModelUnavailableError, as does
 * a list in which no model is served (the error names every model tried and why). Errors that are not model
 * failures propagate as they are.
 */
export async function generateImageWithModels(client: any, request: ImageModelRequest): Promise<ImageModelAnswer> {
    const models = request.models.filter(Boolean);
    if (!models.length) {
        throw mediaModelUnavailable('(none)', 'no image model was named', {
            code: 'invalid_request', message: 'no image model was named', retryable: false
        });
    }
    if (typeof client?.models?.generateContent !== 'function') {
        const message = 'the installed Google Gen AI SDK does not support generateContent';
        throw mediaModelUnavailable(models[0], message, { code: 'unsupported', message, retryable: false, model: models[0] });
    }
    const skipped: SkippedMediaModel[] = [];
    for (const model of models) {
        let response: any;
        let parts: any[] = [];
        let imagePart: any;
        try {
            // Image models sometimes finish (STOP) with no image part; ask again before giving up on the model.
            for (let attempt = 0; attempt < EMPTY_IMAGE_RESPONSE_ATTEMPTS && !imagePart; attempt++) {
                response = await modelCall(() => client.models.generateContent({
                    model,
                    contents: request.contents,
                    config: {
                        responseModalities: ['TEXT', 'IMAGE'],
                        ...(request.imageConfig ? { imageConfig: request.imageConfig } : {})
                    }
                }));
                if (response?.promptFeedback?.blockReason) {
                    throw new ModelCallFailure(new Error(`Safety filter blocked prompt: ${response.promptFeedback.blockReason}`));
                }
                parts = response?.candidates?.[0]?.content?.parts || [];
                imagePart = parts.find((part: any) => part?.inlineData?.data);
            }
            if (!imagePart) {
                const finishReason = response?.candidates?.[0]?.finishReason;
                throw new ModelCallFailure(new Error(finishReason
                    ? `Image generation returned no image (${finishReason})`
                    : 'Image generation returned no image'));
            }
        } catch (error) {
            if (!(error instanceof ModelCallFailure)) throw error;
            const classified = classifyMediaGenerationError(error.original, model);
            if (classified.code === 'unsupported') {
                skipped.push({ model, code: classified.code, reason: skipReason(classified) });
                continue;
            }
            throw mediaModelUnavailable(model, `${classified.message}${skippedSuffix(skipped)}`, classified);
        }
        return {
            data: Buffer.from(imagePart.inlineData.data, 'base64'),
            mimeType: imagePart.inlineData.mimeType || 'image/png',
            modelUsed: model,
            modelVersion: response?.modelVersion || undefined,
            responseText: parts.map((part: any) => part?.text || '').filter(Boolean).join('\n') || undefined,
            requestedModels: models,
            skippedModels: skipped,
            modelNote: describeModelUsed(model, skipped)
        };
    }
    const message = describeNoModelAnswered('image', skipped);
    throw mediaModelUnavailable(models[0], message, { code: 'unsupported', message, retryable: false, model: models[0] });
}

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

    /**
     * Generates one image. The models tried are exactly the request's modelPriority when it names any (product
     * names resolved to API ids), else the default list for its fidelity. The result says which model answered
     * and, when that is not the first one, why each earlier model was skipped.
     */
    async generateImage(request: ImageGenerationRequest): Promise<MediaGenerationResult> {
        validateMediaGenerationRequest(request);
        const client = await this.getClient();

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
        const answer = await generateImageWithModels(client, {
            models: resolveRequestedModels(request.modelPriority, defaultPriority),
            contents,
            imageConfig: {
                aspectRatio: request.aspectRatio,
                imageSize: request.imageSize ?? (isDraft ? '1K' : undefined)
            }
        });
        const asset = await this.assetStore.put(request.workspaceRoot, answer.data, answer.mimeType);
        return {
            asset,
            modelUsed: answer.modelUsed,
            requestedModels: answer.requestedModels,
            skippedModels: answer.skippedModels,
            modelNote: answer.modelNote,
            responseText: answer.responseText,
            createdAt: new Date().toISOString()
        };
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
        // Exactly the caller's models when it names any; a model it did not name (another family included) is never tried.
        const models = resolveRequestedModels(request.modelPriority, VIDEO_MODEL_PRIORITY);
        const skipped: SkippedMediaModel[] = [];

        for (const model of models) {
            let operation: any;
            let video: any;
            try {
                operation = await modelCall(() => client.models.generateVideos({
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
                } as any));
                await onStage?.('running', operation.name, model);

                const maxAttempts = this.options.maxPollAttempts || 180;
                const interval = this.options.pollIntervalMs === undefined ? 10000 : this.options.pollIntervalMs;
                let attempts = 0;
                while (!operation.done && attempts < maxAttempts) {
                    attempts++;
                    await this.delay(interval);
                    const current = operation;
                    operation = await modelCall(() => client.operations.getVideosOperation({ operation: current }));
                }
                if (!operation.done) {
                    throw new ModelCallFailure(Object.assign(new Error('Video generation operation timed out'), { status: 504 }));
                }
                if (operation.error) {
                    throw new ModelCallFailure(Object.assign(
                        new Error(String(operation.error.message || 'Video generation operation failed')),
                        operation.error
                    ));
                }
                video = operation.response?.generatedVideos?.[0]?.video;
                if (!video) {
                    const reasons = operation.response?.raiMediaFilteredReasons;
                    throw new ModelCallFailure(new Error(reasons?.length
                        ? `Responsible AI safety filter: ${reasons.join('; ')}`
                        : 'Video generation completed without a video'));
                }
            } catch (error) {
                if (!(error instanceof ModelCallFailure)) throw error;
                const classified = this.extractOrClassify(error.original, model);
                if (classified.code === 'unsupported') {
                    skipped.push({ model, code: classified.code, reason: skipReason(classified) });
                    continue;
                }
                throw mediaModelUnavailable(model, `${classified.message}${skippedSuffix(skipped)}`, classified);
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
                    try {
                        await client.files.download({ file: video, downloadPath: stagingPath });
                    } catch (error) {
                        const classified = this.extractOrClassify(error, model);
                        throw mediaModelUnavailable(model, `the finished video could not be downloaded: ${classified.message}${skippedSuffix(skipped)}`, classified);
                    }
                    bytes = await fs.readFile(stagingPath);
                } finally {
                    await fs.remove(stagingPath);
                }
            }
            const asset = await this.assetStore.put(request.workspaceRoot, bytes, mimeType);
            return {
                asset,
                modelUsed: model,
                requestedModels: models,
                skippedModels: skipped,
                modelNote: describeModelUsed(model, skipped),
                operationName: operation.name,
                createdAt: new Date().toISOString()
            };
        }
        const message = describeNoModelAnswered('video', skipped);
        throw mediaModelUnavailable(models[0], message, { code: 'unsupported', message, retryable: false, model: models[0] });
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

            // Every candidate is a generated image; a failed generation or an undecodable image fails the matrix.
            const imgResult = await this.generateImage({
                kind: 'image',
                prompt: conditionedPrompt,
                workspaceRoot: request.workspaceRoot,
                idempotencyKey: `${request.idempotencyKey}-candidate-${i}`,
                aspectRatio: '1:1'
            });
            const fileBytes = await fs.readFile(this.assetStore.resolve(request.workspaceRoot, imgResult.asset));
            const { rgba: rgbaBuffer, width, height } = await decodeImageToRgba(fileBytes);

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
