/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A GLTFLoader whose texture decodes are bounded and retried. A district opens a hundred models with tens of thousands
 * of embedded images at once; decoded all together, a few fail (createImageBitmap rejects under the load: 13 of 36,470
 * at Penn, 2026-11-05), and GLTFLoader then leaves that material without its texture for good: a grey building. Here
 * every loader shares one limit on decodes in flight, and a decode that fails is tried again after a pause before the
 * failure is reported.
 */

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const TEXTURE_DECODE = {
    /** Decodes in flight across every loader, at most. */
    concurrency: 16,
    /** Tries per texture, and the pause before the n-th retry (ms x n). */
    attempts: 3,
    retryPauseMs: 250
};

type Load = (url: string, onLoad: (data: unknown) => void, onProgress?: (event: ProgressEvent) => void, onError?: (err: unknown) => void) => unknown;

/** Runs at most `n` tasks at once, in the order asked. */
export function decodeLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async task => {
        if (active >= n) await new Promise<void>(go => waiting.push(go));
        active++;
        try { return await task(); } finally { active--; waiting.shift()?.(); }
    };
}

const shared = decodeLimiter(TEXTURE_DECODE.concurrency);

/** `load` bounded by `limit` and retried: resolves through onLoad once, or through onError after the last try fails. */
export function resilientLoad(load: Load, limit = shared, P = TEXTURE_DECODE, pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Load {
    return (url, onLoad, onProgress, onError) => {
        void limit(async () => {
            let last: unknown;
            for (let attempt = 1; attempt <= P.attempts; attempt++) {
                try {
                    onLoad(await new Promise<unknown>((resolve, reject) => { load(url, resolve, onProgress, reject); }));
                    return;
                } catch (err) {
                    last = err;
                    if (attempt < P.attempts) await pause(P.retryPauseMs * attempt);
                }
            }
            onError?.(last);
        });
        return undefined;
    };
}

/** A GLTFLoader whose parsers decode their textures through resilientLoad. */
export function createGltfLoader(): GLTFLoader {
    const loader = new GLTFLoader();
    loader.register(parser => {
        const textureLoader = (parser as unknown as { textureLoader?: { load: Load } }).textureLoader;
        if (textureLoader) textureLoader.load = resilientLoad(textureLoader.load.bind(textureLoader));
        return { name: 'SB_resilient_textures' };
    });
    return loader;
}
