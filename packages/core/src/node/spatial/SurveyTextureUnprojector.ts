/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
import { encodePng, decodePng } from '../texture-processing';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';

export interface StationPlate {
    station: ColmapCameraPose;
    rgba: Buffer | Uint8Array;
    width: number;
    height: number;
    depth: Float32Array;
    pose: CameraPose6DOF;
    intrinsics: PinholeIntrinsics;
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
    /** PBR material decomposition options (Scharr normals, Toksvig roughness, HBAO, dielectric glass). */
    pbrDecomposition?: PbrDecompositionOptions;
    /** Output path for the enhanced GLB. */
    outGlbPath?: string;
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
}

export interface SurveyTexturePipelineRequest {
    glbPath: string;
    anchor?: GeodeticAnchor;
    stations: ColmapCameraPose[];
    beautifyContext?: StationBeautifyContext;
    generator?: StationImageGenerator;
    precomputedPlates?: StationPlate[];
    options?: SurveyTextureUnprojectorOptions;
}

interface MeshPrimitiveData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    materialIndex?: number;
}

/**
 * Precomputed station projection camera parameters for fast scanline projection.
 */
interface PreparedCamera {
    station: ColmapCameraPose;
    pose: CameraPose6DOF;
    width: number;
    height: number;
    rgba: Buffer | Uint8Array;
    depth: Float32Array;
    eye: [number, number, number];
    VP: Float32Array;
}

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
        const resolution = options.resolution || 4096;

        // 1. Prepare station plates (render blockouts + depth + beautified RGBA)
        let plates: StationPlate[] = [];
        if (request.precomputedPlates && request.precomputedPlates.length > 0) {
            plates = request.precomputedPlates;
        } else {
            plates = await this.renderAndBeautifyStations(
                glbBuffer,
                request.stations,
                request.beautifyContext,
                request.generator,
                options
            );
        }

        if (plates.length === 0) {
            throw new Error('SurveyTextureUnprojector: No valid station plates available for unprojection');
        }

        // 2. Load GLB primitives and verify/generate UV coordinates
        const { primitives, glbJson, glbBin } = this.loadMeshPrimitives(glbBuffer, resolution);

        // 3. Precompute station projection matrices
        const preparedCameras: PreparedCamera[] = plates.map(plate => {
            const VP = this.buildViewProjectionMatrix(plate.pose, plate.width, plate.height);
            return {
                station: plate.station,
                pose: plate.pose,
                width: plate.width,
                height: plate.height,
                rgba: plate.rgba,
                depth: plate.depth,
                eye: [plate.pose.x, plate.pose.y, plate.pose.z],
                VP
            };
        });

        // 4. Rasterize UV triangles into the target atlas
        const atlasW = resolution;
        const atlasH = resolution;
        const totalTexels = atlasW * atlasH;
        const atlasRgba = Buffer.alloc(totalTexels * 4);
        const atlasBestScore = new Float32Array(totalTexels);
        const atlasBestStation = new Int32Array(totalTexels);
        atlasBestStation.fill(-1);
        const atlasCoverage = new Uint8Array(totalTexels);

        const defaultCol = options.defaultColor || [210, 205, 195];
        const minCosIncidence = options.minCosIncidence ?? 0.08;
        const angleExp = options.angleWeightExponent ?? 2.0;
        const depthTol = options.depthTolerance ?? 0.20;
        const depthRelTol = options.depthRelativeTolerance ?? 0.02;

        const stationTexelCounts = new Map<number, number>();
        for (const cam of preparedCameras) {
            stationTexelCounts.set(cam.station.id, 0);
        }

        for (const prim of primitives) {
            const { positions, normals, uvs, indices } = prim;
            const triCount = Math.floor(indices.length / 3);

            for (let t = 0; t < triCount; t++) {
                const i0 = indices[t * 3];
                const i1 = indices[t * 3 + 1];
                const i2 = indices[t * 3 + 2];

                // 3D vertices
                const p0: [number, number, number] = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
                const p1: [number, number, number] = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
                const p2: [number, number, number] = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];

                // 3D normals
                const n0: [number, number, number] = [normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]];
                const n1: [number, number, number] = [normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]];
                const n2: [number, number, number] = [normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]];

                // UVs in [0, 1]^2
                const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
                const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
                const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];

                // Map to atlas pixel space
                const U0 = u0 * (atlasW - 1), V0 = v0 * (atlasH - 1);
                const U1 = u1 * (atlasW - 1), V1 = v1 * (atlasH - 1);
                const U2 = u2 * (atlasW - 1), V2 = v2 * (atlasH - 1);

                // 2D bounding box
                const minX = Math.max(0, Math.floor(Math.min(U0, U1, U2)));
                const maxX = Math.min(atlasW - 1, Math.ceil(Math.max(U0, U1, U2)));
                const minY = Math.max(0, Math.floor(Math.min(V0, V1, V2)));
                const maxY = Math.min(atlasH - 1, Math.ceil(Math.max(V0, V1, V2)));

                // 2D cross product for barycentric coordinates
                const det = (V1 - V2) * (U0 - U2) + (U2 - U1) * (V0 - V2);
                if (Math.abs(det) < 1e-7) continue;
                const invDet = 1.0 / det;

                // Triangle 3D geometric face normal & centroid
                const e1: [number, number, number] = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
                const e2: [number, number, number] = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
                const cross: [number, number, number] = [
                    e1[1] * e2[2] - e1[2] * e2[1],
                    e1[2] * e2[0] - e1[0] * e2[2],
                    e1[0] * e2[1] - e1[1] * e2[0]
                ];
                const crossLen = Math.hypot(cross[0], cross[1], cross[2]);
                const faceNormal: [number, number, number] = crossLen > 1e-6
                    ? [cross[0] / crossLen, cross[1] / crossLen, cross[2] / crossLen]
                    : [0, 1, 0];

                const centroid: [number, number, number] = [
                    (p0[0] + p1[0] + p2[0]) / 3,
                    (p0[1] + p1[1] + p2[1]) / 3,
                    (p0[2] + p1[2] + p2[2]) / 3
                ];

                // Candidate cameras facing towards triangle
                const candidateCams = preparedCameras.filter(cam => {
                    const vx = cam.eye[0] - centroid[0];
                    const vy = cam.eye[1] - centroid[1];
                    const vz = cam.eye[2] - centroid[2];
                    const d = Math.hypot(vx, vy, vz);
                    if (d < 1e-3) return false;
                    const cosA = (faceNormal[0] * vx + faceNormal[1] * vy + faceNormal[2] * vz) / d;
                    return cosA > 0.02;
                });

                if (candidateCams.length === 0) continue;
                const activeCams = candidateCams;

                // Rasterize texels inside the 2D UV triangle
                for (let py = minY; py <= maxY; py++) {
                    const rowOffset = py * atlasW;
                    for (let px = minX; px <= maxX; px++) {
                        const w0 = ((V1 - V2) * (px - U2) + (U2 - U1) * (py - V2)) * invDet;
                        const w1 = ((V2 - V0) * (px - U2) + (U0 - U2) * (py - V2)) * invDet;
                        const w2 = 1.0 - w0 - w1;

                        if (w0 < -1e-3 || w1 < -1e-3 || w2 < -1e-3) continue;

                        // Normalize barycentrics
                        const bw0 = Math.max(0, w0);
                        const bw1 = Math.max(0, w1);
                        const bw2 = Math.max(0, w2);
                        const sumW = bw0 + bw1 + bw2 || 1;
                        const nw0 = bw0 / sumW, nw1 = bw1 / sumW, nw2 = bw2 / sumW;

                        // World 3D position
                        const wx = nw0 * p0[0] + nw1 * p1[0] + nw2 * p2[0];
                        const wy = nw0 * p0[1] + nw1 * p1[1] + nw2 * p2[1];
                        const wz = nw0 * p0[2] + nw1 * p1[2] + nw2 * p2[2];

                        // World normal
                        let nx = nw0 * n0[0] + nw1 * n1[0] + nw2 * n2[0];
                        let ny = nw0 * n0[1] + nw1 * n1[1] + nw2 * n2[1];
                        let nz = nw0 * n0[2] + nw1 * n1[2] + nw2 * n2[2];
                        const nLen = Math.hypot(nx, ny, nz);
                        if (nLen > 1e-6) { nx /= nLen; ny /= nLen; nz /= nLen; }
                        else { nx = faceNormal[0]; ny = faceNormal[1]; nz = faceNormal[2]; }

                        const texIdx = rowOffset + px;
                        atlasCoverage[texIdx] = 1;

                        // Test visibility and score across candidate cameras
                        for (let k = 0; k < activeCams.length; k++) {
                            const cam = activeCams[k];
                            const vx = cam.eye[0] - wx;
                            const vy = cam.eye[1] - wy;
                            const vz = cam.eye[2] - wz;
                            const dist = Math.hypot(vx, vy, vz);
                            if (dist < 1e-3) continue;

                            const cosIncidence = (nx * vx + ny * vy + nz * vz) / dist;
                            if (cosIncidence < minCosIncidence) continue;

                            // Fast projection into camera screen
                            const proj = this.projectWorldToScreen(wx, wy, wz, cam.VP, cam.width, cam.height);
                            if (!proj) continue;
                            const [sx, sy, cameraZ] = proj;
                            if (sx < 0 || sx >= cam.width || sy < 0 || sy >= cam.height) continue;

                            // Depth occlusion test against station rasterizer depth buffer
                            const depthIdx = Math.floor(sy) * cam.width + Math.floor(sx);
                            const recordedDepth = cam.depth[depthIdx];
                            if (recordedDepth >= EMPTY_DEPTH * 0.5) continue;

                            const allowedTol = Math.max(depthTol, cameraZ * depthRelTol);
                            if (cameraZ > recordedDepth + allowedTol) continue; // Occluded!

                            // Quality score favoring orthogonal angle and higher spatial resolution
                            const score = Math.pow(cosIncidence, angleExp) / Math.sqrt(Math.max(1.0, dist));

                            if (score > atlasBestScore[texIdx]) {
                                atlasBestScore[texIdx] = score;
                                const prevStation = atlasBestStation[texIdx];
                                atlasBestStation[texIdx] = cam.station.id;

                                if (prevStation !== cam.station.id) {
                                    if (prevStation >= 0) {
                                        stationTexelCounts.set(prevStation, (stationTexelCounts.get(prevStation) || 1) - 1);
                                    }
                                    stationTexelCounts.set(cam.station.id, (stationTexelCounts.get(cam.station.id) || 0) + 1);
                                }

                                const [r, g, b] = this.sampleBilinear(cam.rgba, cam.width, cam.height, sx, sy);
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

        // 5. Hole filling & gutter dilation (bleed)
        let coveredCount = 0;
        let paintedCount = 0;
        for (let i = 0; i < totalTexels; i++) {
            if (atlasCoverage[i] === 1) {
                coveredCount++;
                if (atlasBestScore[i] > 0) paintedCount++;
            }
        }

        // Fill unobserved covered texels with default stone color
        for (let i = 0; i < totalTexels; i++) {
            if (atlasCoverage[i] === 1 && atlasBestScore[i] === 0) {
                const pIdx = i * 4;
                atlasRgba[pIdx] = defaultCol[0];
                atlasRgba[pIdx + 1] = defaultCol[1];
                atlasRgba[pIdx + 2] = defaultCol[2];
                atlasRgba[pIdx + 3] = 255;
            }
        }

        // Bleed / dilate valid texels into chart gutters by edgeBleedPixels
        const bleedRadius = options.edgeBleedPixels ?? 4;
        if (bleedRadius > 0) {
            this.dilateGutters(atlasRgba, atlasCoverage, atlasW, atlasH, bleedRadius);
        }

        // 6. Intrinsic PBR Material Decomposition (NOAA solar de-lighting, Scharr normals, Toksvig AA, ORM)
        const pbrOpts: PbrDecompositionOptions = {
            enableAlbedoDeLighting: true,
            generateNormalMaps: true,
            generateRoughnessMaps: true,
            generateAoMaps: true,
            packOrm: true,
            enableMultiFrequencyNormals: true,
            enableBiophysicalRoughness: true,
            enableHbaoMicroCavity: true,
            enableToksvigFiltering: true,
            ...options.pbrDecomposition
        };

        // If solar ephemeris context is provided, configure analytical solar inverse de-lighting
        if (options.solarDelighting?.lat && options.solarDelighting?.lng && options.solarDelighting?.isoDate) {
            pbrOpts.enableSolarInverseDelighting = true;
            pbrOpts.solarDelighting = {
                latitude: options.solarDelighting.lat,
                longitude: options.solarDelighting.lng,
                timestampIso: options.solarDelighting.isoDate,
                ...options.pbrDecomposition?.solarDelighting
            };
        }

        const pbrResult = await AlgorithmicUvEngine.decomposePbr(
            atlasRgba,
            pbrOpts,
            atlasW,
            atlasH
        );

        // 7. Rebuild and serialize the enhanced GLB
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

        // Metallic extracted from ORM blue channel
        const metallicBuffer = Buffer.alloc(totalTexels * 4);
        for (let i = 0; i < totalTexels; i++) {
            const m = ormBuffer[i * 4 + 2];
            metallicBuffer[i * 4] = m;
            metallicBuffer[i * 4 + 1] = m;
            metallicBuffer[i * 4 + 2] = m;
            metallicBuffer[i * 4 + 3] = 255;
        }

        const albedoPng = encodePng(atlasW, atlasH, Buffer.from(pbrResult.albedo));
        const normalPng = encodePng(atlasW, atlasH, normalBuffer);
        const ormPng = encodePng(atlasW, atlasH, ormBuffer);
        const roughnessPng = encodePng(atlasW, atlasH, roughnessBuffer);
        const aoPng = encodePng(atlasW, atlasH, aoBuffer);
        const metallicPng = encodePng(atlasW, atlasH, metallicBuffer);

        const updatedGlb = this.embedTexturesIntoGlb(
            glbJson,
            glbBin,
            albedoPng,
            normalPng,
            ormPng
        );

        if (options.outGlbPath) {
            await fs.ensureDir(path.dirname(options.outGlbPath));
            await fs.writeFile(options.outGlbPath, updatedGlb);
        }

        // Compute metrics
        const stationContributions: StationContribution[] = [];
        for (const [stId, count] of stationTexelCounts.entries()) {
            stationContributions.push({
                stationId: stId,
                texelCount: count,
                fraction: paintedCount > 0 ? count / paintedCount : 0
            });
        }
        stationContributions.sort((a, b) => b.texelCount - a.texelCount);

        const durationMs = performance.now() - startTime;

        return {
            success: true,
            glbBuffer: updatedGlb,
            outGlbPath: options.outGlbPath,
            albedoPng,
            normalPng,
            ormPng,
            roughnessPng,
            aoPng,
            metallicPng,
            metrics: {
                resolution,
                totalAtlasTexels: totalTexels,
                coveredMeshTexels: coveredCount,
                directlyPaintedTexels: paintedCount,
                fillRate: totalTexels > 0 ? paintedCount / totalTexels : 0,
                stationContributions,
                durationMs
            },
            pbrResult
        };
    }

    /**
     * Renders blockouts and depth buffers for the stations and executes beautification.
     */
    private static async renderAndBeautifyStations(
        glbBuffer: Buffer,
        stations: ColmapCameraPose[],
        beautifyContext?: StationBeautifyContext,
        generator?: StationImageGenerator,
        options?: SurveyTextureUnprojectorOptions
    ): Promise<StationPlate[]> {
        const renderService = new SurveyStationRenderService();
        await renderService.loadMesh(glbBuffer);

        const renderW = options?.renderWidth || (options?.resolution ? Math.min(1280, options.resolution) : 1280);
        const renderH = options?.renderHeight || Math.round(renderW * (9 / 16));
        const plates: StationPlate[] = [];

        for (const st of stations) {
            const blockout = renderService.renderStationBlockout(st, {
                width: renderW,
                height: renderH
            });

            let stationRgba: Buffer = blockout.rgba;

            if (generator) {
                const beautifyService = new BeautifyStationService(renderService, generator);
                const bRes = await beautifyService.beautify(
                    st,
                    beautifyContext || { locationName: 'Target Location' },
                    { width: renderW, height: renderH }
                );
                stationRgba = Buffer.from(bRes.image.rgba);
            }

            plates.push({
                station: st,
                rgba: stationRgba,
                width: renderW,
                height: renderH,
                depth: blockout.depth,
                pose: blockout.cameraPose,
                intrinsics: blockout.intrinsics
            });
        }

        return plates;
    }

    /**
     * Loads mesh primitives from GLB. If the mesh lacks UVs, automatically generates
     * box/planar unwrap and packs them with MaxRectsAtlasPacker.
     */
    public static loadMeshPrimitives(
        glbBuffer: Buffer,
        targetResolution: number = 4096
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

        // When multiple submesh primitives exist, pack them into a unified non-overlapping atlas using MaxRectsAtlasPacker
        if (primitives.length > 1) {
            const packer = new MaxRectsAtlasPacker({
                maxWidth: targetResolution,
                maxHeight: targetResolution,
                padding: 4,
                powerOfTwo: true,
                allowRotation: false
            });

            const areas: number[] = [];
            let totalArea = 0;
            for (let i = 0; i < primitives.length; i++) {
                const prim = primitives[i];
                let primArea = 0;
                const triCount = Math.floor(prim.indices.length / 3);
                for (let t = 0; t < triCount; t++) {
                    const i0 = prim.indices[t * 3], i1 = prim.indices[t * 3 + 1], i2 = prim.indices[t * 3 + 2];
                    const ax = prim.positions[i1 * 3] - prim.positions[i0 * 3];
                    const ay = prim.positions[i1 * 3 + 1] - prim.positions[i0 * 3 + 1];
                    const az = prim.positions[i1 * 3 + 2] - prim.positions[i0 * 3 + 2];
                    const bx = prim.positions[i2 * 3] - prim.positions[i0 * 3];
                    const by = prim.positions[i2 * 3 + 1] - prim.positions[i0 * 3 + 1];
                    const bz = prim.positions[i2 * 3 + 2] - prim.positions[i0 * 3 + 2];
                    const cx = ay * bz - az * by;
                    const cy = az * bx - ax * bz;
                    const cz = ax * by - ay * bx;
                    primArea += 0.5 * Math.hypot(cx, cy, cz);
                }
                areas.push(Math.max(1.0, primArea));
                totalArea += Math.max(1.0, primArea);
            }

            const availableTexels = targetResolution * targetResolution * 0.85;
            for (let i = 0; i < primitives.length; i++) {
                const targetAreaTexels = (areas[i] / totalArea) * availableTexels;
                const side = Math.max(32, Math.round(Math.sqrt(targetAreaTexels)));
                packer.addTexture({
                    id: i,
                    width: Math.min(targetResolution - 8, side),
                    height: Math.min(targetResolution - 8, side)
                });
            }

            const atlasRes = packer.pack();
            const atlasW = atlasRes.width;
            const atlasH = atlasRes.height;

            let primIdx = 0;
            for (const mesh of json.meshes || []) {
                for (const prim of mesh.primitives || []) {
                    if (prim.attributes && prim.attributes.POSITION !== undefined) {
                        const packedPrim = primitives[primIdx];
                        const rect = atlasRes.rects.get(primIdx);
                        if (rect && packedPrim) {
                            const vertCount = packedPrim.positions.length / 3;
                            for (let v = 0; v < vertCount; v++) {
                                const localU = packedPrim.uvs[v * 2];
                                const localV = packedPrim.uvs[v * 2 + 1];
                                packedPrim.uvs[v * 2] = (rect.x + localU * rect.width) / atlasW;
                                packedPrim.uvs[v * 2 + 1] = (rect.y + localV * rect.height) / atlasH;
                            }

                            // Write back to binary buffer
                            if (prim.attributes.TEXCOORD_0 !== undefined) {
                                const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
                                const uvView = json.bufferViews[uvAcc.bufferView];
                                const uvOffset = (uvView.byteOffset || 0) + (uvAcc.byteOffset || 0);
                                const uvStride = uvView.byteStride ? uvView.byteStride / 4 : 2;
                                for (let v = 0; v < uvAcc.count; v++) {
                                    bin.writeFloatLE(packedPrim.uvs[v * 2], bin.byteOffset + uvOffset + (v * uvStride) * 4);
                                    bin.writeFloatLE(packedPrim.uvs[v * 2 + 1], bin.byteOffset + uvOffset + (v * uvStride + 1) * 4);
                                }
                            }
                        }
                        primIdx++;
                    }
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
        let rx = up[1] * fz - up[2] * fy;
        let ry = up[2] * fx - up[0] * fz;
        let rz = up[0] * fy - up[1] * fx;
        const rlen = Math.hypot(rx, ry, rz) || 1;
        rx /= rlen; ry /= rlen; rz /= rlen;

        const ux = fy * rz - fz * ry;
        const uy = fz * rx - fx * rz;
        const uz = fx * ry - fy * rx;

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
     * Embeds the new albedo, normal, and ORM textures into the GLB JSON & BIN structures.
     */
    private static embedTexturesIntoGlb(
        json: any,
        bin: Buffer,
        albedoPng: Buffer,
        normalPng: Buffer,
        ormPng: Buffer
    ): Buffer {
        const newJson = JSON.parse(JSON.stringify(json));
        let currentBin = Buffer.from(bin);

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

        // 1. Albedo image & texture
        const albBv = appendBuffer(albedoPng);
        const albImgIdx = newJson.images.length;
        newJson.images.push({ bufferView: albBv.bufferViewIndex, mimeType: 'image/png', name: 'albedo_atlas' });
        const albTexIdx = newJson.textures.length;
        newJson.textures.push({ source: albImgIdx });

        // 2. Normal image & texture
        const normBv = appendBuffer(normalPng);
        const normImgIdx = newJson.images.length;
        newJson.images.push({ bufferView: normBv.bufferViewIndex, mimeType: 'image/png', name: 'normal_atlas' });
        const normTexIdx = newJson.textures.length;
        newJson.textures.push({ source: normImgIdx });

        // 3. ORM image & texture
        const ormBv = appendBuffer(ormPng);
        const ormImgIdx = newJson.images.length;
        newJson.images.push({ bufferView: ormBv.bufferViewIndex, mimeType: 'image/png', name: 'orm_atlas' });
        const ormTexIdx = newJson.textures.length;
        newJson.textures.push({ source: ormImgIdx });

        // Update or create material
        const matIdx = 0;
        if (newJson.materials.length === 0) {
            newJson.materials.push({
                name: 'pbr_beautified_material',
                pbrMetallicRoughness: {
                    baseColorTexture: { index: albTexIdx },
                    metallicRoughnessTexture: { index: ormTexIdx },
                    roughnessFactor: 1.0,
                    metallicFactor: 1.0
                },
                normalTexture: { index: normTexIdx },
                occlusionTexture: { index: ormTexIdx }
            });
        } else {
            const mat = newJson.materials[matIdx];
            if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
            mat.pbrMetallicRoughness.baseColorTexture = { index: albTexIdx };
            mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: ormTexIdx };
            mat.pbrMetallicRoughness.roughnessFactor = 1.0;
            mat.pbrMetallicRoughness.metallicFactor = 1.0;
            mat.normalTexture = { index: normTexIdx };
            mat.occlusionTexture = { index: ormTexIdx };

            // Strip KHR_materials_unlit to ensure physical PBR shading
            if (mat.extensions && mat.extensions.KHR_materials_unlit) {
                delete mat.extensions.KHR_materials_unlit;
            }
        }

        // Assign material to all mesh primitives
        for (const mesh of newJson.meshes || []) {
            for (const prim of mesh.primitives || []) {
                prim.material = matIdx;
            }
        }

        // Clean unlit extension from extensionsUsed
        if (newJson.extensionsUsed) {
            newJson.extensionsUsed = newJson.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
        }

        newJson.buffers[0].byteLength = currentBin.length;
        return AlgorithmicUvEngine.serializeGlb(newJson, currentBin);
    }
}
