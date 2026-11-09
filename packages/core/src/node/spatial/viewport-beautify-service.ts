/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Quick AI Beautify of the 3D viewport's current frame (the viewport tool rail's one-click button,
 * QuickBeautifyButton.tsx, through POST /api/viewport-beautify): the frame exactly as framed goes to the image model
 * with the app's standard AI Beautify prompt, and the photograph comes back as PNG bytes for the browser to download.
 *
 * The picture is the deliverable, a final 2D image, so it keeps the scene's own light (AGENTS.md §4, "AI Beautify
 * light and outline": `lighting: 'scene'`), never the even overcast light of the station beautifies that feed 3D.
 */

import {
    buildBeautifyPrompt,
    buildClayRenderBeautifyPrompt
} from '../../browser/generative-canvas/services/location-beautify-service';
import {
    IMAGE_MODEL_ALIASES,
    IMAGE_MODEL_PRIORITY,
    nearestImageAspectRatio,
    type ImageGenerationRequest,
    type MediaAssetRef,
    type MediaGenerationResult
} from '../../common/media-generation-protocol';
import { ensureStationPng } from './BeautifyStationService';

/**
 * The image models a quick beautify asks, in order: Nano Banana Lite first (the fastest and cheapest), then the
 * standard Nano Banana models when Lite is not served. Change the quick pass's model here.
 */
export const QUICK_BEAUTIFY_IMAGE_MODELS: readonly string[] = [IMAGE_MODEL_ALIASES['nano-banana-lite'], ...IMAGE_MODEL_PRIORITY];

/** Output size of a quick beautify (Lite makes no 2K image). Change the quick pass's size here. */
export const QUICK_BEAUTIFY_IMAGE_SIZE: '1K' | '2K' | '4K' = '1K';

/** Said in every quick beautify prompt: the picture is final, so the light the viewport shows is the light it keeps. */
export const KEEP_SCENE_LIGHT_SENTENCE = 'Keep the light exactly as the reference shows it: the same sun direction, cast shadows, sky, clouds and time of day. This photograph is the final image, so do not relight it.';

export interface ViewportBeautifyContext {
    /** What the scene is called (the canvas title), used to name the subject when no real place is known. */
    sceneName: string;
    /** The real place the scene is staged at (Scene3DData.geoAnchor), when it has one. */
    place?: { name?: string; lat: number; lng: number };
    /** Compass heading of the camera's view, degrees clockwise from north (only meaningful with a place). */
    headingDeg?: number;
    pitchDeg?: number;
    fovDeg?: number;
    /** Camera to the orbit target, metres. */
    subjectDistanceM?: number;
    /** Pixel size of the captured frame; its aspect picks the nearest aspect ratio the image model accepts. */
    width: number;
    height: number;
}

/**
 * The quick beautify prompt: buildBeautifyPrompt for a scene staged at a real place (named, with its coordinates and
 * the camera's heading), else buildClayRenderBeautifyPrompt (no place, coordinates or heading are claimed), each with
 * the scene's light kept. Both carry the standard non-negotiable framing rules, so the camera framing is unchanged.
 */
export function buildViewportBeautifyPrompt(ctx: ViewportBeautifyContext): { prompt: string; aspectRatio: string } {
    const aspectRatio = nearestImageAspectRatio(ctx.width, ctx.height);
    const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);
    const name = ctx.place?.name?.trim() || ctx.sceneName.trim() || 'the scene';
    if (ctx.place && Number.isFinite(ctx.place.lat) && Number.isFinite(ctx.place.lng)) {
        const prompt = buildBeautifyPrompt({
            locationName: name,
            coordinates: { lat: ctx.place.lat, lng: ctx.place.lng },
            heading: finite(ctx.headingDeg),
            pitch: finite(ctx.pitchDeg),
            fovDegrees: finite(ctx.fovDeg),
            subjectDistance: finite(ctx.subjectDistanceM),
            aspectRatio,
            moodPromptContext: KEEP_SCENE_LIGHT_SENTENCE
        });
        return { prompt, aspectRatio };
    }
    const dist = finite(ctx.subjectDistanceM);
    const prompt = buildClayRenderBeautifyPrompt({
        subject: name,
        aspectRatio,
        moodPromptContext: KEEP_SCENE_LIGHT_SENTENCE,
        ...(dist !== undefined ? { subjectDistanceHint: ` Subject distance: approximately ${Math.round(dist)} meters from camera (use this for depth-of-field and focus).` } : {})
    });
    return { prompt, aspectRatio };
}

export interface ViewportBeautifyDeps {
    mediaService: { generateImage(req: ImageGenerationRequest, options?: { signal?: AbortSignal; inlineSource?: { data: Buffer; mimeType: string } }): Promise<MediaGenerationResult> };
    assetStore: { resolve(workspaceRoot: string, asset: MediaAssetRef): string };
    workspaceRoot: string;
    readFile?: (path: string) => Promise<Buffer>;
}

export interface ViewportBeautifyResult {
    png: Buffer;
    modelUsed: string;
    modelNote?: string;
    aspectRatio: string;
    imageSize: string;
    prompt: string;
}

/**
 * Beautifies one captured viewport frame. The frame is sent inline as the source image (never stored); the answer is
 * converted to PNG. Model and credential failures are thrown as they are, never replaced by an image.
 */
export async function beautifyViewportFrame(
    frame: { bytes: Buffer; mimeType: string },
    ctx: ViewportBeautifyContext,
    deps: ViewportBeautifyDeps,
    signal?: AbortSignal
): Promise<ViewportBeautifyResult> {
    if (!frame.bytes.length) throw new Error('the viewport frame is empty');
    const { prompt, aspectRatio } = buildViewportBeautifyPrompt(ctx);
    const res = await deps.mediaService.generateImage({
        kind: 'image',
        idempotencyKey: `viewport_beautify_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        prompt,
        workspaceRoot: deps.workspaceRoot,
        aspectRatio: aspectRatio as ImageGenerationRequest['aspectRatio'],
        imageSize: QUICK_BEAUTIFY_IMAGE_SIZE,
        modelPriority: [...QUICK_BEAUTIFY_IMAGE_MODELS]
    }, { signal, inlineSource: { data: frame.bytes, mimeType: frame.mimeType } });
    const read = deps.readFile ?? (async (p: string) => (await import('fs-extra')).readFile(p));
    const png = await ensureStationPng(await read(deps.assetStore.resolve(deps.workspaceRoot, res.asset)));
    return { png, modelUsed: res.modelUsed, modelNote: res.modelNote, aspectRatio, imageSize: QUICK_BEAUTIFY_IMAGE_SIZE, prompt };
}
