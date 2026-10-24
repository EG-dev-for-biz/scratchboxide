/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline H: the procedural rebuild of one real building with the decisions the 3D Building reviews of 2026-10-23
 * asked for (docs/processes/3d_building_button_review_2026-10-23.md), on pipeline G's steps (pipeline-g/: survey
 * stations, metric wall plates, facade programs read by a vision model, the native build, paint, facade and roof
 * textures, weak-wall references, the brief). One implementation, two policies (RebuildPolicy): G is the defaults, H
 * sets each rule below. What H changes:
 *
 *  1. The scan leads; vector and Solar data are witnesses (the orchestrator): the structure is seeded on the vector
 *     building nearest the place when one stands within the search window (extraction-sizing.ts, seedFromVector), the
 *     massing is retried from the scan's own plan when the vector massing fails its check, and the footprint lock does
 *     not degrade a build whose footprint is the scan's own plan. Each choice is a ledger entry (ledger.ts).
 *  2. The build commits what it has (H_POLICY.budgetMs): readings get the time a budget leaves, textures and references
 *     are not started without time for them, and the layer is written before the stage's own limit, rather than a
 *     finished survey being thrown away at 900 s (Flatiron run 5c3555af).
 *  3. A reading that still explains under GATE_EXPLAINED of its plate after its re-read is dropped: its wall is painted
 *     in its measured colour, labelled generated, not built from a lattice nobody saw (Flatiron walls 4:1 and fg:0).
 *  4. Continued openings that overlap another opening on their wall, or lie past its ends, are not sent to the native
 *     tool, and the tool's remaining rejections are reported by reason (583 of 678 Flatiron openings were rejected unsaid).
 *  5. The evidence ledger is written into the brief and returned with the outcome.
 *
 * The default for every procedural build (the 3D Building button; user decision 2026-10-23); SCRATCHBOX_STAGED_PROCEDURAL=g
 * or the tool's `pipeline: 'g'` runs G instead. Scored against the Haughwout baseline with .claude/skills/watch-staged-build.
 * Nothing here names a kind of building.
 */

import { PIPELINE_G_VERSION, runPipelineG, type PipelineGInput, type PipelineGOutcome, type RebuildPolicy } from '../pipeline-g/pipeline-g';

export const PIPELINE_H_VERSION = `pipeline-h/v1+${PIPELINE_G_VERSION}`;

/** A reading explaining under this share of its plate, with under this lift over its displaced copies, is dropped (check.ts: a blank-box wall read 0.001-0.04). */
export const GATE_EXPLAINED = 0.05;
export const GATE_LIFT = 1.5;

export const H_POLICY: RebuildPolicy = { name: 'h', gateExplained: GATE_EXPLAINED, gateLift: GATE_LIFT, dedupeContinued: true, rejectionReasons: true, ledger: true };
/** The rebuild's budget is the grammar stage's, less what the slot spent before it, less this margin for committing the layer. */
export const H_BUDGET_MARGIN_MS = 60_000;

export type PipelineHInput = Omit<PipelineGInput, 'policy'> & {
    /** Milliseconds the rebuild may take before the layer must be written (the stage's budget less what the slot already spent, less its margin). */
    budgetMs: number;
};

/**
 * Which procedural pipeline a request runs: H by default (user decision 2026-10-23: the 3D Building button runs
 * pipeline H); 'g' when the tool's `pipeline` or SCRATCHBOX_STAGED_PROCEDURAL asks for G.
 */
export function stagedProcedural(request: { procedural?: boolean; pipeline?: string }, env: NodeJS.ProcessEnv = process.env): 'g' | 'h' {
    const asked = (request.pipeline ?? env.SCRATCHBOX_STAGED_PROCEDURAL ?? '').trim().toLowerCase();
    return asked === 'g' ? 'g' : 'h';
}

export async function runPipelineH(input: PipelineHInput): Promise<PipelineGOutcome> {
    const { budgetMs, ...rest } = input;
    return runPipelineG({ ...rest, policy: { ...H_POLICY, budgetMs } });
}
