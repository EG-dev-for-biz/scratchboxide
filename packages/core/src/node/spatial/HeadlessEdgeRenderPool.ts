/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import type { CameraPose6DOF, SobelEdgeField } from './SubPixelEdgeAlignmentOptimizer';
import type { EdgeRenderWorkerInit } from './edge-render-worker';

/** Loads the worker entry: compiled .js as is, the .ts source through ts-node (development and tests). */
const BOOTSTRAP = `
const { workerData } = require('worker_threads');
if (/\\.ts$/.test(workerData.entry)) {
    require(require.resolve('ts-node', { paths: [require('path').dirname(workerData.entry)] }))
        .register({ transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node' } });
}
require(workerData.entry);
`;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['edge-render-worker.js', 'edge-render-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`HeadlessEdgeRenderPool: edge-render-worker not found beside ${dir}`);
}

/**
 * Edge-field renders of one mesh split across worker threads. Each worker rasterizes a contiguous shard of the
 * triangles for every pose of a batch; the depth buffers are merged by per-pixel minimum, which is exactly what one
 * full render's depth test computes, so the fields equal HeadlessMeshSilhouetteRenderer.renderEdgeField bit for bit.
 */
export class HeadlessEdgeRenderPool {
    private nextId = 0;
    /** Set when a worker failed or exited: every later render rejects with it. */
    private broken?: Error;
    private readonly pending = new Map<number, { left: number; depths: Float32Array[][]; resolve: (d: Float32Array[][]) => void; reject: (e: Error) => void }>();

    private constructor(private readonly workers: Worker[], private readonly width: number, private readonly height: number) {
        workers.forEach((w, wi) => {
            w.on('message', (msg: { id: number; depths?: Float32Array[]; error?: string }) => {
                if (typeof msg?.id !== 'number') return;
                const job = this.pending.get(msg.id);
                if (!job) return;
                if (msg.error) { this.pending.delete(msg.id); job.reject(new Error(`Edge render worker failed: ${msg.error}`)); return; }
                job.depths[wi] = msg.depths!;
                if (--job.left === 0) { this.pending.delete(msg.id); job.resolve(job.depths); }
            });
            w.on('error', err => this.failAll((this.broken = err)));
            w.on('exit', code => { if (!this.closed) this.failAll((this.broken = new Error(`Edge render worker exited (code ${code})`))); });
        });
    }

    /** Workers that render; 1 means no split. */
    get size(): number {
        return this.workers.length;
    }

    /** Threads worth using on this machine: one per core but one, at most 8. */
    static defaultThreads(): number {
        const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
        return Math.max(1, Math.min(8, cores - 1));
    }

    static async create(mesh: RenderMesh3D, width: number, height: number, threads = HeadlessEdgeRenderPool.defaultThreads()): Promise<HeadlessEdgeRenderPool> {
        const triCount = Math.floor(mesh.indices.length / 3);
        const n = Math.max(1, Math.min(Math.floor(threads), triCount));
        const vertices = new SharedArrayBuffer(mesh.vertices.length * 4);
        new Float32Array(vertices).set(mesh.vertices);
        const indices = new SharedArrayBuffer(mesh.indices.length * 4);
        new Uint32Array(indices).set(mesh.indices);
        const entry = workerEntry();
        const workers: Worker[] = [];
        try {
            for (let i = 0; i < n; i++) {
                const triangleRange: [number, number] = [Math.floor((triCount * i) / n), Math.floor((triCount * (i + 1)) / n)];
                const workerData: EdgeRenderWorkerInit & { entry: string } = { entry, vertices, indices, width, height, triangleRange };
                workers.push(new Worker(BOOTSTRAP, { eval: true, workerData }));
            }
            // Ready once the worker has loaded the renderer (a failed load is an error here, not a hang later).
            await Promise.all(workers.map(w => new Promise<void>((resolve, reject) => {
                w.on('message', (m: { ready?: boolean }) => { if (m?.ready) resolve(); });
                w.once('error', reject);
                w.once('exit', code => reject(new Error(`Edge render worker exited before it was ready (code ${code})`)));
            })));
        } catch (err) {
            await Promise.all(workers.map(w => w.terminate()));
            throw err;
        }
        return new HeadlessEdgeRenderPool(workers, width, height);
    }

    /** Edge fields of `poses`, in order. */
    async render(poses: CameraPose6DOF[]): Promise<SobelEdgeField[]> {
        if (this.broken) throw this.broken;
        if (!poses.length) return [];
        const id = this.nextId++;
        const shards = await new Promise<Float32Array[][]>((resolve, reject) => {
            this.pending.set(id, { left: this.workers.length, depths: new Array(this.workers.length), resolve, reject });
            for (const w of this.workers) w.postMessage({ id, poses });
        });
        const size = this.width * this.height;
        return poses.map((_, k) => {
            const depth = shards[0][k];
            for (let s = 1; s < shards.length; s++) {
                const d = shards[s][k];
                for (let i = 0; i < size; i++) if (d[i] < depth[i]) depth[i] = d[i];
            }
            const silhouette = new Uint8Array(size);
            for (let i = 0; i < size; i++) if (depth[i] < 1e9) silhouette[i] = 255;
            return HeadlessMeshSilhouetteRenderer.edgeFieldFromBuffers(depth, silhouette, this.width, this.height);
        });
    }

    private closed = false;

    async close(): Promise<void> {
        this.closed = true;
        this.failAll(new Error('Edge render pool closed'));
        await Promise.all(this.workers.map(w => w.terminate()));
    }

    private failAll(err: Error): void {
        for (const job of this.pending.values()) job.reject(err);
        this.pending.clear();
    }
}
