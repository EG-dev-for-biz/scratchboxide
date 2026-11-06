/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The twin's texel passes (twin-photo-passes.ts) on a worker thread of their own, so the build's thread is not frozen while
 * they run: in an uncached Empire State Building build (run 18d04782, 2026-11-06) the de-light, roof-shadow lift, its QA and
 * harmonising froze it for 126 s in two stretches, and nothing else on it (the ownership stage beside the twin, the run's
 * model calls) could move. The worker runs the same functions on the same inputs, so the photos and reports are the same
 * bit for bit. The GLB's binary chunk goes to it once, in shared memory; the photos and masks move back and forth by
 * transfer (no copy). SCRATCHBOX_K_TWIN_THREAD=0 runs them on the calling thread instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from '../../../worker-ts-register';
import type { ParsedGlb } from '../glb-bytes';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { shareDeep } from '../texture-worker-protocol';
import { finishTwinPhotos, prepareTwinPhotos, type TwinFinishOptions, type TwinFinished, type TwinPassHooks, type TwinPrepared, type TwinPrepareOptions } from './twin-photo-passes';

export class TwinPhotoThreadError extends Error {
    readonly code = 'twin_photo_thread_failed';
    constructor(message: string) { super(message); this.name = 'TwinPhotoThreadError'; }
}

/** The twin's texel passes, wherever they run: prepare, then finish, then close. */
export interface TwinPhotoPasses {
    /** Where they run: 'thread' (a worker thread) or 'inline' (the calling thread). */
    readonly where: 'thread' | 'inline';
    prepare(o: TwinPrepareOptions): Promise<TwinPrepared>;
    /** The passes after the de-light on `images` and `surfaces` (handed over: the caller uses the returned ones from here on). */
    finish(images: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array> | undefined, o: TwinFinishOptions, hooks?: TwinPassHooks): Promise<{ images: Map<number, RgbaImage8>; surfaces?: Map<number, Uint8Array>; report: TwinFinished }>;
    close(): void;
}

/** On a worker thread unless SCRATCHBOX_K_TWIN_THREAD is 0 (or off). */
export function twinPhotoThreadOn(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env.SCRATCHBOX_K_TWIN_THREAD?.trim().toLowerCase();
    return !(v === '0' || v === 'off' || v === 'false');
}

/** The passes for the textured GLB `g` (its JSON `json`, as the passes are to read it): on a worker thread unless switched off. */
export function twinPhotoPasses(g: ParsedGlb, json: any, opts: { thread?: boolean } = {}): TwinPhotoPasses {
    return (opts.thread ?? twinPhotoThreadOn()) ? new ThreadPasses(g, json) : new InlinePasses(g, json);
}

class InlinePasses implements TwinPhotoPasses {
    readonly where = 'inline' as const;
    constructor(private readonly g: ParsedGlb, private readonly json: any) {}
    async prepare(o: TwinPrepareOptions): Promise<TwinPrepared> { return prepareTwinPhotos(this.g, this.json, o); }
    async finish(images: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array> | undefined, o: TwinFinishOptions, hooks: TwinPassHooks = {}) {
        const report = await finishTwinPhotos(this.g, this.json, images, surfaces, o, hooks);
        return { images, ...(surfaces ? { surfaces } : {}), report };
    }
    close(): void { /* nothing held */ }
}

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['twin-photo-worker.js', 'twin-photo-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new TwinPhotoThreadError(`twin-photo-worker not found beside ${dir}`);
}

/** The buffers under the photos and masks given, to transfer: each once, only whole ones of their own (not shared memory, not Node's small-buffer pool). */
export function transferListOf(images: Iterable<RgbaImage8>, masks?: Iterable<Uint8Array>): ArrayBuffer[] {
    const seen = new Set<ArrayBuffer>();
    const add = (a: Uint8Array) => { const b = a.buffer; if (b instanceof ArrayBuffer && b.byteLength >= 65536 && b.byteLength === a.byteLength) seen.add(b); };
    for (const im of images) add(im.rgba);
    if (masks) for (const m of masks) add(m);
    return [...seen];
}

type Reply = { id: number; ok?: unknown; error?: string; step?: [string, 'running' | 'done' | 'failed']; progress?: string };

class ThreadPasses implements TwinPhotoPasses {
    readonly where = 'thread' as const;
    private readonly worker: Worker;
    private nextId = 0;
    private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; hooks: TwinPassHooks }>();
    private dead: Error | undefined;

    constructor(g: ParsedGlb, json: any) {
        // the same heap ceiling as the thread asking (harmonising holds millions of samples)
        const heapMb = Math.floor(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
        this.worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry: workerEntry(), json, bin: shareDeep(g.bin) }, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
        this.worker.on('message', (m: Reply) => {
            const p = this.pending.get(m.id);
            if (!p) return;
            if (m.step) { p.hooks.onStep?.(m.step[0], m.step[1]); return; }
            if (m.progress !== undefined) { p.hooks.progress?.(m.progress); return; }
            this.pending.delete(m.id);
            if (m.error !== undefined) p.reject(new TwinPhotoThreadError(`the twin's photo passes failed on their thread: ${m.error}`));
            else p.resolve(m.ok);
        });
        this.worker.on('error', err => this.fail(new TwinPhotoThreadError(`the twin's photo thread crashed: ${err.message}`)));
        this.worker.on('exit', code => this.fail(new TwinPhotoThreadError(`the twin's photo thread exited (code ${code}) with work outstanding`)));
    }

    private fail(err: Error): void {
        this.dead = this.dead ?? err;
        for (const p of this.pending.values()) p.reject(this.dead);
        this.pending.clear();
    }

    private call<T>(msg: Record<string, unknown>, transfer: ArrayBuffer[], hooks: TwinPassHooks = {}): Promise<T> {
        if (this.dead) return Promise.reject(this.dead);
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, hooks });
            this.worker.postMessage({ id, ...msg }, transfer);
        });
    }

    prepare(o: TwinPrepareOptions): Promise<TwinPrepared> { return this.call<TwinPrepared>({ cmd: 'prepare', o }, []); }

    finish(images: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array> | undefined, o: TwinFinishOptions, hooks: TwinPassHooks = {}) {
        return this.call<{ images: Map<number, RgbaImage8>; surfaces?: Map<number, Uint8Array>; report: TwinFinished }>({ cmd: 'finish', images, surfaces, o }, transferListOf(images.values(), surfaces?.values()), hooks);
    }

    close(): void {
        this.worker.removeAllListeners('exit');
        this.fail(new TwinPhotoThreadError("the twin's photo thread was closed"));
        void this.worker.terminate();
    }
}
