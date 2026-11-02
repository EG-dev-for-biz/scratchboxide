/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { mapBounded } from '../../common/async/bounded-concurrency';
import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SurveySynthesisEngine, cameraBasis } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService, EMPTY_DEPTH } from './SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator, describeStationImageSource, isNoImageAnswer, STATION_EMPTY_IMAGE_ATTEMPTS, warpCoverage, type StationImageGenerator, type BeautifyStationResult, type GroundingPhoto } from './BeautifyStationService';
import type { StationBeautifyContext } from '../../browser/generative-canvas/services/location-beautify-service';
import { Splat3DTilesService } from './Splat3DTilesService';
import { SplatService } from '../3d-engine/splat-service';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import type { BakedGaussian } from '../../common/geospatial-4d-protocol';
import { decodePng, calibrateStoneAlbedoRgba, type StoneAlbedoPreset } from '../texture-processing';
import type { TileSunSpec } from '../3d-engine/native-tile-path-tracer-service';
import type { Scene3DData, Media4DObject } from '../../browser/generative-canvas/canvas-types';
import { buildNativeIfStale } from '../3d-engine/native-build';
import { repoPath } from '../process/repo-python';
import { containSplatsToScan, type ContainmentReport } from './splat-containment';
import { buildSurfaceSplatLayer, type SurfaceLayerReport } from './surface-splat-layer';
import { glbRaycaster } from './street-view-stations';

/** Street stations' incidence floor: a camera 2.5 m up sees the street ground at 0.06 out to about 40 m. */
export const STREET_MIN_COS_INCIDENCE = 0.06;

const execAsync = promisify(exec);

/** Whether a plate's recorded camera (`<station>_plate.json`) is this station's: within 5 cm and about 0.25 degrees. */
function samePose(plate: { eye?: number[]; forward?: number[] } | null, st: ColmapCameraPose): boolean {
    if (!plate?.eye || !plate.forward) return false;
    const e = st.positionLocalENU, f = st.forwardVector;
    return Math.hypot(plate.eye[0] - e[0], plate.eye[1] - e[1], plate.eye[2] - e[2]) < 0.05
        && plate.forward[0] * f[0] + plate.forward[1] * f[1] + plate.forward[2] * f[2] > 0.99999;
}

/** Throws the signal's reason (or an AbortError) once the caller has stopped the run. */
function throwIfStopped(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The survey splat pipeline was stopped'), { name: 'AbortError' });
}

export interface SurveySplatPipelineRequest {
    glbPath: string;
    anchor: GeodeticAnchor;
    /** Stations to process (already enriched or not; they are re-enriched against the GLB). */
    stations: ColmapCameraPose[];
    /**
     * Street-level stations posed by registered Street View photographs (planStreetViewStations). They run before
     * `stations` and are never ranked out: each beautifies its own photograph (in memory only, the Street View seed
     * prompt) instead of the blockout, and is first in the fuse list, so the fuser's exposure target and the chain's
     * first reference are a street view. Their ids must not repeat a station's.
     */
    streetStations?: Array<{ station: ColmapCameraPose; photo: GroundingPhoto }>;
    /** Street stations' floor on |n.view| when baking (default STREET_MIN_COS_INCIDENCE): they see the ground grazing. */
    streetMinCosIncidence?: number;
    /** Drop fused splats outside the scan's ground and building hulls before tiling (containSplatsToScan). */
    containToScan?: boolean;
    /**
     * A splat on every patch of the scan, coloured from the stations (surface-splat-layer.ts), instead of the stations'
     * per-pixel splats fused by voxel: its spacing grows with the distance to the walk `corridor` (scan frame x, z at eye
     * height), within `budget` splats. Also written as .spz, which the scene loads.
     */
    surfaceLayer?: { corridor: { a: [number, number]; b: [number, number]; eyeY: number }; budget?: number };
    outDir: string;
    beautify: StationBeautifyContext;
    /** 'chained' warps each accepted image into the next station (consistent materials); 'fanout' beautifies independently. */
    mode?: 'chained' | 'fanout';
    /** Fanout mode only: how many stations are beautified and baked at once (default 4). */
    fanoutConcurrency?: number;
    /** Optional ranking cap: keep only the best N stations (uses enrichment metrics). */
    maxStations?: number;
    renderWidth?: number;          // default 1920
    bakeStride?: number;           // default 1
    sigmaScale?: number;           // default 1.15
    /** Drop samples seen more edge-on than this |n.view| (default 0.05); 0 disables the grazing filter. */
    minCosIncidence?: number;
    voxelSizeMeters?: number;
    clean?: boolean;
    isoDate?: string;
    headingDeg?: number;
    maxRerolls?: number;
    /** If true (default), drops organic foliage pixels to avoid lumpy melting mounds. */
    dropFoliage?: boolean;
    /** Semantic foliage handling mode: 'drop' leaves clean clay blockout; 'jitter' spawns spherical volume splats. */
    foliageMode?: 'drop' | 'jitter';
    /** Enable hybrid micro-depth displacement extracting sharp relief directly from photo */
    enableHybridMicroDepth?: boolean;
    /** Extract high-frequency micro-relief directly from 2D photo luminance */
    enablePhotometricMicroDepth?: boolean;
    /** Path to external neural depth map (e.g. Depth Anything V2/V3 or MoGe) */
    neuralDepthPath?: string;
    /** Weight alpha for neural/photometric delta Z */
    neuralDepthWeight?: number;
    /** Maximum depth offset clamp in meters (default 3.5m) */
    maxDeltaZ?: number;
    /** Cavity depth offset in meters (default 3.5m) */
    cavityDepth?: number;
    /** Cavity luminance threshold (default 0.18) */
    cavityLum?: number;
    /** Cosine threshold for multi-view normal consensus pruning (default 0.0) */
    normalPruneCos?: number;
    /** Crop box override for landmark bounds */
    cropBox?: { min: [number, number, number]; max: [number, number, number] };
    /** Center [x, z] for horizontal crop circle (default: center of cropBox or [0, 0]) */
    cropCenter?: [number, number];
    /** Horizontal radius crop in meters around cropCenter (default 115m) */
    cropRadius?: number;
    /** Silhouette mask erosion pixels (default 2px) to eliminate sky bleed */
    erodeSilhouettePx?: number;
    /** If true, drops multi-view inconsistent splats with large color delta (>40/255) */
    dropInconsistent?: boolean;
    /** Maximum color channel delta across views before voxel is considered inconsistent */
    colorConsistencyThresh?: number;
    tiles?: { maxDepth?: number; leafCapacity?: number; interiorBudget?: number };
    /** Force rebaking of all stations even if valid baked splats already exist on disk */
    forceRebake?: boolean;
    /** If true, uses 2D Gaussian Surface Regularization (squashed normal axis sz = 1e-4) to eliminate raymarching bleeding */
    use2dgs?: boolean;
    /** Surface model choice: 'planar' (2DGS planar surfels) vs 'ellipsoid' (3D ellipsoids) */
    surfaceModel?: 'planar' | 'ellipsoid';
    /** Higher-order spherical harmonics degree (0 = RGB only, 1 = 9 coefficients, 2 = 24, 3 = 45) */
    shDegree?: number;
    /** Multi-station photometric exposure normalization scale */
    exposureScale?: number;
    /** Minimum camera view count consensus required to retain a voxel (default: 1) */
    minViews?: number;
    /** Station render provider: 'software-clay' (default), 'pathtracer', or 'textured-glb' */
    renderProvider?: 'software-clay' | 'pathtracer' | 'textured-glb';
    /** Render mode for station input: 'clay' (studio grey) or 'textured' (full GLB photogrammetric PBR textures) */
    renderMode?: 'clay' | 'textured' | 'albedo';
    /** Fast draft generation */
    draft?: boolean;
    /** Calibrate authentic stone albedo */
    stoneType?: StoneAlbedoPreset;
    /** Solar position or ephemeris for path tracing */
    sun?: TileSunSpec;
    /**
     * The caller's Stop (the chat's Stop button or the tool's time limit). Checked before every station, passed to
     * the image model (so its call and its rerolls end), and to the native baker, fuser and tiler; nothing more is
     * generated or written once it fires, and run() rejects with its reason.
     */
    signal?: AbortSignal;
}

export interface SurveySplatStationReport {
    stationId: number;
    accepted: boolean;
    attempts: number;
    usedReference: boolean;
    splatCount: number;
    imagePath: string;
    blockoutPath: string;
    splatPath?: string;
    qc: BeautifyStationResult['qc'];
    prompt: string;
    positionLocalENU?: [number, number, number];
    forwardVector?: [number, number, number];
    name?: string;
    /** The image model that produced this station's picture; absent for a plate reused from disk or a generator that names none. */
    modelUsed?: string;
    /** Where the picture came from: the model (and why, when it was not the requested one) or the reused plate. */
    imageSource?: string;
    /** A street station: the Street View pano its picture was transformed from, and its capture month. */
    groundingPanoId?: string;
    groundingDate?: string;
    /** A street station kept although its picture failed the geometry check against the scan: the check's reason. */
    scanMismatch?: string;
}

export interface SurveySplatPipelineResult {
    success: boolean;
    stations: SurveySplatStationReport[];
    fusedSplatPath: string;
    /** The same splats as SPZ (about a tenth of the size), when written: the scene loads it. */
    spzPath?: string;
    fusedSplatCount: number;
    tilesetPath: string;
    metaPath: string;
    cropBox: { min: [number, number, number]; max: [number, number, number] };
    durationMs: number;
    error?: string;
}

export type ProgressReporter = (progress: number, message?: string) => void;

/**
 * High-throughput orchestration of the Zero-Drift Multi-View Generative 3DGS pipeline:
 * Stations -> beautify -> bake -> fuse -> 3D Tiles.
 *
 * Each accepted station image is unprojected with the mesh's own depth at the QC-aligned pose
 * (scripts/station_to_splats.cpp), the per-station splat sets are fused by voxel hash preferring the
 * station whose view is most normal to the surface, and the result is tiled with a geodetic root
 * transform so it overlays the source Google 3D Tiles. A crop box (union of station frusta clipped
 * to the mesh extent) is written for the viewer's bounding-volume discard.
 */
export class SurveySplatPipelineService {
    private compiler = new NativeCppCompilerService();
    // the repository's, not the process's: the app's server runs from desktop-app/
    private bakerPath = repoPath('build', 'station_to_splats');

    /** The caller's generator, else the default image model, which resolves its credentials only when a station needs a new image. */
    private readonly generator: StationImageGenerator;

    constructor(deps?: { generator?: StationImageGenerator }) {
        this.generator = deps?.generator ?? createDefaultStationImageGenerator();
    }

    async ensureBaker(signal?: AbortSignal): Promise<string> {
        const src = repoPath('scripts', 'station_to_splats.cpp');
        throwIfStopped(signal);
        return buildNativeIfStale({ source: src, binary: this.bakerPath, includeDir: this.compiler.getSdkIncludePath(), libs: ['-lz'] });
    }

    async run(req: SurveySplatPipelineRequest, report: ProgressReporter = () => {}): Promise<SurveySplatPipelineResult> {
        const t0 = Date.now();
        const outDir = req.outDir;
        const stationsDir = path.join(outDir, 'stations');
        const fusedSplatPath = path.join(outDir, 'fused.splat');
        const tilesetPath = path.join(outDir, 'tileset.json');
        const metaPath = path.join(outDir, 'tileset.meta.json');
        const signal = req.signal;
        try {
            throwIfStopped(signal);
            await fs.ensureDir(stationsDir);
            report(0.02, 'Loading mesh');
            const renderer = new SurveyStationRenderService();
            await renderer.loadMesh(req.glbPath);
            throwIfStopped(signal);
            const engine = new SurveySynthesisEngine();
            let stations = renderer.enrichStations(req.stations, { isoDate: req.isoDate });
            if (req.maxStations && req.maxStations < stations.length) stations = engine.rankForBeautify(stations, { maxCount: req.maxStations });
            const street = req.streetStations ?? [];
            const photoOf = new Map<number, GroundingPhoto>(street.map(s => [s.station.id, s.photo]));
            if (photoOf.size !== street.length || stations.some(st => photoOf.has(st.id))) throw new Error('street station ids must be unique and apart from the survey stations\'');
            stations = [...renderer.enrichStations(street.map(s => s.station), { isoDate: req.isoDate }), ...stations];
            const mode = req.mode ?? 'chained';
            const width = req.renderWidth ?? 1920;
            const baker = await this.ensureBaker(signal);
            const beautifier = new BeautifyStationService(renderer, this.generator);
            // Whether this run asked the generator for any image; a run that only reused plates names no generator.
            let generatedAny = false;

            const reports: SurveySplatStationReport[] = [];
            const bakedStations: { splatPath: string; station: ColmapCameraPose }[] = [];
            let reference: BeautifyStationResult | undefined;
            // One station end to end: reuse or beautify its plate, then bake it. In chained mode each station is
            // conditioned on the previous accepted one, so they run in order; in fanout mode they are independent
            // and run several at a time (the image calls overlap; the bake is a native subprocess per station).
            // A street station beautifies its own photograph, never the chain's reference, so street stations run
            // several at a time in either mode; `accepted` hands the chain its first reference.
            // `ref`: this station's own chained reference (a street view it is anchored on), in place of the running chain's.
            const runStation = async (i: number, signal: AbortSignal | undefined, ref?: BeautifyStationResult): Promise<{ localReports: SurveySplatStationReport[]; localBaked: { splatPath: string; station: ColmapCameraPose }[]; accepted?: BeautifyStationResult }> => {
                throwIfStopped(signal);
                const localReports: SurveySplatStationReport[] = [];
                const localBaked: { splatPath: string; station: ColmapCameraPose }[] = [];
                const st = stations[i];
                const photo = photoOf.get(st.id);
                const grounding = photo ? { groundingPanoId: photo.panoId, ...(photo.date ? { groundingDate: photo.date } : {}) } : {};
                const base = path.join(stationsDir, `station_${String(st.id).padStart(3, '0')}`);
                const splatPath = `${base}.splat`;
                const posePath = `${base}.pose.json`;
                const beautifiedPath = `${base}_beautified.png`;
                const blockoutPath = `${base}_blockout.png`;

                const rejectedPath = `${base}_rejected.png`;
                const pctOf = (qc: BeautifyStationResult['qc']) => `overlap ${qc.overlapPercent.toFixed(1)}%${qc.reason ? `; ${qc.reason}` : ''}`;

                // A plate (or the splat baked from it) found on disk is reused only after it passes the same geometry
                // QC against this mesh that a fresh image gets; one that fails is moved aside, never baked.
                let res: BeautifyStationResult | undefined;
                let reuseNote: string | undefined;
                // a street plate skips the geometry check, so it is reused only for the camera it was made for
                const platePath = `${base}_plate.json`;
                const plateFitsStation = !photo || samePose(await fs.readJson(platePath).catch(() => null), st);
                if (!req.forceRebake && plateFitsStation && (await fs.pathExists(beautifiedPath))) {
                    report(0.05 + 0.7 * (i / stations.length), `Checking the beautified image already on disk for station ${st.id} (${i + 1}/${stations.length})`);
                    const imagePng = await fs.readFile(beautifiedPath);
                    const dec = decodePng(imagePng);
                    const blockout = renderer.renderStationBlockout(st, { width: dec.width, height: dec.height });
                    await fs.outputFile(blockoutPath, blockout.png);
                    const verified = BeautifyStationService.verifyStationImage(renderer, st, blockout, dec.rgba, dec.width, dec.height, req.draft || photo ? { maxIterations: 0 } : undefined);
                    if (verified.qc.passed || photo) {
                        const stStat = await fs.stat(splatPath).catch(() => null);
                        const bStat = await fs.stat(beautifiedPath);
                        if (stStat && stStat.size > 100000 && fs.existsSync(posePath) && stStat.mtimeMs >= bStat.mtimeMs) {
                            report(0.05 + 0.7 * (i / stations.length), `Reusing cached station ${st.id} (${i + 1}/${stations.length})`);
                            const pose = await fs.readJson(posePath).catch(() => null);
                            const posENU: [number, number, number] = (pose?.eye || verified.aligned.positionLocalENU || st.positionLocalENU) as [number, number, number];
                            const fwdVec: [number, number, number] = (pose?.forward || verified.aligned.forwardVector || st.forwardVector) as [number, number, number];
                            localReports.push({
                                stationId: st.id, accepted: true, attempts: 0, usedReference: false, splatCount: Math.floor(stStat.size / 32), splatPath,
                                imagePath: beautifiedPath, blockoutPath,
                                qc: verified.qc,
                                prompt: `Photorealistic view of station ${st.id}`,
                                positionLocalENU: posENU,
                                forwardVector: fwdVec,
                                name: st.name,
                                imageSource: photo
                                    ? `Reused the street station splat already on disk at ${splatPath} (kept whatever its match with the scan, ${pctOf(verified.qc)}); no image was generated.`
                                    : `Reused the station splat already on disk at ${splatPath}, after its beautified plate passed geometry QC again (${pctOf(verified.qc)}); no image was generated.`,
                                ...grounding
                            });
                            localBaked.push({ splatPath, station: { ...st, positionLocalENU: posENU, forwardVector: fwdVec } });
                            return { localReports, localBaked };
                        }
                        res = {
                            station: st,
                            alignedStation: verified.aligned,
                            prompt: `Photorealistic view of station ${st.id}`,
                            blockout,
                            imagePng,
                            image: { width: dec.width, height: dec.height, rgba: dec.rgba },
                            qc: verified.qc,
                            accepted: true,
                            attempts: 0,
                            // The plate was made earlier, by whatever model was used then; this run did not generate it.
                            generator: 'cached-beautified-plate'
                        };
                        reuseNote = `Reused the beautified plate already on disk at ${beautifiedPath} after it passed geometry QC again (${pctOf(verified.qc)}); no image was generated.`;
                    } else {
                        // Moved aside with the splat baked from it, so no later run takes it for an accepted plate;
                        // the station is painted afresh below.
                        await fs.move(beautifiedPath, rejectedPath, { overwrite: true });
                        await Promise.all([fs.remove(splatPath), fs.remove(posePath)]);
                    }
                }

                if (!res) {
                    generatedAny = true;
                    report(0.05 + 0.7 * (i / stations.length), `Beautifying station ${st.id} (${i + 1}/${stations.length})`);
                    const stationRenderMode = req.renderMode ?? (req.renderProvider === 'pathtracer' ? 'albedo' : 'clay');
                    const beautifyOnce = () => beautifier.beautify(st, req.beautify, {
                        width,
                        reference: mode === 'chained' ? (ref ?? reference) : undefined,
                        // a street station is stitched in whether or not its photograph agrees with the scan
                        ...(photo ? { groundingPhoto: photo, acceptUnmatched: true } : {}),
                        maxRerolls: req.maxRerolls,
                        draft: req.draft,
                        renderMode: stationRenderMode,
                        glbPath: req.glbPath,
                        stoneType: req.stoneType,
                        signal
                    });
                    // An image model that answers with no image (an empty STOP, a blocked prompt) fails this one station:
                    // it is asked once more, then left out and reported. A model that cannot be reached at all still ends the run.
                    let noImage: string | undefined;
                    for (let attempt = 0; attempt < STATION_EMPTY_IMAGE_ATTEMPTS && !res; attempt++) {
                        try {
                            res = await beautifyOnce();
                        } catch (err) {
                            if (signal?.aborted || !isNoImageAnswer(err)) throw err;
                            noImage = err.message;
                        }
                    }
                    throwIfStopped(signal);
                    if (!res) {
                        const reason = `no image after ${STATION_EMPTY_IMAGE_ATTEMPTS} attempts (${noImage})`;
                        localReports.push({
                            stationId: st.id, accepted: false, attempts: STATION_EMPTY_IMAGE_ATTEMPTS, usedReference: false, splatCount: 0, imagePath: '', blockoutPath,
                            qc: { overlapPercent: 0, residualPx: Number.NaN, deltaYawDeg: Number.NaN, deltaPitchDeg: Number.NaN, deltaPositionM: Number.NaN, passed: false, reason },
                            prompt: '', positionLocalENU: st.positionLocalENU, forwardVector: st.forwardVector, name: st.name,
                            imageSource: `The ${this.generator.name} generator gave no image: ${reason}.`, ...grounding
                        });
                        return { localReports, localBaked };
                    }
                    await fs.outputFile(blockoutPath, res.blockout.png);
                    if (res.accepted) {
                        await fs.outputFile(beautifiedPath, res.imagePng);
                        await fs.writeJson(platePath, { eye: st.positionLocalENU, forward: st.forwardVector, ...(photo ? { panoId: photo.panoId } : {}) });
                        await fs.remove(rejectedPath);
                    } else {
                        // A rejected image is kept for inspection under its own name, never as the station's plate.
                        await fs.outputFile(rejectedPath, res.imagePng);
                        await Promise.all([fs.remove(beautifiedPath), fs.remove(splatPath), fs.remove(posePath)]);
                    }
                    if (res.warp) await fs.outputFile(`${base}_warp.png`, res.warp.warpedPng);
                }

                const rep: SurveySplatStationReport = {
                    stationId: st.id, accepted: res.accepted, attempts: res.attempts, usedReference: !!res.warp, splatCount: 0,
                    imagePath: res.accepted ? beautifiedPath : rejectedPath, blockoutPath: blockoutPath, qc: res.qc, prompt: res.prompt,
                    positionLocalENU: res.alignedStation.positionLocalENU || st.positionLocalENU,
                    forwardVector: res.alignedStation.forwardVector || st.forwardVector,
                    name: st.name,
                    modelUsed: res.modelUsed,
                    imageSource: reuseNote ?? describeStationImageSource(res),
                    ...grounding,
                    ...(photo && !res.qc.passed ? { scanMismatch: res.qc.reason ?? 'the photograph and the scan disagree' } : {})
                };
                if (res.accepted) {
                    throwIfStopped(signal);
                    // a street camera 2.5 m up sees the ground beyond ~12 m at a grazing angle: kept for it (elongation stays capped),
                    // or the street it stands on is a hole in the world
                    const baked = await this.bakeStation(baker, res, `${base}.splat`, photo ? { ...req, minCosIncidence: req.streetMinCosIncidence ?? STREET_MIN_COS_INCIDENCE } : req);
                    rep.splatCount = baked.splatCount;
                    rep.splatPath = baked.splatPath;
                    localBaked.push({ splatPath: baked.splatPath, station: res.alignedStation });
                    if (mode === 'chained' && !photo) reference = res;
                }
                localReports.push(rep);
                return { localReports, localBaked, ...(res.accepted ? { accepted: res } : {}) };
            };
            const limit = Math.max(1, req.fanoutConcurrency ?? 4);
            const runBounded = (from: number, to: number) => mapBounded(stations.slice(from, to).map((_, k) => from + k), (i, _k, stationSignal) => runStation(i, stationSignal), { limit, signal });
            const outcomes = mode === 'chained'
                ? await (async () => {
                    const seq: Awaited<ReturnType<typeof runStation>>[] = street.length ? await runBounded(0, street.length) : [];
                    const anchors = seq.map(o => o.accepted).filter((a): a is BeautifyStationResult => !!a);
                    if (!anchors.length) {
                        for (let i = street.length; i < stations.length; i++) seq.push(await runStation(i, signal));
                        return seq;
                    }
                    // Anchored on the street views: each survey station takes as its reference the accepted street view
                    // that covers most of its frame, warped into it, instead of the station before it. The survey
                    // stations then depend on no other survey station, so they run several at a time too.
                    const anchorFor = (st: ColmapCameraPose): BeautifyStationResult => {
                        const w = 240, h = Math.round(w / (st.aspectRatio && st.aspectRatio > 0 ? st.aspectRatio : 16 / 9));
                        const { intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(st, w, h);
                        let best = anchors[0], bestCover = -1;
                        for (const a of anchors) {
                            const cover = warpCoverage({ depth: a.blockout.depth, width: a.blockout.width, height: a.blockout.height, intrinsics: a.blockout.intrinsics, station: a.alignedStation }, { intrinsics, station: st, width: w, height: h });
                            if (cover > bestCover) { best = a; bestCover = cover; }
                        }
                        return best;
                    };
                    seq.push(...await mapBounded(stations.slice(street.length).map((_, k) => street.length + k), (i, _k, stationSignal) => runStation(i, stationSignal, anchorFor(stations[i])), { limit, signal }));
                    return seq;
                })()
                : await runBounded(0, stations.length);
            for (const outcome of outcomes) {
                reports.push(...outcome.localReports);
                bakedStations.push(...outcome.localBaked);
            }
            if (bakedStations.length === 0) throw new Error('No station passed QC; nothing to bake');

            const voxel = req.voxelSizeMeters ?? 0.025;
            let fusedCount = 0;
            let fuseBounds: { min: number[]; max: number[] } | undefined;
            let containment: ContainmentReport | undefined;
            let surface: SurfaceLayerReport | undefined;
            const spzPath = path.join(outDir, 'fused.spz');
            if (req.surfaceLayer) {
                // a splat on every patch of the scan, coloured from the stations, in place of the per-pixel splats' voxel fuse
                throwIfStopped(signal);
                report(0.8, 'Laying a splat on every patch of the scan, coloured from the stations');
                const layerStations = reports.filter(r => r.accepted && r.splatPath && r.imagePath).flatMap(r => {
                    const baked = bakedStations.find(b => b.splatPath === r.splatPath);
                    return baked ? [{ station: baked.station, imagePath: r.imagePath, posePath: r.splatPath!.replace(/\.splat$/, '.pose.json'), priority: r.groundingPanoId ? 1.5 : 1 }] : [];
                });
                surface = await buildSurfaceSplatLayer({
                    glbPath: req.glbPath, anchor: req.anchor, renderer, stations: layerStations, corridor: req.surfaceLayer.corridor,
                    outSplat: fusedSplatPath, outSpz: spzPath, workDir: path.join(outDir, 'surface_work'),
                    ...(req.surfaceLayer.budget ? { budget: req.surfaceLayer.budget } : {}), ...(signal ? { signal } : {})
                });
                fusedCount = surface.splats;
            } else {
                throwIfStopped(signal);
                report(0.8, 'Fusing station splats');
                const voxel = req.voxelSizeMeters ?? 0.025;
                const listPath = path.join(outDir, 'stations_to_fuse.txt');
                await fs.outputFile(listPath, bakedStations.map(s => `${s.splatPath} ${s.station.cameraAltitude ?? s.station.positionLocalENU?.[1] ?? s.station.cameraHeightAboveGround ?? 50.0}`).join('\n'));
                const dropFoliageArg = req.dropFoliage !== false ? '--drop-foliage' : '';
                const normalPruneArg = `--normal-prune-cos ${req.normalPruneCos ?? 0.0}`;
                const consistencyArg = req.dropInconsistent ? `--drop-inconsistent --color-consistency-thresh ${req.colorConsistencyThresh ?? 40.0}` : '';
                const minViewsArg = (req.minViews && req.minViews > 1) ? `--min-views ${req.minViews}` : '';
                const cropCenter = req.cropCenter ?? (req.cropBox ? [
                    (req.cropBox.min[0] + req.cropBox.max[0]) * 0.5,
                    (req.cropBox.min[2] + req.cropBox.max[2]) * 0.5
                ] : [0.0, 0.0]);
                const cropCenterArg = (cropCenter[0] !== 0 || cropCenter[1] !== 0) ? `--crop-center-x ${cropCenter[0]} --crop-center-z ${cropCenter[1]}` : '';
                const cropRadiusVal = req.cropRadius ?? (req.cropBox ? Math.max(
                    Math.abs(req.cropBox.max[0] - cropCenter[0]),
                    Math.abs(req.cropBox.max[2] - cropCenter[1]),
                    Math.abs(req.cropBox.min[0] - cropCenter[0]),
                    Math.abs(req.cropBox.min[2] - cropCenter[1])
                ) : 115.0);
                const cropRadiusArg = cropRadiusVal > 0 ? `--crop-radius ${cropRadiusVal}` : '';
                const fuseCmd = `"${baker}" --fuse-list "${listPath}" --voxel-size ${voxel} ${cropRadiusArg} ${cropCenterArg} ${dropFoliageArg} ${normalPruneArg} ${consistencyArg} ${minViewsArg} --exclude-underside --out-splat "${fusedSplatPath}" --json`;
                const { stdout: fuseStdout } = await execAsync(fuseCmd, { maxBuffer: 16 * 1024 * 1024, signal });
                const fuseRes = JSON.parse(fuseStdout.trim());
                fuseBounds = fuseRes.bounds;
                await fs.remove(listPath).catch(() => {});
                fusedCount = fuseRes.fusedSplatCount ?? 0;
                // kept inside the scan's ground and building hulls (splat-containment.ts)
                if (req.containToScan) {
                    throwIfStopped(signal);
                    report(0.84, 'Containing the splats to the ground and the building hulls');
                    const contained = containSplatsToScan(await fs.readFile(fusedSplatPath), glbRaycaster(req.glbPath, { lat: req.anchor.lat, lng: req.anchor.lng, heightMeters: req.anchor.elevationMeters }));
                    await fs.writeFile(fusedSplatPath, contained.kept);
                    containment = contained.report;
                    fusedCount = contained.report.kept;
                }

            }

            throwIfStopped(signal);
            report(0.88, 'Tiling');
            const tiles = new Splat3DTilesService();
            const tileRes = await tiles.convert({ inputPath: fusedSplatPath, outDir, origin: { lat: req.anchor.lat, lng: req.anchor.lng, alt: req.anchor.elevationMeters }, headingDeg: req.headingDeg ?? 0, maxDepth: req.tiles?.maxDepth ?? 5, leafCapacity: req.tiles?.leafCapacity, interiorBudget: req.tiles?.interiorBudget, signal });
            if (!tileRes.success) throw new Error(tileRes.error || 'Tiling failed');
            throwIfStopped(signal);

            const meshBounds = renderer.getMeshBounds()!;
            const fMin = fuseBounds?.min ?? [-100, -100, -100];
            const fMax = fuseBounds?.max ?? [100, 100, 100];
            const cropBox = req.cropBox ?? {
                min: [
                    Math.min(fMin[0] - 1.0, meshBounds.min[0] - 1.0),
                    Math.min(0.0, Math.min(fMin[1] - 0.5, meshBounds.min[1] - 0.5)),
                    Math.min(fMin[2] - 1.0, meshBounds.min[2] - 1.0)
                ] as [number, number, number],
                max: [
                    Math.max(fMax[0] + 1.0, meshBounds.max[0] + 1.0),
                    Math.max(fMax[1] + 1.0, meshBounds.max[1] + 1.0),
                    Math.max(fMax[2] + 1.0, meshBounds.max[2] + 1.0)
                ] as [number, number, number]
            };
            const meta = {
                generator: generatedAny ? this.generator.name : 'cached-beautified-plates',
                modelsUsed: Array.from(new Set(reports.map(r => r.modelUsed).filter((m): m is string => !!m))),
                mode, anchor: req.anchor, glbPath: req.glbPath,
                eyeHeight: stations[0]?.cameraHeightAboveGround ?? 1.7,
                cropBox, fusedSplatCount: fusedCount, ...(surface ? { surfaceLayer: surface } : { voxelSizeMeters: voxel }), ...(containment ? { containment } : {}),
                stations: reports, tiles: { tileCount: tileRes.tileCount, levels: tileRes.levels, tileBytes: tileRes.tileBytes },
                createdAt: new Date().toISOString()
            };
            await fs.writeJson(metaPath, meta, { spaces: 2 });
            report(1, 'Done');
            return { success: true, stations: reports, fusedSplatPath, ...(surface ? { spzPath } : {}), fusedSplatCount: fusedCount, tilesetPath, metaPath, cropBox, durationMs: Date.now() - t0 };
        } catch (e: any) {
            // A stopped run is not a pipeline failure: the caller gets the stop itself.
            throwIfStopped(signal);
            return { success: false, stations: [], fusedSplatPath, fusedSplatCount: 0, tilesetPath, metaPath, cropBox: { min: [0, 0, 0], max: [0, 0, 0] }, durationMs: Date.now() - t0, error: e?.message || String(e) };
        }
    }

    /** Writes raw RGB + f32 depth + pose json for the aligned station and runs the native baker. */
    private async bakeStation(baker: string, res: BeautifyStationResult, outSplat: string, req: SurveySplatPipelineRequest): Promise<{ splatCount: number; splatPath: string }> {
        const img = res.image;
        // Retain full 2K resolution if available; otherwise use blockout dimensions
        const width = (img && img.width && img.width > res.blockout.width) ? img.width : res.blockout.width;
        const height = (img && img.height && img.height > res.blockout.height) ? img.height : res.blockout.height;

        let rgb: Buffer;
        if (img && img.width === width && img.height === height) {
            rgb = Buffer.alloc(width * height * 3);
            for (let i = 0; i < width * height; i++) {
                const si = i * 4, di = i * 3;
                rgb[di] = img.rgba[si];
                rgb[di + 1] = img.rgba[si + 1];
                rgb[di + 2] = img.rgba[si + 2];
            }
        } else {
            rgb = Buffer.alloc(width * height * 3);
            for (let y = 0; y < height; y++) {
                const sy = Math.min(img.height - 1, Math.floor(y * img.height / height));
                for (let x = 0; x < width; x++) {
                    const sx = Math.min(img.width - 1, Math.floor(x * img.width / width));
                    const si = (sy * img.width + sx) * 4, di = (y * width + x) * 3;
                    rgb[di] = img.rgba[si]; rgb[di + 1] = img.rgba[si + 1]; rgb[di + 2] = img.rgba[si + 2];
                }
            }
        }
        // Depth for the ALIGNED pose (QC may have moved the camera slightly): re-render mesh depth there
        const renderer = new SurveyStationRenderService();
        renderer.setMesh((await this.meshFor(req.glbPath)));
        const aligned = req.renderProvider === 'pathtracer'
            ? await renderer.renderStation(res.alignedStation, {
                renderMode: 'albedo',
                glbPath: req.glbPath,
                width,
                height,
                sun: req.sun,
                stoneType: req.stoneType
            })
            : renderer.renderStationBlockout(res.alignedStation, { width, height });
        const depth = Buffer.from(aligned.depth.buffer, aligned.depth.byteOffset, aligned.depth.byteLength);
        const { right, up, forward } = cameraBasis(res.alignedStation.forwardVector, res.alignedStation.upVector || [0, 1, 0]);
        const alt = res.alignedStation.cameraAltitude ?? res.alignedStation.positionLocalENU?.[1] ?? res.alignedStation.cameraHeightAboveGround ?? 50.0;
        const pose = { fx: aligned.intrinsics.fx, fy: aligned.intrinsics.fy, cx: aligned.intrinsics.cx, cy: aligned.intrinsics.cy, eye: res.alignedStation.positionLocalENU, right, up, forward, cameraAltitude: alt, depthKind: 'camera-z' };
        const base = outSplat.replace(/\.splat$/, '');
        await fs.outputFile(`${base}.rgb`, rgb);
        await fs.outputFile(`${base}.depth.f32`, depth);
        await fs.writeJson(`${base}.pose.json`, pose);
        const dropFoliageArg = req.dropFoliage !== false ? '--drop-foliage' : '';
        const foliageModeArg = req.foliageMode ? `--foliage-mode ${req.foliageMode}` : '';
        const enablePhoto = (req.enablePhotometricMicroDepth !== false && req.enableHybridMicroDepth !== false);
        const hybridArg = enablePhoto ? `--photometric-micro-depth --cavity-depth ${req.cavityDepth ?? 0.0} --cavity-lum ${req.cavityLum ?? 0.18}` : '';
        const neuralDepthArg = req.neuralDepthPath ? `--neural-depth "${req.neuralDepthPath}"` : '';
        const neuralWeightArg = req.neuralDepthWeight !== undefined ? `--neural-depth-weight ${req.neuralDepthWeight}` : '';
        const maxDeltaZArg = req.maxDeltaZ !== undefined ? `--max-delta-z ${req.maxDeltaZ}` : '';
        const sigmaScaleArg = req.sigmaScale !== undefined ? `--sigma-scale ${req.sigmaScale}` : '';
        const minCosIncidenceArg = `--min-cos-incidence ${req.minCosIncidence ?? 0.20}`;
        const erodeSilhouetteArg = `--erode-silhouette ${req.erodeSilhouettePx ?? 2}`;
        const twoDgsArg = (req.use2dgs !== false || req.surfaceModel === 'planar') ? '--2dgs' : '';
        const shDegreeArg = (req.shDegree !== undefined && req.shDegree > 0) ? `--sh-degree ${req.shDegree}` : '';
        const exposureScaleArg = (req.exposureScale !== undefined) ? `--exposure-scale ${req.exposureScale}` : '';
        const cmd = `"${baker}" --rgb "${base}.rgb" --depth "${base}.depth.f32" --width ${width} --height ${height} --pose "${base}.pose.json" --out-splat "${outSplat}" --stride ${req.bakeStride ?? 1} --station-altitude ${alt} ${sigmaScaleArg} ${minCosIncidenceArg} ${dropFoliageArg} ${foliageModeArg} ${erodeSilhouetteArg} ${hybridArg} ${neuralDepthArg} ${neuralWeightArg} ${maxDeltaZArg} ${twoDgsArg} ${shDegreeArg} ${exposureScaleArg} --exclude-underside --json`;
        let stdout: string;
        try {
            ({ stdout } = await execAsync(cmd, { maxBuffer: 8 * 1024 * 1024, signal: req.signal }));
        } finally {
            // The raw inputs go whether the baker finished, failed or was stopped.
            await fs.remove(`${base}.rgb`); await fs.remove(`${base}.depth.f32`);
        }
        let splatCount = 0;
        try {
            const parsed = JSON.parse(stdout.trim());
            splatCount = parsed.numSplats ?? 0;
        } catch {
            const st = await fs.stat(outSplat);
            splatCount = Math.floor(st.size / 32);
        }
        return { splatCount, splatPath: outSplat };
    }

    private meshCache: { path: string; mesh: any } | null = null;
    private async meshFor(glbPath: string) {
        if (this.meshCache && this.meshCache.path === glbPath) return this.meshCache.mesh;
        const { HeadlessMeshSilhouetteRenderer } = await import('./HeadlessMeshSilhouetteRenderer');
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        this.meshCache = { path: glbPath, mesh };
        return mesh;
    }

    static medianSigma(splats: BakedGaussian[]): number {
        if (splats.length === 0) return 0.05;
        const step = Math.max(1, Math.floor(splats.length / 5000));
        const v: number[] = [];
        for (let i = 0; i < splats.length; i += step) v.push(Math.max(splats[i].scale[0], splats[i].scale[1]));
        v.sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)];
    }

    /**
     * Voxel-hash fusion across stations. Within a voxel the splat whose station viewed the surface
     * most head-on wins (smallest elongation => smallest scale[0]/scale[1] ratio), so grazing views
     * do not smear over frontal ones; colours of ties are averaged.
     */
    static fuse(sets: { splats: BakedGaussian[]; station: ColmapCameraPose }[], voxel: number): BakedGaussian[] {
        const grid = new Map<string, BakedGaussian>();
        const inv = 1 / voxel;
        const elong = (s: BakedGaussian) => Math.max(s.scale[0], s.scale[1]) / Math.max(1e-6, Math.min(s.scale[0], s.scale[1]));
        for (const set of sets) {
            for (const s of set.splats) {
                const key = `${Math.floor(s.position[0] * inv)},${Math.floor(s.position[1] * inv)},${Math.floor(s.position[2] * inv)}`;
                const e = grid.get(key);
                if (!e) { grid.set(key, { ...s, position: [...s.position] as any, scale: [...s.scale] as any, colorRgb: [...s.colorRgb] as any }); continue; }
                const ea = elong(e), sa = elong(s);
                if (sa < ea * 0.9) grid.set(key, { ...s, position: [...s.position] as any, scale: [...s.scale] as any, colorRgb: [...s.colorRgb] as any });
                else if (sa <= ea * 1.1) { e.colorRgb[0] = (e.colorRgb[0] + s.colorRgb[0]) / 2; e.colorRgb[1] = (e.colorRgb[1] + s.colorRgb[1]) / 2; e.colorRgb[2] = (e.colorRgb[2] + s.colorRgb[2]) / 2; }
            }
        }
        return Array.from(grid.values());
    }

    /** AABB of the fused splats, clamped to the mesh extent: the viewer's discard volume. */
    static cropBox(_stations: ColmapCameraPose[], meshBounds: { min: [number, number, number]; max: [number, number, number] }, splats: BakedGaussian[]): { min: [number, number, number]; max: [number, number, number] } {
        const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        const step = Math.max(1, Math.floor(splats.length / 20000));
        for (let i = 0; i < splats.length; i += step) for (let k = 0; k < 3; k++) { const v = splats[i].position[k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
        for (let k = 0; k < 3; k++) { min[k] = Math.max(min[k] - 0.5, meshBounds.min[k] - 0.5); max[k] = Math.min(max[k] + 0.5, meshBounds.max[k] + 0.5); }
        return { min, max };
    }

    /**
     * A file under the served `public/` folder as its web path; a URL or a web path as given; anything else as file://.
     * An absolute file path is a file, not a web path: the pipeline's outputs are absolute and must reach the viewer as
     * /tilesets/..., never as /Users/....
     */
    public static toWebUrl(filePath: string): string {
        if (!filePath) return '';
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) return filePath;
        const rel = path.relative(path.resolve(process.cwd(), 'public'), path.resolve(filePath));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `/${rel.replace(/\\/g, '/')}`;
        // a web path already (e.g. /tilesets/x/fused.splat), not a file on this machine
        if (filePath.startsWith('/') && !fs.existsSync(filePath)) return filePath;
        return `file://${filePath}`;
    }

    /**
     * Converts a SurveySplatPipelineResult into standard Canvas Scene3DData and Media4DObject contracts.
     */
    public static toScene3DData(
        result: SurveySplatPipelineResult,
        anchor: GeodeticAnchor,
        locationName: string = 'Location',
        options: {
            splatScale?: number;
            contactShadow?: boolean;
            enableSoftZ?: boolean;
            /**
             * Where a viewer stands (the splat frame) and the compass heading they look along: the scene opens there in
             * first-person (walk) mode instead of orbiting the place from above.
             */
            vantage?: { eye: [number, number, number]; headingDeg: number };
        } = {}
    ): { scene3DData: Scene3DData; splatMediaObject: Media4DObject } {
        const splatUrl = SurveySplatPipelineService.toWebUrl(result.spzPath ?? result.fusedSplatPath);
        const tilesetUrl = SurveySplatPipelineService.toWebUrl(result.tilesetPath);
        const sceneSlug = locationName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const vantage = options.vantage;
        // the look direction on the ground (x east, z south): heading clockwise from north
        const look: [number, number] = vantage ? [Math.sin(vantage.headingDeg * Math.PI / 180), -Math.cos(vantage.headingDeg * Math.PI / 180)] : [0, 0];

        const splatMediaObject: Media4DObject = {
            id: `${sceneSlug}-3dgs`,
            content: {
                type: 'gaussian-splat',
                durableUri: splatUrl,
                mimeType: splatUrl.endsWith('.spz') ? 'application/x-spz' : 'application/octet-stream',
                metadata: {
                    dims: {
                        width: Math.abs(result.cropBox.max[0] - result.cropBox.min[0]) || 120,
                        height: Math.abs(result.cropBox.max[1] - result.cropBox.min[1]) || 120,
                        depth: Math.abs(result.cropBox.max[2] - result.cropBox.min[2]) || 120
                    }
                }
            },
            space: {
                spatial3d: { x: 0, y: 0, z: 0 },
                geoAnchor: {
                    lat: anchor.lat,
                    lng: anchor.lng,
                    alt: anchor.elevationMeters || 0,
                    heading: anchor.headingDeg || 0,
                    pitch: 0
                }
            },
            lineage: {
                version: 1,
                generation: {
                    model: 'nano-banana-survey-3dgs',
                    prompt: `Location 3D Gaussian Splatting of ${locationName}`,
                    params: { pipeline: 'SurveySplatPipelineService', restyleModel: 'nano-banana-2' }
                },
                timestamp: new Date().toISOString()
            }
        };

        const scene3DData: Scene3DData = {
            title: `${locationName} — 3D Gaussian Splat`,
            subtitle: `Photorealistic 3DGS radiance field at Lat ${anchor.lat.toFixed(4)}°, Lng ${anchor.lng.toFixed(4)}° synthesized via Nano Banana multi-station capture and C++20 metric depth unprojection.`,
            worldBranch: `splat-world/${sceneSlug}`,
            sceneType: 'gaussian_splat',
            renderMode: 'pbr',
            cameraMode: vantage ? 'fps' : 'orbit',
            animation: vantage ? 'idle' : 'orbit',
            splatUrl,
            // a world served from /tilesets is opened and saved by its folder name (/api/worlds, world-scenes.ts)
            ...(splatUrl.startsWith('/tilesets/') ? { world: { slug: path.basename(path.dirname(result.spzPath ?? result.fusedSplatPath)) } } : {}),
            splatTilesetUrl: tilesetUrl,
            splatOptions: {
                splatScale: options.splatScale ?? 1.0,
                contactShadow: options.contactShadow ?? true,
                enableSoftZ: options.enableSoftZ ?? true,
                cropBox: result.cropBox
            },
            timeline: {
                currentTimeMs: 0,
                durationMs: 20000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: vantage
                ? { position: vantage.eye, target: [vantage.eye[0] + 20 * look[0], vantage.eye[1], vantage.eye[2] + 20 * look[1]], fov: 60, keepPoseOnLoad: true }
                : { position: [0, 20, 45], target: [0, 2, 0], fov: 45 },
            // no uninvited atmosphere (AGENTS.md 3.6): the splat carries its own (even) light, the scene is a neutral studio
            environment: {
                skybox: 'studio',
                lighting: 'studio',
                ground: false
            },
            geoAnchor: {
                lat: anchor.lat,
                lng: anchor.lng,
                elevation: anchor.elevationMeters,
                // the splat is the world (built from these tiles): live tiles streamed around it would cover it with
                // their coarser copy of the same place, so the place is kept for reference, not streamed
                active: false,
                landmarkName: locationName
            },
            customMeshes: [],
            objects: [splatMediaObject]
        };

        return { scene3DData, splatMediaObject };
    }
}

export { EMPTY_DEPTH };
