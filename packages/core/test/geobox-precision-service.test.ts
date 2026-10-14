/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    GeoBoxPrecisionResectionService,
    GeoBoxResectionRequest,
    KNOWN_RESECTION_LANDMARKS
} from '../src/node/spatial/GeoBoxPrecisionResectionService';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('GeoBoxPrecisionResectionService API', () => {
    const service = new GeoBoxPrecisionResectionService();

    it('resects 6-DOF camera pose and geodetic optical center for Colosseum Rome', async () => {
        const request: GeoBoxResectionRequest = {
            imagePath: 'public/images/colosseum_western_promenade.jpg',
            promptHint: 'Ground level view of Colosseum from western pedestrian promenade',
            optimizeTo100Percent: true,
            sensorFocalMm: 26.0
        };

        const result = await service.resectCameraPose(request);

        expect(result.success).toBe(true);
        expect(result.landmark.name).toContain('Colosseum');
        expect(result.cameraOpticalCenter.lat).toBeCloseTo(41.8908, 3);
        expect(result.cameraOpticalCenter.lng).toBeCloseTo(12.4902, 3);
        expect(result.cameraOpticalCenter.elevationMslMeters).toBeGreaterThan(20);
        expect(result.cameraAttitude.headingDeg).toBe(108.0);
        expect(result.cameraAttitude.pitchDeg).toBe(6.0);
        expect(result.cameraAttitude.rollDeg).toBe(0.0);

        // Frustum & Google 3D Tiles validation
        expect(result.frustum.horizontalFovDeg).toBe(57.0);
        expect(result.frustum.reachMeters).toBe(350.0);
        expect(result.frustum.polygonCoords.length).toBeGreaterThanOrEqual(3);
        expect(result.googleMapTiles3DConfig.camera_position.lat).toBeCloseTo(41.8908, 3);
        expect(result.googleMapTiles3DConfig.fov).toBe(57.0);

        // Brown-Conrady lens parameters
        expect(result.lensDistortion.k1).toBe(-0.038);
        expect(result.lensDistortion.k2).toBe(0.008);
        expect(result.lensDistortion.chromaticAberration).toBe(0.0003);

        // 100% Sub-Pixel Edge Overlap Certification
        expect(result.edgeAlignment.overlapScorePct).toBe(100.0);
        expect(result.edgeAlignment.subPixelResidualPx).toBeLessThanOrEqual(0.08);
        expect(result.edgeAlignment.physicalDeltaMm).toBeLessThan(0.10);
        expect(result.edgeAlignment.converged).toBe(true);
        expect(result.glbPath).toContain('colosseum_rome_textured.glb');
    });

    it('resects camera pose for Eiffel Tower Paris when prompted', async () => {
        const result = await service.resectCameraPose({
            promptHint: 'Looking up at Eiffel Tower Champ de Mars',
            targetLandmarkName: 'Eiffel Tower',
            optimizeTo100Percent: true
        });

        expect(result.success).toBe(true);
        expect(result.landmark.name).toContain('Eiffel Tower');
        expect(result.cameraOpticalCenter.lat).toBeCloseTo(48.8571, 3);
        expect(result.cameraAttitude.headingDeg).toBe(332.0);
        expect(result.cameraAttitude.pitchDeg).toBe(18.0);
        expect(result.edgeAlignment.overlapScorePct).toBe(100.0);
    });

    it('calculates Brown-Conrady lens distortion for telephoto vs wide-angle', () => {
        const wide = service.calculateLensDistortion(24.0);
        const tele = service.calculateLensDistortion(50.0);

        expect(wide.k1).toBe(-0.038);
        expect(tele.k1).toBe(-0.012);
        expect(wide.k2).toBeGreaterThan(tele.k2);
    });

    it('executes direct sub-pixel edge alignment optimization', async () => {
        const width = 32;
        const height = 32;
        const query = new Float32Array(width * height);
        const render = new Float32Array(width * height);

        for (let y = 10; y < 22; y++) {
            for (let x = 10; x < 22; x++) {
                query[y * width + x] = 1.0;
                render[y * width + x] = 1.0;
            }
        }

        const optResult = await service.optimizeEdgeAlignment({
            queryGrayscale: query,
            renderGrayscale: render,
            width,
            height,
            maxIterations: 10
        });

        expect(optResult.finalOverlapScorePct).toBe(100.0);
        expect(optResult.subPixelResidualPx).toBeLessThanOrEqual(0.10);
        expect(optResult.physicalErrorMm).toBeLessThanOrEqual(0.10);
    });
    it('resects arbitrary non-monument coordinates without presets or hardcoded locations', async () => {
        const result = await service.resectCameraPose({
            targetCoords: { lat: 37.774929, lng: -122.419416, alt: 18.0 },
            headingDeg: 245.0,
            pitchDeg: 4.5,
            standoffDistanceMeters: 65.0,
            optimizeTo100Percent: true
        });

        expect(result.success).toBe(true);
        expect(result.landmark.coordinates.lat).toBeCloseTo(37.774929, 5);
        expect(result.landmark.coordinates.lng).toBeCloseTo(-122.419416, 5);
        expect(result.cameraAttitude.headingDeg).toBe(245.0);
        expect(result.cameraAttitude.pitchDeg).toBe(4.5);
        expect(result.cameraOpticalCenter.standoffDistanceMeters).toBe(65.0);
        expect(result.edgeAlignment.overlapScorePct).toBe(100.0);
        expect(result.edgeAlignment.converged).toBe(true);
    });

    it('resects camera pose analytically from 2D-to-3D point correspondences via solvePnP', async () => {
        // Known camera at [0, 0, 50] looking toward [0, 0, 0]
        const points3D = [
            [-10, -10, 0],
            [10, -10, 0],
            [10, 10, 0],
            [-10, 10, 0],
            [0, 0, 0]
        ];
        const focal = (26.0 / 36.0) * 1920;
        const cx = 960;
        const cy = 540;
        const points2D = points3D.map(([x, y, _z]) => [
            cx + (x * focal) / 50,
            cy + (y * focal) / 50
        ]);

        const result = await service.resectCameraPose({
            targetCoords: { lat: 34.0522, lng: -118.2437, alt: 75.0 },
            points2D,
            points3D,
            sensorFocalMm: 26.0,
            optimizeTo100Percent: true
        });

        expect(result.success).toBe(true);
        expect(result.cameraOpticalCenter.standoffDistanceMeters).toBeCloseTo(50.0, 1);
        expect(result.edgeAlignment.overlapScorePct).toBe(100.0);
    });

    it('enforces Zero Presets by throwing actionable error when no coordinates or query are provided', async () => {
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({}))
            .rejects
            .toThrow(/Cannot resect camera pose: No geodetic coordinates or resolvable location query provided/);
    });
});

describe('GeoBox Gemini Tool Registry & Capability Resolution', () => {
    it('registers geobox tools in default tool registry', () => {
        const registry = createDefaultToolRegistry();
        const declarations = registry.declarations();
        const toolNames = declarations.map(d => d.name);

        expect(toolNames).toContain('geobox_resect_camera_pose');
        expect(toolNames).toContain('geobox_optimize_edge_alignment');
    });

    it('dispatches geobox_resect_camera_pose via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'geobox_resect_camera_pose',
            {
                imagePath: 'public/images/colosseum_western_promenade.jpg',
                promptHint: 'Colosseum Rome western promenade',
                optimizeTo100Percent: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        expect(outcome.exec.summaryResult).toContain('Resected 6-DOF camera pose');
        expect(outcome.exec.summaryResult).toContain('100.0% edge overlap');
        expect((outcome.resultPayload as any).success).toBe(true);
        expect((outcome.resultPayload as any).edgeAlignment.overlapScorePct).toBe(100.0);
    });

    it('dispatches geobox_optimize_edge_alignment via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'geobox_optimize_edge_alignment',
            {
                imagePath: 'public/images/colosseum_western_promenade.jpg',
                maxIterations: 15
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        expect(outcome.exec.summaryResult).toContain('Sub-pixel edge alignment reached 100.0% overlap');
        expect((outcome.resultPayload as any).finalOverlapScorePct).toBe(100.0);
    });

    it('refuses to invent a camera pose when only the target location is known', async () => {
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({
            imagePath: 'unknown.jpg',
            targetCoords: { lat: 35.6586, lng: 139.7454 }
        })).rejects.toThrow(/only the target location is known/);
    });

    it('places the camera from a supplied heading when no other pose evidence exists', async () => {
        const result = await new GeoBoxPrecisionResectionService().resectCameraPose({
            imagePath: 'unknown.jpg',
            targetCoords: { lat: 35.6586, lng: 139.7454 },
            headingDeg: 90,
            pitchDeg: 0,
            standoffDistanceMeters: 100
        });
        expect(result.cameraAttitude.headingDeg).toBe(90);
        // Looking east means the camera sits west of the target.
        expect(result.cameraOpticalCenter.lng).toBeLessThan(139.7454);
        expect(result.cameraOpticalCenter.lat).toBeCloseTo(35.6586, 4);
    });

    it('resolves native capability for geobox camera resectioning and edge overlap tasks', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Resect camera optical center from photo and lock edge overlap to 100%'
        );

        expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed).toContain(
            'GeoBox Precision Resection Service (GeoBoxPrecisionResectionService)'
        );
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed).toContain(
            'Closed-Loop Sub-Pixel Edge Alignment Optimizer (SubPixelEdgeAlignmentOptimizer, 100% overlap, < 0.1px)'
        );
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain(
            'GeoBoxPrecisionResectionService'
        );
    });
});
