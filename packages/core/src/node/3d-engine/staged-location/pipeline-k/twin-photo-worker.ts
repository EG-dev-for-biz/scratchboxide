/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The twin's photo thread (twin-photo-thread.ts owns it): runs prepareTwinPhotos and finishTwinPhotos (twin-photo-passes.ts)
 * on the GLB it was started with, one call at a time; the photos and masks come and go by transfer, the steps and progress
 * lines are sent as they happen.
 */

import { parentPort, workerData } from 'worker_threads';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { finishTwinPhotos, prepareTwinPhotos, type TwinFinishOptions, type TwinPrepareOptions } from './twin-photo-passes';
import { transferListOf } from './twin-photo-thread';

const port = parentPort;
if (!port) throw new Error('twin-photo-worker.ts runs only as a worker thread');

const { json, bin } = workerData as { json: any; bin: Uint8Array };
const g = { json, bin };

type Call = { id: number; cmd: 'prepare'; o: TwinPrepareOptions } | { id: number; cmd: 'finish'; images: Map<number, RgbaImage8>; surfaces?: Map<number, Uint8Array>; o: TwinFinishOptions };

// one call at a time, in the order sent
let queue: Promise<void> = Promise.resolve();
port.on('message', (msg: Call) => {
    queue = queue.then(async () => {
        try {
            if (msg.cmd === 'prepare') {
                const prepared = prepareTwinPhotos(g, json, msg.o);
                port.postMessage({ id: msg.id, ok: prepared }, transferListOf(prepared.photos.map(p => p.delit), prepared.surfaces?.values()));
            } else {
                const report = await finishTwinPhotos(g, json, msg.images, msg.surfaces, msg.o, {
                    onStep: (step, state) => port.postMessage({ id: msg.id, step: [step, state] }),
                    progress: message => port.postMessage({ id: msg.id, progress: message })
                });
                const ok = { images: msg.images, ...(msg.surfaces ? { surfaces: msg.surfaces } : {}), report };
                port.postMessage({ id: msg.id, ok }, transferListOf(msg.images.values(), msg.surfaces?.values()));
            }
        } catch (err) {
            port.postMessage({ id: msg.id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
        }
    });
});
