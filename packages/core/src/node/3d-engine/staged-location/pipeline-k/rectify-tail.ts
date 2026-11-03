/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The straightened orthos' tail in rectifyReliefOrthos (pipeline-k.ts), off the server's main thread: the holes the facades'
 * own repeats left, the featureless photo continued from facades facing the same way (continueFeatureless), the smooth
 * fill of what no source covers, and the changed orthos written back as PNG. On the Empire State Building this held the
 * main thread for 15-20 s after the straightening workers returned. Two steps, because the image model's inpaint (a
 * network call with the server's client) sits between them on the main thread: `continue`, then `finish`. One worker
 * thread (rectify-tail-worker.ts) runs both with the very functions below, the images passed back and forth without a copy,
 * so the orthos and reports are the same bytes as on this thread (`inline`, and SCRATCHBOX_REMESH_WORKERS=0).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from '../../../worker-ts-register';
import { encodePng } from '../png-encode';
import { smoothFillHoles } from './ortho-rectify';
import { continueFeatureless, type ContinuedFill, type FacadeImage } from './pipeline-k';

/** The holes the facades' own repeats left: uncovered texels still the exact grey of the uncovered mark. */
export function holesOf(x: FacadeImage): Uint8Array {
    const N = x.width * x.height, out = new Uint8Array(N), p = x.rgba, u = x.uncovered;
    for (let i = 0; i < N; i++) if (u?.[i] && p[i * 4 + 3] && p[i * 4] === 128 && p[i * 4 + 1] === 128 && p[i * 4 + 2] === 128) out[i] = 1;
    return out;
}

export function countOf(m: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < m.length; i++) n += m[i];
    return n;
}

export interface ContinueResult {
    /** The featureless fill per facade it ran on. */
    continued: Map<number, ContinuedFill>;
    /** The facades with holes, in the images' order; each one's texels the regions refilled. */
    holes: Array<{ id: number; fromRegions: number }>;
}

/** The holes marked featureless and the featureless photo continued (edits the images in place). */
export function continueTail(images: Map<number, FacadeImage>): ContinueResult {
    // the holes the facades' own repeats left: refilled with the smears, each region whole from one facade facing the same
    // way, aligned to the photo around it
    const holes0 = new Map<number, number>();
    for (const [id, x] of images) {
        const h = holesOf(x), n = countOf(h);
        if (!n) continue;
        holes0.set(id, n);
        const fl = x.featureless ? Uint8Array.from(x.featureless) : new Uint8Array(h.length);
        for (let i = 0; i < h.length; i++) if (h[i]) fl[i] = 1;
        x.featureless = fl;
    }
    const continued = continueFeatureless(images);
    return { continued, holes: [...holes0].map(([id, n]) => ({ id, fromRegions: n - countOf(holesOf(images.get(id)!)) })) };
}

/** What no real source covers filled smoothly, and every changed ortho written into `dir` (edits the images in place). */
export function finishTail(images: Map<number, FacadeImage>, dir: string, continuedIds: number[], holeIds: number[]): Map<number, number> {
    const fromSmooth = new Map<number, number>();
    for (const id of holeIds) {
        const x = images.get(id)!;
        fromSmooth.set(id, smoothFillHoles({ width: x.width, height: x.height, rgba: x.rgba }, holesOf(x)));
    }
    for (const id of new Set([...continuedIds, ...holeIds])) {
        const x = images.get(id)!;
        fs.writeFileSync(path.join(dir, x.f.image), encodePng(x.width, x.height, x.rgba, 4));
    }
    return fromSmooth;
}

export type TailRequest =
    | { op: 'continue'; images: Map<number, FacadeImage> }
    | { op: 'finish'; images: Map<number, FacadeImage>; dir: string; continuedIds: number[]; holeIds: number[] };
export type TailReply =
    | { op: 'continue'; images: Map<number, FacadeImage>; result: ContinueResult }
    | { op: 'finish'; fromSmooth: Map<number, number> }
    | { error: string };
type TailAnswer = Exclude<TailReply, { error: string }>;

/** Every buffer an image map holds, to transfer it whole (each array a view over all of its own buffer). */
export function imageBuffers(images: Map<number, FacadeImage>): ArrayBuffer[] {
    const out = new Set<ArrayBuffer>();
    for (const x of images.values()) for (const a of [x.rgba, x.uncovered, x.featureless]) {
        if (a && a.buffer instanceof ArrayBuffer && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength) out.add(a.buffer);
    }
    return [...out];
}

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['rectify-tail-worker.js', 'rectify-tail-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`pipeline K: rectify-tail-worker not found beside ${dir}`);
}

/** The tail's two steps on one worker thread of its own; `close` ends it. */
export function startTailWorker(signal?: AbortSignal): { send: (req: TailRequest) => Promise<TailAnswer>; close: () => Promise<void> } {
    const worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry: workerEntry(), rectifyTail: true } });
    let pending: { resolve: (r: TailAnswer) => void; reject: (e: Error) => void } | undefined;
    const fail = (err: Error) => { const p = pending; pending = undefined; p?.reject(err); };
    worker.on('message', (r: TailReply) => {
        const p = pending; pending = undefined;
        if (!p) return;
        if ('error' in r) p.reject(new Error(`pipeline K: the orthos' tail failed on its worker thread: ${r.error}`)); else p.resolve(r);
    });
    worker.on('error', err => fail(err));
    worker.on('exit', code => fail(new Error(`pipeline K: the orthos' tail worker exited (code ${code})`)));
    const onAbort = () => { fail(signal!.reason instanceof Error ? signal!.reason : new Error('pipeline K: stopped')); void worker.terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    return {
        send: req => new Promise<TailAnswer>((resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error('pipeline K: stopped')); return; }
            pending = { resolve, reject };
            worker.postMessage(req, imageBuffers(req.images));
        }),
        close: async () => { signal?.removeEventListener('abort', onAbort); worker.removeAllListeners('exit'); await worker.terminate(); }
    };
}
