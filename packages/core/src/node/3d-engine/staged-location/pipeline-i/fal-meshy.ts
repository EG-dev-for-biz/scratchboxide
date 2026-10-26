/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline I/J's Meshy alternative: Meshy 7.1 multi-image-to-3D on Fal.ai (meshy/v7.1/multi-image-to-3d, Meshy's own
 * partner namespace, not fal-ai/...), given 1-4 views of one structure in one request: remeshed, 2k geometry, textured.
 * This endpoint takes no seed (its own `seed` is output-only, not settable), unlike Trellis. Without a FAL_KEY it
 * throws MissingInputError; a failed or timed-out job throws GeneratorFailedError. It never returns a stand-in model.
 */

import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import { createFalQueue, type FetchFn } from './fal-queue';
export { resolveFalKey } from './fal-queue';

export const MESHY_MODEL = 'meshy/v7.1/multi-image-to-3d';

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

/** Meshy 7.1 multi-image-to-3d: remeshed, 2k geometry, textured (its real input fields; no texture-resolution knob). */
export const MESHY_SETTINGS = { should_remesh: true, geometry_resolution: '2k', should_texture: true } as const;

export function createFalMeshyClient(opts: ClientOpts = {}): ModelClient {
    const q = createFalQueue('pipeline-i-meshy', opts);
    let uploaded: { images: Buffer[]; urls: Promise<string[]> } | undefined;
    return {
        model: MESHY_MODEL,
        async generate(images, { signal, timeoutMs, seed, onProgress }) {
            // the seeds of one build share the same views: upload them once
            if (!uploaded || uploaded.images.length !== images.length || uploaded.images.some((b, i) => b !== images[i])) uploaded = { images, urls: uploadAll(q, images, 'pipeline-i-meshy', signal) };
            // this endpoint has no seed input (its own `seed` is output-only): the caller's seed is kept only for bookkeeping
            const body = { image_urls: await uploaded.urls, ...MESHY_SETTINGS };
            const r = await q.run(MESHY_MODEL, body, res => res?.model_glb?.url || res?.model_urls?.glb?.url, { signal, timeoutMs, onProgress });
            return { ...r, model: MESHY_MODEL, ...(seed !== undefined ? { seed } : {}) };
        }
    };
}
