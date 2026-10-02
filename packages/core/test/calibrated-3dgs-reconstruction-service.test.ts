/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    Calibrated3DGSReconstructionService,
    type Calibrated3DGSReconstructionOptions
} from '../src/node/spatial/Calibrated3DGSReconstructionService';
import { AdaptiveSurveyRigService } from '../src/node/spatial/AdaptiveSurveyRigService';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import type { ColmapCameraPose } from '../src/common/spatial/colmap-vector-reference-types';

const GLB_PATH = path.resolve(process.cwd(), 'build/test_survey_render/box_ground.glb');
const OUT_DIR = path.resolve(process.cwd(), 'build/test_calibrated_3dgs_recon');

describe('Calibrated3DGSReconstructionService: 1:1 Metric Matrix Lock 3DGS Reconstruction', () => {
    const service = new Calibrated3DGSReconstructionService();

    beforeAll(async () => {
        await fs.emptyDir(OUT_DIR);
    });

    it('resolves correct voxel grid sizes across density presets and explicit overrides', () => {
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize('draft')).toBe(0.10);
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize('standard')).toBe(0.05);
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize('high')).toBe(0.025);
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize('ultra-dense')).toBe(0.0125);
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize('nooks-and-crannies')).toBe(0.025);

        // Explicit override always takes precedence
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize('draft', 0.035)).toBe(0.035);
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize(undefined, 0.015)).toBe(0.015);
        expect(Calibrated3DGSReconstructionService.resolveVoxelSize(undefined, undefined)).toBe(0.05);
    });

    it('validates 1:1 pinhole optical congruence and zero-drift center alignment', () => {
        const dummyPoses: ColmapCameraPose[] = [
            {
                id: 1,
                name: 'station_01',
                positionLocalENU: [50, 10, 50],
                forwardVector: [-0.7071, 0, -0.7071],
                yawDegrees: -135,
                pitchDegrees: 0,
                rollDegrees: 0,
                focalLengthMm: 35,
                sensorWidthMm: 36,
                fovDegrees: 54.43,
                aspectRatio: 16 / 9,
                coordinatesWGS84: { lat: 41.8902, lng: 12.4922, elevation: 22 }
            },
            {
                id: 2,
                name: 'station_02',
                positionLocalENU: [-50, 15, 50],
                forwardVector: [0.7071, -0.1, -0.7071],
                yawDegrees: 135,
                pitchDegrees: -5.7,
                rollDegrees: 0,
                focalLengthMm: 35,
                sensorWidthMm: 36,
                fovDegrees: 54.43,
                aspectRatio: 16 / 9,
                coordinatesWGS84: { lat: 41.8902, lng: 12.4922, elevation: 22 }
            }
        ];

        const width = 1920;
        const height = 1080;
        const congruence = service.validateOpticalCongruence(dummyPoses, width, height);

        expect(congruence.valid).toBe(true);
        expect(congruence.maxFxDelta).toBeLessThan(1e-4);
        expect(congruence.maxCenterDriftPx).toBeLessThan(0.01);
        expect(congruence.residual).toBeLessThan(1e-6);
    });

    it('successfully reconstructs 3DGS from test GLB with 1:1 metric spatial lock', async () => {
        expect(fs.existsSync(GLB_PATH)).toBe(true);

        const progressLog: string[] = [];
        const options: Calibrated3DGSReconstructionOptions = {
            glbPath: GLB_PATH,
            outDir: OUT_DIR,
            cameraBudget: 4,
            densityPreset: 'draft',
            renderWidth: 320,
            renderHeight: 180,
            surfaceModel: 'planar-2dgs',
            includeUnderside: true
        };

        const result = await service.reconstruct(options, (p, stage) => {
            progressLog.push(`[${(p * 100).toFixed(0)}%] ${stage}`);
        });

        expect(result).toBeDefined();
        expect(result.stationCount).toBe(4);
        expect(result.surfaceModel).toBe('planar-2dgs');
        expect(result.voxelSizeMeters).toBe(0.10);
        expect(result.metrics.spatialLockErrorPx).toBe(0.000);
        expect(result.metrics.unprojectionParityResidual).toBeLessThan(1e-6);

        // Check output files
        expect(fs.existsSync(result.splatPath)).toBe(true);
        expect(fs.existsSync(result.plyPath)).toBe(true);

        const splatStat = await fs.stat(result.splatPath);
        expect(splatStat.size).toBeGreaterThan(0);
        expect(splatStat.size % 32).toBe(0); // 32 bytes per Gaussian
        expect(result.splatCount).toBe(splatStat.size / 32);

        // Validate standard PLY header and content
        const plyText = await fs.readFile(result.plyPath, 'utf-8');
        expect(plyText.startsWith('ply\nformat ascii 1.0\n')).toBe(true);
        expect(plyText).toContain('element vertex');
        expect(plyText).toContain('property float x');
        expect(plyText).toContain('property float y');
        expect(plyText).toContain('property float z');
        expect(plyText).toContain('property float scale_0');
        expect(plyText).toContain('property float rot_0');
        expect(plyText).toContain('property float f_dc_0');
        expect(plyText).toContain('property float opacity');
        expect(plyText).toContain('end_header\n');

        expect(progressLog.length).toBeGreaterThan(5);
    }, 120000);

    it('verifies free-space ray clearance repels camera away from masonry walls', () => {
        // Construct a vertical wall at x = 10, y in [-5, 5], z in [-5, 5]
        const wallVerts: number[] = [];
        for (let y = -5; y <= 5; y += 1) {
            for (let z = -5; z <= 5; z += 1) {
                wallVerts.push(10.0, y, z);
            }
        }
        const centroid: [number, number, number] = [0, 0, 0];

        // Candidate station at x = 10.3 (only 0.3m from wall, requires min 1.50m clearance)
        const candidate: [number, number, number] = [10.3, 0.0, 0.0];
        const res = AdaptiveSurveyRigService.verifyStationClearance(wallVerts, candidate, centroid, 1.50);

        expect(res.valid).toBe(true);
        // Adjusted position should be repelled away from the wall (x > 10.3)
        expect(res.adjustedPos[0]).toBeGreaterThan(10.3);
        expect(res.minDistance).toBeGreaterThanOrEqual(1.05); // 0.70 * minClearance threshold
    });

    it('reconstructs with adaptive curvature dual-voxel fusion and emits hierarchical 3D Tiles', async () => {
        expect(fs.existsSync(GLB_PATH)).toBe(true);

        const outDirCurv = path.resolve(process.cwd(), 'build/test_calibrated_3dgs_recon_curv');
        await fs.emptyDir(outDirCurv);

        const options: Calibrated3DGSReconstructionOptions = {
            glbPath: GLB_PATH,
            outDir: outDirCurv,
            cameraBudget: 4,
            densityPreset: 'draft',
            renderWidth: 320,
            renderHeight: 180,
            surfaceModel: 'planar-2dgs',
            includeUnderside: true,
            adaptiveCurvature: true,
            enable3DTilesStreaming: true,
            octreeOptions: {
                maxDepth: 3,
                leafCapacity: 4096,
                interiorBudget: 2048,
                geometricErrorScale: 0.25
            }
        };

        const result = await service.reconstruct(options);

        expect(result).toBeDefined();
        expect(result.splatCount).toBeGreaterThan(0);
        expect(result.tilesetPath).toBeDefined();
        expect(fs.existsSync(result.tilesetPath!)).toBe(true);
        expect(result.tilesetResult).toBeDefined();
        expect(result.tilesetResult!.success).toBe(true);
        expect(result.tilesetResult!.tileCount).toBeGreaterThan(0);

        // Verify tileset.json structure
        const tilesetJson = await fs.readJson(result.tilesetPath!);
        expect(tilesetJson.asset).toBeDefined();
        expect(tilesetJson.asset.version).toBe('1.1');
        expect(tilesetJson.root).toBeDefined();
        expect(tilesetJson.root.boundingVolume).toBeDefined();

        await fs.remove(outDirCurv).catch(() => {});
    }, 180000);
});
