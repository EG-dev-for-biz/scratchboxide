/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * google_3d_tiles_get_clay, when it remeshes: the staged location build behind the tool call.
 *
 * - `parseStagedLocationArgs` reads the call's arguments (and a retry's: `retryRunId` with `retryStage`, which rebuilds
 *   the recorded request and recomputes only the named stage).
 * - `createStagedLocationDeps` wires the orchestrator to the app's own services: the Places geocoder and the leaf
 *   crawler, tile_vegetation, tile_refine, the scan fitter when this build has it, Street View through the Maps Imagery
 *   Grounding API only, and the vision model (the staged default first, then the chat's own fallbacks).
 * - `runStagedLocationTool` runs it and returns what the model reads: the digest, then the summary (every degradation,
 *   the retry handle, the vision model that was tried, the labels on what is inferred), then the structured result and
 *   the final scene. A place that cannot be resolved or has no tile coverage fails the call; nothing else does.
 */

import { solarRoofFromBuildingShape } from './pipeline-e/solar-roof';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolHandlerOutcome, ToolResultPayload } from '../../gemini/tools/types';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import { STAGED_VISION_MODEL_DEFAULT } from '../../../common/spatial/staged-location-contracts';
import { GeminiClient } from '../../gemini/gemini-client';
import { createStreetViewGroundingImageService } from '../../spatial/StreetViewGroundingImageService';
import { Google3DTileBlockoutPipelineService, getGoogle3DTilesFullTexture } from '../../spatial/Google3DTileBlockoutPipelineService';
import { resolveMapsApiKey } from '../../../browser/generative-canvas/services/google-maps-service';
import { getTileRefineService } from '../tile-refine-service';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import { fetchVectorEvidence } from './vector-footprints';
import { fetchElevations } from './vector-first-paint';
import { getTileVegetationService } from '../tile-vegetation-service';
import { loadScanFit } from '../scan-fit-loader';
import { StageCache, stagedWorkspaceRoot } from './stage-cache';
import { genAiEnhanceClient } from './texture-enhance';
import { lightingCorrectionEnabled, lightingModels } from './texture-lighting';
import {
    STAGE_IDS, runStagedLocation, type StageId, type StagedExtraction, type StagedLocationDeps, type StagedLocationRequest, type ResolvedPlace
} from './orchestrator';

// ----------------------------------------------------------------------------------------------------------------
// what the model is told about the tool (the declaration's text lives here, beside the code that makes it true)
// ----------------------------------------------------------------------------------------------------------------

export const STAGED_CLAY_TOOL_DESCRIPTION =
    'Ingest a real-world place (coordinates or an address) as a studio grey clay 3D scene from Google Maps Photorealistic 3D Tiles at leaf LOD, ' +
    'built in stages that the user watches arrive in the viewport: the tiles as downloaded, the tiles remeshed (hidden shells culled, facades snapped to planes, ' +
    'cracks closed, photometric facade relief), and the trees measured in the photos regrown as SB-Veggie trees. With isolate (one building or structure) it also ' +
    'fits an architectural rebuild to the scan and reads facade detail from photographs. Every stage is a real result of that stage; each commits as it finishes, ' +
    'and a later failure never removes an earlier stage. Nothing is invented: when a stage fails it drops one rung to a simpler version of the same real data ' +
    '(photo-read detail becomes the flat fitted face; a failed rebuild becomes the remeshed scan; a failed remesh becomes the raw scan with its facades flattened; ' +
    'a tree that cannot regrow stays as scanned; a failed tree stage puts the scanned trees back, labelled as scanned). The result lists every degraded part with ' +
    'its reason, the provenance of what is shown (as-scanned, scan-flattened, remeshed, fitted, photo-corrected, photo-inferred, grown to the measured crown) and ' +
    'the vision model that was tried. Report the degraded parts to the user, and say plainly that detail labelled photo-inferred is read from photographs: an ' +
    'inference with a confidence, not a measurement. Only an unresolved place, or a place with no tile coverage, fails the call. A result that gives a ' +
    'retryRunId can be retried: call this tool again with retryRunId and retryStage (the stage the result names); the earlier stages come from cache and only ' +
    'that stage is recomputed. Returns the mounted scene, the structured result and the summary.';

export const STAGED_ISOLATE_DESCRIPTION =
    'Return only the structure at the anchor (its whole connected footprint and everything above it, never cut, with a small ground apron) instead of the ' +
    'whole district, and rebuild it: a fitted architectural model of the scan with continuous measured residuals, then facade detail read from tile photos and ' +
    'Street View images (up to 4 per building, Google captures only), labelled photo-inferred. The extraction is sized to the structure, so radiusMeters is ' +
    'ignored. Use it when the user asks for one building or object rather than an area.';

export const STAGED_RADIUS_DESCRIPTION =
    'Extraction radius in metres around the anchor for a district (default 250). The nearest 524 leaf tiles are kept; when the radius holds more, the result ' +
    'reports the smaller radius actually covered as extraction.radiusM (extraction.requestedRadiusM is what was asked) with a radius_truncated degradation, and ' +
    'the summary says so. A radius that selects more than 6000 leaf tiles fails. Ignored with isolate, whose extraction is sized to the structure ' +
    '(extraction.radiusM says how far it reached).';

export const STAGED_RETRY_RUN_DESCRIPTION =
    'Retry one stage of an earlier run: the retryRunId the last result gave (8 hex digits). The recorded request is rebuilt from the run, so the other ' +
    'arguments are ignored (pass the same query). Use it only for a degraded part the result marks as retryable.';

export const STAGED_PLACE_DESCRIPTION =
    'A place already resolved, copied exactly from a "Switch location" choice the user clicked: {lat, lng, formattedAddress, placeId?, alternatives?}. ' +
    'When given, the query is not looked up again and the build is made at these coordinates. Never invent it; leave it out otherwise.';

export const STAGED_RETRY_STAGE_DESCRIPTION =
    `The stage to recompute on a retry, one of: ${STAGE_IDS.join(', ')}. Earlier stages come from cache; this one bypasses its cache.`;

/** A run id is 8 hex digits (scene-stg-<runId>). */
const RUN_ID = /^[0-9a-f]{8}$/;

export interface ParsedStagedArgs {
    request: StagedLocationRequest;
    retry?: { runId: string; stage: StageId };
}

function asString(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

/** The `place` argument: finite coordinates and an address, else the call fails (it is never filled in). */
function parsePlaceArg(toolName: string, raw: unknown): ResolvedPlace | undefined {
    if (raw === undefined || raw === null) return undefined;
    const p = raw as Record<string, unknown>;
    const lat = Number(p?.lat), lng = Number(p?.lng);
    const formattedAddress = asString(p?.formattedAddress);
    if (typeof raw !== 'object' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !formattedAddress) {
        throw new MissingInputError(toolName, 'a place of {lat, lng, formattedAddress}', `got ${JSON.stringify(raw)}`);
    }
    const alternatives = Array.isArray(p.alternatives)
        ? p.alternatives.flatMap((a: any) => Number.isFinite(Number(a?.lat)) && Number.isFinite(Number(a?.lng)) && asString(a?.formattedAddress)
            ? [{ ...(asString(a.name) ? { name: asString(a.name) } : {}), formattedAddress: asString(a.formattedAddress), lat: Number(a.lat), lng: Number(a.lng), ...(asString(a.placeId) ? { placeId: asString(a.placeId) } : {}) }] : [])
        : [];
    return {
        lat, lng, formattedAddress,
        ...(asString(p.placeId) ? { placeId: asString(p.placeId) } : {}),
        ...(Number.isFinite(Number(p.elevation)) && p.elevation !== null && p.elevation !== '' ? { elevation: Number(p.elevation) } : {}),
        ...(alternatives.length ? { alternatives } : {})
    };
}

/**
 * The request a google_3d_tiles_get_clay call makes. On a retry the recorded request is rebuilt from the run record,
 * so the query and the other arguments are not required (and are ignored: a re-worded query could miss the geocode key
 * and rebuild everything).
 */
export function parseStagedLocationArgs(toolName: string, args: Record<string, unknown>): ParsedStagedArgs {
    const retryRunId = asString(args.retryRunId);
    const retryStage = asString(args.retryStage);
    let retry: ParsedStagedArgs['retry'];
    if (retryRunId || retryStage) {
        if (!RUN_ID.test(retryRunId)) throw new MissingInputError(toolName, 'a retryRunId of 8 hex digits', `got ${JSON.stringify(args.retryRunId)}; use the retryRunId the last result gave`);
        if (!STAGE_IDS.includes(retryStage as StageId)) throw new MissingInputError(toolName, `a retryStage of ${STAGE_IDS.join(', ')}`, `got ${JSON.stringify(args.retryStage)}`);
        retry = { runId: retryRunId, stage: retryStage as StageId };
    }
    const query = asString(args.query);
    if (!query && !retry) throw new MissingInputError(toolName, 'query', 'a place name, address or "lat, lng"');
    let treeTriangleBudget: number | undefined;
    if (args.treeTriangleBudget !== undefined && args.treeTriangleBudget !== null) {
        treeTriangleBudget = Number(args.treeTriangleBudget);
        if (!Number.isFinite(treeTriangleBudget) || treeTriangleBudget < 1) {
            throw new MissingInputError(toolName, 'a treeTriangleBudget of at least 1 triangle', `got ${JSON.stringify(args.treeTriangleBudget)}`);
        }
    }
    const place = parsePlaceArg(toolName, args.place);
    const radiusM = typeof args.radiusMeters === 'number' && args.radiusMeters > 0 ? args.radiusMeters : undefined;
    return {
        request: {
            query,
            isolate: args.isolate === true,
            ...(radiusM !== undefined ? { radiusM } : {}),
            trees: args.trees !== false,
            ...(treeTriangleBudget !== undefined ? { treeTriangleBudget } : {}),
            stageIntoActiveScene: args.stageIntoActiveScene === true,
            ...(typeof args.enhance === 'boolean' ? { enhance: args.enhance } : {}),
            ...(place ? { place } : {})
        },
        ...(retry ? { retry } : {})
    };
}

function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'place';
}

function stoppableFetch(signal: AbortSignal | undefined): typeof fetch | undefined {
    return signal ? (((input: any, init?: RequestInit) => fetch(input, { ...(init ?? {}), signal })) as typeof fetch) : undefined;
}

/** The orchestrator's dependencies wired to the app's own services. */
export async function createStagedLocationDeps(workspaceRoot: string, options: { signal?: AbortSignal } = {}): Promise<StagedLocationDeps> {
    const cache = new StageCache({ workspaceRoot });
    const gemini = new GeminiClient();
    const vegetation = getTileVegetationService(workspaceRoot);
    const canopy = (vegetation as unknown as { canopy?: (req: { tilePath: string; cellM?: number; signal?: AbortSignal }) => Promise<any> }).canopy;
    const fitter = await loadScanFit(workspaceRoot);

    let vision: StagedLocationDeps['vision'];
    try {
        const client = await gemini.getGenAIClient();
        if (!client) throw new Error('no Gemini credentials are configured (add a service account or an API key in Settings)');
        const candidates = [...new Set([STAGED_VISION_MODEL_DEFAULT.model, ...gemini.getModelCandidates()])];
        vision = { client: client as never, candidates };
    } catch (err) {
        vision = { unavailable: err instanceof Error ? err.message : String(err) };
    }

    return {
        cache,
        geocode: async (query, signal) => {
            const anchor = await new Google3DTileBlockoutPipelineService().resolveAddress(query, undefined, stoppableFetch(signal));
            return {
                lat: anchor.lat, lng: anchor.lng, formattedAddress: anchor.formattedAddress ?? `${anchor.lat.toFixed(6)}, ${anchor.lng.toFixed(6)}`,
                ...(anchor.elevation !== undefined ? { elevation: anchor.elevation } : {}),
                ...(anchor.alternatives?.length ? { alternatives: anchor.alternatives } : {})
            } satisfies ResolvedPlace;
        },
        extract: async req => {
            const textured = path.join(req.outDir, 'textured.glb');
            const geometry = path.join(req.outDir, 'geometry.glb');
            req.onProgress?.(`downloading the Google 3D Tiles within ${Math.round(req.radiusM)} m`);
            const r = await getGoogle3DTilesFullTexture({
                lat: req.lat, lng: req.lng, formattedAddress: req.place.formattedAddress, landmarkName: req.place.formattedAddress,
                ...(req.place.elevation !== undefined ? { elevation: req.place.elevation } : {})
            }, { radiusMeters: req.radiusM, outputDir: req.outDir, outputGlbPath: textured, geometryGlbPath: geometry, signal: req.signal });
            if (r.mock) throw new Error('the extraction returned placeholder tiles, not Google 3D Tiles');
            if (!r.geometryGlbPath || !r.frame || !r.leafIds || !r.copyrights || !r.fetchedAt || r.leafGeometricErrorM === undefined) {
                throw new Error('the extraction did not report its leaves, attribution and frame');
            }
            // the raw high-resolution extraction is kept for reuse (AGENTS.md: persist the raw mesh)
            const raw = cache.publishFile(r.glbPath, `${slug(req.place.formattedAddress)}_${req.lat.toFixed(5)}_${req.lng.toFixed(5)}_r${Math.round(req.radiusM)}_textured.glb`);
            return {
                texturedGlb: r.glbPath, geometryGlb: r.geometryGlbPath, rawGlbPath: raw.path,
                downloadOrder: r.downloadOrder, leafIds: r.leafIds, copyrights: r.copyrights, fetchedAt: r.fetchedAt,
                radiusM: req.radiusM, coveredRadiusM: r.coveredRadiusMeters ?? req.radiusM, truncated: !!r.truncated, leafTiles: r.leafTiles?.kept ?? r.leafIds.length,
                leafGeometricErrorM: r.leafGeometricErrorM, originEllipsoidalHeightM: r.frame.originEllipsoidalHeightM,
                geoAnchor: r.geoAnchor as StagedExtraction['geoAnchor']
            };
        },
        vegetation: {
            strip: req => vegetation.strip(req),
            plant: req => vegetation.plant(req),
            ...(typeof canopy === 'function' ? { canopy: (req: { tilePath: string; cellM?: number; signal?: AbortSignal }) => canopy.call(vegetation, req) } : {})
        },
        refine: getTileRefineService(workspaceRoot),
        // building footprints, water and roads from Google vector data (vectortiles.featuretiles, the service account)
        ...(gemini.ensureAuth()
            ? { vectorEvidence: (req: { lat: number; lng: number; radiusM: number }) => fetchVectorEvidence({ ...req, fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') }) }
            : {}),
        // terrain heights for the vector first paint's building bases (the Google Elevation API, the Maps key)
        ...(resolveMapsApiKey() ? { elevations: (points: Array<{ lat: number; lng: number }>, signal?: AbortSignal) => fetchElevations(points, resolveMapsApiKey(), { ...(signal ? { signal } : {}) }) } : {}),
        ...(fitter.service ? { scanFit: fitter.service } : { scanFitUnavailable: fitter.unavailable }),
        // Solar API roof facets (pipeline E's massing, SCRATCHBOX_STAGED_PIPELINE=e)
        ...(resolveMapsApiKey() ? { solarRoof: (lat: number, lng: number) => solarRoofFromBuildingShape(lat, lng, workspaceRoot, resolveMapsApiKey()) } : {}),
        streetView: {
            mapsApiKey: resolveMapsApiKey(),
            // Street View images come only through the Maps Imagery Grounding API, on the app's service account
            ...(gemini.ensureAuth()
                ? { grounding: createStreetViewGroundingImageService(gemini) }
                : { groundingUnavailable: 'no Google Cloud service account is configured for the Maps Imagery Grounding API' }),
            metadataCachePath: path.join(cache.dir, 'streetview', 'metadata.json')
        },
        vision,
        // the texture pass's optional enhancement rung: the image model edits the tile transfer, kept only past its edge
        // gate (SCRATCHBOX_TEXTURE_ENHANCE=0 turns the rung off); and the model lighting correction of the photos, detail-locked
        // (texture-lighting.ts; SCRATCHBOX_TEXTURE_LIGHTING=1 turns it on, SCRATCHBOX_TEXTURE_LIGHTING_MODELS picks the model)
        textures: 'client' in vision ? {
            ...(process.env.SCRATCHBOX_TEXTURE_ENHANCE !== '0' ? { enhance: genAiEnhanceClient(vision.client) } : {}),
            ...(lightingCorrectionEnabled() ? { lighting: genAiEnhanceClient(vision.client), lightingModels: lightingModels() } : {})
        } : {}
    };
}

/**
 * What the model reads, in this order, so a long result never truncates the part that matters: the digest (status,
 * degradations, retry handle), the summary, then the structured result, then the scene.
 */
export function stagedToolPayload(outcome: Awaited<ReturnType<typeof runStagedLocation>>): ToolResultPayload {
    const { result, compat } = outcome;
    const { artifact, digest, summary, success, status, ...rest } = result;
    return {
        success,
        status,
        digest,
        summary,
        mode: 'clay',
        resolvedAddress: compat.resolvedAddress,
        geoAnchor: compat.geoAnchor,
        glbPath: compat.glbPath,
        ...(compat.groundGlbPath ? { groundGlbPath: compat.groundGlbPath } : {}),
        remesh: compat.remesh,
        ...(compat.trees ? { trees: compat.trees } : {}),
        ...rest,
        artifact
    } as unknown as ToolResultPayload;
}

/** google_3d_tiles_get_clay when it remeshes: the staged build. `injected` replaces the real dependencies (tests). */
export async function runStagedLocationTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    injected?: StagedLocationDeps
): Promise<ToolHandlerOutcome> {
    const { request, retry } = parseStagedLocationArgs(toolName, args);
    const root = stagedWorkspaceRoot();
    // the caller's own copy of the raw extraction, where the extraction tools have always put it: the path as given when
    // absolute, else under public/models by its file name
    const wanted = typeof args.outputGlbPath === 'string' ? args.outputGlbPath.trim() : '';
    const copyTo = wanted ? (path.isAbsolute(wanted) ? wanted : path.resolve(root, 'public', 'models', path.basename(wanted))) : undefined;
    const deps = injected ?? await createStagedLocationDeps(root, { signal: ctx.signal });
    const outcome = await runStagedLocation(request, deps, {
        signal: ctx.signal,
        emitStage: ctx.emitStage,
        reportProgress: ctx.reportProgress,
        // the tool's remaining time, when the chat reports it (the computer-use plan adds the field); else the static budget
        ...(typeof (ctx as unknown as { remainingMs?: () => number }).remainingMs === 'function' ? { remainingMs: (ctx as unknown as { remainingMs: () => number }).remainingMs } : {}),
        activeArtifact: ctx.request?.activeArtifact,
        ...(retry ? { retry } : {})
    });
    if (copyTo && fs.existsSync(outcome.compat.glbPath)) {
        fs.mkdirSync(path.dirname(copyTo), { recursive: true });
        fs.copyFileSync(outcome.compat.glbPath, copyTo);
    }
    return { resultPayload: stagedToolPayload(outcome), summaryResult: outcome.result.digest };
}
