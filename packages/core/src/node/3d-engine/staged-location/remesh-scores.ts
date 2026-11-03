/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's two measurements of the polished remesh, off the server's main thread: the clay against Street View before
 * and after the polish (streetview-clay-score.ts) and the holes seen from outside (pipeline-k/visible-defects.ts). Each runs
 * on remesh worker threads (remesh-worker-pool.ts) as the polish does, the Street View score's before and after at once,
 * unless SCRATCHBOX_REMESH_WORKERS=0; the workers call the same inline functions below, so the numbers are the same either
 * way. On the Empire State Building the two held
 * the main thread for 25 s at a stretch (docs/processes/pipeline_k_native_kernels_timing_esb.md: per-pixel edge detection,
 * distance transforms and a software depth render, 16 views twice).
 */

import * as fs from 'fs';
import { readGlbScene, sceneToRenderMesh } from '../../spatial/StreetViewPoseRegistrar';
import { measureVisibleDefects, type VisibleDefectsReport } from './pipeline-k/visible-defects';
import { remeshWorkersEnabled, runRemeshJob } from './remesh-worker-pool';
import { streetViewClayScore, type ClayScore, type ClayScoreView } from './streetview-clay-score';

export interface StreetViewClayScores { before: ClayScore; after: ClayScore }

/** One clay GLB against the survey's Street View photos, on this thread. */
export function streetViewClayScoreOf(clayGlb: string, views: ClayScoreView[]): ClayScore {
    return streetViewClayScore(sceneToRenderMesh(readGlbScene(clayGlb)), views);
}

/** The clay before and after the polish against the survey's Street View photos, on this thread. */
export function streetViewClayScoresInline(beforeGlb: string, afterGlb: string, views: ClayScoreView[]): StreetViewClayScores {
    return { before: streetViewClayScoreOf(beforeGlb, views), after: streetViewClayScoreOf(afterGlb, views) };
}

/** The holes seen on the outside of a textured GLB, on this thread. */
export function visibleDefectsInline(texturedGlb: string): VisibleDefectsReport {
    return measureVisibleDefects(fs.readFileSync(texturedGlb));
}

/**
 * streetViewClayScoresInline on remesh worker threads, the before and the after clay each on its own at once (they are
 * independent), so the step takes about one score's time; inline with SCRATCHBOX_REMESH_WORKERS=0.
 */
export async function streetViewClayScores(beforeGlb: string, afterGlb: string, views: ClayScoreView[], opts: { signal?: AbortSignal } = {}): Promise<StreetViewClayScores> {
    if (!remeshWorkersEnabled()) return streetViewClayScoresInline(beforeGlb, afterGlb, views);
    const run = (clayGlb: string) => runRemeshJob<ClayScore>({ kind: 'streetViewScore', clayGlb, views }, opts.signal ? { signal: opts.signal } : {});
    const [before, after] = await Promise.all([run(beforeGlb), run(afterGlb)]);
    return { before, after };
}

/** visibleDefectsInline on a remesh worker thread (inline with SCRATCHBOX_REMESH_WORKERS=0). */
export async function visibleDefects(texturedGlb: string, opts: { signal?: AbortSignal } = {}): Promise<VisibleDefectsReport> {
    if (!remeshWorkersEnabled()) return visibleDefectsInline(texturedGlb);
    return runRemeshJob<VisibleDefectsReport>({ kind: 'visibleDefects', texturedGlb }, opts.signal ? { signal: opts.signal } : {});
}
