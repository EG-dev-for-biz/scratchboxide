/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * infer_surface_materials: the surface step of a rebuilt district run on its own (staged-location/surface-inference.ts):
 * each rebuilt surface (building walls and roofs, ground regions, carriageways, kerbs) gets the library material the vision
 * model infers for it from the photo tiles, at real scale, tinted to its lit colour; or, in photo mode, the clays and
 * fill spec for the texture pass. The written GLBs are published under /models for the scene to load.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import { inferStageSurfaces, type StageSurfaceInput } from '../../3d-engine/staged-location/surface-inference';
import { createStagedLocationDeps } from '../../3d-engine/staged-location/staged-location-tool';
import { stagedWorkspaceRoot } from '../../3d-engine/staged-location/stage-cache';
import { VisionModelChain } from '../vision-model-chain';
import { resolveRepoRoot } from './nano-banana-tools';
import type { ToolDeclaration, ToolHandler } from './types';
import { harvestSurveySwatches, type StationBeautifier, type SurveySwatchHarvestResult } from '../../spatial/survey-swatch-harvest';
import { fastMatchSwatchToLibrary, geminiJsonVision, matchSwatchToLibrary, openPbrLibrary, resolvePbrLibrary, vertexEmbeddingsClient, type PbrLibraryIndexFile, type PbrMatch } from '../../spatial/pbr-library-match';
import { cachedGeminiSegmenter } from '../../spatial/StreetViewMaterialHarvester';
import { SurveyStationRenderService } from '../../spatial/SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from '../../spatial/BeautifyStationService';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';

export const SURFACE_MATERIALS_TOOL_NAME = 'infer_surface_materials';

export const SURFACE_MATERIALS_TOOL_DECLARATION: ToolDeclaration = {
    name: SURFACE_MATERIALS_TOOL_NAME,
    description: 'Give every rebuilt surface of a procedural district its material: the vision model infers, from the place\'s photo tiles, '
        + 'which surface-library material each building\'s walls and roofs, each ground region, the carriageways and the kerbs are, and writes '
        + 'them in it at real scale, tinted to the colour measured on lit photo texels (generated, no photo texel drawn, no baked shadow). '
        + 'mode "photo" instead prepares the texture pass (the photo transferred onto each surface). Input: the district massing stage '
        + 'folder a staged build reports (stageDir) and the place\'s photo tiles GLB. Returns the written GLBs with /models URLs and the '
        + 'material chosen per surface.',
    parameters: {
        type: 'OBJECT',
        properties: {
            stageDir: { type: 'STRING', description: 'The district massing stage folder of a staged build (holds ground.glb, district_massing_textured.glb, buildings.json, native/).' },
            tilesGlb: { type: 'STRING', description: 'Path of the place\'s textured photo tiles GLB (the staged build\'s tiles layer).' },
            mode: { type: 'STRING', description: '"inferred" (default): materials inferred per surface; "photo": prepare the texture pass instead.' },
            outputDir: { type: 'STRING', description: 'Optional output folder (default <stageDir>/surfaces-<mode>).' }
        },
        required: ['stageDir', 'tilesGlb']
    }
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function createSurfaceMaterialsHandler(deps: { run?: typeof inferStageSurfaces; chain?: StageSurfaceInput['chain']; modelsDir?: string } = {}): ToolHandler {
    return async (args, ctx) => {
        const stageDir = str(args.stageDir), tilesGlb = str(args.tilesGlb);
        if (!stageDir) throw new MissingInputError(SURFACE_MATERIALS_TOOL_NAME, 'stageDir', 'the district massing stage folder');
        if (!tilesGlb) throw new MissingInputError(SURFACE_MATERIALS_TOOL_NAME, 'tilesGlb', 'the place\'s photo tiles GLB');
        const mode = str(args.mode).toLowerCase() === 'photo' ? 'photo' as const : 'inferred' as const;
        let chain = deps.chain, unavailable: string | undefined;
        if (!chain) {
            const staged = await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx?.signal });
            if (staged.vision && 'client' in staged.vision) chain = new VisionModelChain<string>({ client: staged.vision.client, candidates: staged.vision.candidates, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
            else unavailable = staged.vision && 'unavailable' in staged.vision ? String(staged.vision.unavailable) : 'no vision model configured';
        }
        const r = await (deps.run ?? inferStageSurfaces)({ stageDir, tilesGlb, mode, ...(str(args.outputDir) ? { outDir: str(args.outputDir) } : {}), ...(chain ? { chain } : {}), ...(unavailable ? { unavailable } : {}), ...(ctx?.signal ? { signal: ctx.signal } : {}), onProgress: m => ctx?.reportProgress?.(m) });
        // the GLBs published under /models so a scene can load them
        const modelsDir = deps.modelsDir ?? path.join(resolveRepoRoot(), 'public', 'models');
        fs.mkdirSync(modelsDir, { recursive: true });
        const stamp = `${path.basename(stageDir).slice(0, 8)}_${mode}_${Date.now()}`;
        const published: Record<string, { path: string; url: string }> = {};
        for (const [k, p] of Object.entries(r.files)) {
            if (!p.endsWith('.glb')) continue;
            const name = `surfaces_${stamp}_${path.basename(p)}`;
            fs.copyFileSync(p, path.join(modelsDir, name));
            published[k] = { path: path.join(modelsDir, name), url: `/models/${name}` };
        }
        const entries = Object.entries(r.summary.entries).map(([e, n]) => `${e} x${n}`).join(', ');
        const summary = mode === 'inferred'
            ? `Inferred materials for ${r.buildings} buildings, ${r.summary.groundRegions} ground regions${r.files.roads ? ' and the streets' : ''}: ${entries} (${r.summary.byVision} by vision, ${r.summary.byColour} by measured colour alone). Generated library materials tinted to lit colour; no photo texel drawn.`
            : `Prepared the texture pass for ${r.buildings} buildings and ${r.summary.groundRegions} ground regions; library fill: ${entries}.`;
        return { resultPayload: { success: true, mode, provenance: { label: 'generated', basis: mode === 'inferred' ? 'library material inferred per surface' : 'texture-pass preparation' }, outDir: r.outDir, files: r.files, published, choices: r.summary, summary }, summaryResult: summary };
    };
}

// =============================================================================
// survey_harvest_swatches: texture swatches of a building from AI Beautify survey stations, matched to the PBR library
// =============================================================================

export const SURVEY_SWATCHES_TOOL_NAME = 'survey_harvest_swatches';

export const SURVEY_SWATCHES_TOOL_DECLARATION: ToolDeclaration = {
    name: SURVEY_SWATCHES_TOOL_NAME,
    description: 'Harvest texture swatches of one building from a survey of its Google 3D Tiles: survey stations square-on to each facade and '
        + 'off-axis, at street and mid height, plus four framed aerials, each path-traced and run through AI Beautify (exact poses, no Street '
        + 'View needed); the material harvester then rectifies clean patches into tileable PBR swatches (albedo, normal, ORM, height) at a '
        + 'measured metres-per-pixel, keeping only patches on the building itself. Each swatch can be matched to its closest material in the '
        + 'local PBR texture library. Everything is labelled generated (from renders of the tiles), never measured. Takes several minutes: '
        + 'one image call per station.',
    parameters: {
        type: 'OBJECT',
        properties: {
            place: { type: 'STRING', description: 'The building: an address or name (geocoded), or "lat, lng".' },
            beautify: { type: 'BOOLEAN', description: 'Run each station through AI Beautify before harvesting (default true; false harvests the raw tile renders).' },
            subjectOnly: { type: 'BOOLEAN', description: 'Keep only swatches on the building itself, not neighbours or the street (default true).' },
            matchLibrary: { type: 'BOOLEAN', description: 'Match each swatch to the closest material of the local PBR texture library (default true).' },
            libraryPath: { type: 'STRING', description: 'Optional PBR library location: a gs:// URI or a local folder (default SCRATCHBOX_PBR_LIBRARY, else gs://scoutscan-pbr-library/PBR_Textures_Library).' },
            fetchMaps: { type: 'BOOLEAN', description: 'Download each matched material\'s maps (colour, normal, roughness, displacement...) into the local cache and return their paths (default false: their gs:// URIs only; 8K sets are 100-170 MB each).' },
            outputDir: { type: 'STRING', description: 'Optional output folder (default .scratchbox/survey_swatches/<place> in the workspace).' }
        },
        required: ['place']
    }
};

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);

export function createSurveySwatchesHandler(deps: {
    staged?: Pick<Awaited<ReturnType<typeof createStagedLocationDeps>>, 'geocode' | 'extract'>;
    harvest?: typeof harvestSurveySwatches; vision?: unknown; beautifier?: StationBeautifier | null;
    match?: (s: SurveySwatchHarvestResult['swatches'][number], workDir: string) => Promise<PbrMatch>;
} = {}): ToolHandler {
    return async (args, ctx) => {
        const placeArg = str(args.place);
        if (!placeArg) throw new MissingInputError(SURVEY_SWATCHES_TOOL_NAME, 'place', 'the building to survey (address, name or "lat, lng")');
        const root = stagedWorkspaceRoot();
        const staged = deps.staged ?? await createStagedLocationDeps(root, { signal: ctx?.signal });
        const ll = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(placeArg);
        const place = ll ? { lat: Number(ll[1]), lng: Number(ll[2]), formattedAddress: placeArg } : await staged.geocode(placeArg, ctx?.signal);
        const outDir = str(args.outputDir) || path.join(root, '.scratchbox', 'survey_swatches', `${slug(place.formattedAddress)}_${place.lat.toFixed(5)}_${place.lng.toFixed(5)}`);
        const tilesDir = path.join(outDir, 'tiles');
        let tileGlb = path.join(tilesDir, 'textured.glb');
        if (!fs.existsSync(tileGlb)) {
            ctx?.reportProgress?.('downloading the Google 3D Tiles around the building');
            fs.mkdirSync(tilesDir, { recursive: true });
            tileGlb = (await staged.extract({ lat: place.lat, lng: place.lng, radiusM: 60, outDir: tilesDir, place: place as never, ...(ctx?.signal ? { signal: ctx.signal } : {}), onProgress: m => ctx?.reportProgress?.(m) })).texturedGlb;
        }
        const vision = deps.vision ?? await new GoogleMediaCredentialsService().createVertexClient();
        let beautifier = deps.beautifier;
        if (beautifier === undefined && args.beautify !== false) {
            const renderer = new SurveyStationRenderService();
            await renderer.loadMesh(tileGlb);
            beautifier = new BeautifyStationService(renderer, createDefaultStationImageGenerator({ workspaceRoot: root, imageSize: '2K' })) as unknown as StationBeautifier;
        }
        const harvestDir = path.join(outDir, args.beautify === false ? 'raw' : 'beautified');
        const r = await (deps.harvest ?? harvestSurveySwatches)({
            tileGlb, anchor: { lat: place.lat, lng: place.lng, elevationMeters: 0 }, place: place.formattedAddress, outDir: harvestDir,
            segmenter: cachedGeminiSegmenter(vision as never, path.join(harvestDir, 'segmentation'), { allowNetwork: true }),
            ...(beautifier ? { beautifier } : {}), subjectOnly: args.subjectOnly !== false, log: m => ctx?.reportProgress?.(m), ...(ctx?.signal ? { signal: ctx.signal } : {})
        });
        const matches: Array<PbrMatch | { error: string }> = [];
        let libraryNote = 'library matching off';
        if (args.matchLibrary !== false && r.swatches.length) {
            try {
                let match = deps.match;
                if (!match) {
                    const where = resolvePbrLibrary(str(args.libraryPath) || undefined);
                    ctx?.reportProgress?.(`opening the PBR library at ${where}`);
                    const library = await openPbrLibrary(where);
                    const jv = geminiJsonVision(vision as never);
                    const fetchMaps = args.fetchMaps === true;

                    // Try to load the index to check for embeddings
                    let fastMatcher: NonNullable<typeof deps.match> | undefined;
                    try {
                        if (where.startsWith('gs://')) {
                            const indexStore = await (await import('../../spatial/pbr-library-match')).cloudStore(`${where}_index`);
                            const indexJson = await indexStore.read('index.json');
                            const index: PbrLibraryIndexFile = JSON.parse(indexJson.toString('utf8'));
                            if (index.embedDim) {
                                const embedClient = vertexEmbeddingsClient();
                                ctx?.reportProgress?.(`using fast embedding-based matching (${index.materials.filter(m => m.embed).length} materials have embeddings)`);
                                fastMatcher = (s, workDir) => fastMatchSwatchToLibrary({ photo: s.files.photoSwatch, description: s.description, sizeMeters: s.sizeMeters }, library, index, embedClient, jv, workDir, { fetchMaps });
                            }
                        }
                    } catch {
                        // No embeddings available, use slow matcher
                    }

                    if (!fastMatcher) match = (s, workDir) => matchSwatchToLibrary({ photo: s.files.photoSwatch, description: s.description, sizeMeters: s.sizeMeters }, library, jv, workDir, { fetchMaps });
                    else match = fastMatcher;

                    libraryNote = `${library.names.length} materials in ${where}${fastMatcher ? ' (fast embedding search)' : ''}`;
                } else libraryNote = 'library matching';

                // Match swatches in parallel (4 at a time)
                const concurrency = 4;
                let next = 0;
                await Promise.all(Array.from({ length: Math.min(concurrency, r.swatches.length) }, async () => {
                    for (let i; (i = next++) < r.swatches.length;) {
                        const s = r.swatches[i];
                        try {
                            const result = await match(s, path.join(harvestDir, 'library_match'));
                            matches[i] = result;
                            ctx?.reportProgress?.(`matched swatch ${i + 1} of ${r.swatches.length}`);
                        } catch (err) {
                            matches[i] = { error: (err as Error).message };
                        }
                    }
                }));
            } catch (err) { libraryNote = `library matching skipped: ${(err as Error).message}`; }
        }
        const swatches = r.swatches.map((s, i) => ({ ...s, ...(matches[i] ? { libraryMatch: matches[i] } : {}) }));
        const kept = r.stations.filter(s => s.kept).length;
        const summary = `Harvested ${swatches.length} swatches of ${place.formattedAddress} from ${kept} of ${r.stations.length} survey stations${args.beautify === false ? '' : ' (AI Beautify)'}`
            + `${r.droppedOffSubject ? `, ${r.droppedOffSubject} off the building dropped` : ''}, ${r.rejected} proposals rejected; ${libraryNote}. Labelled generated.`;
        return {
            resultPayload: { success: true, place, outDir, libraryPath: r.libraryPath, hero: r.hero, stations: r.stations, swatches, rejected: r.rejected, droppedOffSubject: r.droppedOffSubject, provenance: { label: 'generated', basis: args.beautify === false ? 'survey station renders of the Google 3D Tiles' : 'AI Beautify images of survey station renders of the Google 3D Tiles' }, summary },
            summaryResult: summary
        };
    };
}

export const SURFACE_MATERIALS_TOOL_DECLARATIONS: ToolDeclaration[] = [SURFACE_MATERIALS_TOOL_DECLARATION, SURVEY_SWATCHES_TOOL_DECLARATION];

export const surfaceMaterialsHandlers: Record<string, ToolHandler> = {
    [SURFACE_MATERIALS_TOOL_NAME]: createSurfaceMaterialsHandler(),
    [SURVEY_SWATCHES_TOOL_NAME]: createSurveySwatchesHandler()
};
