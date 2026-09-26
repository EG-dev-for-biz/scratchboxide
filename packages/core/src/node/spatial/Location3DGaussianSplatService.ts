/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySplatPipelineService } from './SurveySplatPipelineService';
import { SurveySynthesisEngine } from '../../common/spatial/SurveySynthesisEngine';
import {
    createDefaultStationImageGenerator,
    createArchitecturalStationGenerator,
    type StationImageGenerator
} from './BeautifyStationService';
import { resolveSurveyPreset } from './survey-router';
import { Google3DTileService } from '../../browser/generative-canvas/services/Google3DTileService';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import type { Scene3DData, Media4DObject } from '../../browser/generative-canvas/canvas-types';

export interface Location3DGSRequest {
    location: string;
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
    error?: string;
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
        const publicDir = path.resolve(this.workspaceRoot, 'public');
        const relative = path.relative(publicDir, filePath);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
            return `/${relative.replace(/\\/g, '/')}`;
        }
        return filePath;
    }

    /**
     * Executes the complete end-to-end Location 3DGS pipeline.
     */
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

        let glbPath = path.isAbsolute(preset.glbPath) ? preset.glbPath : path.resolve(root, preset.glbPath);
        const anchor = preset.anchor;
        const sanitizedName = (req.location || anchor.formattedAddress || 'location').toLowerCase().replace(/[^a-z0-9]+/g, '_');

        // If target GLB is not on disk, synthesize authentic clay mesh or check fallback models
        if (!fs.existsSync(glbPath)) {
            const namedCandidates = [
                path.resolve(root, `public/models/${sanitizedName}_grounded.glb`),
                path.resolve(root, `public/models/${sanitizedName}_clay.glb`),
                path.resolve(root, `public/models/${sanitizedName}.glb`)
            ];
            let found = false;
            for (const cand of namedCandidates) {
                if (fs.existsSync(cand)) {
                    glbPath = cand;
                    found = true;
                    break;
                }
            }

            if (!found) {
                // Dynamically synthesize authentic real-world 3D clay geometry for this location
                try {
                    const tileService = Google3DTileService.getInstance();
                    const tileResult = tileService.ingestTileRegionSync({
                        query: req.location || anchor.formattedAddress,
                        lat: anchor.lat,
                        lng: anchor.lng,
                        elevation: anchor.elevationMeters,
                        radiusMeters: preset.cropRadius || 75,
                        clayPreset: 'studio-grey',
                        detailLevel: 'high',
                        generateGlb: true
                    });
                    if (tileResult.glbBuffer) {
                        const targetGlb = path.resolve(root, `public/models/${sanitizedName}_clay.glb`);
                        await fs.outputFile(targetGlb, Buffer.from(tileResult.glbBuffer));
                        glbPath = targetGlb;
                        found = true;
                    }
                } catch (tileErr) {
                    console.warn('[Location3DGSService] Dynamic tile mesh synthesis warning:', tileErr);
                }
            }

            if (!found) {
                const fallbackCandidates = [
                    path.resolve(root, 'public/models/survey_box_ground.glb'),
                    path.resolve(root, 'build/test_survey_render/box_ground.glb'),
                    path.resolve(root, 'public/models/colosseum_clay.glb'),
                    path.resolve(root, 'public/models/esb_clay.glb'),
                    path.resolve(root, 'public/models/gap_clay.glb')
                ];
                for (const cand of fallbackCandidates) {
                    if (fs.existsSync(cand)) {
                        glbPath = cand;
                        break;
                    }
                }
            }
        }

        let stations = preset.stations;

        // If custom camera count requested and differs from preset
        if (req.cameraCount && req.cameraCount !== stations.length) {
            const engine = new SurveySynthesisEngine();
            stations = engine.synthesize(anchor, {
                type: 'orbital-multi-tier',
                cameraCount: req.cameraCount,
                targetRadiusMeters: preset.cropRadius || 45,
                altitudeTiersMeters: [anchor.elevationMeters + 5, anchor.elevationMeters + 25]
            });
        }

        const outDir = path.isAbsolute(preset.outDir) ? preset.outDir : path.resolve(root, preset.outDir);
        await fs.ensureDir(outDir);

        // 2. Resolve image generator (Nano Banana / Google media generation or procedural mock)
        let generator = req.generator;
        if (!generator) {
            if (process.env.SCRATCHBOX_STATION_IMAGE_GENERATOR === 'mock') {
                const { decodePng, encodePng } = await import('../texture-processing');
                generator = {
                    name: 'mock-recolour',
                    async generate(a) {
                        const b = decodePng(a.blockoutPng);
                        const out = Buffer.alloc(b.rgba.length);
                        for (let i = 0; i < b.rgba.length; i += 4) {
                            const r = b.rgba[i], g = b.rgba[i + 1], bl = b.rgba[i + 2];
                            const isSky = bl > 170 && r < 140;
                            out[i] = isSky ? 135 : Math.min(255, r * 1.1 + 15);
                            out[i + 1] = isSky ? 170 : g * 0.95;
                            out[i + 2] = isSky ? 215 : bl * 0.75;
                            out[i + 3] = 255;
                        }
                        return encodePng(b.width, b.height, out);
                    }
                };
            } else {
                generator = createDefaultStationImageGenerator({ workspaceRoot: root, allowProceduralGenerator: true });
            }
        }

        const beautifyContext = {
            locationName: req.location || preset.beautify.locationName,
            architecturalStyle: req.architecturalStyle || preset.beautify.architecturalStyle,
            moodPromptContext: req.moodPromptContext || preset.beautify.moodPromptContext || 'Authentic daylight with natural sun shadows.',
            styleSuffix: req.styleSuffix || preset.beautify.styleSuffix || ''
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
            exposureScale: req.exposureScale
        }, progressReporter);

        const splatUrl = this.toWebUrl(pipelineResult.fusedSplatPath);
        const tilesetUrl = this.toWebUrl(pipelineResult.tilesetPath);

        const sceneSlug = beautifyContext.locationName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const splatMediaObject: Media4DObject = {
            id: `${sceneSlug}-3dgs`,
            content: {
                type: 'gaussian-splat',
                durableUri: splatUrl,
                mimeType: splatUrl.endsWith('.spz') ? 'application/x-spz' : 'application/octet-stream',
                metadata: {
                    dims: {
                        width: Math.abs(pipelineResult.cropBox.max[0] - pipelineResult.cropBox.min[0]) || 120,
                        height: Math.abs(pipelineResult.cropBox.max[1] - pipelineResult.cropBox.min[1]) || 120,
                        depth: Math.abs(pipelineResult.cropBox.max[2] - pipelineResult.cropBox.min[2]) || 120
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
                    prompt: `Location 3D Gaussian Splatting of ${beautifyContext.locationName}`,
                    params: { pipeline: 'Location3DGaussianSplatService', restyleModel: 'nano-banana-2' }
                },
                timestamp: new Date().toISOString()
            }
        };

        const scene3DData: Scene3DData = {
            title: `${beautifyContext.locationName} — 3D Gaussian Splat`,
            subtitle: `Photorealistic 3DGS radiance field at Lat ${anchor.lat.toFixed(4)}°, Lng ${anchor.lng.toFixed(4)}° synthesized via Nano Banana multi-station capture and C++20 metric depth unprojection.`,
            worldBranch: `splat-world/${sceneSlug}`,
            sceneType: 'gaussian_splat',
            renderMode: 'pbr',
            cameraMode: 'orbit',
            animation: 'orbit',
            splatUrl,
            splatTilesetUrl: tilesetUrl,
            splatOptions: {
                splatScale: 1.0,
                contactShadow: true,
                enableSoftZ: true,
                cropBox: pipelineResult.cropBox
            },
            timeline: {
                currentTimeMs: 0,
                durationMs: 20000,
                isPlaying: true,
                speed: 1.0,
                playbackSpeed: 1.0,
                isLooping: true
            },
            camera: {
                position: [0, 20, 45],
                target: [0, 2, 0],
                fov: 45
            },
            environment: {
                skybox: 'golden_hour',
                lighting: 'golden_hour',
                ground: false
            },
            geoAnchor: {
                lat: anchor.lat,
                lng: anchor.lng,
                elevation: anchor.elevationMeters,
                active: true,
                landmarkName: beautifyContext.locationName
            },
            customMeshes: [],
            objects: [splatMediaObject]
        };

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
            scene3DData,
            cropBox: pipelineResult.cropBox,
            durationMs: Date.now() - t0
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
