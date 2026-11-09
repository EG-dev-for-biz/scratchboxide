/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The evidence stage's geometric registration (edges, then jointly), as one job that runs in a worker thread.
 *
 * Live (Washington Square Arch, replayed with recorded evidence and a CPU profile) it held the main thread for 107 s in one
 * block: the frames' JPEG decode, the edge search (dataCost, blurs, distance transforms), the cross-view matching (whose
 * pool the main thread waited on with Atomics.wait) and the held-out scoring. The figures' and the reading's vision calls
 * in flight then could not be read. The job's inputs are plain data (image bytes, mesh files, the box registration), its
 * result is cloned back; the computation is the same function either way, so the poses are the same.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { readGlbScene, sceneToRenderMesh } from '../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { workerTsRegisterSource } from '../../worker-ts-register';
import type { CastFace } from './survey-casting';
import { registerPanos, type Correspondence, type Registration } from './pano-registration';
import { EDGE_MAX_RESIDUAL_PX, EDGE_REGISTRATION_BUDGET_MS, edgeFramesFromImages, registerPanosByEdges, type EdgeRegistrationResult, type HeldImage } from './pano-edge-registration';
import { JOINT_REGISTRATION_BUDGET_MS, registerPanosJointly, type JointRegistrationResult } from './pano-joint-registration';
import { jointRegistrationEnabled } from './round5-switch';
import { registerPanosByDrive, type DriveStepResult } from './pano-drive-registration';
import { LearnedFeatureMatcherService, LearnedMatcherUnavailableError } from '../../spatial/LearnedFeatureMatcherService';

export interface PanoRegistrationJob {
    images: HeldImage[];
    /** GLB files of the full tile mesh the frames are registered against. */
    meshFiles: string[];
    prior?: Registration;
    correspondences: Correspondence[];
    faces: CastFace[];
    edgeBudgetMs?: number;
    jointBudgetMs?: number;
    /** Run the joint registration after the edges (default: jointRegistrationEnabled()). */
    joint?: boolean;
    /** Run the drive registration after them (default: driveRegistrationEnabled()). */
    drive?: boolean;
}

export interface PanoRegistrationOutcome {
    frames: number;
    panos: number;
    edge?: EdgeRegistrationResult;
    joint?: JointRegistrationResult;
    /** The drive registration (pano-drive-registration.ts), when it ran. */
    drive?: DriveStepResult;
    /** The registration in force after the job: the edge registration's when any pano took its edge pose, the joint one's when kept. Absent: the prior stands. */
    registration?: Registration;
}

function loadMesh(files: string[]): RenderMesh3D {
    return sceneToRenderMesh(files.filter(f => !!f && fs.existsSync(f)).flatMap(f => readGlbScene(f)));
}

/** The job, in this thread. `log` gets the progress lines (the frame count first, then the joint fit's). */
export function runPanoRegistration(job: PanoRegistrationJob, log: (m: string) => void = () => undefined): PanoRegistrationOutcome {
    const frames = edgeFramesFromImages(job.images);
    const panos = new Set(frames.map(f => f.view.panoId)).size;
    if (frames.length < 2) return { frames: frames.length, panos };
    log(`registering ${panos} panos against the scan's silhouette and edges (${frames.length} images)`);
    const mesh = loadMesh(job.meshFiles);
    const edge = registerPanosByEdges({ frames, mesh, ...(job.prior ? { prior: job.prior } : {}), correspondences: job.correspondences, faces: job.faces, budgetMs: job.edgeBudgetMs ?? EDGE_REGISTRATION_BUDGET_MS });
    let registration = edge.panos.some(p => p.chosen === 'edges') ? edge.registration : undefined;
    let joint: JointRegistrationResult | undefined;
    if ((job.joint ?? jointRegistrationEnabled()) && edge.registration && edge.panos.length >= 2) {
        log(`registering ${edge.panos.length} panos jointly (edges, cross-view consistency through the scan, priors)`);
        const candidates = new Map(edge.panos.map(p => [p.panoId, {
            box: p.prior, ...(p.edge ? { edge: p.edge } : {}),
            edgeLocked: p.edgeResidualPx.edge !== null && p.edgeResidualPx.edge <= EDGE_MAX_RESIDUAL_PX && (p.edgeResidualPx.prior === null || p.edgeResidualPx.edge < p.edgeResidualPx.prior)
        }]));
        joint = registerPanosJointly({ frames, mesh, current: registration ?? job.prior ?? edge.registration, candidates, faces: job.faces, budgetMs: job.jointBudgetMs ?? JOINT_REGISTRATION_BUDGET_MS, log });
        if (joint.chosen !== 'current') registration = joint.registration;
    }
    return { frames: frames.length, panos, edge, ...(joint ? { joint } : {}), ...(registration ? { registration } : {}) };
}

/**
 * The drive registration after the edge and joint registration (pano-drive-registration.ts); kept only when the held-out
 * fit improves. SCRATCHBOX_DRIVE_REGISTRATION=0 turns it off. Without the learned matcher's interpreter (torch and kornia)
 * it is skipped and says why.
 */
export const driveRegistrationEnabled = (): boolean => process.env.SCRATCHBOX_DRIVE_REGISTRATION !== '0';

/** The drive step of a job, from the registration in force after the edges and the joint fit. */
export async function runDriveRegistration(job: { images: HeldImage[]; meshFiles: string[]; current?: Registration }, log: (m: string) => void = () => undefined): Promise<DriveStepResult> {
    const t0 = Date.now();
    let matcher: LearnedFeatureMatcherService;
    try {
        matcher = new LearnedFeatureMatcherService();
    } catch (e) {
        if (!(e instanceof LearnedMatcherUnavailableError)) throw e;
        return { status: 'skipped', reason: `the learned matcher is not available: ${e.message}`, panos: [], viewPairs: 0, ties: 0, tiesUsed: 0, scanMatches: 0, fit: { current: null, drive: null }, ms: Date.now() - t0 };
    }
    const frames = edgeFramesFromImages(job.images);
    return registerPanosByDrive({ frames, meshFiles: job.meshFiles, mesh: loadMesh(job.meshFiles), ...(job.current ? { current: job.current } : {}), matcher, log });
}

/** SCRATCHBOX_REGISTRATION_WORKER=0 runs the job on the main thread (as before). */
export const registrationWorkerEnabled = (): boolean => process.env.SCRATCHBOX_REGISTRATION_WORKER !== '0';

/** What a registration thread is asked: the box solve from the matched elements, or the edge and joint registration. */
export type RegistrationThreadJob = { kind: 'box'; correspondences: Correspondence[]; faces: CastFace[] } | ({ kind: 'edges' } & PanoRegistrationJob)
    | { kind: 'drive'; images: HeldImage[]; meshFiles: string[]; current?: Registration };

/** Runs a thread job in this thread (the worker's entry calls it too). */
export function runRegistrationThreadJob(job: RegistrationThreadJob, log: (m: string) => void = () => undefined): Registration | PanoRegistrationOutcome | Promise<DriveStepResult> {
    if (job.kind === 'drive') return runDriveRegistration(job, log);
    return job.kind === 'box' ? registerPanos(job.correspondences, job.faces) : runPanoRegistration(job, log);
}

const BOOTSTRAP = `
const { workerData, parentPort } = require('worker_threads');
${workerTsRegisterSource()}
const { runRegistrationThreadJob } = require(workerData.entry);
Promise.resolve().then(() => runRegistrationThreadJob(workerData.job, m => parentPort.postMessage({ log: m })))
    .then(out => parentPort.postMessage({ done: out }))
    .catch(err => parentPort.postMessage({ error: { message: err && err.message || String(err), stack: err && err.stack } }));
`;

function selfEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['pano-registration-run.js', 'pano-registration-run.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`pano-registration-run not found beside ${dir}`);
}

/**
 * The edge and joint registration in a worker thread (or inline with SCRATCHBOX_REGISTRATION_WORKER=0). A stop terminates
 * the thread and rejects with the signal's reason; a thread that dies rejects with why.
 */
export async function runPanoRegistrationOffThread(job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<PanoRegistrationOutcome> {
    const out = await (inThread({ kind: 'edges', ...job }, opts) as Promise<PanoRegistrationOutcome>);
    if (!(job.drive ?? driveRegistrationEnabled()) || out.panos < 2) return out;
    const current = out.registration ?? job.prior ?? out.edge?.registration;
    opts.log?.(`registering ${out.panos} panos as a drive (learned photo-to-photo and photo-to-texture matches)`);
    const drive = await (inThread({ kind: 'drive', images: job.images, meshFiles: job.meshFiles, ...(current ? { current } : {}) }, opts) as Promise<DriveStepResult>);
    return { ...out, drive, ...(drive.status === 'accepted' && drive.registration ? { registration: drive.registration } : {}) };
}

/** The box solve of the matched element pairs (registerPanos) in a worker thread: live it held the main thread ~7 s (ray casts). */
export function registerPanosOffThread(correspondences: Correspondence[], faces: CastFace[], opts: { signal?: AbortSignal } = {}): Promise<Registration> {
    return inThread({ kind: 'box', correspondences, faces }, opts) as Promise<Registration>;
}

function inThread(job: RegistrationThreadJob, opts: { signal?: AbortSignal; log?: (m: string) => void }): Promise<Registration | PanoRegistrationOutcome | DriveStepResult> {
    if (!registrationWorkerEnabled()) return Promise.resolve().then((): Promise<Registration | PanoRegistrationOutcome | DriveStepResult> | Registration | PanoRegistrationOutcome => runRegistrationThreadJob(job, opts.log));
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
    return new Promise((resolve, reject) => {
        const worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry: selfEntry(), job } });
        let settled = false;
        const finish = (fn: () => void) => { if (settled) return; settled = true; opts.signal?.removeEventListener('abort', onAbort); fn(); void worker.terminate(); };
        const onAbort = () => finish(() => reject(opts.signal!.reason));
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        worker.on('message', (m: { log?: string; done?: Registration | PanoRegistrationOutcome | DriveStepResult; error?: { message: string; stack?: string } }) => {
            if (m.log !== undefined) opts.log?.(m.log);
            else if (m.done) finish(() => resolve(m.done!));
            else if (m.error) finish(() => reject(Object.assign(new Error(m.error!.message), { stack: m.error!.stack })));
        });
        worker.on('error', err => finish(() => reject(err)));
        worker.on('exit', code => finish(() => reject(new Error(`the registration thread exited (code ${code}) before it answered`))));
    });
}
