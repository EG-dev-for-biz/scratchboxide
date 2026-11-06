/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D's chunk layers joined off the main thread (district-chunks.ts joinChunkLayerFile): read, checked (or,
 * when one came uncut, cut, placed in the district's frame and compacted) and written by one worker thread a district, one
 * file at a time, so the server's main thread stays free while the chunks join (at Penn Station, on a laptop at load 260-525, the
 * join on the main thread put each chunk up to 9 minutes behind its cloud job). The thread lives for the chunks stage;
 * `close` retires it. SCRATCHBOX_REMESH_WORKERS=0 (no worker threads) joins on the calling thread.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isMainThread, parentPort, Worker, workerData } from 'worker_threads';
import { workerTsRegisterSource } from '../../../worker-ts-register';
import { remeshWorkersEnabled } from '../remesh-worker-pool';
import { joinChunkLayerFile, type ChunkLayerJoinJob, type ChunkLayerJoinResult } from './district-chunks';

type JoinMessage = { ready: true } | { id: number; result: ChunkLayerJoinResult } | { id: number; error: string };

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['chunk-join-worker.js', 'chunk-join-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`chunk-join-worker not found beside ${dir}`);
}

export interface ChunkJoiner {
    join(job: ChunkLayerJoinJob): Promise<ChunkLayerJoinResult>;
    close(): Promise<void>;
}

/** A joiner on a worker thread of its own (started on the first join), or on this thread when worker threads are off. */
export function createChunkJoiner(opts: { threads?: boolean } = {}): ChunkJoiner {
    if (!(opts.threads ?? remeshWorkersEnabled())) return { join: async job => joinChunkLayerFile(job), close: async () => undefined };
    let worker: Worker | undefined, ready: Promise<void> | undefined, dead: Error | undefined, nextId = 0;
    const waiting = new Map<number, { resolve: (r: ChunkLayerJoinResult) => void; reject: (e: Error) => void }>();
    const failAll = (err: Error) => {
        dead = err;
        for (const w of waiting.values()) w.reject(err);
        waiting.clear();
    };
    const start = () => ready ??= new Promise<void>((resolve, reject) => {
        const w = worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry: workerEntry(), chunkJoinWorker: true } });
        w.on('message', (m: JoinMessage) => {
            if ('ready' in m) { resolve(); return; }
            const p = waiting.get(m.id);
            waiting.delete(m.id);
            if ('error' in m) p?.reject(new Error(`the chunk join failed on its worker thread: ${m.error}`));
            else p?.resolve(m.result);
        });
        w.on('error', err => { const e = new Error(`the chunk join's worker thread crashed: ${err.message}`); reject(e); failAll(e); });
        w.on('exit', code => { const e = new Error(`the chunk join's worker thread exited (code ${code})`); reject(e); failAll(e); });
    });
    return {
        async join(job) {
            if (dead) throw dead;
            await start();
            const id = nextId++;
            return new Promise<ChunkLayerJoinResult>((resolve, reject) => {
                waiting.set(id, { resolve, reject });
                worker!.postMessage({ id, job });
            });
        },
        async close() {
            const w = worker;
            worker = undefined;
            if (!w) return;
            w.removeAllListeners('exit');
            failAll(new Error('the chunk joiner was closed'));
            await w.terminate();
        }
    };
}

if (!isMainThread && (workerData as { chunkJoinWorker?: boolean } | undefined)?.chunkJoinWorker) {
    parentPort!.on('message', (m: { id: number; job: ChunkLayerJoinJob }) => {
        try {
            parentPort!.postMessage({ id: m.id, result: joinChunkLayerFile(m.job) } satisfies JoinMessage);
        } catch (err) {
            parentPort!.postMessage({ id: m.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) } satisfies JoinMessage);
        }
    });
    parentPort!.postMessage({ ready: true } satisfies JoinMessage);
}
