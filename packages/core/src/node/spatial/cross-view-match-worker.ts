/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * A worker of CrossViewMatchPool: holds the frames' photo maps (shared, read-only) and the frames' current depths
 * (shared, written by the pool before each job), takes pairs from the shared index and posts each pair's
 * matchFramePair result on its port.
 */

import { parentPort, workerData, type MessagePort } from 'worker_threads';
import { matchFramePair, type PairFrameData, type PairMatchParams } from './StreetViewCrossViewRefiner';
import type { FrameCamera } from './StreetViewPoseRegistrar';

interface SharedIntegral { s: SharedArrayBuffer; s2: SharedArrayBuffer; w: number }

/** workerData of a cross-view match worker (the pool imports this type, which also keeps this file in compiled builds). */
export interface CrossViewMatchWorkerInit {
    ctrl: SharedArrayBuffer;
    port: MessagePort;
    frames: Array<{ width: number; height: number; lum: SharedArrayBuffer; valid: SharedArrayBuffer; bp: SharedArrayBuffer; bpHalf: SharedArrayBuffer; bpI: SharedIntegral; bpHalfI: SharedIntegral; depth: SharedArrayBuffer }>;
}

const init = workerData as CrossViewMatchWorkerInit;
const ctrl = new Int32Array(init.ctrl);
const integral = (x: SharedIntegral) => ({ s: new Float64Array(x.s), s2: new Float64Array(x.s2), w: x.w });
const frames = init.frames.map(f => ({
    lum: new Float32Array(f.lum), valid: new Uint8Array(f.valid), bp: new Float32Array(f.bp), bpHalf: new Float32Array(f.bpHalf),
    bpI: integral(f.bpI), bpHalfI: integral(f.bpHalfI), depth: new Float32Array(f.depth)
}));

parentPort!.on('message', (job: { id: number; cams: FrameCamera[]; order: Array<[number, number]>; params: PairMatchParams }) => {
    const data = (i: number): PairFrameData => ({ cam: job.cams[i], ...frames[i] });
    try {
        for (;;) {
            const i = Atomics.add(ctrl, 0, 1);
            if (i >= job.order.length) break;
            const [a, b] = job.order[i];
            init.port.postMessage({ id: job.id, i, r: matchFramePair(a, b, data(a), data(b), job.params) });
        }
    } catch (err) {
        init.port.postMessage({ id: job.id, error: err instanceof Error ? err.message : String(err) });
    } finally {
        Atomics.add(ctrl, 1, 1);
        Atomics.notify(ctrl, 1);
    }
});

Atomics.add(ctrl, 2, 1);
Atomics.notify(ctrl, 2);
