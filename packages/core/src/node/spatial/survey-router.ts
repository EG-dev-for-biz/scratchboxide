/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySynthesisEngine } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor, SurveyPatternConfig } from '../../common/spatial/colmap-vector-reference-types';
import { AdaptiveSurveyRigService } from './AdaptiveSurveyRigService';
import { SurveyStationRenderService } from './SurveyStationRenderService';
import { BeautifyStationService, describeStationImageSource, type StationImageGenerator } from './BeautifyStationService';
import { SurveySplatPipelineService } from './SurveySplatPipelineService';
import { Google3DTileService } from '../../browser/generative-canvas/services/Google3DTileService';
import { extractLocationAndEraFromContext } from '../../browser/generative-canvas/services/location-beautify-service';

/**
 * Framework-agnostic handlers for the Survey Synthesis API, mounted by the desktop server at
 * /api/3d/survey via createSurveyRouter(). Kept free of express types so vitest can call the
 * handlers directly and so the same functions back the Gemini agent tools.
 *
 * Long-running operations (beautify, splat tiling) run as jobs: POST returns { jobId }, and
 * GET /jobs/:id reports progress and the final result.
 */

export interface SurveyJob {
    id: string;
    kind: string;
    status: 'queued' | 'running' | 'done' | 'error';
    progress: number;           // 0..1
    message?: string;
    createdAt: number;
    updatedAt: number;
    result?: any;
    error?: string;
}

export interface SurveyApiDeps {
    /** Resolves a query/anchor to a clay GLB on disk (wraps getGoogle3DTilesClay). Optional so the API works offline. */
    fetchClayGlb?: (query: string | GeodeticAnchor, options?: Record<string, any>) => Promise<{ glbPath: string; glbUrl?: string; mesh?: any; geoAnchor?: any; resolvedAddress?: string; quality?: any; mode?: string }>;
    /** Root directory that glbPath arguments must live under (path traversal guard). */
    workspaceRoot?: string;
    /** Registered by later phases: beautify one station / whole batch to splat tiles. */
    beautifyStation?: (args: any, report: (p: number, msg?: string) => void) => Promise<any>;
    beautifyToSplats?: (args: any, report: (p: number, msg?: string) => void) => Promise<any>;
    rerunPipeline?: (args: any, report: (p: number, msg?: string) => void) => Promise<any>;
}

/**
 * Resolves preset geographic locations (Colosseum, Empire State, Grand Army Plaza)
 * into canonical anchors, foveated survey camera patterns, and bounding crop parameters
 * when shorthand location keys are provided from the demo workbench.
 */
export function resolveSurveyPreset(args: any, workspaceRoot: string): {
    glbPath: string;
    outDir: string;
    anchor: GeodeticAnchor;
    stations: ColmapCameraPose[];
    beautify: { locationName: string; architecturalStyle?: string; moodPromptContext?: string; styleSuffix?: string };
    cropRadius?: number;
    cropBox?: { min: [number, number, number]; max: [number, number, number] };
    sigmaScale?: number;
    voxelSizeMeters?: number;
    erodeSilhouettePx?: number;
    dropInconsistent?: boolean;
    colorConsistencyThresh?: number;
} {
    const loc = (args?.location || args?.activeModel || '').toLowerCase();
    const engine = new SurveySynthesisEngine();

    if (loc.includes('colosseum')) {
        const anchor: GeodeticAnchor = {
            lat: 41.8902,
            lng: 12.4922,
            elevationMeters: 22.0,
            headingDeg: 0,
            formattedAddress: 'Colosseum, Rome'
        };
        const colosseumCenterENU: [number, number, number] = [-43.42, 24.0, 62.54];
        const lookAt = args?.lookAtOffsetLocalENU || colosseumCenterENU;

        const isGeoSurvey = args?.surveyPattern === 'geographic-3dtiles-survey';
        const isCompleteAmphitheatre = args?.surveyPattern === 'amphitheatre-complete' ||
            args?.surveyPreset === 'watertight-112' ||
            args?.surveyPreset === 'interior-pilot-40' ||
            (typeof args?.cameraCount === 'number' && args.cameraCount > 24);

        const cameraCount = typeof args?.cameraCount === 'number'
            ? args.cameraCount
            : (args?.surveyPreset === 'watertight-112' ? 112 : (args?.surveyPreset === 'interior-pilot-40' ? 40 : 24));

        const glb = fs.existsSync(path.resolve(workspaceRoot, 'public/models/colosseum_grounded.glb'))
            ? 'public/models/colosseum_grounded.glb'
            : 'public/models/colosseum_clay.glb';
        const glbAbs = path.resolve(workspaceRoot, args?.glbPath || glb);

        let stations: ColmapCameraPose[];
        if (args?.stations && args.stations.length) {
            stations = args.stations;
        } else if (args?.useAdaptiveRig !== false && fs.existsSync(glbAbs) && (args?.surveyPattern === 'adaptive-scene-aware' || isCompleteAmphitheatre)) {
            const adaptiveResult = AdaptiveSurveyRigService.planRig(glbAbs, {
                anchor,
                cameraBudget: cameraCount,
                mode: 'multitier-complete',
                focalLengthMm: 35,
                targetResolutionMm: 2.5,
                focusCentroid: lookAt,
                cropRadius: args?.cropRadius ?? 120.0
            });
            stations = adaptiveResult.poses;
        } else {
            stations = isGeoSurvey
                ? engine.synthesize(anchor, {
                    type: 'geographic-3dtiles-survey',
                    cameraCount,
                    targetRadiusMeters: 130,
                    focalLengthMm: 35,
                    lookAtOffsetLocalENU: lookAt
                })
                : isCompleteAmphitheatre
                ? engine.synthesize(anchor, {
                    type: 'amphitheatre-complete',
                    cameraCount,
                    targetRadiusMeters: 150,
                    aspectRatioXZ: 1.18,
                    lookAtOffsetLocalENU: lookAt
                })
                : engine.synthesize(anchor, {
                    type: 'foveated-multi-tier',
                    cameraCount: 24,
                    targetRadiusMeters: 150,
                    tierRadiiMeters: [110, 130, 180],
                    altitudeTiersMeters: [
                        anchor.elevationMeters + 3.0,
                        anchor.elevationMeters + 30.0,
                        anchor.elevationMeters + 75.0
                    ],
                    lookAtOffsetLocalENU: lookAt,
                    lookAtTiersOffsetLocalENU: [
                        [lookAt[0], 6.0 + (lookAt[1] - 20.0), lookAt[2]],
                        [lookAt[0], 28.0 + (lookAt[1] - 20.0), lookAt[2]],
                        [lookAt[0], 20.0 + (lookAt[1] - 20.0), lookAt[2]]
                    ]
                });
        }
        return {
            glbPath: args?.glbPath || glb,
            outDir: args?.outDir || 'public/tilesets/colosseum',
            anchor: args?.anchor || anchor,
            stations: args?.stations && args.stations.length ? args.stations : stations,
            beautify: {
                locationName: 'Rome Colosseum',
                architecturalStyle: 'Ancient Roman travertine limestone amphitheatre with arched arcades, Corinthian columns, and authentic Roman masonry under warm Mediterranean sunlight',
                ...(args?.beautify || {})
            },
            cropRadius: args?.cropRadius ?? 140.0,
            cropBox: args?.cropBox || {
                min: [lookAt[0] - 115.0, -0.5, lookAt[2] - 115.0],
                max: [lookAt[0] + 115.0, 55.0, lookAt[2] + 115.0]
            },
            sigmaScale: args?.sigmaScale ?? 0.5,
            voxelSizeMeters: args?.voxelSizeMeters ?? 0.05,
            erodeSilhouettePx: args?.erodeSilhouettePx ?? 2,
            dropInconsistent: args?.dropInconsistent ?? true,
            colorConsistencyThresh: args?.colorConsistencyThresh ?? 40.0
        };
    } else if (loc.includes('esb') || loc.includes('empire')) {
        const anchor: GeodeticAnchor = {
            lat: 40.7484,
            lng: -73.9857,
            elevationMeters: 15.0,
            headingDeg: 0,
            formattedAddress: 'Empire State Building, New York'
        };
        const stations = engine.synthesize(anchor, {
            type: 'orbital-multi-tier',
            cameraCount: 24,
            targetRadiusMeters: 120,
            tierRadiiMeters: [80, 120, 160],
            altitudeTiersMeters: [
                anchor.elevationMeters + 5.0,
                anchor.elevationMeters + 120.0,
                anchor.elevationMeters + 350.0
            ],
            lookAtOffsetLocalENU: [0, 180, 0],
            lookAtTiersOffsetLocalENU: [
                [0, 20, 0],
                [0, 150, 0],
                [0, 320, 0]
            ]
        });
        const glb = fs.existsSync(path.resolve(workspaceRoot, 'public/models/esb_grounded.glb'))
            ? 'public/models/esb_grounded.glb'
            : 'public/models/esb_clay.glb';
        return {
            glbPath: args?.glbPath || glb,
            outDir: args?.outDir || 'public/tilesets/esb',
            anchor: args?.anchor || anchor,
            stations: args?.stations && args.stations.length ? args.stations : stations,
            beautify: {
                locationName: 'Empire State Building',
                architecturalStyle: 'Art Deco limestone skyscraper with vertical piers, stainless steel crown spire, and Manhattan streetscape under crisp morning illumination',
                ...(args?.beautify || {})
            },
            cropRadius: args?.cropRadius ?? 150.0,
            sigmaScale: args?.sigmaScale ?? 0.8,
            voxelSizeMeters: args?.voxelSizeMeters ?? 0.15
        };
    } else if (loc.includes('gap') || loc.includes('plaza') || loc.includes('grand')) {
        const anchor: GeodeticAnchor = {
            lat: 40.7648,
            lng: -73.9733,
            elevationMeters: 20.0,
            headingDeg: 0,
            formattedAddress: 'Grand Army Plaza, New York'
        };
        const stations = engine.synthesize(anchor, {
            type: 'orbital-multi-tier',
            cameraCount: 18,
            targetRadiusMeters: 55,
            tierRadiiMeters: [38, 55, 80],
            altitudeTiersMeters: [
                anchor.elevationMeters + 2.0,
                anchor.elevationMeters + 10.0,
                anchor.elevationMeters + 26.0
            ],
            lookAtOffsetLocalENU: [0, 10, 0],
            lookAtTiersOffsetLocalENU: [
                [0, 4, 0],
                [0, 10, 0],
                [0, 14, 0]
            ]
        });
        const glb = fs.existsSync(path.resolve(workspaceRoot, 'public/models/gap_grounded.glb'))
            ? 'public/models/gap_grounded.glb'
            : 'public/models/gap_clay.glb';
        return {
            glbPath: args?.glbPath || glb,
            outDir: args?.outDir || 'public/tilesets/gap',
            anchor: args?.anchor || anchor,
            stations: args?.stations && args.stations.length ? args.stations : stations,
            beautify: {
                locationName: 'Grand Army Plaza',
                architecturalStyle: 'Beaux-Arts neoclassical plaza with Pulitzer Fountain, gilded bronze Pomona statue, limestone balustrades, and Manhattan Fifth Avenue context under late afternoon sun',
                ...(args?.beautify || {})
            },
            cropRadius: args?.cropRadius ?? 90.0,
            sigmaScale: args?.sigmaScale ?? 0.5,
            voxelSizeMeters: args?.voxelSizeMeters ?? 0.08
        };
    }

    // Dynamic resolution for any real-world location (e.g. Sydney Opera House, Eiffel Tower, Taj Mahal, Pantheon, or coordinates)
    const rawLoc = args?.location || args?.activeModel || '';
    const resolvedGeo = Google3DTileService.getInstance().resolveLocationSync(
        args?.anchor
            ? args.anchor
            : (args?.lat !== undefined && args?.lng !== undefined
                ? { lat: args.lat, lng: args.lng, elevation: args.elevationMeters }
                : (rawLoc || 'Survey Target'))
    );

    const anchor: GeodeticAnchor = args?.anchor || {
        lat: resolvedGeo.lat,
        lng: resolvedGeo.lng,
        elevationMeters: resolvedGeo.elevation,
        headingDeg: args?.headingDeg || 0,
        formattedAddress: resolvedGeo.formattedAddress || resolvedGeo.landmarkName || rawLoc || 'Survey Target'
    };

    const locName = rawLoc || resolvedGeo.landmarkName || 'Survey Target';
    const sanitizedName = locName.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    const cand1 = path.resolve(workspaceRoot, `public/models/${sanitizedName}_grounded.glb`);
    const cand2 = path.resolve(workspaceRoot, `public/models/${sanitizedName}_clay.glb`);
    const cand3 = path.resolve(workspaceRoot, `public/models/${sanitizedName}.glb`);
    const defaultBox = path.resolve(workspaceRoot, 'public/models/survey_box_ground.glb');

    const glb = args?.glbPath || (fs.existsSync(cand1)
        ? `public/models/${sanitizedName}_grounded.glb`
        : (fs.existsSync(cand2)
            ? `public/models/${sanitizedName}_clay.glb`
            : (fs.existsSync(cand3)
                ? `public/models/${sanitizedName}.glb`
                : (fs.existsSync(defaultBox) ? 'public/models/survey_box_ground.glb' : `public/models/${sanitizedName}_clay.glb`))));

    const extractedEra = extractLocationAndEraFromContext(locName);
    const radius = args?.cropRadius ?? 75.0;

    const stations = args?.stations && args.stations.length ? args.stations : engine.synthesize(anchor, {
        type: 'orbital-multi-tier',
        cameraCount: args?.cameraCount || 16,
        targetRadiusMeters: radius,
        altitudeTiersMeters: [
            anchor.elevationMeters + 4.0,
            anchor.elevationMeters + 20.0,
            anchor.elevationMeters + 45.0
        ],
        lookAtOffsetLocalENU: [0, 15, 0]
    });

    return {
        glbPath: glb,
        outDir: args?.outDir || `public/tilesets/${sanitizedName}`,
        anchor,
        stations,
        beautify: {
            locationName: locName,
            architecturalStyle: extractedEra.eraContext || `${locName} architectural structure`,
            stylePreset: extractedEra.stylePreset,
            // In accordance with style neutrality directive: extra injections into the prompt
            // should only happen in {styleSuffix}, and remain empty unless explicitly prompted by the user.
            moodPromptContext: args?.beautify?.moodPromptContext || '',
            styleSuffix: args?.beautify?.styleSuffix || '',
            ...(args?.beautify || {})
        },
        cropRadius: radius,
        cropBox: args?.cropBox || { min: [-radius, -0.5, -radius], max: [radius, 55.0, radius] },
        sigmaScale: args?.sigmaScale ?? 0.6,
        voxelSizeMeters: args?.voxelSizeMeters ?? 0.08,
        erodeSilhouettePx: args?.erodeSilhouettePx ?? 2,
        dropInconsistent: args?.dropInconsistent ?? true,
        colorConsistencyThresh: args?.colorConsistencyThresh ?? 40.0
    };
}

/**
 * Wires the beautify job handlers onto a SurveyApi given an image generator. Kept separate so
 * servers without Google credentials can still serve synthesis/render/export.
 */
export function registerBeautifyHandlers(deps: SurveyApiDeps, generator: StationImageGenerator, workspaceRoot: string): SurveyApiDeps {
    const resolveGlb = (glbPath: string) => path.isAbsolute(glbPath) ? glbPath : path.resolve(workspaceRoot, glbPath);
    deps.beautifyStation = async (args, report) => {
        if (!args?.glbPath || !args?.station) throw new Error('glbPath and station are required');
        report(0.05, 'Rendering blockout');
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(resolveGlb(args.glbPath));
        const [station] = renderer.enrichStations([args.station], { isoDate: args.isoDate });
        const svc = new BeautifyStationService(renderer, generator);
        report(0.2, `Generating with ${generator.name}`);
        const res = await svc.beautify(station, { locationName: args.locationName || args.anchor?.formattedAddress || 'the location', moodPromptContext: args.moodPromptContext, styleSuffix: args.styleSuffix }, { width: args.width ?? 1920, maxRerolls: args.maxRerolls, signal: args.signal });
        const outDir = path.resolve(workspaceRoot, args.outDir || `build/beautify_stations/${Date.now()}`);
        await fs.outputFile(path.join(outDir, `station_${station.id}_blockout.png`), res.blockout.png);
        await fs.outputFile(path.join(outDir, `station_${station.id}_beautified.png`), res.imagePng);
        report(1, res.accepted ? 'Accepted' : `Rejected: ${res.qc.reason}`);
        return { stationId: station.id, accepted: res.accepted, attempts: res.attempts, qc: res.qc, prompt: res.prompt, imageBase64: res.imagePng.toString('base64'), imagePath: path.join(outDir, `station_${station.id}_beautified.png`), blockoutPath: path.join(outDir, `station_${station.id}_blockout.png`), alignedStation: res.alignedStation, modelUsed: res.modelUsed, imageSource: describeStationImageSource(res) };
    };

    const runSurveyPipeline = async (args: any, report: (p: number, msg?: string) => void) => {
        let preset: ReturnType<typeof resolveSurveyPreset> | null = null;
        if (!args?.glbPath || !Array.isArray(args?.stations) || args.stations.length === 0 || !args?.anchor) {
            preset = resolveSurveyPreset(args, workspaceRoot);
        }
        const glbPath = resolveGlb(args?.glbPath || preset!.glbPath);
        const anchor = args?.anchor || preset!.anchor;
        const stations = (args?.stations && args.stations.length) ? args.stations : preset!.stations;
        const outDir = path.resolve(workspaceRoot, args?.outDir || preset?.outDir || `public/tilesets/survey_${Date.now()}`);
        const beautify = {
            locationName: args?.locationName || preset?.beautify?.locationName || anchor.formattedAddress || 'the location',
            architecturalStyle: args?.architecturalStyle || preset?.beautify?.architecturalStyle,
            // In accordance with style neutrality directive: extra injections into the prompt
            // should only happen in {styleSuffix}, and remain empty unless explicitly prompted by the user.
            moodPromptContext: args?.moodPromptContext || args?.beautify?.moodPromptContext || '',
            styleSuffix: args?.styleSuffix || args?.beautify?.styleSuffix || ''
        };

        const svc = new SurveySplatPipelineService({ generator });
        const res = await svc.run({
            glbPath,
            anchor,
            stations,
            outDir,
            beautify,
            mode: args?.mode ?? 'chained',
            maxStations: args?.maxStations,
            renderWidth: args?.width || args?.renderWidth || 1920,
            bakeStride: args?.bakeStride,
            isoDate: args?.isoDate,
            headingDeg: args?.headingDeg,
            maxRerolls: args?.maxRerolls,
            // Calibrated splat parameters forwarded to C++ station_to_splats & octree voxel fusion
            sigmaScale: args?.sigmaScale ?? preset?.sigmaScale,
            voxelSizeMeters: args?.voxelSizeMeters ?? preset?.voxelSizeMeters,
            forceRebake: args?.forceRebake !== false,
            clean: args?.clean ?? false,
            cropRadius: args?.cropRadius ?? preset?.cropRadius,
            cropBox: args?.cropBox ?? preset?.cropBox,
            erodeSilhouettePx: args?.erodeSilhouettePx ?? preset?.erodeSilhouettePx,
            dropInconsistent: args?.dropInconsistent ?? preset?.dropInconsistent,
            colorConsistencyThresh: args?.colorConsistencyThresh ?? preset?.colorConsistencyThresh,
            dropFoliage: args?.dropFoliage,
            enableHybridMicroDepth: args?.enableHybridMicroDepth,
            enablePhotometricMicroDepth: args?.enablePhotometricMicroDepth,
            use2dgs: args?.use2dgs === true || args?.surfaceModel === 'planar',
            surfaceModel: args?.surfaceModel,
            shDegree: args?.shDegree !== undefined ? parseInt(args.shDegree, 10) : undefined,
            exposureScale: args?.exposureScale !== undefined ? parseFloat(args.exposureScale) : undefined,
            // The caller's Stop (a tool call's ctx.signal): the pipeline stops between stations and inside them.
            signal: args?.signal
        }, report);

        if (!res.success) throw new Error(res.error || 'pipeline failed');
        const publicRoot = path.resolve(workspaceRoot, 'public');
        const rel = path.relative(publicRoot, res.tilesetPath);
        return {
            ...res,
            tilesetUrl: rel && !rel.startsWith('..') ? '/' + rel.split(path.sep).join('/') : undefined
        };
    };

    deps.beautifyToSplats = runSurveyPipeline;
    deps.rerunPipeline = runSurveyPipeline;
    return deps;
}

export class SurveyApi {
    readonly engine = new SurveySynthesisEngine();
    private jobs = new Map<string, SurveyJob>();
    private renderers = new Map<string, SurveyStationRenderService>();

    constructor(readonly deps: SurveyApiDeps = {}) {}

    // ---- helpers ----

    private resolveGlb(glbPath: string): string {
        const root = this.deps.workspaceRoot || process.cwd();
        const abs = path.isAbsolute(glbPath) ? glbPath : path.resolve(root, glbPath);
        const rel = path.relative(root, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`glbPath must be inside the workspace: ${glbPath}`);
        if (!fs.existsSync(abs)) throw new Error(`GLB not found: ${glbPath}`);
        return abs;
    }

    private async rendererFor(glbPath: string): Promise<SurveyStationRenderService> {
        const abs = this.resolveGlb(glbPath);
        const key = `${abs}:${fs.statSync(abs).mtimeMs}`;
        let r = this.renderers.get(key);
        if (!r) {
            r = new SurveyStationRenderService();
            await r.loadMesh(abs);
            this.renderers.set(key, r);
            if (this.renderers.size > 4) this.renderers.delete(this.renderers.keys().next().value!);
        }
        return r;
    }

    private static anchorFrom(body: any): GeodeticAnchor {
        const a = body?.anchor;
        if (!a || typeof a.lat !== 'number' || typeof a.lng !== 'number') {
            throw new Error('anchor { lat, lng, elevationMeters?, headingDeg? } is required (zero presets: no default location)');
        }
        return { lat: a.lat, lng: a.lng, elevationMeters: a.elevationMeters ?? 0, headingDeg: a.headingDeg ?? 0, formattedAddress: a.formattedAddress || `${a.lat.toFixed(6)}, ${a.lng.toFixed(6)}` };
    }

    private startJob(kind: string, run: (report: (p: number, msg?: string) => void) => Promise<any>): SurveyJob {
        const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const job: SurveyJob = { id, kind, status: 'queued', progress: 0, createdAt: Date.now(), updatedAt: Date.now() };
        this.jobs.set(id, job);
        const report = (p: number, msg?: string) => { job.progress = Math.max(0, Math.min(1, p)); if (msg) job.message = msg; job.updatedAt = Date.now(); };
        setImmediate(async () => {
            job.status = 'running'; job.updatedAt = Date.now();
            try { job.result = await run(report); job.status = 'done'; job.progress = 1; }
            catch (e: any) { job.status = 'error'; job.error = e?.message || String(e); }
            job.updatedAt = Date.now();
        });
        return job;
    }

    // ---- handlers ----

    /** POST /synthesize { anchor, config, glbPath?, isoDate?, rankMaxCount? } */
    async synthesize(body: any) {
        const anchor = SurveyApi.anchorFrom(body);
        const config: SurveyPatternConfig = body?.config;
        if (!config || !config.type) throw new Error('config { type, targetRadiusMeters, cameraCount, ... } is required');
        let poses = this.engine.synthesize(anchor, config);
        let enriched = false;
        if (body?.glbPath) {
            const r = await this.rendererFor(body.glbPath);
            poses = r.enrichStations(poses, { isoDate: body.isoDate });
            enriched = true;
        }
        const ranked = typeof body?.rankMaxCount === 'number' ? this.engine.rankForBeautify(poses, { maxCount: body.rankMaxCount }).map(p => p.id) : undefined;
        return {
            success: true, anchor, poses, enriched, rankedStationIds: ranked,
            geoJson: this.engine.toGeoJson(poses, anchor),
            stats: { stationCount: poses.length, boundingRadiusMeters: Number(Math.max(...poses.map(p => Math.hypot(p.positionLocalENU[0], p.positionLocalENU[2]))).toFixed(2)) }
        };
    }

    /** POST /plan-adaptive { glbPath, anchor?, cameraBudget?, mode?, focalLengthMm?, targetResolutionMm?, standoffMeters?, minGroundClearanceMeters? } */
    async planAdaptive(body: any) {
        if (!body?.glbPath) throw new Error('glbPath is required for adaptive survey rig planning');
        const absGlb = this.resolveGlb(body.glbPath);
        const anchor = body?.anchor ? SurveyApi.anchorFrom(body) : undefined;
        const result = AdaptiveSurveyRigService.planRig(absGlb, {
            anchor,
            cameraBudget: body?.cameraBudget,
            mode: body?.mode,
            focalLengthMm: body?.focalLengthMm,
            targetResolutionMm: body?.targetResolutionMm,
            standoffMeters: body?.standoffMeters,
            minGroundClearanceMeters: body?.minGroundClearanceMeters,
            renderWidth: body?.renderWidth,
            renderHeight: body?.renderHeight,
            focusCentroid: body?.focusCentroid
        });
        const safeAnchor = (result.poses[0] as any)?.metadata?.anchor || anchor || { lat: 0, lng: 0, elevationMeters: 0, headingDeg: 0 };
        const geoJson = this.engine.toGeoJson(result.poses, safeAnchor);
        return {
            success: true,
            ...result,
            geoJson
        };
    }

    /** POST /enrich { poses, glbPath, isoDate? } */
    async enrich(body: any) {
        const poses: ColmapCameraPose[] = body?.poses;
        if (!Array.isArray(poses) || poses.length === 0) throw new Error('poses[] is required');
        if (!body?.glbPath) throw new Error('glbPath is required');
        const r = await this.rendererFor(body.glbPath);
        return { success: true, poses: r.enrichStations(poses, { isoDate: body.isoDate }), meshBounds: r.getMeshBounds() };
    }

    /** POST /rank { poses, maxCount, minMeshCoverage?, maxSkyFraction? } */
    rank(body: any) {
        const poses: ColmapCameraPose[] = body?.poses;
        if (!Array.isArray(poses)) throw new Error('poses[] is required');
        const ranked = this.engine.rankForBeautify(poses, { maxCount: body?.maxCount ?? 8, minMeshCoverage: body?.minMeshCoverage, maxSkyFraction: body?.maxSkyFraction });
        return { success: true, ranked, rankedStationIds: ranked.map(p => p.id) };
    }

    /** POST /export-colmap { poses, width?, height? } */
    exportColmap(body: any) {
        const poses: ColmapCameraPose[] = body?.poses;
        if (!Array.isArray(poses) || poses.length === 0) throw new Error('poses[] is required');
        const out = this.engine.toColmapText(poses, { width: body?.width ?? 1920, height: body?.height ?? 1080 });
        return { success: true, ...out };
    }

    /** POST /clay { query | anchor, options? } -> clay GLB on disk */
    async clay(body: any) {
        if (!this.deps.fetchClayGlb) throw new Error('Clay ingestion is not configured on this server (getGoogle3DTilesClay unavailable)');
        const query = body?.query || (body?.anchor ? SurveyApi.anchorFrom(body) : undefined);
        if (!query) throw new Error('query or anchor is required');
        const res = await this.deps.fetchClayGlb(query, body?.options);
        return { success: true, glbPath: res.glbPath, glbUrl: res.glbUrl, mesh: res.mesh, geoAnchor: res.geoAnchor, resolvedAddress: res.resolvedAddress, quality: res.quality, mode: res.mode };
    }

    /** POST /render-station { glbPath, station, width?, height?, outPath? } -> PNG (base64) + intrinsics + depth stats */
    async renderStation(body: any) {
        if (!body?.glbPath || !body?.station) throw new Error('glbPath and station are required');
        const r = await this.rendererFor(body.glbPath);
        const render = r.renderStationBlockout(body.station, { width: body.width ?? 1280, height: body.height });
        let filled = 0, minD = Infinity, maxD = 0;
        for (let i = 0; i < render.depth.length; i++) { const d = render.depth[i]; if (d < 1e8) { filled++; if (d < minD) minD = d; if (d > maxD) maxD = d; } }
        if (body?.outPath) {
            const abs = path.isAbsolute(body.outPath) ? body.outPath : path.resolve(this.deps.workspaceRoot || process.cwd(), body.outPath);
            await fs.outputFile(abs, render.png);
        }
        return {
            success: true, stationId: render.stationId, width: render.width, height: render.height,
            pngBase64: render.png.toString('base64'), intrinsics: render.intrinsics, cameraPose: render.cameraPose,
            depthKind: render.depthKind, depthStats: { filledFraction: filled / render.depth.length, minMeters: filled ? minD : null, maxMeters: filled ? maxD : null }
        };
    }

    /** POST /beautify-station -> job */
    beautifyStation(body: any): SurveyJob {
        if (!this.deps.beautifyStation) throw new Error('beautify-station is not available yet on this server');
        return this.startJob('beautify-station', (report) => this.deps.beautifyStation!(body, report));
    }

    /** POST /beautify-to-splats -> job */
    beautifyToSplats(body: any): SurveyJob {
        if (!this.deps.beautifyToSplats) throw new Error('beautify-to-splats is not available yet on this server');
        return this.startJob('beautify-to-splats', (report) => this.deps.beautifyToSplats!(body, report));
    }

    /** POST /rerun-pipeline -> job */
    rerunPipeline(body: any): SurveyJob {
        if (this.deps.rerunPipeline) {
            return this.startJob('rerun-pipeline', (report) => this.deps.rerunPipeline!(body, report));
        }
        return this.beautifyToSplats(body);
    }

    /** GET /jobs/:id */
    job(id: string): SurveyJob | undefined { return this.jobs.get(id); }

    /** GET /jobs */
    listJobs(): SurveyJob[] { return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50); }
}

/**
 * Builds an express Router over SurveyApi. `express` is passed in to keep this module free of a
 * hard dependency (core is also consumed in the browser bundle).
 */
export function createSurveyRouter(express: any, api: SurveyApi) {
    const router = express.Router();
    const wrap = (fn: (body: any, req: any) => any) => async (req: any, res: any) => {
        try { res.json(await fn(req.body || {}, req)); }
        catch (e: any) { res.status(400).json({ success: false, error: e?.message || String(e) }); }
    };
    router.get('/status', (_req: any, res: any) => res.json({ success: true, service: 'survey-synthesis', clay: !!(api as any).deps?.fetchClayGlb, beautify: !!(api as any).deps?.beautifyStation }));
    router.post('/synthesize', wrap(b => api.synthesize(b)));
    router.post('/plan-adaptive', wrap(b => api.planAdaptive(b)));
    router.post('/enrich', wrap(b => api.enrich(b)));
    router.post('/rank', wrap(b => api.rank(b)));
    router.post('/export-colmap', wrap(b => api.exportColmap(b)));
    router.post('/clay', wrap(b => api.clay(b)));
    router.post('/render-station', wrap(b => api.renderStation(b)));
    router.post('/beautify-station', wrap(b => ({ success: true, job: api.beautifyStation(b) })));
    router.post('/beautify-to-splats', wrap(b => ({ success: true, job: api.beautifyToSplats(b) })));
    router.post('/rerun-pipeline', wrap(b => ({ success: true, job: api.rerunPipeline(b) })));
    router.get('/jobs', (_req: any, res: any) => res.json({ success: true, jobs: api.listJobs() }));
    router.get('/jobs/:id', (req: any, res: any) => {
        const job = api.job(req.params.id);
        if (!job) return res.status(404).json({ success: false, error: 'job not found' });
        res.json({ success: true, job });
    });
    return router;
}

/**
 * Minimal Node http adapter with the same routes as createSurveyRouter (used by tests and by
 * environments without express).
 */
export function createNodeHttpHandler(api: SurveyApi, prefix = '/api/3d/survey') {
    const send = (res: any, status: number, body: any) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    return async (req: any, res: any) => {
        const url = new URL(req.url || '/', 'http://local');
        if (!url.pathname.startsWith(prefix)) return send(res, 404, { success: false, error: 'not found' });
        const route = url.pathname.slice(prefix.length) || '/';
        let body: any = {};
        if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c);
            try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(res, 400, { success: false, error: 'invalid JSON' }); }
        }
        try {
            if (req.method === 'GET' && route === '/status') return send(res, 200, { success: true, service: 'survey-synthesis', clay: !!(api as any).deps?.fetchClayGlb, beautify: !!(api as any).deps?.beautifyStation });
            if (req.method === 'GET' && route === '/jobs') return send(res, 200, { success: true, jobs: api.listJobs() });
            if (req.method === 'GET' && route.startsWith('/jobs/')) { const j = api.job(route.slice(6)); return j ? send(res, 200, { success: true, job: j }) : send(res, 404, { success: false, error: 'job not found' }); }
            if (req.method === 'POST') {
                switch (route) {
                    case '/synthesize': return send(res, 200, await api.synthesize(body));
                    case '/plan-adaptive': return send(res, 200, await api.planAdaptive(body));
                    case '/enrich': return send(res, 200, await api.enrich(body));
                    case '/rank': return send(res, 200, api.rank(body));
                    case '/export-colmap': return send(res, 200, api.exportColmap(body));
                    case '/clay': return send(res, 200, await api.clay(body));
                    case '/render-station': return send(res, 200, await api.renderStation(body));
                    case '/beautify-station': return send(res, 200, { success: true, job: api.beautifyStation(body) });
                    case '/beautify-to-splats': return send(res, 200, { success: true, job: api.beautifyToSplats(body) });
                    case '/rerun-pipeline': return send(res, 200, { success: true, job: api.rerunPipeline(body) });
                }
            }
            return send(res, 404, { success: false, error: 'not found' });
        } catch (e: any) {
            return send(res, 400, { success: false, error: e?.message || String(e) });
        }
    };
}
