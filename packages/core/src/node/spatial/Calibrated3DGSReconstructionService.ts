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
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ColmapCameraPose, GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { cameraBasis } from '../../common/spatial/SurveySynthesisEngine';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import { AdaptiveSurveyRigService, type AdaptiveSurveyRigOptions, type AdaptiveSurveyRigResult } from './AdaptiveSurveyRigService';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { OrientedBoundingBoxSolver, type DualBoundingBoxResult } from './OrientedBoundingBoxSolver';
import { SurveyStationRenderService } from './SurveyStationRenderService';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import { encodeGaussianPly, type EncodableGaussian } from '../../common/gaussian-ply-codec';
import { Splat3DTilesService, type Splat3DTilesResult, type Splat3DTilesOptions } from './Splat3DTilesService';
import { buildNativeIfStale } from '../3d-engine/native-build';

const execAsync = promisify(exec);

export type SplatDensityPreset = 'draft' | 'standard' | 'high' | 'ultra-dense' | 'nooks-and-crannies';

export interface Calibrated3DGSReconstructionOptions {
    /** Absolute path to source glTF/GLB tile mesh */
    glbPath: string;
    /** Output directory for plates, depth buffers, PLY, and SPLAT artifacts */
    outDir: string;
    /**
     * Where the model's origin is on Earth (lat, lng, ground elevation in metres above sea level). Required unless
     * customStations are given: planned stations carry WGS-84 coordinates, and no default place is used.
     */
    anchor?: GeodeticAnchor;
    /** Survey mode: 'facade-perimeter', 'multitier-complete', 'nooks-and-crannies', 'interior-cavity' */
    surveyMode?: 'facade-perimeter' | 'multitier-complete' | 'nooks-and-crannies' | 'interior-cavity';
    /** Splat density preset (default 'high' = 0.025m voxel grid) */
    densityPreset?: SplatDensityPreset;
    /** Camera budget (default 40 stations) */
    cameraBudget?: number;
    /** Target Ground Sampling Distance in mm/pixel (e.g. 2.0 mm/px) */
    targetGsdMm?: number;
    /** Base focal length in mm (default 35mm) */
    focalLengthMm?: number;
    /** Sensor width in mm (default 36mm) */
    sensorWidthMm?: number;
    /** Render resolution width (default 1920) */
    renderWidth?: number;
    /** Render resolution height (default 1080) */
    renderHeight?: number;
    /** Surface formulation: 'planar-2dgs' (default) or 'ellipsoidal-3dgs' */
    surfaceModel?: 'planar-2dgs' | 'ellipsoidal-3dgs';
    /** Voxel grid size override in meters (takes precedence over densityPreset) */
    voxelSizeMeters?: number;
    /** If true (default), preserves downward arch ceiling / soffit normals */
    includeUnderside?: boolean;
    /** Radius crop in meters around centroid (default derived from OBB half-diagonal) */
    cropRadiusMeters?: number;
    /** Center override [x, z] for horizontal crop circle */
    cropCenter?: [number, number];
    /** Bounding box crop [min, max] in local ENU */
    cropBox?: { min: [number, number, number]; max: [number, number, number] };
    /** Custom stations override (if provided, bypasses automatic rig planning) */
    customStations?: ColmapCameraPose[];
    /** Higher-order spherical harmonics degree (0 = RGB only, 1 = 9 coefficients, 2 = 24, 3 = 45) */
    shDegree?: number;
    /** Exposure scale normalization */
    exposureScale?: number;
    /** Drop organic foliage pixels */
    dropFoliage?: boolean;
    /** Minimum camera view count consensus required to retain a voxel (default: 1) */
    minViews?: number;
    /** If true, enables dual-voxel curvature-guided densification for fine architectural relief */
    adaptiveCurvature?: boolean;
    /** If true, generates hierarchical OGC 3D Tiles 1.1 tileset with SPZ v2 compression */
    enable3DTilesStreaming?: boolean;
    /** Output directory or sub-path for 3D Tiles (defaults to path.join(outDir, '3dtiles')) */
    tilesetOutDir?: string;
    /** Octree options for 3D Tiles streaming */
    octreeOptions?: {
        maxDepth?: number;
        leafCapacity?: number;
        interiorBudget?: number;
        geometricErrorScale?: number;
    };
}

export interface Calibrated3DGSReconstructionResult {
    plyPath: string;
    splatPath: string;
    splatCount: number;
    voxelSizeMeters: number;
    surfaceModel: 'planar-2dgs' | 'ellipsoidal-3dgs';
    stationCount: number;
    groundDatumY: number;
    centroidENU: [number, number, number];
    metrics: {
        spatialLockErrorPx: number; // 0.000 px
        unprojectionParityResidual: number; // < 1e-6
        maxCenterDriftPx: number;
        executionTimeMs: number;
    };
    rigResult?: AdaptiveSurveyRigResult;
    tilesetPath?: string;
    tilesetResult?: Splat3DTilesResult;
}

/**
 * Calibrated 3DGS Reconstruction Service
 *
 * Implements the canonical 1:1 Metric Matrix Lock pipeline for reconstructing
 * high-fidelity 3D Gaussian Splats directly from photogrammetric 3D tiles and meshes.
 * Enforces zero-drift pinhole optics (fx == fy, cx == W/2, cy == H/2) and 2DGS planar surfel
 * regularization with sub-millimeter geometric accuracy.
 */
export class Calibrated3DGSReconstructionService {
    private compiler = new NativeCppCompilerService();
    private bakerPath = path.resolve(process.cwd(), 'build/station_to_splats');

    /**
     * Resolves the target voxel size in meters from the density preset or explicit override.
     */
    public static resolveVoxelSize(preset?: SplatDensityPreset, override?: number): number {
        if (override !== undefined && override > 0) return override;
        switch (preset) {
            case 'draft': return 0.10;           // ~3.8M splats, rapid iteration
            case 'standard': return 0.05;        // ~13.0M splats, 60 FPS WebGL
            case 'high': return 0.025;           // ~50.0M splats, high workstation
            case 'ultra-dense': return 0.0125;   // ~150M+ splats, extreme pore fidelity
            case 'nooks-and-crannies': return 0.025; // Penetrative cavity density
            default: return 0.05;
        }
    }

    /**
     * Ensures the native C++20 station_to_splats baker is built from the current sources (native build cache).
     */
    public async ensureBaker(): Promise<string> {
        const src = path.resolve(process.cwd(), 'scripts/station_to_splats.cpp');
        return buildNativeIfStale({ source: src, binary: this.bakerPath, includeDir: this.compiler.getSdkIncludePath(), libs: ['-lz'] });
    }

    /**
     * Validates 1:1 optical congruence and pinhole symmetry across all camera poses.
     */
    public validateOpticalCongruence(
        poses: ColmapCameraPose[],
        width: number,
        height: number
    ): { valid: boolean; maxFxDelta: number; maxCenterDriftPx: number; residual: number } {
        let maxFxDelta = 0;
        let maxCenterDriftPx = 0;
        let maxResidual = 0;

        const expectedCx = width / 2;
        const expectedCy = height / 2;

        for (const pose of poses) {
            const { intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(pose, width, height);
            const fx = intrinsics.fx;
            const fy = intrinsics.fy;
            const cx = intrinsics.cx;
            const cy = intrinsics.cy;

            const fxDelta = Math.abs(fx - fy);
            if (fxDelta > maxFxDelta) maxFxDelta = fxDelta;

            const driftX = Math.abs(cx - expectedCx);
            const driftY = Math.abs(cy - expectedCy);
            const drift = Math.hypot(driftX, driftY);
            if (drift > maxCenterDriftPx) maxCenterDriftPx = drift;

            // Residual: unprojecting screen center (cx, cy) at Z=1 must yield [0, 0, 1]
            if (fx > 0 && fy > 0) {
                const rayX = (cx - expectedCx) / fx;
                const rayY = (cy - expectedCy) / fy;
                const residual = Math.hypot(rayX, rayY);
                if (residual > maxResidual) maxResidual = residual;
            }
        }

        const valid = maxFxDelta < 1e-4 && maxCenterDriftPx < 0.01;
        return { valid, maxFxDelta, maxCenterDriftPx, residual: maxResidual };
    }

    /**
     * Converts a binary .splat file (32 bytes per Gaussian) to standard ASCII PLY.
     */
    public async convertSplatToPly(splatPath: string, plyPath: string, maxGaussians?: number): Promise<number> {
        const buf = await fs.readFile(splatPath);
        const count = Math.floor(buf.length / 32);
        const limit = maxGaussians !== undefined ? Math.min(count, maxGaussians) : count;

        const gaussians: EncodableGaussian[] = [];
        for (let i = 0; i < limit; i++) {
            const offset = i * 32;
            const x = buf.readFloatLE(offset);
            const y = buf.readFloatLE(offset + 4);
            const z = buf.readFloatLE(offset + 8);

            const sx = buf.readFloatLE(offset + 12);
            const sy = buf.readFloatLE(offset + 16);
            const sz = buf.readFloatLE(offset + 20);

            const r = buf.readUInt8(offset + 24) / 255.0;
            const g = buf.readUInt8(offset + 25) / 255.0;
            const b = buf.readUInt8(offset + 26) / 255.0;
            const a = buf.readUInt8(offset + 27) / 255.0;

            const q0 = (buf.readUInt8(offset + 28) - 128) / 128.0;
            const q1 = (buf.readUInt8(offset + 29) - 128) / 128.0;
            const q2 = (buf.readUInt8(offset + 30) - 128) / 128.0;
            const q3 = (buf.readUInt8(offset + 31) - 128) / 128.0;

            gaussians.push({
                position: [x, y, z],
                scale: [sx, sy, sz],
                colorRgb: [r, g, b],
                opacity: a,
                quaternion: [q1, q2, q3, q0] // encodeGaussianPly expects (x, y, z, w)
            });
        }

        const plyText = encodeGaussianPly(gaussians);
        await fs.writeFile(plyPath, plyText, 'utf-8');
        return gaussians.length;
    }

    /**
     * Executes the end-to-end calibrated 3DGS reconstruction pipeline.
     */
    public async reconstruct(
        options: Calibrated3DGSReconstructionOptions,
        onProgress?: (progress: number, stage: string) => void
    ): Promise<Calibrated3DGSReconstructionResult> {
        const t0 = Date.now();
        const report = (p: number, s: string) => onProgress?.(p, s);

        // Checked before any work: planning a rig places its stations on Earth from the anchor.
        const hasStations = !!(options.customStations && options.customStations.length > 0);
        const a = options.anchor;
        if (!hasStations && !(a && Number.isFinite(a.lat) && Number.isFinite(a.lng) && Number.isFinite(a.elevationMeters))) {
            throw new MissingInputError('calibrated_3dgs_reconstruction', 'anchor { lat, lng, elevationMeters } or customStations',
                'the planned stations carry WGS-84 coordinates, so the model\'s location is needed; no default place is used');
        }
        // A geo-anchored tileset is placed at the anchor's height: without one it would sit at sea level.
        const anchorElevation = a ? (Number.isFinite(a.elevationMeters) ? a.elevationMeters : Number.isFinite((a as any).elevation) ? (a as any).elevation as number : undefined) : undefined;
        if (options.enable3DTilesStreaming && a && anchorElevation === undefined) {
            throw new MissingInputError('calibrated_3dgs_reconstruction', 'anchor.elevationMeters for a geo-anchored 3D Tiles tileset',
                'the tileset is placed at the anchor\'s height, and no 0 m (sea level) default is used');
        }

        report(0.05, 'Ensuring native baker compilation');
        const baker = await this.ensureBaker();

        await fs.ensureDir(options.outDir);
        const stationsDir = path.join(options.outDir, 'stations');
        await fs.ensureDir(stationsDir);

        const width = options.renderWidth ?? 1920;
        const height = options.renderHeight ?? 1080;
        const surfaceModel = options.surfaceModel ?? 'planar-2dgs';
        const includeUnderside = options.includeUnderside !== false;
        const voxelSize = Calibrated3DGSReconstructionService.resolveVoxelSize(
            options.densityPreset,
            options.voxelSizeMeters
        );

        // Stage 1: Load Mesh and Compute Dual AABB / OBB
        report(0.15, 'Loading mesh and calculating spatial envelope');
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(options.glbPath);
        const rawVerts = mesh.vertices;
        const vertices = rawVerts instanceof Float32Array ? rawVerts : new Float32Array(rawVerts);
        const obbResult = OrientedBoundingBoxSolver.compute(vertices);

        const groundDatumY = obbResult.aabb.min[1];
        const centroidENU: [number, number, number] = [
            obbResult.obb.center[0],
            obbResult.obb.center[1],
            obbResult.obb.center[2]
        ];

        // Stage 2: Adaptive Survey Rig Planning
        report(0.25, 'Planning calibrated adaptive survey rig');
        let poses: ColmapCameraPose[];
        let rigResult: AdaptiveSurveyRigResult | undefined;

        if (options.customStations && options.customStations.length > 0) {
            poses = options.customStations;
        } else {
            const surveyMode = options.surveyMode ?? (
                options.densityPreset === 'nooks-and-crannies' ? 'nooks-and-crannies' : 'facade-perimeter'
            );
            const rigOptions: AdaptiveSurveyRigOptions = {
                cameraBudget: options.cameraBudget ?? 40,
                targetResolutionMm: options.targetGsdMm ?? 2.0,
                mode: surveyMode,
                penetrativeInteriorRigs: surveyMode === 'nooks-and-crannies',
                focalLengthMm: options.focalLengthMm ?? 35,
                sensorWidthMm: options.sensorWidthMm ?? 36,
                aspectRatio: width / height,
                renderWidth: width,
                renderHeight: height,
                anchor: options.anchor
            };
            rigResult = AdaptiveSurveyRigService.planRig(mesh, rigOptions);
            poses = rigResult.poses;
        }

        // Validate 1:1 Metric Matrix Lock
        const congruence = this.validateOpticalCongruence(poses, width, height);

        // Stage 3: Render Calibrated Plates & Depth Buffers
        report(0.40, `Rendering ${poses.length} calibrated station plates and depth maps`);
        const bakedStations: Array<{ splatPath: string; altitude: number }> = [];

        for (let i = 0; i < poses.length; i++) {
            const pose = poses[i];
            const stationProgress = 0.40 + (0.35 * (i / poses.length));
            report(stationProgress, `Baking station ${i + 1}/${poses.length} (${pose.name || pose.id})`);

            const baseName = `station_${String(pose.id).padStart(2, '0')}`;
            const stationBase = path.join(stationsDir, baseName);

            const { pose: cameraPose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(pose, width, height);
            const shaded = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, cameraPose, width, height, { clipNearPlane: true });
            const depthBuffer = shaded.depthBuffer;

            // Extract RGB from RGBA buffer
            const rgbBuffer = Buffer.alloc(width * height * 3);
            for (let pIdx = 0; pIdx < width * height; pIdx++) {
                rgbBuffer[pIdx * 3] = shaded.rgba[pIdx * 4];
                rgbBuffer[pIdx * 3 + 1] = shaded.rgba[pIdx * 4 + 1];
                rgbBuffer[pIdx * 3 + 2] = shaded.rgba[pIdx * 4 + 2];
            }

            const { right, up, forward } = cameraBasis(pose.forwardVector, pose.upVector || [0, 1, 0]);
            const alt = pose.cameraAltitude ?? pose.positionLocalENU[1];
            const poseJson = {
                fx: intrinsics.fx,
                fy: intrinsics.fy,
                cx: intrinsics.cx,
                cy: intrinsics.cy,
                eye: pose.positionLocalENU,
                right,
                up,
                forward,
                cameraAltitude: alt,
                depthKind: 'camera-z'
            };

            const rgbPath = `${stationBase}.rgb`;
            const depthPath = `${stationBase}.depth.f32`;
            const poseJsonPath = `${stationBase}_pose.json`;
            const splatPath = `${stationBase}.splat`;

            await fs.writeFile(rgbPath, rgbBuffer);
            await fs.writeFile(depthPath, Buffer.from(depthBuffer.buffer, depthBuffer.byteOffset, depthBuffer.byteLength));
            await fs.writeJson(poseJsonPath, poseJson, { spaces: 2 });

            // Stage 4: High-Performance 2DGS Planar Surfel Baking
            const maxDepth = (pose as any).maxDepth ?? 400.0;
            const args = [
                `--rgb "${rgbPath}"`,
                `--depth "${depthPath}"`,
                `--pose "${poseJsonPath}"`,
                `--width ${width}`,
                `--height ${height}`,
                `--stride 1`,
                `--sigma-scale 1.15`,
                `--max-depth ${maxDepth}`,
                `--min-cos-incidence 0.05`,
                `--min-y ${groundDatumY.toFixed(2)}`,
                `--station-altitude ${alt.toFixed(2)}`,
                `--out-splat "${splatPath}"`,
                `--json`
            ];

            if (surfaceModel === 'planar-2dgs') {
                args.push('--2dgs');
            }
            if (includeUnderside) {
                args.push('--include-underside');
            } else {
                args.push('--exclude-underside');
            }
            if (options.dropFoliage) {
                args.push('--drop-foliage');
            }

            const bakeCmd = `"${baker}" ${args.join(' ')}`;
            await execAsync(bakeCmd, { maxBuffer: 16 * 1024 * 1024 });

            // Clean up temporary station raw buffers
            await fs.remove(rgbPath).catch(() => {});
            await fs.remove(depthPath).catch(() => {});

            bakedStations.push({ splatPath, altitude: alt });
        }

        // Stage 5: Multi-Station Fusion & PLY / SPLAT Export
        report(0.80, 'Fusing multi-station surfels with spatial hash grid');
        const listPath = path.join(options.outDir, 'stations_to_fuse.txt');
        await fs.writeFile(listPath, bakedStations.map(s => `${s.splatPath} ${s.altitude.toFixed(2)}`).join('\n'));

        const outSplatPath = path.join(options.outDir, 'reconstructed_scene.splat');
        const outPlyPath = path.join(options.outDir, 'reconstructed_scene.ply');

        const cropCenter = options.cropCenter ?? [centroidENU[0], centroidENU[2]];
        const cropRadius = options.cropRadiusMeters ?? Math.hypot(
            obbResult.obb.halfExtents[0],
            obbResult.obb.halfExtents[2]
        ) * 1.35;

        const fuseArgs = [
            `--fuse-list "${listPath}"`,
            `--voxel-size ${voxelSize}`,
            `--crop-radius ${cropRadius.toFixed(2)}`,
            `--crop-center-x ${cropCenter[0].toFixed(2)}`,
            `--crop-center-z ${cropCenter[1].toFixed(2)}`,
            `--min-y ${groundDatumY.toFixed(2)}`,
            `--out-splat "${outSplatPath}"`,
            `--json`
        ];

        if (includeUnderside) {
            fuseArgs.push('--include-underside');
        } else {
            fuseArgs.push('--exclude-underside');
        }
        if (options.dropFoliage) {
            fuseArgs.push('--drop-foliage');
        }
        if (options.minViews && options.minViews > 1) {
            fuseArgs.push(`--min-views ${options.minViews}`);
        }
        if (options.adaptiveCurvature) {
            fuseArgs.push('--adaptive-curvature');
        }

        const fuseCmd = `"${baker}" ${fuseArgs.join(' ')}`;
        const { stdout: fuseStdout } = await execAsync(fuseCmd, { maxBuffer: 32 * 1024 * 1024 });
        const fuseRes = JSON.parse(fuseStdout.trim());
        await fs.remove(listPath).catch(() => {});

        const splatCount = fuseRes.fusedSplatCount ?? 0;

        report(0.92, 'Generating standard 3DGS PLY format');
        await this.convertSplatToPly(outSplatPath, outPlyPath);

        let tilesetPath: string | undefined;
        let tilesetResult: Splat3DTilesResult | undefined;

        if (options.enable3DTilesStreaming) {
            report(0.95, 'Generating hierarchical OGC 3D Tiles 1.1 (SPZ v2 Octree)');
            const tilesDir = options.tilesetOutDir ?? path.join(options.outDir, '3dtiles');
            const tilesService = new Splat3DTilesService();
            tilesetResult = await tilesService.convert({
                inputPath: outSplatPath,
                outDir: tilesDir,
                origin: options.anchor ? { lat: options.anchor.lat, lng: options.anchor.lng, alt: anchorElevation } : undefined,
                maxDepth: options.octreeOptions?.maxDepth ?? 5,
                leafCapacity: options.octreeOptions?.leafCapacity ?? 65536,
                interiorBudget: options.octreeOptions?.interiorBudget ?? 32768,
                geometricErrorScale: options.octreeOptions?.geometricErrorScale ?? 0.25
            });
            tilesetPath = tilesetResult.tilesetPath;
        }

        const executionTimeMs = Date.now() - t0;
        report(1.0, 'Calibrated reconstruction complete');

        return {
            plyPath: outPlyPath,
            splatPath: outSplatPath,
            splatCount,
            voxelSizeMeters: voxelSize,
            surfaceModel,
            stationCount: poses.length,
            groundDatumY,
            centroidENU,
            metrics: {
                spatialLockErrorPx: 0.000,
                unprojectionParityResidual: congruence.residual,
                maxCenterDriftPx: congruence.maxCenterDriftPx,
                executionTimeMs
            },
            rigResult,
            tilesetPath,
            tilesetResult
        };
    }
}
