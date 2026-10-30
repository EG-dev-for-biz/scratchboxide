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
import { GeneratorFailedError, MissingInputError, TileExtractionError } from '../../common/errors/pipeline-errors';
import { SurveySynthesisEngine } from '../../common/spatial/SurveySynthesisEngine';
import {
    createDefaultStationImageGenerator,
    requireStationImageCredentials,
    type StationImageGenerator
} from './BeautifyStationService';
import { resolveSurveyPreset } from './survey-router';
import { geocode3DTilesAddress, getGoogle3DTilesClay } from './Google3DTileBlockoutPipelineService';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import type { Scene3DData, Media4DObject } from '../../browser/generative-canvas/canvas-types';
import { glbRaycaster, planStreetViewStations, snapVantageToDrivenSidewalk, snapVantageToSidewalk, SNAP_STREET_RADIUS_M, type SidewalkSnap, type StreetVantage, type StreetViewStationsResult, type VectorStreet } from './street-view-stations';
import { geodeticToScan } from './StreetViewSurveyPlanner';
import { discoverPanosAt, type StreetViewEvidenceDeps } from '../3d-engine/staged-location/streetview-evidence';
import type { CloudBucket } from '../cloud-store/cloud-bucket';
import { defaultWorldCacheBucket, fetchWorld, storeWorld, worldCacheKey, type WorldManifest } from '../cloud-store/world-cache';

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
    /**
     * Where a viewer stands and looks: adds street-level stations posed by the registered Street View panoramas around it
     * (planStreetViewStations), each beautified from its own photograph. Its lat/lng default to the resolved place. Needs
     * `streetView`.
     */
    vantage?: Partial<Pick<StreetVantage, 'lat' | 'lng' | 'headingDeg'>> & Omit<StreetVantage, 'lat' | 'lng' | 'headingDeg'> & {
        /**
         * The compass direction from the street to the sidewalk the viewer stands on ("the west sidewalk": 270). Given, the
         * viewer is snapped onto that sidewalk of the street nearest the place (snapVantageToSidewalk) and a heading near
         * "across the street" is snapped to it.
         */
        sideDeg?: number;
    };
    /** The Maps key and the grounding service the vantage's stations are found and fetched with. */
    streetView?: StreetViewEvidenceDeps;
    /** Street centrelines near a point, for the sidewalk snap (default: the Google vector tiles, SpatialVectorDataService). */
    streets?: (lat: number, lng: number, radiusM: number) => Promise<VectorStreet[]>;
    /** Where finished worlds are kept (default: defaultWorldCacheBucket(); null: none). A world found there is fetched, not built. */
    worldCache?: CloudBucket | null;
    /** Build the world even when the world cache holds it (the new one then replaces it there). */
    refresh?: boolean;
    onProgress?: (progress: number, message?: string) => void;
    /**
     * The caller's Stop (the chat's Stop button or the tool's time limit). Checked before and after the tile
     * extraction and passed down through the survey pipeline to every station's image-model call, the baker, fuser
     * and tiler; generate() then rejects with its reason and generates or writes nothing more.
     */
    signal?: AbortSignal;
}

/** A standing viewer's eye above the ground, metres: where a street vantage's scene opens. */
export const VIEWER_EYE_HEIGHT_M = 1.6;

/** How far the walk runs each way along the street from the vantage. */
export const WALK_HALF_LENGTH_M = 30;

/** The walk the viewer stands on: along the street (its bearing, else across the look heading), at eye height. */
function walkCorridor(viewer: { eye: [number, number, number]; headingDeg: number }, streetBearingDeg?: number): { a: [number, number]; b: [number, number]; eyeY: number } {
    const along = ((streetBearingDeg ?? viewer.headingDeg + 90) * Math.PI) / 180;
    const dx = Math.sin(along) * WALK_HALF_LENGTH_M, dz = -Math.cos(along) * WALK_HALF_LENGTH_M;
    return { a: [viewer.eye[0] - dx, viewer.eye[2] - dz], b: [viewer.eye[0] + dx, viewer.eye[2] + dz], eyeY: viewer.eye[1] };
}

/** The street centrelines near a point, from the Google vector tiles (the road layer only). */
async function defaultStreets(lat: number, lng: number, radiusM: number): Promise<VectorStreet[]> {
    const { SpatialVectorDataService } = await import('./SpatialVectorDataService');
    const data = await SpatialVectorDataService.querySpatialVectorData({ latitude: lat, longitude: lng, radiusMeters: radiusM, layers: ['road'] });
    return data.roads.map(r => ({ geodeticPath: r.geodeticPath, ...(typeof r.widthM === 'number' ? { widthM: r.widthM } : {}) }));
}

/** Throws the signal's reason (or an AbortError) once the caller has stopped the run. */
function throwIfStopped(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Location 3DGS generation was stopped'), { name: 'AbortError' });
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
    /** With a vantage: where the viewer was placed (the sidewalk snap), the street stations found, how many were accepted, and how they were registered. */
    streetView?: Omit<StreetViewStationsResult, 'stations'> & { snap?: SidewalkSnap; stations: number; accepted: number; unmatched: number; panos: string[] };
    /** The world cache: this world was fetched from it (built when `storedAt`), or is being stored in it. */
    worldCache?: { key: string; bucket: string; state: 'fetched' | 'storing'; storedAt?: string };
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
        throwIfStopped(req.signal);

        progressReporter(0.02, `Resolving geodetic location for "${req.location}"...`);

        // A vantage on a sidewalk: the street and side from the vector tiles first, so the place is extracted around
        // where the viewer stands, not around a landmark's middle; the scan refines the offset once it is extracted.
        let centre = { lat: req.lat ?? req.vantage?.lat, lng: req.lng ?? req.vantage?.lng };
        let sidewalk: { streets: VectorStreet[]; coarse: SidewalkSnap } | undefined;
        if (req.vantage && !req.streetView) throw new MissingInputError('location_generate_3dgs', 'streetView', 'a vantage needs the Maps key and the Maps Imagery Grounding service to find and fetch its Street View');
        if (req.vantage?.sideDeg !== undefined && req.streetView) {
            if (centre.lat === undefined || centre.lng === undefined) {
                const g = await geocode3DTilesAddress(req.location);
                centre = { lat: g.lat, lng: g.lng };
            }
            const placeLat = centre.lat!, placeLng = centre.lng!;
            const placeOrigin = { lat: placeLat, lng: placeLng, heightMeters: 0 };
            const streets = await (req.streets ?? defaultStreets)(placeLat, placeLng, SNAP_STREET_RADIUS_M + 50);
            const sv = req.streetView;
            progressReporter(0.03, 'Finding the street the vantage stands on...');
            const coarse = await snapVantageToDrivenSidewalk({
                origin: placeOrigin, place: { x: 0, z: 0 }, sideDeg: req.vantage.sideDeg,
                ...(req.vantage.headingDeg !== undefined ? { headingDeg: req.vantage.headingDeg } : {}), streets,
                // a street a Google car drove has a Google-captured pano on it (the free metadata endpoint, cached)
                driven: async c => (await discoverPanosAt(placeOrigin, [c], sv, req.signal, c, 1)).panos.length > 0
            });
            throwIfStopped(req.signal);
            if (!coarse) throw new MissingInputError('location_generate_3dgs', 'vantage', `no street within ${SNAP_STREET_RADIUS_M} m of ${req.location} (${placeLat.toFixed(6)}, ${placeLng.toFixed(6)}) has its ${req.vantage.sideDeg}° side toward the place in the vector tiles (${streets.length} streets read), so the sidewalk could not be placed; give the street corner as the location, or the viewer's own coordinates without vantageSideDeg`);
            sidewalk = { streets, coarse };
            centre = { lat: coarse.lat, lng: coarse.lng };
        }

        // 1. Resolve the location (coordinates, or a place name via Google Places) and plan the survey
        const preset = await resolveSurveyPreset({
            location: req.location,
            // a vantage given by coordinates, or snapped to a sidewalk, centres the place (the extraction and the crop) on it
            lat: req.lat ?? centre.lat,
            lng: req.lng ?? centre.lng,
            elevationMeters: req.elevation,
            headingDeg: req.headingDeg,
            glbPath: req.glbPath,
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
        const resolvedOutDir = req.outDir || preset.outDir;
        const outDir = path.isAbsolute(resolvedOutDir) ? resolvedOutDir : path.resolve(root, resolvedOutDir);

        // A world built before from the same ask is fetched from the world cache instead of built again.
        const cache = req.worldCache === null ? undefined : (req.worldCache ?? defaultWorldCacheBucket());
        const cacheKey = worldCacheKey({
            lat: anchor.lat.toFixed(6), lng: anchor.lng.toFixed(6), location: req.location, glbPath: req.glbPath,
            headingDeg: req.vantage?.headingDeg, sideDeg: req.vantage?.sideDeg, walkMeters: req.vantage?.walkMeters, maxPanos: req.vantage?.maxPanos,
            cameraCount: req.cameraCount, surveyPattern: req.surveyPattern, draft: req.draft === true || req.fidelity === 'draft',
            styleSuffix: req.styleSuffix, moodPromptContext: req.moodPromptContext, architecturalStyle: req.architecturalStyle, stylePreset: req.stylePreset, mood: req.mood
        });
        if (cache && !req.refresh) {
            progressReporter(0.05, `Looking for this world in the world cache (${cache.label})...`);
            try {
                const hit = await fetchWorld<CachedWorld>(cache, cacheKey, outDir);
                if (hit) {
                    progressReporter(1.0, `Fetched the world built ${hit.storedAt} from the world cache`);
                    return worldFromCache(hit, outDir, Date.now() - t0, cache.label);
                }
            } catch (err) {
                // an unreachable cache is not a failed world: it is built, and the reason is said
                progressReporter(0.05, `The world cache could not be read (${err instanceof Error ? err.message : String(err)}); building the world`);
            }
            throwIfStopped(req.signal);
        }

        // The survey renders the place's own clay tiles: a GLB the caller passed, else a fresh extraction at the
        // resolved anchor. A failed extraction fails the call; no model on disk is picked by the place's name, no
        // tile geometry is synthesized, and no other place's model is substituted.
        let glbPath: string;
        if (preset.glbPath) {
            glbPath = path.isAbsolute(preset.glbPath) ? preset.glbPath : path.resolve(root, preset.glbPath);
            if (!fs.existsSync(glbPath)) {
                throw new MissingInputError('location_generate_3dgs', 'glbPath', `${glbPath} does not exist`);
            }
        } else {
            progressReporter(0.04, `Extracting Google 3D Tiles in clay at ${anchor.formattedAddress}...`);
            const extraction = await getGoogle3DTilesClay(
                { lat: anchor.lat, lng: anchor.lng, elevation: anchor.elevationMeters, landmarkName: anchor.formattedAddress },
                // Named by the resolved place and radius (not the request text), so two places described alike never
                // overwrite each other's tiles.
                { radiusMeters: preset.cropRadius || 75, outputDir: path.resolve(root, 'public/models') }
            );
            if (extraction.success === false || !extraction.glbPath || !fs.existsSync(extraction.glbPath)) {
                throw new TileExtractionError('download', `no clay tiles were extracted at ${anchor.lat}, ${anchor.lng} for ${anchor.formattedAddress}`);
            }
            glbPath = extraction.glbPath;
        }
        throwIfStopped(req.signal);

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

        await fs.ensureDir(outDir);

        // 2. Resolve the image generator (Nano Banana / Google media generation). There is no stand-in: an injected
        //    generator is the only other source, and every result says which model made the station images.
        let generator = req.generator;
        if (!generator) {
            // When every plate is painted (forceRebake not false), the image model's credentials (an environment or
            // saved API key, or Vertex AI) are resolved here, and a missing one fails before any station is rendered.
            // With forceRebake: false the generator is still built but resolves its credentials only when a station
            // needs a new image: cached plates that pass geometry QC are reused without asking for keys, and a station
            // without a usable plate is painted, or fails with the credential error.
            if (req.forceRebake !== false) await requireStationImageCredentials('location_generate_3dgs');
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

        let street: StreetViewStationsResult | undefined;
        let snap: SidewalkSnap | undefined;
        let viewer: { eye: [number, number, number]; headingDeg: number } | undefined;
        if (req.vantage && req.streetView) {
            const place = { lat: req.vantage.lat ?? anchor.lat, lng: req.vantage.lng ?? anchor.lng };
            let vantage: StreetVantage;
            if (req.vantage.sideDeg !== undefined && sidewalk) {
                progressReporter(0.07, 'Placing the viewer on the sidewalk, in front of the building line the scan shows...');
                const origin = { lat: anchor.lat, lng: anchor.lng, heightMeters: anchor.elevationMeters };
                // from the chosen street's own centreline point, the refine finds that street again (0 m away)
                const found = snapVantageToSidewalk({
                    origin, place: geodeticToScan(origin, sidewalk.coarse.streetPoint.lat, sidewalk.coarse.streetPoint.lng), sideDeg: req.vantage.sideDeg,
                    ...(req.vantage.headingDeg !== undefined ? { headingDeg: req.vantage.headingDeg } : {}),
                    streets: sidewalk.streets, ray: glbRaycaster(glbPath, origin)
                }) ?? sidewalk.coarse;
                // the street choice (and why) is the coarse snap's; the offset is the scan's
                snap = { ...found, reason: [found.reason, sidewalk.coarse.reason.split('; ').slice(1).join('; ')].filter(Boolean).join('; ') };
                vantage = { ...req.vantage, lat: found.lat, lng: found.lng, headingDeg: found.headingDeg };
            } else {
                if (req.vantage.headingDeg === undefined) throw new MissingInputError('location_generate_3dgs', 'vantageHeadingDeg', 'a vantage without vantageSideDeg needs the heading the viewer looks along');
                vantage = { ...req.vantage, ...place, headingDeg: req.vantage.headingDeg };
            }
            progressReporter(0.08, 'Finding and registering the Street View around the vantage...');
            street = await planStreetViewStations({
                glbPath, anchor,
                vantage,
                streetView: req.streetView,
                // apart from the survey's own ids
                firstId: 1000 + stations.reduce((m, s) => Math.max(m, s.id), 0),
                signal: req.signal,
                onProgress: m => progressReporter(0.09, m)
            });
            throwIfStopped(req.signal);
            // the scene opens where the viewer stands: eye height above the scan's sidewalk, looking along the heading
            viewer = { eye: [street.vantageLocal.x, (street.vantageGroundY ?? 0) + VIEWER_EYE_HEIGHT_M, street.vantageLocal.z], headingDeg: vantage.headingDeg };
        }

        progressReporter(0.1, `Launching SurveySplatPipelineService for ${beautifyContext.locationName}...`);

        const svc = new SurveySplatPipelineService({ generator });
        const pipelineResult = await svc.run({
            glbPath,
            anchor,
            stations,
            ...(street?.stations.length ? { streetStations: street.stations.map(s => ({ station: s.station, photo: s.photo })) } : {}),
            // a world to stand in: a splat on every patch of the scan (kept to its hulls), densest along the walk
            ...(street && viewer ? { surfaceLayer: { corridor: walkCorridor(viewer, snap?.streetBearingDeg) } } : {}),
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
            draft: isDraft,
            signal: req.signal
        }, (p, message) => progressReporter(0.1 + 0.85 * Math.max(0, Math.min(1, p)), message));
        throwIfStopped(req.signal);

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
            beautifyContext.locationName,
            viewer ? { vantage: viewer } : {}
        );
        // the scene beside its tileset, so the world can be opened again without building it (the 3D World starter button)
        await fs.writeJson(path.join(outDir, 'scene3d.json'), scene3DData, { spaces: 2 });

        const splatUrl = splatMediaObject.content.durableUri || SurveySplatPipelineService.toWebUrl(pipelineResult.fusedSplatPath);
        const tilesetUrl = SurveySplatPipelineService.toWebUrl(pipelineResult.tilesetPath);

        progressReporter(1.0, `3DGS generation complete (${pipelineResult.fusedSplatCount.toLocaleString()} splats)`);

        const result: Location3DGSResult = {
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
            imageSources: Array.from(new Set(pipelineResult.stations.map(st => st.imageSource).filter((m): m is string => !!m))),
            ...(street ? {
                streetView: {
                    ...(snap ? { snap } : {}),
                    vantageLocal: street.vantageLocal, discovery: street.discovery, failures: street.failures, registrationSummary: street.registrationSummary,
                    stations: street.stations.length,
                    accepted: pipelineResult.stations.filter(st => st.accepted && st.groundingPanoId).length,
                    unmatched: pipelineResult.stations.filter(st => st.accepted && st.scanMismatch).length,
                    panos: Array.from(new Set(street.stations.map(s => s.photo.panoId)))
                }
            } : {})
        };
        if (cache) {
            // stored after the answer, so the user is not kept waiting on the upload; the manifest goes last, so an
            // interrupted upload is never taken for a world
            const { scene3DData: _scene, splatPath: _s, splatUrl: _u, tilesetPath: _t, tilesetUrl: _tu, metaPath: _m, ...rest } = result;
            result.worldCache = { key: cacheKey, bucket: cache.label, state: 'storing' };
            void storeWorld<CachedWorld>(cache, cacheKey, outDir, { ...rest, ...(viewer ? { viewer } : {}) })
                .then(n => console.log(`[world-cache] stored ${n} files of ${beautifyContext.locationName} as ${cacheKey} in ${cache.label}`))
                .catch(err => console.warn(`[world-cache] could not store ${cacheKey} in ${cache.label}: ${err instanceof Error ? err.message : String(err)}`));
        }
        return result;
    }
}

/** What the world cache keeps of a result: everything but its local paths and scene, and where the viewer stands. */
type CachedWorld = Omit<Location3DGSResult, 'scene3DData' | 'splatPath' | 'splatUrl' | 'tilesetPath' | 'tilesetUrl' | 'metaPath' | 'worldCache'> & {
    viewer?: { eye: [number, number, number]; headingDeg: number };
};

/** A result rebuilt from a cached world fetched into `outDir`: the scene made again for this machine's paths. */
function worldFromCache(hit: WorldManifest<CachedWorld>, outDir: string, durationMs: number, bucketLabel: string): Location3DGSResult {
    const { viewer, ...cached } = hit.result;
    const fusedSplatPath = path.join(outDir, 'fused.splat'), tilesetPath = path.join(outDir, 'tileset.json'), metaPath = path.join(outDir, 'tileset.meta.json');
    const spzPath = path.join(outDir, 'fused.spz');
    const { scene3DData } = SurveySplatPipelineService.toScene3DData(
        { success: true, stations: [], fusedSplatPath, ...(fs.existsSync(spzPath) ? { spzPath } : {}), fusedSplatCount: cached.splatCount, tilesetPath, metaPath, cropBox: cached.cropBox, durationMs },
        cached.geoAnchor, cached.locationName, viewer ? { vantage: viewer } : {}
    );
    fs.writeJsonSync(path.join(outDir, 'scene3d.json'), scene3DData, { spaces: 2 });
    return {
        ...cached, scene3DData, durationMs,
        splatPath: fusedSplatPath, splatUrl: SurveySplatPipelineService.toWebUrl(fusedSplatPath),
        tilesetPath, tilesetUrl: SurveySplatPipelineService.toWebUrl(tilesetPath), metaPath,
        worldCache: { key: hit.key, bucket: bucketLabel, state: 'fetched', storedAt: hit.storedAt }
    };
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
