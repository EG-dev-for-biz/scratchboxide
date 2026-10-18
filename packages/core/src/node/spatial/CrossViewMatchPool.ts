/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * The cross-view refiner's pair matching across worker threads, called synchronously.
 *
 * The refiner is synchronous (its callers are), so the pool is too: the frames' photo maps live in SharedArrayBuffers
 * from the start, each call copies the frames' depths in, posts the job, and blocks on an Atomics counter while the
 * workers take pairs from a shared index (load-balanced). Each pair's result comes back on the worker's own port and
 * is read with receiveMessageOnPort, by pair index: the results are the ones matchFramePair gives in one thread, in the
 * same order, whatever the threads' timing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'worker_threads';
import { workerTsRegisterSource } from '../worker-ts-register';
import type { FrameCamera } from './StreetViewPoseRegistrar';
import type { CrossViewMatch, Integral, PairMatchParams } from './StreetViewCrossViewRefiner';
import type { CrossViewMatchWorkerInit } from './cross-view-match-worker';

/** Loads the worker entry (.js as is, .ts through ts-node) and says ready, or that it failed, on the control counters. */
const BOOTSTRAP = `
const { workerData } = require('worker_threads');
const ctrl = new Int32Array(workerData.ctrl);
try {
    ${workerTsRegisterSource()}
    require(workerData.entry);
} catch (err) {
    Atomics.store(ctrl, 3, 1);
    Atomics.add(ctrl, 2, 1);
    Atomics.notify(ctrl, 2);
    throw err;
}
`;

/** Control counters: next pair, workers done with the job, workers ready, a worker failed to load. */
const NEXT = 0, DONE = 1, READY = 2, FAILED = 3;
/** How long a worker may take to load, and a job to finish, before the pool gives up on it. */
const READY_TIMEOUT_MS = 120_000;
const JOB_TIMEOUT_MS = 600_000;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['cross-view-match-worker.js', 'cross-view-match-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`CrossViewMatchPool: cross-view-match-worker not found beside ${dir}`);
}

export interface PoolFrame {
    width: number; height: number;
    lum: Float32Array; valid: Uint8Array; bp: Float32Array; bpHalf: Float32Array; bpI: Integral; bpHalfI: Integral;
}

function shared<T extends Float32Array | Float64Array | Uint8Array>(a: T): SharedArrayBuffer {
    const buf = new SharedArrayBuffer(a.byteLength);
    new Uint8Array(buf).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return buf;
}

function waitFor(ctrl: Int32Array, index: number, target: number, timeoutMs: number, what: string): void {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const now = Atomics.load(ctrl, index);
        if (now >= target) return;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`cross-view worker threads: ${what} took longer than ${Math.round(timeoutMs / 1000)} s`);
        Atomics.wait(ctrl, index, now, left);
    }
}

export class CrossViewMatchPool {
    private nextId = 0;
    private closed = false;

    private constructor(private readonly workers: Worker[], private readonly ports: MessagePort[], private readonly ctrl: Int32Array, private readonly depths: Float32Array[]) {}

    get size(): number {
        return this.workers.length;
    }

    /** Starts `threads` workers holding the frames' photo maps; blocks until each has loaded. Throws when one cannot. */
    static create(frames: PoolFrame[], threads: number): CrossViewMatchPool {
        const ctrlBuf = new SharedArrayBuffer(4 * 4);
        const ctrl = new Int32Array(ctrlBuf);
        const depthBufs = frames.map(f => new SharedArrayBuffer(f.width * f.height * 4));
        const init: Omit<CrossViewMatchWorkerInit, 'port'> & { entry: string } = {
            entry: workerEntry(), ctrl: ctrlBuf,
            frames: frames.map((f, i) => ({
                width: f.width, height: f.height, lum: shared(f.lum), valid: shared(f.valid), bp: shared(f.bp), bpHalf: shared(f.bpHalf),
                bpI: { s: shared(f.bpI.s), s2: shared(f.bpI.s2), w: f.bpI.w }, bpHalfI: { s: shared(f.bpHalfI.s), s2: shared(f.bpHalfI.s2), w: f.bpHalfI.w }, depth: depthBufs[i]
            }))
        };
        const workers: Worker[] = [];
        const ports: MessagePort[] = [];
        try {
            for (let k = 0; k < Math.max(1, Math.floor(threads)); k++) {
                const { port1, port2 } = new MessageChannel();
                const w = new Worker(BOOTSTRAP, { eval: true, workerData: { ...init, port: port2 }, transferList: [port2] });
                w.unref();
                // a worker's own error ends its jobs through the counters (it never answers): nothing to do here
                w.on('error', () => undefined);
                workers.push(w);
                ports.push(port1);
            }
            waitFor(ctrl, READY, workers.length, READY_TIMEOUT_MS, 'loading');
            if (Atomics.load(ctrl, FAILED)) throw new Error('a worker could not load the matcher');
        } catch (err) {
            for (const w of workers) void w.terminate();
            for (const p of ports) p.close();
            throw err;
        }
        return new CrossViewMatchPool(workers, ports, ctrl, depthBufs.map(b => new Float32Array(b)));
    }

    /** matchFramePair for every pair of `order`, at the given cameras and depths; results by pair index. */
    match(states: Array<{ cam: FrameCamera; depth: Float32Array }>, order: Array<[number, number]>, params: PairMatchParams): Array<{ overlapPx: number; patches: number; matches: CrossViewMatch[] } | null> {
        if (this.closed) throw new Error('cross-view worker threads: the pool is closed');
        states.forEach((s, i) => this.depths[i].set(s.depth));
        const id = this.nextId++;
        Atomics.store(this.ctrl, NEXT, 0);
        Atomics.store(this.ctrl, DONE, 0);
        const cams = states.map(s => s.cam);
        for (const w of this.workers) w.postMessage({ id, cams, order, params });
        waitFor(this.ctrl, DONE, this.workers.length, JOB_TIMEOUT_MS, 'matching');
        const out: Array<{ overlapPx: number; patches: number; matches: CrossViewMatch[] } | null> = new Array(order.length);
        const got = new Uint8Array(order.length);
        for (const port of this.ports) {
            for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) {
                const msg = m.message as { id: number; i?: number; r?: { overlapPx: number; patches: number; matches: CrossViewMatch[] } | null; error?: string };
                if (msg.id !== id) continue;
                if (msg.error) throw new Error(`cross-view worker failed: ${msg.error}`);
                out[msg.i!] = msg.r ?? null;
                got[msg.i!] = 1;
            }
        }
        const missing = got.indexOf(0);
        if (missing >= 0) throw new Error(`cross-view worker threads: pair ${missing} came back with no result`);
        return out;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const w of this.workers) void w.terminate();
        for (const p of this.ports) p.close();
    }
}
