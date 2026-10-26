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
 *  6. The facades are built on the scan-led massing (the orchestrator, scan-massing.ts): the simplest of block, block with
 *     its roof objects (outlines from the photo straight down, heights from the scan) and tiers that explains the
 *     structure's scan is built natively first and its walls are the ones surveyed; its roof objects replace the scan-blob
 *     ones (roof-objects.ts). E's vector massing stays, with the reason in the ledger, when the scan's winner is lofted
 *     sections (no flat walls to read) or the scan massing fails.
 *
 * The default procedural build from 2026-10-23 until pipeline I took the 3D Building button on 2026-10-24; still the default
 * where pipeline I's services are not wired. SCRATCHBOX_STAGED_PROCEDURAL or the tool's `pipeline` picks G, H or I. Scored against the Haughwout baseline with .claude/skills/watch-staged-build.
 * Nothing here names a kind of building.
 */

import { PIPELINE_G_VERSION, runPipelineG, type PipelineGInput, type PipelineGOutcome, type RebuildPolicy } from '../pipeline-g/pipeline-g';

export const PIPELINE_H_VERSION = `pipeline-h/v2+${PIPELINE_G_VERSION}`;  // v2: the facades are built on the scan-led massing (scan-massing.ts)

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
 * Which procedural pipeline a request runs: I by default when its services are wired (user decision 2026-10-24: the 3D
 * Building button runs pipeline I, the character sheet made into a model by Trellis and fitted to the scan), else H (the
 * 2026-10-23 default; stand-in deps such as the tests' never reach the paid services); 'g', 'h', 'i' or 'j' when the
 * tool's `pipeline` or SCRATCHBOX_STAGED_PROCEDURAL asks for one. 'j' runs the same character sheet and scan fit as 'i',
 * with Meshy in place of Trellis as the 3D model service (pipeline-i.ts, fal-meshy.ts). An explicit 'i' or 'j' without
 * the services runs I, which then says why it cannot build.
 */
export function stagedProcedural(request: { procedural?: boolean; pipeline?: string }, env: NodeJS.ProcessEnv = process.env, pipelineIServices = false): 'g' | 'h' | 'i' | 'j' {
    const asked = (request.pipeline ?? env.SCRATCHBOX_STAGED_PROCEDURAL ?? '').trim().toLowerCase();
    if (asked === 'g' || asked === 'h' || asked === 'i' || asked === 'j') return asked;
    // pipeline J (Meshy, one seed, no colour match) is the 3D Building default (user decision 2026-10-25); I (Trellis) stays selectable
    return pipelineIServices ? 'j' : 'h';
}

export async function runPipelineH(input: PipelineHInput): Promise<PipelineGOutcome> {
    const { budgetMs, ...rest } = input;
    return runPipelineG({ ...rest, policy: { ...H_POLICY, budgetMs } });
}
