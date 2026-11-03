/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The remesh steps' worker thread (remesh-worker-pool.ts): the wall grammar, the wall sheets, the polish, one facade's
 * structural window fit, and the polished remesh's Street View score and visible-defects check (remesh-scores.ts) run
 * here, each the same function the main thread would call, in a heap of their own. On the
 * server's main thread they held it for up to 11 minutes at a time on the Empire State Building, in a heap the facade
 * reader and the window fit had filled (which alone doubles their time), so the server answered nothing meanwhile.
 *
 * The thread says it is ready, then runs one job a message: { i, job } in, { i, result } or { i, error } out, and the
 * polish's steps as { i, step, state } while it runs.
 */

import { isMainThread, parentPort, workerData } from 'worker_threads';
import { decodePng } from '../../texture-processing';
import { polishRemesh } from './remesh-polish';
import { buildWallSheets } from './wall-sheets';
import { readWallGrammar, type WallGrammarFile } from './wall-grammar';
import { fitOrthoFacades, type OrthoFacade, type WindowFitFile, type WindowFitParams } from './window-fit';
import { streetViewClayScoreOf, visibleDefectsInline } from './remesh-scores';
import type { ClayScoreView } from './streetview-clay-score';

/** The polish's input, its step callback left out (the steps come back as messages). */
export type PolishJobInput = Omit<Parameters<typeof polishRemesh>[0], 'onStep'>;

export type RemeshJob =
    | { kind: 'wallGrammar'; orthosDir: string; fit: WindowFitFile; threads?: number }
    | { kind: 'wallSheets'; orthosDir: string; grammar: WallGrammarFile; fit: WindowFitFile }
    | { kind: 'polish'; input: PolishJobInput }
    | { kind: 'windowFacade'; orthosDir: string; facade: OrthoFacade; params: WindowFitParams }
    | { kind: 'streetViewScore'; clayGlb: string; views: ClayScoreView[] }
    | { kind: 'visibleDefects'; texturedGlb: string };

export type RemeshWorkerMessage =
    | { ready: true }
    | { i: number; result: unknown }
    | { i: number; error: string }
    | { i: number; step: string; state: 'running' | 'done' | 'failed' };

const decode = (b: Buffer) => { const d = decodePng(b); return { rgba: d.rgba, width: d.width, height: d.height }; };

async function run(i: number, job: RemeshJob): Promise<unknown> {
    switch (job.kind) {
        case 'wallGrammar': return readWallGrammar(job.orthosDir, job.fit, decode, undefined, job.threads ? { threads: job.threads } : {});
        case 'wallSheets': return buildWallSheets(job.orthosDir, job.grammar, job.fit, decode);
        case 'polish': return polishRemesh({ ...job.input, onStep: (step, state) => parentPort!.postMessage({ i, step, state } satisfies RemeshWorkerMessage) });
        case 'windowFacade': return (await fitOrthoFacades(job.orthosDir, [job.facade], job.params))[0];
        case 'streetViewScore': return streetViewClayScoreOf(job.clayGlb, job.views);
        case 'visibleDefects': return visibleDefectsInline(job.texturedGlb);
    }
}

if (!isMainThread && (workerData as { remeshWorker?: boolean } | undefined)?.remeshWorker) {
    parentPort!.on('message', (m: { i: number; job: RemeshJob }) => {
        run(m.i, m.job).then(
            result => parentPort!.postMessage({ i: m.i, result } satisfies RemeshWorkerMessage),
            err => parentPort!.postMessage({ i: m.i, error: err instanceof Error ? (err.stack ?? err.message) : String(err) } satisfies RemeshWorkerMessage)
        );
    });
    parentPort!.postMessage({ ready: true } satisfies RemeshWorkerMessage);
}
