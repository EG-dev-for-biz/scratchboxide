/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// API model ids; the Gemini API and Vertex AI serve image models under the same ids.
export const IMAGE_MODEL_PRIORITY = [
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image'
];

export const IMAGE_MODEL_PRIORITY_DRAFT = [
    'gemini-2.5-flash-image',
    'gemini-3.1-flash-image'
];

/**
 * Product names that callers and saved documents still send, mapped to the API model id of the same model.
 * Sending one of these names as-is costs a 404 round trip. An alias only ever names the same model under its
 * API id: a name for another model family (an Imagen id, say) is not an alias and is sent as given.
 */
export const IMAGE_MODEL_ALIASES: Record<string, string> = {
    'nano-banana-2': 'gemini-3.1-flash-image',
    'google/nano-banana-pro': 'gemini-3-pro-image',
    'nano-banana-pro': 'gemini-3-pro-image',
    'nano-banana-lite': 'gemini-3.1-flash-lite-image'
};

/** The API model id for an image model name; a name that is not an alias passes through unchanged. */
export function resolveImageModelId(model: string): string {
    const key = model.toLowerCase();
    return Object.prototype.hasOwnProperty.call(IMAGE_MODEL_ALIASES, key) ? IMAGE_MODEL_ALIASES[key] : model;
}

/**
 * The models to try for a request, in order: exactly the caller's models (product names resolved to API ids)
 * when it names any, otherwise the defaults. The defaults are never appended to a caller's list, so a caller
 * that names one model gets that model or an error.
 */
export function resolveRequestedModels(requested: readonly string[] | string | undefined, defaults: readonly string[]): string[] {
    const named = (typeof requested === 'string' ? [requested] : (requested || []))
        .map(model => (typeof model === 'string' ? model.trim() : ''))
        .filter(Boolean);
    const list = named.length ? named : defaults;
    return Array.from(new Set(list.map(resolveImageModelId)));
}

/** A model that was tried before the one that answered, and why it did not answer. */
export interface SkippedMediaModel {
    model: string;
    code: MediaGenerationErrorCode;
    reason: string;
}

/**
 * One sentence naming the model that answered. When it is not the first model asked for, the sentence says
 * so and gives the reason each earlier model was skipped.
 */
export function describeModelUsed(modelUsed: string, skipped: readonly SkippedMediaModel[] = []): string {
    if (!skipped.length) {
        return `Generated with ${modelUsed}.`;
    }
    const reasons = skipped.map(s => `${s.model} (${s.reason})`).join('; ');
    return `Generated with ${modelUsed}, not the requested ${skipped[0].model}: skipped ${reasons}.`;
}

/** The failure message when no model in a list produced output: every model tried, with its reason. */
export function describeNoModelAnswered(kind: string, skipped: readonly SkippedMediaModel[]): string {
    if (!skipped.length) {
        return `No ${kind} model was tried`;
    }
    return `No ${kind} model produced output: ${skipped.map(s => `${s.model} (${s.reason})`).join('; ')}`;
}

export const VIDEO_MODEL_PRIORITY = [
    'google/omni-1.1',
    'gemini-omni-flash-video',
    'omni-1.1-video',
    'veo-3.1-fast-generate-preview',
    'veo-3.1-generate-preview',
    'veo-3.1-lite-generate-preview'
];

export type MediaKind = 'image' | 'video' | 'audio' | '3d';
export type MediaJobStatus =
    | 'queued'
    | 'submitting'
    | 'running'
    | 'downloading'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type MediaGenerationErrorCode =
    | 'unsupported'
    | 'unauthorized'
    | 'quota'
    | 'safety_filtered'
    | 'transient'
    | 'invalid_request'
    | 'cancelled'
    | 'internal';

export interface MediaGenerationError {
    code: MediaGenerationErrorCode;
    message: string;
    retryable: boolean;
    model?: string;
    status?: number;
}

export interface MediaAssetRef {
    uri: string;
    contentHash: string;
    mimeType: string;
    byteLength: number;
    relativePath: string;
}

interface MediaGenerationRequestBase {
    kind: MediaKind;
    prompt: string;
    workspaceRoot: string;
    idempotencyKey: string;
    modelPriority?: string[];
    negativePrompt?: string;
}

export interface ImageGenerationRequest extends MediaGenerationRequestBase {
    kind: 'image';
    aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9';
    imageSize?: '1K' | '2K' | '4K';
    fidelity?: 'draft' | 'production';
    draft?: boolean;
    referenceAssets?: MediaAssetRef[];
    sourceAsset?: MediaAssetRef;
}

export interface VideoGenerationRequest extends MediaGenerationRequestBase {
    kind: 'video';
    aspectRatio?: '16:9' | '9:16';
    durationSeconds?: 4 | 6 | 8;
    resolution?: '720p' | '1080p' | '4k';
    generateAudio?: boolean;
    sourceAsset?: MediaAssetRef;
    referenceAssets?: MediaAssetRef[];
}

export interface AudioGenerationRequest extends MediaGenerationRequestBase {
    kind: 'audio';
    audioKind: 'speech' | 'music' | 'sound_effect';
    voiceId?: string;
    durationSeconds?: number;
}

export interface Scene3DGenerationRequest extends MediaGenerationRequestBase {
    kind: '3d';
    meshType: string;
    environment: string;
    cameraParams?: { x: number; y: number; z: number; fov: number };
}

export type MediaGenerationRequest = ImageGenerationRequest | VideoGenerationRequest | AudioGenerationRequest | Scene3DGenerationRequest;

export interface MediaGenerationResult {
    asset: MediaAssetRef;
    /** The model that produced the asset. */
    modelUsed: string;
    /** The models the request asked for, in order; the first is the requested model. */
    requestedModels?: string[];
    /** Models tried before modelUsed that produced nothing, with the reason; empty when the first model answered. */
    skippedModels?: SkippedMediaModel[];
    /** Plain statement of which model answered and, when it was not the requested one, why (describeModelUsed). */
    modelNote?: string;
    operationName?: string;
    responseText?: string;
    createdAt?: string;
}

export interface PbrTextureSetUrls {
    albedo: string;
    normal: string;
    roughness: string;
    metallic: string;
    ao: string;
    orm?: string;
    isTileable: boolean;
}

export interface TextureMatrixCandidate {
    id: string;
    prompt: string;
    styleModifier: string;
    textures: PbrTextureSetUrls;
    previewGlbUrl?: string;
    meshMappingPreset?: 'triplanar' | 'uv' | 'spherical';
}

export interface TextureMatrixRequest {
    basePrompt: string;
    workspaceRoot: string;
    idempotencyKey: string;
    isMetallic?: boolean;
    bumpStrength?: number;
    targetMeshId?: string;
}

export interface TextureMatrixResult {
    candidates: TextureMatrixCandidate[];
    selectedCandidateId: string;
    targetMeshId?: string;
}

export interface PersistedMediaGenerationRequest {
    kind: MediaKind;
    prompt: string;
    idempotencyKey: string;
    modelPriority?: string[];
    negativePrompt?: string;
    aspectRatio?: string;
    imageSize?: string;
    durationSeconds?: number;
    resolution?: string;
    generateAudio?: boolean;
    referenceAssets?: MediaAssetRef[];
    sourceAsset?: MediaAssetRef;
}

export interface MediaGenerationJob {
    id: string;
    status: MediaJobStatus;
    request: PersistedMediaGenerationRequest;
    createdAt: string;
    updatedAt: string;
    operationName?: string;
    modelUsed?: string;
    result?: MediaGenerationResult;
    error?: MediaGenerationError;
}

export interface MediaModelCapability {
    available: boolean;
    supportedActions: string[];
    error?: MediaGenerationError;
}

export interface MediaCapabilities {
    sdk: {
        generateContent: boolean;
        generateVideos: boolean;
        getVideosOperation: boolean;
        download: boolean;
    };
    models: Record<string, MediaModelCapability>;
}

export interface StartMediaGenerationResponse {
    success: boolean;
    job?: MediaGenerationJob;
    error?: MediaGenerationError;
}

export function validateMediaGenerationRequest<T extends MediaGenerationRequest>(request: T): T {
    if (!request || (request.kind !== 'image' && request.kind !== 'video' && request.kind !== 'audio' && request.kind !== '3d')) {
        throw validationError('A valid media kind is required');
    }
    if (!request.prompt || !request.prompt.trim()) {
        throw validationError('A non-empty media prompt is required');
    }
    if (request.prompt.length > 32000) {
        throw validationError('Media prompt exceeds the 32000 character limit');
    }
    if (!request.workspaceRoot || !request.workspaceRoot.trim()) {
        throw validationError('A workspace root is required');
    }
    if (!request.idempotencyKey || !request.idempotencyKey.trim()) {
        throw validationError('An idempotency key is required');
    }
    return request;
}

function validationError(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

export function classifyMediaGenerationError(error: unknown, model?: string): MediaGenerationError {
    const candidate = (error || {}) as {
        status?: number;
        statusCode?: number;
        code?: number | string;
        message?: string;
    };
    const status = Number(candidate.status || candidate.statusCode || candidate.code) || undefined;
    const rawMessage = candidate.message || String(error || 'Unknown media generation error');
    const message = redactSensitiveMessage(rawMessage);
    const lower = message.toLowerCase();

    if (lower.includes('cancel')) {
        return { code: 'cancelled', message, retryable: false, model, status };
    }
    if (status === 401 || status === 403 || /api key|credential|unauth|permission denied/.test(lower)) {
        return { code: 'unauthorized', message, retryable: false, model, status };
    }
    if (status === 429 || /quota|resource exhausted|rate limit/.test(lower)) {
        return { code: 'quota', message, retryable: true, model, status };
    }
    if (/safety|blocked|rai|responsible ai|prohibited content/.test(lower)) {
        return { code: 'safety_filtered', message, retryable: false, model, status };
    }
    // Only "this model is not served" moves on to the next model; a request option a model does not support is
    // an invalid request, not a reason to substitute another model.
    if (status === 404 || /model.+not (found|supported)|unsupported model/.test(lower)) {
        return { code: 'unsupported', message, retryable: false, model, status };
    }
    if (status === 400 || /invalid argument|bad request/.test(lower)) {
        return { code: 'invalid_request', message, retryable: false, model, status };
    }
    if (!status || status >= 500 || /timeout|temporar|unavailable|network|fetch failed/.test(lower)) {
        return { code: 'transient', message, retryable: true, model, status };
    }
    return { code: 'internal', message, retryable: false, model, status };
}

function redactSensitiveMessage(message: string): string {
    return message
        .replace(/(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,})/g, '[REDACTED_API_KEY]')
        .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}
