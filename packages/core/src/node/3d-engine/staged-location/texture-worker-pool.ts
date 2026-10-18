/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture stage's worker threads. The stage's CPU work (the shared sources, each layer's atlas, bake, transfer,
 * seams, fit and twin, and the leave-one-pano-out re-bakes) runs here instead of on the server's main thread, which a
 * layer used to hold for up to 90 s at a time: the vision calls running beside the stage then saw their timers fire
 * while their replies sat unread.
 *
 * - At most `size` jobs compute at once; a job waits for a slot. A worker that finished a layer keeps that layer's
 *   leave-one-pano-out job (parked, not computing) until it is run or released, then serves the next job.
 * - Inputs shared by every layer (views, meshes, the tile) go in shared memory once (shareDeep); a layer's own bytes and
 *   its twin are transferred, not copied.
 * - The stage's AbortSignal stops a job: the worker is asked to stop (so a native child it waits on is killed), then
 *   terminated; the job rejects with the signal's reason at once.
 * - A worker that dies (uncaught error, out of memory, exit) rejects its job with TextureWorkerCrashError.
 * - The model enhancement calls a layer makes come back here and run on the stage's own client.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from '../../worker-ts-register';
import type { EnhanceModelClient } from './texture-enhance';
import type { LooFit } from './texture-fit-metric';
import type { TextureLayerInput, TextureLayerOutcome, TexturePassSources } from './texture-pass';
import { textureSourcesFromWire, type TextureSources, type TextureSourcesInput, type TextureSourcesWire } from './texture-sources';
import { tileSurfaceState } from './tile-texture-transfer';
import { errorFromWire, ownedBytes, shareDeep, wireError, type FromWorker, type ToWorker, type WireOutcome } from './texture-worker-protocol';

/** A texture worker thread died before it answered (crash, out of memory, exit). */
export class TextureWorkerCrashError extends Error {
    readonly code = 'texture_worker_crashed';
    constructor(message: string, readonly exitCode?: number) {
        super(message);
        this.name = 'TextureWorkerCrashError';
    }
}

/**
 * Loads the worker entry (.js as is, .ts through ts-node with the server's own target, whatever tsconfig the working
 * directory has: an ES5 default target compiles for...of over a Set or Map to nothing).
 */
const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

/** How long a stopped worker gets to kill its native children before it is terminated. */
const ABORT_GRACE_MS = 1_000;

/** SCRATCHBOX_TEXTURE_WORKERS: '0' runs the texture stage on the main thread (as before); a number sets the pool size. */
export function textureWorkersEnabled(): boolean {
    return process.env.SCRATCHBOX_TEXTURE_WORKERS !== '0';
}

export function defaultTextureWorkerCount(): number {
    const n = Number(process.env.SCRATCHBOX_TEXTURE_WORKERS);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(4, cpus - 1));
}

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['texture-worker.js', 'texture-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`texture worker pool: texture-worker not found beside ${dir}`);
}

const abortError = (signal: AbortSignal): Error => signal.reason instanceof Error ? signal.reason : Object.assign(new Error('the texture pass was stopped'), { name: 'AbortError' });

interface Job {
    id: number;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    onProgress?: (m: string) => void;
    enhance?: EnhanceModelClient;
    signal?: AbortSignal;
    /** The enhancement calls in flight on the main thread, to stop with the job. */
    calls: Map<number, AbortController>;
}

/** One worker thread and the job it is doing. */
class TextureThread {
    readonly worker: Worker;
    private job?: Job;
    dead = false;
    private readonly ready: Promise<void>;

    constructor(entry: string, private readonly onDead: (t: TextureThread) => void, onExit: (code: number) => void) {
        this.worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry } });
        this.worker.unref();
        this.worker.once('exit', onExit);
        this.ready = new Promise<void>((resolve, reject) => {
            const onMsg = (m: FromWorker) => { if (m.type === 'ready') { this.worker.off('message', onMsg); resolve(); } };
            this.worker.on('message', onMsg);
            this.worker.once('exit', code => reject(new TextureWorkerCrashError(`the texture worker exited (code ${code}) while loading`, code)));
            this.worker.once('error', err => reject(new TextureWorkerCrashError(`the texture worker could not load: ${err.message}`)));
        });
        this.ready.catch(() => undefined);
        this.worker.on('message', (m: FromWorker) => this.onMessage(m));
        this.worker.on('error', err => this.die(new TextureWorkerCrashError(`the texture worker crashed: ${err?.message ?? String(err)}`)));
        this.worker.on('exit', code => this.die(new TextureWorkerCrashError(`the texture worker exited (code ${code}) before it answered`, code)));
    }

    get busy(): boolean { return !!this.job; }

    /** Resolves when the thread has loaded its modules, or could not (never rejects). */
    loaded(): Promise<void> { return this.ready.catch(() => undefined); }

    private die(err: Error): void {
        if (this.dead) return;
        this.dead = true;
        const job = this.job;
        this.job = undefined;
        if (job) { for (const c of job.calls.values()) c.abort(err); job.reject(err); }
        this.onDead(this);
    }

    /** Ends the thread; a job still on it rejects with TextureWorkerCrashError. */
    terminate(): void {
        const job = this.job;
        this.job = undefined;
        if (!this.dead) { this.dead = true; this.onDead(this); }
        if (job) { for (const c of job.calls.values()) c.abort(); job.reject(new TextureWorkerCrashError('the texture worker was terminated before it answered')); }
        void this.worker.terminate();
    }

    private onMessage(m: FromWorker): void {
        const job = this.job;
        if (m.type === 'ready' || !job || ('id' in m && m.id !== job.id)) return;
        switch (m.type) {
            case 'progress': job.onProgress?.(m.message); break;
            case 'enhance': {
                const ctl = new AbortController();
                job.calls.set(m.callId, ctl);
                const signal = job.signal ? AbortSignal.any([job.signal, ctl.signal]) : ctl.signal;
                const client = job.enhance;
                const answer = client ? client({ ...m.request, signal }) : Promise.reject(new Error('no model client was given for the enhancement'));
                answer.then(
                    a => { if (job.calls.delete(m.callId) && this.job === job) { const bytes = ownedBytes(a.bytes); this.post({ type: 'enhance-result', callId: m.callId, answer: { ...a, bytes } }, [bytes.buffer as ArrayBuffer]); } },
                    e => { if (job.calls.delete(m.callId) && this.job === job) this.post({ type: 'enhance-result', callId: m.callId, error: wireError(e) }); }
                );
                break;
            }
            case 'enhance-abort': job.calls.get(m.callId)?.abort(Object.assign(new Error('the enhancement call was stopped'), { name: 'AbortError' })); job.calls.delete(m.callId); break;
            case 'result': this.job = undefined; job.resolve(m.value); break;
            case 'error': this.job = undefined; for (const c of job.calls.values()) c.abort(); job.reject(errorFromWire(m.error)); break;
        }
    }

    private post(m: ToWorker, transfer: Transferable[] = []): void {
        if (!this.dead) this.worker.postMessage(m, transfer as never);
    }

    /** Runs one job; the signal stops it by terminating the thread. */
    async call<T>(msg: ToWorker & { id: number }, opts: { transfer?: Transferable[]; signal?: AbortSignal; onProgress?: (m: string) => void; enhance?: EnhanceModelClient } = {}): Promise<T> {
        await this.ready;
        if (this.dead) throw new TextureWorkerCrashError('the texture worker is gone');
        if (this.job) throw new Error('texture worker pool: a thread was given two jobs');
        const { signal } = opts;
        if (signal?.aborted) throw abortError(signal);
        return new Promise<T>((resolve, reject) => {
            const job: Job = { id: msg.id, resolve: v => { cleanup(); resolve(v as T); }, reject: e => { cleanup(); reject(e); }, calls: new Map(),
                ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(opts.enhance ? { enhance: opts.enhance } : {}), ...(signal ? { signal } : {}) };
            const onAbort = () => {
                if (this.job !== job) return;
                this.job = undefined;
                for (const c of job.calls.values()) c.abort(abortError(signal!));
                // asked to stop first (its native children are killed on its signal), then terminated
                this.post({ type: 'abort', id: msg.id });
                const t = setTimeout(() => this.terminate(), ABORT_GRACE_MS);
                t.unref();
                if (!this.dead) { this.dead = true; this.onDead(this); }
                reject(abortError(signal!));
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            signal?.addEventListener('abort', onAbort, { once: true });
            this.job = job;
            this.post(msg, opts.transfer);
        });
    }

    release(): void { this.post({ type: 'release' }); }
}

export interface TextureWorkerPoolOptions {
    /** Jobs computing at once (default defaultTextureWorkerCount()). */
    size?: number;
    /** The worker entry (default texture-worker.ts/.js beside this file). */
    entry?: string;
}

/** See the file comment. One pool per texture stage; `close` ends every thread. */
export class TextureWorkerPool {
    readonly size: number;
    private readonly entry: string;
    private readonly idle: TextureThread[] = [];
    private readonly all = new Set<TextureThread>();
    private computing = 0;
    private readonly waiting: Array<() => void> = [];
    private nextId = 0;
    private closed = false;
    private readonly exitCodes: number[] = [];

    constructor(options: TextureWorkerPoolOptions = {}) {
        this.size = Math.max(1, Math.floor(options.size ?? defaultTextureWorkerCount()));
        this.entry = options.entry ?? workerEntry();
    }

    /** Exit codes of the threads that have ended (terminated, crashed or closed), in order. */
    exited(): number[] { return [...this.exitCodes]; }

    /** Threads alive (computing, parked with a leave-one-pano-out job, or idle). */
    get threads(): number { return this.all.size; }

    private async slot(signal?: AbortSignal): Promise<void> {
        if (this.closed) throw new Error('texture worker pool: the pool is closed');
        if (this.computing < this.size) { this.computing++; return; }
        await new Promise<void>((resolve, reject) => {
            const go = () => { signal?.removeEventListener('abort', stop); resolve(); };
            const stop = () => { const i = this.waiting.indexOf(go); if (i >= 0) this.waiting.splice(i, 1); reject(abortError(signal!)); };
            if (signal?.aborted) { stop(); return; }
            signal?.addEventListener('abort', stop, { once: true });
            this.waiting.push(go);
        });
        this.computing++;
    }

    private unslot(): void {
        this.computing--;
        const next = this.waiting.shift();
        next?.();
    }

    private thread(): TextureThread {
        if (this.closed) throw new Error('texture worker pool: the pool is closed');
        for (;;) {
            const t = this.idle.pop();
            if (!t) break;
            if (!t.dead) return t;
        }
        return this.spawn();
    }

    private spawn(): TextureThread {
        if (this.closed) throw new Error('texture worker pool: the pool is closed');
        const t = new TextureThread(this.entry, dead => { this.all.delete(dead); const i = this.idle.indexOf(dead); if (i >= 0) this.idle.splice(i, 1); }, code => this.exitCodes.push(code));
        this.all.add(t);
        return t;
    }

    private giveBack(t: TextureThread): void {
        if (t.dead) return;
        if (this.closed || this.idle.length >= this.size) { t.terminate(); return; }
        this.idle.push(t);
    }

    /**
     * Starts the threads ahead of the first jobs (their module load is seconds under ts-node); resolves once they have
     * loaded (one that cannot load is left to fail its first job with the reason).
     */
    async warm(n = this.size): Promise<void> {
        const want = Math.max(0, Math.min(n, this.size) - this.idle.length);
        const started: TextureThread[] = [];
        for (let i = 0; i < want; i++) { const t = this.spawn(); started.push(t); this.idle.push(t); }
        await Promise.all(started.map(t => t.loaded()));
    }

    /** prepareTextureSources in a thread; the views, meshes and tile come back in shared memory. */
    async prepare(input: TextureSourcesInput, signal?: AbortSignal): Promise<TextureSources> {
        await this.slot(signal);
        try {
            const t = this.thread();
            const wire = await t.call<TextureSourcesWire>({ type: 'prepare', id: ++this.nextId, input }, { ...(signal ? { signal } : {}) });
            this.giveBack(t);
            return textureSourcesFromWire(wire);
        } finally {
            this.unslot();
        }
    }

    /**
     * textureLayer in a thread: the same outcome. Its measureLoo runs on the same thread (which keeps the layer until then);
     * `release` drops it without running it. A rejected job has no thread left to release.
     */
    async textureLayer(layer: TextureLayerInput, src: TexturePassSources): Promise<TextureLayerOutcome & { release?: () => void }> {
        const { tile, enhance, signal, onProgress, ...rest } = src;
        const tileState = tile ? tileSurfaceState(tile) : undefined;
        if (tile && !tileState) throw new Error('texture worker pool: the tile surface carries no state to send to a thread');
        await this.slot(signal);
        let t: TextureThread | undefined;
        let parked = false;
        try {
            t = this.thread();
            const clay = ownedBytes(layer.clayGlb);
            const transfer = clay === layer.clayGlb ? [] : [clay.buffer as ArrayBuffer];
            const wire = await t.call<WireOutcome>({
                type: 'texture', id: ++this.nextId, layer: { ...layer, clayGlb: clay }, src: shareDeep(rest),
                ...(tileState ? { tile: shareDeep(tileState) } : {}),
                ...(enhance ? { enhance: { ...(enhance.models ? { models: enhance.models } : {}), ...(enhance.budgetMs ? { budgetMs: enhance.budgetMs } : {}) } } : {})
            }, { transfer, ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}), ...(enhance ? { enhance: enhance.client } : {}) });
            const { glb, hasLoo, ...value } = wire;
            const out: TextureLayerOutcome & { release?: () => void } = { ...value, glb: Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength) };
            if (hasLoo) {
                parked = true;
                const thread = t;
                let done = false;
                const onAbort = () => { if (!done) { done = true; thread.terminate(); } };
                signal?.addEventListener('abort', onAbort, { once: true });
                const finish = (keep: boolean) => { done = true; signal?.removeEventListener('abort', onAbort); if (keep) { thread.release(); this.giveBack(thread); } else thread.terminate(); };
                out.measureLoo = async (budgetMs?: number): Promise<LooFit> => {
                    if (done) throw new Error('the leave-one-pano-out job was already run or released');
                    await this.slot(signal);
                    try {
                        const r = await thread.call<LooFit>({ type: 'loo', id: ++this.nextId, ...(budgetMs !== undefined ? { budgetMs } : {}) }, { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) });
                        finish(true);
                        return r;
                    } catch (err) {
                        finish(false);
                        throw err;
                    } finally {
                        this.unslot();
                    }
                };
                out.release = () => { if (!done) finish(true); };
            }
            return out;
        } finally {
            this.unslot();
            if (t && !parked) this.giveBack(t);
        }
    }

    /** Ends every thread (parked ones too); jobs still running reject with TextureWorkerCrashError. */
    close(): void {
        this.closed = true;
        for (const t of [...this.all]) t.terminate();
        this.idle.length = 0;
        for (const w of this.waiting.splice(0)) w();
    }
}
