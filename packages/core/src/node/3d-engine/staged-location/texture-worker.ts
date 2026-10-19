/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A texture worker thread (texture-worker-pool.ts owns them): runs the texture stage's CPU work, the shared sources
 * (prepareTextureSources) and one layer's whole pass (textureLayer), off the server's main thread. The code is the same
 * the main thread runs, so the results are the same bit for bit. The layer's model enhancement calls are sent back to the
 * main thread (the model client lives there); progress is posted as it comes. After a layer the worker keeps its
 * leave-one-pano-out job until it is run ('loo') or dropped ('release').
 */

import { parentPort } from 'worker_threads';
import type { EnhanceModelAnswer, EnhanceModelClient } from './texture-enhance';
import { textureLayer, type TextureLayerOutcome } from './texture-pass';
import { prepareTextureSources, textureSourcesToWire } from './texture-sources';
import { tileSurfaceFromState } from './tile-texture-transfer';
import { ownedBytes, shareDeep, wireError, errorFromWire, type ToWorker, type FromWorker } from './texture-worker-protocol';

const port = parentPort;
if (!port) throw new Error('texture-worker.ts runs only as a worker thread');

const post = (m: FromWorker, transfer: Transferable[] = []) => port.postMessage(m, transfer as never);

/** The job in hand: its stop and, for a layer, the enhancement calls waiting on the main thread. */
let current: { id: number; ctl: AbortController } | undefined;
const enhanceCalls = new Map<number, { resolve: (a: EnhanceModelAnswer) => void; reject: (e: Error) => void }>();
let nextCall = 0;
/** The last layer's leave-one-pano-out job, kept for 'loo'. */
let loo: NonNullable<TextureLayerOutcome['measureLoo']> | undefined;

function enhanceProxy(id: number, purpose?: 'lighting'): EnhanceModelClient {
    return request => new Promise<EnhanceModelAnswer>((resolve, reject) => {
        const callId = ++nextCall;
        const { signal, ...wire } = request;
        if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('stopped'), { name: 'AbortError' })); return; }
        enhanceCalls.set(callId, { resolve, reject });
        signal?.addEventListener('abort', () => {
            if (!enhanceCalls.delete(callId)) return;
            post({ type: 'enhance-abort', id, callId });
            reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('stopped'), { name: 'AbortError' }));
        }, { once: true });
        post({ type: 'enhance', id, callId, request: wire, ...(purpose ? { purpose } : {}) });
    });
}

async function run(id: number, work: (signal: AbortSignal) => Promise<{ value: unknown; transfer?: Transferable[] }>): Promise<void> {
    const ctl = new AbortController();
    current = { id, ctl };
    try {
        const { value, transfer } = await work(ctl.signal);
        post({ type: 'result', id, value }, transfer);
    } catch (err) {
        post({ type: 'error', id, error: wireError(err) });
    } finally {
        if (current?.id === id) current = undefined;
    }
}

port.on('message', (msg: ToWorker) => {
    switch (msg.type) {
        case 'prepare':
            void run(msg.id, async () => {
                // into shared memory once here, so every layer's worker reads the same views and meshes without a copy
                const wire = shareDeep(textureSourcesToWire(prepareTextureSources(msg.input)));
                return { value: wire };
            });
            break;
        case 'texture':
            loo = undefined;
            void run(msg.id, async signal => {
                const src = msg.src;
                const out = await textureLayer(msg.layer, {
                    ...src, ...(msg.tile ? { tile: tileSurfaceFromState(msg.tile) } : {}),
                    ...(msg.enhance ? { enhance: { client: enhanceProxy(msg.id), ...(msg.enhance.models ? { models: msg.enhance.models } : {}), ...(msg.enhance.budgetMs ? { budgetMs: msg.enhance.budgetMs } : {}) } } : {}),
                    ...(msg.lighting ? { lighting: { client: enhanceProxy(msg.id, 'lighting'), models: msg.lighting.models } } : {}),
                    signal, onProgress: message => post({ type: 'progress', id: msg.id, message })
                });
                const { glb, measureLoo, ...rest } = out;
                loo = measureLoo;
                const bytes = ownedBytes(glb);
                return { value: { ...rest, glb: bytes, hasLoo: !!measureLoo }, transfer: [bytes.buffer as ArrayBuffer] };
            });
            break;
        case 'loo':
            void run(msg.id, async () => {
                const job = loo;
                loo = undefined;
                if (!job) throw new Error('this worker holds no leave-one-pano-out job');
                return { value: await job(msg.budgetMs) };
            });
            break;
        case 'release':
            loo = undefined;
            break;
        case 'abort':
            if (current?.id === msg.id) current.ctl.abort(Object.assign(new Error('the texture pass was stopped'), { name: 'AbortError' }));
            break;
        case 'enhance-result': {
            const call = enhanceCalls.get(msg.callId);
            if (!call) break;
            enhanceCalls.delete(msg.callId);
            if (msg.error) call.reject(errorFromWire(msg.error));
            else call.resolve(msg.answer!);
            break;
        }
    }
});

post({ type: 'ready' });
