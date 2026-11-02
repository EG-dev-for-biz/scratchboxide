/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged location build as the asset recovery service re-runs it (asset-recovery-service.ts): the recorded request,
 * the real dependencies, no chat. Stages whose cache entries still exist are reused; the rest run again.
 */

import type { StagedBuildState } from '../../../common/spatial/staged-location-contracts';
import type { CanvasArtifact } from '../../../browser/generative-canvas/canvas-types';
import type { StagedRebuilder } from '../../asset-store/asset-recovery-service';
import { runStagedLocation, type StagedLocationContext, type StagedLocationRequest } from './orchestrator';
import { createStagedLocationDeps, runStagedLocationOffThread, stagedWorkerEnabled } from './staged-location-tool';

export const rebuildStagedForRecovery: StagedRebuilder = async (request, ctx) => {
    const runCtx: StagedLocationContext = {
        ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.reportProgress ? { reportProgress: ctx.reportProgress } : {}),
        ...(ctx.activeArtifact ? { activeArtifact: ctx.activeArtifact as CanvasArtifact } : {})
    };
    // on its own thread, as the chat's builds are (staged-location-worker.ts): the server keeps answering meanwhile
    const outcome = stagedWorkerEnabled()
        ? await runStagedLocationOffThread(request as StagedLocationRequest, ctx.workspaceRoot, undefined, runCtx)
        : await runStagedLocation(request as StagedLocationRequest, await createStagedLocationDeps(ctx.workspaceRoot, { signal: ctx.signal }), runCtx);
    const artifact = outcome.result.artifact as { data?: { stagedBuild?: StagedBuildState } } | undefined;
    const staged = artifact?.data?.stagedBuild;
    return { runId: staged?.runId ?? '', layers: (staged?.layers ?? []).map(l => ({ url: l.url })) };
};
