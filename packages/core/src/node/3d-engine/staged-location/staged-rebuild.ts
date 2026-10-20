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
import type { StagedRebuilder } from '../../asset-store/asset-recovery-service';
import { runStagedLocation, type StagedLocationRequest } from './orchestrator';
import { createStagedLocationDeps } from './staged-location-tool';

export const rebuildStagedForRecovery: StagedRebuilder = async (request, ctx) => {
    const deps = await createStagedLocationDeps(ctx.workspaceRoot, { signal: ctx.signal });
    const outcome = await runStagedLocation(request as StagedLocationRequest, deps, { signal: ctx.signal, reportProgress: ctx.reportProgress });
    const artifact = outcome.result.artifact as { data?: { stagedBuild?: StagedBuildState } } | undefined;
    const staged = artifact?.data?.stagedBuild;
    return { runId: staged?.runId ?? '', layers: (staged?.layers ?? []).map(l => ({ url: l.url })) };
};
