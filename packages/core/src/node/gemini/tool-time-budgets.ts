/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How long one chat tool call may run. Every tool gets the default limit (5 min, or SCRATCHBOX_TOOL_TIMEOUT_MS)
 * unless it is listed here. A listed tool may run up to `maxMs`, as long as it never goes `idleMs` without a
 * progress report (ToolContext.reportProgress); `idleMs` defaults to `maxMs`, so a tool that cannot report
 * progress gets its whole budget. The user can stop any call with the chat's Stop button.
 *
 * Kept off ToolDeclaration on purpose: declarations are sent to Gemini verbatim.
 */

import { stagedDistrict } from '../3d-engine/staged-location/staged-switches';

export interface ToolTimeBudget {
    /** Hard ceiling for one call, in ms. */
    maxMs: number;
    /** Longest gap allowed between progress reports, in ms (defaults to maxMs). */
    idleMs?: number;
}

const MIN = 60_000;

/** Budgets for tools whose normal runtime is longer than the default limit, with the reason for each. */
export const TOOL_TIME_BUDGETS: Readonly<Record<string, ToolTimeBudget | ((args: Record<string, unknown>) => ToolTimeBudget | undefined)>> = {
    // One image-model call per station (with rerolls and retries) in a chain, then the atlas bake; an 8-station
    // Flatiron run took ~11 min. Reports progress per station, so a stalled model is caught by idleMs.
    survey_beautify_to_texture: { maxMs: 90 * MIN, idleMs: 10 * MIN },
    survey_beautify_to_splats: { maxMs: 90 * MIN, idleMs: 10 * MIN },
    // one AI Beautify image call per texture station (28), then the harvest and the library match
    survey_harvest_swatches: { maxMs: 90 * MIN, idleMs: 10 * MIN },
    // the same harvest when no swatch library is given, then the atlas bake (minutes for a few hundred atlases)
    tile_detail_bake: { maxMs: 90 * MIN, idleMs: 10 * MIN },
    // with a street vantage, up to 6 panos x 4 views of street stations (four at a time) come before the survey's chain
    location_generate_3dgs: args => (typeof args.vantageHeadingDeg === 'number' || typeof args.vantageSideDeg === 'number')
        ? { maxMs: 120 * MIN, idleMs: 15 * MIN }
        : { maxMs: 60 * MIN, idleMs: 10 * MIN },
    // The headless-Chrome tile runner allows itself up to ~38 min for a 72-frame orbit and has its own startup
    // and inactivity watchdogs; the blockout runner adds ffmpeg encodes (10 min cap each).
    // A district (no isolate) rebuilds every building the scan confirms: its massing alone may take 125 min
    // (orchestrator.ts DISTRICT_RUN_BUDGET_MS, 140 min, plus the run's 2 min margin).
    // Pipeline K-D builds a large district as chunks, each a district build of its own, several at a time
    // (orchestrator.ts CHUNKED_DISTRICT_RUN_BUDGET_MS, 360 min, plus the margin).
    // kd is a district's look: the call's district (or its pipeline 'kd'), which overrides isolate, else
    // SCRATCHBOX_STAGED_DISTRICT=kd for a call without isolate.
    google_3d_tiles_get_clay: args => {
        const asked = typeof args.district === 'string' ? args.district : args.pipeline === 'kd' ? 'kd' : undefined;
        const kd = asked !== undefined ? stagedDistrict({ district: asked }) === 'kd' : args.isolate !== true && stagedDistrict({}) === 'kd';
        return { maxMs: kd ? 362 * MIN : args.isolate === true ? 40 * MIN : 142 * MIN };
    },
    google_3d_tiles_get_full_texture: { maxMs: 40 * MIN },
    google_3d_tiles_clay_blockout_runner: { maxMs: 60 * MIN },
    // With a location it ingests 3D Tiles (above) before running the script.
    execute_3d_python_script: { maxMs: 45 * MIN },
    // Image, vision and native build calls with up to two revision passes; with a location it first stages on 3D
    // Tiles (above), which can go a long time between progress reports.
    build_3d_object_from_reference: { maxMs: 50 * MIN },
    // The UV rewrap and the detail bake (the first call after an engine change also builds both binaries), plus one image
    // call per painted decal; reports progress before the bake.
    object_detail_pass: { maxMs: 20 * MIN, idleMs: 12 * MIN },
    // With a place not yet built it extracts and isolates the structure from 3D Tiles first (minutes, cached after), then
    // the grounding fetches, the registration (up to 90 s edges + 120 s joint) and, optionally, the segmenter per view.
    streetview_survey: { maxMs: 40 * MIN, idleMs: 10 * MIN },
    // The first call compiles the native binary (up to 10 min) before the run (up to 5 min).
    tile_refine: { maxMs: 16 * MIN },
    // Street View discovery and fetch, edge registration (worker thread), then several judge calls per view; reports
    // progress at each step and after every judged view.
    photo_match_evaluate: { maxMs: 30 * MIN, idleMs: 10 * MIN },
    // Leaf-tile extraction rounds, tree measurement, the mask vote's vision calls and tile_refine (each first-use build
    // up to 10 min); reports progress between steps.
    location_isolate_structure: { maxMs: 30 * MIN, idleMs: 15 * MIN },
    // One block extraction, a structure pick per building, the tree strip, the per-triangle split and one GLB pair per
    // building; with the mask vote, a render, vision outlines and an isolate per building.
    location_split_block: { maxMs: 45 * MIN, idleMs: 15 * MIN },
    // The first call compiles the native audit binary (up to 10 min); an audit itself takes well under a minute per layer.
    location_residual_audit: { maxMs: 15 * MIN },
    // Native cluster LOD build: about 2 s per 170k triangles, longer for multi-million-triangle scans.
    virtual_geometry_open_glb: { maxMs: 12 * MIN },
    // The same build, then one high-sample render (a 4K still at 1024 spp is about a minute on an M1 Ultra).
    path_trace_render: { maxMs: 20 * MIN },
    // Several serial image-model calls each.
    panorama_to_3dgs: { maxMs: 15 * MIN },
    mesh_bake_ai_textures: { maxMs: 15 * MIN },
    panorama_generate_perspectives: { maxMs: 15 * MIN },
    // Up to 12 serial image-model calls (one per station, progress after each), then an optional Trellis
    // reconstruction on Fal.ai, which reports nothing until it finishes.
    generate_multi_angle_turnaround: { maxMs: 30 * MIN, idleMs: 10 * MIN },
    spatial_keyframe_video_interpolation: { maxMs: 15 * MIN },
    // One MediaPipe (Python) process per sampled frame: 15 fps over a 60 s clip is 900 of them. Both report progress
    // after every frame; idleMs also covers extracting all the frames with ffmpeg first.
    vfx_mediapipe_track_video_motion: { maxMs: 60 * MIN, idleMs: 10 * MIN },
    vfx_video_auto_reframe: { maxMs: 30 * MIN, idleMs: 10 * MIN },
    // A full read-only agent run of up to 20 model turns.
    invoke_subagent: { maxMs: 30 * MIN },
    // The model sets the command's own timeout; give the call that long plus a margin, within an hour.
    workspace_run_command: args => {
        const requested = Number(args.timeoutMs);
        return Number.isFinite(requested) && requested > 0 ? { maxMs: Math.min(60 * MIN, requested + 30_000) } : undefined;
    }
};

/** The effective limits for one call: the tool's budget when it has one, else the default limit for both. */
export function resolveToolTimeBudget(toolName: string, args: Record<string, unknown> | undefined, defaultMs: number): Required<ToolTimeBudget> {
    // Own properties only: a tool named e.g. "valueOf" must not pick up Object.prototype members.
    const entry = Object.prototype.hasOwnProperty.call(TOOL_TIME_BUDGETS, toolName) ? TOOL_TIME_BUDGETS[toolName] : undefined;
    const budget = typeof entry === 'function' ? entry(args || {}) : entry;
    if (!budget) return { maxMs: defaultMs, idleMs: defaultMs };
    const maxMs = Math.max(defaultMs, budget.maxMs);
    return { maxMs, idleMs: Math.min(maxMs, budget.idleMs ?? maxMs) };
}
