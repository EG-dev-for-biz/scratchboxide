/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The remesh steps on worker threads (remesh-worker.ts), off the server's main thread and each run in a fresh heap.
 *
 * - runRemeshJob: one step (the wall grammar, the wall sheets, the polish) on a thread of its own, retired after it.
 * - runRemeshJobs: many jobs (one facade's window fit each, when SCRATCHBOX_K_NATIVE without window-fit keeps the window fit in
 *   TypeScript; natively it is one process on a thread pool of its own, remesh-polish-native.ts) on up to `threads`
 *   threads, each thread taking the next job as it finishes one; results come back in job order.
 * - The stage's AbortSignal terminates the threads and rejects at once; a thread that dies or a job that throws rejects
 *   with RemeshWorkerError.
 * - SCRATCHBOX_REMESH_WORKERS=0 runs the steps on the main thread as before; a number sets the window fit's threads.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from '../../worker-ts-register';
import type { RemeshJob, RemeshWorkerMessage } from './remesh-worker';

export class RemeshWorkerError extends Error {
    readonly code = 'remesh_worker_failed';
    constructor(message: string) { super(message); this.name = 'RemeshWorkerError'; }
}

/** The remesh steps run on worker threads unless SCRATCHBOX_REMESH_WORKERS=0. */
export function remeshWorkersEnabled(): boolean {
    return process.env.SCRATCHBOX_REMESH_WORKERS?.trim() !== '0';
}

/** Threads for the window fit: SCRATCHBOX_REMESH_WORKERS when a number, else one fewer than the cores, at most 8. */
export function remeshWorkerThreads(): number {
    const n = Number(process.env.SCRATCHBOX_REMESH_WORKERS);
    if (process.env.SCRATCHBOX_REMESH_WORKERS !== undefined && Number.isFinite(n) && n >= 1) return Math.floor(n);
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(8, cpus - 1));
}

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['remesh-worker.js', 'remesh-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new RemeshWorkerError(`remesh-worker not found beside ${dir}`);
}

const stopped = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error('stopped'));

/** The jobs on up to `threads` threads, in the given order of starting (default: as listed); each job's result by its index. */
export async function runRemeshJobs<R>(jobs: RemeshJob[], opts: { threads?: number; order?: number[]; signal?: AbortSignal; onStep?: (step: string, state: 'running' | 'done' | 'failed') => void } = {}): Promise<R[]> {
    const results: R[] = new Array(jobs.length);
    if (!jobs.length) return results;
    const queue = opts.order ? [...opts.order] : jobs.map((_, i) => i);
    const threads = Math.max(1, Math.min(opts.threads ?? remeshWorkerThreads(), jobs.length));
    const entry = workerEntry();
    const workers: Worker[] = [];
    try {
        await new Promise<void>((resolve, reject) => {
            let left = jobs.length, failed = false;
            const fail = (err: Error) => { if (failed) return; failed = true; reject(err); };
            if (opts.signal?.aborted) { fail(stopped(opts.signal)); return; }
            opts.signal?.addEventListener('abort', () => fail(stopped(opts.signal!)), { once: true });
            const next = (w: Worker) => { const i = queue.shift(); if (i !== undefined) w.postMessage({ i, job: jobs[i] }); };
            for (let k = 0; k < threads; k++) {
                const w = new Worker(BOOTSTRAP, { eval: true, workerData: { entry, remeshWorker: true } });
                workers.push(w);
                w.on('message', (m: RemeshWorkerMessage) => {
                    if (failed) return;
                    if ('ready' in m) { next(w); return; }
                    if ('step' in m) { opts.onStep?.(m.step, m.state); return; }
                    if ('error' in m) { fail(new RemeshWorkerError(`remesh: ${jobs[m.i].kind} failed on a worker thread: ${m.error}`)); return; }
                    results[m.i] = m.result as R;
                    if (--left === 0) resolve(); else next(w);
                });
                w.on('error', err => fail(new RemeshWorkerError(`remesh: a worker thread crashed: ${err.message}`)));
                w.on('exit', code => { if (left > 0) fail(new RemeshWorkerError(`remesh: a worker thread exited (code ${code}) before its jobs were done`)); });
            }
        });
    } finally {
        for (const w of workers) { w.removeAllListeners('exit'); void w.terminate(); }
    }
    return results;
}

/** One step on a thread of its own (a fresh heap), retired after it. */
export async function runRemeshJob<R>(job: RemeshJob, opts: { signal?: AbortSignal; onStep?: (step: string, state: 'running' | 'done' | 'failed') => void } = {}): Promise<R> {
    return (await runRemeshJobs<R>([job], { ...opts, threads: 1 }))[0];
}
