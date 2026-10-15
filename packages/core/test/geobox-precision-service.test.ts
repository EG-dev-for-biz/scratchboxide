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
import { MissingInputError } from '../src/common/errors/pipeline-errors';

/**
 * A surveyed reference pose passed explicitly. Resolution never looks fixtures up by name: words in the
 * prompt hint (e.g. "Colosseum") do not select a fixture or a place.
 */
function fixturePose(key: keyof typeof KNOWN_RESECTION_LANDMARKS): GeoBoxResectionRequest {
    const f = KNOWN_RESECTION_LANDMARKS[key];
    return {
        targetLandmarkName: f.name,
        targetCoords: { lat: f.targetCoords.lat, lng: f.targetCoords.lng, alt: f.groundElevation },
        cameraOpticalCenter: { lat: f.vantageCoords.lat, lng: f.vantageCoords.lng, alt: f.vantageCoords.altitudeMeters },
        headingDeg: f.headingDeg,
        pitchDeg: f.pitchDeg,
        glbPath: f.glbPath
    };
}

describe('GeoBoxPrecisionResectionService API', () => {
    const service = new GeoBoxPrecisionResectionService();

    it('resects 6-DOF camera pose and geodetic optical center for Colosseum Rome', async () => {
        const request: GeoBoxResectionRequest = {
            ...fixturePose('colosseum'),
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

        // Frustum & Google 3D Tiles validation: the FOV is the 26 mm lens's on a 36 mm sensor, not a constant 57°
        expect(result.frustum.horizontalFovDeg).toBeCloseTo(69.39, 1);
        expect(result.frustum.reachMeters).toBe(350.0);
        expect(result.frustum.polygonCoords.length).toBeGreaterThanOrEqual(3);
        expect(result.googleMapTiles3DConfig.camera_position.lat).toBeCloseTo(41.8908, 3);
        expect(result.googleMapTiles3DConfig.fov).toBeCloseTo(69.39, 1);

        // Typical Brown-Conrady coefficients for the lens, labelled as such
        expect(result.lensDistortion.k1).toBe(-0.038);
        expect(result.lensDistortion.k2).toBe(0.008);
        expect(result.lensDistortion.chromaticAberration).toBe(0.0003);
        expect(result.lensDistortionSource).toMatch(/not measured from the image/);

        // Nothing it did not compute: no edge-overlap certification and no match score
        expect(result.imageAnalysed).toBe(false);
        expect((result as any).edgeAlignment).toBeUndefined();
        expect(result.googleMapTiles3DConfig.match_confidence).toBeUndefined();
        expect(result.googleMapTiles3DConfig.photometric_match_score).toBeUndefined();
        expect(result.poseSource).toMatch(/stated camera position \(cameraOpticalCenter\), stated heading, stated pitch/);
        expect(result.landmark.resolvedFrom).toBe('targetCoords');
        expect((result.landmark as any).confidence).toBeUndefined();
        expect(result.glbPath).toContain('colosseum_rome_textured.glb');
    });

    it('resects camera pose for Eiffel Tower Paris when prompted', async () => {
        const result = await service.resectCameraPose({
            ...fixturePose('eiffel'),
            promptHint: 'Looking up at Eiffel Tower Champ de Mars',
            optimizeTo100Percent: true
        });

        expect(result.success).toBe(true);
        expect(result.landmark.name).toContain('Eiffel Tower');
        expect(result.cameraOpticalCenter.lat).toBeCloseTo(48.8571, 3);
        expect(result.cameraAttitude.headingDeg).toBe(332.0);
        expect(result.cameraAttitude.pitchDeg).toBe(18.0);
        expect(result.imageAnalysed).toBe(false);
    });

    it('calculates Brown-Conrady lens distortion for telephoto vs wide-angle', () => {
        const wide = service.calculateLensDistortion(24.0);
        const tele = service.calculateLensDistortion(50.0);

        expect(wide.k1).toBe(-0.038);
        expect(tele.k1).toBe(-0.012);
        expect(wide.k2).toBeGreaterThan(tele.k2);
    });

    it('measures edge overlap of two fixed images at a stated pose, and does not claim a refinement', async () => {
        const width = 32;
        const height = 32;
        const query = new Float32Array(width * height);
        const render = new Float32Array(width * height);
        for (let y = 10; y < 22; y++) {
            for (let x = 10; x < 22; x++) {
                query[y * width + x] = 1.0;
                render[y * width + x + 3] = 1.0; // the render is 3 px off
            }
        }
        const pose = { position: [0, 0, 50] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45 };
        const optResult = await service.optimizeEdgeAlignment({ queryGrayscale: query, renderGrayscale: render, width, height, initialPose: pose });
        expect(optResult.initialOverlapScorePct).toBe(optResult.finalOverlapScorePct); // measured, not a constant 98.4
        expect(optResult.finalOverlapScorePct).toBeLessThan(100);
        expect(optResult.converged).toBe(false);
        expect(optResult.iterations).toBe(0);
        expect(optResult.optimizedPose).toEqual(pose);
        await expect(service.optimizeEdgeAlignment({ queryGrayscale: query, renderGrayscale: render, width, height })).rejects.toThrow(MissingInputError);
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
        expect(result.poseSource).toBe('stated heading, stated pitch and stated standoff distance');
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
            imageWidthPx: 1920,
            imageHeightPx: 1080,
            sensorFocalMm: 26.0,
            optimizeTo100Percent: true
        });

        expect(result.success).toBe(true);
        expect(result.cameraOpticalCenter.standoffDistanceMeters).toBeCloseTo(50.0, 1);
        expect(result.poseSource).toMatch(/^solvePnP from 5 point correspondences/);

        // The principal point comes from the image size: without it nothing is assumed.
        await expect(service.resectCameraPose({ targetCoords: { lat: 34.0522, lng: -118.2437, alt: 75.0 }, points2D, points3D }))
            .rejects.toThrow(/imageWidthPx and imageHeightPx/);
    });

    it('enforces Zero Presets by throwing actionable error when no coordinates or query are provided', async () => {
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({}))
            .rejects
            .toThrow(MissingInputError);
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({}))
            .rejects
            .toThrow(/targetCoords, targetLandmarkName or promptHint/);
    });

    it('never picks a surveyed fixture from words in the prompt hint; without a Maps key the place lookup fails', async () => {
        const saved = { g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
        delete process.env.GOOGLE_MAPS_API_KEY;
        delete process.env.MAP_TILES_API_KEY;
        try {
            // "plaza" used to select The Plaza Hotel NYC for any query containing it (e.g. Plaza Mayor, Madrid).
            await expect(service.resectCameraPose({ promptHint: 'Plaza Mayor, Madrid at dusk' })).rejects.toThrow(/Could not resolve location "Plaza Mayor, Madrid at dusk"/);
        } finally {
            if (saved.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.g;
            if (saved.m !== undefined) process.env.MAP_TILES_API_KEY = saved.m;
        }
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
                ...fixturePose('colosseum'),
                imagePath: 'public/images/colosseum_western_promenade.jpg',
                promptHint: 'Colosseum Rome western promenade',
                optimizeTo100Percent: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        expect(outcome.exec.summaryResult).toContain('Camera pose for Colosseum');
        expect(outcome.exec.summaryResult).toContain("The photo's pixels were not analysed and no edge alignment was run.");
        expect(outcome.exec.summaryResult).not.toMatch(/edge overlap|Millimeter|mm tolerance/);
        expect((outcome.resultPayload as any).success).toBe(true);
        expect((outcome.resultPayload as any).edgeAlignment).toBeUndefined();
    });

    it('geobox_optimize_edge_alignment needs the model and starting pose: it no longer aligns two synthetic squares', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'geobox_optimize_edge_alignment',
            {
                imagePath: 'public/images/colosseum_western_promenade.jpg',
                maxIterations: 15
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('failed');
        expect(String((outcome.resultPayload as any).error)).toContain('needs glbPath');
    });

    it('refuses to invent a camera pose when only the target location is known', async () => {
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({
            imagePath: 'unknown.jpg',
            targetCoords: { lat: 35.6586, lng: 139.7454, alt: 40.0 }
        })).rejects.toThrow(/only the target location is known/);
    });

    it('a heading alone does not place the camera: no 100 m standoff or 5° pitch is assumed, and a nonexistent photo gets no certificate', async () => {
        // This used to "resect" /definitely/not/a/real/photo.jpg to 100% edge overlap at 0.00 mm.
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({
            imagePath: '/definitely/not/a/real/photo.jpg',
            targetCoords: { lat: 40.7411, lng: -73.9897, alt: 12 },
            targetLandmarkName: 'Flatiron Building',
            headingDeg: 90
        })).rejects.toThrow(MissingInputError);
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({
            targetCoords: { lat: 40.7411, lng: -73.9897, alt: 12 },
            headingDeg: 90,
            pitchDeg: 5
        })).rejects.toThrow(/standoffDistanceMeters/);
        // A camera position without its altitude: no "eye height" of ground + 2 m.
        await expect(new GeoBoxPrecisionResectionService().resectCameraPose({
            targetCoords: { lat: 40.7411, lng: -73.9897, alt: 12 },
            knownCoords: { lat: 40.7405, lng: -73.9900 }
        })).rejects.toThrow(/knownCoords\.alt/);
    });

    it('places the camera from a supplied heading when no other pose evidence exists', async () => {
        const result = await new GeoBoxPrecisionResectionService().resectCameraPose({
            imagePath: 'unknown.jpg',
            targetCoords: { lat: 35.6586, lng: 139.7454, alt: 40.0 },
            headingDeg: 90,
            pitchDeg: 0,
            standoffDistanceMeters: 100
        });
        expect(result.cameraAttitude.headingDeg).toBe(90);
        // Looking east means the camera sits west of the target.
        expect(result.cameraOpticalCenter.lng).toBeLessThan(139.7454);
        expect(result.cameraOpticalCenter.lat).toBeCloseTo(35.6586, 4);
    });

    it('a stated pitch places the camera on the ray it looks along: looking down puts it above the target', async () => {
        const target = { lat: 40.7411, lng: -73.9897, alt: 20 };
        // Pitch is degrees above the horizon: -30 looks down, so the camera is 100 m back along the ray and 50 m up.
        const down = await new GeoBoxPrecisionResectionService().resectCameraPose({ targetCoords: target, headingDeg: 0, pitchDeg: -30, standoffDistanceMeters: 100 });
        expect(down.cameraOpticalCenter.elevationMslMeters).toBeCloseTo(70, 1);
        expect(down.cameraOpticalCenter.lat).toBeLessThan(target.lat); // heading north: the camera is south of the target
        expect(down.cameraAttitude.pitchDeg).toBe(-30);
        expect(down.googleMapTiles3DConfig.tilt).toBe(60);
        // +18 looks up: the camera is below the target, and the tilt is above the horizon (not the same as -18).
        const up = await new GeoBoxPrecisionResectionService().resectCameraPose({ targetCoords: target, headingDeg: 0, pitchDeg: 18, standoffDistanceMeters: 100 });
        expect(up.cameraOpticalCenter.elevationMslMeters).toBeCloseTo(20 - 100 * Math.sin(18 * Math.PI / 180), 1);
        expect(up.googleMapTiles3DConfig.tilt).toBe(108);
        // The reported pitch matches the computed camera-to-target ray.
        for (const r of [down, up]) {
            const rise = target.alt - r.cameraOpticalCenter.elevationMslMeters;
            expect(Math.asin(rise / r.cameraOpticalCenter.standoffDistanceMeters) * 180 / Math.PI).toBeCloseTo(r.cameraAttitude.pitchDeg, 3);
        }
    });

    it('a camera position alone is not a target: knownCoords needs what the photo shows, like cameraOpticalCenter', async () => {
        // knownCoords used to make the ground under the camera the target and report a straight-down pitch.
        for (const camera of [{ knownCoords: { lat: 40.7411, lng: -73.9897, alt: 60 } }, { cameraOpticalCenter: { lat: 40.7411, lng: -73.9897, alt: 60 } }]) {
            const request = { ...camera, headingDeg: 90 };
            await expect(new GeoBoxPrecisionResectionService().resectCameraPose(request)).rejects.toThrow(MissingInputError);
            await expect(new GeoBoxPrecisionResectionService().resectCameraPose(request)).rejects.toThrow(/only the camera position was given/);
        }
        // With a stated target the camera position is used and the pitch is toward that target.
        const result = await new GeoBoxPrecisionResectionService().resectCameraPose({
            knownCoords: { lat: 40.7405, lng: -73.9900, alt: 60 },
            targetCoords: { lat: 40.7411, lng: -73.9897, alt: 12 }
        });
        expect(result.landmark.resolvedFrom).toBe('targetCoords');
        expect(result.cameraAttitude.pitchDeg).toBeLessThan(0);
        expect(result.cameraAttitude.pitchDeg).toBeGreaterThan(-60);
        expect(result.poseSource).toBe('stated camera position (knownCoords), heading toward the target, pitch toward the target');
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
            'Closed-Loop Edge Alignment (SubPixelEdgeAlignmentOptimizer: refines a camera pose against a given photo and model, reports the edge correlation it measured)'
        );
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain(
            'GeoBoxPrecisionResectionService'
        );
    });
});
