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
 *     frame and the tile mesh does not hide most of it; at a place with no structure at it (a park, a plaza) the tile's surfaces
 *     round the place stand in for the structure (openPlaceViews); the images come through the grounding API and are posed against the
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
    aggregateCriteria, aggregateRuns, armLayerTriangles, armMeshesForView, composeGrid, coverageMask, judgeView, judgeViewClay, loadArmLayer, perceptualScores, photoEdgeField, planOutlineCells, regionMasks, regionOverlay, regionScores,
    regionsInFrame, renderPng, renderTriangles, targetPlacement, tileEdgeInFrame, triangleRegions, JUDGE_CRITERIA, JUDGE_REGION_CRITERIA, PHOTO_MATCH_GROUND_BAND_M, PHOTO_MATCH_METRIC_WIDTH_PX, PHOTO_MATCH_OUTLINE_REACH_M, PHOTO_MATCH_PLACEMENT_BAND_PX, PHOTO_MATCH_PLACEMENT_SEARCH_PX,
    PHOTO_MATCH_PLACEMENT_TRUNCATION_PX, PHOTO_MATCH_REGION_LEGEND, PHOTO_MATCH_REGION_MIN_SHARE, PHOTO_MATCH_REGIONS, PHOTO_MATCH_TILE_EDGE_MIN_SHARE, PHOTO_MATCH_TILE_EDGE_REACH_M, REGION,
    type ArmLayer, type ArmRender, type CriterionStat, type JudgeClient, type JudgeCriterion, type JudgeRegionCriterion, type JudgeRun, type PerceptualScores, type PhotoMatchRegion, type RegionMasks, type RegionScore,
    type TargetPlacement, type TileEdgeReading
} from '../../../3d-engine/staged-location/photo-match-eval';
import { readTileTriangles, decodeImageInMemory, type TileTriangles } from '../../../3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../../../3d-engine/staged-location/png-encode';
import { fetchOrthoReference, orthoReferenceCamera, type OrthoReference } from '../../../3d-engine/staged-location/ortho-reference';
import { castCamera } from '../../../3d-engine/staged-location/survey-casting';
import { isTreesLodJson } from '../../../3d-engine/staged-location/tree-lod-view';
import { bearingDeg, discoverPanos, discoverPanosAt, evidenceImageId, fetchViews, knownRefusals, type PanoCandidate, type SelectedView, type StreetViewEvidenceDeps } from '../../../3d-engine/staged-location/streetview-evidence';
import { fetchStreetViewPanoMetadata } from '../../../spatial/StreetViewPanoramaProjectionService';
import { isGoogleCapture } from '../../../spatial/StreetViewGroundingImageService';
import { EDGE_MAX_RESIDUAL_PX, type HeldImage } from '../../../3d-engine/staged-location/pano-edge-registration';
import { runPanoRegistrationOffThread } from '../../../3d-engine/staged-location/pano-registration-run';
import { StageCache, stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';
import { readGlbScene, renderFrameDepth, sceneToRenderMesh, type PoseCorrection } from '../../../spatial/StreetViewPoseRegistrar';
import { buildGroundModel, geodeticToScan, loadScanMesh } from '../../../spatial/StreetViewSurveyPlanner';
import { pickStructure, PICK_STRUCTURE, STRUCTURE_SEED_SEARCH_M } from '../../../3d-engine/staged-location/extraction-sizing';
import { evidenceLookup, type EvidenceLookup } from '../../../3d-engine/staged-location/vector-footprints';
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
/**
 * A place with no structure at it (a park, a plaza): the views look at the tile's surfaces within these radii of the place,
 * the structure pick's own search window first (where it found nothing standing), widened a window at a time until enough
 * views qualify.
 */
export const OPEN_PLACE_RADII_M = [1, 2, 3, 4].map(k => k * STRUCTURE_SEED_SEARCH_M);
/** A fixed pose looks from the nearest Google-captured pano within this distance of its position, else it is not used. */
export const FIXED_POSE_MAX_PANO_M = 20;
/** A fixed pose's field of view when none is given (the grounding API's own default and its widest). */
export const FIXED_POSE_DEFAULT_FOV = 90;

export const PHOTO_MATCH_EVALUATE_DECLARATION: ToolDeclaration = {
    name: PHOTO_MATCH_EVALUATE_TOOL,
    description:
        'Check how much a location build looks like the real place, against real Google Street View photos the build never used. ' +
        'Use it to check a location build (google_3d_tiles_get_clay, tile_refine output, any GLB in the tile frame) BEFORE telling the user it looks right or that one version is better than another. ' +
        'It picks held-out Street View views near the structure (never a pano any build used: it checks), registers each against the tile mesh (a view that does not lock is not used), ' +
        'renders every build from exactly those camera poses in its street, and has a vision model score the renders blind against each photo (shuffled and unlabelled, several runs) ' +
        'on shape, materials, detail, errors (10 = nothing wrong or invented), overall, realism (looks like a real photograph) and identity (recognisably this place), 1-10. Returns per-view and mean scores per criterion with their spread across runs and views, ' +
        'pixel metrics (SSIM, edge chamfer, colour difference: secondary, they do not rank builds reliably), the grid images (photo beside each render) and a short summary. ' +
        'The pixel metrics are also given per region of each view: the whole frame, the target building, the ground, the neighbouring buildings, measured trees and the skyline band, with masks taken from the geometry each pixel shows (never from colour) and drawn in the grids. ' +
        'By default it also renders every build in uniform untextured clay from the same poses and has the judge score shape only (massing, openings, surface relief) against the photo: ' +
        'clayScores, clay grids; use them to compare geometry changes (relief, reveals, massing) that the photo texture hides. ' +
        'Every build\'s placement is also measured from edges, not by the judge: the image shift that sets the target\'s outline on the photo\'s edges (placement, px and degrees; 0 = drawn where the photo shows it). ' +
        'A view whose registered eye stands under the street is not used; a region under 1% of a view is not judged there; a view where the reference tile ends inside the frame (its sky over what stands past the edge) is flagged (tileEdge) and its regions are not judged. ' +
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
                        glbs: { type: 'ARRAY', items: { type: 'STRING' } },
                        scope: { type: 'STRING', description: '"target": the build stands in for the target alone and is drawn in its street (the tile with the target cut out); "place": the build is the whole place (its own street and neighbours) and is drawn on its own. Default: an isolated run is "target", a district run "place", GLBs "target".' }
                    }
                }
            },
            views: { type: 'NUMBER', description: `Held-out views to judge (default ${PHOTO_MATCH_DEFAULT_VIEWS}, at most ${PHOTO_MATCH_MAX_VIEWS}), fixed poses included.` },
            poses: {
                type: 'ARRAY',
                description: `Fixed held-out views, judged blind with the automatic ones and counted in views (raised to their number; at most ${PHOTO_MATCH_MAX_VIEWS}). ` +
                    `Each looks from the nearest Google-captured Street View pano within ${FIXED_POSE_MAX_PANO_M} m of lat/lng, or from the pano named, along headingDeg. ` +
                    'A pano any build used is refused and a view that does not register is not used; heldOut.fixed reports every pose, the pano it used and why any dropped out.',
                items: {
                    type: 'OBJECT',
                    properties: {
                        label: { type: 'STRING', description: 'Short name for the pose in the report.' },
                        lat: { type: 'NUMBER' },
                        lng: { type: 'NUMBER' },
                        panoId: { type: 'STRING', description: 'Instead of lat/lng: the pano to look from.' },
                        headingDeg: { type: 'NUMBER', description: 'View direction, degrees clockwise from north.' },
                        pitchDeg: { type: 'NUMBER', description: 'Elevation, degrees, up positive (default 0).' },
                        fovDeg: { type: 'NUMBER', description: `Horizontal field of view, 10-90 degrees (default ${FIXED_POSE_DEFAULT_FOV}).` }
                    },
                    required: ['headingDeg']
                }
            },
            inContext: { type: 'BOOLEAN', description: 'Render each build inside the photo-textured tile with only the target cut out, the same street for every build (default true). False renders it alone on grey with the tile as an occluder.' },
            judgeModel: { type: 'STRING', description: `Vision model asked first (default ${PHOTO_MATCH_DEFAULT_JUDGE}; the chat's fallbacks follow).` },
            runs: { type: 'NUMBER', description: `Blind judgements per view, each with the order reshuffled (default ${PHOTO_MATCH_DEFAULT_RUNS}).` },
            clay: { type: 'BOOLEAN', description: 'Also judge every build rendered in uniform clay (no texture) from the same poses, for shape only (default true; one more judge call per view and run).' },
            trees: { type: 'BOOLEAN', description: 'Draw a run\'s regrown trees as the viewport shows them from each pose (one level of detail per tree, leaves expanded) and cut the scanned trees they replace out of the street (default true). False leaves the trees layer out and the scanned trees in the street.' },
            baseline: { type: 'BOOLEAN', description: 'Also render the raw scan as downloaded (cut to the target) as a reference arm (default true when the tile is known).' },
            place: { type: 'STRING', description: 'The place as named to the judge (default: the run\'s resolved address).' },
            excludePanoIds: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Panos the build used that the records do not show (GLB builds made elsewhere): never held out.' },
            judgeRegions: { type: 'BOOLEAN', description: 'Also have the judge score the place around the building in every view: the ground, the neighbouring buildings and the skyline, 1-10, blind like the rest (regionScores). The building criteria are asked as before (default false; no extra judge calls).' },
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
    /**
     * Panos a fixed pose can look from, Google captures only and the grounding API's known refusals left out: those found round a
     * point (tile frame; the tool takes the nearest), or the one pano named. None, with the reason, when there is none.
     */
    posePanos?(origin: GeodeticOrigin, at: { x: number; z: number } | { panoId: string }, cacheDir: string, signal?: AbortSignal): Promise<{ panos: PanoCandidate[]; reason?: string }>;
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
        posePanos: async (origin, at, cacheDir, signal) => {
            const sv = { mapsApiKey: maps().resolveMapsApiKey(), metadataCachePath: path.join(cacheDir, 'streetview', 'metadata.json') };
            if ('panoId' in at) {
                let m: Awaited<ReturnType<typeof fetchStreetViewPanoMetadata>>;
                try {
                    m = await fetchStreetViewPanoMetadata({ panoId: at.panoId, apiKey: sv.mapsApiKey });
                } catch (err) {
                    if (/No Street View panorama found/.test((err as Error).message)) return { panos: [], reason: `pano ${at.panoId}: ${(err as Error).message}` };
                    throw err;
                }
                if (!isGoogleCapture(m.copyright)) return { panos: [], reason: `pano ${at.panoId} is not a Google capture (${m.copyright ?? 'no copyright given'})` };
                const refused = knownRefusals(sv).get(at.panoId);
                if (refused) return { panos: [], reason: `the grounding API refuses pano ${at.panoId}: ${refused}` };
                const q = geodeticToScan(origin, m.lat, m.lng);
                return { panos: [{ panoId: m.panoId, lat: m.lat, lng: m.lng, ...(m.date ? { date: m.date } : {}), ...(m.copyright ? { copyright: m.copyright } : {}), x: q.x, z: q.z }] };
            }
            // the nearest pano to each probe within 8 m: the point itself and two rings round it reach every pano within the limit
            const probes = [at, ...([[8, 8], [16, 12]] as const).flatMap(([r, n]) => Array.from({ length: n }, (_, k) => {
                const a = (2 * Math.PI * k) / n;
                return { x: at.x + r * Math.sin(a), z: at.z - r * Math.cos(a) };
            }))];
            const r = await discoverPanosAt(origin, probes, sv, signal, at);
            return { panos: r.panos, ...(r.panos.length ? {} : { reason: `no Google-captured pano found round the position (${r.rejectedNotGoogle} not Google captures, ${r.rejectedRefused} refused by the grounding API)` }) };
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

/**
 * What an arm is: `target` stands in for the target alone (an isolated build: drawn in its street, the tile with the target
 * cut out), `place` is the whole place (a district build: drawn on its own, its own street and neighbours).
 */
export type ArmScope = 'target' | 'place';

interface ArmSpec { id: string; label: string; runId?: string; glbs?: string[]; scope?: ArmScope }

interface ResolvedArm {
    id: string; label: string; glbs: string[]; runId?: string; layers?: Array<{ layer: string; textured: boolean }>; baseline?: boolean; scope: ArmScope;
    /** Metres added to every height to bring the arm's frame onto the reference's (runs extracted at the same place, origin heights apart). */
    dy?: number;
}

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
    /** Google's building footprints the run read (its vector stage), for the structure pick at the place when nothing was isolated. */
    footprints?: EvidenceLookup;
    source: string;
}

type TilesValue = { texturedGlb: string; geometryGlb: string; originEllipsoidalHeightM: number; geoAnchor?: { lat: number; lng: number } };

interface RunRecordLike {
    runId: string;
    request?: { query?: string; isolate?: boolean };
    place?: { lat: number; lng: number; formattedAddress?: string };
    keys?: Record<string, string>;
}

const RUN_ID = /^[0-9a-f]{8}$/;
const PANO_KEY = /^sv:([^:]+):/;
/**
 * A view of a pano named by its 22-character Google pano id and heading: "<panoId>_h<deg>_p<deg>" (the build's scored views),
 * "SV_<panoId>_h<deg>" (survey stations), "<panoId>_h<deg>_p<deg>_f<deg>.jpg" (survey frames).
 */
const PANO_VIEW = /([A-Za-z0-9_-]{22})_h-?\d+/g;

/** Every pano id a JSON value names: `panoId` strings, `panoIds` arrays, "sv:<panoId>:..." ids and views named after a pano. */
export function collectPanoIds(value: unknown, into: Set<string> = new Set()): Set<string> {
    const walk = (v: unknown, key?: string): void => {
        if (typeof v === 'string') {
            if (key === 'panoId' && v) into.add(v);
            const m = PANO_KEY.exec(v);
            if (m) into.add(m[1]);
            for (const view of v.matchAll(PANO_VIEW)) into.add(view[1]);
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

    /**
     * The extraction of a run whose seam stage welded it: the run keys its tiles on the welded scan, and its tile_seams note
     * names the raw extraction, whose cache entry holds the frame; the welded files lie beside it, named as the orchestrator
     * names them (its tile seam step). Undefined without the note or the files.
     */
    weldedTiles(rec: RunRecordLike): { dir: string; value: TilesValue } | undefined {
        const note = this.cache.readRunNote<{ version?: string; raw?: string; tJunctions?: unknown; overlapTrim?: unknown }>(rec.runId, 'tile_seams');
        if (!note?.raw || !note.version) return undefined;
        const dir = path.dirname(note.raw);
        let raw: TilesValue | undefined;
        try { raw = (JSON.parse(fs.readFileSync(path.join(dir, 'done.json'), 'utf8')) as { value?: TilesValue }).value; } catch { return undefined; }
        const tag = `${note.version.replace(/\W/g, '_')}${note.tJunctions ? '' : '_notj'}${note.overlapTrim ? '' : '_noov'}`;
        const value = raw && { ...raw, texturedGlb: `textured_${tag}.glb`, geometryGlb: `geometry_${tag}.glb` };
        return value && fs.existsSync(path.join(dir, value.texturedGlb)) && fs.existsSync(path.join(dir, value.geometryGlb)) ? { dir, value } : undefined;
    }

    /** The reference of a run: its tile, origin, isolate and place. */
    runReference(rec: RunRecordLike): Reference {
        const direct = this.stageValue<TilesValue>('tiles', rec.keys?.tiles);
        const welded = direct ? undefined : this.weldedTiles(rec);
        const tiles = direct ?? welded;
        if (!tiles) throw new PhotoMatchError('missing_reference_tile', `Staged run ${rec.runId} has no cached tile extraction (stage "tiles", nor a seam-welded scan its tile_seams note leads to), so its frame and street are unknown.`);
        const textured = path.join(tiles.dir, tiles.value.texturedGlb), geometry = path.join(tiles.dir, tiles.value.geometryGlb);
        if (!fs.existsSync(textured) || !fs.existsSync(geometry)) throw new PhotoMatchError('missing_reference_tile', `Staged run ${rec.runId}: the cached tile files are missing (${tiles.dir}).`);
        const place = rec.place ?? tiles.value.geoAnchor;
        if (!place) throw new PhotoMatchError('missing_reference_tile', `Staged run ${rec.runId} records no place coordinates.`);
        const remesh = this.stageValue<{ clay?: string }>('remesh', rec.keys?.remesh);
        // the isolate tile_refine wrote beside its clay; a polished clay (pipeline K: <entry>/polish/<key>/clay.glb) lies two
        // levels below that entry
        const iso = remesh?.value.clay ? [0, 2].map(up => path.join(path.dirname(remesh.value.clay!), ...new Array(up).fill('..'), 'raw_clay.glb')).map(f => path.normalize(f)).find(f => fs.existsSync(f)) : undefined;
        // the strip's cache entry (tile-vegetation-service.ts): its removed_trees.glb is what the regrown trees replace
        const stripKey = rec.keys?.['trees-measure'];
        const removed = stripKey && /^[0-9a-f]{16,}$/.test(stripKey) ? path.join(this.root, '.scratchbox', 'cache', 'tile_vegetation', stripKey, 'removed_trees.glb') : undefined;
        // the footprints of Google's buildings the vector stage read (in the place's frame: x east, z south, the same origin)
        const vector = this.stageValue<{ sel?: { buildings?: StoredVectorBuilding[] } }>('vector', rec.keys?.vector);
        const footprints = vector?.value.sel?.buildings?.length ? footprintLookup(vector.value.sel.buildings) : undefined;
        return {
            origin: { lat: place.lat, lng: place.lng, heightMeters: tiles.value.originEllipsoidalHeightM },
            place: rec.place?.formattedAddress ?? rec.request?.query ?? `${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}`,
            tileTextured: textured, tileGeometry: geometry,
            ...(iso && fs.existsSync(iso) ? { isolate: iso } : {}),
            ...(removed && fs.existsSync(removed) ? { removedTrees: removed } : {}),
            ...(footprints ? { footprints } : {}),
            source: `staged run ${rec.runId}${welded ? ' (its seam-welded scan, which every stage of the run read)' : ''}`
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

/** A building as the vector stage stores it (vector-first-paint.ts): extruded parts' loops, and modelled volumes (x, height, z). */
interface StoredVectorBuilding {
    id: string;
    parts: Array<{ loops: Array<Array<[number, number]>> }>;
    volumes?: Array<{ vertices: Array<[number, number, number]>; indices: number[] }>;
}

/**
 * The point lookup the structure pick reads (feature index + 1, 0 off every footprint) from footprints in the tile frame. A
 * building Google models as a 3D volume has no extruded parts; its plan is the union of its triangles seen from above, as
 * vector-footprints.ts reads it from the tiles.
 */
export function footprintLookup(buildings: StoredVectorBuilding[]): EvidenceLookup {
    const plans = buildings.map(b => {
        const parts: Array<Array<Array<[number, number]>>> = b.parts.map(p => p.loops);
        for (const v of b.volumes ?? []) {
            const q = v.vertices.map(([x, , z]) => [x, z] as [number, number]);
            for (let i = 0; i + 2 < v.indices.length; i += 3) {
                const tri = [q[v.indices[i]], q[v.indices[i + 1]], q[v.indices[i + 2]]];
                if (!tri.every(Boolean)) continue;
                const area = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
                if (Math.abs(area) > 1e-3) parts.push([tri]);
            }
        }
        return { id: b.id, parts };
    });
    let reach = 0;
    for (const b of plans) for (const p of b.parts) for (const l of p) for (const [x, z] of l) reach = Math.max(reach, Math.abs(x), Math.abs(z));
    return evidenceLookup({ buildings: plans, water: [], roads: [], tiles: 0, zoom: 0 }, Math.min(2000, Math.ceil(reach)));
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
            const scope = a?.scope === 'target' || a?.scope === 'place' ? a.scope as ArmScope : undefined;
            return { id, label: typeof a?.label === 'string' && a.label.trim() ? a.label.trim() : (runId ? `RUN ${runId}` : `BUILD ${id}`), ...(runId ? { runId } : {}), ...(glbs.length ? { glbs } : {}), ...(scope ? { scope } : {}) };
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
    const near = nearTriangleFlags(t, ref, tol);
    return selectTriangles(t, near.map(f => (!!f !== drop ? 1 : 0)));
}

/** Per triangle of `t`, 1 when its centroid lies within `tol` of one of `ref`'s centroids (a hash grid). */
export function nearTriangleFlags(t: TileTriangles, ref: TileTriangles, tol = 0.01): Uint8Array {
    const grid = new Map<string, number[]>();
    const rc = centroids(ref), cell = (v: number) => Math.floor(v / tol);
    for (let i = 0; i < rc.length; i += 3) {
        const k = `${cell(rc[i])},${cell(rc[i + 1])},${cell(rc[i + 2])}`;
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
    }
    const tc = centroids(t), flags = new Uint8Array(t.texture.length);
    for (let i = 0; i < t.texture.length; i++) {
        const x = tc[i * 3], y = tc[i * 3 + 1], z = tc[i * 3 + 2];
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) {
            const g = grid.get(`${cell(x) + dx},${cell(y) + dy},${cell(z) + dz}`);
            if (g?.some(j => Math.hypot(rc[j] - x, rc[j + 1] - y, rc[j + 2] - z) <= tol)) hit = true;
        }
        if (hit) flags[i] = 1;
    }
    return flags;
}

/**
 * How far (m) a tile triangle's centroid may lie from the isolate's surface and still be on it: the seam weld's tolerance
 * (tile-seam-weld-service, 3 cm), the most a weld moved a vertex of the scan the isolate was cut from.
 */
export const PHOTO_MATCH_ISOLATE_SURFACE_M = 0.03;

/** Squared distance from p to the triangle (a, b, c) (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDist2(P: ArrayLike<number>, o: number, px: number, py: number, pz: number): number {
    const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d2 = (x: number, y: number, z: number) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    const d1 = abx * apx + aby * apy + abz * apz, e1 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && e1 <= 0) return d2(ax, ay, az);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, e3 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && e3 <= d3) return d2(bx, by, bz);
    const vc = d1 * e3 - d3 * e1;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d2(ax + v * abx, ay + v * aby, az + v * abz); }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d6 = abx * cpx + aby * cpy + abz * cpz, e6 = acx * cpx + acy * cpy + acz * cpz;
    if (e6 >= 0 && d6 <= e6) return d2(cx, cy, cz);
    const vb = d6 * e1 - d1 * e6;
    if (vb <= 0 && e1 >= 0 && e6 <= 0) { const w = e1 / (e1 - e6); return d2(ax + w * acx, ay + w * acy, az + w * acz); }
    const va = d3 * e6 - d6 * e3;
    if (va <= 0 && e3 - d3 >= 0 && d6 - e6 >= 0) { const w = (e3 - d3) / (e3 - d3 + d6 - e6); return d2(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return d2(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** A point query against triangles: whether a point lies within `tol` of any of them (a uniform grid over their bounds). */
function surfaceIndex(t: TileTriangles, tol: number, keep?: Uint8Array): (x: number, y: number, z: number) => boolean {
    const CELL = 2, grid = new Map<string, number[]>(), P = t.positions;
    const cell = (v: number) => Math.floor(v / CELL);
    for (let i = 0; i < t.texture.length; i++) {
        if (keep && !keep[i]) continue;
        const o = i * 9, lo = [0, 1, 2].map(k => cell(Math.min(P[o + k], P[o + 3 + k], P[o + 6 + k]) - tol)), hi = [0, 1, 2].map(k => cell(Math.max(P[o + k], P[o + 3 + k], P[o + 6 + k]) + tol));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const k = `${x},${y},${z}`, list = grid.get(k);
            if (list) list.push(o); else grid.set(k, [o]);
        }
    }
    const tol2 = tol * tol;
    return (x, y, z) => !!grid.get(`${cell(x)},${cell(y)},${cell(z)}`)?.some(o => pointTriangleDist2(P, o, x, y, z) <= tol2);
}

/**
 * Per triangle of `t`, 1 when its centroid lies on `ref`'s surface (within `tol`, point to triangle). A triangle of `t` that
 * `ref` holds cut into pieces (an isolate cut at its outline, split at a seam) is found whole; one `ref` cut through is
 * decided by where its centroid falls.
 */
export function onSurfaceFlags(t: TileTriangles, ref: TileTriangles, tol = PHOTO_MATCH_ISOLATE_SURFACE_M): Uint8Array {
    const near = surfaceIndex(ref, tol), c = centroids(t), flags = new Uint8Array(t.texture.length);
    for (let i = 0; i < flags.length; i++) if (near(c[i * 3], c[i * 3 + 1], c[i * 3 + 2])) flags[i] = 1;
    return flags;
}

/**
 * The share of `ref`'s area within `tol` of the triangles of `t` that `flags` selects: each triangle of `ref` sampled at four
 * interior points (its centroid and the midpoints between it and each corner), each standing for a quarter of its area.
 */
export function surfaceCoverShare(ref: TileTriangles, t: TileTriangles, flags: Uint8Array, tol = PHOTO_MATCH_ISOLATE_SURFACE_M): number {
    const near = surfaceIndex(t, tol, flags), P = ref.positions;
    let total = 0, covered = 0;
    for (let i = 0; i < ref.texture.length; i++) {
        const o = i * 9;
        const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2], vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (!(area > 0)) continue;
        total += area;
        const g = [0, 1, 2].map(k => (P[o + k] + P[o + 3 + k] + P[o + 6 + k]) / 3);
        const samples = [g, ...[0, 3, 6].map(v => [0, 1, 2].map(k => (g[k] + P[o + v + k]) / 2))];
        for (const s of samples) if (near(s[0], s[1], s[2])) covered += area / 4;
    }
    return total > 0 ? covered / total : 0;
}

/** The triangles of `t` whose entry in `keepFlags` is set, in order. */
function selectTriangles(t: TileTriangles, keepFlags: Uint8Array): TileTriangles {
    const keep: number[] = [];
    for (let i = 0; i < keepFlags.length; i++) if (keepFlags[i]) keep.push(i);
    const pickF = (a: Float32Array, w: number) => { const o = new Float32Array(keep.length * w); keep.forEach((s, d) => o.set(a.subarray(s * w, s * w + w), d * w)); return o; };
    const pickI = (a: Int32Array, w: number) => { const o = new Int32Array(keep.length * w); keep.forEach((s, d) => o.set(a.subarray(s * w, s * w + w), d * w)); return o; };
    return { ...t, positions: pickF(t.positions, 9), uvs: pickF(t.uvs, 6), normals: pickF(t.normals, 3), texture: pickI(t.texture, 1), flatLinear: pickF(t.flatLinear, 3) };
}

/** A copy of `t` raised by `dy` metres (an arm from another extraction at the same place, onto the reference's frame). */
function liftTriangles(t: TileTriangles, dy: number): TileTriangles {
    const positions = Float32Array.from(t.positions);
    for (let i = 1; i < positions.length; i += 3) positions[i] += dy;
    return { ...t, positions };
}

/** The triangles of `mesh` that stand (a vertex more than the ground band above the terrain) with their centroid where `at` holds. */
function standingIn(mesh: RenderMesh3D, terrain: { groundAt(x: number, z: number): number }, at: (x: number, z: number) => boolean): RenderMesh3D {
    const V = mesh.vertices, I = mesh.indices;
    const out: number[] = [];
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        if (!at((V[a] + V[b] + V[c]) / 3, (V[a + 2] + V[b + 2] + V[c + 2]) / 3)) continue;
        if (![a, b, c].some(o => V[o + 1] - terrain.groundAt(V[o], V[o + 2]) > PHOTO_MATCH_GROUND_BAND_M)) continue;
        for (const o of [a, b, c]) out.push(V[o], V[o + 1], V[o + 2]);
    }
    return { vertices: Float32Array.from(out), indices: Uint32Array.from({ length: out.length / 3 }, (_, k) => k) };
}

/** Lowest surface of the mesh under (x, z) within 1.5 m (the street off the terrain), else NaN. */
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

interface Structure {
    cx: number; cz: number; radiusM: number; ymin: number; ymax: number; mesh: RenderMesh3D;
    /** An open place (no structure at it): the views aim at its centre and at its ground there (this height), never at a nearest wall. */
    openGroundY?: number;
}

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

/**
 * The surfaces of `mesh` within `r` of (cx, cz) in plan. A triangle that crosses the circle is cut at it (at a 32-sided polygon
 * round it, heights interpolated), so a large ground triangle counts for its part inside and nothing reaches past the circle.
 */
export function surfacesWithin(mesh: RenderMesh3D, cx: number, cz: number, r: number): RenderMesh3D {
    const SIDES = 32;
    const V = mesh.vertices, I = mesh.indices;
    const out: number[] = [];
    const emit = (poly: number[][]) => { for (let k = 1; k + 1 < poly.length; k++) for (const p of [poly[0], poly[k], poly[k + 1]]) out.push(p[0], p[1], p[2]); };
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        // wholly outside the circle's square, or wholly inside the circle
        if (Math.min(V[a], V[b], V[c]) - cx > r || Math.max(V[a], V[b], V[c]) - cx < -r || Math.min(V[a + 2], V[b + 2], V[c + 2]) - cz > r || Math.max(V[a + 2], V[b + 2], V[c + 2]) - cz < -r) continue;
        const tri = [a, b, c].map(o => [V[o], V[o + 1], V[o + 2]]);
        if (tri.every(p => Math.hypot(p[0] - cx, p[2] - cz) <= r)) { emit(tri); continue; }
        let poly = tri;
        for (let k = 0; k < SIDES && poly.length >= 3; k++) {
            const nx = Math.cos((2 * Math.PI * k) / SIDES), nz = Math.sin((2 * Math.PI * k) / SIDES);
            const side = (p: number[]) => (p[0] - cx) * nx + (p[2] - cz) * nz - r;
            const kept: number[][] = [];
            for (let i = 0; i < poly.length; i++) {
                const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
                if (sp <= 0) kept.push(p);
                if ((sp <= 0) !== (sq <= 0)) { const f = sp / (sp - sq); kept.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1]), p[2] + f * (q[2] - p[2])]); }
            }
            poly = kept;
        }
        if (poly.length >= 3) emit(poly);
    }
    return { vertices: Float32Array.from(out), indices: Uint32Array.from({ length: out.length / 3 }, (_, k) => k) };
}

/** An open place as the views' target: the surfaces within `radiusM` of the frame origin (the place), aimed at its ground there. */
function openPlace(disc: RenderMesh3D, terrain: { groundAt(x: number, z: number): number }, radiusM: number): Structure {
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 1; i < disc.vertices.length; i += 3) { ymin = Math.min(ymin, disc.vertices[i]); ymax = Math.max(ymax, disc.vertices[i]); }
    const g = terrain.groundAt(0, 0);
    return { cx: 0, cz: 0, radiusM, ymin, ymax, mesh: disc, openGroundY: Number.isFinite(g) ? g : ymin };
}

/** What a candidate's eye stands on: the terrain ground model, the lowest surface within 1.5 m (off the terrain), the structure's base. */
export type HeldOutEyeGround = 'terrain' | 'lowest-surface' | 'structure-base';

export interface HeldOutCandidateView extends SelectedView { close: boolean; visibleShare: number; screenShare: number; eyeGround: HeldOutEyeGround }

/** The street under (x, z): the terrain ground model, else (off it) the lowest surface of `context` within 1.5 m; undefined when neither. */
function streetAt(x: number, z: number, context: RenderMesh3D, terrain?: { groundAt(x: number, z: number): number }): { y: number; on: HeldOutEyeGround } | undefined {
    const t = terrain ? terrain.groundAt(x, z) : NaN;
    if (Number.isFinite(t)) return { y: t, on: 'terrain' };
    const s = groundAt(context.vertices, context.indices, x, z);
    return Number.isFinite(s) ? { y: s, on: 'lowest-surface' } : undefined;
}

/** How far round a pano the street is looked for when the tile has no surface under it (a pano past the tile's edge), m. */
export const HELD_OUT_EYE_GROUND_REACH_M = 25;

/**
 * The street at an eye's plan position: as a candidate's eye stands (the terrain, else the lowest surface within 1.5 m), else
 * (a pano past the tile's edge) the median terrain on the first ring round it, a metre at a time out to
 * HELD_OUT_EYE_GROUND_REACH_M, that has any; undefined when none.
 */
export function streetUnderEye(x: number, z: number, context: RenderMesh3D, terrain: { groundAt(x: number, z: number): number }): { y: number; on: HeldOutEyeGround | 'nearest-terrain'; distanceM?: number } | undefined {
    const s = streetAt(x, z, context, terrain);
    if (s) return s;
    for (let r = 1; r <= HELD_OUT_EYE_GROUND_REACH_M; r++) {
        const ring: number[] = [];
        for (let k = 0; k < 32; k++) { const a = (2 * Math.PI * k) / 32, g = terrain.groundAt(x + r * Math.sin(a), z - r * Math.cos(a)); if (Number.isFinite(g)) ring.push(g); }
        if (ring.length) { ring.sort((p, q) => p - q); return { y: ring[ring.length >> 1], on: 'nearest-terrain', distanceM: r }; }
    }
    return undefined;
}

/** A registered eye under the street there (streetUnderEye), with its depth below it; undefined when it stands above or none is known. */
export function eyeUnderStreet(eye: Vec3, context: RenderMesh3D, terrain: { groundAt(x: number, z: number): number }): { streetY: number; depthM: number; on: string } | undefined {
    const s = streetUnderEye(eye[0], eye[2], context, terrain);
    return s && eye[1] < s.y ? { streetY: s.y, depthM: s.y - eye[1], on: s.on === 'nearest-terrain' ? `the terrain ${s.distanceM} m away (none under the pano)` : s.on } : undefined;
}

/** How much of a 160 x 120 frame the target fills (screen), and the share of that which the context does not hide (seen). */
function targetShares(target: RenderMesh3D, context: RenderMesh3D, v: { eye: Vec3; headingDeg: number; pitchDeg: number; fovDeg: number }): { screen: number; seen: number } {
    const cam = castCamera({ eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, widthPx: 160, heightPx: 120 });
    const isoD = renderFrameDepth(target, cam), ctxD = renderFrameDepth(context, cam);
    let seen = 0, isoPx = 0;
    for (let i = 0; i < isoD.length; i++) if (isoD[i] < 1e8) { isoPx++; if (ctxD[i] >= isoD[i] - 0.6) seen++; }
    return { screen: isoPx / isoD.length, seen: isoPx ? seen / isoPx : 0 };
}

/**
 * Candidate views from the unused panos: one per pano, aimed at the structure (its nearest wall with a wide view when the pano
 * stands close, else its centre), kept when the structure fills enough of the frame and the tile mesh does not hide most of it.
 * An open place is aimed at its centre, at its ground there, from near and far alike.
 * The eye stands 2.5 m over the street: the terrain ground model under the pano (`terrain`, the reference tile's), else the
 * lowest surface within 1.5 m (scan below the street, a vault or a cutting, can reach far under it: the terrain does not).
 */
export function heldOutViews(panos: PanoCandidate[], structure: Structure, context: RenderMesh3D, exclude: Set<string>, terrain?: { groundAt(x: number, z: number): number }): { views: HeldOutCandidateView[]; rejected: string[] } {
    const { cx, cz, radiusM: R, ymin, ymax, openGroundY } = structure;
    const open = openGroundY !== undefined;
    const IV = open ? new Float32Array(0) : structure.mesh.vertices;
    const near = panos.filter(p => !exclude.has(p.panoId)).map(p => ({ ...p, d: Math.hypot(p.x - cx, p.z - cz) })).filter(p => p.d > R * 0.5 + 3 && p.d < R + 110);
    near.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.panoId.localeCompare(b.panoId));
    const cands: typeof near = [];
    for (const p of near) if (!cands.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 10)) cands.push(p);
    const views: HeldOutCandidateView[] = [], rejected: string[] = [];
    for (const p of cands) {
        let street = streetAt(p.x, p.z, context, terrain);
        if (!street) { if (p.d > R + 60) { rejected.push(`${p.panoId}: no ground under it`); continue; } street = { y: ymin, on: 'structure-base' }; }
        const eye: Vec3 = [p.x, street.y + 2.5, p.z];
        const eyeGround = street.on;
        let nx = cx, nz = cz, dn = Infinity;
        for (let i = 0; i < IV.length; i += 30) { const dd = Math.hypot(IV[i] - p.x, IV[i + 2] - p.z); if (dd < dn) { dn = dd; nx = IV[i]; nz = IV[i + 2]; } }
        const close = dn < 22;
        const headingDeg = Math.round(bearingDeg(p.x, p.z, close ? nx : cx, close ? nz : cz) * 10) / 10;
        const fovDeg = Math.round(close ? 80 : Math.max(50, Math.min(90, 2 * Math.atan((R * 0.9) / Math.max(1, p.d)) * 180 / Math.PI)));
        const mid = open ? openGroundY : ymin + 0.4 * (ymax - ymin);
        const pitchDeg = Math.round((close ? 12 : Math.max(-5, Math.min(30, Math.atan((mid - eye[1]) / p.d) * 180 / Math.PI))) * 10) / 10;
        const { screen, seen: share } = targetShares(structure.mesh, context, { eye, headingDeg, pitchDeg, fovDeg });
        if (screen < HELD_OUT_MIN_SCREEN || share < HELD_OUT_MIN_VISIBLE) { rejected.push(`${p.panoId}: ${p.d.toFixed(0)} m, fills ${(screen * 100).toFixed(0)}% of the frame, ${(share * 100).toFixed(0)}% of it unhidden`); continue; }
        views.push({
            panoId: p.panoId, ...(p.date ? { date: p.date } : {}), ...(p.copyright ? { copyright: p.copyright } : {}), eye, headingDeg, pitchDeg, fovDeg, aspectRatio: 'RATIO_4X3',
            distanceM: Math.round(p.d * 10) / 10, facadeHeadingDeg: (headingDeg + 180) % 360, score: share, close,
            visibleShare: Math.round(share * 100) / 100, screenShare: Math.round(screen * 100) / 100, eyeGround
        });
    }
    return { views, rejected };
}

/**
 * Candidate views of a place with no structure at it: the tile's surfaces within a radius of the frame origin stand in for
 * the structure, at the first of OPEN_PLACE_RADII_M where at least `want` views qualify, else at the radius where the most do.
 * Geometry alone decides: what stands and lies round the place, never what it is called or coded as.
 */
export function openPlaceViews(panos: PanoCandidate[], context: RenderMesh3D, terrain: { groundAt(x: number, z: number): number }, exclude: Set<string>, want: number): {
    views: HeldOutCandidateView[]; rejected: string[]; radiusM: number; triangles: number; tried: Array<{ radiusM: number; candidates: number }>;
} {
    const tried: Array<{ radiusM: number; candidates: number }> = [];
    let best: { views: HeldOutCandidateView[]; rejected: string[]; radiusM: number; triangles: number } | undefined;
    for (const radiusM of OPEN_PLACE_RADII_M) {
        const disc = surfacesWithin(context, 0, 0, radiusM);
        const r = disc.indices.length ? heldOutViews(panos, openPlace(disc, terrain, radiusM), context, exclude, terrain) : { views: [], rejected: [`no surface of the tile within ${radiusM} m of the place`] };
        tried.push({ radiusM, candidates: r.views.length });
        if (!best || r.views.length > best.views.length) best = { ...r, radiusM, triangles: disc.indices.length / 3 };
        if (r.views.length >= want) break;
    }
    return { ...best!, tried };
}

/** A fixed held-out view as asked for (`poses`): where it looks from and along which direction. */
export interface FixedPoseSpec { pose: number; label?: string; at: { lat: number; lng: number } | { panoId: string }; headingDeg: number; pitchDeg: number; fovDeg: number }

/** What became of a fixed pose: judged, or why it dropped out (heldOut.fixed). */
export interface FixedPoseOutcome {
    pose: number;
    label?: string;
    requested: FixedPoseSpec['at'];
    headingDeg: number; pitchDeg: number; fovDeg: number;
    status: 'judged' | 'no-pano' | 'used-by-build' | 'no-ground' | 'duplicate' | 'not-fetched' | 'not-registered';
    reason?: string;
    panoId?: string;
    date?: string;
    /** From the position asked for to the pano used (a lat/lng pose). */
    panoDistanceM?: number;
    eyeGround?: HeldOutEyeGround;
    /** The automatic views' target in this view, measured as they measure it (reported, never a gate): its share of the frame, and the share of it unhidden. */
    targetScreenShare?: number;
    targetVisibleShare?: number;
    edgeResidualPx?: { prior: number | null; edge: number | null };
    viewId?: string;
}

function parsePoses(raw: unknown): FixedPoseSpec[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new PhotoMatchError('bad_arguments', 'poses must be an array of { lat, lng (or panoId), headingDeg, pitchDeg?, fovDeg? }.');
    if (raw.length > PHOTO_MATCH_MAX_VIEWS) throw new PhotoMatchError('bad_arguments', `at most ${PHOTO_MATCH_MAX_VIEWS} poses (each is one view).`);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return raw.map((p: Record<string, unknown> | undefined, k) => {
        const pose = k + 1;
        const bad = (m: string) => new PhotoMatchError('bad_arguments', `pose ${pose}: ${m}`);
        const headingDeg = num(p?.headingDeg);
        if (headingDeg === undefined) throw bad('headingDeg (degrees clockwise from north) is required.');
        const panoId = typeof p?.panoId === 'string' && p.panoId.trim() ? p.panoId.trim() : undefined;
        const lat = num(p?.lat), lng = num(p?.lng);
        if (!panoId && (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw bad('give lat and lng, or panoId.');
        const pitchDeg = num(p?.pitchDeg) ?? 0, fovDeg = num(p?.fovDeg) ?? FIXED_POSE_DEFAULT_FOV;
        if (Math.abs(pitchDeg) > 90) throw bad('pitchDeg must lie within -90 to 90.');
        if (fovDeg < 10 || fovDeg > 90) throw bad('fovDeg must lie within 10 to 90 (the grounding API serves at most 90).');
        const label = typeof p?.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 60) : undefined;
        return { pose, ...(label ? { label } : {}), at: panoId ? { panoId } : { lat: lat!, lng: lng! }, headingDeg: ((headingDeg % 360) + 360) % 360, pitchDeg, fovDeg };
    });
}

/**
 * The views of the fixed poses: each looks from the nearest Google-captured pano within FIXED_POSE_MAX_PANO_M of its position (or
 * from the pano named), its eye 2.5 m over the street there, along the heading asked for. A pano any build used is refused, as is
 * a pose with no pano near enough, no ground under it, or the very view of an earlier pose. The views that remain are fetched and
 * registered with the automatic ones; `views` maps each to its outcome, which the caller completes.
 */
async function fixedPoseViews(specs: FixedPoseSpec[], input: {
    origin: GeodeticOrigin; cacheDir: string; posePanos: NonNullable<PhotoMatchDeps['posePanos']>; signal?: AbortSignal;
    context: RenderMesh3D; terrain: { groundAt(x: number, z: number): number }; used: Set<string>;
    /** What the automatic views look at: distances are measured from its centre, and its share of each view is reported when it has a mesh. */
    centre: { x: number; z: number }; target?: RenderMesh3D;
}): Promise<{ outcomes: FixedPoseOutcome[]; views: Map<SelectedView, FixedPoseOutcome> }> {
    const outcomes: FixedPoseOutcome[] = [];
    const views = new Map<SelectedView, FixedPoseOutcome>();
    const ids = new Set<string>();
    for (const s of specs) {
        stopIfAborted(input.signal);
        const o: FixedPoseOutcome = { pose: s.pose, ...(s.label ? { label: s.label } : {}), requested: s.at, headingDeg: s.headingDeg, pitchDeg: s.pitchDeg, fovDeg: s.fovDeg, status: 'no-pano' };
        outcomes.push(o);
        const named = 'panoId' in s.at ? s.at.panoId : undefined;
        const point = 'lat' in s.at ? geodeticToScan(input.origin, s.at.lat, s.at.lng) : undefined;
        const found = await input.posePanos(input.origin, point ?? { panoId: named! }, input.cacheDir, input.signal);
        let pano: PanoCandidate | undefined, dist = 0;
        if (point) {
            for (const p of found.panos) { const d = Math.hypot(p.x - point.x, p.z - point.z); if (!pano || d < dist) { pano = p; dist = d; } }
            if (pano && dist > FIXED_POSE_MAX_PANO_M) { o.reason = `the nearest Google-captured pano found (${pano.panoId}) stands ${dist.toFixed(1)} m from the position, past ${FIXED_POSE_MAX_PANO_M} m`; continue; }
        } else {
            pano = found.panos.find(p => p.panoId === named);
        }
        if (!pano) { o.reason = found.reason ?? (point ? `no Google-captured pano within ${FIXED_POSE_MAX_PANO_M} m of the position` : 'the pano named was not found'); continue; }
        o.panoId = pano.panoId;
        if (pano.date) o.date = pano.date;
        if (point) o.panoDistanceM = r2(dist);
        if (input.used.has(pano.panoId)) { o.status = 'used-by-build'; o.reason = `pano ${pano.panoId} was used by a build, so it cannot be held out`; continue; }
        const street = streetAt(pano.x, pano.z, input.context, input.terrain);
        if (!street) { o.status = 'no-ground'; o.reason = `no ground under pano ${pano.panoId}: it stands off the reference tile`; continue; }
        o.eyeGround = street.on;
        const view: SelectedView = {
            panoId: pano.panoId, ...(pano.date ? { date: pano.date } : {}), ...(pano.copyright ? { copyright: pano.copyright } : {}),
            eye: [pano.x, street.y + 2.5, pano.z], headingDeg: s.headingDeg, pitchDeg: s.pitchDeg, fovDeg: s.fovDeg, aspectRatio: 'RATIO_4X3',
            distanceM: Math.round(Math.hypot(pano.x - input.centre.x, pano.z - input.centre.z) * 10) / 10, facadeHeadingDeg: (s.headingDeg + 180) % 360, score: 0
        };
        const id = evidenceImageId(view);
        if (ids.has(id)) { o.status = 'duplicate'; o.reason = `the same view as an earlier pose (pano ${pano.panoId}, heading ${s.headingDeg})`; continue; }
        ids.add(id);
        if (input.target) {
            const sh = targetShares(input.target, input.context, view);
            o.targetScreenShare = r2(sh.screen);
            o.targetVisibleShare = r2(sh.seen);
            view.score = sh.seen;
        }
        o.status = 'not-fetched';
        views.set(view, o);
    }
    return { outcomes, views };
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
    /** A fixed pose's view (`poses`): which pose, as numbered from 1 in the order given. */
    fixed?: { pose: number; label?: string };
    distanceM: number;
    headingDeg: number;
    pitchDeg: number;
    fovDeg: number;
    size: [number, number];
    edgeResidualPx: { prior: number | null; edge: number | null };
    maskPixels: number;
    grid: string;
    renders: Record<string, string>;
    judge?: {
        stats: Record<string, Record<JudgeCriterion, CriterionStat>>; notes: Record<string, string[]>; model: string;
        /** With judgeRegions: the place around the building, per arm. */
        regionStats?: Record<string, Record<JudgeRegionCriterion, CriterionStat>>;
    };
    judgeError?: string;
    /**
     * The regions of this view, from what each pixel's ray hits in the reference tile (the measured scan, labelled by geometry):
     * pixels per label and in the skyline band (photo resolution), the masks drawn over the photo, and per arm the secondary
     * numbers in every region with how far the arm's own labels agree with the reference's.
     */
    regions?: {
        pixels: RegionMasks['pixels']; bandPx: number; masks: string; maskGrid: string;
        arms: Record<string, Record<PhotoMatchRegion, RegionScore>>;
    };
    /** The clay arm: each arm's untextured render from this pose, its grid, and the shape-only judgement. */
    clayRenders?: Record<string, string>;
    clayGrid?: string;
    clayJudge?: { stats: Record<string, { shape: CriterionStat }>; notes: Record<string, string[]>; model: string };
    clayJudgeError?: string;
    pixel: Record<string, PerceptualScores>;
    /** Per arm with a trees layer: trees drawn at each level from this pose, and triangles drawn against every level's. */
    trees?: Record<string, { atLevel: number[]; drawnTriangles: number; allLevelTriangles: number }>;
    /**
     * Where the reference tile ends inside the frame (tileEdgeInFrame), read before any score: flagged, the view's regions are
     * not judged and it is left out of every region mean (its building is judged as before).
     */
    tileEdge?: TileEdgeReading;
    /** The region criteria the judge was asked here: those the frame holds enough of, none when tileEdge is flagged. */
    judgedRegions?: JudgeRegionCriterion[];
    /** The region criteria not asked here, and why. */
    regionsLeftOut?: Partial<Record<JudgeRegionCriterion, string>>;
    /** Per arm, where its target is drawn against where the photo shows it, from edges (targetPlacement); null with no outline. */
    placement?: Record<string, TargetPlacement | null>;
}

const DEFAULT_RUN_CONCURRENCY = 2;
const yieldLoop = () => new Promise<void>(r => setImmediate(r));
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number | null) => (v === null ? '-' : v.toFixed(2));

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
    const poses = parsePoses(args.poses);
    if (poses.length && !deps.posePanos) throw new PhotoMatchError('street_view_unavailable', 'fixed poses need a pano lookup (posePanos), and none is configured here.');
    // fixed poses count toward the views, which are never fewer than they
    const askedViews = intArg(args.views, PHOTO_MATCH_DEFAULT_VIEWS, 1, PHOTO_MATCH_MAX_VIEWS);
    const nViews = Math.max(askedViews, poses.length);
    const nRuns = intArg(args.runs, PHOTO_MATCH_DEFAULT_RUNS, 1, PHOTO_MATCH_MAX_RUNS);
    const wantContext = args.inContext !== false;
    const wantClay = args.clay !== false;
    const wantTrees = args.trees !== false;
    const wantRegionJudge = args.judgeRegions === true;
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
            // two extractions at one place share the frame up to their origin heights
            const dy = r.origin.heightMeters - ref.origin.heightMeters;
            arms.push({
                id: spec.id, label: spec.label, glbs: layers.glbs, runId: spec.runId, scope: spec.scope ?? (rec.request?.isolate ? 'target' : 'place'),
                ...(layers.layers ? { layers: layers.layers } : {}), ...(Math.abs(dy) > 1e-3 ? { dy } : {})
            });
        } else {
            arms.push({ id: spec.id, label: spec.label, glbs: spec.glbs!.map(g => builds.file(g, `arm ${spec.id} GLB`)), scope: spec.scope ?? 'target' });
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
    if (withBaseline) arms.unshift({ id: 'raw', label: 'RAW SCAN', glbs: [ref.tileTextured], baseline: true, scope: 'target' });
    stopIfAborted(signal);

    // ---------------- the reference tile, its terrain and the target ----------------
    // The reference is the measured tile, whole. Its terrain is the ground model of the tile's geometry; the target is the
    // isolate (every tile triangle on its surface) or, when the build isolated nothing, the structure the app's structure rule picks
    // at the frame origin (the place); the crowns are the ones the run's tree strip measured.
    progress('measuring the reference tile: its terrain and the target at the place', 0.01);
    const scan = loadScanMesh(ref.tileGeometry);
    const contextMesh = scan.mesh;
    const terrain = buildGroundModel(scan, { cellMeters: 1 });
    const pick = ref.isolate ? undefined : pickStructure(scan, terrain, { anchor: { x: 0, z: 0 }, ...(ref.footprints ? { footprints: { buildingAt: ref.footprints.buildingAt, buildings: ref.footprints.raster.buildings } } : {}) });
    const targetAt = pick ? (x: number, z: number) => { const c = terrain.cellIndex(x, z); return c >= 0 && pick.footprintMask[c] === PICK_STRUCTURE; } : undefined;

    // ---------------- held-out views ----------------
    // what the views look at: the isolate, else the structure picked at the place; with no structure at the place, the first
    // build's layers without its trees (a trees GLB holds every level) when that build stands in for the target, else the place
    // itself (a whole-place build reaches far past it: a district's terrain runs for kilometres, and no view would qualify)
    const firstBuild = arms.find(a => !a.baseline)!;
    const fetchCount = Math.min(12, Math.max(4, nViews * 2));
    const viewRule = ref.isolate ? 'isolate' : pick ? 'picked-structure' : firstBuild.scope === 'target' ? 'first-build' : 'open-place';
    const structure = viewRule === 'open-place' ? undefined : structureOf(
        viewRule === 'isolate' ? sceneToRenderMesh(readGlbScene(ref.isolate!))
            : viewRule === 'picked-structure' ? standingIn(scan.mesh, terrain, targetAt!)
                : sceneToRenderMesh(firstBuild.glbs.filter(f => !isTreesLodJson(glbJson(f))).flatMap(f => readGlbScene(f))));
    const near = structure ? 'the structure' : 'the place';
    progress(`finding Street View panos near ${near} that the build never used`, 0.02);
    const centre = structure ? { x: structure.cx, z: structure.cz } : { x: 0, z: 0 };
    const panos = await deps.discover(ref.origin, centre, builds.cache.dir, signal);
    stopIfAborted(signal);
    // the fixed poses first: the automatic views never repeat a pano one of them looks from
    if (poses.length) progress(`finding the panos of ${poses.length} fixed pose${poses.length === 1 ? '' : 's'}`, 0.03);
    const fixed = poses.length ? await fixedPoseViews(poses, {
        origin: ref.origin, cacheDir: builds.cache.dir, posePanos: deps.posePanos!, ...(signal ? { signal } : {}), context: contextMesh, terrain, used: builds.used,
        centre, ...(structure ? { target: structure.mesh } : {})
    }) : undefined;
    const fixedReady = fixed ? [...fixed.views.keys()] : [];
    const autoExclude = fixedReady.length ? new Set([...builds.used, ...fixedReady.map(v => v.panoId)]) : builds.used;
    const open = structure ? undefined : openPlaceViews(panos, contextMesh, terrain, autoExclude, fetchCount);
    const { views: candidates, rejected } = open ?? heldOutViews(panos, structure!, contextMesh, autoExclude, terrain);
    const viewTarget = {
        rule: viewRule,
        source: viewRule === 'isolate' ? 'the isolate (the scan the build isolated)'
            : viewRule === 'picked-structure' ? 'the structure the app\'s structure rule picks at the frame origin, standing on the terrain'
                : viewRule === 'first-build' ? `the first build's layers (${firstBuild.id}, which stands in for the target): no structure stands within ${STRUCTURE_SEED_SEARCH_M} m of the place`
                    : `the place itself: no structure stands within ${STRUCTURE_SEED_SEARCH_M} m of it, so every surface of the reference tile within ${open!.radiusM} m of the frame origin (cut at that circle) stands in for one, each view aimed at its centre; the radius is the first of ${OPEN_PLACE_RADII_M.join(', ')} m at which ${fetchCount} views qualify, else the one where the most do`,
        ...(open ? { radiusM: open.radiusM, triangles: open.triangles, tried: open.tried } : {})
    };
    const unusedNear = panos.filter(p => !builds.used.has(p.panoId)).length;
    const fixedNote = fixed ? { fixed: fixed.outcomes } : {};
    if (!candidates.length && !fixedReady.length) {
        throw new PhotoMatchError('no_heldout_candidates', `No held-out view: of ${panos.length} Google panos near ${near}, ${panos.length - unusedNear} were used by the build and none of the other ${unusedNear} sees enough of it unhidden${fixed ? `, and none of the ${poses.length} fixed poses has a pano that can be held out` : ''}.`, { panosNear: panos.length, usedByBuild: builds.used.size, viewTarget, rejected: rejected.slice(0, 20), ...fixedNote });
    }
    // every fixed view, then the automatic ones to fill the fetch (they stand in for fixed views that do not register)
    const toFetch: SelectedView[] = [...fixedReady, ...spreadViews(candidates, Math.max(0, fetchCount - fixedReady.length))];
    progress(`fetching ${toFetch.length} held-out Street View images through the grounding API`, 0.08);
    const got = await fetchViews(toFetch, { grounding: deps.grounding() }, signal);
    stopIfAborted(signal);
    for (const f of got.failures) { const o = fixed?.views.get(f.view); if (o) o.reason = `the grounding API did not serve it: ${f.error}`; }
    for (const im of got.images) { const o = fixed?.views.get(im.view); if (o) o.status = 'not-registered'; }
    if (!got.images.length) {
        throw new PhotoMatchError('no_heldout_fetched', `None of the ${toFetch.length} held-out Street View images could be fetched: ${got.failures.slice(0, 4).map(f => `${f.view.panoId}: ${f.error}`).join('; ')}`, { failures: got.failures.map(f => ({ panoId: f.view.panoId, error: f.error })), ...fixedNote });
    }
    progress(`registering ${got.images.length} held-out images against the tile mesh by silhouette and edges`, 0.15);
    const regs = await deps.register(got.images.map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view })), [ref.tileGeometry], signal, m => progress(m));
    stopIfAborted(signal);
    // a view registers when its edge residual locks and its registered eye stands over the street (an eye under it sees the
    // street from below, whatever the edges say)
    const underStreet = new Map<SelectedView, string>();
    const locked = got.images.flatMap(im => {
        const o = regs.find(q => q.panoId === im.view.panoId);
        const before = o?.edgeResidualPx.prior ?? null, after = o?.edgeResidualPx.edge ?? null;
        const ok = !!o && !!o.correction && after !== null && after <= EDGE_MAX_RESIDUAL_PX && !(before !== null && after >= before);
        if (!ok) return [];
        const c = o!.correction!, v = im.view;
        const under = eyeUnderStreet([v.eye[0] + c.dx, v.eye[1] + c.dy, v.eye[2] + c.dz], contextMesh, terrain);
        if (under) {
            underStreet.set(v, `the registered eye stands ${under.depthM.toFixed(2)} m under the street (${under.streetY.toFixed(2)} m, from ${under.on}), so it sees the street from below: not used, whatever its edge residual`);
            return [];
        }
        return [{ im, reg: o! }];
    });
    const unregistered = got.images.filter(im => !locked.some(l => l.im === im)).map(im => {
        const o = regs.find(q => q.panoId === im.view.panoId);
        const fx = fixed?.views.get(im.view);
        const under = underStreet.get(im.view);
        if (fx) {
            const ep = o?.edgeResidualPx;
            if (ep) fx.edgeResidualPx = ep;
            fx.reason = under ?? `did not register against the tile mesh (an edge residual of at most ${EDGE_MAX_RESIDUAL_PX} px, lower than at the start, is needed${ep ? `; it went from ${fmt(ep.prior)} to ${fmt(ep.edge)} px` : ''}): ${o ? o.reason : 'not registered'}`;
        }
        return { panoId: im.view.panoId, edgeResidualPx: o?.edgeResidualPx ?? null, reason: under ?? (o ? o.reason : 'not registered'), ...(under ? { eyeUnderStreet: true } : {}), ...(fx ? { fixedPose: fx.pose } : {}) };
    });
    if (!locked.length) {
        const few = got.images.length < 2 ? ' Only one image came back, and the edge registration needs at least two.' : '';
        const under = underStreet.size ? ` ${underStreet.size} of them registered with the eye under the street.` : '';
        throw new PhotoMatchError('no_heldout_registered', `None of the ${got.images.length} held-out images registered against the tile mesh (an edge residual of at most ${EDGE_MAX_RESIDUAL_PX} px, lower than at the start, with the eye over the street), so no pose is trusted enough to judge from.${few}${under}`, { unregistered, ...fixedNote });
    }
    // the fixed views that registered, in the order asked, then the nearest automatic ones
    const isFixed = (l: { im: { view: SelectedView } }) => !!fixed?.views.has(l.im.view);
    const chosen = [...locked.filter(isFixed), ...locked.filter(l => !isFixed(l)).sort((a, b) => a.im.view.distanceM - b.im.view.distanceM)].slice(0, nViews);
    for (const c of chosen) {
        if (builds.used.has(c.im.view.panoId)) throw new PhotoMatchError('heldout_used_by_build', `pano ${c.im.view.panoId} was used by the build; it cannot be held out.`);
        const fx = fixed?.views.get(c.im.view);
        if (fx) { fx.status = 'judged'; fx.edgeResidualPx = c.reg.edgeResidualPx; delete fx.reason; }
    }

    // ---------------- regions: every triangle labelled by geometry ----------------
    progress('labelling the tile and every arm by geometry: terrain, the target, measured crowns, neighbours', 0.21);
    const full = readTileTriangles(fs.readFileSync(ref.tileTextured));
    const isolate = ref.isolate ? readTileTriangles(fs.readFileSync(ref.isolate)) : undefined;
    // the isolate's triangles in the tile: every tile triangle whose centroid lies on the isolate's surface (tile_refine cuts the
    // isolate's triangles at its outline, so they are not the tile's triangles one for one)
    const isoFlags = isolate ? onSurfaceFlags(full, isolate) : undefined;
    const crownFlags = ref.removedTrees ? nearTriangleFlags(full, readTileTriangles(fs.readFileSync(ref.removedTrees))) : undefined;
    const fullLabels = triangleRegions(full, terrain, (i, x, z) => (crownFlags?.[i] ? REGION.trees : (isoFlags ? isoFlags[i] : targetAt?.(x, z)) ? REGION.target : REGION.neighbours));
    // the target's triangles in the tile: the isolate's, else the picked structure's standing triangles
    const targetFlags = isoFlags ?? fullLabels.map(l => (l === REGION.target ? 1 : 0));
    const targetCount = targetFlags.reduce((n, f) => n + f, 0);
    const hasTarget = targetCount > 0;
    // the target alone (the scan's): where the photo's silhouette of it is read for each arm's placement
    const targetTris = hasTarget ? selectTriangles(full, targetFlags) : undefined;
    const targetLabels = hasTarget ? fullLabels.filter((_, i) => targetFlags[i]) : undefined;

    // ---------------- arms, context ----------------
    progress(`loading ${arms.length} arms`, 0.22);
    const loaded = arms.map(a => {
        // the raw scan: the tile cut to the target (whole when there is none); any other GLB as written, a trees GLB (tree LOD
        // contract) kept for per-view level selection when trees are drawn
        const parts: ArmLayer[] = a.baseline
            ? [{ fixed: targetTris ?? full }]
            : a.glbs.map(g => loadArmLayer(fs.readFileSync(g), { treeLod: wantTrees }));
        if (a.dy) for (const l of parts) if (l.fixed) l.fixed = liftTriangles(l.fixed, a.dy);
        return {
            ...a, ...(a.baseline && hasTarget ? { label: 'RAW SCAN (CUT TO TARGET)' } : {}),
            parts, treeLayers: parts.filter(l => l.trees).length, triangles: parts.reduce((s, l) => s + armLayerTriangles(l), 0)
        };
    });
    for (const a of loaded) if (!a.triangles) throw new PhotoMatchError('no_build', `arm ${a.id} has no triangles${a.baseline && hasTarget ? ' on the target' : ''}.`);
    // labels: an arm that stands in for the target is the target where it stands; a whole place follows the target's footprint,
    // the picked structure's cells, else (an isolate as the target) the isolate's plan outline on the terrain grid
    const placeArms = loaded.filter(a => a.scope === 'place').length;
    const outline = isolate && placeArms ? planOutlineCells(isolate, terrain) : undefined;
    const outlineCells = outline ? outline.reduce((n, f) => n + f, 0) : 0;
    const placeAt = targetAt ?? (outline ? (x: number, z: number) => { const c = terrain.cellIndex(x, z); return c >= 0 && outline[c] === 1; } : undefined);
    const placeRule = (_i: number, x: number, z: number) => (placeAt?.(x, z) ? REGION.target : REGION.neighbours);
    const armLabels = loaded.map(a => a.parts.map(l => (l.trees ? REGION.trees
        : a.baseline ? (targetLabels ?? fullLabels)
            : triangleRegions(l.fixed!, terrain, a.scope === 'target' ? (hasTarget || isoFlags ? REGION.target : REGION.neighbours) : placeRule))));
    const targetArmsDrawTrees = loaded.some(a => a.scope === 'target' && a.treeLayers > 0);
    // each arm's triangles by label (a trees layer counted whole, every level)
    const armTriangles = Object.fromEntries(loaded.map((a, k) => {
        const n = { triangles: 0, target: 0, neighbours: 0, ground: 0, trees: 0 };
        a.parts.forEach((l, j) => {
            const lab = armLabels[k][j];
            if (typeof lab === 'number') { const c = armLayerTriangles(l); n.triangles += c; n.trees += c; return; }
            n.triangles += lab.length;
            for (const v of lab) { if (v === REGION.target) n.target++; else if (v === REGION.neighbours) n.neighbours++; else if (v === REGION.ground) n.ground++; else if (v === REGION.trees) n.trees++; }
        });
        return [a.id, n];
    }));
    const regionsNote = {
        method: `every triangle labelled from geometry alone, then each pixel by the surface its ray hits (z-buffer, the most common label of its samples; no hit is sky). Ground: no vertex more than ${PHOTO_MATCH_GROUND_BAND_M} m above the terrain under it (off the terrain: facing within 60 degrees of up). ` +
            'Standing geometry is the target, a measured crown or a neighbour. The masks are the reference tile\'s (the measured scan, whole), the same for every arm; the skyline band is every pixel near where standing geometry meets the sky. Colour and brightness decide nothing.',
        terrain: { source: 'the reference tile\'s geometry', method: terrain.terrainMethod, cellM: terrain.cellMeters },
        target: isoFlags
            ? {
                source: `the isolate (the scan the build isolated): every tile triangle whose centroid lies on its surface, within ${PHOTO_MATCH_ISOLATE_SURFACE_M * 100} cm`,
                triangles: targetCount, isolateTriangles: isolate!.texture.length,
                // how much of the isolate the target covers: the share of its area within the tolerance of the tile triangles labelled
                // target (an isolate cut from another scan than the reference, a raw extraction against a welded one, covers only part)
                matchedShare: r3(surfaceCoverShare(isolate!, full, isoFlags)),
                // the earlier count, for comparison: tile triangles whose centroid is an isolate triangle's (within 1 cm), over the
                // isolate's triangles; cut triangles never match it
                matchedShareByTriangles: r3(nearTriangleFlags(full, isolate!).reduce((n, f) => n + f, 0) / Math.max(1, isolate!.texture.length))
            }
            : pick
                ? {
                    source: `the structure the app's structure rule picks at the frame origin (extraction-sizing pickStructure, ${pick.footprintSource === 'vector-footprint' ? 'within Google\'s building footprint the run read' : ref.footprints ? `on the scan geometry: Google's footprint was not used (${pick.vectorFootprint?.reason ?? 'no reason given'})` : 'on the scan geometry alone: no building footprints are recorded for this build'})`,
                    triangles: targetCount, areaM2: Math.round(pick.areaM2), heightM: r2(pick.heightM), geocodeToStructureM: r2(pick.geocodeToStructureM), footprintSource: pick.footprintSource
                }
                : { source: 'none', reason: 'the build isolated no structure and no structure stands within the pick\'s search window of the frame origin, so the building mask is empty and every standing triangle is a neighbour' },
        arms: 'an arm that stands in for the target (scope target) is the target wherever it stands; a whole place (scope place) is labelled by the target\'s footprint, like the tile'
            + (outline ? ': with the isolate as the target, its plan outline (placeOutline)' : ''),
        ...(outline ? {
            placeOutline: {
                source: 'the isolate\'s plan outline on the terrain grid, from geometry alone',
                method: `every ${terrain.cellMeters} m cell whose centre lies within ${PHOTO_MATCH_OUTLINE_REACH_M} m in plan of one of the isolate's standing triangles (a roof by its area, a wall by its foot line), and every cell those enclose (a courtyard, a gap in the roof); a whole place's standing triangle is the target when its centroid falls in such a cell, else a neighbour, so a wall rebuilt up to half a metre outside the scanned one stays the target, and a neighbour's face within about a metre of the target's counts as the target`,
                cells: outlineCells, areaM2: Math.round(outlineCells * terrain.cellMeters * terrain.cellMeters), reachM: PHOTO_MATCH_OUTLINE_REACH_M
            }
        } : {}),
        armTriangles,
        trees: crownFlags ? 'the scanned crowns the run\'s tree strip measured (removed_trees.glb), and every regrown trees layer' : 'only regrown trees layers: the run records no tree strip, so scanned crowns count as neighbours'
    };
    let context: TileTriangles[] | undefined;
    let contextLabels: Uint8Array | undefined;
    let contextNote: string;
    const targetSource = isoFlags ? 'the isolate' : 'the structure picked at the place';
    if (wantContext && hasTarget && placeArms < loaded.length) {
        // the regrown trees replace the scanned ones the strip measured: those leave the street too, or the photo's trees stand twice
        const cutTrees = targetArmsDrawTrees && !!crownFlags;
        const keepFlags = targetFlags.map((f, i) => (!f && !(cutTrees && crownFlags![i]) ? 1 : 0));
        const cut = selectTriangles(full, keepFlags);
        contextLabels = fullLabels.filter((_, i) => keepFlags[i]);
        const treesCut = cutTrees ? targetFlags.reduce((n, f, i) => n + (!f && crownFlags![i] ? 1 : 0), 0) : 0;
        context = [cut];
        contextNote = `in context: every arm that stands in for the target drawn in the photo-textured tile with the target's own ${targetCount} triangles (${targetSource}) cut out${treesCut ? ` and the ${treesCut} triangles of the scanned trees the regrown trees replace` : ''} (${cut.texture.length} kept), the same street for every such arm`
            + (targetArmsDrawTrees && !ref.removedTrees ? '; the scanned trees stay in the street (the run records no strip to cut them by)' : '')
            + (placeArms ? `; ${placeArms} arm${placeArms === 1 ? ' is' : 's are'} the whole place, drawn on its own` : '');
    } else {
        contextNote = placeArms === loaded.length
            ? 'whole places: every arm is the whole place, drawn on its own'
            : wantContext
                ? `not in context: no target was found to cut out of the tile; each arm is drawn alone${placeArms ? ' (a whole place with nothing hiding it, any other' : ' (each'} with the tile mesh hiding what stands in front)`
                : `not in context (inContext false): each arm that stands in for the target drawn alone on grey, the tile mesh hiding what stands in front${placeArms ? '; a whole place drawn on its own' : ''}`;
    }
    // what hides an arm drawn alone that stands in for the target: the tile (a whole place hides itself)
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
        /** The photo with the reference's region masks drawn over it (the grids' second image). */
        maskOverlay?: { width: number; height: number; rgba: Uint8Array };
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
        const occluderDepth = occluder && placeArms < loaded.length ? renderFrameDepth(occluder, camera) : undefined;
        const renders: Array<{ id: string; label: string; r: ArmRender }> = [];
        // each arm as the viewport would draw it from this pose (one level per tree)
        const forView = loaded.map(a => armMeshesForView(a.parts, camera));
        const treeLevels: Record<string, { atLevel: number[]; drawnTriangles: number; allLevelTriangles: number }> = {};
        loaded.forEach((a, i) => {
            const t = forView[i].trees;
            if (t.length) treeLevels[a.id] = { atLevel: t.reduce((acc, x) => acc.map((n, k) => n + (x.atLevel[k] ?? 0)), new Array(Math.max(...t.map(x => x.atLevel.length))).fill(0)), drawnTriangles: t.reduce((n, x) => n + x.drawnTriangles, 0), allLevelTriangles: t.reduce((n, x) => n + x.allLevelTriangles, 0) };
        });
        // a trees layer of an arm from another extraction is lifted onto the reference frame as it is chosen
        forView.forEach((f, i) => { const dy = loaded[i].dy; if (dy) f.meshes = f.meshes.map((m, j) => (loaded[i].parts[j].trees ? liftTriangles(m, dy) : m)); });
        // an arm standing in for the target in its street (or behind the tile's occluders); a whole place on its own
        const drawn = (i: number) => (loaded[i].scope === 'place' ? {} : { ...(occluderDepth ? { occluderDepth } : {}), ...(context ? { context } : {}) });
        const regionsFor = (i: number) => ({ meshes: armLabels[i], ...(contextLabels && loaded[i].scope !== 'place' ? { context: [contextLabels] } : {}) });
        for (let i = 0; i < loaded.length; i++) {
            const a = loaded[i];
            renders.push({ id: a.id, label: a.label, r: renderTriangles(forView[i].meshes, camera, { ...drawn(i), regions: regionsFor(i) }) });
            await yieldLoop();
        }
        // the reference regions: the measured tile, whole, from the same pose
        const refLabels = renderTriangles([full], camera, { regions: { meshes: [fullLabels] } }).regions!;
        const masks = regionMasks(refLabels, img.width, img.height);
        // before any score: where the tile ends inside the frame, and the regions the frame holds enough of to be judged
        const tileEdge = tileEdgeInFrame(refLabels, camera, terrain);
        const inFrame = regionsInFrame(masks.pixels, img.width * img.height);
        const regionsLeftOut: Partial<Record<JudgeRegionCriterion, string>> = {};
        for (const c of JUDGE_REGION_CRITERIA) {
            if (!inFrame.includes(c)) regionsLeftOut[c] = `not in the frame (${(masks.pixels[c] / (img.width * img.height) * 100).toFixed(1)}% of it, under ${PHOTO_MATCH_REGION_MIN_SHARE * 100}%)`;
            else if (tileEdge.flagged) regionsLeftOut[c] = `the reference tile ends inside the frame (${(tileEdge.share * 100).toFixed(1)}% of it is sky past the tile's edge)`;
        }
        const judgedRegions = tileEdge.flagged ? [] : inFrame;
        // each arm's placement: drawn alone at the metric width from the registered pose, its outline set on the photo's
        // silhouette of the target (its edges along the scan's target outline from the same pose)
        const placement: Record<string, TargetPlacement | null> = {};
        if (targetTris) {
            const field = photoEdgeField(photo);
            const camW = castCamera({ eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, widthPx: field.w, heightPx: field.h, ...(reg.correction ? { correction: reg.correction } : {}) });
            const degPerPx = (2 * Math.atan(field.w / (2 * camW.fx)) * 180) / Math.PI / field.w;
            const refW = renderTriangles([targetTris], camW, { supersample: 1, regions: { meshes: [targetLabels!] } }).regions!;
            for (let i = 0; i < loaded.length; i++) {
                const alone = renderTriangles(forView[i].meshes, camW, { supersample: 1, regions: { meshes: armLabels[i] } });
                placement[loaded[i].id] = targetPlacement(field, refW, alone.regions!, degPerPx);
                await yieldLoop();
            }
        }
        await yieldLoop();
        // the clay arm: the same pose, occluders and street, every arm (and its street) untextured
        const clayRenders: Array<{ id: string; label: string; r: ArmRender }> = [];
        if (wantClay) {
            for (let i = 0; i < loaded.length; i++) {
                const a = loaded[i];
                clayRenders.push({ id: a.id, label: a.label, r: renderTriangles(forView[i].meshes, camera, { clay: true, ...drawn(i) }) });
                await yieldLoop();
            }
        }
        const mask = coverageMask(renders.find(x => x.id === maskArm)!.r);
        const pixel: Record<string, PerceptualScores> = {};
        const files: Record<string, string> = {};
        const viewId = `v${k}_${v.panoId.slice(0, 6).replace(/[^A-Za-z0-9_-]/g, '_')}`;
        const fx = fixed?.views.get(v);
        if (fx) fx.viewId = viewId;
        const regionArms: Record<string, Record<PhotoMatchRegion, RegionScore>> = {};
        for (const x of renders) {
            pixel[x.id] = perceptualScores(photo, x.r, mask);
            regionArms[x.id] = regionScores(photo, x.r, masks, refLabels);
            files[x.id] = path.join(outDir, `${viewId}_${x.id}.png`);
            fs.writeFileSync(files[x.id], renderPng(x.r));
            await yieldLoop();
        }
        // the masks over the photo, and each arm's own labels over its render
        const maskOverlay = regionOverlay(photo, refLabels, masks.masks.skyline);
        const maskFile = path.join(outDir, `${viewId}_masks.png`), maskGrid = path.join(outDir, `grid_${viewId}_masks.png`);
        fs.writeFileSync(maskFile, encodePng(maskOverlay.width, maskOverlay.height, maskOverlay.rgba, 4));
        const armMaskTiles = renders.map(x => ({
            image: regionOverlay(x.r, x.r.regions!, regionMasks(x.r.regions!, x.r.width, x.r.height).masks.skyline), label: `${x.label} LABELS`,
            sublabel: `AGREES ${fmt(regionArms[x.id].frame.agreement)}  SKYLINE ${fmt(regionArms[x.id].skyline.agreement)}`
        }));
        fs.writeFileSync(maskGrid, composeGrid([{ image: maskOverlay, label: PHOTO_MATCH_REGION_LEGEND[0], sublabel: PHOTO_MATCH_REGION_LEGEND[1] }, ...armMaskTiles], { tileWidth: 560, columns: Math.min(4, armMaskTiles.length + 1), title: `${ref.place} - ${viewId} - REGIONS FROM GEOMETRY` }));
        const clayFiles: Record<string, string> = {};
        for (const x of clayRenders) {
            clayFiles[x.id] = path.join(outDir, `${viewId}_${x.id}_clay.png`);
            fs.writeFileSync(clayFiles[x.id], renderPng(x.r));
        }
        prepared.push({
            view: {
                id: viewId, panoId: v.panoId, ...(v.date ? { date: v.date } : {}), ...(fx ? { fixed: { pose: fx.pose, ...(fx.label ? { label: fx.label } : {}) } } : {}),
                distanceM: v.distanceM, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg,
                size: [img.width, img.height], edgeResidualPx: reg.edgeResidualPx, maskPixels: mask.reduce((s, m) => s + m, 0), grid: path.join(outDir, `grid_${viewId}.png`), renders: files, pixel,
                ...(wantClay ? { clayRenders: clayFiles, clayGrid: path.join(outDir, `grid_${viewId}_clay.png`) } : {}),
                ...(Object.keys(treeLevels).length ? { trees: treeLevels } : {}),
                regions: { pixels: masks.pixels, bandPx: masks.bandPx, masks: maskFile, maskGrid, arms: regionArms },
                tileEdge, judgedRegions, ...(Object.keys(regionsLeftOut).length ? { regionsLeftOut } : {}), placement
            },
            photoBytes: im.bytes, mime: im.mimeType || 'image/jpeg', photo, renders, clayRenders, maskOverlay
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
            forView.forEach((f, i) => { const dy = loaded[i].dy; if (dy) f.meshes = f.meshes.map((m, j) => (loaded[i].parts[j].trees ? liftTriangles(m, dy) : m)); });
            const inStreet = (i: number) => (context && loaded[i].scope !== 'place' ? { context } : {});
            const renders: Array<{ id: string; label: string; r: ArmRender }> = [];
            for (let i = 0; i < loaded.length; i++) {
                renders.push({ id: loaded[i].id, label: loaded[i].label, r: renderTriangles(forView[i].meshes, cam, inStreet(i)) });
                await yieldLoop();
            }
            const clayRenders: Array<{ id: string; label: string; r: ArmRender }> = [];
            if (wantClay) for (let i = 0; i < loaded.length; i++) {
                clayRenders.push({ id: loaded[i].id, label: loaded[i].label, r: renderTriangles(forView[i].meshes, cam, { clay: true, ...inStreet(i) }) });
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
            // the place around the building only in the street views (a roof seen from above has no skyline), and there only the
            // regions the frame holds enough of, none where the tile ends inside the frame
            const regionsAsked = wantRegionJudge && !p.satellite;
            const asked = regionsAsked ? p.view.judgedRegions ?? [...JUDGE_REGION_CRITERIA] : [];
            const runs: JudgeRun[] = await judgeView({
                client: judge, place: ref!.place, photo: { bytes: p.photoBytes, mimeType: p.mime },
                renders: p.renders.map(x => ({ armId: x.id, png: renderPng(x.r) })), repeats: nRuns, seed: `${evalId}:${p.view.id}`, ...(regionsAsked ? { regions: asked } : {})
            });
            const notes: Record<string, string[]> = {};
            for (const run of runs) for (const [id, n] of Object.entries(run.notes)) (notes[id] ??= []).push(n);
            p.view.judge = {
                stats: aggregateRuns(runs, loaded.map(a => a.id)), notes, model: runs[runs.length - 1]?.model ?? '',
                ...(regionsAsked && asked.length ? { regionStats: aggregateCriteria(runs, loaded.map(a => a.id), asked) as Record<string, Record<JudgeRegionCriterion, CriterionStat>> } : {})
            };
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
        const photoTile = { image: p.photo, label: p.photoLabel ?? `REAL PHOTO ${Math.round(p.view.distanceM)} M`, sublabel: p.satellite ? `GSD ${(satellite.gsdMetresPerPixel as number).toFixed(3)} M/PX` : p.view.panoId.slice(0, 10) };
        const tiles = [photoTile, ...(p.maskOverlay ? [{ image: p.maskOverlay, label: PHOTO_MATCH_REGION_LEGEND[0], sublabel: PHOTO_MATCH_REGION_LEGEND[1] }] : []), ...p.renders.map(x => {
            const s = p.view.judge?.stats[x.id]?.overall;
            const ssim = p.view.pixel[x.id].ssim;
            return { image: x.r, label: x.label, sublabel: s ? `JUDGE ${s.mean.toFixed(1)} +- ${s.sd.toFixed(1)}  SSIM ${ssim ?? '-'}` : `NOT JUDGED  SSIM ${ssim ?? '-'}` };
        })];
        fs.writeFileSync(p.view.grid, composeGrid(tiles, { tileWidth: 560, columns: Math.min(4, tiles.length), title: `${ref.place} - ${p.view.id}${context ? ' - IN CONTEXT' : ''}` }));
        if (p.view.clayGrid) {
            const clayTiles = [photoTile, ...p.clayRenders.map(x => {
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

    // the regions: each arm's secondary numbers and label agreement per region, the mean over the views that have the region
    type RegionMean = { ssim: number | null; edgeChamferPx: number | null; colourDeltaE: number | null; agreement: number | null; views: number };
    const regionMean: Record<string, Record<PhotoMatchRegion, RegionMean>> = {};
    for (const a of loaded) {
        regionMean[a.id] = {} as Record<PhotoMatchRegion, RegionMean>;
        for (const reg of PHOTO_MATCH_REGIONS) {
            // the place round the building (not the frame or the building): only views that show the region and end inside the tile
            const around = reg !== 'frame' && reg !== 'building';
            const per = views.filter(x => !around || !x.tileEdge?.flagged).map(x => x.regions?.arms[a.id]?.[reg])
                .filter((x): x is RegionScore => !!x && x.share > 0 && (!around || x.share >= PHOTO_MATCH_REGION_MIN_SHARE));
            const m = (k: 'ssim' | 'edgeChamferPx' | 'colourDeltaE' | 'agreement') => {
                const v = per.map(x => x[k]).filter((x): x is number => typeof x === 'number');
                return v.length ? r3(v.reduce((t, x) => t + x, 0) / v.length) : null;
            };
            regionMean[a.id][reg] = { ssim: m('ssim'), edgeChamferPx: m('edgeChamferPx'), colourDeltaE: m('colourDeltaE'), agreement: m('agreement'), views: per.length };
        }
    }
    // the judge on the place around the building (judgeRegions), over the views it scored
    const regionJudged = scored.filter(p => p.view.judge?.regionStats);
    // each criterion over the views that judged it (a region out of the frame, or past the tile's edge, is never asked); no view: null
    const judgeRegionScores: Record<string, Record<JudgeRegionCriterion, ArmScore['overall'] & { views: number }>> = {};
    if (regionJudged.length) {
        for (const a of loaded) {
            judgeRegionScores[a.id] = {} as Record<JudgeRegionCriterion, ArmScore['overall'] & { views: number }>;
            for (const c of JUDGE_REGION_CRITERIA) {
                const per = regionJudged.map(p => p.view.judge!.regionStats![a.id]?.[c]).filter((x): x is CriterionStat => !!x && Number.isFinite(x.mean));
                const means = per.map(x => x.mean);
                const mean = means.length ? means.reduce((t, x) => t + x, 0) / means.length : NaN;
                judgeRegionScores[a.id][c] = {
                    mean: r2(mean), runSd: per.length ? r2(per.reduce((t, x) => t + x.sd, 0) / per.length) : NaN,
                    viewSd: per.length ? r2(Math.sqrt(means.reduce((t, x) => t + (x - mean) ** 2, 0) / means.length)) : NaN, min: means.length ? r2(Math.min(...means)) : NaN, max: means.length ? r2(Math.max(...means)) : NaN,
                    views: per.length
                };
            }
        }
    }
    // each arm's placement (targetPlacement) over the views where the target fills at least HELD_OUT_MIN_SCREEN of the frame
    const placementViews = views.filter(v => (v.regions?.pixels.target ?? 0) / Math.max(1, v.size[0] * v.size[1]) >= HELD_OUT_MIN_SCREEN);
    const placementMean: Record<string, { errorPx: number | null; errorDeg: number | null; views: number }> = {};
    for (const a of loaded) {
        const per = placementViews.map(v => v.placement?.[a.id]).filter((x): x is TargetPlacement => !!x);
        placementMean[a.id] = {
            errorPx: per.length ? r2(per.reduce((t, x) => t + x.errorPx, 0) / per.length) : null,
            errorDeg: per.length ? r3(per.reduce((t, x) => t + x.errorDeg, 0) / per.length) : null, views: per.length
        };
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
    const summary = summarize({ ref, loaded, scores, views, scored: scored.length, nRuns, judgeModelUse, contextNote: context ? (placeArms ? 'in context (whole places on their own)' : 'in context') : placeArms === loaded.length ? 'as whole places' : 'not in context', unregistered: unregistered.length, usedPanos: builds.used.size })
        + (wantClay ? clayLine(loaded, clayScores, clayScored.length, prepared.length) : '')
        + (wantRegionJudge ? regionJudgeLine(loaded, judgeRegionScores, regionJudged.length, scored.length) : '')
        + placementLine(loaded, placementMean, placementViews.length)
        + viewChecksLine(views, underStreet.size)
        + ` Region metrics (masks from geometry: whole frame, building, ground, neighbours, trees, skyline) per arm in pixelMetrics.regions and views[].regions; the masks are drawn in each grid${pick || isoFlags ? '' : '; no target was found, so the building mask is empty'}.`
        + (open ? ` No structure stands at the place, so the views look at the place itself: the tile's surfaces within ${open.radiusM} m of it (heldOut.viewTarget).` : '')
        + (fixed ? fixedPoseLine(fixed.outcomes) : '')
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
        trees: wantTrees ? (loaded.some(a => a.treeLayers > 0) ? 'regrown trees drawn one level per tree per view, as the viewport chooses it; scanned trees cut from the street' + (ref.removedTrees ? '' : ' (none recorded: they stay)') : 'no arm has a trees layer') : 'off: no trees layer drawn',
        arms: loaded.map(a => ({ id: a.id, label: a.label, scope: a.scope, triangles: a.triangles, glbs: a.glbs, ...(a.dy ? { liftedM: r3(a.dy) } : {}), ...(a.treeLayers ? { treeLayers: a.treeLayers } : {}), ...(a.runId ? { runId: a.runId } : {}), ...(a.layers ? { layers: a.layers } : {}), ...(a.baseline ? { baseline: true } : {}) })),
        scores,
        clay: wantClay,
        ...(wantClay ? { clayScores, clayJudged: clayScored.length, clayGrids: views.map(v => v.clayGrid).filter((g): g is string => !!g) } : {}),
        satelliteOrtho: satellite,
        pixelMetrics: {
            note: 'Secondary: inside the target mask (the raw scan\'s coverage when the baseline is on). They do not rank builds the way the judge does.', mean: pixelMean,
            regions: { note: 'The same numbers per region of the reference tile\'s masks (from geometry), plus agreement: the share of the region where the arm\'s own labels show what the reference shows. Mean over the views that have the region.', mean: regionMean }
        },
        regions: regionsNote,
        placement: {
            note: `Where each build's target is drawn against where the photo shows it, from edges, not by the judge. The photo's silhouette of the target is its structural edges within ${PHOTO_MATCH_PLACEMENT_BAND_PX} px of the scan's target outline from the registered pose (${PHOTO_MATCH_METRIC_WIDTH_PX} px wide); each build is drawn alone from the same pose. errorPx is the mean distance from that silhouette to the build's outline as drawn (truncated at ${PHOTO_MATCH_PLACEMENT_TRUNCATION_PX} px; errorDeg the angle): it grows with a move and with a wrong shape. Beside it, shiftPx is the image shift (within ${PHOTO_MATCH_PLACEMENT_SEARCH_PX} px) that brings the outline closest, and residualPx the error left there. Mean over the views where the target fills at least ${HELD_OUT_MIN_SCREEN * 100}% of the frame; per view in views[].placement.`,
            mean: placementMean, views: placementViews.length
        },
        viewChecks: {
            note: `Read before any score. A view whose registered eye stands under the street is not used (heldOut.unregistered, eyeUnderStreet). A region the judge scores is asked only where it holds at least ${PHOTO_MATCH_REGION_MIN_SHARE * 100}% of the frame (views[].judgedRegions, regionsLeftOut). A view where at least ${PHOTO_MATCH_TILE_EDGE_MIN_SHARE * 100}% of the frame is sky past the reference tile's edge (its ray leaves the tile lower than the tile stands within ${PHOTO_MATCH_TILE_EDGE_REACH_M} m of where it leaves) is flagged (views[].tileEdge): its regions are not judged and it is left out of the region means; its building is judged as before.`,
            eyeUnderStreet: underStreet.size,
            tileEdgeFlagged: views.filter(v => v.tileEdge?.flagged).map(v => v.id)
        },
        judgeRegions: wantRegionJudge,
        ...(wantRegionJudge ? { regionScores: judgeRegionScores, regionJudged: regionJudged.length } : {}),
        views: views.map(v => ({ ...v, renders: v.renders })),
        grids: views.map(v => v.grid),
        heldOut: {
            viewTarget,
            // every fixed pose: the pano it looked from and its view, or why it dropped out
            ...(fixed ? { fixed: fixed.outcomes, ...(nViews > askedViews ? { viewsRaisedTo: nViews } : {}) } : {}),
            panosNear: panos.length,
            usedByBuild: builds.used.size,
            usedPanoSources: builds.usedSources,
            candidates: candidates.length,
            notQualified: rejected.length,
            // where each candidate's eye stands, 2.5 m up: the reference tile's terrain, else the lowest surface within 1.5 m, else the structure's base
            eyeGround: candidates.reduce((n, v) => ({ ...n, [v.eyeGround]: (n[v.eyeGround] ?? 0) + 1 }), {} as Partial<Record<HeldOutEyeGround, number>>),
            fetched: got.images.length,
            fetchFailures: got.failures.map(f => ({ panoId: f.view.panoId, error: f.error })),
            registered: locked.length,
            unregistered,
            judged: scored.length
        },
        outDir,
        ms: now() - t0
    };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
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

/** The fixed poses' line of the summary: how many were judged, and why any dropped out. */
function fixedPoseLine(outcomes: FixedPoseOutcome[]): string {
    const judged = outcomes.filter(o => o.status === 'judged').length;
    const dropped = outcomes.filter(o => o.status !== 'judged');
    const name = (o: FixedPoseOutcome) => `pose ${o.pose}${o.label ? ` (${o.label})` : ''}`;
    return ` Fixed poses: ${judged} of ${outcomes.length} judged${dropped.length ? `; not used: ${dropped.map(o => `${name(o)}, ${o.status}`).join('; ')}` : ''} (heldOut.fixed).`;
}

/** The judge's region line of the summary (judgeRegions): ground, neighbours and skyline per arm, each over the views that judged it. */
function regionJudgeLine(loaded: Array<{ id: string; label: string }>, rs: Record<string, Record<JudgeRegionCriterion, ArmScore['overall'] & { views: number }>>, judged: number, views: number): string {
    if (!judged) return ` The place around the building (judgeRegions): no view was judged on it (none of the ${views} shows a region within the tile, or the judge returned none).`;
    const one = (s: ArmScore['overall'] & { views: number }) => (s.views ? `${s.mean.toFixed(1)} (${s.views})` : 'not judged');
    return ` The place around the building (${judged} of ${views} views; views per score in brackets): ${loaded.map(a => `${a.label} [${a.id}] ground ${one(rs[a.id].ground)}, neighbours ${one(rs[a.id].neighbours)}, skyline ${one(rs[a.id].skyline)}`).join('; ')}.`;
}

/** The placement line of the summary: each arm's mean placement error from edges. */
function placementLine(loaded: Array<{ id: string; label: string }>, pm: Record<string, { errorPx: number | null; errorDeg: number | null; views: number }>, views: number): string {
    if (!views) return ' Placement from edges: no view where the target fills enough of the frame.';
    return ` Placement from edges (${views} view${views === 1 ? '' : 's'}; px at the metric width, 0 = where the photo shows it): ${loaded.map(a => `${a.label} [${a.id}] ${pm[a.id].errorPx === null ? 'no outline' : `${pm[a.id].errorPx!.toFixed(1)} px (${pm[a.id].errorDeg!.toFixed(2)} deg)`}`).join('; ')}.`;
}

/** The view checks' line of the summary: eyes under the street, views where the tile ends inside the frame. */
function viewChecksLine(views: PhotoMatchViewResult[], underStreet: number): string {
    const edge = views.filter(v => v.tileEdge?.flagged);
    return (underStreet ? ` ${underStreet} registered view${underStreet === 1 ? '' : 's'} had the eye under the street and ${underStreet === 1 ? 'was' : 'were'} not used.` : '')
        + (edge.length ? ` The reference tile ends inside the frame in ${edge.map(v => v.id).join(', ')}: ${edge.length === 1 ? 'its' : 'their'} regions were not judged.` : '');
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
