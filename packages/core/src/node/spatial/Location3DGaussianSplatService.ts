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
import { SurveySplatPipelineService } from './SurveySplatPipelineService';
import { GeneratorFailedError, TileExtractionError } from '../../common/errors/pipeline-errors';
import { SurveySynthesisEngine } from '../../common/spatial/SurveySynthesisEngine';
import {
    createDefaultStationImageGenerator,
    type StationImageGenerator
} from './BeautifyStationService';
import { resolveSurveyPreset } from './survey-router';
import { getGoogle3DTilesClay } from './Google3DTileBlockoutPipelineService';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import type { Scene3DData, Media4DObject } from '../../browser/generative-canvas/canvas-types';

export interface Location3DGSRequest {
    location: string;
    /** A clay GLB already extracted for this place (e.g. by google_3d_tiles_get_clay). Without it the place is extracted fresh. */
    glbPath?: string;
    lat?: number;
    lng?: number;
    elevation?: number;
    headingDeg?: number;
    stylePreset?: string;
    architecturalStyle?: string;
    mood?: 'dawn' | 'golden-hour' | 'midday' | 'overcast' | 'dusk' | 'night' | string;
    moodPromptContext?: string;
    styleSuffix?: string;
    cameraCount?: number;
    outDir?: string;
    width?: number;
    bakeStride?: number;
    sigmaScale?: number;
    voxelSizeMeters?: number;
    cropRadius?: number;
    cropBox?: { min: [number, number, number]; max: [number, number, number] };
    forceRebake?: boolean;
    clean?: boolean;
    use2dgs?: boolean;
    surfaceModel?: 'planar' | 'ellipsoid';
    shDegree?: number;
    exposureScale?: number;
    generator?: StationImageGenerator;
    workspaceRoot?: string;
    surveyPattern?: 'orbital-multi-tier' | 'foveated-multi-tier' | 'amphitheatre-complete' | 'facade-strip' | 'street-promenade' | string;
    surveyPatternConfig?: any;
    stoneType?: string;
    renderProvider?: 'software-clay' | 'pathtracer';
    /** Render mode for station input: 'textured' (full GLB photogrammetric PBR textures) or 'clay' (studio grey). Default 'clay'. */
    renderMode?: 'clay' | 'textured' | 'albedo';
    /** Fast generation using Nano Banana Lite / 1K resolution and empty default style suffix */
    draft?: boolean;
    /** Generation fidelity tier */
    fidelity?: 'draft' | 'production';
    onProgress?: (progress: number, message?: string) => void;
}

export interface Location3DGSResult {
    success: boolean;
    locationName: string;
    geoAnchor: GeodeticAnchor;
    splatPath: string;
    splatUrl: string;
    tilesetPath: string;
    tilesetUrl: string;
    metaPath: string;
    splatCount: number;
    stationCount: number;
    scene3DData: Scene3DData;
    cropBox: { min: [number, number, number]; max: [number, number, number] };
    durationMs: number;
    /** The clay tiles the survey rendered (the caller's GLB, or the fresh extraction). */
    glbPath: string;
    /** Stations whose generated image passed geometry QC and was baked into splats. */
    acceptedStations: number;
    /** Image models that made the station images. */
    modelsUsed: string[];
    /** One line per distinct station image source: the model that answered and, when another was asked for, why. */
    imageSources: string[];
}

/**
 * Location3DGaussianSplatService (Canonical Location 3DGS Service)
 *
 * End-to-end autonomous service that synthesizes a high-fidelity 3D Gaussian Splat (3DGS)
 * of any real-world location or landmark. The pipeline automatically orchestrates:
 *   1. Google 3D Tiles grounded mesh ingestion & anchor resolution
 *   2. Multi-tier camera survey synthesis & pinhole blockout rendering
 *   3. Autonomous Nano Banana multi-view restyling with closed-loop Sobel edge alignment QC
 *   4. Chained forward-warp projective consistency across viewpoints
 *   5. Native C++20 metric depth unprojection & spatial voxel-hash fusion (station_to_splats.cpp)
 *   6. OGC 3D Tiles 1.1 packaging (KHR_gaussian_splatting & Niantic SPZ v2)
 *   7. Interactive Scene3DData packaging for direct Three.js 3D viewport rendering.
 *
 * The caller never has to explicitly invoke or mention Nano Banana — it is the built-in
 * standard restyling engine of our pipeline.
 */
export class Location3DGaussianSplatService {
    private workspaceRoot: string;

    constructor(options: { workspaceRoot?: string } = {}) {
        this.workspaceRoot = options.workspaceRoot || process.cwd();
    }

    /**
     * Resolves an absolute path within workspace to a public web URL.
     */
    private toWebUrl(filePath: string): string {
        return SurveySplatPipelineService.toWebUrl(filePath);
    }

    /**
     * Executes the complete end-to-end Location 3DGS pipeline.
     */
    public async synthesize(req: Location3DGSRequest): Promise<Location3DGSResult> {
        return this.generate(req);
    }

    public async generate(req: Location3DGSRequest): Promise<Location3DGSResult> {
        const t0 = Date.now();
        const root = req.workspaceRoot || this.workspaceRoot;
        const progressReporter = req.onProgress || (() => {});

        progressReporter(0.02, `Resolving geodetic location for "${req.location}"...`);

        // 1. Resolve geographic preset or synthesize from coordinates
        const customAnchor: GeodeticAnchor | undefined = (req.lat !== undefined && req.lng !== undefined) ? {
            lat: req.lat,
            lng: req.lng,
            elevationMeters: req.elevation || 0,
            headingDeg: req.headingDeg || 0,
            formattedAddress: req.location
        } : undefined;

        const preset = resolveSurveyPreset({
            location: req.location,
            lat: req.lat,
            lng: req.lng,
            elevationMeters: req.elevation,
            anchor: customAnchor,
            cameraCount: req.cameraCount,
            sigmaScale: req.sigmaScale,
            voxelSizeMeters: req.voxelSizeMeters,
            cropRadius: req.cropRadius,
            cropBox: req.cropBox,
            outDir: req.outDir,
            forceRebake: req.forceRebake,
            clean: req.clean,
            use2dgs: req.use2dgs,
            surfaceModel: req.surfaceModel,
            shDegree: req.shDegree,
            exposureScale: req.exposureScale
        }, root);

        const anchor = preset.anchor;
        // The survey renders the place's own clay tiles: a GLB the caller passed, else a fresh extraction at the
        // resolved anchor. A failed extraction fails the call; no model on disk is picked by the place's name, no
        // tile geometry is synthesized, and no other place's model is substituted.
        let glbPath: string;
        if (req.glbPath) {
            glbPath = path.isAbsolute(req.glbPath) ? req.glbPath : path.resolve(root, req.glbPath);
            if (!fs.existsSync(glbPath)) {
                throw new MissingInputError('location_generate_3dgs', 'glbPath', `${glbPath} does not exist`);
            }
        } else {
            progressReporter(0.04, `Extracting Google 3D Tiles in clay at ${anchor.formattedAddress}...`);
            const radiusMeters = preset.cropRadius || 75;
            const extraction = await getGoogle3DTilesClay(
                { lat: anchor.lat, lng: anchor.lng, elevation: anchor.elevationMeters, landmarkName: anchor.formattedAddress },
                // Named by the resolved place and radius (not the request text), so two places described alike never
                // overwrite each other's tiles.
                { radiusMeters, outputGlbPath: path.resolve(root, 'public/models', `${anchor.lat.toFixed(5)}_${anchor.lng.toFixed(5)}_r${Math.round(radiusMeters)}_clay.glb`) }
            );
            if (extraction.success === false || !extraction.glbPath || !fs.existsSync(extraction.glbPath)) {
                throw new TileExtractionError('download', `no clay tiles were extracted at ${anchor.lat}, ${anchor.lng} for ${anchor.formattedAddress}`);
            }
            glbPath = extraction.glbPath;
        }

        let stations = preset.stations;

        // If custom survey pattern requested
        if (req.surveyPattern) {
            const engine = new SurveySynthesisEngine();
            const patternCfg = {
                type: req.surveyPattern as any,
                cameraCount: req.cameraCount || 12,
                targetRadiusMeters: req.cropRadius || preset.cropRadius || 60,
                ...(req.surveyPatternConfig || {})
            };
            stations = engine.synthesize(anchor, patternCfg);
        } else if (req.cameraCount && req.cameraCount !== stations.length) {
            const engine = new SurveySynthesisEngine();
            stations = engine.synthesize(anchor, {
                type: 'orbital-multi-tier',
                cameraCount: req.cameraCount,
                targetRadiusMeters: preset.cropRadius || 45,
                altitudeTiersMeters: [anchor.elevationMeters + 5, anchor.elevationMeters + 25]
            });
        }

        const resolvedOutDir = req.outDir || preset.outDir;
        const outDir = path.isAbsolute(resolvedOutDir) ? resolvedOutDir : path.resolve(root, resolvedOutDir);
        await fs.ensureDir(outDir);

        // 2. Resolve the image generator (Nano Banana / Google media generation). There is no stand-in: an injected
        //    generator is the only other source, and every result says which model made the station images.
        let generator = req.generator;
        if (!generator) {
            const isDraftGenerator = req.draft === true || req.fidelity === 'draft';
            generator = createDefaultStationImageGenerator({
                workspaceRoot: root,
                fidelity: isDraftGenerator ? 'draft' : (req.fidelity || 'production'),
                imageSize: isDraftGenerator ? '1K' : '2K'
            });
        }

        const isDraft = req.draft === true || req.fidelity === 'draft';
        const beautifyContext = {
            locationName: req.location || preset.beautify.locationName,
            architecturalStyle: req.architecturalStyle || preset.beautify.architecturalStyle,
            // Injecting anything more into the prompt should only happen in {styleSuffix}, leave empty unless user prompts a style
            moodPromptContext: req.moodPromptContext || '',
            styleSuffix: req.styleSuffix !== undefined ? req.styleSuffix : ''
        };

        progressReporter(0.1, `Launching SurveySplatPipelineService for ${beautifyContext.locationName}...`);

        const svc = new SurveySplatPipelineService({ generator });
        const pipelineResult = await svc.run({
            glbPath,
            anchor,
            stations,
            outDir,
            beautify: beautifyContext,
            mode: 'chained',
            maxStations: req.cameraCount,
            renderWidth: req.width || 1920,
            bakeStride: req.bakeStride || 1,
            sigmaScale: req.sigmaScale ?? preset.sigmaScale ?? 0.8,
            voxelSizeMeters: req.voxelSizeMeters ?? preset.voxelSizeMeters ?? 0.08,
            forceRebake: req.forceRebake !== false,
            clean: req.clean ?? false,
            cropRadius: req.cropRadius ?? preset.cropRadius,
            cropBox: req.cropBox ?? preset.cropBox,
            erodeSilhouettePx: preset.erodeSilhouettePx,
            dropInconsistent: preset.dropInconsistent,
            colorConsistencyThresh: preset.colorConsistencyThresh,
            use2dgs: req.use2dgs === true || req.surfaceModel === 'planar',
            surfaceModel: req.surfaceModel,
            shDegree: req.shDegree,
            exposureScale: req.exposureScale,
            stoneType: req.stoneType as any,
            renderProvider: req.renderProvider,
            renderMode: req.renderMode,
            draft: isDraft
        }, (p, message) => progressReporter(0.1 + 0.85 * Math.max(0, Math.min(1, p)), message));

        if (!pipelineResult.success) {
            throw new GeneratorFailedError('survey splat pipeline', `the 3DGS pipeline for ${beautifyContext.locationName} failed: ${(pipelineResult as any).error || 'no error was reported'}`);
        }
        const accepted = pipelineResult.stations.filter(st => st.accepted);
        if (accepted.length === 0 || !(pipelineResult.fusedSplatCount > 0)) {
            throw new GeneratorFailedError('survey splat pipeline', `the 3DGS pipeline for ${beautifyContext.locationName} produced no splats (${accepted.length}/${pipelineResult.stations.length} station images accepted)`);
        }

        const { scene3DData, splatMediaObject } = SurveySplatPipelineService.toScene3DData(
            pipelineResult,
            anchor,
            beautifyContext.locationName
        );

        const splatUrl = splatMediaObject.content.durableUri || SurveySplatPipelineService.toWebUrl(pipelineResult.fusedSplatPath);
        const tilesetUrl = SurveySplatPipelineService.toWebUrl(pipelineResult.tilesetPath);

        progressReporter(1.0, `3DGS generation complete (${pipelineResult.fusedSplatCount.toLocaleString()} splats)`);

        return {
            success: pipelineResult.success,
            locationName: beautifyContext.locationName,
            geoAnchor: anchor,
            splatPath: pipelineResult.fusedSplatPath,
            splatUrl,
            tilesetPath: pipelineResult.tilesetPath,
            tilesetUrl,
            metaPath: pipelineResult.metaPath,
            splatCount: pipelineResult.fusedSplatCount,
            stationCount: pipelineResult.stations.length,
            glbPath,
            acceptedStations: accepted.length,
            scene3DData,
            cropBox: pipelineResult.cropBox,
            durationMs: Date.now() - t0,
            modelsUsed: Array.from(new Set(pipelineResult.stations.map(st => st.modelUsed).filter((m): m is string => !!m))),
            imageSources: Array.from(new Set(pipelineResult.stations.map(st => st.imageSource).filter((m): m is string => !!m)))
        };
    }
}

/**
 * Functional entrypoint to synthesize a location 3D Gaussian Splat radiance field.
 */
export async function generateLocation3DGS(request: Location3DGSRequest): Promise<Location3DGSResult> {
    const service = new Location3DGaussianSplatService({ workspaceRoot: request.workspaceRoot });
    return service.generate(request);
}

// Canonical alias
export const Location3DGSService = Location3DGaussianSplatService;
