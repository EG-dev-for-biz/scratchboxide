/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A material-regions worker thread (material-regions-pool.ts owns them): plans one job (one photo's maps) at a time with
 * the same code the main thread runs (planMaterialJob), reading the GLB and its photos from shared memory.
 */

import { parentPort, workerData } from 'worker_threads';
import { materialPlanContext, planMaterialJob, type MaterialPlanJob } from './material-regions';
import type { MaterialRegionsWorkerInit } from './material-regions-pool';

const port = parentPort;
if (!port) throw new Error('material-regions-worker.ts runs only as a worker thread');

const init = (workerData as { init: MaterialRegionsWorkerInit }).init;
const ctx = materialPlanContext({ json: init.json, bin: init.bin }, init.json, init.images, init.classes, init.sets, init.P);

port.on('message', (msg: { i: number; job: MaterialPlanJob }) => {
    try {
        const piece = planMaterialJob(msg.job, ctx);
        const p = piece.planned, transfer = p ? [p.orm.rgba.buffer, ...(p.normal ? [p.normal.rgba.buffer] : []), ...(p.height ? [p.height.rgba.buffer] : [])] : [];
        port.postMessage({ i: msg.i, piece }, transfer as never);
    } catch (err) {
        port.postMessage({ i: msg.i, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
    }
});
port.postMessage({ ready: true });
