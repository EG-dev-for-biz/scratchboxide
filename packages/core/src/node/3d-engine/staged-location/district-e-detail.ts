/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E's detail for every building of a district (user decision 2026-10-22: "let's do this for every building"):
 * the district massing (district-massing.ts, all buildings in one native run) goes through the same two steps an isolated
 * building does:
 * - inference (pipeline-e/inference.ts): roofs, bands, windows from the facade grammar carved at the depth the scan
 *   measures, occluder masks, averaged bays, straightened textures; each step verified and labelled;
 * - measured relief (pipeline-e/relief.ts): each face's scan depth averaged along what repeats, bands swept, reveals set,
 *   each feature gated on its standard error.
 * What a district does not have is left out and said so: Street View colour and the image model's redraw (the survey runs
 * for one structure) and the relief's photo-match layer gate (it needs held-out photos of the structure).
 * A failure in either step leaves the layer before it standing, with the reason.
 */

import * as path from 'path';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { MassingLayerFiles, UnsourcedClosure } from './pipeline-e/pipeline-e';
import { runInferenceE, type InferenceOutcome } from './pipeline-e/inference';
import { runReliefStage, type ReliefOutcome } from './pipeline-e/relief';
import type { DistrictMassingLayer } from './district-massing';

export const DISTRICT_E_DETAIL_VERSION = 'district-e-detail/3';  // 3: texels no stage wrote are filled (pipeline-e.ts closeUnsourcedTexels)

/** The most walls the facade grammar reads in a district (an isolated building reads 12): the nearest to the place first. */
export const DISTRICT_GRAMMAR_MAX_FACADES = 48;

/** On unless SCRATCHBOX_STAGED_DISTRICT_E_DETAIL=0. */
export function districtEDetailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_DISTRICT_E_DETAIL?.trim() !== '0';
}

function unsourcedNote(u: UnsourcedClosure): string {
    return `${u.repeat + u.nearest + u.median} texels on ${u.faces} faces had no source and were filled (generated): ${u.repeat} from their face's repeats, ${u.nearest} from its nearest texel, ${u.median} with its building's median wall colour`;
}

export interface DistrictDetailResult {
    files: MassingLayerFiles;
    inference?: { steps: Array<{ step: string; proposed: number; accepted: number; rejected: number; skipped?: string }>; grammars: number; ms: number };
    relief?: { counts: ReliefOutcome['counts']; built: number; ms: number };
    notes: string[];
}

export async function districtEDetail(input: {
    layer: DistrictMassingLayer; scanGlb: string; dir: string; stageKey: string;
    chain?: VisionModelChain<string>; crowns?: Parameters<typeof runReliefStage>[0]['crowns'];
    signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<DistrictDetailResult> {
    const { layer } = input;
    const notes: string[] = ['Street View colour, the image-model redraw and the relief photo-match gate are single-structure steps and are not run for a district'];
    let files = layer.files;
    let inf: InferenceOutcome | undefined;
    let t0 = Date.now();
    try {
        inf = await runInferenceE({
            massing: layer.massing, run: layer.run, textures: layer.textures, tilePath: input.scanGlb, isolateGlb: layer.isolateGlb,
            dir: path.join(input.dir, 'inference'), stage: 'massing', stageKey: input.stageKey, maxFacades: DISTRICT_GRAMMAR_MAX_FACADES,
            ...(input.chain ? { chain: input.chain } : {}), ...(input.crowns ? { crowns: input.crowns } : {}),
            ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {})
        });
        files = inf.files;
        if (inf.files.unsourced) notes.push(`inference layer: ${unsourcedNote(inf.files.unsourced)}`);
    } catch (err) {
        if (input.signal?.aborted) throw err;
        notes.push(`inference failed (${(err as Error).message}); the clean massing stands`);
    }
    const infMs = Date.now() - t0;
    let rel: ReliefOutcome | undefined;
    t0 = Date.now();
    try {
        rel = await runReliefStage({
            massing: layer.massing, run: layer.run,
            build: inf ? inf.build : { parts: layer.run.report.parts.map(q => { const p = layer.massing.parts.find(x => x.id === q.id)!; return { ...p, loops: q.loops.map(l => l.map(([x, z]) => [x, z] as [number, number])) }; }).filter(p => p.id), sweeps: [], openings: [] },
            base: inf ? { run: inf.run, textures: inf.textures, legend: inf.legend } : { run: layer.run, textures: layer.textures, legend: layer.legend },
            grammars: inf?.grammars ?? [], ...(inf ? { occluderMasks: inf.occluderMasks } : {}), ...(input.crowns ? { crowns: input.crowns } : {}),
            tilePath: input.scanGlb, isolateGlb: layer.isolateGlb, dir: path.join(input.dir, 'relief'), stage: 'massing', stageKey: input.stageKey,
            ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {})
        });
        if (rel.files.unsourced) notes.push(`relief layer: ${unsourcedNote(rel.files.unsourced)}`);
        if (rel.geometry.features.some(f => f.built)) files = rel.files;
        else notes.push('measured relief: nothing stood out of the scan significantly; the layer before it stands');
    } catch (err) {
        if (input.signal?.aborted) throw err;
        notes.push(`measured relief failed (${(err as Error).message}); the layer before it stands`);
    }
    return {
        files, notes,
        ...(inf ? { inference: { steps: inf.steps.map(s => ({ step: s.step, proposed: s.proposed, accepted: s.accepted, rejected: s.rejected, ...(s.skipped ? { skipped: s.skipped } : {}) })), grammars: inf.grammars.length, ms: infMs } } : {}),
        ...(rel ? { relief: { counts: rel.counts, built: rel.geometry.features.filter(f => f.built).length, ms: Date.now() - t0 } } : {})
    };
}
