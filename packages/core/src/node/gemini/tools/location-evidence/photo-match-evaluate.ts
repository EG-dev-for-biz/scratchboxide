/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * photo_match_evaluate: does a location build look like the real place, judged against real Street View photos it never saw?
 *
 * The in-app face of the photo-match evaluator (3d-engine/staged-location/photo-match-eval.ts, whose behaviour is unchanged
 * here; scripts/dev/photo-match-heldout.ts and photo-match-eval.ts are the dev drivers this follows):
 *  1. the build: a staged run (its layers from the open scene, its tile, its isolate and every pano it used from the stage
 *     cache), or GLB paths plus a geodetic anchor; several builds can be compared at once (arms);
 *  2. held-out views: Google-captured panos near the structure that no arm used (checked against every pano id the runs'
 *     records, notes, scene and GLBs name), one view each aimed at the structure, kept when the structure fills enough of the
 *     frame and the tile mesh does not hide most of it; the images come through the grounding API and are posed against the
 *     full tile mesh by edge registration; a view is used only when its edge residual locks (at most 5 px, lower than the start);
 *  3. every arm is rendered from exactly each pose, in its street (the photo-textured tile with the target cut out, the same
 *     for every arm), and judged blind against the photo with reshuffled orders; pixel metrics are secondary;
 *  4. the clay arm (on unless clay: false): every arm rendered again from the same poses in one uniform clay, its street in a
 *     lighter clay, judged blind for shape only, so a geometry change the photo texture hides (relief, reveals) is scored;
 *  5. trees (on unless trees: false): a run's regrown SB-Veggie trees are drawn as the viewport would draw them from each pose,
 *     one level per tree by on-screen size and place in the frame with the leaf instances expanded (photo-match-eval.ts
 *     loadArmLayer / armMeshesForView), and the scanned trees the strip measured are cut from the street, so the photo's trees
 *     are compared with the regrown ones and not drawn twice.
 * No view that cannot be found or registered is ever scored: those end the call with a typed error.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from '../types';
import type { StagedBuildState, StagedLayer, Vec3 } from '../../../../common/spatial/staged-location-contracts';
import {
    aggregateRuns, armLayerTriangles, armMeshesForView, composeGrid, coverageMask, judgeView, judgeViewClay, loadArmLayer, perceptualScores, renderPng, renderTriangles, JUDGE_CRITERIA,
    type ArmLayer, type ArmRender, type CriterionStat, type JudgeClient, type JudgeCriterion, type JudgeRun, type PerceptualScores
} from '../../../3d-engine/staged-location/photo-match-eval';
import { readTileTriangles, decodeImageInMemory, type TileTriangles } from '../../../3d-engine/staged-location/tile-texture-transfer';
import { fetchOrthoReference, orthoReferenceCamera, type OrthoReference } from '../../../3d-engine/staged-location/ortho-reference';
import { castCamera } from '../../../3d-engine/staged-location/survey-casting';
import { isTreesLodJson } from '../../../3d-engine/staged-location/tree-lod-view';
import { bearingDeg, discoverPanos, fetchViews, type PanoCandidate, type SelectedView, type StreetViewEvidenceDeps } from '../../../3d-engine/staged-location/streetview-evidence';
import { EDGE_MAX_RESIDUAL_PX, type HeldImage } from '../../../3d-engine/staged-location/pano-edge-registration';
import { runPanoRegistrationOffThread } from '../../../3d-engine/staged-location/pano-registration-run';
import { StageCache, stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';
import { appendJudgeRow, judgeRowFromReport } from '../../../3d-engine/staged-location/run-ledger';
import { readGlbScene, renderFrameDepth, sceneToRenderMesh, type PoseCorrection } from '../../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import type { GeodeticOrigin } from '../../../spatial/StreetViewSurveyPlanner';
import { resolveWithinRoot } from '../../../security/path-guard';

export const PHOTO_MATCH_EVALUATE_TOOL = 'photo_match_evaluate';

/** The judge asked first (then the chat's fallbacks; a model not served moves on and is recorded). */
export const PHOTO_MATCH_DEFAULT_JUDGE = 'gemini-4-argon';
export const PHOTO_MATCH_DEFAULT_VIEWS = 4;
export const PHOTO_MATCH_MAX_VIEWS = 8;
export const PHOTO_MATCH_DEFAULT_RUNS = 3;
export const PHOTO_MATCH_MAX_RUNS = 6;
/** Least share of the structure a candidate view must see past what stands in front (the dev driver's HELD_MIN_VIS). */
export const HELD_OUT_MIN_VISIBLE = 0.3;
/** Least share of the frame the structure must fill. */
export const HELD_OUT_MIN_SCREEN = 0.06;

export const PHOTO_MATCH_EVALUATE_DECLARATION: ToolDeclaration = {
    name: PHOTO_MATCH_EVALUATE_TOOL,
    description:
        'Check how much a location build looks like the real place, against real Google Street View photos the build never used. ' +
        'Use it to check a location build (google_3d_tiles_get_clay, tile_refine output, any GLB in the tile frame) BEFORE telling the user it looks right or that one version is better than another. ' +
        'It picks held-out Street View views near the structure (never a pano any build used: it checks), registers each against the tile mesh (a view that does not lock is not used), ' +
        'renders every build from exactly those camera poses in its street, and has a vision model score the renders blind against each photo (shuffled and unlabelled, several runs) ' +
        'on shape, materials, detail, errors (10 = nothing wrong or invented), overall, realism (looks like a real photograph) and identity (recognisably this place), 1-10. Returns per-view and mean scores per criterion with their spread across runs and views, ' +
        'pixel metrics (SSIM, edge chamfer, colour difference: secondary, they do not rank builds reliably), the grid images (photo beside each render) and a short summary. ' +
        'By default it also renders every build in uniform untextured clay from the same poses and has the judge score shape only (massing, openings, surface relief) against the photo: ' +
        'clayScores, clay grids; use them to compare geometry changes (relief, reveals, massing) that the photo texture hides. ' +
        'With no build named it evaluates the open staged scene. Compare versions by passing arms. Scores are relative judgements, not measurements: report the spread, and say when the views are few. ' +
        'Fails with a typed error (no scores) when no held-out view can be found or registered. Takes a few minutes (Street View fetch, registration, several judge calls per view).',
    parameters: {
        type: 'OBJECT',
        properties: {
            runId: { type: 'STRING', description: 'The staged run to evaluate (8 hex, the retryRunId / stagedBuild.runId of a google_3d_tiles_get_clay build). Default: the open staged scene.' },
            glbs: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Instead of a run: the GLB layers of one build, in the tile frame (x east, y up, z south, metres; /models/<name>.glb URLs, workspace paths or absolute paths). Needs anchor.' },
            anchor: {
                type: 'OBJECT',
                description: 'With glbs: the geodetic origin of their frame.',
                properties: { lat: { type: 'NUMBER' }, lng: { type: 'NUMBER' }, heightMeters: { type: 'NUMBER', description: 'Ellipsoidal height of the frame origin (the tile extraction\'s); found from the tile cache when omitted.' } },
                required: ['lat', 'lng']
            },
            tileGlb: { type: 'STRING', description: 'With glbs: the photo-textured Google 3D Tiles GLB in the same frame (registration, occlusion and context). Default: the cached extraction at the anchor.' },
            isolateGlb: { type: 'STRING', description: 'With glbs: the isolated raw scan of the target (tile_refine\'s raw_clay.glb), cut out of the tile for the in-context renders.' },
            arms: {
                type: 'ARRAY',
                description: 'Several builds to compare at once, each a run or GLBs (all in the same frame). Replaces runId/glbs.',
                items: {
                    type: 'OBJECT',
                    properties: {
                        id: { type: 'STRING', description: 'Short id (letters/digits).' },
                        label: { type: 'STRING' },
                        runId: { type: 'STRING' },
                        glbs: { type: 'ARRAY', items: { type: 'STRING' } }
                    }
                }
            },
            views: { type: 'NUMBER', description: `Held-out views to judge (default ${PHOTO_MATCH_DEFAULT_VIEWS}, at most ${PHOTO_MATCH_MAX_VIEWS}).` },
            inContext: { type: 'BOOLEAN', description: 'Render each build inside the photo-textured tile with only the target cut out, the same street for every build (default true). False renders it alone on grey with the tile as an occluder.' },
            judgeModel: { type: 'STRING', description: `Vision model asked first (default ${PHOTO_MATCH_DEFAULT_JUDGE}; the chat's fallbacks follow).` },
            runs: { type: 'NUMBER', description: `Blind judgements per view, each with the order reshuffled (default ${PHOTO_MATCH_DEFAULT_RUNS}).` },
            clay: { type: 'BOOLEAN', description: 'Also judge every build rendered in uniform clay (no texture) from the same poses, for shape only (default true; one more judge call per view and run).' },
            trees: { type: 'BOOLEAN', description: 'Draw a run\'s regrown trees as the viewport shows them from each pose (one level of detail per tree, leaves expanded) and cut the scanned trees they replace out of the street (default true). False leaves the trees layer out and the scanned trees in the street.' },
            baseline: { type: 'BOOLEAN', description: 'Also render the raw scan as downloaded (cut to the target) as a reference arm (default true when the tile is known).' },
            place: { type: 'STRING', description: 'The place as named to the judge (default: the run\'s resolved address).' },
            excludePanoIds: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Panos the build used that the records do not show (GLB builds made elsewhere): never held out.' },
            includeSatelliteOrtho: { type: 'BOOLEAN', description: 'Also fetch a Google Static Maps satellite crop centred on the place (zoom 19, 2048 px, its ground sample distance computed) and show the judge each build rendered top-down at that scale beside it, as one extra view labelled "satellite (Google Static Maps, date unknown)". A second opinion: reported in satelliteOrtho with the GSD, not counted in scores (default false; one Static Maps request and one or two more judge calls).' }
        }
    }
};

// =============================================================================
// errors and dependencies
// =============================================================================

export type PhotoMatchErrorCode =
    | 'bad_arguments' | 'no_build' | 'run_not_found' | 'run_layers_unknown' | 'missing_glb' | 'missing_reference_tile' | 'frame_mismatch'
    | 'street_view_unavailable' | 'no_heldout_candidates' | 'no_heldout_fetched' | 'no_heldout_registered' | 'heldout_used_by_build'
    | 'judge_unavailable' | 'judge_failed' | 'satellite_unavailable' | 'stopped' | (string & {});

/** A failure with a code the model can act on; no scores are returned with it. */
export class PhotoMatchError extends Error {
    constructor(readonly code: PhotoMatchErrorCode, message: string, readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'PhotoMatchError';
    }
}

/** One registered held-out pano: its edge residual before and after, and the pose correction to use. */
export interface HeldOutRegistration {
    panoId: string;
    edgeResidualPx: { prior: number | null; edge: number | null };
    correction?: PoseCorrection;
    reason: string;
}

/** What the evaluation reaches outside this process; the defaults are the app's own services. */
export interface PhotoMatchDeps {
    /** Root of the staged caches and public/models (stagedWorkspaceRoot()). */
    stagedRoot(): string;
    /** Google-captured panos near `centre` (tile frame), the grounding API's known refusals left out. */
    discover(origin: GeodeticOrigin, centre: { x: number; z: number }, cacheDir: string, signal?: AbortSignal): Promise<PanoCandidate[]>;
    /** The grounding service on the app's service account. Throws street_view_unavailable when it is not configured. */
    grounding(): NonNullable<StreetViewEvidenceDeps['grounding']>;
    /** Edge registration of the images against the tile mesh files (in a worker thread). */
    register(images: HeldImage[], meshFiles: string[], signal?: AbortSignal, log?: (m: string) => void): Promise<HeldOutRegistration[]>;
    /** The blind judge, `model` first. Throws judge_unavailable when no Gemini credentials are configured. */
    judge(model: string, signal?: AbortSignal): Promise<JudgeClient & { requested?: string; answeredModel?: string; skipped?: Array<{ model: string; reason: string }> }>;
    /**
     * The Static Maps satellite crop centred on the frame origin (includeSatelliteOrtho). Throws satellite_unavailable when
     * no Maps API key is configured. Missing: the option fails with that code and the street views are still judged.
     */
    satelliteOrtho?(origin: GeodeticOrigin, signal?: AbortSignal): Promise<OrthoReference>;
    now?: () => number;
}

export function defaultPhotoMatchDeps(): PhotoMatchDeps {
    // loaded on use: the Gemini client pulls in the auth stack, which tests that inject their own deps never need
    const gem = () => require('../../gemini-client') as typeof import('../../gemini-client');
    const maps = () => require('../../../../browser/generative-canvas/services/google-maps-service') as typeof import('../../../../browser/generative-canvas/services/google-maps-service');
    return {
        stagedRoot: stagedWorkspaceRoot,
        discover: async (origin, centre, cacheDir, signal) => {
            const r = await discoverPanos(origin, [], { mapsApiKey: maps().resolveMapsApiKey(), metadataCachePath: path.join(cacheDir, 'streetview', 'metadata.json') }, signal, centre);
            return r.panos;
        },
        grounding: () => {
            const { GeminiClient } = gem();
            const gemini = new GeminiClient();
            if (!gemini.ensureAuth()) throw new PhotoMatchError('street_view_unavailable', 'Street View images come through the Maps Imagery Grounding API on the app\'s Google Cloud service account, and none is configured (Settings).');
            const { createStreetViewGroundingImageService } = require('../../../spatial/StreetViewGroundingImageService') as typeof import('../../../spatial/StreetViewGroundingImageService');
            return createStreetViewGroundingImageService(gemini);
        },
        register: async (images, meshFiles, signal, log) => {
            const out = await runPanoRegistrationOffThread({ images, meshFiles, correspondences: [], faces: [], joint: false }, { signal, log });
            return (out.edge?.panos ?? []).map(p => ({ panoId: p.panoId, edgeResidualPx: p.edgeResidualPx, ...(p.edge ? { correction: p.edge } : {}), reason: p.reason }));
        },
        judge: async (model, signal) => {
            const { GeminiClient, FALLBACK_GEMINI_MODELS } = gem();
            const client = await new GeminiClient().getGenAIClient();
            if (!client) throw new PhotoMatchError('judge_unavailable', 'no Gemini credentials are configured for the judge (add a service account or an API key in Settings)');
            const { VisionModelChain } = require('../../vision-model-chain') as typeof import('../../vision-model-chain');
            const chain = new VisionModelChain<string>({ client: client as never, candidates: [...new Set([model, ...FALLBACK_GEMINI_MODELS])], ...(signal ? { signal } : {}) });
            return chain as unknown as JudgeClient & { requested: string; answeredModel?: string; skipped: Array<{ model: string; reason: string }> };
        },
        satelliteOrtho: async (origin, signal) => {
            const apiKey = maps().resolveMapsApiKey();
            if (!apiKey) throw new PhotoMatchError('satellite_unavailable', 'the Static Maps satellite crop needs a Google Maps Platform API key (GOOGLE_MAPS_API_KEY or Settings), and none is configured.');
            return fetchOrthoReference({ lat: origin.lat, lng: origin.lng, zoom: 19, sizePx: 1024, scale: 2, apiKey, ...(signal ? { signal } : {}) });
        }
    };
}

// =============================================================================
// the build: runs, GLBs, the reference tile and the panos the build used
// =============================================================================

interface ArmSpec { id: string; label: string; runId?: string; glbs?: string[] }

interface ResolvedArm { id: string; label: string; glbs: string[]; runId?: string; layers?: Array<{ layer: string; textured: boolean }>; baseline?: boolean; keepNear?: string }

interface Reference {
    origin: GeodeticOrigin;
    place: string;
    /** The photo-textured tile and its geometry (registration, occlusion, context). */
    tileTextured: string;
    tileGeometry: string;
    /** The isolated raw scan of the target (the cut), when the build isolated one. */
    isolate?: string;
    /** The scanned trees the run's strip measured and removed (tile_vegetation removed_trees.glb), cut from the street when trees are drawn. */
    removedTrees?: string;
    source: string;
}

interface RunRecordLike {
    runId: string;
    request?: { query?: string; isolate?: boolean };
    place?: { lat: number; lng: number; formattedAddress?: string };
    keys?: Record<string, string>;
}

const RUN_ID = /^[0-9a-f]{8}$/;
const PANO_KEY = /^sv:([^:]+):/;

/** Every pano id a JSON value names: `panoId` strings, `panoIds` arrays and "sv:<panoId>:..." ids. */
export function collectPanoIds(value: unknown, into: Set<string> = new Set()): Set<string> {
    const walk = (v: unknown, key?: string): void => {
        if (typeof v === 'string') {
            if (key === 'panoId' && v) into.add(v);
            const m = PANO_KEY.exec(v);
            if (m) into.add(m[1]);
            return;
        }
        if (Array.isArray(v)) {
            for (const x of v) {
                if (key === 'panoIds' && typeof x === 'string' && x) into.add(x);
                else walk(x);
            }
            return;
        }
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    };
    walk(value);
    return into;
}

/** The JSON chunk of a GLB (asset, node and material extras), or undefined when it is not a GLB. */
function glbJson(file: string): unknown {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(20);
        if (fs.readSync(fd, head, 0, 20, 0) < 20 || head.readUInt32LE(0) !== 0x46546c67) return undefined;
        const len = head.readUInt32LE(12);
        const json = Buffer.alloc(len);
        fs.readSync(fd, json, 0, len, 20);
        return JSON.parse(json.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * The layers a staged scene shows: not retired, not superseded, not the raw tiles, not empty, not kept from another run; the
 * trees only with `trees` (their GLB holds every level of detail, so a caller drawing it must pick one level per tree per view).
 */
export function visibleStagedLayers(state: Pick<StagedBuildState, 'layers'>, options: { trees?: boolean } = {}): StagedLayer[] {
    const live = state.layers.filter(l => !l.retired);
    const superseded = new Set(live.flatMap(l => l.supersedes ?? []));
    return live.filter(l => !superseded.has(l.objectId) && l.stage !== 'tiles' && (options.trees || l.stage !== 'trees') && (l.counts?.triangles ?? 0) > 0 && !l.keptFrom);
}

class BuildResolver {
    readonly cache: StageCache;
    readonly used = new Set<string>();
    readonly usedSources: string[] = [];

    constructor(readonly root: string, readonly workspaceRoot: string, readonly active: StagedBuildState | undefined) {
        this.cache = new StageCache({ workspaceRoot: root });
    }

    /** A GLB argument as a file: a /models URL, a path under the staged root or the workspace, or an absolute path inside either. */
    file(p: string, what: string): string {
        const s = p.trim();
        const tries: string[] = [];
        if (/^\/models\//.test(s)) tries.push(path.join(this.cache.modelsDir, s.slice('/models/'.length)));
        for (const root of [this.root, this.workspaceRoot]) {
            try { tries.push(resolveWithinRoot(root, s)); } catch { /* outside this root */ }
        }
        const hit = tries.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
        if (!hit) throw new PhotoMatchError('missing_glb', `${what} ${s} does not exist under ${this.root}${this.workspaceRoot !== this.root ? ` or ${this.workspaceRoot}` : ''}.`);
        return hit;
    }

    record(runId: string): RunRecordLike {
        if (!RUN_ID.test(runId)) throw new PhotoMatchError('bad_arguments', `runId "${runId}" is not a staged run id (8 hex digits).`);
        const rec = this.cache.readRunRecord<RunRecordLike>(runId);
        if (!rec) throw new PhotoMatchError('run_not_found', `There is no staged run ${runId} (no record in ${path.join(this.cache.dir, 'runs')}).`);
        return rec;
    }

    stageValue<T>(stage: string, key: string | undefined): { dir: string; value: T } | undefined {
        if (!key) return undefined;
        const hit = this.cache.get<T>(stage, key);
        return hit ? { dir: hit.dir, value: hit.value } : undefined;
    }

    /** The reference of a run: its tile, origin, isolate and place. */
    runReference(rec: RunRecordLike): Reference {
        const tiles = this.stageValue<{ texturedGlb: string; geometryGlb: string; originEllipsoidalHeightM: number; geoAnchor?: { lat: number; lng: number } }>('tiles', rec.keys?.tiles);
        if (!tiles) throw new PhotoMatchError('missing_reference_tile', `Staged run ${rec.runId} has no cached tile extraction (stage "tiles"), so its frame and street are unknown.`);
        const textured = path.join(tiles.dir, tiles.value.texturedGlb), geometry = path.join(tiles.dir, tiles.value.geometryGlb);
        if (!fs.existsSync(textured) || !fs.existsSync(geometry)) throw new PhotoMatchError('missing_reference_tile', `Staged run ${rec.runId}: the cached tile files are missing (${tiles.dir}).`);
        const place = rec.place ?? tiles.value.geoAnchor;
        if (!place) throw new PhotoMatchError('missing_reference_tile', `Staged run ${rec.runId} records no place coordinates.`);
        const remesh = this.stageValue<{ clay?: string }>('remesh', rec.keys?.remesh);
        const iso = remesh?.value.clay ? path.join(path.dirname(remesh.value.clay), 'raw_clay.glb') : undefined;
        // the strip's cache entry (tile-vegetation-service.ts): its removed_trees.glb is what the regrown trees replace
        const stripKey = rec.keys?.['trees-measure'];
        const removed = stripKey && /^[0-9a-f]{16,}$/.test(stripKey) ? path.join(this.root, '.scratchbox', 'cache', 'tile_vegetation', stripKey, 'removed_trees.glb') : undefined;
        return {
            origin: { lat: place.lat, lng: place.lng, heightMeters: tiles.value.originEllipsoidalHeightM },
            place: rec.place?.formattedAddress ?? rec.request?.query ?? `${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}`,
            tileTextured: textured, tileGeometry: geometry,
            ...(iso && fs.existsSync(iso) ? { isolate: iso } : {}),
            ...(removed && fs.existsSync(removed) ? { removedTrees: removed } : {}),
            source: `staged run ${rec.runId}`
        };
    }

    /** Every pano a run used: its notes (registration, ownership, fit), its stage entries and, when open, its scene. */
    noteRunPanos(rec: RunRecordLike): void {
        const before = this.used.size;
        const dir = path.dirname(this.cache.runRecordPath(rec.runId));
        for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            if (!f.endsWith('.json')) continue;
            try { collectPanoIds(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), this.used); } catch { /* a note that does not parse names nothing */ }
        }
        for (const [stage, key] of Object.entries(rec.keys ?? {})) {
            try {
                const hit = this.cache.get<unknown>(stage, key);
                if (hit) collectPanoIds({ value: hit.value }, this.used);
            } catch { /* not a stage entry this cache can read */ }
        }
        if (this.active?.runId === rec.runId) collectPanoIds(this.active, this.used);
        this.usedSources.push(`run ${rec.runId}: ${this.used.size - before} panos from its notes, stage entries${this.active?.runId === rec.runId ? ' and scene' : ''}`);
    }

    noteGlbPanos(files: string[]): void {
        const before = this.used.size;
        for (const f of files) {
            try { collectPanoIds(glbJson(f), this.used); } catch { /* not readable as GLB JSON: readTileTriangles reports it later */ }
        }
        this.usedSources.push(`${files.length} GLBs: ${this.used.size - before} more panos named in their extras`);
    }

    /** The layers of a run: from the open scene when it is that run's (textured twins where they exist), else unknown. */
    runLayers(rec: RunRecordLike, trees = false): { glbs: string[]; layers: Array<{ layer: string; textured: boolean }> } {
        if (this.active?.runId !== rec.runId) {
            throw new PhotoMatchError('run_layers_unknown', `Staged run ${rec.runId} is not the open scene, so which of its layers are shown is not known here. Open that scene, or pass its GLBs (arms[].glbs with runId).`);
        }
        const vis = visibleStagedLayers(this.active, { trees });
        if (!vis.length) throw new PhotoMatchError('no_build', `The open staged scene (run ${rec.runId}) shows no layer with triangles yet.`);
        return {
            glbs: vis.map(l => this.file(l.textured?.url ?? l.url, `layer ${l.layer}`)),
            layers: vis.map(l => ({ layer: l.layer, textured: !!l.textured }))
        };
    }

    /** The cached extraction whose origin is the anchor (within 1e-6 degrees). */
    tileAtAnchor(lat: number, lng: number): { textured: string; geometry: string; heightM: number } | undefined {
        const dir = path.join(this.cache.dir, 'tiles');
        if (!fs.existsSync(dir)) return undefined;
        let best: { textured: string; geometry: string; heightM: number; at: number } | undefined;
        for (const key of fs.readdirSync(dir)) {
            try {
                const d = JSON.parse(fs.readFileSync(path.join(dir, key, 'done.json'), 'utf8'));
                const a = d.value?.geoAnchor;
                if (!a || Math.abs(a.lat - lat) > 1e-6 || Math.abs(a.lng - lng) > 1e-6) continue;
                const t = path.join(dir, key, d.value.texturedGlb), g = path.join(dir, key, d.value.geometryGlb);
                if (fs.existsSync(t) && fs.existsSync(g) && (!best || d.builtAtMs > best.at)) best = { textured: t, geometry: g, heightM: d.value.originEllipsoidalHeightM, at: d.builtAtMs };
            } catch { /* not an entry */ }
        }
        return best;
    }
}

function armId(raw: unknown, k: number): string {
    const s = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9+_-]/g, '').slice(0, 12) : '';
    return s || `B${k + 1}`;
}

function parseArms(args: Record<string, unknown>, active: StagedBuildState | undefined): ArmSpec[] {
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
    if (Array.isArray(args.arms) && args.arms.length) {
        const arms = (args.arms as Array<Record<string, unknown>>).map((a, k) => {
            const id = armId(a?.id, k);
            const runId = typeof a?.runId === 'string' && a.runId.trim() ? a.runId.trim() : undefined;
            const glbs = strs(a?.glbs);
            if (!runId && !glbs.length) throw new PhotoMatchError('bad_arguments', `arm ${id}: give a runId or glbs.`);
            return { id, label: typeof a?.label === 'string' && a.label.trim() ? a.label.trim() : (runId ? `RUN ${runId}` : `BUILD ${id}`), ...(runId ? { runId } : {}), ...(glbs.length ? { glbs } : {}) };
        });
        if (new Set(arms.map(a => a.id)).size !== arms.length) throw new PhotoMatchError('bad_arguments', 'arm ids must differ.');
        return arms;
    }
    const glbs = strs(args.glbs);
    const runId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : (glbs.length ? undefined : active?.runId);
    if (!runId && !glbs.length) throw new PhotoMatchError('no_build', 'Nothing to evaluate: no staged scene is open and no runId, glbs or arms were given.');
    return [{ id: 'build', label: runId ? `BUILD RUN ${runId}` : 'BUILD', ...(runId ? { runId } : {}), ...(glbs.length ? { glbs } : {}) }];
}

// =============================================================================
// geometry helpers (the dev drivers' selection and cut, in the tile frame)
// =============================================================================

function centroids(t: TileTriangles): Float32Array {
    const n = t.texture.length, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = (t.positions[i * 9 + k] + t.positions[i * 9 + 3 + k] + t.positions[i * 9 + 6 + k]) / 3;
    return c;
}

/** Triangles of `t` whose centroid lies within `tol` of one of `ref`'s centroids (a hash grid); `drop` keeps the others instead. */
export function keepNearTriangles(t: TileTriangles, ref: TileTriangles, tol = 0.01, drop = false): TileTriangles {
    const grid = new Map<string, number[]>();
    const rc = centroids(ref), cell = (v: number) => Math.floor(v / tol);
    for (let i = 0; i < rc.length; i += 3) {
        const k = `${cell(rc[i])},${cell(rc[i + 1])},${cell(rc[i + 2])}`;
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
    }
    const tc = centroids(t), keep: number[] = [];
    for (let i = 0; i < t.texture.length; i++) {
        const x = tc[i * 3], y = tc[i * 3 + 1], z = tc[i * 3 + 2];
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) {
            const g = grid.get(`${cell(x) + dx},${cell(y) + dy},${cell(z) + dz}`);
            if (g?.some(j => Math.hypot(rc[j] - x, rc[j + 1] - y, rc[j + 2] - z) <= tol)) hit = true;
        }
        if (hit !== drop) keep.push(i);
    }
    const pickF = (a: Float32Array, w: number) => { const o = new Float32Array(keep.length * w); keep.forEach((s, d) => o.set(a.subarray(s * w, s * w + w), d * w)); return o; };
    const pickI = (a: Int32Array, w: number) => { const o = new Int32Array(keep.length * w); keep.forEach((s, d) => o.set(a.subarray(s * w, s * w + w), d * w)); return o; };
    return { ...t, positions: pickF(t.positions, 9), uvs: pickF(t.uvs, 6), normals: pickF(t.normals, 3), texture: pickI(t.texture, 1), flatLinear: pickF(t.flatLinear, 3) };
}

/** Lowest surface of the mesh under (x, z) within 1.5 m (the street), else NaN. */
function groundAt(V: ArrayLike<number>, I: ArrayLike<number>, x: number, z: number): number {
    let best = Infinity;
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        if (x < Math.min(V[a], V[b], V[c]) - 1.5 || x > Math.max(V[a], V[b], V[c]) + 1.5 || z < Math.min(V[a + 2], V[b + 2], V[c + 2]) - 1.5 || z > Math.max(V[a + 2], V[b + 2], V[c + 2]) + 1.5) continue;
        const x1 = V[a], z1 = V[a + 2], x2 = V[b], z2 = V[b + 2], x3 = V[c], z3 = V[c + 2];
        const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d, l3 = 1 - l1 - l2;
        if (l1 < -0.3 || l2 < -0.3 || l3 < -0.3) continue;
        best = Math.min(best, l1 * V[a + 1] + l2 * V[b + 1] + l3 * V[c + 1]);
    }
    return Number.isFinite(best) ? best : NaN;
}

interface Structure { cx: number; cz: number; radiusM: number; ymin: number; ymax: number; mesh: RenderMesh3D }

function structureOf(mesh: RenderMesh3D): Structure {
    const V = mesh.vertices;
    let cx = 0, cz = 0, ymin = Infinity, ymax = -Infinity, n = 0;
    for (let i = 0; i < V.length; i += 3) { cx += V[i]; cz += V[i + 2]; ymin = Math.min(ymin, V[i + 1]); ymax = Math.max(ymax, V[i + 1]); n++; }
    if (!n) throw new PhotoMatchError('no_build', 'the target mesh has no vertices.');
    cx /= n; cz /= n;
    let R = 0;
    for (let i = 0; i < V.length; i += 3) R = Math.max(R, Math.hypot(V[i] - cx, V[i + 2] - cz));
    return { cx, cz, radiusM: R, ymin, ymax, mesh };
}

export interface HeldOutCandidateView extends SelectedView { close: boolean; visibleShare: number; screenShare: number }

/**
 * Candidate views from the unused panos: one per pano, aimed at the structure (its nearest wall with a wide view when the pano
 * stands close, else its centre), kept when the structure fills enough of the frame and the tile mesh does not hide most of it.
 */
export function heldOutViews(panos: PanoCandidate[], structure: Structure, context: RenderMesh3D, exclude: Set<string>): { views: HeldOutCandidateView[]; rejected: string[] } {
    const { cx, cz, radiusM: R, ymin, ymax } = structure;
    const V = context.vertices, I = context.indices, IV = structure.mesh.vertices;
    const near = panos.filter(p => !exclude.has(p.panoId)).map(p => ({ ...p, d: Math.hypot(p.x - cx, p.z - cz) })).filter(p => p.d > R * 0.5 + 3 && p.d < R + 110);
    near.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.panoId.localeCompare(b.panoId));
    const cands: typeof near = [];
    for (const p of near) if (!cands.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 10)) cands.push(p);
    const views: HeldOutCandidateView[] = [], rejected: string[] = [];
    for (const p of cands) {
        let gy = groundAt(V, I, p.x, p.z);
        if (!Number.isFinite(gy)) { if (p.d > R + 60) { rejected.push(`${p.panoId}: no ground under it`); continue; } gy = ymin; }
        const eye: Vec3 = [p.x, gy + 2.5, p.z];
        let nx = cx, nz = cz, dn = Infinity;
        for (let i = 0; i < IV.length; i += 30) { const dd = Math.hypot(IV[i] - p.x, IV[i + 2] - p.z); if (dd < dn) { dn = dd; nx = IV[i]; nz = IV[i + 2]; } }
        const close = dn < 22;
        const headingDeg = Math.round(bearingDeg(p.x, p.z, close ? nx : cx, close ? nz : cz) * 10) / 10;
        const fovDeg = Math.round(close ? 80 : Math.max(50, Math.min(90, 2 * Math.atan((R * 0.9) / Math.max(1, p.d)) * 180 / Math.PI)));
        const mid = ymin + 0.4 * (ymax - ymin);
        const pitchDeg = Math.round((close ? 12 : Math.max(-5, Math.min(30, Math.atan((mid - eye[1]) / p.d) * 180 / Math.PI))) * 10) / 10;
        const cam = castCamera({ eye, headingDeg, pitchDeg, fovDeg, widthPx: 160, heightPx: 120 });
        const isoD = renderFrameDepth(structure.mesh, cam), ctxD = renderFrameDepth(context, cam);
        let seen = 0, isoPx = 0;
        for (let i = 0; i < isoD.length; i++) if (isoD[i] < 1e8) { isoPx++; if (ctxD[i] >= isoD[i] - 0.6) seen++; }
        const share = isoPx ? seen / isoPx : 0, screen = isoPx / isoD.length;
        if (screen < HELD_OUT_MIN_SCREEN || share < HELD_OUT_MIN_VISIBLE) { rejected.push(`${p.panoId}: ${p.d.toFixed(0)} m, fills ${(screen * 100).toFixed(0)}% of the frame, ${(share * 100).toFixed(0)}% of it unhidden`); continue; }
        views.push({
            panoId: p.panoId, ...(p.date ? { date: p.date } : {}), ...(p.copyright ? { copyright: p.copyright } : {}), eye, headingDeg, pitchDeg, fovDeg, aspectRatio: 'RATIO_4X3',
            distanceM: Math.round(p.d * 10) / 10, facadeHeadingDeg: (headingDeg + 180) % 360, score: share, close,
            visibleShare: Math.round(share * 100) / 100, screenShare: Math.round(screen * 100) / 100
        });
    }
    return { views, rejected };
}

/** Spread: the nearest and the farthest, then the most different by bearing and distance. */
export function spreadViews<T extends { headingDeg: number; distanceM: number }>(views: T[], n: number): T[] {
    const sorted = [...views].sort((a, b) => a.distanceM - b.distanceM);
    const pick: T[] = [];
    const take = (v: T | undefined) => { if (v && !pick.includes(v)) pick.push(v); };
    take(sorted[0]); take(sorted[sorted.length - 1]);
    while (pick.length < Math.min(n, sorted.length)) {
        let best: T | undefined, bs = -1;
        for (const v of sorted) {
            if (pick.includes(v)) continue;
            const s = Math.min(...pick.map(q => Math.min(Math.abs(q.headingDeg - v.headingDeg), 360 - Math.abs(q.headingDeg - v.headingDeg)) + Math.abs(q.distanceM - v.distanceM)));
            if (s > bs) { bs = s; best = v; }
        }
        take(best);
    }
    return pick.slice(0, n);
}

// =============================================================================
// the evaluation
// =============================================================================

export interface ArmScore extends Record<JudgeCriterion, { mean: number; runSd: number; viewSd: number; min: number; max: number }> {}

export interface PhotoMatchViewResult {
    id: string;
    panoId: string;
    date?: string;
    distanceM: number;
    headingDeg: number;
    pitchDeg: number;
    fovDeg: number;
    size: [number, number];
    edgeResidualPx: { prior: number | null; edge: number | null };
    maskPixels: number;
    grid: string;
    renders: Record<string, string>;
    judge?: { stats: Record<string, Record<JudgeCriterion, CriterionStat>>; notes: Record<string, string[]>; model: string };
    judgeError?: string;
    /** The clay arm: each arm's untextured render from this pose, its grid, and the shape-only judgement. */
    clayRenders?: Record<string, string>;
    clayGrid?: string;
    clayJudge?: { stats: Record<string, { shape: CriterionStat }>; notes: Record<string, string[]>; model: string };
    clayJudgeError?: string;
    pixel: Record<string, PerceptualScores>;
    /** Per arm with a trees layer: trees drawn at each level from this pose, and triangles drawn against every level's. */
    trees?: Record<string, { atLevel: number[]; drawnTriangles: number; allLevelTriangles: number }>;
}

const DEFAULT_RUN_CONCURRENCY = 2;
const yieldLoop = () => new Promise<void>(r => setImmediate(r));
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function intArg(v: unknown, def: number, min: number, max: number): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
    return Math.max(min, Math.min(max, n));
}

function stopIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new PhotoMatchError('stopped', 'The evaluation was stopped.');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, k: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

/** Runs the evaluation; returns the payload the model reads. Throws PhotoMatchError for every typed failure. */
export async function evaluatePhotoMatch(args: Record<string, unknown>, ctx: Pick<ToolContext, 'workspaceRoot' | 'request' | 'signal' | 'reportProgress'>, deps: PhotoMatchDeps = defaultPhotoMatchDeps()): Promise<Record<string, unknown>> {
    const now = deps.now ?? Date.now;
    const t0 = now();
    const signal = ctx.signal;
    const progress = (m: string, f?: number) => ctx.reportProgress?.(m, f);
    const activeData = ctx.request?.activeArtifact?.type === '3d-scene' ? (ctx.request.activeArtifact.data as { stagedBuild?: StagedBuildState } | undefined) : undefined;
    const active = activeData?.stagedBuild && Array.isArray(activeData.stagedBuild.layers) ? activeData.stagedBuild : undefined;
    const nViews = intArg(args.views, PHOTO_MATCH_DEFAULT_VIEWS, 1, PHOTO_MATCH_MAX_VIEWS);
    const nRuns = intArg(args.runs, PHOTO_MATCH_DEFAULT_RUNS, 1, PHOTO_MATCH_MAX_RUNS);
    const wantContext = args.inContext !== false;
    const wantClay = args.clay !== false;
    const wantTrees = args.trees !== false;
    const judgeModel = typeof args.judgeModel === 'string' && args.judgeModel.trim() ? args.judgeModel.trim() : PHOTO_MATCH_DEFAULT_JUDGE;
    const root = deps.stagedRoot();
    const builds = new BuildResolver(root, ctx.workspaceRoot || root, active);

    // ---------------- the arms and the reference frame ----------------
    const specs = parseArms(args, active);
    let ref: Reference | undefined;
    const arms: ResolvedArm[] = [];
    for (const spec of specs) {
        if (spec.runId) {
            const rec = builds.record(spec.runId);
            const r = builds.runReference(rec);
            if (!ref) ref = r;
            else if (Math.abs(r.origin.lat - ref.origin.lat) > 1e-6 || Math.abs(r.origin.lng - ref.origin.lng) > 1e-6) {
                throw new PhotoMatchError('frame_mismatch', `arm ${spec.id} (run ${spec.runId}) is in the frame of ${r.origin.lat}, ${r.origin.lng}, not ${ref.origin.lat}, ${ref.origin.lng}: arms must share one tile frame.`);
            }
            builds.noteRunPanos(rec);
            const layers = spec.glbs ? { glbs: spec.glbs.map(g => builds.file(g, `arm ${spec.id} GLB`)), layers: undefined } : builds.runLayers(rec, wantTrees);
            arms.push({ id: spec.id, label: spec.label, glbs: layers.glbs, runId: spec.runId, ...(layers.layers ? { layers: layers.layers } : {}) });
        } else {
            arms.push({ id: spec.id, label: spec.label, glbs: spec.glbs!.map(g => builds.file(g, `arm ${spec.id} GLB`)) });
        }
    }
    if (!ref) {
        const a = args.anchor as { lat?: unknown; lng?: unknown; heightMeters?: unknown } | undefined;
        if (!a || typeof a.lat !== 'number' || typeof a.lng !== 'number') throw new PhotoMatchError('bad_arguments', 'GLBs without a staged run need anchor {lat, lng} (the geodetic origin of their frame).');
        const cached = builds.tileAtAnchor(a.lat, a.lng);
        const tileTextured = typeof args.tileGlb === 'string' && args.tileGlb.trim() ? builds.file(args.tileGlb, 'tileGlb') : cached?.textured;
        if (!tileTextured) throw new PhotoMatchError('missing_reference_tile', `No Google 3D Tiles extraction is known at ${a.lat}, ${a.lng}: pass tileGlb (the photo-textured tile in the GLBs' frame). The held-out photos are registered against it, never against the build.`);
        const height = typeof a.heightMeters === 'number' ? a.heightMeters : cached?.heightM;
        if (height === undefined) throw new PhotoMatchError('bad_arguments', 'anchor.heightMeters (the ellipsoidal height of the frame origin) is needed when the tile is not from the cache.');
        ref = {
            origin: { lat: a.lat, lng: a.lng, heightMeters: height },
            place: typeof args.place === 'string' && args.place.trim() ? args.place.trim() : `the place at ${a.lat.toFixed(6)}, ${a.lng.toFixed(6)}`,
            tileTextured, tileGeometry: cached && cached.textured === tileTextured ? cached.geometry : tileTextured,
            ...(typeof args.isolateGlb === 'string' && args.isolateGlb.trim() ? { isolate: builds.file(args.isolateGlb, 'isolateGlb') } : {}),
            source: cached && cached.textured === tileTextured ? 'the cached extraction at the anchor' : 'tileGlb'
        };
    } else if (typeof args.isolateGlb === 'string' && args.isolateGlb.trim()) {
        ref.isolate = builds.file(args.isolateGlb, 'isolateGlb');
    }
    if (typeof args.place === 'string' && args.place.trim()) ref.place = args.place.trim();
    builds.noteGlbPanos(arms.flatMap(a => a.glbs));
    for (const p of Array.isArray(args.excludePanoIds) ? args.excludePanoIds : []) if (typeof p === 'string' && p) builds.used.add(p);
    const withBaseline = args.baseline !== false;
    if (withBaseline) arms.unshift({ id: 'raw', label: ref.isolate ? 'RAW SCAN (CUT TO TARGET)' : 'RAW SCAN', glbs: [ref.tileTextured], baseline: true, ...(ref.isolate ? { keepNear: ref.isolate } : {}) });
    stopIfAborted(signal);

    // ---------------- held-out views ----------------
    progress('finding Street View panos near the structure that the build never used', 0.02);
    const contextMesh = sceneToRenderMesh(readGlbScene(ref.tileGeometry));
    // the structure: the isolate, else the first build's layers without its trees (a trees GLB holds every level)
    const targetMesh = sceneToRenderMesh((ref.isolate ? [ref.isolate] : arms.find(a => !a.baseline)!.glbs.filter(f => !isTreesLodJson(glbJson(f)))).flatMap(f => readGlbScene(f)));
    const structure = structureOf(targetMesh);
    const panos = await deps.discover(ref.origin, { x: structure.cx, z: structure.cz }, builds.cache.dir, signal);
    stopIfAborted(signal);
    const { views: candidates, rejected } = heldOutViews(panos, structure, contextMesh, builds.used);
    const unusedNear = panos.filter(p => !builds.used.has(p.panoId)).length;
    if (!candidates.length) {
        throw new PhotoMatchError('no_heldout_candidates', `No held-out view: of ${panos.length} Google panos near the structure, ${panos.length - unusedNear} were used by the build and none of the other ${unusedNear} sees enough of it unhidden.`, { panosNear: panos.length, usedByBuild: builds.used.size, rejected: rejected.slice(0, 20) });
    }
    const toFetch = spreadViews(candidates, Math.min(12, Math.max(4, nViews * 2)));
    progress(`fetching ${toFetch.length} held-out Street View images through the grounding API`, 0.08);
    const got = await fetchViews(toFetch, { grounding: deps.grounding() }, signal);
    stopIfAborted(signal);
    if (!got.images.length) {
        throw new PhotoMatchError('no_heldout_fetched', `None of the ${toFetch.length} held-out Street View images could be fetched: ${got.failures.slice(0, 4).map(f => `${f.view.panoId}: ${f.error}`).join('; ')}`, { failures: got.failures.map(f => ({ panoId: f.view.panoId, error: f.error })) });
    }
    progress(`registering ${got.images.length} held-out images against the tile mesh by silhouette and edges`, 0.15);
    const regs = await deps.register(got.images.map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view })), [ref.tileGeometry], signal, m => progress(m));
    stopIfAborted(signal);
    const locked = got.images.flatMap(im => {
        const o = regs.find(q => q.panoId === im.view.panoId);
        const before = o?.edgeResidualPx.prior ?? null, after = o?.edgeResidualPx.edge ?? null;
        const ok = !!o && !!o.correction && after !== null && after <= EDGE_MAX_RESIDUAL_PX && !(before !== null && after >= before);
        return ok ? [{ im, reg: o! }] : [];
    });
    const unregistered = got.images.filter(im => !locked.some(l => l.im === im)).map(im => {
        const o = regs.find(q => q.panoId === im.view.panoId);
        return { panoId: im.view.panoId, edgeResidualPx: o?.edgeResidualPx ?? null, reason: o ? o.reason : 'not registered' };
    });
    if (!locked.length) {
        const few = got.images.length < 2 ? ' Only one image came back, and the edge registration needs at least two.' : '';
        throw new PhotoMatchError('no_heldout_registered', `None of the ${got.images.length} held-out images registered against the tile mesh (an edge residual of at most ${EDGE_MAX_RESIDUAL_PX} px, lower than at the start), so no pose is trusted enough to judge from.${few}`, { unregistered });
    }
    const chosen = locked.sort((a, b) => a.im.view.distanceM - b.im.view.distanceM).slice(0, nViews);
    for (const c of chosen) {
        if (builds.used.has(c.im.view.panoId)) throw new PhotoMatchError('heldout_used_by_build', `pano ${c.im.view.panoId} was used by the build; it cannot be held out.`);
    }

    // ---------------- arms, context ----------------
    progress(`loading ${arms.length} arms`, 0.22);
    const loaded = arms.map(a => {
        // a trees GLB (tree LOD contract) is kept for per-view level selection when trees are drawn; any other GLB is fixed
        let parts: ArmLayer[] = a.glbs.map(g => loadArmLayer(fs.readFileSync(g), { treeLod: wantTrees }));
        if (a.keepNear) { const cut = readTileTriangles(fs.readFileSync(a.keepNear)); parts = parts.map(l => (l.fixed ? { fixed: keepNearTriangles(l.fixed, cut) } : l)); }
        return { ...a, parts, treeLayers: parts.filter(l => l.trees).length, triangles: parts.reduce((s, l) => s + armLayerTriangles(l), 0) };
    });
    for (const a of loaded) if (!a.triangles) throw new PhotoMatchError('no_build', `arm ${a.id} has no triangles${a.keepNear ? ' near the isolated target' : ''}.`);
    const drawsTrees = loaded.some(a => a.treeLayers > 0);
    let context: TileTriangles[] | undefined;
    let contextNote: string;
    if (wantContext && ref.isolate) {
        const full = readTileTriangles(fs.readFileSync(ref.tileTextured));
        let cut = keepNearTriangles(full, readTileTriangles(fs.readFileSync(ref.isolate)), 0.01, true);
        const target = full.texture.length - cut.texture.length;
        // the regrown trees replace the scanned ones the strip measured: those leave the street too, or the photo's trees stand twice
        let treesCut = 0;
        if (drawsTrees && ref.removedTrees) {
            const before = cut.texture.length;
            cut = keepNearTriangles(cut, readTileTriangles(fs.readFileSync(ref.removedTrees)), 0.01, true);
            treesCut = before - cut.texture.length;
        }
        context = [cut];
        contextNote = `in context: every arm drawn in the photo-textured tile with the target's own ${target} triangles cut out${treesCut ? ` and the ${treesCut} triangles of the scanned trees the regrown trees replace` : ''} (${cut.texture.length} kept), the same street for every arm`
            + (drawsTrees && !ref.removedTrees ? '; the scanned trees stay in the street (the run records no strip to cut them by)' : '');
    } else {
        contextNote = wantContext
            ? 'not in context: the build isolated no single structure, so there is no target to cut out of the tile; each arm is drawn alone with the tile mesh hiding what stands in front'
            : 'not in context (inContext false): each arm drawn alone on grey, the tile mesh hiding what stands in front';
    }
    const occluder = context ? undefined : contextMesh;

    const evalId = `${(ref.place.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'place')}_${new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}_${crypto.randomBytes(2).toString('hex')}`;
    const outDir = path.join(root, '.scratchbox', 'cache', 'photo_match', evalId);
    fs.mkdirSync(outDir, { recursive: true });
    const maskArm = loaded.find(a => a.baseline)?.id ?? loaded[0].id;

    // ---------------- renders and pixel metrics ----------------
    interface Prepared {
        view: PhotoMatchViewResult; photoBytes: Buffer; mime: string; photo: { width: number; height: number; rgba: Uint8Array };
        renders: Array<{ id: string; label: string; r: ArmRender }>; clayRenders: Array<{ id: string; label: string; r: ArmRender }>;
        /** The grid's label of the reference image (default: the real photo and its distance). */
        photoLabel?: string;
        /** The satellite second opinion: judged and gridded like a view, kept out of the scores. */
        satellite?: boolean;
    }
    const prepared: Prepared[] = [];
    for (let k = 0; k < chosen.length; k++) {
        stopIfAborted(signal);
        const { im, reg } = chosen[k];
        const v = im.view;
        progress(`rendering ${loaded.length} arms from held-out view ${k + 1} of ${chosen.length} (pano ${v.panoId.slice(0, 8)}, ${v.distanceM} m)`, 0.25 + 0.25 * (k / chosen.length));
        const img = decodeImageInMemory(im.bytes);
        const photo = { width: img.width, height: img.height, rgba: img.rgba };
        const camera = castCamera({ eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, widthPx: img.width, heightPx: img.height, ...(reg.correction ? { correction: reg.correction } : {}) });
        const occluderDepth = occluder ? renderFrameDepth(occluder, camera) : undefined;
        const renders: Array<{ id: string; label: string; r: ArmRender }> = [];
        // each arm as the viewport would draw it from this pose (one level per tree)
        const forView = loaded.map(a => armMeshesForView(a.parts, camera));
        const treeLevels: Record<string, { atLevel: number[]; drawnTriangles: number; allLevelTriangles: number }> = {};
        loaded.forEach((a, i) => {
            const t = forView[i].trees;
            if (t.length) treeLevels[a.id] = { atLevel: t.reduce((acc, x) => acc.map((n, k) => n + (x.atLevel[k] ?? 0)), new Array(Math.max(...t.map(x => x.atLevel.length))).fill(0)), drawnTriangles: t.reduce((n, x) => n + x.drawnTriangles, 0), allLevelTriangles: t.reduce((n, x) => n + x.allLevelTriangles, 0) };
        });
        for (let i = 0; i < loaded.length; i++) {
            const a = loaded[i];
            renders.push({ id: a.id, label: a.label, r: renderTriangles(forView[i].meshes, camera, { ...(occluderDepth ? { occluderDepth } : {}), ...(context ? { context } : {}) }) });
            await yieldLoop();
        }
        // the clay arm: the same pose, occluders and street, every arm (and its street) untextured
        const clayRenders: Array<{ id: string; label: string; r: ArmRender }> = [];
        if (wantClay) {
            for (let i = 0; i < loaded.length; i++) {
                const a = loaded[i];
                clayRenders.push({ id: a.id, label: a.label, r: renderTriangles(forView[i].meshes, camera, { clay: true, ...(occluderDepth ? { occluderDepth } : {}), ...(context ? { context } : {}) }) });
                await yieldLoop();
            }
        }
        const mask = coverageMask(renders.find(x => x.id === maskArm)!.r);
        const pixel: Record<string, PerceptualScores> = {};
        const files: Record<string, string> = {};
        const viewId = `v${k}_${v.panoId.slice(0, 6).replace(/[^A-Za-z0-9_-]/g, '_')}`;
        for (const x of renders) {
            pixel[x.id] = perceptualScores(photo, x.r, mask);
            files[x.id] = path.join(outDir, `${viewId}_${x.id}.png`);
            fs.writeFileSync(files[x.id], renderPng(x.r));
            await yieldLoop();
        }
        const clayFiles: Record<string, string> = {};
        for (const x of clayRenders) {
            clayFiles[x.id] = path.join(outDir, `${viewId}_${x.id}_clay.png`);
            fs.writeFileSync(clayFiles[x.id], renderPng(x.r));
        }
        prepared.push({
            view: {
                id: viewId, panoId: v.panoId, ...(v.date ? { date: v.date } : {}), distanceM: v.distanceM, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg,
                size: [img.width, img.height], edgeResidualPx: reg.edgeResidualPx, maskPixels: mask.reduce((s, m) => s + m, 0), grid: path.join(outDir, `grid_${viewId}.png`), renders: files, pixel,
                ...(wantClay ? { clayRenders: clayFiles, clayGrid: path.join(outDir, `grid_${viewId}_clay.png`) } : {}),
                ...(Object.keys(treeLevels).length ? { trees: treeLevels } : {})
            },
            photoBytes: im.bytes, mime: im.mimeType || 'image/jpeg', photo, renders, clayRenders
        });
    }

    // ---------------- the satellite second opinion (opt-in) ----------------
    // A Google Static Maps satellite crop centred on the frame origin, and every arm rendered top-down at its ground sample
    // distance (an orthographic camera, the same neutral light, the same street as context). Judged and gridded like a view,
    // reported apart from the scores: Static Maps carries no capture date, and a roof seen from above is not a facade.
    const wantSatellite = args.includeSatelliteOrtho === true;
    let satellite: Record<string, unknown> = wantSatellite ? { used: false, requested: true } : { used: false, requested: false, note: 'not requested (includeSatelliteOrtho)' };
    let satPrepared: Prepared | undefined;
    if (wantSatellite) {
        progress('fetching the Static Maps satellite crop of the place and rendering every arm top-down at its scale (second opinion, date unknown)', 0.47);
        try {
            if (!deps.satelliteOrtho) throw new PhotoMatchError('satellite_unavailable', 'no satellite source is configured for this evaluation.');
            const sat = await deps.satelliteOrtho(ref.origin, signal);
            stopIfAborted(signal);
            const cam = orthoReferenceCamera(sat);
            const forView = loaded.map(a => armMeshesForView(a.parts, cam));
            const renders: Array<{ id: string; label: string; r: ArmRender }> = [];
            for (let i = 0; i < loaded.length; i++) {
                renders.push({ id: loaded[i].id, label: loaded[i].label, r: renderTriangles(forView[i].meshes, cam, context ? { context } : {}) });
                await yieldLoop();
            }
            const clayRenders: Array<{ id: string; label: string; r: ArmRender }> = [];
            if (wantClay) for (let i = 0; i < loaded.length; i++) {
                clayRenders.push({ id: loaded[i].id, label: loaded[i].label, r: renderTriangles(forView[i].meshes, cam, { clay: true, ...(context ? { context } : {}) }) });
                await yieldLoop();
            }
            const mask = coverageMask(renders.find(x => x.id === maskArm)!.r);
            const viewId = 'sat_ortho';
            const pixel: Record<string, PerceptualScores> = {};
            const files: Record<string, string> = {}, clayFiles: Record<string, string> = {};
            for (const x of renders) {
                pixel[x.id] = perceptualScores(sat.image, x.r, mask);
                files[x.id] = path.join(outDir, `${viewId}_${x.id}.png`);
                fs.writeFileSync(files[x.id], renderPng(x.r));
                await yieldLoop();
            }
            for (const x of clayRenders) {
                clayFiles[x.id] = path.join(outDir, `${viewId}_${x.id}_clay.png`);
                fs.writeFileSync(clayFiles[x.id], renderPng(x.r));
            }
            const imagePath = path.join(outDir, 'satellite_static_maps.png');
            fs.writeFileSync(imagePath, sat.bytes);
            satPrepared = {
                view: {
                    id: viewId, panoId: 'google-static-maps-satellite', distanceM: cam.eye[1], headingDeg: 0, pitchDeg: -90, fovDeg: 0,
                    size: [sat.widthPx, sat.heightPx], edgeResidualPx: { prior: null, edge: null }, maskPixels: mask.reduce((s, m) => s + m, 0),
                    grid: path.join(outDir, `grid_${viewId}.png`), renders: files, pixel,
                    ...(wantClay ? { clayRenders: clayFiles, clayGrid: path.join(outDir, `grid_${viewId}_clay.png`) } : {})
                },
                photoBytes: sat.bytes, mime: 'image/png', photo: sat.image, renders, clayRenders,
                photoLabel: 'SATELLITE (GOOGLE STATIC MAPS, DATE UNKNOWN)', satellite: true
            };
            satellite = {
                used: true, requested: true, source: sat.source, mapType: sat.mapType, zoom: sat.zoom, scale: sat.scale, size: [sat.widthPx, sat.heightPx],
                gsdMetresPerPixel: r3(sat.pixelM), widthM: r2(sat.widthM), heightM: r2(sat.heightM), centre: sat.centre,
                capturedAt: null, captureDateNote: sat.captureDateNote, attribution: sat.attribution, image: imagePath,
                camera: `orthographic, straight down from ${cam.eye[1]} m over the frame origin, image x east and y south, one pixel = ${sat.pixelM.toFixed(4)} m`,
                note: 'A second opinion beside the held-out street views, not counted in scores or clayScores. Rendered in the same street context, with no occluder depth (nothing but trees stands above a roof). The tile photo\'s own roof ortho remains the first opinion on roofs.'
            };
        } catch (err) {
            if (signal?.aborted) throw new PhotoMatchError('stopped', 'The evaluation was stopped.');
            satellite = { used: false, requested: true, code: err instanceof PhotoMatchError ? err.code : 'failed', error: (err as Error).message };
        }
    }
    const judgedList = satPrepared ? [...prepared, satPrepared] : prepared;

    // ---------------- blind judging ----------------
    progress(`judging ${prepared.length} views blind${satPrepared ? ' plus the satellite view' : ''}, ${nRuns} reshuffled runs each${wantClay ? ', textured and in clay (shape only)' : ''}`, 0.5);
    const judge = await deps.judge(judgeModel, signal);
    let judged = 0;
    await mapLimit(judgedList, DEFAULT_RUN_CONCURRENCY, async p => {
        stopIfAborted(signal);
        try {
            const runs: JudgeRun[] = await judgeView({
                client: judge, place: ref!.place, photo: { bytes: p.photoBytes, mimeType: p.mime },
                renders: p.renders.map(x => ({ armId: x.id, png: renderPng(x.r) })), repeats: nRuns, seed: `${evalId}:${p.view.id}`
            });
            const notes: Record<string, string[]> = {};
            for (const run of runs) for (const [id, n] of Object.entries(run.notes)) (notes[id] ??= []).push(n);
            p.view.judge = { stats: aggregateRuns(runs, loaded.map(a => a.id)), notes, model: runs[runs.length - 1]?.model ?? '' };
        } catch (err) {
            if (signal?.aborted) throw new PhotoMatchError('stopped', 'The evaluation was stopped.');
            p.view.judgeError = (err as Error).message;
        }
        if (p.clayRenders.length) {
            stopIfAborted(signal);
            try {
                const runs = await judgeViewClay({
                    client: judge, place: ref!.place, photo: { bytes: p.photoBytes, mimeType: p.mime },
                    renders: p.clayRenders.map(x => ({ armId: x.id, png: renderPng(x.r) })), repeats: nRuns, seed: `${evalId}:${p.view.id}:clay`
                });
                const notes: Record<string, string[]> = {};
                for (const run of runs) for (const [id, n] of Object.entries(run.notes)) (notes[id] ??= []).push(n);
                const agg = aggregateRuns(runs, loaded.map(a => a.id));
                p.view.clayJudge = { stats: Object.fromEntries(loaded.map(a => [a.id, { shape: agg[a.id].shape }])), notes, model: runs[runs.length - 1]?.model ?? '' };
            } catch (err) {
                if (signal?.aborted) throw new PhotoMatchError('stopped', 'The evaluation was stopped.');
                p.view.clayJudgeError = (err as Error).message;
            }
        }
        judged++;
        progress(`judged ${judged} of ${judgedList.length} views`, 0.5 + 0.45 * (judged / judgedList.length));
    });
    const scored = prepared.filter(p => p.view.judge);
    if (!scored.length) {
        throw new PhotoMatchError('judge_failed', `The judge returned no usable scores for any view: ${prepared.map(p => p.view.judgeError).filter(Boolean).slice(0, 3).join('; ')}`, { renders: prepared.map(p => p.view.renders) });
    }

    // ---------------- grids ----------------
    for (const p of judgedList) {
        const tiles = [{ image: p.photo, label: p.photoLabel ?? `REAL PHOTO ${Math.round(p.view.distanceM)} M`, sublabel: p.satellite ? `GSD ${(satellite.gsdMetresPerPixel as number).toFixed(3)} M/PX` : p.view.panoId.slice(0, 10) }, ...p.renders.map(x => {
            const s = p.view.judge?.stats[x.id]?.overall;
            const ssim = p.view.pixel[x.id].ssim;
            return { image: x.r, label: x.label, sublabel: s ? `JUDGE ${s.mean.toFixed(1)} +- ${s.sd.toFixed(1)}  SSIM ${ssim ?? '-'}` : `NOT JUDGED  SSIM ${ssim ?? '-'}` };
        })];
        fs.writeFileSync(p.view.grid, composeGrid(tiles, { tileWidth: 560, columns: Math.min(4, tiles.length), title: `${ref.place} - ${p.view.id}${context ? ' - IN CONTEXT' : ''}` }));
        if (p.view.clayGrid) {
            const clayTiles = [tiles[0], ...p.clayRenders.map(x => {
                const s = p.view.clayJudge?.stats[x.id]?.shape;
                return { image: x.r, label: `${x.label} CLAY`, sublabel: s ? `SHAPE ${s.mean.toFixed(1)} +- ${s.sd.toFixed(1)}` : 'NOT JUDGED' };
            })];
            fs.writeFileSync(p.view.clayGrid, composeGrid(clayTiles, { tileWidth: 560, columns: Math.min(4, clayTiles.length), title: `${ref.place} - ${p.view.id} - CLAY, SHAPE ONLY` }));
        }
    }

    // ---------------- aggregation ----------------
    const views = prepared.map(p => p.view);
    const scores: Record<string, ArmScore> = {};
    for (const a of loaded) {
        const s = {} as ArmScore;
        for (const c of JUDGE_CRITERIA) {
            const per = scored.map(p => p.view.judge!.stats[a.id]?.[c]).filter((x): x is CriterionStat => !!x && Number.isFinite(x.mean));
            const means = per.map(x => x.mean);
            const mean = means.length ? means.reduce((t, x) => t + x, 0) / means.length : NaN;
            s[c] = {
                mean: r2(mean),
                runSd: r2(per.reduce((t, x) => t + x.sd, 0) / Math.max(1, per.length)),
                viewSd: r2(Math.sqrt(means.reduce((t, x) => t + (x - mean) ** 2, 0) / Math.max(1, means.length))),
                min: means.length ? r2(Math.min(...means)) : NaN, max: means.length ? r2(Math.max(...means)) : NaN
            };
        }
        scores[a.id] = s;
    }
    // the clay arm: shape only, over the views the clay judge scored
    const clayScored = prepared.filter(p => p.view.clayJudge);
    const clayScores: Record<string, { shape: ArmScore['shape'] }> = {};
    if (clayScored.length) {
        for (const a of loaded) {
            const means = clayScored.map(p => p.view.clayJudge!.stats[a.id]?.shape).filter((x): x is CriterionStat => !!x && Number.isFinite(x.mean));
            const m = means.map(x => x.mean);
            const mean = m.length ? m.reduce((t, x) => t + x, 0) / m.length : NaN;
            clayScores[a.id] = {
                shape: {
                    mean: r2(mean), runSd: r2(means.reduce((t, x) => t + x.sd, 0) / Math.max(1, means.length)),
                    viewSd: r2(Math.sqrt(m.reduce((t, x) => t + (x - mean) ** 2, 0) / Math.max(1, m.length))), min: m.length ? r2(Math.min(...m)) : NaN, max: m.length ? r2(Math.max(...m)) : NaN
                }
            };
        }
    }
    const pixelMean: Record<string, { coverage: number | null; ssim: number | null; edgeChamferPx: number | null; colourDeltaE: number | null }> = {};
    for (const a of loaded) {
        const m = (k: 'coverage' | 'ssim' | 'edgeChamferPx' | 'colourDeltaE') => {
            const v = views.map(x => x.pixel[a.id]?.[k]).filter((x): x is number => typeof x === 'number');
            return v.length ? r3(v.reduce((t, x) => t + x, 0) / v.length) : null;
        };
        pixelMean[a.id] = { coverage: m('coverage'), ssim: m('ssim'), edgeChamferPx: m('edgeChamferPx'), colourDeltaE: m('colourDeltaE') };
    }

    const judgeModelUse = { requested: judge.requested ?? judgeModel, answered: judge.answeredModel ?? scored[0].view.judge!.model, skipped: judge.skipped ?? [] };
    // the satellite second opinion: its own judgement, apart from the scores
    if (satPrepared) {
        const v = satPrepared.view;
        satellite = {
            ...satellite,
            grid: v.grid, renders: v.renders, pixel: v.pixel,
            ...(v.judge ? { judge: v.judge } : {}), ...(v.judgeError ? { judgeError: v.judgeError } : {}),
            ...(v.clayGrid ? { clayGrid: v.clayGrid, clayRenders: v.clayRenders } : {}),
            ...(v.clayJudge ? { clayJudge: v.clayJudge } : {}), ...(v.clayJudgeError ? { clayJudgeError: v.clayJudgeError } : {})
        };
    }
    const summary = summarize({ ref, loaded, scores, views, scored: scored.length, nRuns, judgeModelUse, contextNote: context ? 'in context' : 'not in context', unregistered: unregistered.length, usedPanos: builds.used.size })
        + (wantClay ? clayLine(loaded, clayScores, clayScored.length, prepared.length) : '')
        + satelliteLine(loaded, satellite, satPrepared?.view);
    const report = {
        status: 'success',
        evalId,
        summary,
        place: ref.place,
        origin: ref.origin,
        reference: ref.source,
        inContext: !!context,
        context: contextNote,
        judgeModel: judgeModelUse,
        runsPerView: nRuns,
        trees: wantTrees ? (drawsTrees ? 'regrown trees drawn one level per tree per view, as the viewport chooses it; scanned trees cut from the street' + (ref.removedTrees ? '' : ' (none recorded: they stay)') : 'no arm has a trees layer') : 'off: no trees layer drawn',
        arms: loaded.map(a => ({ id: a.id, label: a.label, triangles: a.triangles, glbs: a.glbs, ...(a.treeLayers ? { treeLayers: a.treeLayers } : {}), ...(a.runId ? { runId: a.runId } : {}), ...(a.layers ? { layers: a.layers } : {}), ...(a.baseline ? { baseline: true } : {}) })),
        scores,
        clay: wantClay,
        ...(wantClay ? { clayScores, clayJudged: clayScored.length, clayGrids: views.map(v => v.clayGrid).filter((g): g is string => !!g) } : {}),
        satelliteOrtho: satellite,
        pixelMetrics: { note: 'Secondary: inside the target mask (the raw scan\'s coverage when the baseline is on). They do not rank builds the way the judge does.', mean: pixelMean },
        views: views.map(v => ({ ...v, renders: v.renders })),
        grids: views.map(v => v.grid),
        heldOut: {
            panosNear: panos.length,
            usedByBuild: builds.used.size,
            usedPanoSources: builds.usedSources,
            candidates: candidates.length,
            fetched: got.images.length,
            fetchFailures: got.failures.map(f => ({ panoId: f.view.panoId, error: f.error })),
            registered: locked.length,
            unregistered,
            judged: scored.length
        },
        outDir,
        ms: now() - t0
    };
    const reportJson = path.join(outDir, 'report.json');
    fs.writeFileSync(reportJson, JSON.stringify(report, null, 1));
    // one durable row for this judgement, outside the stage cache (run-ledger.ts): each arm's cheap measurements beside
    // the scores it was given, joined to its build by runId, and marked when only the stand-in scored it
    appendJudgeRow(judgeRowFromReport(report, { reportJson }));
    progress('done', 1);
    return report;
}

/** The satellite second opinion's line of the summary: used (with its GSD and the judge's overall per arm), failed, or not asked for. */
function satelliteLine(loaded: Array<{ id: string; label: string }>, sat: Record<string, unknown>, view?: PhotoMatchViewResult): string {
    if (!sat.requested) return '';
    if (!sat.used) return ` Satellite second opinion (includeSatelliteOrtho) was requested but not used: ${sat.error}.`;
    const gsd = (sat.gsdMetresPerPixel as number).toFixed(3);
    if (!view?.judge) return ` Satellite second opinion (Google Static Maps, top-down at ${gsd} m/px, capture date unknown): rendered and gridded, but the judge returned no usable scores for it${view?.judgeError ? ` (${view.judgeError})` : ''}; not counted in the scores.`;
    const ranked = [...loaded].filter(a => view.judge!.stats[a.id]?.overall).sort((a, b) => view.judge!.stats[b.id].overall.mean - view.judge!.stats[a.id].overall.mean);
    return ` Satellite second opinion (Google Static Maps, top-down at ${gsd} m/px, capture date unknown; not counted in the scores): ${ranked.map(a => `${a.label} [${a.id}] overall ${view.judge!.stats[a.id].overall.mean.toFixed(1)}`).join('; ')}.`;
}

/** The clay arm's line of the summary: shape only, untextured. */
function clayLine(loaded: Array<{ id: string; label: string }>, clayScores: Record<string, { shape: ArmScore['shape'] }>, judged: number, views: number): string {
    if (!judged) return ` Clay (shape only): the judge returned no usable clay scores for any of the ${views} views.`;
    const ranked = [...loaded].sort((a, b) => clayScores[b.id].shape.mean - clayScores[a.id].shape.mean);
    return ` Clay, untextured, shape only (${judged} of ${views} views): ${ranked.map(a => `${a.label} [${a.id}] shape ${clayScores[a.id].shape.mean.toFixed(1)} (runs ±${clayScores[a.id].shape.runSd.toFixed(1)})`).join('; ')}.`;
}

function summarize(input: {
    ref: Reference; loaded: Array<{ id: string; label: string; baseline?: boolean }>; scores: Record<string, ArmScore>; views: PhotoMatchViewResult[]; scored: number; nRuns: number;
    judgeModelUse: { requested: string; answered: string }; contextNote: string; unregistered: number; usedPanos: number;
}): string {
    const { loaded, scores, scored, nRuns } = input;
    const line = (a: { id: string; label: string }) => {
        const s = scores[a.id];
        return `${a.label} [${a.id}]: overall ${s.overall.mean.toFixed(1)} (runs ±${s.overall.runSd.toFixed(1)}, views ${s.overall.min.toFixed(1)}-${s.overall.max.toFixed(1)}); shape ${s.shape.mean.toFixed(1)}, materials ${s.materials.mean.toFixed(1)}, detail ${s.detail.mean.toFixed(1)}, errors ${s.errors.mean.toFixed(1)}${Number.isFinite(s.realism?.mean) ? `; realism ${s.realism.mean.toFixed(1)}` : ''}${Number.isFinite(s.identity?.mean) ? `, identity ${s.identity.mean.toFixed(1)}` : ''}`;
    };
    const ranked = [...loaded].sort((a, b) => scores[b.id].overall.mean - scores[a.id].overall.mean);
    const top = ranked[0], second = ranked[1];
    const spread = Math.max(...loaded.map(a => scores[a.id].overall.runSd), 0.1);
    let verdict = '';
    if (second) {
        const gap = scores[top.id].overall.mean - scores[second.id].overall.mean;
        verdict = gap <= spread
            ? ` ${top.label} and ${second.label} are within the judge's own run-to-run spread (gap ${gap.toFixed(2)}): no clear winner.`
            : ` ${top.label} scores highest, ${gap.toFixed(1)} ahead of ${second.label}.`;
    }
    const scale = scores[top.id].overall.mean < 5 ? ' Even the best render is judged a weak likeness (below 5 of 10).' : '';
    const few = scored < 3 ? ` Only ${scored} view${scored === 1 ? '' : 's'} could be judged: treat this as indicative.` : '';
    return `Judged blind by ${input.judgeModelUse.answered} against ${scored} held-out Street View photo${scored === 1 ? '' : 's'} of ${input.ref.place} that no build used (${input.usedPanos} panos the builds used were excluded), ` +
        `${nRuns} reshuffled runs each, rendered ${input.contextNote} from each photo's registered pose. Scores 1-10 (relative, a vision model's judgement, not a measurement): ` +
        `${ranked.map(line).join('; ')}.${verdict}${scale}${few}${input.unregistered ? ` ${input.unregistered} fetched view${input.unregistered === 1 ? '' : 's'} did not register and ${input.unregistered === 1 ? 'was' : 'were'} not used.` : ''} ` +
        'Pixel metrics are secondary. Look at the grids before claiming a likeness.';
}

/** The tool handler on given dependencies (tests pass fakes for Street View, registration and the judge). */
export function createPhotoMatchEvaluateHandler(deps?: () => PhotoMatchDeps): ToolHandler {
    return async (args, ctx): Promise<ToolHandlerOutcome> => {
        try {
            const report = await evaluatePhotoMatch(args, ctx, deps ? deps() : defaultPhotoMatchDeps());
            return { status: 'completed', summaryResult: String(report.summary), resultPayload: report };
        } catch (err) {
            const code = err instanceof PhotoMatchError ? err.code : 'failed';
            const message = err instanceof Error ? err.message : String(err);
            return {
                status: 'failed',
                summaryResult: `${PHOTO_MATCH_EVALUATE_TOOL} failed (${code}): ${message}`,
                resultPayload: { status: 'error', code, message, ...(err instanceof PhotoMatchError && err.details ? { details: err.details } : {}), note: 'No scores: nothing was judged.' }
            };
        }
    };
}

export const runPhotoMatchEvaluate: ToolHandler = createPhotoMatchEvaluateHandler();
