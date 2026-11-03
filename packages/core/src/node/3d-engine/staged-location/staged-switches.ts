/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build's environment switches, one meaning each (user decision, 2026-10-30):
 *  - SCRATCHBOX_STAGED_BUILDING_PIPELINE=j|k: the pipeline an isolated building is rebuilt by when the request names none
 *    ('k' is already the default for one building; 'j' makes the procedural pipeline the default instead);
 *  - SCRATCHBOX_STAGED_MODEL_SERVICE=meshy|trellis: the 3D model service pipeline J sends its character sheet to when the
 *    request names none (Meshy 7.1 by default, one seed; Trellis multi, best of six seeds and a swatch colour match);
 *  - SCRATCHBOX_STAGED_DISTRICT=scan|massing|rebuilt|kd: a district shown as its remeshed scan, with pipeline E's massing
 *    for every building the scan confirms (the default, district-massing.ts), rebuilt (every building, the ground and the
 *    streets recreated, the scan kept as the reference they supersede), or kd (pipeline K over the whole district, in
 *    chunks: every facade straightened on the scan, no massing; pipeline-k/district-chunks.ts). A request's `district`
 *    comes first; the staged tool still takes `pipeline: 'kd'` for it.
 * They replace SCRATCHBOX_STAGED_PROCEDURAL, which carried both a pipeline letter and 1 for a rebuilt district, and
 * SCRATCHBOX_STAGED_DISTRICT_MASSING. Pipelines G and H were retired and I merged into J as its Trellis service (user
 * decision, 2026-10-30). A retired switch or letter is not read: one still set is reported once, with the setting that
 * replaces it, so a stale environment never changes a build unnoticed. SCRATCHBOX_STAGED_PIPELINE (pipeline E on or off)
 * is a separate switch and unchanged.
 */

export type StagedBuildingPipeline = 'j' | 'k';
export type StagedModelService = 'meshy' | 'trellis';
export type StagedDistrictMode = 'scan' | 'massing' | 'rebuilt' | 'kd';

export const STAGED_BUILDING_PIPELINES: readonly StagedBuildingPipeline[] = ['j', 'k'];
export const STAGED_MODEL_SERVICES: readonly StagedModelService[] = ['meshy', 'trellis'];
export const STAGED_DISTRICT_MODES: readonly StagedDistrictMode[] = ['scan', 'massing', 'rebuilt', 'kd'];
/** The switches these replace (2026-10-30). */
export const RETIRED_STAGED_SWITCHES = ['SCRATCHBOX_STAGED_PROCEDURAL', 'SCRATCHBOX_STAGED_DISTRICT_MASSING'] as const;
/** The pipeline letters retired on 2026-10-30, and what to ask for instead. */
export const RETIRED_PIPELINE_LETTERS: Readonly<Record<string, string>> = {
    g: 'pipelines G and H were retired on 2026-10-30; pipeline J is the procedural build',
    h: 'pipelines G and H were retired on 2026-10-30; pipeline J is the procedural build',
    i: 'pipeline I is now pipeline J with the Trellis model service'
};

const valueOf = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim().toLowerCase();
const isPipeline = (v: string): v is StagedBuildingPipeline => (STAGED_BUILDING_PIPELINES as readonly string[]).includes(v);
const isModelService = (v: string): v is StagedModelService => (STAGED_MODEL_SERVICES as readonly string[]).includes(v);
const isDistrictMode = (v: string): v is StagedDistrictMode => (STAGED_DISTRICT_MODES as readonly string[]).includes(v);
const isRetiredLetter = (v: string): boolean => Object.prototype.hasOwnProperty.call(RETIRED_PIPELINE_LETTERS, v);

/** The building pipeline the environment asks for; undefined when it asks for none, or for one that does not exist. */
export function stagedBuildingPipelineEnv(env: NodeJS.ProcessEnv = process.env): StagedBuildingPipeline | undefined {
    const v = valueOf(env, 'SCRATCHBOX_STAGED_BUILDING_PIPELINE');
    return isPipeline(v) ? v : undefined;
}

/** Pipeline J's model service: the request's, else the environment's, else Meshy. */
export function stagedModelService(request: { modelService?: string }, env: NodeJS.ProcessEnv = process.env): StagedModelService {
    const asked = (request.modelService ?? '').trim().toLowerCase();
    if (isModelService(asked)) return asked;
    const v = valueOf(env, 'SCRATCHBOX_STAGED_MODEL_SERVICE');
    return isModelService(v) ? v : 'meshy';
}

/** How a district is shown: 'massing' unless the environment asks for 'scan', 'rebuilt' or 'kd'. */
export function stagedDistrictMode(env: NodeJS.ProcessEnv = process.env): StagedDistrictMode {
    const v = valueOf(env, 'SCRATCHBOX_STAGED_DISTRICT');
    return isDistrictMode(v) ? v : 'massing';
}

/** How this build's district is shown: the request's, else the environment's, else massing. */
export function stagedDistrict(request: { district?: string }, env: NodeJS.ProcessEnv = process.env): StagedDistrictMode {
    const asked = (request.district ?? '').trim().toLowerCase();
    return isDistrictMode(asked) ? asked : stagedDistrictMode(env);
}

/** The new setting that does what a pipeline letter asked for. */
function letterReplacement(v: string): string {
    if (v === 'i') return 'SCRATCHBOX_STAGED_BUILDING_PIPELINE=j and SCRATCHBOX_STAGED_MODEL_SERVICE=trellis';
    return `SCRATCHBOX_STAGED_BUILDING_PIPELINE=${v === 'g' || v === 'h' ? 'j' : v}`;
}

/** The new setting that does what a retired switch's value asked for. */
function replacementOf(name: typeof RETIRED_STAGED_SWITCHES[number], v: string): string {
    if (name === 'SCRATCHBOX_STAGED_DISTRICT_MASSING') return v === '0' ? 'SCRATCHBOX_STAGED_DISTRICT=scan' : 'SCRATCHBOX_STAGED_DISTRICT=massing (the default)';
    if (isRetiredLetter(v)) return `${letterReplacement(v)} (${RETIRED_PIPELINE_LETTERS[v]})`;
    if (isPipeline(v)) return letterReplacement(v);
    if (v === '1') return 'SCRATCHBOX_STAGED_DISTRICT=rebuilt';
    if (v === 'kd') return 'SCRATCHBOX_STAGED_DISTRICT=kd';
    return `SCRATCHBOX_STAGED_BUILDING_PIPELINE=${STAGED_BUILDING_PIPELINES.join('|')} for the building, or SCRATCHBOX_STAGED_DISTRICT=rebuilt for the district`;
}

/** What is wrong with the staged switches in `env`, one sentence each: retired switches still set, values a switch does not take. */
export function stagedSwitchProblems(env: NodeJS.ProcessEnv = process.env): string[] {
    const out: string[] = [];
    for (const name of RETIRED_STAGED_SWITCHES) {
        const raw = (env[name] ?? '').trim();
        if (raw) out.push(`${name}=${raw} is no longer read (replaced 2026-10-30): set ${replacementOf(name, raw.toLowerCase())}.`);
    }
    const pipeline = valueOf(env, 'SCRATCHBOX_STAGED_BUILDING_PIPELINE');
    if (isRetiredLetter(pipeline)) out.push(`SCRATCHBOX_STAGED_BUILDING_PIPELINE=${pipeline} is ignored: ${RETIRED_PIPELINE_LETTERS[pipeline]}; set ${letterReplacement(pipeline)}.`);
    else if (pipeline === 'kd') out.push('SCRATCHBOX_STAGED_BUILDING_PIPELINE=kd is ignored: kd is how a district is shown; set SCRATCHBOX_STAGED_DISTRICT=kd.');
    else if (pipeline && !isPipeline(pipeline)) out.push(`SCRATCHBOX_STAGED_BUILDING_PIPELINE takes ${STAGED_BUILDING_PIPELINES.join(', ')}; "${pipeline}" is ignored.`);
    const service = valueOf(env, 'SCRATCHBOX_STAGED_MODEL_SERVICE');
    if (service && !isModelService(service)) out.push(`SCRATCHBOX_STAGED_MODEL_SERVICE takes ${STAGED_MODEL_SERVICES.join(', ')}; "${service}" is ignored, so pipeline J uses Meshy.`);
    if (valueOf(env, 'SCRATCHBOX_STAGED_GEOMETRY') === 'g') out.push(`SCRATCHBOX_STAGED_GEOMETRY=g is ignored: ${RETIRED_PIPELINE_LETTERS.g}; set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j.`);
    const district = valueOf(env, 'SCRATCHBOX_STAGED_DISTRICT');
    if (district && !isDistrictMode(district)) out.push(`SCRATCHBOX_STAGED_DISTRICT takes ${STAGED_DISTRICT_MODES.join(', ')}; "${district}" is ignored, so a district has its massing.`);
    return out;
}

let reported = false;
/** Logs stagedSwitchProblems once per process: at server start, else at the first build. */
export function reportStagedSwitchProblems(env: NodeJS.ProcessEnv = process.env, log: (message: string) => void = console.warn): void {
    if (reported) return;
    reported = true;
    for (const problem of stagedSwitchProblems(env)) log(`[staged-location] ${problem}`);
}

/**
 * The most leaf tiles one extraction keeps (SCRATCHBOX_STAGED_MAX_LEAF_TILES, a whole number from 1 to 6000), for an
 * experiment that needs a district's scan to reach further than the default 524 nearest leaves; unset, the extraction's
 * own default stands. A dense place at the default reaches about 80 m, short of its large buildings.
 */
export function stagedMaxLeafTiles(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const n = Number(env.SCRATCHBOX_STAGED_MAX_LEAF_TILES?.trim());
    return Number.isInteger(n) && n >= 1 && n <= 6000 ? n : undefined;
}
