/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const IMAGE_MODEL_PRIORITY = [
    'nano-banana-2',
    'google/nano-banana-pro',
    'gemini-3.1-flash-image',
    'imagen-3.0-generate-002',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image'
];

export const IMAGE_MODEL_PRIORITY_DRAFT = [
    'nano-banana-lite',
    'gemini-2.5-flash-image',
    'gemini-3.1-flash-image',
    'nano-banana-2'
];

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
    modelUsed: string;
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
    if (status === 404 || /model.+not found|unsupported model|not supported/.test(lower)) {
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
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
        .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}
