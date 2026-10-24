/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline I's 3D model service: Trellis multi on Fal.ai (fal-ai/trellis/multi), given the four character-sheet views of one
 * structure in one request, as tested on Puck ("D", user decision 2026-10-24): multidiffusion across the views, 25 + 25
 * sampling steps, a 2048 texture, one seed per call (pipeline I runs several and keeps the best). About $0.02 a call.
 * Without a FAL_KEY it throws MissingInputError; a failed or timed-out job throws GeneratorFailedError. It never returns a
 * stand-in model.
 */

import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import { createFalQueue, type FetchFn } from './fal-queue';
export { resolveFalKey } from './fal-queue';

export const TRELLIS_MODEL = 'fal-ai/trellis/multi';

export interface ModelResult {
    glb: Buffer;
    requestId: string;
    seconds: number;
    model: string;
    seed?: number;
}

/** A 3D model service of pipeline I (the Fal clients below, or a test double). */
export interface ModelClient {
    readonly model: string;
    generate(images: Buffer[], opts: { signal?: AbortSignal; timeoutMs: number; seed?: number; onProgress?: (msg: string) => void }): Promise<ModelResult>;
}

type ClientOpts = { falKey?: string; fetch?: FetchFn; pollMs?: number; sleep?: (ms: number) => Promise<void> };

async function uploadAll(q: ReturnType<typeof createFalQueue>, images: Buffer[], tool: string, signal?: AbortSignal): Promise<string[]> {
    if (images.length < 1 || images.length > 4) throw new MissingInputError(tool, 'images', `takes 1 to 4 views of one object, got ${images.length}`);
    const urls: string[] = [];
    for (let i = 0; i < images.length; i++) urls.push(await q.upload(images[i], `view_${i + 1}.png`, signal));
    return urls;
}

/** Trellis multi as tested on Puck ("D"): multidiffusion, 25 + 25 steps, 2048 texture; the seed is the caller's. */
export const TRELLIS_SETTINGS = { multiimage_algo: 'multidiffusion', ss_sampling_steps: 25, slat_sampling_steps: 25, ss_guidance_strength: 7.5, slat_guidance_strength: 3, mesh_simplify: 0.95, texture_size: 2048 } as const;

export function createFalTrellisClient(opts: ClientOpts = {}): ModelClient {
    const q = createFalQueue('pipeline-i-trellis', opts);
    let uploaded: { images: Buffer[]; urls: Promise<string[]> } | undefined;
    return {
        model: TRELLIS_MODEL,
        async generate(images, { signal, timeoutMs, seed, onProgress }) {
            // the seeds of one build share the same views: upload them once
            if (!uploaded || uploaded.images.length !== images.length || uploaded.images.some((b, i) => b !== images[i])) uploaded = { images, urls: uploadAll(q, images, 'pipeline-i-trellis', signal) };
            const body = { image_urls: await uploaded.urls, ...TRELLIS_SETTINGS, ...(seed !== undefined ? { seed } : {}) };
            const r = await q.run(TRELLIS_MODEL, body, res => res?.model_mesh?.url, { signal, timeoutMs, onProgress });
            return { ...r, model: TRELLIS_MODEL, ...(seed !== undefined ? { seed } : {}) };
        }
    };
}
