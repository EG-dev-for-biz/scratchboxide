/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Material regions' plan across worker threads: each photo's maps are one job (planMaterialJob), independent of the others,
 * run on the next free thread, largest photos first; the pieces are merged in the serial order (mergeMaterialPlan), so the
 * plan is the same bit for bit as planMaterialRegions on one thread. The GLB's binary chunk and the photos go to the
 * threads once, in shared memory. SCRATCHBOX_K_MATERIAL_WORKERS sets the thread count (0 or 1: the main thread only).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from '../../../worker-ts-register';
import { shareDeep } from '../texture-worker-protocol';
import type { ParsedGlb } from '../glb-bytes';
import type { RgbaImage8 } from '../tile-texture-transfer';
import type { FittedPlane } from '../window-fit';
import { MATERIAL_REGIONS_PARAMS, materialPlanJobs, mergeMaterialPlan, planMaterialRegions, type MaterialPlanPiece, type MaterialRegionsParams, type MaterialRegionsPlan, type RegionClass, type RegionSet } from './material-regions';

export interface MaterialRegionsWorkerInit {
    json: any; bin: Uint8Array; images: Map<number, RgbaImage8>; classes: RegionClass[]; sets: RegionSet[]; planes: FittedPlane[]; P: MaterialRegionsParams;
}

export class MaterialRegionsWorkerError extends Error {
    readonly code = 'material_regions_worker_failed';
    constructor(message: string) { super(message); this.name = 'MaterialRegionsWorkerError'; }
}

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

/** Threads for the plan: SCRATCHBOX_K_MATERIAL_WORKERS, else one fewer than the cores, at most 8. */
export function materialRegionsThreads(): number {
    const n = Number(process.env.SCRATCHBOX_K_MATERIAL_WORKERS);
    if (process.env.SCRATCHBOX_K_MATERIAL_WORKERS !== undefined && Number.isFinite(n)) return Math.max(1, Math.floor(n));
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(8, cpus - 1));
}

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['material-regions-worker.js', 'material-regions-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new MaterialRegionsWorkerError(`material-regions-worker not found beside ${dir}`);
}

/** planMaterialRegions across `threads` worker threads (one: on this thread); the same plan, its report's ms the wall time. */
export async function planMaterialRegionsOnThreads(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], planes: FittedPlane[] = [], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS, opts: { threads?: number; signal?: AbortSignal } = {}): Promise<MaterialRegionsPlan> {
    const t0 = Date.now();
    const jobs = materialPlanJobs(json, images);
    const threads = Math.min(opts.threads ?? materialRegionsThreads(), jobs.length);
    if (threads <= 1) return planMaterialRegions(g, json, images, classes, sets, planes, P);
    // largest photos first, so no thread is left with a big one at the end
    const size = (i: number) => { const img = images.get(json.textures[json.materials[jobs[i].material].pbrMetallicRoughness.baseColorTexture.index].source)!; return img.width * img.height; };
    const queue = jobs.map((_, i) => i).sort((a, b) => size(b) - size(a) || a - b);
    const init: MaterialRegionsWorkerInit = { json, ...shareDeep({ bin: g.bin, images, sets, planes }), classes, P };
    const entry = workerEntry();
    const pieces: MaterialPlanPiece[] = new Array(jobs.length);
    const workers: Worker[] = [];
    try {
        await new Promise<void>((resolve, reject) => {
            let left = jobs.length, failed = false;
            const fail = (err: Error) => { if (failed) return; failed = true; reject(err); };
            if (opts.signal?.aborted) { fail(opts.signal.reason instanceof Error ? opts.signal.reason : new Error('stopped')); return; }
            opts.signal?.addEventListener('abort', () => fail(opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error('stopped')), { once: true });
            const next = (w: Worker) => { const i = queue.shift(); if (i !== undefined) w.postMessage({ i, job: jobs[i] }); };
            for (let k = 0; k < threads; k++) {
                const w = new Worker(BOOTSTRAP, { eval: true, workerData: { entry, init } });
                workers.push(w);
                w.on('message', (m: { ready?: boolean; i?: number; piece?: MaterialPlanPiece; error?: string }) => {
                    if (failed) return;
                    if (m.ready) { next(w); return; }
                    if (m.error !== undefined) { fail(new MaterialRegionsWorkerError(`material regions: planning a photo failed on a worker thread: ${m.error}`)); return; }
                    pieces[m.i!] = m.piece!;
                    if (--left === 0) resolve(); else next(w);
                });
                w.on('error', err => fail(new MaterialRegionsWorkerError(`material regions: a worker thread crashed: ${err.message}`)));
                w.on('exit', code => { if (left > 0) fail(new MaterialRegionsWorkerError(`material regions: a worker thread exited (code ${code}) before the plan was done`)); });
            }
        });
    } finally {
        for (const w of workers) { w.removeAllListeners('exit'); void w.terminate(); }
    }
    return mergeMaterialPlan(json, classes, sets, pieces, Date.now() - t0);
}
