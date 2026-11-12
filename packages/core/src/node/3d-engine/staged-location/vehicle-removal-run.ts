/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The vehicles stage (vehicle-removal.ts removeVehicles) in a worker thread, its vision calls answered on the calling thread.
 *
 * Live (the Flatiron district, run ee634ff6) the stage held the server's main thread 498 s in eight blocks, the longest 349 s:
 * the scan's load and street model, the top-surface grid and its components, the tile's triangles and images decoded, every
 * crop rendered and encoded, then the rings, stacks, surface infill and both GLBs patched. The server answered nothing
 * meanwhile, so the stage's own vision calls (and the chat's) timed out. Here everything but the vision calls runs in a
 * thread: the job is plain data (file paths, the scan when the caller already holds it, the vector rasters), the thread
 * rebuilds the street model and the lookups from it, and each crop (or batch of crops) it wants read is posted back to be
 * judged by the caller's judge, whose answer is posted in again. The computation is the same function either way, so the
 * GLBs and the report are the same (the report's `ms` aside).
 *
 * SCRATCHBOX_VEHICLES_WORKER=0 runs the job on the calling thread (as before). A stop terminates the thread and rejects with
 * the signal's reason; a thread that dies rejects with why.
 */

import * as v8 from 'v8';
import { isMainThread, parentPort, Worker, workerData } from 'worker_threads';
import { buildGroundModel, loadScanMesh, type GroundModelOptions, type ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { findWorkerEntry, workerTsRegisterSource } from '../../worker-ts-register';
import { evidenceLookupFromRaster, type EvidenceGrid, type EvidenceRaster } from './vector-footprints';
import { removeVehicles, type RemoveVehiclesResult, type VehicleBatchJudge, type VehicleCrop, type VehicleJudge, type VehicleLookups, type VehicleReading, type VehicleRemovalParams } from './vehicle-removal';

/** The job, as plain data: what removeVehicles is given, less the functions (rebuilt in the thread) and the judges. */
export interface VehicleRemovalJob {
    texturedGlb: string;
    geometryGlb?: string;
    /** The scan, when the caller already holds it (cloned into the thread); else `scanGlb` is loaded there. */
    scan?: ScanMesh;
    scanGlb?: string;
    /** The street model's options (its water and road come from `lookups` when they hold the vector rasters). */
    groundOptions?: Omit<GroundModelOptions, 'water' | 'road' | 'exclude'>;
    lookups?: {
        /** The vector evidence's rasters (evidenceLookup's): building, water and road per cell. */
        raster?: Pick<EvidenceRaster, 'building' | 'water' | 'road'>;
        grid?: EvidenceGrid;
        /** Inside the extraction's cover: within this plan radius of the origin. */
        within?: { radiusM: number };
    };
    outDir: string;
    keepImages?: boolean;
    P?: VehicleRemovalParams;
}

export interface VehicleRemovalRunOptions {
    judge: VehicleJudge;
    judgeMany?: VehicleBatchJudge;
    signal?: AbortSignal;
    log?: (m: string) => void;
}

/** SCRATCHBOX_VEHICLES_WORKER=0 runs the vehicles stage on the calling thread (as before). */
export const vehicleRemovalWorkerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SCRATCHBOX_VEHICLES_WORKER?.trim() !== '0';

/** The lookups removeVehicles reads, from the job's plain data (the same cells as evidenceLookup's closures). */
export function jobLookups(job: VehicleRemovalJob): VehicleLookups {
    const l = job.lookups ?? {};
    const out: VehicleLookups = {};
    if (l.raster && l.grid) {
        const look = evidenceLookupFromRaster(l.raster, l.grid);
        out.buildingAt = look.buildingAt; out.waterAt = look.waterAt; out.roadAt = look.roadAt;
    }
    if (l.within) { const r = l.within.radiusM; out.within = (x, z) => Math.hypot(x, z) <= r; }
    return out;
}

/** The job on this thread: the scan (loaded unless given), its street model, the lookups, then removeVehicles. */
export async function runVehicleRemovalJob(job: VehicleRemovalJob, opts: VehicleRemovalRunOptions): Promise<RemoveVehiclesResult> {
    const look = jobLookups(job);
    if (!job.scan && !job.scanGlb) throw new Error('the vehicles job names no scan (neither the mesh nor its GLB)');
    const scan = job.scan ?? loadScanMesh(job.scanGlb!);
    const ground = buildGroundModel(scan, { cellMeters: 1, ...(job.groundOptions ?? {}), ...(look.waterAt ? { water: look.waterAt } : {}), ...(look.roadAt ? { road: look.roadAt } : {}) });
    return removeVehicles({
        texturedGlb: job.texturedGlb, ...(job.geometryGlb ? { geometryGlb: job.geometryGlb } : {}), scan, ground, look,
        judge: opts.judge, ...(opts.judgeMany ? { judgeMany: opts.judgeMany } : {}), outDir: job.outDir,
        ...(job.keepImages ? { keepImages: true } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(job.P ? { P: job.P } : {}), ...(opts.log ? { log: opts.log } : {})
    });
}

// ------------------------------------------------------------------------------------------------ the thread's messages

type WireCrop = Omit<VehicleCrop, 'jpeg'> & { jpeg: Uint8Array };
type ToCaller =
    | { t: 'log'; m: string }
    | { t: 'judge'; id: number; crop: WireCrop }
    | { t: 'judgeMany'; id: number; crops: WireCrop[] }
    | { t: 'done'; result: RemoveVehiclesResult }
    | { t: 'error'; message: string; stack?: string };
type ToThread =
    | { t: 'judged'; id: number; readings: VehicleReading[] }
    | { t: 'judgedMany'; id: number; entries: Array<[number, VehicleReading[]]> }
    | { t: 'judgeFailed'; id: number; message: string };

/** A crop as it crossed the thread boundary (a Buffer arrives as a plain Uint8Array): its JPEG a Buffer again, no copy. */
const asCrop = (c: WireCrop): VehicleCrop => ({ ...c, jpeg: Buffer.from(c.jpeg.buffer, c.jpeg.byteOffset, c.jpeg.byteLength) });
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The thread's side: the judges post the crops to the caller and wait for its answer. */
function threadMain(): void {
    const port = parentPort!;
    const pending = new Map<number, { resolve: (v: ToThread) => void }>();
    let nextId = 0;
    const ask = (msg: ToCaller & { id: number }): Promise<ToThread> => new Promise(resolve => { pending.set(msg.id, { resolve }); port.postMessage(msg); });
    port.on('message', (m: ToThread) => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m); } });
    const judge: VehicleJudge = async crop => {
        const r = await ask({ t: 'judge', id: nextId++, crop });
        if (r.t === 'judgeFailed') throw new Error(r.message);
        return r.t === 'judged' ? r.readings : [];
    };
    const judgeMany: VehicleBatchJudge = async crops => {
        const r = await ask({ t: 'judgeMany', id: nextId++, crops });
        if (r.t === 'judgeFailed') throw new Error(r.message);
        return new Map(r.t === 'judgedMany' ? r.entries : []);
    };
    const { job, batch } = workerData as { job: VehicleRemovalJob; batch: boolean };
    runVehicleRemovalJob(job, { judge, ...(batch ? { judgeMany } : {}), log: m => port.postMessage({ t: 'log', m } satisfies ToCaller) })
        .then(result => port.postMessage({ t: 'done', result } satisfies ToCaller))
        .catch(err => port.postMessage({ t: 'error', message: message(err), ...(err instanceof Error && err.stack ? { stack: err.stack } : {}) } satisfies ToCaller));
}

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

/**
 * The vehicles stage in a worker thread (or on this thread with SCRATCHBOX_VEHICLES_WORKER=0). The judges run on this thread,
 * with `signal`; everything else in the thread.
 */
export function removeVehiclesOffThread(job: VehicleRemovalJob, opts: VehicleRemovalRunOptions): Promise<RemoveVehiclesResult> {
    if (!vehicleRemovalWorkerEnabled()) return runVehicleRemovalJob(job, opts);
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
    return new Promise((resolve, reject) => {
        // the thread's heap as large as this one's: the stage's grids and sample lists live on the JS heap
        const heapMb = Math.ceil(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
        const worker = new Worker(BOOTSTRAP, {
            eval: true, workerData: { entry: findWorkerEntry('vehicle-removal-run', __dirname, '3d-engine/staged-location'), vehicleRemovalWorker: true, job, batch: !!opts.judgeMany },
            resourceLimits: { maxOldGenerationSizeMb: heapMb }
        });
        let settled = false;
        const finish = (fn: () => void) => { if (settled) return; settled = true; opts.signal?.removeEventListener('abort', onAbort); fn(); void worker.terminate(); };
        const onAbort = () => finish(() => reject(opts.signal!.reason));
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        const answer = (m: ToThread) => { if (!settled) worker.postMessage(m); };
        worker.on('message', (m: ToCaller) => {
            if (m.t === 'log') opts.log?.(m.m);
            else if (m.t === 'judge') {
                opts.judge(asCrop(m.crop), opts.signal).then(readings => answer({ t: 'judged', id: m.id, readings }), err => answer({ t: 'judgeFailed', id: m.id, message: message(err) }));
            } else if (m.t === 'judgeMany') {
                const many = opts.judgeMany;
                if (!many) { answer({ t: 'judgeFailed', id: m.id, message: 'no batch judge on the calling thread' }); return; }
                many(m.crops.map(asCrop), opts.signal).then(got => answer({ t: 'judgedMany', id: m.id, entries: [...got] }), err => answer({ t: 'judgeFailed', id: m.id, message: message(err) }));
            } else if (m.t === 'done') finish(() => resolve(m.result));
            else if (m.t === 'error') finish(() => reject(Object.assign(new Error(m.message), m.stack ? { stack: m.stack } : {})));
        });
        worker.on('error', err => finish(() => reject(err)));
        worker.on('exit', code => finish(() => reject(new Error(`the vehicles thread exited (code ${code}) before it answered`))));
    });
}

if (!isMainThread && (workerData as { vehicleRemovalWorker?: boolean } | undefined)?.vehicleRemovalWorker) threadMain();
