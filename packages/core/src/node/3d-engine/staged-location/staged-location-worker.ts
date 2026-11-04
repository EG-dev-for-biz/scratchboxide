/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One staged location build on its own worker thread (staged-location-tool.ts runStagedLocationOffThread). Its stages hold
 * the CPU for minutes at a time (a district's massing, relief and revolution fit; the remesh polish; the textures): on the
 * server's main thread the server answered nothing meanwhile, so the chat stopped streaming and the viewport could not
 * load the layers already committed. Here the build has the thread to itself: it makes its own services
 * (createStagedLocationDeps), posts each stage event and progress line to the main thread, which records them in the run
 * registry as before, and stops when the main thread asks.
 */

import { parentPort, workerData } from 'worker_threads';
import { runStagedLocation, type StagedLocationContext, type StagedLocationRequest } from './orchestrator';
import { createStagedLocationDeps, type StagedWorkerIn, type StagedWorkerOut } from './staged-location-tool';
import { awaitSceneObjectStores } from './scene-objects';

const job = workerData as { request: StagedLocationRequest; root: string; runId?: string; deadlineAt?: number; activeArtifact?: StagedLocationContext['activeArtifact']; retry?: StagedLocationContext['retry']; resume?: StagedLocationContext['resume'] };
const own = new AbortController();
const post = (m: StagedWorkerOut) => {
    // an event the structured clone cannot carry goes as JSON (functions and the like dropped)
    try { parentPort!.postMessage(m); } catch { parentPort!.postMessage(JSON.parse(JSON.stringify(m))); }
};
parentPort!.on('message', (m: StagedWorkerIn) => { if (m.kind === 'abort') own.abort(Object.assign(new Error(m.message), { name: m.name ?? 'AbortError' })); });

void (async () => {
    try {
        const deps = await createStagedLocationDeps(job.root, { signal: own.signal });
        const outcome = await runStagedLocation(job.request, { ...deps, ...(job.runId ? { newRunId: () => job.runId! } : {}) }, {
            signal: own.signal,
            emitStage: (event, artifact) => post({ kind: 'event', event, ...(artifact ? { artifact } : {}) }),
            reportProgress: (message, fraction) => post({ kind: 'progress', message, ...(fraction !== undefined ? { fraction } : {}) }),
            ...(job.deadlineAt !== undefined ? { remainingMs: () => job.deadlineAt! - Date.now() } : {}),
            ...(job.activeArtifact ? { activeArtifact: job.activeArtifact } : {}),
            ...(job.retry ? { retry: job.retry } : {}),
            ...(job.resume ? { resume: job.resume } : {})
        });
        post({ kind: 'done', outcome });
        // the scene object store's pass (and the place store's after it) runs after the result: the thread stays until it ends
        await awaitSceneObjectStores();
        post({ kind: 'idle' });
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        post({ kind: 'error', name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}), ...((e as { stage?: string }).stage ? { stage: (e as { stage?: string }).stage } : {}), ...((e as { reasonCode?: string }).reasonCode ? { reasonCode: (e as { reasonCode?: string }).reasonCode } : {}) });
    }
})();
