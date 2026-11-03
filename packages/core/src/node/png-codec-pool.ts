/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * PNG encode and decode off the server's event loop: encodePngAsync / decodePngAsync run png-encode.ts encodePng and
 * texture-processing.ts decodePng on a small pool of worker threads (png-codec-worker.ts). Same functions, same bundled
 * zlib, so the bytes are the synchronous calls' bytes exactly; only where the work runs changes. A native codec was not
 * used: another deflate (system zlib, libdeflate) does not reproduce Node's bundled zlib byte for byte.
 *
 * The caller's pixels or PNG are copied into a buffer of their own before they go (the caller's arrays are never
 * detached); the answer comes back transferred. Images under INLINE_MAX_BYTES run on the calling thread, where a worker
 * round trip would cost more than it saves. Workers: SCRATCHBOX_PNG_WORKERS, else one fewer than the cores, at most 4; 0
 * runs every call inline. A worker holds the process open only while it has work; one that dies fails what it held and is
 * replaced on the next call.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from './worker-ts-register';
import { encodePng } from './3d-engine/staged-location/png-encode';
import { decodePng, type DecodedImage } from './texture-processing';

export type PngCodecRequest =
    | { id: number; op: 'encode'; width: number; height: number; channels: 1 | 3 | 4; pixels: ArrayBuffer }
    | { id: number; op: 'decode'; png: ArrayBuffer };
export type PngCodecReply = { id: number; bytes?: ArrayBuffer; width?: number; height?: number; error?: string };

/** Inputs smaller than this many bytes are coded on the calling thread. */
export const INLINE_MAX_BYTES = 64 * 1024;

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

/** Codec threads: SCRATCHBOX_PNG_WORKERS, else one fewer than the cores, at most 4. */
export function pngCodecThreads(): number {
    const n = Number(process.env.SCRATCHBOX_PNG_WORKERS);
    if (process.env.SCRATCHBOX_PNG_WORKERS !== undefined && Number.isFinite(n)) return Math.max(0, Math.floor(n));
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(4, cpus - 1));
}

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['png-codec-worker.js', 'png-codec-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`png-codec-worker not found beside ${dir}`);
}

interface Pending { resolve: (r: PngCodecReply) => void; reject: (e: Error) => void }
interface Slot { worker: Worker; pending: Map<number, Pending> }

let slots: Slot[] = [];
let nextId = 1, nextSlot = 0;

function spawn(): Slot {
    const worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry: workerEntry() } });
    const slot: Slot = { worker, pending: new Map() };
    worker.unref();
    const failAll = (err: Error) => {
        for (const p of slot.pending.values()) p.reject(err);
        slot.pending.clear();
        slots = slots.filter(s => s !== slot);
    };
    worker.on('message', (r: PngCodecReply) => {
        const p = slot.pending.get(r.id);
        if (!p) return;
        slot.pending.delete(r.id);
        if (!slot.pending.size) worker.unref();
        if (r.error !== undefined) p.reject(new Error(r.error)); else p.resolve(r);
    });
    worker.on('error', err => failAll(new Error(`a PNG codec worker failed: ${err.message}`)));
    worker.on('exit', code => { if (slot.pending.size) failAll(new Error(`a PNG codec worker exited (code ${code}) with work in hand`)); else slots = slots.filter(s => s !== slot); });
    return slot;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function submit(req: WithoutId<PngCodecRequest>, transfer: ArrayBuffer): Promise<PngCodecReply> {
    const want = pngCodecThreads();
    if (slots.length < want) slots.push(spawn());
    const slot = slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a), slots[nextSlot++ % slots.length]);
    const id = nextId++;
    return new Promise<PngCodecReply>((resolve, reject) => {
        slot.pending.set(id, { resolve, reject });
        slot.worker.ref();
        slot.worker.postMessage({ ...req, id } as PngCodecRequest, [transfer]);
    });
}

/** A copy of `bytes` in an ArrayBuffer of its own, safe to transfer. */
function ownCopy(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}

/** encodePng on a codec thread: the same PNG bytes, without blocking the event loop. */
export async function encodePngAsync(width: number, height: number, pixels: Uint8Array, channels: 1 | 3 | 4): Promise<Buffer> {
    if (pixels.byteLength < INLINE_MAX_BYTES || pngCodecThreads() === 0) return encodePng(width, height, pixels, channels);
    const pixelsCopy = ownCopy(pixels);
    const r = await submit({ op: 'encode', width, height, channels, pixels: pixelsCopy }, pixelsCopy);
    return Buffer.from(r.bytes!);
}

/** decodePng on a codec thread: the same pixels, without blocking the event loop. */
export async function decodePngAsync(pngBuffer: Buffer): Promise<DecodedImage> {
    if (pngBuffer.byteLength < INLINE_MAX_BYTES || pngCodecThreads() === 0) return decodePng(pngBuffer);
    const pngCopy = ownCopy(pngBuffer);
    const r = await submit({ op: 'decode', png: pngCopy }, pngCopy);
    const rgba = Buffer.from(r.bytes!);
    return { width: r.width!, height: r.height!, rgba, data: rgba };
}

/** Ends the codec threads (tests; a server leaves them, unreferenced, to the process). */
export async function closePngCodecPool(): Promise<void> {
    const all = slots;
    slots = [];
    await Promise.all(all.map(s => s.worker.terminate()));
}
