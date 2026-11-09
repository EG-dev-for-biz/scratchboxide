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

import { cacheMirrorBucket, mirrorCachesInBackground, restoreCacheEntry, restoreCacheFile } from '../../cloud-store/cache-mirror';
import { GcsCloudBucket } from '../../cloud-store/cloud-bucket';
import { cloudChunkConfig, CloudRunJobsRest, CloudRunServiceJobs, createCloudChunkRunner, HybridJobs, RoundRobinJobs, VmPoolJobs, type CloudRunJobs, type RunChunk } from './cloud-chunk-runner';
import { kdChunkRunner } from './pipeline-k/district-chunks';
import { TOGGLEABLE_STEPS } from '../../../common/staged-build-steps';
import { solarRoofFromBuildingShape } from './pipeline-e/solar-roof';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { MessageChannel, Worker } from 'worker_threads';
import { serveCallBudget } from '../../gemini/model-call-budget';
import { workerTsRegisterSource } from '../../worker-ts-register';
import { isClientDisconnect, stagedRunRegistry } from './staged-run-registry';
import type { CanvasArtifact } from '../../../browser/generative-canvas/canvas-types';
import type { ToolContext, ToolHandlerOutcome, ToolResultPayload } from '../../gemini/tools/types';
import { InvalidInputError, MissingInputError } from '../../../common/errors/pipeline-errors';
import { STAGED_VISION_MODEL_DEFAULT, type StageEvent } from '../../../common/spatial/staged-location-contracts';
import { GeminiClient } from '../../gemini/gemini-client';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';
import type { GroundedReferenceClient } from '../../spatial/search-grounded-reference';
import { createStreetViewGroundingImageService } from '../../spatial/StreetViewGroundingImageService';
import { Google3DTileBlockoutPipelineService, getGoogle3DTilesFullTexture, prefetchGoogle3DTileLeaves } from '../../spatial/Google3DTileBlockoutPipelineService';
import { resolveMapsApiKey } from '../../../browser/generative-canvas/services/google-maps-service';
import { GoogleElevationService } from '../../../browser/generative-canvas/services/google-elevation-service';
import { getTileRefineService } from '../tile-refine-service';
import { runTileSeamWeld } from '../tile-seam-weld-service';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import { fetchVectorEvidence } from './vector-footprints';
import { fetchElevations } from './vector-first-paint';
import { getTileVegetationService } from '../tile-vegetation-service';
import { loadScanFit } from '../scan-fit-loader';
import { createDefaultStationImageGenerator } from '../../spatial/BeautifyStationService';
import { createFalTrellisClient } from './pipeline-i/fal-trellis';
import { createFalMeshyClient } from './pipeline-i/fal-meshy';
import { resolveRegionSets } from './pipeline-k/material-sets';
import { StageCache, stagedWorkspaceRoot } from './stage-cache';
import { reportStagedSwitchProblems, RETIRED_PIPELINE_LETTERS, STAGED_DISTRICT_MODES, stagedBuildingPipelineEnv } from './staged-switches';
import { genAiEnhanceClient } from './texture-enhance';
import { lightingCorrectionEnabled, lightingModels } from './texture-lighting';
import { bakeTileDetail, defaultSwatchServices, subjectSwatchLibrary } from '../../spatial/tile-detail-bake';
import { MODEL_READINGS_DIR } from './pipeline-k/model-readings';
import {
    STAGE_IDS, runStagedLocation, StagedLocationHardFailure, type StageId, type StagedExtraction, type StagedLocationContext, type StagedLocationDeps,
    type StagedLocationOutcome, type StagedLocationRequest, type ResolvedPlace
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
    'whole district, and rebuild it: by default the real scan straightened with its own photo (pipeline K, see pipeline), with procedural true a procedural ' +
    'rebuild (see procedural and pipeline), or with procedural false a model of the scan on the vector ' +
    'massing with facade detail read from tile photos and Street View images (up to 4 per building, Google captures only), labelled photo-inferred. The ' +
    'extraction is sized to the structure, so radiusMeters is ignored. Use it when the user asks for one building or object rather than an area.';

export const STAGED_RADIUS_DESCRIPTION =
    'Extraction radius in metres around the anchor for a district (default 250). Every leaf tile whose plan footprint the radius touches is kept, at any height; when a cap keeps fewer, the result ' +
    'reports the smaller radius actually covered as extraction.radiusM (extraction.requestedRadiusM is what was asked) with a radius_truncated degradation, and ' +
    'the summary says so. A radius that selects more than 6000 leaf tiles fails. Ignored with isolate, whose extraction is sized to the structure ' +
    '(extraction.radiusM says how far it reached).';

export const STAGED_RETRY_RUN_DESCRIPTION =
    'Retry one stage of an earlier run: the retryRunId the last result gave (8 hex digits). The recorded request is rebuilt from the run, so the other ' +
    'arguments are ignored (pass the same query). Use it only for a degraded part the result marks as retryable.';

export const STAGED_RESUME_RUN_DESCRIPTION =
    'Resume an earlier run that stopped, failed or was interrupted: the runId of the scene\'s staged build (8 hex digits, scene-stg-<runId>). ' +
    'The recorded request is rebuilt from the run; stages whose results are cached are reused and the rest run again. The other arguments are ignored.';

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
    /** Resume: the recorded request again, nothing bypassed. */
    resume?: { runId: string };
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
    const resumeRunId = asString(args.resumeRunId);
    let resume: ParsedStagedArgs['resume'];
    if (resumeRunId) {
        if (!RUN_ID.test(resumeRunId)) throw new MissingInputError(toolName, 'a resumeRunId of 8 hex digits', `got ${JSON.stringify(args.resumeRunId)}; use the scene's staged runId`);
        if (retry) throw new MissingInputError(toolName, 'either resumeRunId or retryRunId', 'got both');
        resume = { runId: resumeRunId };
    }
    const query = asString(args.query);
    if (!query && !retry && !resume) throw new MissingInputError(toolName, 'query', 'a place name, address or "lat, lng"');
    let treeTriangleBudget: number | undefined;
    if (args.treeTriangleBudget !== undefined && args.treeTriangleBudget !== null) {
        treeTriangleBudget = Number(args.treeTriangleBudget);
        if (!Number.isFinite(treeTriangleBudget) || treeTriangleBudget < 1) {
            throw new MissingInputError(toolName, 'a treeTriangleBudget of at least 1 triangle', `got ${JSON.stringify(args.treeTriangleBudget)}`);
        }
    }
    const place = parsePlaceArg(toolName, args.place);
    // pipelines G and H were retired and I merged into J as its Trellis service (user decision 2026-10-30): a retired letter
    // is refused with what replaced it, and 'i' still runs what it ran, J with Trellis
    const rawPipeline = typeof args.pipeline === 'string' ? args.pipeline.trim().toLowerCase() : undefined;
    if (rawPipeline === 'g' || rawPipeline === 'h') throw new InvalidInputError(toolName, `pipeline "${rawPipeline}"`, `${RETIRED_PIPELINE_LETTERS[rawPipeline]}; ask for "j" (procedural) or "k"`);
    const asked = rawPipeline === 'i' ? 'j' : rawPipeline === 'j' || rawPipeline === 'k' ? rawPipeline : undefined;
    const modelService = args.modelService === 'meshy' || args.modelService === 'trellis' ? args.modelService : rawPipeline === 'i' ? 'trellis' : undefined;
    // how the district is shown (staged-switches.ts): 'kd' is K over the whole district and never isolates; the pipeline
    // 'kd' it once was still asks for it
    const rawDistrict = typeof args.district === 'string' && args.district.trim() ? args.district.trim().toLowerCase() : undefined;
    if (rawDistrict && !(STAGED_DISTRICT_MODES as readonly string[]).includes(rawDistrict)) throw new InvalidInputError(toolName, `district "${rawDistrict}"`, `a district is shown as ${STAGED_DISTRICT_MODES.join(', ')}`);
    const district = rawDistrict ?? (rawPipeline === 'kd' ? 'kd' : undefined);
    const isolate = args.isolate === true && district !== 'kd';
    // one building is pipeline K's, the scan straightened with its own photo, from the chat and the 3D Building button alike
    // (user decision 2026-10-26), unless the caller asks for a procedural rebuild (procedural true, pipeline 'j', or
    // SCRATCHBOX_STAGED_BUILDING_PIPELINE=j) or for the scan detailed (procedural false)
    const pipeline = asked ?? (isolate && args.procedural === undefined && stagedBuildingPipelineEnv() !== 'j' ? 'k' : undefined);
    const radiusM = typeof args.radiusMeters === 'number' && args.radiusMeters > 0 ? args.radiusMeters : undefined;
    // steps turned on or off for this build (the node graph's switches), by step key: unknown keys and non-booleans are dropped
    const steps = args.steps && typeof args.steps === 'object' && !Array.isArray(args.steps)
        ? Object.fromEntries(Object.entries(args.steps as Record<string, unknown>).filter((e): e is [string, boolean] => TOGGLEABLE_STEPS.has(e[0]) && typeof e[1] === 'boolean'))
        : undefined;
    return {
        request: {
            query,
            isolate,
            ...(radiusM !== undefined ? { radiusM } : {}),
            trees: args.trees !== false,
            ...(treeTriangleBudget !== undefined ? { treeTriangleBudget } : {}),
            stageIntoActiveScene: args.stageIntoActiveScene === true,
            ...(typeof args.enhance === 'boolean' ? { enhance: args.enhance } : {}),
            // a procedural rebuild when asked for (above); never for pipeline K or a scan asked to be detailed
            ...(isolate && args.procedural !== false && pipeline !== 'k' ? { procedural: true } : {}),
            // which pipeline ('j' procedural, pipeline-i/; 'k' the straightened scan, pipeline-k/pipeline-k.ts), and J's model
            // service when one is named (staged-switches.ts stagedModelService reads it, else the environment, else Meshy)
            ...(pipeline ? { pipeline } : {}),
            ...(modelService ? { modelService } : {}),
            ...(district ? { district } : {}),
            ...(steps ? { steps } : {}),
            ...(place ? { place } : {})
        },
        ...(retry ? { retry } : {}),
        ...(resume ? { resume } : {})
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
    // a stage this workspace lacks is read back from the cache mirror's bucket before it runs, and so is a model's answer
    // kept as one file (pipeline-k/model-readings.ts) before the model is asked (SCRATCHBOX_CACHE_RESTORE=off: never;
    // `readings`: the model's answers only, every stage built here: a build compared with another on the same answers)
    const restoreMode = process.env.SCRATCHBOX_CACHE_RESTORE?.trim();
    const mirror = restoreMode === 'off' ? undefined : cacheMirrorBucket();
    const readingsOnly = restoreMode === 'readings';
    const cache: StageCache = new StageCache({
        workspaceRoot,
        ...(mirror ? {
            ...(readingsOnly ? {} : { restore: (stage: string, key: string) => restoreCacheEntry(mirror, cache.workspaceRoot, `staged_location/${stage}/${key}`, { modelsDir: cache.modelsDir }) }),
            restoreFile: (rel: string) => (readingsOnly && !rel.startsWith(`${MODEL_READINGS_DIR}/`) ? Promise.resolve(false) : restoreCacheFile(mirror, cache.workspaceRoot, `staged_location/${rel}`))
        } : {})
    });
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

    // the ground around the place: the Google Elevation API on the Maps key (the app's elevation standard, EGM96 MSL)
    const mapsKey = resolveMapsApiKey();
    const elevationService = mapsKey ? new GoogleElevationService({ apiKey: mapsKey }) : undefined;
    return {
        cache,
        // pipeline I/J (J the 3D Building default): the image model draws the character sheet, then Meshy (J, default, one
        // seed) or Trellis (I, best of six seeds) on Fal.ai makes the model; made on first use, so a build without FAL_KEY
        // fails pipeline I/J with that reason
        pipelineI: { generator: () => createDefaultStationImageGenerator({ workspaceRoot: cache.dir }), model: (name?: string) => name === 'meshy' ? createFalMeshyClient() : createFalTrellisClient() },
        // pipeline K's material regions: a texture library set per appearance class, fetched from the library bucket
        // and the swatch detail bake (off unless asked): the building's survey swatches baked into the twin's atlases
        pipelineK: {
            materialSets: (classes, o) => resolveRegionSets(classes, o),
            detailBake: async i => {
                const services = await defaultSwatchServices(cache.dir);
                const library = await subjectSwatchLibrary({ tilesGlb: i.tilesGlb, lat: i.lat, lng: i.lng, place: i.place, workDir: i.workDir, services, log: i.progress, signal: i.signal });
                return bakeTileDetail({ glb: i.glb, libraryPath: library.libraryPath, ground: i.tilesGlb, workDir: path.join(i.workDir, 'bake'), log: i.progress });
            }
        },
        ...(elevationService ? {
            elevation: {
                sample: async (points: Array<{ lat: number; lng: number }>) => {
                    const results = await elevationService.getElevationForLocations(points);
                    if (results.length !== points.length) throw new Error(`the Elevation API answered ${results.length} of ${points.length} points`);
                    return results.map(r => r.elevation);
                }
            }
        } : {}),
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
            }, { radiusMeters: req.radiusM, outputDir: req.outDir, outputGlbPath: textured, geometryGlbPath: geometry, signal: req.signal, ...(req.rect ? { rect: req.rect } : {}) });
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
        // search-grounded reference images (the bridges' detail the scan cannot resolve): the Vertex client with the image models
        groundedReferences: async () => (await new GoogleMediaCredentialsService().createVertexClient()) as unknown as GroundedReferenceClient,
        vehicleRemoval: true,
        // what the residual audit finds standing in a district's streets that nothing explains, out of the tree-stripped scan (street-residue.ts)
        streetResidue: true,
        // the tile seam stage on the extraction as it arrives (tile-seam-weld-service.ts)
        tileSeams: runTileSeamWeld,
        // pipeline K-D: each chunk of a chunked district is a build of its own, on its own worker thread, or with
        // SCRATCHBOX_KD_CHUNK_RUNNER=cloud one Cloud Run job each (cloud-chunk-runner.ts); the district's leaf tiles are
        // fetched ahead of its chunks into the shared leaf cache only when the chunks build here
        ...(kdChunkRunner() === 'cloud' ? { runChunk: cloudRunChunk(cache), chunkBands: true as const } : {
            prefetchTiles: (req: Parameters<NonNullable<StagedLocationDeps['prefetchTiles']>>[0]) => prefetchGoogle3DTileLeaves({ lat: req.lat, lng: req.lng, ...(req.elevation !== undefined ? { elevation: req.elevation } : {}) }, req.radiusM, { ...(req.signal ? { signal: req.signal } : {}), ...(req.onProgress ? { onProgress: req.onProgress } : {}) }),
            runChunk: (request: StagedLocationRequest, o: { signal?: AbortSignal; onProgress?: (message: string) => void }) => runStagedLocationOffThread(request, workspaceRoot, undefined, { ...(o.signal ? { signal: o.signal } : {}), ...(o.onProgress ? { reportProgress: (m: string) => o.onProgress!(m) } : {}) })
        }),
        // the texture pass's model texture rung: the image model redraws the tile transfer, kept only past its gate
        // (SCRATCHBOX_TEXTURE_ENHANCE=0 turns the rung off); default mode 'recreate' (user decision, 2026-10-21) removes
        // the scan's own baked shadow/highlight and recovers the material's true colour, gated on structure and
        // hue/chroma, not on lighting (texture-enhance.ts RECREATE_GATE; SCRATCHBOX_TEXTURE_ENHANCE_MODE=sharpen reverts
        // to the earlier, lighting-locked sharpen-only mode). The detail-locked model lighting correction of the photos
        // (texture-lighting.ts; on by default, SCRATCHBOX_TEXTURE_LIGHTING=0 turns it off) runs alongside it, wherever a
        // registered Street View view agrees - a second, independent de-light pass, not a duplicate of the one above.
        textures: 'client' in vision ? {
            ...(process.env.SCRATCHBOX_TEXTURE_ENHANCE !== '0' ? {
                enhance: genAiEnhanceClient(vision.client),
                enhanceMode: process.env.SCRATCHBOX_TEXTURE_ENHANCE_MODE === 'sharpen' ? 'sharpen' as const : 'recreate' as const
            } : {}),
            ...(lightingCorrectionEnabled() ? { lighting: genAiEnhanceClient(vision.client), lightingModels: lightingModels() } : {})
        } : {}
    };
}

/**
 * The cloud chunk runner on the app's service account: the job bucket (SCRATCHBOX_KD_JOB_BUCKET) and the Cloud Run job
 * (cloud-chunk-runner.ts cloudChunkConfig), made on the first chunk, so a district without credentials fails its chunks
 * with that reason (the orchestrator then degrades them) rather than building them here.
 */
function cloudRunChunk(cache: StageCache): NonNullable<StagedLocationDeps['runChunk']> {
    let runner: Promise<RunChunk> | undefined;
    const make = async (): Promise<RunChunk> => {
        const config = cloudChunkConfig();
        const storage = new GoogleMediaCredentialsService().createStorageClient();
        // the warm worker pool (a Cloud Run service, SCRATCHBOX_KD_CLOUD_SERVICE) when named, else a job execution a chunk
        const pool: CloudRunJobs = config.service
            ? (config.serviceRegions?.length ? new RoundRobinJobs(await Promise.all(config.serviceRegions.map(region => CloudRunServiceJobs.create({ ...config, region })))) : await CloudRunServiceJobs.create(config))
            : await CloudRunJobsRest.create(config);
        const bucket = new GcsCloudBucket(storage.bucket(config.bucket));
        // the largest chunks on the fast VMs (SCRATCHBOX_KD_CLOUD_VMS), the rest on the pool
        const jobs = config.vms?.length ? new HybridJobs(await VmPoolJobs.create(config, bucket, path.join(cache.dir, '.kd-vm'), m => console.log(m)), pool) : pool;
        return createCloudChunkRunner({ cache, config, bucket, jobs });
    };
    return async (request, o) => {
        runner ??= make();
        runner.catch(() => { runner = undefined; });
        return (await runner)(request, o);
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

/** What the main thread sends a build's worker (staged-location-worker.ts): a stop. */
export type StagedWorkerIn = { kind: 'abort'; message: string; name?: string };
/** What a build's worker posts back: its stage events and progress as they happen, then its outcome or its error. */
export type StagedWorkerOut =
    | { kind: 'event'; event: StageEvent; artifact?: CanvasArtifact }
    | { kind: 'progress'; message: string; fraction?: number }
    | { kind: 'done'; outcome: StagedLocationOutcome }
    /** After `done`: the build's background passes (the scene object store's) have ended, so the worker can go. */
    | { kind: 'idle' }
    | { kind: 'error'; name: string; message: string; stack?: string; stage?: string; reasonCode?: string };

/** How long a worker that has answered may go on with its background passes before it is terminated (ms). */
const STAGED_WORKER_IDLE_CAP_MS = 60 * 60_000;

/** SCRATCHBOX_STAGED_WORKER=0 runs the staged build on the server's main thread, as before. */
export function stagedWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_WORKER?.trim() !== '0';
}

const STAGED_WORKER_BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

/**
 * runStagedLocation on its own worker thread, with services it makes itself (createStagedLocationDeps on `root`): the
 * same events, outcome and errors, while the server's main thread stays free to stream the chat and serve the layers
 * already committed. The worker gets the server's own heap limit; the signal stops it (the build ends as stopped, and
 * the worker is terminated if it has not ended a few seconds later). Its model calls are kept to this thread's call
 * budget (model-call-budget.ts serveCallBudget), so every build in the process shares one.
 */
export function runStagedLocationOffThread(request: StagedLocationRequest, root: string, runId: string | undefined, ctx: StagedLocationContext): Promise<StagedLocationOutcome> {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const entry = ['staged-location-worker.js', 'staged-location-worker.ts'].map(n => path.join(dir, n)).find(p => fs.existsSync(p));
    if (!entry) return Promise.reject(new Error(`the staged build worker was not found beside ${dir}`));
    const heapMb = Math.floor(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
    return new Promise<StagedLocationOutcome>((resolve, reject) => {
        let settled = false, killTimer: NodeJS.Timeout | undefined, idleTimer: NodeJS.Timeout | undefined;
        const budget = new MessageChannel();
        serveCallBudget(budget.port1);
        const w = new Worker(STAGED_WORKER_BOOTSTRAP, {
            eval: true, resourceLimits: { maxOldGenerationSizeMb: heapMb },
            workerData: {
                entry, request, root, runId, modelCallBudget: budget.port2,
                ...(ctx.remainingMs ? { deadlineAt: Date.now() + ctx.remainingMs() } : {}),
                ...(ctx.activeArtifact ? { activeArtifact: ctx.activeArtifact } : {}),
                ...(ctx.retry ? { retry: ctx.retry } : {}), ...(ctx.resume ? { resume: ctx.resume } : {})
            },
            transferList: [budget.port2]
        });
        // the worker's turns are let go when it ends, whichever way
        w.once('exit', () => budget.port1.close());
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            ctx.signal?.removeEventListener('abort', onAbort);
            if (killTimer) clearTimeout(killTimer);
            fn();
        };
        // the build ends itself on a stop (as stopped, with what it committed); a worker that has not ended is terminated
        const onAbort = () => {
            const r = ctx.signal!.reason;
            w.postMessage({ kind: 'abort', message: r instanceof Error ? r.message : String(r ?? 'stopped'), ...(r instanceof Error ? { name: r.name } : {}) } satisfies StagedWorkerIn);
            killTimer = setTimeout(() => finish(() => { void w.terminate(); reject(r instanceof Error ? r : new Error('the staged build was stopped')); }), 10_000);
        };
        if (ctx.signal?.aborted) onAbort(); else ctx.signal?.addEventListener('abort', onAbort, { once: true });
        w.on('message', (m: StagedWorkerOut) => {
            if (m.kind === 'event') ctx.emitStage?.(m.event, m.artifact);
            else if (m.kind === 'progress') ctx.reportProgress?.(m.message, m.fraction);
            // the result is answered at once; the worker goes once its background passes end (none while the object store is off)
            else if (m.kind === 'done') finish(() => { resolve(m.outcome); idleTimer = setTimeout(() => void w.terminate(), STAGED_WORKER_IDLE_CAP_MS); idleTimer.unref(); });
            else if (m.kind === 'idle') { if (idleTimer) clearTimeout(idleTimer); void w.terminate(); }
            else finish(() => {
                const e = m.name === 'StagedLocationHardFailure' ? new StagedLocationHardFailure((m.stage ?? 'resolve') as StageId, m.reasonCode ?? 'failed', m.message) : Object.assign(new Error(m.message), { name: m.name });
                if (m.stack) e.stack = m.stack;
                reject(e);
                void w.terminate();
            });
        });
        w.on('error', err => finish(() => reject(err)));
        w.on('exit', code => finish(() => reject(new Error(`the staged build worker exited with code ${code} before it answered`))));
    });
}

/** google_3d_tiles_get_clay when it remeshes: the staged build. `injected` replaces the real dependencies (tests). */
export async function runStagedLocationTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    injected?: StagedLocationDeps
): Promise<ToolHandlerOutcome> {
    reportStagedSwitchProblems();
    const { request, retry, resume } = parseStagedLocationArgs(toolName, args);
    const root = stagedWorkspaceRoot();
    // the caller's own copy of the raw extraction, where the extraction tools have always put it: the path as given when
    // absolute, else under public/models by its file name
    const wanted = typeof args.outputGlbPath === 'string' ? args.outputGlbPath.trim() : '';
    const copyTo = wanted ? (path.isAbsolute(wanted) ? wanted : path.resolve(root, 'public', 'models', path.basename(wanted))) : undefined;
    // The run outlives the chat stream: its own signal aborts on the user's Stop (or a deadline), never because the page
    // went away. Its events and artifacts are kept in the run registry, where a reloaded page re-attaches.
    const own = new AbortController();
    const forwardAbort = () => { if (!isClientDisconnect(ctx.signal?.reason)) own.abort(ctx.signal?.reason); };
    if (ctx.signal?.aborted) forwardAbort();
    else ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
    const registry = stagedRunRegistry();
    const runId = injected?.newRunId?.() ?? crypto.randomBytes(4).toString('hex');
    registry.begin(runId, own);
    const detach = registry.attach(runId, (event, artifact) => ctx.emitStage?.(event, artifact));
    let outcome: Awaited<ReturnType<typeof runStagedLocation>>;
    try {
        // the build on its own thread (its stages hold the CPU for minutes), unless the services are injected (tests) or it is turned off
        if (!injected && stagedWorkerEnabled()) outcome = await runStagedLocationOffThread(request, root, runId, {
            signal: own.signal,
            emitStage: (event, artifact) => registry.record(runId, event, artifact),
            ...(ctx.reportProgress ? { reportProgress: ctx.reportProgress } : {}),
            ...(typeof (ctx as unknown as { remainingMs?: () => number }).remainingMs === 'function' ? { remainingMs: (ctx as unknown as { remainingMs: () => number }).remainingMs } : {}),
            ...(ctx.request?.activeArtifact ? { activeArtifact: ctx.request.activeArtifact } : {}),
            ...(retry ? { retry } : {}),
            ...(resume ? { resume } : {})
        });
        else outcome = await runStagedLocation(request, { ...(injected ?? await createStagedLocationDeps(root, { signal: own.signal })), newRunId: () => runId }, {
            signal: own.signal,
            emitStage: (event, artifact) => registry.record(runId, event, artifact),
            reportProgress: ctx.reportProgress,
            // the tool's remaining time, when the chat reports it (the computer-use plan adds the field); else the static budget
            ...(typeof (ctx as unknown as { remainingMs?: () => number }).remainingMs === 'function' ? { remainingMs: (ctx as unknown as { remainingMs: () => number }).remainingMs } : {}),
            activeArtifact: ctx.request?.activeArtifact,
            ...(retry ? { retry } : {}),
            ...(resume ? { resume } : {})
        });
    } catch (err) {
        registry.end(runId, own.signal.aborted ? 'stopped' : 'failed', undefined, (err as Error)?.message ?? String(err));
        if (!injected) mirrorCachesInBackground(root);
        detach();
        ctx.signal?.removeEventListener('abort', forwardAbort);
        throw err;
    }
    registry.end(runId, outcome.result.status === 'stopped' ? 'stopped' : 'finished', outcome.result.artifact as CanvasArtifact | undefined);
    // the run's caches (its stage entries, run records, native caches; its chunks' too) to the training bucket, for regressors
    if (!injected) mirrorCachesInBackground(root);
    detach();
    ctx.signal?.removeEventListener('abort', forwardAbort);
    if (copyTo && fs.existsSync(outcome.compat.glbPath)) {
        fs.mkdirSync(path.dirname(copyTo), { recursive: true });
        fs.copyFileSync(outcome.compat.glbPath, copyTo);
    }
    return { resultPayload: stagedToolPayload(outcome), summaryResult: outcome.result.digest };
}
