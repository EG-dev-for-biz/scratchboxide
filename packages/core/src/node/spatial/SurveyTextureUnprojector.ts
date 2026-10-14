/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { stationToPinhole, cameraBasis, type PinholeIntrinsics } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService, EMPTY_DEPTH, solarAtUtcInstant } from './SurveyStationRenderService';
import { BeautifyStationService, type StationImageGenerator, type BeautifyStationResult } from './BeautifyStationService';
import type { StationBeautifyContext } from '../../browser/generative-canvas/services/location-beautify-service';
import { AlgorithmicUvEngine, type PbrDecompositionOptions, type PbrDecompositionResult } from './AlgorithmicUvEngine';
import { MaxRectsAtlasPacker, type TextureItem } from './TextureAtlasPacker';
import { encodePng, decodePng, resampleRgba } from '../texture-processing';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { StationRadianceEqualizer, type RadianceEqualizationOptions } from './StationRadianceEqualizer';
import { readImageDimensions } from '../image-codec-ffmpeg';

export interface StationPlate {
    station: ColmapCameraPose;
    rgba: Buffer | Uint8Array;
    width: number;
    height: number;
    depth: Float32Array;
    pose: CameraPose6DOF;
    intrinsics: PinholeIntrinsics;
    /**
     * Optional registration quality in [0, 1]. When set it multiplies this plate's blend weight
     * and best-view score; plates with poseQuality <= 0 are ignored. Undefined behaves as 1.
     */
    poseQuality?: number;
    /**
     * Optional per-channel linear-light gain applied to every sample taken from this plate, in float
     * (no 8-bit requantisation), e.g. exposure / white-balance normalisation. Undefined = unchanged.
     */
    linearGain?: [number, number, number];
}

/** Robust (IRLS Huber) re-weighting of multi-view observations. Opt-in. */
export interface RobustReweightingOptions {
    enabled?: boolean;
    /** Only texels with at least this many observations are re-weighted. Default 3. */
    minObservations?: number;
    /** Huber threshold as a CIELAB Delta-E (CIE76) residual. Default 10. */
    huberDeltaE?: number;
    /** IRLS iterations starting from the weighted per-channel median. Default 3. */
    iterations?: number;
}

/**
 * Per-texel accumulation buffers returned when `returnAccumulators` is set.
 * All arrays are row-major `width * height` (x3 for RGB/vector fields).
 */
export interface SurveyTexelAccumulators {
    width: number;
    height: number;
    /** Weighted mean plate colour (sRGB, 0..255 floats); valid where weightSum > 0. */
    meanRgb: Float32Array;
    /** Sum of blend weights (score^2 * poseQuality, after robust re-weighting when enabled). */
    weightSum: Float32Array;
    /** Sum of score^2 without poseQuality (weightSum / rawWeightSum = weighted mean poseQuality). */
    rawWeightSum: Float32Array;
    /** Best single-view score (cos^gamma / sqrt(distance), times poseQuality). */
    bestScore: Float32Array;
    /** Number of accepted observations. */
    obsCount: Uint16Array;
    /** 1 where the texel centre lies inside a UV chart of this primitive. */
    coverage: Uint8Array;
    /** Largest accepted incidence cosine. */
    maxCosIncidence: Float32Array;
    /** Smallest plate-pixel footprint on the surface, metres (Infinity where unobserved). */
    minFootprintMeters: Float32Array;
    /** Edge length of one atlas texel on the surface, metres (from the UV Jacobian; 0 outside charts). */
    texelSizeMeters: Float32Array;
    /** World position per texel (last covering triangle). */
    worldPositions: Float32Array;
    /** World normal per texel used for incidence (face or interpolated per `incidenceNormal`). */
    worldNormals: Float32Array;
    /** Effective / original weight after robust re-weighting (1 where not re-weighted). */
    robustInlierFraction?: Float32Array;
}

export interface SurveyTextureUnprojectorOptions {
    /** Target UV atlas resolution (e.g. 2048, 4096, 8192). Default 4096. */
    resolution?: number;
    /** Station plate render width for software rasterization. Default 1280. */
    renderWidth?: number;
    /** Station plate render height for software rasterization. Default 720. */
    renderHeight?: number;
    /** Absolute metric depth tolerance in meters for occlusion testing. Default 0.20m. */
    depthTolerance?: number;
    /** Relative depth tolerance scaling with camera distance. Default 0.02 (2%). */
    depthRelativeTolerance?: number;
    /** Drop views seen more edge-on than this incidence cosine. Default 0.08 (~85 degrees). */
    minCosIncidence?: number;
    /** Exponent for orthogonal normal weighting: (cos theta)^gamma. Default 2.0. */
    angleWeightExponent?: number;
    /** Number of gutter dilation bleed pixels to prevent edge fringing. Default 4. */
    edgeBleedPixels?: number;
    /** Default stone fallback color if a surface is never observed. Default limestone [210, 205, 195]. */
    defaultColor?: [number, number, number];
    /** Solar ephemeris coordinates and timestamp for NOAA inverse de-lighting. */
    solarDelighting?: {
        lat?: number;
        lng?: number;
        isoDate?: string;
    };
    /** Fast draft mode: generates lightweight station plates, bypasses iterative rerolls, auto-selects aspect ratio. */
    draft?: boolean;
    /** Station plate aspect ratio mode ('auto' to derive dynamically per station, or explicit '16:9', '9:16', '3:4', etc.). */
    aspectRatio?: string;
    /** Multi-station angle-weighted super-resolution blending (default true). */
    multiStationBlend?: boolean;
    /** Cross-station radiance and color temperature equalization across overlapping camera frustums. */
    radianceEqualization?: RadianceEqualizationOptions;
    /** Metric Jacobian surface scaling for facet-level micro-tooth (default true). */
    metricJacobianScaling?: boolean;
    /** PBR material decomposition options (Scharr normals, Toksvig roughness, HBAO, dielectric glass). */
    pbrDecomposition?: PbrDecompositionOptions;
    /** Output path for the enhanced GLB. */
    outGlbPath?: string;

    // ---- Opt-in extensions (all default to the legacy behaviour above) ----

    /** Attach per-texel accumulators (`SubmeshTextureResult.accumulators`). Requires multiStationBlend (default). Default false. */
    returnAccumulators?: boolean;
    /**
     * Per-primitive atlas scale relative to the primitive's baseColor source image size
     * (or relative to `resolution` when that is set). A number applies to every primitive;
     * an array or function supplies a scale per primitive index. Default: unset (legacy sizing).
     */
    resolutionScale?: number | ArrayLike<number> | ((primitiveIndex: number) => number);
    /**
     * 'legacy' (default): texel x = u*(W-1), plates sampled at the projected coordinate.
     * 'gl': texel centres (x = u*W - 0.5) and pixel-centre plate sampling, matching GPU texture lookup.
     */
    texelCenter?: 'legacy' | 'gl';
    /**
     * 'interpolated' (default): barycentric vertex normals (smooth normals are synthesised when the mesh has none).
     * 'face': geometric face normal from triangle winding; use for normal-less photogrammetry tiles.
     */
    incidenceNormal?: 'interpolated' | 'face';
    /** Skip AlgorithmicUvEngine.decomposePbr; albedo is the blended atlas and the other maps are flat. Default false. */
    skipPbrDecomposition?: boolean;
    /** When false, no PNGs are encoded and processGlbWithSurveyStations returns the input GLB unchanged. Default true. */
    encodeTextures?: boolean;
    /** Robust IRLS Huber re-weighting of texels with enough observations. Default disabled. */
    robustReweighting?: RobustReweightingOptions;
    /** Conservative per-triangle camera culling (behind-plane in 'face' mode, frustum). Result-preserving speed-up. Default false. */
    perTriangleCameraCulling?: boolean;
}

export interface StationContribution {
    stationId: number;
    texelCount: number;
    fraction: number;
}

export interface UnprojectionMetrics {
    resolution: number;
    totalAtlasTexels: number;
    coveredMeshTexels: number;
    directlyPaintedTexels: number;
    fillRate: number;
    stationContributions: StationContribution[];
    durationMs: number;
}

export interface SubmeshTextureResult {
    primitiveIndex: number;
    materialIndex?: number;
    /** Atlas width (legacy name; atlases are square unless resolutionScale yields a non-square source). */
    resolution: number;
    /** Atlas width in texels. */
    width?: number;
    /** Atlas height in texels. */
    height?: number;
    /** Present when options.returnAccumulators is true. */
    accumulators?: SurveyTexelAccumulators;
    albedoPng: Buffer;
    normalPng: Buffer;
    ormPng: Buffer;
    roughnessPng: Buffer;
    aoPng: Buffer;
    metallicPng: Buffer;
    metrics: UnprojectionMetrics;
    pbrResult?: PbrDecompositionResult;
}

export interface SurveyTextureResult {
    success: boolean;
    glbBuffer: Buffer;
    outGlbPath?: string;
    albedoPng: Buffer;
    normalPng: Buffer;
    ormPng: Buffer;
    roughnessPng: Buffer;
    aoPng: Buffer;
    metallicPng: Buffer;
    metrics: UnprojectionMetrics;
    pbrResult?: PbrDecompositionResult;
    submeshes?: SubmeshTextureResult[];
}

export interface SurveyTexturePipelineRequest {
    glbPath: string;
    anchor?: GeodeticAnchor;
    stations: ColmapCameraPose[];
    beautifyContext?: StationBeautifyContext;
    generator?: StationImageGenerator;
    precomputedPlates?: StationPlate[];
    options?: SurveyTextureUnprojectorOptions;
    /** Progress for long runs (one report per station and per baked submesh); `fraction` is 0..1. */
    onProgress?: (message: string, fraction: number) => void;
    /** Stops the run between stations and between submeshes. */
    signal?: AbortSignal;
}

/** Throws the signal's reason (or a plain abort error) once the caller has asked the pipeline to stop. */
function throwIfStopped(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Survey texture bake was stopped'), { name: 'AbortError' });
}

export interface MeshPrimitiveData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    materialIndex?: number;
}

/**
 * Precomputed station projection camera parameters for fast scanline projection.
 */
export interface PreparedCamera {
    station: ColmapCameraPose;
    pose: CameraPose6DOF;
    width: number;
    height: number;
    rgba: Buffer | Uint8Array;
    depth: Float32Array;
    eye: [number, number, number];
    right: [number, number, number];
    up: [number, number, number];
    fwd: [number, number, number];
    P00: number;
    P11: number;
    halfW: number;
    halfH: number;
    VP: Float32Array;
    /** Plate poseQuality (undefined = 1). */
    poseQuality?: number;
    /** Plate linearGain (undefined = no gain). */
    linearGain?: [number, number, number];
}

/** Shared per-observation parameters for {@link SurveyTextureUnprojector.observeTexel}. */
interface ObserveParams {
    minCosIncidence: number;
    angleExp: number;
    depthTol: number;
    depthRelTol: number;
    /** Subtract 0.5 px before bilinear plate sampling (pixel-centre convention). */
    pixelCentre: boolean;
}

/** sRGB 8-bit -> linear lookup used by the robust Lab residuals. */
const SRGB_TO_LINEAR_LUT: Float32Array = (() => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return lut;
})();

/**
 * Survey-to-Atlas Inverse Projection (SAIP) Engine:
 * Back-projects generative AI Beautify camera station plates directly into the
 * model's consolidated UV atlas using MaxRects packing, analytical metric-depth
 * occlusion testing, orthogonal normal weighting, and PBR biophysical decomposition.
 */
export class SurveyTextureUnprojector {
    /**
     * Executes the complete end-to-end Survey-to-Atlas Inverse Projection pipeline.
     */
    public static async processGlbWithSurveyStations(
        request: SurveyTexturePipelineRequest
    ): Promise<SurveyTextureResult> {
        const startTime = performance.now();
        const glbBuffer = await fs.readFile(request.glbPath);
        const options = request.options || {};
        const isDraft = options.draft === true;
        const defaultResolution = options.resolution;

        // Fidelity check: enforce agreement between generator and options.draft
        let generator = request.generator;
        if (generator) {
            if (isDraft && generator.fidelity && generator.fidelity !== 'draft') {
                throw new Error(`Generator fidelity (${generator.fidelity}) disagrees with options.draft (draft)`);
            }
            if (!isDraft && generator.fidelity === 'draft') {
                throw new Error('Generator fidelity (draft) disagrees with options.draft (production)');
            }
        } else if (!request.precomputedPlates || request.precomputedPlates.length === 0) {
            try {
                const { GoogleMediaGenerationService } = await import('../google-media-generation-service');
                const { GoogleMediaCredentialsService } = await import('../google-media-credentials-service');
                const { MediaAssetStore } = await import('../media-asset-store');
                const { createGoogleStationImageGenerator } = await import('./BeautifyStationService');

                const credentials = new GoogleMediaCredentialsService();
                const assetStore = new MediaAssetStore();
                const mediaService = new GoogleMediaGenerationService(assetStore, () => credentials.createClient());
                generator = createGoogleStationImageGenerator({
                    mediaService,
                    assetStore,
                    workspaceRoot: process.cwd(),
                    fidelity: isDraft ? 'draft' : 'production',
                    imageSize: isDraft ? '1K' : '2K'
                });
            } catch {
                // Ignore if Google GenAI unavailable in environment
            }
        }

        // 1. Prepare station plates (render blockouts + depth + beautified RGBA)
        let plates: StationPlate[] = [];
        if (request.precomputedPlates && request.precomputedPlates.length > 0) {
            plates = request.precomputedPlates;
        } else {
            plates = await this.renderAndBeautifyStations(
                glbBuffer,
                request.stations,
                request.beautifyContext,
                generator,
                options,
                request
            );
        }

        if (plates.length === 0) {
            throw new Error('SurveyTextureUnprojector: No valid station plates available for unprojection');
        }

        const { primitives, glbJson, glbBin } = this.loadMeshPrimitives(glbBuffer, defaultResolution || 1024);

        // 3. Precompute station projection matrices and camera basis frames
        const preparedCameras: PreparedCamera[] = this.prepareCameras(plates);

        // 4. Unproject each submesh primitive into its own original-UV atlas
        const submeshResults: SubmeshTextureResult[] = [];
        // Stations are most of the time when they are generated here; baking the atlases is the rest.
        const bakeStart = request.precomputedPlates && request.precomputedPlates.length > 0 ? 0 : 0.6;
        for (let i = 0; i < primitives.length; i++) {
            throwIfStopped(request.signal);
            request.onProgress?.(`Baking texture ${i + 1}/${primitives.length}`, bakeStart + (1 - bakeStart) * (i / primitives.length));
            const prim = primitives[i];
            let primW: number;
            let primH: number;
            if (options.resolutionScale !== undefined) {
                const size = this.determinePrimitiveAtlasSize(prim, i, glbJson, glbBin, options);
                primW = size.width;
                primH = size.height;
            } else {
                primW = primH = this.determinePrimitiveResolution(prim, glbJson, glbBin, defaultResolution);
            }
            console.log(`[SurveyTextureUnprojector] Submesh ${i + 1}/${primitives.length}: ${prim.indices.length / 3} tris, target res ${primW}x${primH}...`);
            const subT0 = performance.now();
            const sub = await this.unprojectPrimitiveToAtlas(prim, i, preparedCameras, options, primW, primH);
            console.log(`[SurveyTextureUnprojector] Submesh ${i + 1}/${primitives.length} finished in ${((performance.now() - subT0) / 1000).toFixed(2)}s`);
            submeshResults.push(sub);
            // The bake is synchronous per submesh; yield so a Stop (an I/O event) can land between submeshes.
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        throwIfStopped(request.signal);

        // 5. Embed per-submesh textures into GLB without mutating original UV accessors.
        //    With encodeTextures === false there is nothing to embed: the input GLB is returned as-is.
        const encodeTextures = options.encodeTextures !== false;
        const updatedGlb = encodeTextures
            ? this.embedPerSubmeshTexturesIntoGlb(glbJson, glbBin, submeshResults)
            : glbBuffer;

        if (options.outGlbPath && encodeTextures) {
            await fs.ensureDir(path.dirname(options.outGlbPath));
            await fs.writeFile(options.outGlbPath, updatedGlb);
        }

        // 6. Aggregate overall metrics across submeshes
        let totalCoveredTexels = 0;
        let totalPaintedTexels = 0;
        let totalTexelArea = 0;
        const mergedStationTexels = new Map<number, number>();

        for (const sub of submeshResults) {
            totalCoveredTexels += sub.metrics.coveredMeshTexels;
            totalPaintedTexels += sub.metrics.directlyPaintedTexels;
            totalTexelArea += sub.resolution * sub.resolution;
            for (const sc of sub.metrics.stationContributions) {
                mergedStationTexels.set(sc.stationId, (mergedStationTexels.get(sc.stationId) || 0) + sc.texelCount);
            }
        }

        const stationContributions: StationContribution[] = [];
        for (const [stId, count] of mergedStationTexels.entries()) {
            stationContributions.push({
                stationId: stId,
                texelCount: count,
                fraction: totalPaintedTexels > 0 ? count / totalPaintedTexels : 0
            });
        }
        stationContributions.sort((a, b) => b.texelCount - a.texelCount);

        const primarySub = submeshResults[0];
        const overallMetrics: UnprojectionMetrics = {
            resolution: primarySub.metrics.resolution,
            totalAtlasTexels: totalTexelArea,
            coveredMeshTexels: totalCoveredTexels,
            directlyPaintedTexels: totalPaintedTexels,
            fillRate: totalTexelArea > 0 ? totalCoveredTexels / totalTexelArea : 0,
            stationContributions,
            durationMs: performance.now() - startTime
        };

        return {
            success: true,
            glbBuffer: updatedGlb,
            outGlbPath: encodeTextures ? options.outGlbPath : undefined,
            albedoPng: primarySub.albedoPng,
            normalPng: primarySub.normalPng,
            ormPng: primarySub.ormPng,
            roughnessPng: primarySub.roughnessPng,
            aoPng: primarySub.aoPng,
            metallicPng: primarySub.metallicPng,
            metrics: overallMetrics,
            pbrResult: primarySub.pbrResult,
            submeshes: submeshResults
        };
    }

    /**
     * Unprojects survey station plates into an individual submesh primitive's atlas
     * using its native [0, 1] UV space without repacking or texture bleeding.
     */
    public static async unprojectPrimitiveToAtlas(
        prim: MeshPrimitiveData,
        primIndex: number,
        preparedCameras: PreparedCamera[],
        options: SurveyTextureUnprojectorOptions,
        resolution: number,
        atlasHeight?: number
    ): Promise<SubmeshTextureResult> {
        const atlasW = resolution;
        const atlasH = atlasHeight !== undefined && atlasHeight > 0 ? atlasHeight : resolution;
        const totalTexels = atlasW * atlasH;
        const atlasRgba = Buffer.alloc(totalTexels * 4);
        const atlasBestScore = new Float32Array(totalTexels);
        const atlasBestStation = new Int32Array(totalTexels);
        atlasBestStation.fill(-1);
        const atlasCoverage = new Uint8Array(totalTexels);
        const atlasTexelDensity = new Float32Array(totalTexels);
        const atlasWorldPos = new Float32Array(totalTexels * 3);
        const atlasWorldNorm = new Float32Array(totalTexels * 3);

        // Multi-station angle-weighted super-resolution blending accumulators
        const useMultiBlend = options.multiStationBlend ?? true;
        const atlasR = new Float32Array(totalTexels);
        const atlasG = new Float32Array(totalTexels);
        const atlasB = new Float32Array(totalTexels);
        const atlasWeight = new Float32Array(totalTexels);
        const atlasColorSqSum = new Float32Array(totalTexels);
        const atlasObsCount = new Uint16Array(totalTexels);

        const defaultCol = options.defaultColor || [210, 205, 195];
        const minCosIncidence = options.minCosIncidence ?? 0.08;
        const angleExp = options.angleWeightExponent ?? 2.0;
        const depthTol = options.depthTolerance ?? 0.20;
        const depthRelTol = options.depthRelativeTolerance ?? 0.02;

        // Opt-in modes (all false/undefined by default => legacy arithmetic)
        const glTexelCentres = options.texelCenter === 'gl';
        const faceIncidence = options.incidenceNormal === 'face';
        const wantAccumulators = options.returnAccumulators === true;
        const robustOpts = options.robustReweighting;
        const robustEnabled = robustOpts?.enabled === true && useMultiBlend;
        const cullPerTriangle = options.perTriangleCameraCulling === true;
        const observeParams: ObserveParams = {
            minCosIncidence,
            angleExp,
            depthTol,
            depthRelTol,
            pixelCentre: glTexelCentres
        };
        const obs = new Float64Array(8);

        const atlasRawWeight = wantAccumulators ? new Float32Array(totalTexels) : undefined;
        const atlasMaxCos = wantAccumulators ? new Float32Array(totalTexels) : undefined;
        const atlasMinFootprint = wantAccumulators ? new Float32Array(totalTexels).fill(Infinity) : undefined;
        const atlasTexelSize = wantAccumulators ? new Float32Array(totalTexels) : undefined;

        const stationTexelCounts = new Map<number, number>();
        for (const cam of preparedCameras) {
            stationTexelCounts.set(cam.station.id, 0);
        }

        // Cameras with poseQuality <= 0 never contribute.
        const usableCameras = preparedCameras.filter(c => c.poseQuality === undefined || c.poseQuality > 0);
        const camCount = usableCameras.length;
        const triCams = new Int32Array(camCount);
        let triCamCount = camCount;
        for (let k = 0; k < camCount; k++) triCams[k] = k;

        const { positions, normals, uvs, indices } = prim;
        const triCount = Math.floor(indices.length / 3);

        // Atlas pixel mapping: legacy u*(W-1) or GL texel centres u*W - 0.5
        const uScale = glTexelCentres ? atlasW : atlasW - 1;
        const vScale = glTexelCentres ? atlasH : atlasH - 1;
        const uvOffset = glTexelCentres ? -0.5 : 0;

        for (let t = 0; t < triCount; t++) {
            const i0 = indices[t * 3];
            const i1 = indices[t * 3 + 1];
            const i2 = indices[t * 3 + 2];

            // 3D vertices
            const p0: [number, number, number] = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
            const p1: [number, number, number] = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
            const p2: [number, number, number] = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];

            // 3D normals (vertex normals, or the geometric face normal in 'face' mode)
            let n0: [number, number, number];
            let n1: [number, number, number];
            let n2: [number, number, number];
            if (faceIncidence) {
                const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2];
                const gx = p2[0] - p0[0], gy = p2[1] - p0[1], gz = p2[2] - p0[2];
                let cx = ey * gz - ez * gy, cy = ez * gx - ex * gz, cz = ex * gy - ey * gx;
                const cl = Math.hypot(cx, cy, cz);
                if (cl < 1e-12) continue; // degenerate: no defined incidence
                cx /= cl; cy /= cl; cz /= cl;
                n0 = [cx, cy, cz]; n1 = n0; n2 = n0;
            } else {
                n0 = [normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]];
                n1 = [normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]];
                n2 = [normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]];
            }

            // UVs in [0, 1]^2
            const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
            const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
            const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];

            // Map to atlas pixel space
            const U0 = u0 * uScale + uvOffset, V0 = v0 * vScale + uvOffset;
            const U1 = u1 * uScale + uvOffset, V1 = v1 * vScale + uvOffset;
            const U2 = u2 * uScale + uvOffset, V2 = v2 * vScale + uvOffset;

            // 2D bounding box
            const minX = Math.max(0, Math.floor(Math.min(U0, U1, U2)));
            const maxX = Math.min(atlasW - 1, Math.ceil(Math.max(U0, U1, U2)));
            const minY = Math.max(0, Math.floor(Math.min(V0, V1, V2)));
            const maxY = Math.min(atlasH - 1, Math.ceil(Math.max(V0, V1, V2)));

            const denom = (V1 - V2) * (U0 - U2) + (U2 - U1) * (V0 - V2);
            if (Math.abs(denom) < 1e-8) continue;
            const invDenom = 1.0 / denom;

            // Surface area metric for Jacobian texel density
            const d1x = p1[0] - p0[0], d1y = p1[1] - p0[1], d1z = p1[2] - p0[2];
            const d2x = p2[0] - p0[0], d2y = p2[1] - p0[1], d2z = p2[2] - p0[2];
            const areaWorld = 0.5 * Math.hypot(
                d1y * d2z - d1z * d2y,
                d1z * d2x - d1x * d2z,
                d1x * d2y - d1y * d2x
            );
            const du1 = u1 - u0, dv1 = v1 - v0;
            const du2 = u2 - u0, dv2 = v2 - v0;
            const areaUv = 0.5 * Math.abs(du1 * dv2 - dv1 * du2);
            const texelsPerMeterSq = areaWorld > 1e-6 ? (areaUv * totalTexels) / areaWorld : 1.0;
            const texelEdgeMeters = areaWorld > 1e-6 && areaUv > 0 ? Math.sqrt(areaWorld / (areaUv * totalTexels)) : 0;

            if (cullPerTriangle) {
                triCamCount = this.cullCamerasForTriangle(
                    usableCameras, p0, p1, p2, faceIncidence && minCosIncidence > 0 ? n0 : null, triCams
                );
            }

            for (let py = minY; py <= maxY; py++) {
                for (let px = minX; px <= maxX; px++) {
                    const w0 = ((V1 - V2) * (px - U2) + (U2 - U1) * (py - V2)) * invDenom;
                    const w1 = ((V2 - V0) * (px - U2) + (U0 - U2) * (py - V2)) * invDenom;
                    const w2 = 1.0 - w0 - w1;

                    // Inside triangle (with small conservative border)
                    if (w0 >= -0.005 && w1 >= -0.005 && w2 >= -0.005) {
                        const texIdx = py * atlasW + px;
                        atlasCoverage[texIdx] = 1;
                        atlasTexelDensity[texIdx] = texelsPerMeterSq;
                        if (atlasTexelSize) atlasTexelSize[texIdx] = texelEdgeMeters;

                        // Interpolated 3D position & normal
                        const wx = w0 * p0[0] + w1 * p1[0] + w2 * p2[0];
                        const wy = w0 * p0[1] + w1 * p1[1] + w2 * p2[1];
                        const wz = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];

                        atlasWorldPos[texIdx * 3] = wx;
                        atlasWorldPos[texIdx * 3 + 1] = wy;
                        atlasWorldPos[texIdx * 3 + 2] = wz;

                        let nx = w0 * n0[0] + w1 * n1[0] + w2 * n2[0];
                        let ny = w0 * n0[1] + w1 * n1[1] + w2 * n2[1];
                        let nz = w0 * n0[2] + w1 * n1[2] + w2 * n2[2];
                        if (faceIncidence) {
                            nx = n0[0]; ny = n0[1]; nz = n0[2];
                        } else {
                            const nLen = Math.hypot(nx, ny, nz);
                            if (nLen > 1e-6) {
                                nx /= nLen; ny /= nLen; nz /= nLen;
                            }
                        }

                        atlasWorldNorm[texIdx * 3] = nx;
                        atlasWorldNorm[texIdx * 3 + 1] = ny;
                        atlasWorldNorm[texIdx * 3 + 2] = nz;

                        // Project into all candidate station cameras
                        for (let ci = 0; ci < triCamCount; ci++) {
                            const cam = usableCameras[triCams[ci]];
                            if (!this.observeTexel(cam, wx, wy, wz, nx, ny, nz, observeParams, obs)) continue;
                            const r = obs[0], g = obs[1], b = obs[2];
                            const score = obs[3];
                            const q = cam.poseQuality === undefined ? 1 : cam.poseQuality;
                            const qScore = score * q;

                            if (useMultiBlend) {
                                const weight = score * score * q;
                                atlasR[texIdx] += r * weight;
                                atlasG[texIdx] += g * weight;
                                atlasB[texIdx] += b * weight;
                                atlasWeight[texIdx] += weight;
                                atlasColorSqSum[texIdx] += (r * r + g * g + b * b) * weight;
                                atlasObsCount[texIdx]++;
                                if (atlasRawWeight) atlasRawWeight[texIdx] += score * score;
                            }
                            if (atlasMaxCos && atlasMinFootprint) {
                                if (obs[4] > atlasMaxCos[texIdx]) atlasMaxCos[texIdx] = obs[4];
                                if (obs[7] < atlasMinFootprint[texIdx]) atlasMinFootprint[texIdx] = obs[7];
                            }

                            if (qScore > atlasBestScore[texIdx]) {
                                atlasBestScore[texIdx] = qScore;
                                const prevStation = atlasBestStation[texIdx];
                                atlasBestStation[texIdx] = cam.station.id;

                                if (prevStation !== cam.station.id) {
                                    if (prevStation >= 0) {
                                        stationTexelCounts.set(prevStation, (stationTexelCounts.get(prevStation) || 1) - 1);
                                    }
                                    stationTexelCounts.set(cam.station.id, (stationTexelCounts.get(cam.station.id) || 0) + 1);
                                }

                                if (!useMultiBlend) {
                                    const pIdx = texIdx * 4;
                                    atlasRgba[pIdx] = r;
                                    atlasRgba[pIdx + 1] = g;
                                    atlasRgba[pIdx + 2] = b;
                                    atlasRgba[pIdx + 3] = 255;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Optional robust IRLS Huber re-weighting of texels with enough observations
        let atlasInlierFraction: Float32Array | undefined;
        if (robustEnabled) {
            atlasInlierFraction = new Float32Array(totalTexels).fill(1);
            this.robustReweightTexels({
                cameras: usableCameras,
                totalTexels,
                coverage: atlasCoverage,
                obsCount: atlasObsCount,
                worldPos: atlasWorldPos,
                worldNorm: atlasWorldNorm,
                sumR: atlasR,
                sumG: atlasG,
                sumB: atlasB,
                weight: atlasWeight,
                colorSq: atlasColorSqSum,
                rawWeight: atlasRawWeight,
                inlierFraction: atlasInlierFraction,
                params: observeParams,
                minObservations: Math.max(2, robustOpts?.minObservations ?? 3),
                huberDeltaE: robustOpts?.huberDeltaE ?? 10,
                iterations: Math.max(1, robustOpts?.iterations ?? 3)
            });
        }

        // Normalize multi-station blended accumulators and derive view parallax variance
        const atlasViewVariance = new Float32Array(totalTexels);
        const meanRgb = wantAccumulators ? new Float32Array(totalTexels * 3) : undefined;
        if (useMultiBlend) {
            for (let i = 0; i < totalTexels; i++) {
                if (atlasWeight[i] > 0) {
                    const invW = 1.0 / atlasWeight[i];
                    const meanR = atlasR[i] * invW;
                    const meanG = atlasG[i] * invW;
                    const meanB = atlasB[i] * invW;
                    if (meanRgb) {
                        meanRgb[i * 3] = meanR;
                        meanRgb[i * 3 + 1] = meanG;
                        meanRgb[i * 3 + 2] = meanB;
                    }

                    const pIdx = i * 4;
                    atlasRgba[pIdx] = Math.min(255, Math.max(0, Math.round(meanR)));
                    atlasRgba[pIdx + 1] = Math.min(255, Math.max(0, Math.round(meanG)));
                    atlasRgba[pIdx + 2] = Math.min(255, Math.max(0, Math.round(meanB)));
                    atlasRgba[pIdx + 3] = 255;

                    if (atlasObsCount[i] > 1) {
                        const meanSq = meanR * meanR + meanG * meanG + meanB * meanB;
                        const weightedSq = atlasColorSqSum[i] * invW;
                        atlasViewVariance[i] = Math.max(0, weightedSq - meanSq);
                    }
                }
            }
        }

        // Hole filling & gutter dilation
        let coveredCount = 0;
        let paintedCount = 0;
        for (let i = 0; i < totalTexels; i++) {
            if (atlasCoverage[i] === 1) {
                coveredCount++;
                if (atlasBestScore[i] > 0 || (useMultiBlend && atlasWeight[i] > 0)) paintedCount++;
            }
        }

        for (let i = 0; i < totalTexels; i++) {
            if (atlasCoverage[i] === 1 && atlasBestScore[i] === 0 && (!useMultiBlend || atlasWeight[i] === 0)) {
                const pIdx = i * 4;
                atlasRgba[pIdx] = defaultCol[0];
                atlasRgba[pIdx + 1] = defaultCol[1];
                atlasRgba[pIdx + 2] = defaultCol[2];
                atlasRgba[pIdx + 3] = 255;
            }
        }

        const bleedRadius = options.edgeBleedPixels ?? 4;
        if (bleedRadius > 0) {
            this.dilateGutters(atlasRgba, atlasCoverage, atlasW, atlasH, bleedRadius);
        }

        const encodeTextures = options.encodeTextures !== false;
        let pbrResult: PbrDecompositionResult | undefined;
        let albedoPng: Buffer;
        let normalPng: Buffer;
        let ormPng: Buffer;
        let roughnessPng: Buffer;
        let aoPng: Buffer;
        let metallicPng: Buffer;

        if (options.skipPbrDecomposition === true) {
            if (encodeTextures) {
                // Flat companion maps: +Z normal, fully rough, no occlusion, never metallic.
                const flatNormal = Buffer.alloc(totalTexels * 4);
                const flatOrm = Buffer.alloc(totalTexels * 4);
                const flatWhite = Buffer.alloc(totalTexels * 4, 255);
                const flatBlack = Buffer.alloc(totalTexels * 4);
                for (let i = 0; i < totalTexels; i++) {
                    flatNormal[i * 4] = 128; flatNormal[i * 4 + 1] = 128; flatNormal[i * 4 + 2] = 255; flatNormal[i * 4 + 3] = 255;
                    flatOrm[i * 4] = 255; flatOrm[i * 4 + 1] = 255; flatOrm[i * 4 + 2] = 0; flatOrm[i * 4 + 3] = 255;
                    flatBlack[i * 4 + 3] = 255;
                }
                albedoPng = encodePng(atlasW, atlasH, atlasRgba);
                normalPng = encodePng(atlasW, atlasH, flatNormal);
                ormPng = encodePng(atlasW, atlasH, flatOrm);
                roughnessPng = encodePng(atlasW, atlasH, flatWhite);
                aoPng = roughnessPng;
                metallicPng = encodePng(atlasW, atlasH, flatBlack);
            } else {
                albedoPng = normalPng = ormPng = roughnessPng = aoPng = metallicPng = Buffer.alloc(0);
            }
        } else {
            const isDraft = options.draft === true;
            // PBR Material Decomposition (Activated in Phase 2 full mode, or via explicit pbrDecomposition options)
            const pbrOpts: PbrDecompositionOptions = {
                enableAlbedoDeLighting: !isDraft || options.pbrDecomposition?.enableAlbedoDeLighting === true,
                generateNormalMaps: true,
                generateRoughnessMaps: true,
                generateAoMaps: true,
                packOrm: true,
                enableMultiFrequencyNormals: !isDraft || options.pbrDecomposition?.enableMultiFrequencyNormals === true,
                enableBiophysicalRoughness: !isDraft || options.pbrDecomposition?.enableBiophysicalRoughness === true,
                enableHbaoMicroCavity: !isDraft || options.pbrDecomposition?.enableHbaoMicroCavity === true,
                enableToksvigFiltering: !isDraft || options.pbrDecomposition?.enableToksvigFiltering === true,
                ...options.pbrDecomposition
            };

            if ((!isDraft || options.pbrDecomposition?.enableSolarInverseDelighting === true) &&
                options.solarDelighting?.lat && options.solarDelighting?.lng && options.solarDelighting?.isoDate) {
                pbrOpts.enableSolarInverseDelighting = true;
                pbrOpts.solarDelighting = {
                    latitude: options.solarDelighting.lat,
                    longitude: options.solarDelighting.lng,
                    timestampIso: options.solarDelighting.isoDate,
                    ...options.pbrDecomposition?.solarDelighting
                };
            }

            if (options.metricJacobianScaling !== false) {
                pbrOpts.metricTexelDensityMap = atlasTexelDensity;
            }
            pbrOpts.viewVarianceMap = atlasViewVariance;
            pbrOpts.worldPositionsMap = atlasWorldPos;
            pbrOpts.worldNormalsMap = atlasWorldNorm;

            const tPbr0 = performance.now();
            pbrResult = await AlgorithmicUvEngine.decomposePbr(
                atlasRgba,
                pbrOpts,
                atlasW,
                atlasH
            );
            console.log(`[Submesh ${primIndex}] decomposePbr finished in ${((performance.now() - tPbr0) / 1000).toFixed(2)}s`);

            const defaultNormal = Buffer.alloc(totalTexels * 4);
            for (let i = 0; i < totalTexels; i++) {
                defaultNormal[i * 4] = 128;
                defaultNormal[i * 4 + 1] = 128;
                defaultNormal[i * 4 + 2] = 255;
                defaultNormal[i * 4 + 3] = 255;
            }

            const normalBuffer = pbrResult.normal ? Buffer.from(pbrResult.normal) : defaultNormal;
            const ormBuffer = pbrResult.orm ? Buffer.from(pbrResult.orm) : Buffer.alloc(totalTexels * 4, 255);
            const roughnessBuffer = pbrResult.roughness ? Buffer.from(pbrResult.roughness) : Buffer.alloc(totalTexels * 4, 200);
            const aoBuffer = pbrResult.ao ? Buffer.from(pbrResult.ao) : Buffer.alloc(totalTexels * 4, 255);

            const metallicBuffer = Buffer.alloc(totalTexels * 4);
            for (let i = 0; i < totalTexels; i++) {
                const m = ormBuffer[i * 4 + 2];
                metallicBuffer[i * 4] = m;
                metallicBuffer[i * 4 + 1] = m;
                metallicBuffer[i * 4 + 2] = m;
                metallicBuffer[i * 4 + 3] = 255;
            }

            if (encodeTextures) {
                albedoPng = encodePng(atlasW, atlasH, Buffer.from(pbrResult.albedo));
                normalPng = encodePng(atlasW, atlasH, normalBuffer);
                ormPng = encodePng(atlasW, atlasH, ormBuffer);
                roughnessPng = encodePng(atlasW, atlasH, roughnessBuffer);
                aoPng = encodePng(atlasW, atlasH, aoBuffer);
                metallicPng = encodePng(atlasW, atlasH, metallicBuffer);
            } else {
                albedoPng = normalPng = ormPng = roughnessPng = aoPng = metallicPng = Buffer.alloc(0);
            }
        }

        const stationContributions: StationContribution[] = [];
        for (const [stId, count] of stationTexelCounts.entries()) {
            stationContributions.push({
                stationId: stId,
                texelCount: count,
                fraction: paintedCount > 0 ? count / paintedCount : 0
            });
        }
        stationContributions.sort((a, b) => b.texelCount - a.texelCount);

        const submeshMetrics: UnprojectionMetrics = {
            resolution,
            totalAtlasTexels: totalTexels,
            coveredMeshTexels: coveredCount,
            directlyPaintedTexels: paintedCount,
            fillRate: totalTexels > 0 ? coveredCount / totalTexels : 0,
            stationContributions,
            durationMs: 0
        };

        let accumulators: SurveyTexelAccumulators | undefined;
        if (wantAccumulators && meanRgb && atlasRawWeight && atlasMaxCos && atlasMinFootprint && atlasTexelSize) {
            accumulators = {
                width: atlasW,
                height: atlasH,
                meanRgb,
                weightSum: atlasWeight,
                rawWeightSum: atlasRawWeight,
                bestScore: atlasBestScore,
                obsCount: atlasObsCount,
                coverage: atlasCoverage,
                maxCosIncidence: atlasMaxCos,
                minFootprintMeters: atlasMinFootprint,
                texelSizeMeters: atlasTexelSize,
                worldPositions: atlasWorldPos,
                worldNormals: atlasWorldNorm,
                robustInlierFraction: atlasInlierFraction
            };
        }

        return {
            primitiveIndex: primIndex,
            materialIndex: prim.materialIndex,
            resolution,
            width: atlasW,
            height: atlasH,
            accumulators,
            albedoPng,
            normalPng,
            ormPng,
            roughnessPng,
            aoPng,
            metallicPng,
            metrics: submeshMetrics,
            pbrResult
        };
    }

    /**
     * Projects one surface sample into one prepared camera. Writes
     * [r, g, b, score, cosIncidence, cameraZ, distance, footprintMeters] into `out` and returns
     * true when the sample is visible, unoccluded and scores above 1e-4. The arithmetic matches
     * the original inline projection exactly when `pixelCentre` is false.
     */
    private static observeTexel(
        cam: PreparedCamera,
        wx: number, wy: number, wz: number,
        nx: number, ny: number, nz: number,
        p: ObserveParams,
        out: Float64Array
    ): boolean {
        const vx = cam.eye[0] - wx;
        const vy = cam.eye[1] - wy;
        const vz = cam.eye[2] - wz;
        const dist = Math.hypot(vx, vy, vz);
        if (dist < 1e-4) return false;

        const dirX = vx / dist;
        const dirY = vy / dist;
        const dirZ = vz / dist;

        // Cosine of incidence angle (surface normal dot ray to camera)
        const cosIncidence = nx * dirX + ny * dirY + nz * dirZ;
        if (cosIncidence < p.minCosIncidence) return false; // Grazing angle or backfacing

        // Forward metric depth along camera optical axis
        const dx = wx - cam.eye[0], dy = wy - cam.eye[1], dz = wz - cam.eye[2];
        const cameraZ = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (cameraZ <= 0.1) return false; // Behind near plane

        const camX = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
        const camY = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];

        const invZ = 1.0 / cameraZ;
        const sx = (cam.P00 * camX * invZ + 1.0) * cam.halfW;
        const sy = (1.0 - cam.P11 * camY * invZ) * cam.halfH;

        const pxInt = Math.floor(sx);
        const pyInt = Math.floor(sy);
        if (pxInt < 0 || pxInt >= cam.width || pyInt < 0 || pyInt >= cam.height) return false;

        // Metric depth comparison for occlusion culling
        const depthIdx = pyInt * cam.width + pxInt;
        const recordedDepth = cam.depth[depthIdx];

        if (recordedDepth >= EMPTY_DEPTH * 0.5) return false;

        const allowedTol = Math.max(p.depthTol, cameraZ * p.depthRelTol);
        if (cameraZ > recordedDepth + allowedTol) return false; // Occluded!

        // Quality score favoring orthogonal angle and spatial resolution
        const score = Math.pow(cosIncidence, p.angleExp) / Math.sqrt(Math.max(1.0, dist));
        if (!(score > 1e-4)) return false;

        const [r, g, b] = p.pixelCentre
            ? this.sampleBilinear(cam.rgba, cam.width, cam.height, sx - 0.5, sy - 0.5)
            : this.sampleBilinear(cam.rgba, cam.width, cam.height, sx, sy);
        if (cam.linearGain) {
            // Float result (may exceed 255); sRGB encode of the gained linear value.
            const enc = (v8: number, gain: number): number => {
                const c = SRGB_TO_LINEAR_LUT[v8] * gain;
                return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
            };
            out[0] = enc(r, cam.linearGain[0]);
            out[1] = enc(g, cam.linearGain[1]);
            out[2] = enc(b, cam.linearGain[2]);
        } else {
            out[0] = r;
            out[1] = g;
            out[2] = b;
        }
        out[3] = score;
        out[4] = cosIncidence;
        out[5] = cameraZ;
        out[6] = dist;
        // Plate-pixel footprint on the surface: (z * cos(off-axis) / f_px) / cos(incidence)
        const fPx = cam.P11 * cam.halfH;
        out[7] = fPx > 0 && cosIncidence > 1e-6 ? (cameraZ * cameraZ) / (dist * fPx * cosIncidence) : Infinity;
        return true;
    }

    /**
     * Conservative per-triangle camera culling. Writes indices of cameras that may observe any
     * texel of the (2%-expanded) triangle into `outIdx` and returns their count. A camera is culled
     * only when it is behind the face plane (when `faceNormal` is given) or when all expanded
     * vertices are behind its near plane or outside one of its four frustum side planes.
     */
    private static cullCamerasForTriangle(
        cameras: PreparedCamera[],
        p0: [number, number, number],
        p1: [number, number, number],
        p2: [number, number, number],
        faceNormal: [number, number, number] | null,
        outIdx: Int32Array
    ): number {
        const cx = (p0[0] + p1[0] + p2[0]) / 3, cy = (p0[1] + p1[1] + p2[1]) / 3, cz = (p0[2] + p1[2] + p2[2]) / 3;
        const e = 1.02;
        const vx0 = cx + (p0[0] - cx) * e, vy0 = cy + (p0[1] - cy) * e, vz0 = cz + (p0[2] - cz) * e;
        const vx1 = cx + (p1[0] - cx) * e, vy1 = cy + (p1[1] - cy) * e, vz1 = cz + (p1[2] - cz) * e;
        const vx2 = cx + (p2[0] - cx) * e, vy2 = cy + (p2[1] - cy) * e, vz2 = cz + (p2[2] - cz) * e;
        let n = 0;
        for (let k = 0; k < cameras.length; k++) {
            const cam = cameras[k];
            if (faceNormal) {
                const s = faceNormal[0] * (cam.eye[0] - p0[0]) + faceNormal[1] * (cam.eye[1] - p0[1]) + faceNormal[2] * (cam.eye[2] - p0[2]);
                if (s <= 0) continue;
            }
            let allNear = true, allRight = true, allLeft = true, allTop = true, allBottom = true;
            for (let j = 0; j < 3; j++) {
                const wx = j === 0 ? vx0 : j === 1 ? vx1 : vx2;
                const wy = j === 0 ? vy0 : j === 1 ? vy1 : vy2;
                const wz = j === 0 ? vz0 : j === 1 ? vz1 : vz2;
                const dx = wx - cam.eye[0], dy = wy - cam.eye[1], dz = wz - cam.eye[2];
                const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
                const x = (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) * cam.P00;
                const y = (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2]) * cam.P11;
                if (z > 0.1) allNear = false;
                if (!(x - z > 0)) allRight = false;
                if (!(-x - z > 0)) allLeft = false;
                if (!(y - z > 0)) allTop = false;
                if (!(-y - z > 0)) allBottom = false;
            }
            if (allNear || allRight || allLeft || allTop || allBottom) continue;
            outIdx[n++] = k;
        }
        return n;
    }

    /** CIELAB (D65) of an sRGB colour given as 0..255 floats. */
    private static srgbToLab(r: number, g: number, b: number, out: Float64Array, offset: number): void {
        const lin = (v: number): number => {
            const c = Math.max(0, v / 255);
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        const R = Number.isInteger(r) && r >= 0 && r <= 255 ? SRGB_TO_LINEAR_LUT[r] : lin(r);
        const G = Number.isInteger(g) && g >= 0 && g <= 255 ? SRGB_TO_LINEAR_LUT[g] : lin(g);
        const B = Number.isInteger(b) && b >= 0 && b <= 255 ? SRGB_TO_LINEAR_LUT[b] : lin(b);
        const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
        const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
        const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
        const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
        const fx = f(X), fy = f(Y), fz = f(Z);
        out[offset] = 116 * fy - 16;
        out[offset + 1] = 500 * (fx - fy);
        out[offset + 2] = 200 * (fy - fz);
    }

    /**
     * Second pass of the robust blend: for texels with enough observations, re-sample every camera
     * at the stored surface point and replace the weighted mean with an IRLS Huber estimate
     * (residuals in CIELAB Delta-E, start at the weighted per-channel median).
     */
    private static robustReweightTexels(args: {
        cameras: PreparedCamera[];
        totalTexels: number;
        coverage: Uint8Array;
        obsCount: Uint16Array;
        worldPos: Float32Array;
        worldNorm: Float32Array;
        sumR: Float32Array;
        sumG: Float32Array;
        sumB: Float32Array;
        weight: Float32Array;
        colorSq: Float32Array;
        rawWeight?: Float32Array;
        inlierFraction: Float32Array;
        params: ObserveParams;
        minObservations: number;
        huberDeltaE: number;
        iterations: number;
    }): void {
        const { cameras, params } = args;
        const maxObs = cameras.length;
        const sr = new Float64Array(maxObs), sg = new Float64Array(maxObs), sb = new Float64Array(maxObs);
        const sw = new Float64Array(maxObs), sraw = new Float64Array(maxObs), sh = new Float64Array(maxObs);
        const sLab = new Float64Array(maxObs * 3);
        const estLab = new Float64Array(3);
        const order: number[] = [];
        const obs = new Float64Array(8);
        const k = args.huberDeltaE;

        const weightedMedian = (vals: Float64Array, w: Float64Array, n: number): number => {
            order.length = 0;
            let total = 0;
            for (let i = 0; i < n; i++) { order.push(i); total += w[i]; }
            order.sort((a, b) => vals[a] - vals[b]);
            let acc = 0;
            for (const i of order) {
                acc += w[i];
                if (acc >= total * 0.5) return vals[i];
            }
            return vals[order[order.length - 1]];
        };

        for (let idx = 0; idx < args.totalTexels; idx++) {
            if (args.coverage[idx] !== 1 || args.obsCount[idx] < args.minObservations) continue;
            const wx = args.worldPos[idx * 3], wy = args.worldPos[idx * 3 + 1], wz = args.worldPos[idx * 3 + 2];
            const nx = args.worldNorm[idx * 3], ny = args.worldNorm[idx * 3 + 1], nz = args.worldNorm[idx * 3 + 2];
            let n = 0;
            for (const cam of cameras) {
                if (!this.observeTexel(cam, wx, wy, wz, nx, ny, nz, params, obs)) continue;
                const q = cam.poseQuality === undefined ? 1 : cam.poseQuality;
                sr[n] = obs[0]; sg[n] = obs[1]; sb[n] = obs[2];
                sraw[n] = obs[3] * obs[3];
                sw[n] = sraw[n] * q;
                this.srgbToLab(obs[0], obs[1], obs[2], sLab, n * 3);
                n++;
            }
            if (n < args.minObservations) continue;

            let er = weightedMedian(sr, sw, n);
            let eg = weightedMedian(sg, sw, n);
            let eb = weightedMedian(sb, sw, n);
            let wSum = 0, wOrig = 0;
            for (let i = 0; i < n; i++) wOrig += sw[i];
            for (let it = 0; it < args.iterations; it++) {
                this.srgbToLab(er, eg, eb, estLab, 0);
                let ar = 0, ag = 0, ab = 0;
                wSum = 0;
                for (let i = 0; i < n; i++) {
                    const dL = sLab[i * 3] - estLab[0], da = sLab[i * 3 + 1] - estLab[1], db = sLab[i * 3 + 2] - estLab[2];
                    const res = Math.sqrt(dL * dL + da * da + db * db);
                    sh[i] = res <= k ? 1 : k / res;
                    const w = sw[i] * sh[i];
                    ar += sr[i] * w; ag += sg[i] * w; ab += sb[i] * w;
                    wSum += w;
                }
                if (wSum <= 0) break;
                er = ar / wSum; eg = ag / wSum; eb = ab / wSum;
            }
            if (!(wSum > 0)) continue;

            let sq = 0, raw = 0;
            for (let i = 0; i < n; i++) {
                const w = sw[i] * sh[i];
                sq += (sr[i] * sr[i] + sg[i] * sg[i] + sb[i] * sb[i]) * w;
                raw += sraw[i] * sh[i];
            }
            args.sumR[idx] = er * wSum;
            args.sumG[idx] = eg * wSum;
            args.sumB[idx] = eb * wSum;
            args.weight[idx] = wSum;
            args.colorSq[idx] = sq;
            args.obsCount[idx] = n;
            if (args.rawWeight) args.rawWeight[idx] = raw;
            args.inlierFraction[idx] = wOrig > 0 ? wSum / wOrig : 1;
        }
    }

    /**
     * Precomputes per-plate projection parameters (view basis, projection scale, VP matrix).
     */
    public static prepareCameras(plates: StationPlate[]): PreparedCamera[] {
        return plates.map(plate => {
            const VP = this.buildViewProjectionMatrix(plate.pose, plate.width, plate.height);
            const pose = plate.pose;
            const eye: [number, number, number] = [pose.x, pose.y, pose.z];
            const target: [number, number, number] = [pose.targetX, pose.targetY, pose.targetZ];
            let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
            let fLen = Math.hypot(fx, fy, fz) || 1;
            fx /= fLen; fy /= fLen; fz /= fLen;
            const up = pose.up || [0, 1, 0];
            let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
            let rLen = Math.hypot(rx, ry, rz);
            if (rLen < 1e-6) { rx = 1; ry = 0; rz = 0; } else { rx /= rLen; ry /= rLen; rz /= rLen; }
            const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
            const tanHalfFov = Math.tan(((pose.fov || 45) * Math.PI / 180) * 0.5);
            const aspect = plate.width / plate.height;
            const P00 = 1.0 / (aspect * tanHalfFov);
            const P11 = 1.0 / tanHalfFov;
            const prepared: PreparedCamera = {
                station: plate.station,
                pose: plate.pose,
                width: plate.width,
                height: plate.height,
                rgba: plate.rgba,
                depth: plate.depth,
                eye,
                right: [rx, ry, rz],
                up: [ux, uy, uz],
                fwd: [fx, fy, fz],
                P00,
                P11,
                halfW: plate.width * 0.5,
                halfH: plate.height * 0.5,
                VP
            };
            if (plate.poseQuality !== undefined) prepared.poseQuality = plate.poseQuality;
            if (plate.linearGain !== undefined) prepared.linearGain = plate.linearGain;
            return prepared;
        });
    }

    /** Reads the pixel size of the primitive's baseColor image from its encoded header, if any. */
    public static readPrimitiveBaseColorDimensions(
        prim: MeshPrimitiveData,
        glbJson: any,
        glbBin: Buffer
    ): { width: number; height: number; imageIndex: number } | null {
        if (prim.materialIndex === undefined) return null;
        const mat = glbJson.materials?.[prim.materialIndex];
        const texIdx = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
        if (texIdx === undefined) return null;
        const imgIdx = glbJson.textures?.[texIdx]?.source;
        if (imgIdx === undefined) return null;
        const img = glbJson.images?.[imgIdx];
        if (!img || img.bufferView === undefined) return null;
        const bv = glbJson.bufferViews?.[img.bufferView];
        if (!bv) return null;
        const offset = bv.byteOffset || 0;
        if (offset + bv.byteLength > glbBin.length) return null;
        const dims = readImageDimensions(glbBin.subarray(offset, offset + bv.byteLength));
        return dims ? { width: dims.width, height: dims.height, imageIndex: imgIdx } : null;
    }

    /**
     * Atlas size for a primitive under `options.resolutionScale`: the baseColor source size
     * (or `options.resolution` when set) multiplied by the primitive's scale.
     */
    public static determinePrimitiveAtlasSize(
        prim: MeshPrimitiveData,
        primIndex: number,
        glbJson: any,
        glbBin: Buffer,
        options: SurveyTextureUnprojectorOptions
    ): { width: number; height: number; scale: number } {
        const rs = options.resolutionScale;
        let scale = 1;
        if (typeof rs === 'number') scale = rs;
        else if (typeof rs === 'function') scale = rs(primIndex);
        else if (rs !== undefined && primIndex < rs.length) scale = rs[primIndex];
        if (!Number.isFinite(scale) || scale <= 0) scale = 1;

        if (options.resolution !== undefined && options.resolution > 0) {
            const r = Math.max(1, Math.round(options.resolution * scale));
            return { width: r, height: r, scale };
        }
        const src = this.readPrimitiveBaseColorDimensions(prim, glbJson, glbBin);
        if (src) {
            return {
                width: Math.max(1, Math.round(src.width * scale)),
                height: Math.max(1, Math.round(src.height * scale)),
                scale
            };
        }
        const base = this.determinePrimitiveResolution(prim, glbJson, glbBin, undefined);
        const r = Math.max(1, Math.round(base * scale));
        return { width: r, height: r, scale };
    }

    /**
     * Renders blockouts and depth buffers for the stations and executes beautification.
     */
    private static async renderAndBeautifyStations(
        glbBuffer: Buffer,
        stations: ColmapCameraPose[],
        beautifyContext?: StationBeautifyContext,
        generator?: StationImageGenerator,
        options?: SurveyTextureUnprojectorOptions,
        progress: Pick<SurveyTexturePipelineRequest, 'onProgress' | 'signal'> = {}
    ): Promise<StationPlate[]> {
        const renderService = new SurveyStationRenderService();
        await renderService.loadMesh(glbBuffer);

        const isDraft = options?.draft ?? false;
        const defaultW = isDraft ? 768 : 1280;
        const baseW = options?.renderWidth || (options?.resolution ? Math.min(defaultW, options.resolution) : defaultW);
        const plates: StationPlate[] = [];
        let previousAccepted: BeautifyStationResult | undefined;

        for (const [stationIndex, st] of stations.entries()) {
            throwIfStopped(progress.signal);
            progress.onProgress?.(`${generator ? 'Beautifying' : 'Rendering'} station ${stationIndex + 1}/${stations.length}`, 0.6 * (stationIndex / stations.length));
            // Auto aspect ratio resolution per station
            let targetAspect = st.aspectRatio;
            const pitch = Math.abs(st.pitchDegrees || 0);
            if (options?.aspectRatio === 'auto' || isDraft) {
                targetAspect = pitch > 25 ? 9 / 16 : (st.aspectRatio || 16 / 9);
            } else if (!targetAspect || targetAspect <= 0) {
                targetAspect = pitch > 25 ? 9 / 16 : 16 / 9;
            }

            const stationW = baseW;
            const stationH = options?.renderHeight || Math.round(stationW / targetAspect);

            const blockout = renderService.renderStationBlockout(st, {
                width: stationW,
                height: stationH
            });

            let stationRgba: Buffer = blockout.rgba;

            if (generator) {
                const beautifyService = new BeautifyStationService(renderService, generator);
                const bRes = await beautifyService.beautify(
                    st,
                    beautifyContext || { locationName: 'Target Location' },
                    {
                        width: stationW,
                        height: stationH,
                        aspectRatio: options?.aspectRatio || 'auto',
                        draft: isDraft,
                        reference: previousAccepted,
                        signal: progress.signal
                    }
                );
                if (bRes.accepted) {
                    previousAccepted = bRes;
                }
                if (bRes.image.width !== stationW || bRes.image.height !== stationH) {
                    stationRgba = resampleRgba(bRes.image.rgba, bRes.image.width, bRes.image.height, stationW, stationH);
                } else {
                    stationRgba = Buffer.from(bRes.image.rgba);
                }
            }

            plates.push({
                station: st,
                rgba: stationRgba,
                width: stationW,
                height: stationH,
                depth: blockout.depth,
                pose: blockout.cameraPose,
                intrinsics: blockout.intrinsics
            });
        }

        if (options?.radianceEqualization?.enabled !== false && plates.length > 1) {
            console.log(`[SurveyTextureUnprojector] Equalizing radiance across ${plates.length} station plates...`);
            const eqRes = StationRadianceEqualizer.equalizePlates(plates, options?.radianceEqualization);
            console.log(`[SurveyTextureUnprojector] Radiance equalized anchored to station ${eqRes.anchorStationId} (${eqRes.stationsEqualized} plates processed)`);
        }

        return plates;
    }

    /**
     * Loads mesh primitives from GLB. If the mesh lacks UVs, automatically generates
     * box/planar unwrap and packs them with MaxRectsAtlasPacker.
     */
    public static loadMeshPrimitives(
        glbBuffer: Buffer,
        targetResolution: number = 4096,
        loadOptions?: {
            /**
             * Decode UNSIGNED_BYTE (5121) index accessors correctly. The legacy path reads every
             * non-UNSIGNED_SHORT accessor as UNSIGNED_INT, which corrupts uint8-indexed primitives
             * (Google 3D Tiles use them for small chunks). Opt-in to keep legacy results unchanged.
             */
            decodeAllIndexTypes?: boolean;
        }
    ): { primitives: MeshPrimitiveData[]; glbJson: any; glbBin: Buffer } {
        const { json, bin } = AlgorithmicUvEngine.parseGlb(glbBuffer);
        const primitives: MeshPrimitiveData[] = [];

        for (const mesh of json.meshes || []) {
            for (const prim of mesh.primitives || []) {
                if (prim.attributes && prim.attributes.POSITION !== undefined) {
                    const posAcc = json.accessors[prim.attributes.POSITION];
                    const posView = json.bufferViews[posAcc.bufferView];
                    const posOffset = (posView.byteOffset || 0) + (posAcc.byteOffset || 0);
                    const posStride = posView.byteStride ? posView.byteStride / 4 : 3;
                    const rawPositions = new Float32Array(bin.buffer, bin.byteOffset + posOffset, posAcc.count * posStride);

                    // Compact positions
                    const positions = new Float32Array(posAcc.count * 3);
                    for (let i = 0; i < posAcc.count; i++) {
                        positions[i * 3] = rawPositions[i * posStride];
                        positions[i * 3 + 1] = rawPositions[i * posStride + 1];
                        positions[i * 3 + 2] = rawPositions[i * posStride + 2];
                    }

                    // Indices
                    let indices: Uint32Array;
                    if (prim.indices !== undefined) {
                        const indAcc = json.accessors[prim.indices];
                        const indView = json.bufferViews[indAcc.bufferView];
                        const indOffset = (indView.byteOffset || 0) + (indAcc.byteOffset || 0);
                        if (indAcc.componentType === 5123) { // UNSIGNED_SHORT
                            const rawInd = new Uint16Array(bin.buffer, bin.byteOffset + indOffset, indAcc.count);
                            indices = new Uint32Array(rawInd);
                        } else if (loadOptions?.decodeAllIndexTypes === true && indAcc.componentType === 5121) { // UNSIGNED_BYTE
                            indices = new Uint32Array(new Uint8Array(bin.buffer, bin.byteOffset + indOffset, indAcc.count));
                        } else {
                            indices = new Uint32Array(bin.buffer, bin.byteOffset + indOffset, indAcc.count);
                        }
                    } else {
                        indices = new Uint32Array(posAcc.count);
                        for (let i = 0; i < posAcc.count; i++) indices[i] = i;
                    }

                    // Normals
                    let normals: Float32Array;
                    if (prim.attributes.NORMAL !== undefined) {
                        const normAcc = json.accessors[prim.attributes.NORMAL];
                        const normView = json.bufferViews[normAcc.bufferView];
                        const normOffset = (normView.byteOffset || 0) + (normAcc.byteOffset || 0);
                        const normStride = normView.byteStride ? normView.byteStride / 4 : 3;
                        const rawNorm = new Float32Array(bin.buffer, bin.byteOffset + normOffset, normAcc.count * normStride);
                        normals = new Float32Array(normAcc.count * 3);
                        for (let i = 0; i < normAcc.count; i++) {
                            normals[i * 3] = rawNorm[i * normStride];
                            normals[i * 3 + 1] = rawNorm[i * normStride + 1];
                            normals[i * 3 + 2] = rawNorm[i * normStride + 2];
                        }
                    } else {
                        // Calculate vertex normals from faces
                        normals = this.calculateMeshNormals(positions, indices);
                    }

                    // UVs
                    let uvs: Float32Array;
                    if (prim.attributes.TEXCOORD_0 !== undefined) {
                        const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
                        const uvView = json.bufferViews[uvAcc.bufferView];
                        const uvOffset = (uvView.byteOffset || 0) + (uvAcc.byteOffset || 0);
                        const uvStride = uvView.byteStride ? uvView.byteStride / 4 : 2;
                        const rawUvs = new Float32Array(bin.buffer, bin.byteOffset + uvOffset, uvAcc.count * uvStride);
                        uvs = new Float32Array(uvAcc.count * 2);
                        for (let i = 0; i < uvAcc.count; i++) {
                            uvs[i * 2] = rawUvs[i * uvStride];
                            uvs[i * 2 + 1] = rawUvs[i * uvStride + 1];
                        }
                    } else {
                        // Synthesize box UV unwrap packed with MaxRects
                        uvs = this.generateBoxUvs(positions, normals, indices, targetResolution);
                    }

                    primitives.push({
                        positions,
                        normals,
                        uvs,
                        indices,
                        materialIndex: prim.material
                    });
                }
            }
        }

        return { primitives, glbJson: json, glbBin: bin };
    }

    /**
     * Calculates smooth per-vertex normals by accumulating face cross products.
     */
    private static calculateMeshNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
        const vertCount = positions.length / 3;
        const normals = new Float32Array(vertCount * 3);
        const triCount = Math.floor(indices.length / 3);

        for (let t = 0; t < triCount; t++) {
            const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
            const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
            const p1x = positions[i1 * 3], p1y = positions[i1 * 3 + 1], p1z = positions[i1 * 3 + 2];
            const p2x = positions[i2 * 3], p2y = positions[i2 * 3 + 1], p2z = positions[i2 * 3 + 2];

            const e1x = p1x - p0x, e1y = p1y - p0y, e1z = p1z - p0z;
            const e2x = p2x - p0x, e2y = p2y - p0y, e2z = p2z - p0z;

            const cx = e1y * e2z - e1z * e2y;
            const cy = e1z * e2x - e1x * e2z;
            const cz = e1x * e2y - e1y * e2x;

            normals[i0 * 3] += cx; normals[i0 * 3 + 1] += cy; normals[i0 * 3 + 2] += cz;
            normals[i1 * 3] += cx; normals[i1 * 3 + 1] += cy; normals[i1 * 3 + 2] += cz;
            normals[i2 * 3] += cx; normals[i2 * 3 + 1] += cy; normals[i2 * 3 + 2] += cz;
        }

        for (let i = 0; i < vertCount; i++) {
            const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
            if (len > 1e-6) {
                normals[i * 3] /= len;
                normals[i * 3 + 1] /= len;
                normals[i * 3 + 2] /= len;
            } else {
                normals[i * 3 + 1] = 1; // Default +Y Up
            }
        }

        return normals;
    }

    /**
     * Automatic tri-planar box UV unwrapper that clusters triangles by dominant axis,
     * normalizes each chart, and packs them with our MaxRectsAtlasPacker.
     */
    public static generateBoxUvs(
        positions: Float32Array,
        normals: Float32Array,
        indices: Uint32Array,
        atlasResolution: number = 4096
    ): Float32Array {
        const vertCount = positions.length / 3;
        const uvs = new Float32Array(vertCount * 2);

        // Partition vertices by dominant normal axis (X = 0, Y = 1, Z = 2)
        // Chart 0: +X, Chart 1: -X, Chart 2: +Y, Chart 3: -Y, Chart 4: +Z, Chart 5: -Z
        const chartBounds: Array<{ minU: number; maxU: number; minV: number; maxV: number }> = Array.from(
            { length: 6 },
            () => ({ minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity })
        );

        const vertChart = new Uint8Array(vertCount);
        const rawU = new Float32Array(vertCount);
        const rawV = new Float32Array(vertCount);

        for (let i = 0; i < vertCount; i++) {
            const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];

            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            let chart = 0;
            let u = 0, v = 0;

            if (ay >= ax && ay >= az) {
                chart = ny >= 0 ? 2 : 3;
                u = px; v = pz;
            } else if (ax >= ay && ax >= az) {
                chart = nx >= 0 ? 0 : 1;
                u = pz; v = py;
            } else {
                chart = nz >= 0 ? 4 : 5;
                u = px; v = py;
            }

            vertChart[i] = chart;
            rawU[i] = u;
            rawV[i] = v;

            const b = chartBounds[chart];
            if (u < b.minU) b.minU = u;
            if (u > b.maxU) b.maxU = u;
            if (v < b.minV) b.minV = v;
            if (v > b.maxV) b.maxV = v;
        }

        // Pack the 6 charts using MaxRectsAtlasPacker
        const packer = new MaxRectsAtlasPacker({
            maxWidth: atlasResolution,
            maxHeight: atlasResolution,
            padding: 8,
            allowRotation: false
        });

        const activeCharts: number[] = [];
        for (let c = 0; c < 6; c++) {
            const b = chartBounds[c];
            const wMeters = Math.max(0.1, b.maxU - b.minU);
            const hMeters = Math.max(0.1, b.maxV - b.minV);
            if (b.minU !== Infinity) {
                activeCharts.push(c);
                packer.addTexture({
                    id: c,
                    width: Math.max(64, Math.round(wMeters * 30)),
                    height: Math.max(64, Math.round(hMeters * 30)),
                    data: new Uint8Array(64 * 64 * 4)
                });
            }
        }

        const packed = packer.pack();

        // Assign UV coordinates into the packed rects
        for (let i = 0; i < vertCount; i++) {
            const c = vertChart[i];
            const rect = packed.rects.get(c);
            const b = chartBounds[c];
            if (!rect || b.minU === Infinity) {
                uvs[i * 2] = 0;
                uvs[i * 2 + 1] = 0;
                continue;
            }

            const rangeU = Math.max(1e-4, b.maxU - b.minU);
            const rangeV = Math.max(1e-4, b.maxV - b.minV);
            const localU = (rawU[i] - b.minU) / rangeU;
            const localV = (rawV[i] - b.minV) / rangeV;

            const pixelX = rect.x + localU * rect.width;
            const pixelY = rect.y + localV * rect.height;

            uvs[i * 2] = pixelX / packed.width;
            uvs[i * 2 + 1] = pixelY / packed.height;
        }

        return uvs;
    }

    /**
     * Builds standard 4x4 View-Projection Matrix matching HeadlessMeshSilhouetteRenderer.
     */
    public static buildViewProjectionMatrix(pose: CameraPose6DOF, width: number, height: number): Float32Array {
        const eye = [pose.x, pose.y, pose.z];
        const target = [pose.targetX, pose.targetY, pose.targetZ];
        let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        const up = pose.up || [0, 1, 0];
        let rx = fy * up[2] - fz * up[1];
        let ry = fz * up[0] - fx * up[2];
        let rz = fx * up[1] - fy * up[0];
        const rlen = Math.hypot(rx, ry, rz);
        if (rlen < 1e-6) { rx = 1; ry = 0; rz = 0; } else { rx /= rlen; ry /= rlen; rz /= rlen; }

        const ux = ry * fz - rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy - ry * fx;

        const aspect = width / height;
        const fovRad = (pose.fov * Math.PI) / 180;
        const f = 1.0 / Math.tan(fovRad / 2);
        const zNear = 0.5;
        const zFar = 1000.0;

        const V = [
            rx, ux, -fx, 0,
            ry, uy, -fy, 0,
            rz, uz, -fz, 0,
            -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
            -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
            -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]),
            1
        ];

        const P = [
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (zFar + zNear) / (zNear - zFar), -1,
            0, 0, (2 * zFar * zNear) / (zNear - zFar), 0
        ];

        const VP = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += V[i * 4 + k] * P[k * 4 + j];
                VP[i * 4 + j] = sum;
            }
        }
        return VP;
    }

    /**
     * Fast inlined world to screen projection returning [screenX, screenY, cameraZ].
     */
    private static projectWorldToScreen(
        vx: number, vy: number, vz: number,
        VP: Float32Array,
        width: number, height: number
    ): [number, number, number] | null {
        const cx = vx * VP[0] + vy * VP[4] + vz * VP[8] + VP[12];
        const cy = vx * VP[1] + vy * VP[5] + vz * VP[9] + VP[13];
        const cw = vx * VP[3] + vy * VP[7] + vz * VP[11] + VP[15];

        if (cw <= 0.05) return null;
        const invW = 1.0 / cw;
        const sx = (cx * invW * 0.5 + 0.5) * width;
        const sy = (1.0 - (cy * invW * 0.5 + 0.5)) * height;
        return [sx, sy, cw];
    }

    /**
     * Bilinear RGBA texture sample.
     */
    private static sampleBilinear(
        rgba: Uint8Array | Buffer,
        width: number,
        height: number,
        x: number,
        y: number
    ): [number, number, number] {
        const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
        const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
        const x1 = Math.min(width - 1, x0 + 1);
        const y1 = Math.min(height - 1, y0 + 1);

        const fx = Math.max(0, Math.min(1, x - x0));
        const fy = Math.max(0, Math.min(1, y - y0));

        const i00 = (y0 * width + x0) * 4;
        const i10 = (y0 * width + x1) * 4;
        const i01 = (y1 * width + x0) * 4;
        const i11 = (y1 * width + x1) * 4;

        const r0 = rgba[i00] * (1 - fx) + rgba[i10] * fx;
        const g0 = rgba[i00 + 1] * (1 - fx) + rgba[i10 + 1] * fx;
        const b0 = rgba[i00 + 2] * (1 - fx) + rgba[i10 + 2] * fx;

        const r1 = rgba[i01] * (1 - fx) + rgba[i11] * fx;
        const g1 = rgba[i01 + 1] * (1 - fx) + rgba[i11 + 1] * fx;
        const b1 = rgba[i01 + 2] * (1 - fx) + rgba[i11 + 2] * fx;

        return [
            Math.round(r0 * (1 - fy) + r1 * fy),
            Math.round(g0 * (1 - fy) + g1 * fy),
            Math.round(b0 * (1 - fy) + b1 * fy)
        ];
    }

    /**
     * Dilates valid texels into chart gutters by the specified pixel radius.
     */
    private static dilateGutters(
        rgba: Buffer,
        coverage: Uint8Array,
        width: number,
        height: number,
        radius: number
    ): void {
        const hasColor = new Uint8Array(width * height);
        for (let i = 0; i < width * height; i++) {
            if (coverage[i] === 1 || rgba[i * 4 + 3] > 0) {
                hasColor[i] = 1;
            }
        }

        for (let step = 0; step < radius; step++) {
            const newlyFilled: number[] = [];
            for (let y = 0; y < height; y++) {
                const row = y * width;
                for (let x = 0; x < width; x++) {
                    const idx = row + x;
                    if (hasColor[idx] === 1) continue;

                    // Look at 4-neighbors
                    const neighbors = [
                        x > 0 ? idx - 1 : -1,
                        x + 1 < width ? idx + 1 : -1,
                        y > 0 ? idx - width : -1,
                        y + 1 < height ? idx + width : -1
                    ];

                    for (const n of neighbors) {
                        if (n >= 0 && hasColor[n] === 1) {
                            const pDst = idx * 4;
                            const pSrc = n * 4;
                            rgba[pDst] = rgba[pSrc];
                            rgba[pDst + 1] = rgba[pSrc + 1];
                            rgba[pDst + 2] = rgba[pSrc + 2];
                            rgba[pDst + 3] = rgba[pSrc + 3];
                            newlyFilled.push(idx);
                            break;
                        }
                    }
                }
            }

            for (const idx of newlyFilled) {
                hasColor[idx] = 1;
            }
            if (newlyFilled.length === 0) break;
        }
    }

    /**
     * Determines the unprojection resolution for a mesh primitive based on its source texture resolution.
     */
    public static determinePrimitiveResolution(
        prim: MeshPrimitiveData,
        glbJson: any,
        glbBin: Buffer,
        defaultResolution?: number
    ): number {
        if (defaultResolution !== undefined && defaultResolution > 0) {
            return defaultResolution;
        }
        if (prim.materialIndex !== undefined && glbJson.materials?.[prim.materialIndex]) {
            const mat = glbJson.materials[prim.materialIndex];
            const texIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
            if (texIdx !== undefined && glbJson.textures?.[texIdx]) {
                const imgIdx = glbJson.textures[texIdx].source;
                if (imgIdx !== undefined && glbJson.images?.[imgIdx]) {
                    const img = glbJson.images[imgIdx];
                    if (img.bufferView !== undefined && glbJson.bufferViews?.[img.bufferView]) {
                        const bv = glbJson.bufferViews[img.bufferView];
                        const offset = bv.byteOffset || 0;
                        const len = bv.byteLength;
                        if (offset + len <= glbBin.length) {
                            const imgBuf = Buffer.from(glbBin.buffer, glbBin.byteOffset + offset, len);
                            // Check PNG IHDR: bytes 16-19 width, 20-23 height
                            if (imgBuf.length >= 24 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4e && imgBuf[3] === 0x47) {
                                const srcW = imgBuf.readUInt32BE(16);
                                const srcH = imgBuf.readUInt32BE(20);
                                const maxDim = Math.max(srcW, srcH);
                                return Math.min(4096, Math.max(512, Math.pow(2, Math.ceil(Math.log2(maxDim * 2)))));
                            }
                            // Check JPEG: scan markers for SOF0 (0xFF, 0xC0) or SOF2 (0xFF, 0xC2)
                            if (imgBuf.length >= 4 && imgBuf[0] === 0xff && imgBuf[1] === 0xd8) {
                                let pos = 2;
                                while (pos < imgBuf.length - 8) {
                                    if (imgBuf[pos] === 0xff && (imgBuf[pos + 1] === 0xc0 || imgBuf[pos + 1] === 0xc2)) {
                                        const srcH = imgBuf.readUInt16BE(pos + 5);
                                        const srcW = imgBuf.readUInt16BE(pos + 7);
                                        const maxDim = Math.max(srcW, srcH);
                                        return Math.min(4096, Math.max(512, Math.pow(2, Math.ceil(Math.log2(maxDim * 2)))));
                                    }
                                    const markerLen = imgBuf.readUInt16BE(pos + 2);
                                    pos += 2 + markerLen;
                                }
                            }
                        }
                    }
                }
            }
        }
        return defaultResolution || 1024;
    }

    public static embedPerSubmeshTexturesIntoGlb(
        glbJson: any,
        glbBin: Buffer,
        submeshResults: Array<{
            primitiveIndex: number;
            materialIndex?: number;
            albedoPng: Buffer;
            normalPng: Buffer;
            ormPng: Buffer;
        }>
    ): Buffer {
        const newJson = JSON.parse(JSON.stringify(glbJson));
        let currentBin = Buffer.from(glbBin);

        const appendBuffer = (data: Buffer): { bufferViewIndex: number } => {
            const alignedOffset = (currentBin.length + 3) & ~3;
            const expandedBin = Buffer.alloc(alignedOffset + data.length);
            currentBin.copy(expandedBin, 0);
            data.copy(expandedBin, alignedOffset);
            currentBin = expandedBin;

            if (!newJson.bufferViews) newJson.bufferViews = [];
            const bvIdx = newJson.bufferViews.length;
            newJson.bufferViews.push({
                buffer: 0,
                byteOffset: alignedOffset,
                byteLength: data.length
            });
            return { bufferViewIndex: bvIdx };
        };

        if (!newJson.images) newJson.images = [];
        if (!newJson.textures) newJson.textures = [];
        if (!newJson.materials) newJson.materials = [];

        let submeshIdx = 0;
        for (const mesh of newJson.meshes || []) {
            for (const prim of mesh.primitives || []) {
                const submesh = submeshResults[submeshIdx];
                if (!submesh) {
                    submeshIdx++;
                    continue;
                }

                // 1. Albedo image & texture
                const albBv = appendBuffer(submesh.albedoPng);
                const albImgIdx = newJson.images.length;
                newJson.images.push({ bufferView: albBv.bufferViewIndex, mimeType: 'image/png', name: `albedo_atlas_submesh_${submeshIdx}` });
                const albTexIdx = newJson.textures.length;
                newJson.textures.push({ source: albImgIdx });

                // 2. Normal image & texture
                const normBv = appendBuffer(submesh.normalPng);
                const normImgIdx = newJson.images.length;
                newJson.images.push({ bufferView: normBv.bufferViewIndex, mimeType: 'image/png', name: `normal_atlas_submesh_${submeshIdx}` });
                const normTexIdx = newJson.textures.length;
                newJson.textures.push({ source: normImgIdx });

                // 3. ORM image & texture
                const ormBv = appendBuffer(submesh.ormPng);
                const ormImgIdx = newJson.images.length;
                newJson.images.push({ bufferView: ormBv.bufferViewIndex, mimeType: 'image/png', name: `orm_atlas_submesh_${submeshIdx}` });
                const normOrmIdx = newJson.textures.length;
                newJson.textures.push({ source: ormImgIdx });

                // Create distinct material for this submesh
                const matIdx = newJson.materials.length;
                newJson.materials.push({
                    name: `pbr_beautified_submesh_${submeshIdx}`,
                    pbrMetallicRoughness: {
                        baseColorTexture: { index: albTexIdx },
                        metallicRoughnessTexture: { index: normOrmIdx },
                        roughnessFactor: 1.0,
                        metallicFactor: 1.0
                    },
                    normalTexture: { index: normTexIdx },
                    occlusionTexture: { index: normOrmIdx }
                });

                prim.material = matIdx;
                submeshIdx++;
            }
        }

        // Strip KHR_materials_unlit from all materials and extensionsUsed
        for (const mat of newJson.materials) {
            if (mat.extensions && mat.extensions.KHR_materials_unlit) {
                delete mat.extensions.KHR_materials_unlit;
            }
        }
        if (newJson.extensionsUsed) {
            newJson.extensionsUsed = newJson.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
        }

        newJson.buffers[0].byteLength = currentBin.length;
        return AlgorithmicUvEngine.serializeGlb(newJson, currentBin);
    }

    public static embedTexturesIntoGlb(
        glbJson: any,
        glbBin: Buffer,
        albedoPng: Buffer,
        normalPng: Buffer,
        ormPng: Buffer
    ): Buffer {
        return this.embedPerSubmeshTexturesIntoGlb(glbJson, glbBin, [{
            primitiveIndex: 0,
            albedoPng,
            normalPng,
            ormPng
        }]);
    }
}
