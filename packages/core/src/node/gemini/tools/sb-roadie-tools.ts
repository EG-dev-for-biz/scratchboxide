/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Roadie: the road surfaces of the open staged place, as its own tool. The staged build measures the streets once
 * (the `roads` stage: Google's road centrelines, kerbs and levels read on the photo tiles, the tile photo from above as
 * the texture; road-surfaces.ts). This tool reads the same measurement back for the model to report on (how wide each
 * street was measured, where kerbs were not found), or measures again with other parameters (the kerb rise, the default
 * half-width, the stand-off above the scan, the photo texel) and replaces the scene's road layer. Nothing is invented: a
 * street whose kerbs the scan does not show gets the default half-width and says so.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import type { StagedBuildState, StagedLayer } from '../../../common/spatial/staged-location-contracts';
import { StageCache, stageKey, stagedWorkspaceRoot } from '../../3d-engine/staged-location/stage-cache';
import { layerObject, layerObjectId } from '../../3d-engine/staged-location/staged-artifact';
import { evidenceLookup, fetchVectorEvidence } from '../../3d-engine/staged-location/vector-footprints';
import { VECTOR_MODELLED_LABEL } from '../../3d-engine/staged-location/vector-first-paint';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import { buildGroundModel, loadScanMesh, surfaceModel } from '../../spatial/StreetViewSurveyPlanner';
import { buildRoadMesh, measureRoadSurfaces, writeRoadsGlb, ROAD_SURFACE_PARAMS, type RoadSurface, type RoadSurfaceParams } from '../../3d-engine/staged-location/road-surfaces';
import { renderTopDownPhoto } from '../../3d-engine/staged-location/top-down-photo';
import { synthesizeRoadTextures } from '../../3d-engine/staged-location/road-texture';
import * as jpegJs from 'jpeg-js';
import { measureGlbMeshCounts } from '../../../common/glb-mesh-counts';
import { GeminiClient } from '../gemini-client';
import type { StagedExtraction } from '../../3d-engine/staged-location/orchestrator';

export const SB_ROADIE_TOOL = 'sb_roadie';

export const SB_ROADIE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: SB_ROADIE_TOOL,
        description: 'SB-Roadie: the streets of the open staged place. With action "report" it returns how each street was measured (its length, the kerb-to-kerb width per side, how many kerbs the scan showed and how many were defaulted, medians, sidewalks). With action "rebuild" it measures the streets again on the photo tiles with the parameters given (the kerb rise that counts as a kerb, the default half-width where none shows, the stand-off above the scan, the photo texel) and replaces the scene\'s road layer with ribbons swept along Google\'s road centrelines through the measured levels, textured from the tile photo rendered from above. Needs a scene staged by google_3d_tiles_get_clay and Google vector data (the service account).',
        parameters: {
            type: 'OBJECT',
            properties: {
                action: { type: 'STRING', enum: ['report', 'rebuild'], description: '"report" (default) reads the measurement back; "rebuild" measures again with the parameters below and replaces the road layer.' },
                kerbRiseM: { type: 'NUMBER', description: 'A kerb: the surface rises at least this much (m) and stays up (default 0.08).' },
                defaultHalfWidthM: { type: 'NUMBER', description: 'Half-width used where the scan shows no kerb (m, default 3.5); such stations are labelled vector-modelled.' },
                liftM: { type: 'NUMBER', description: 'How far the surfaces stand above the scan they were read from (m, default 0.04).' },
                texelM: { type: 'NUMBER', description: 'The photo texture\'s texel (m, default 0.1; the side is capped at 4096 px).' },
                stationM: { type: 'NUMBER', description: 'Distance between stations along a street (m, default 2).' }
            }
        }
    }
];

interface RoadRecord { schema: string; roads: RoadSurface[] }

function number(args: Record<string, unknown>, key: string, lo: number, hi: number): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${SB_ROADIE_TOOL}: "${key}" must be a number in [${lo}, ${hi}]`);
    return n;
}

/** The open scene's staged build, its run record and extraction (the roads stage's inputs), or an error saying what is missing. */
function openStagedPlace(ctx: ToolContext): { active: CanvasArtifact; data: Scene3DData & { stagedBuild: StagedBuildState }; cache: StageCache; extraction: StagedExtraction; tilesKey: string; roadsKey?: string; stripKey?: string } {
    const active = ctx?.request?.activeArtifact as CanvasArtifact | undefined;
    if (!active || active.type !== '3d-scene' || !active.data) throw new Error(`${SB_ROADIE_TOOL}: no 3D scene is open. Stage a place with google_3d_tiles_get_clay first.`);
    const data = active.data as Scene3DData & { stagedBuild?: StagedBuildState };
    if (!data.stagedBuild) throw new Error(`${SB_ROADIE_TOOL}: the open scene is not a staged place (no stagedBuild). Stage a place with google_3d_tiles_get_clay first.`);
    const cache = new StageCache({ workspaceRoot: stagedWorkspaceRoot() });
    const rec = cache.readRunRecord<{ keys?: Partial<Record<string, string>> }>(data.stagedBuild.runId);
    const tilesKey = rec?.keys?.tiles;
    if (!tilesKey) throw new Error(`${SB_ROADIE_TOOL}: the staged run ${data.stagedBuild.runId} has no tile extraction on record; stage the place again.`);
    const hit = cache.get<StagedExtraction>('tiles', tilesKey);
    if (!hit) throw new Error(`${SB_ROADIE_TOOL}: the tile extraction of run ${data.stagedBuild.runId} is no longer in the stage cache; stage the place again.`);
    const extraction: StagedExtraction = { ...hit.value, texturedGlb: path.join(hit.dir, hit.value.texturedGlb), geometryGlb: path.join(hit.dir, hit.value.geometryGlb) };
    if (!fs.existsSync(extraction.texturedGlb)) throw new Error(`${SB_ROADIE_TOOL}: the photo tiles of run ${data.stagedBuild.runId} are no longer on disk; stage the place again.`);
    return { active, data: data as Scene3DData & { stagedBuild: StagedBuildState }, cache, extraction, tilesKey, roadsKey: rec?.keys?.roads, stripKey: rec?.keys?.['trees-measure'] };
}

function summarize(roads: RoadSurface[]): { streets: number; stations: number; measuredKerbShare: number; perStreet: Array<Record<string, unknown>> } {
    const stations = roads.reduce((n, r) => n + r.stations.length, 0);
    const measuredKerbShare = stations ? roads.reduce((n, r) => n + r.measuredKerbShare * r.stations.length, 0) / stations : 0;
    const perStreet = roads.map(r => {
        const widths = r.stations.map(s => s.left.halfWidthM + s.right.halfWidthM);
        const sorted = [...widths].sort((a, b) => a - b);
        const measured = r.stations.filter(s => s.left.kerb === 'measured' && s.right.kerb === 'measured').length;
        return {
            id: r.id, lengthM: Math.round(r.lengthM), stations: r.stations.length,
            widthM: { median: Number(sorted[Math.floor(sorted.length / 2)]?.toFixed(1)), min: Number(sorted[0]?.toFixed(1)), max: Number(sorted[sorted.length - 1]?.toFixed(1)) },
            stationsWithBothKerbsMeasured: measured, measuredKerbShare: Number(r.measuredKerbShare.toFixed(2)),
            medianStations: r.stations.filter(s => s.median).length,
            sidewalkStations: r.stations.filter(s => s.left.sidewalk || s.right.sidewalk).length,
            provenance: r.measuredKerbShare >= 0.5 ? 'measured (widths and levels from the scan; the centreline vector-modelled)' : 'vector-modelled widths (the scan showed few kerbs); levels measured'
        };
    });
    return { streets: roads.length, stations, measuredKerbShare: Number(measuredKerbShare.toFixed(3)), perStreet };
}

export const sbRoadieHandlers: Record<string, ToolHandler> = {
    [SB_ROADIE_TOOL]: async (args, ctx): Promise<ToolHandlerOutcome> => {
        const action = args.action === 'rebuild' ? 'rebuild' : 'report';
        const place = openStagedPlace(ctx);
        const { cache, extraction, data } = place;
        if (action === 'report') {
            if (!place.roadsKey) {
                const stage = data.stagedBuild.stages.find(s => s.stage === 'roads');
                throw new Error(`${SB_ROADIE_TOOL}: the staged build measured no streets${stage?.reason ? ` (${stage.reason})` : ''}.`);
            }
            const hit = cache.get<unknown>('roads', place.roadsKey);
            const file = hit ? path.join(hit.dir, 'roads.json') : '';
            if (!hit || !fs.existsSync(file)) throw new Error(`${SB_ROADIE_TOOL}: the road measurement of run ${data.stagedBuild.runId} is no longer in the stage cache; rebuild it (action "rebuild").`);
            const roads = (JSON.parse(fs.readFileSync(file, 'utf8')) as RoadRecord).roads;
            const summary = summarize(roads);
            const text = `${summary.streets} streets measured at ${summary.stations} stations; ${Math.round(100 * summary.measuredKerbShare)} % of kerbs found on the scan, the rest defaulted to ${2 * ROAD_SURFACE_PARAMS.defaultHalfWidthM} m wide.`;
            return { resultPayload: { success: true, action, ...summary, params: ROAD_SURFACE_PARAMS }, summaryResult: text };
        }
        const P: RoadSurfaceParams = {
            ...ROAD_SURFACE_PARAMS,
            ...(number(args, 'kerbRiseM', 0.03, 0.5) !== undefined ? { kerbRiseM: number(args, 'kerbRiseM', 0.03, 0.5)! } : {}),
            ...(number(args, 'defaultHalfWidthM', 1, 15) !== undefined ? { defaultHalfWidthM: number(args, 'defaultHalfWidthM', 1, 15)! } : {}),
            ...(number(args, 'liftM', 0, 0.5) !== undefined ? { liftM: number(args, 'liftM', 0, 0.5)! } : {}),
            ...(number(args, 'stationM', 1, 10) !== undefined ? { stationM: number(args, 'stationM', 1, 10)! } : {})
        };
        const texelM = number(args, 'texelM', 0.05, 1) ?? 0.1;
        if (!new GeminiClient().ensureAuth()) throw new Error(`${SB_ROADIE_TOOL}: no service account for Google vector data (vectortiles.featuretiles), so the road centrelines cannot be read.`);
        const covered = extraction.coveredRadiusM;
        const { lat, lng } = data.stagedBuild.place;
        ctx?.reportProgress?.('Reading Google\'s road centrelines');
        const vector = evidenceLookup(await fetchVectorEvidence({ lat, lng, radiusM: covered + 20, fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') }), covered + 20);
        const centrelines = vector.raster.roads.filter(l => l.some(([x, z]) => Math.hypot(x, z) <= covered));
        if (!centrelines.length) throw new Error(`${SB_ROADIE_TOOL}: no road centreline from Google vector data runs through the extraction (${Math.round(covered)} m).`);
        // the tree-stripped tile of this run's tree measurement, when the stage cache still has it; else the photo tiles as extracted
        const stripKey = place.stripKey;
        const stripDir = stripKey ? (() => { const dir = path.join(stagedWorkspaceRoot(), '.scratchbox', 'cache', 'tile_vegetation', stripKey); return fs.existsSync(path.join(dir, 'devegetated.glb')) ? dir : undefined; })() : undefined;
        const tileForRoads = stripDir ? path.join(stripDir, 'devegetated.glb') : extraction.texturedGlb;
        const key = stageKey('roads/v3', place.tilesKey, stripKey ?? 'scan', crypto.createHash('sha256').update(JSON.stringify(centrelines)).digest('hex').slice(0, 16), covered.toFixed(1), P.liftM, P.kerbRiseM, P.defaultHalfWidthM, P.stationM, texelM);
        const key8 = key.slice(0, 8);
        const base = `${data.stagedBuild.place.resolvedAddress.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'place'}`;
        type Value = { stats: ReturnType<typeof buildRoadMesh>['stats']; measuredKerbShare: number; photo: { width: number; height: number; texelM: number } };
        const entry = await cache.run<Value>('roads', key, async dir => {
            ctx?.reportProgress?.(`Measuring ${centrelines.length} streets kerb to kerb on the scan`);
            const scan = loadScanMesh(tileForRoads);
            const grid = { ...surfaceModel(scan, 0.5), cellM: 0.5 };
            const ground = buildGroundModel(scan, { cellMeters: 1, water: vector.waterAt, road: vector.roadAt });
            const roads = measureRoadSurfaces({ roads: centrelines, grid, within: (x, z) => Math.hypot(x, z) <= covered, buildingAt: vector.buildingAt, groundAt: ground.groundAt }, P);
            const planar = buildRoadMesh(roads, P);
            const stations = roads.reduce((n, r) => n + r.stations.length, 0);
            const measuredKerbShare = stations ? roads.reduce((n, r) => n + r.measuredKerbShare * r.stations.length, 0) / stations : 0;
            ctx?.reportProgress?.('Reading the road surfaces from the tile photo');
            const photo = renderTopDownPhoto(fs.readFileSync(tileForRoads), planar.uvFrame, { texelM, maxPx: 4096 });
            const atlas = synthesizeRoadTextures(roads, photo, planar.uvFrame);
            const mesh = buildRoadMesh(roads, P, atlas);
            const jpeg = jpegJs.encode({ data: Buffer.from(atlas.rgba.buffer, atlas.rgba.byteOffset, atlas.rgba.byteLength), width: atlas.width, height: atlas.height }, 90).data;
            writeRoadsGlb(path.join(dir, 'roads.glb'), mesh, { stats: mesh.stats, measuredKerbShare, liftM: P.liftM, params: P, markings: atlas.stats, source: 'SB-Roadie: Google vector road centrelines; kerbs, levels and camber measured on the tree-stripped photo tiles; tarmac and lane markings read along each street from the tile photo and redrawn' },
                { jpeg: Buffer.from(jpeg), width: atlas.width, height: atlas.height });
            fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify({ schema: 'scratchbox.road-surfaces/1', roads, params: P } satisfies RoadRecord & { params: RoadSurfaceParams }));
            return { value: { stats: mesh.stats, measuredKerbShare, photo: { width: atlas.width, height: atlas.height, texelM: photo.texelM } }, inputs: { params: P, texelM, centrelines: centrelines.length, tile: path.basename(tileForRoads) } };
        }, { publish: () => [{ from: 'roads.glb', as: `${base}_roads_${key8}.glb` }] });
        const roads = (JSON.parse(fs.readFileSync(path.join(entry.dir, 'roads.json'), 'utf8')) as RoadRecord).roads;
        const summary = summarize(roads);
        const pub = entry.published[0];
        const v = entry.value;
        const measured = v.measuredKerbShare >= 0.5;
        const counts = measureGlbMeshCounts(fs.readFileSync(pub.path));
        const layer: StagedLayer = {
            objectId: layerObjectId(key, 'l1r'), stage: 'roads', layer: 'l1r', order: 2, url: pub.url, bytes: pub.bytes,
            provenance: {
                label: measured ? 'measured' : VECTOR_MODELLED_LABEL, measuredGeometry: measured, confidence: v.measuredKerbShare,
                method: `SB-Roadie: ribbons swept along Google vector road centrelines through levels read low on the photo tiles at stations every ${P.stationM} m; kerbs where the scan steps up ${P.kerbRiseM} m (a default half-width of ${P.defaultHalfWidthM} m where none shows); the tile photo rendered from above as the texture`,
                sources: [{ kind: 'vector-tiles', id: `roads:${key8}` }, { kind: 'tile-extraction', id: `extract:${place.tilesKey.slice(0, 8)}` }],
                note: `${v.stats.roads} streets, ${v.stats.stations} stations; ${v.stats.measuredKerbs} kerbs measured, ${v.stats.defaultKerbs} defaulted; ${v.stats.medians} median stations; ${Math.round(v.stats.sidewalkM)} m of sidewalk; stands ${P.liftM} m above the scan`
            },
            provenanceLabels: measured ? ['measured', VECTOR_MODELLED_LABEL] : [VECTOR_MODELLED_LABEL], supersedes: [], revealAfter: [],
            reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] },
            cached: entry.cached, builtAtMs: entry.builtAtMs, counts: { vertices: counts.vertexCount, triangles: counts.triangleCount }
        };
        const meta = { source: 'GoogleVectorRoads', resolvedAddress: data.stagedBuild.place.resolvedAddress, extra: { selfTextured: true, roads: v.stats.roads, measuredKerbShare: v.measuredKerbShare, photo: v.photo, tool: SB_ROADIE_TOOL } };
        // the scene: the earlier road layer (the stage's or a previous rebuild's) replaced by this one
        const previous = data.stagedBuild.layers.filter(l => l.layer === 'l1r').map(l => l.objectId);
        const objects = (data.objects ?? []).filter(o => !previous.includes(o.id));
        objects.push(layerObject(layer, meta));
        const next: Scene3DData & { stagedBuild: StagedBuildState } = {
            ...data,
            objects,
            stagedBuild: { ...data.stagedBuild, layers: [...data.stagedBuild.layers.filter(l => l.layer !== 'l1r'), layer], updatedAtMs: Date.now() }
        };
        const text = `SB-Roadie rebuilt ${summary.streets} streets (${summary.stations} stations): ${Math.round(100 * v.measuredKerbShare)} % of kerbs found on the scan, the rest defaulted to ${2 * P.defaultHalfWidthM} m wide; ${v.stats.medians} median stations, ${Math.round(v.stats.sidewalkM)} m of sidewalk; ${counts.triangleCount.toLocaleString('en-US')} triangles, textured from the tile photo at ${v.photo.texelM} m.`;
        const artifact: CanvasArtifact = { ...place.active, data: next, summary: text, version: ((place.active as { version?: number }).version || 1) + 1 } as CanvasArtifact;
        return { resultPayload: { success: true, action, ...summary, params: P, texelM, layer: { objectId: layer.objectId, url: layer.url, triangles: counts.triangleCount, provenance: layer.provenance.label }, cached: entry.cached, artifact }, summaryResult: text };
    }
};
