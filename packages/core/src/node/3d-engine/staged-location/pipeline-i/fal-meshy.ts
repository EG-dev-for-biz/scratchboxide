/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline I alternative: Meshy 7.1 multi on Fal.ai (fal-ai/meshy/multi), given 1-4 views of one
 * structure in one request (Ultra 2K mode): remesher enabled, 2048 texture resolution, one seed per call
 * (pipeline I can run several and keep the best). About $0.02 a call. Without a FAL_KEY it throws
 * MissingInputError; a failed or timed-out job throws GeneratorFailedError. It never returns a
 * stand-in model.
 */

import { MissingInputError } from '../../../../common/errors/pipeline-errors';
import { createFalQueue, type FetchFn } from './fal-queue';
export { resolveFalKey } from './fal-queue';

export const MESHY_MODEL = 'fal-ai/meshy/multi';

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

/** Meshy 7.1 Ultra 2K multi-view: remesher enabled, 2048 texture; the seed is the caller's. */
export const MESHY_SETTINGS = { enable_remesher: true, remeshing_threshold: 0.1, texture_resolution: 2048 } as const;

export function createFalMeshyClient(opts: ClientOpts = {}): ModelClient {
    const q = createFalQueue('pipeline-i-meshy', opts);
    let uploaded: { images: Buffer[]; urls: Promise<string[]> } | undefined;
    return {
        model: MESHY_MODEL,
        async generate(images, { signal, timeoutMs, seed, onProgress }) {
            // the seeds of one build share the same views: upload them once
            if (!uploaded || uploaded.images.length !== images.length || uploaded.images.some((b, i) => b !== images[i])) uploaded = { images, urls: uploadAll(q, images, 'pipeline-i-meshy', signal) };
            const body = { image_urls: await uploaded.urls, ...MESHY_SETTINGS, ...(seed !== undefined ? { seed } : {}) };
            const r = await q.run(MESHY_MODEL, body, res => res?.model_url || res?.mesh_url || res?.model_mesh?.url, { signal, timeoutMs, onProgress });
            return { ...r, model: MESHY_MODEL, ...(seed !== undefined ? { seed } : {}) };
        }
    };
}
