/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicalCameraModel } from '../src/common/optics/PhysicalCameraModel';
import { SENSOR_FORMAT_DIMENSIONS } from '../src/common/optics/physical-camera-protocol';
import { Google3DTileBlockoutPipelineService } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { physicalCameraHandlers } from '../src/node/gemini/tools/spatial-tools';

describe('PhysicalCameraModel (Analytical Optics & Sensor Mathematics)', () => {
    it('provides accurate industry sensor format dimensions', () => {
        const fullFrame = PhysicalCameraModel.getSensorDimensions('full_frame_35mm');
        expect(fullFrame.widthMm).toBe(36.0);
        expect(fullFrame.heightMm).toBe(24.0);
        expect(fullFrame.aspectRatio).toBeCloseTo(1.5, 3);
        expect(fullFrame.diagonalMm).toBeCloseTo(Math.sqrt(36 * 36 + 24 * 24), 3);

        const super35 = PhysicalCameraModel.getSensorDimensions('super_35');
        expect(super35.widthMm).toBe(24.89);
        expect(super35.heightMm).toBe(18.66);

        const imax = PhysicalCameraModel.getSensorDimensions('imax_70mm');
        expect(imax.widthMm).toBe(70.41);
        expect(imax.heightMm).toBe(52.63);

        // Custom sensor format
        const custom = PhysicalCameraModel.getSensorDimensions('custom', 40, 30);
        expect(custom.widthMm).toBe(40.0);
        expect(custom.heightMm).toBe(30.0);
        expect(custom.aspectRatio).toBeCloseTo(40 / 30, 3);
    });

    it('calculates FOV and focal length with exact physical trigonometry', () => {
        // FOV = 2 * arctan(sensorWidth / (2 * focalLength))
        // 50mm lens on 36mm sensor: 2 * arctan(36 / 100) = 2 * arctan(0.36) rad = 2 * 0.34563 = 0.69127 rad = 39.5977 deg
        const hFov = PhysicalCameraModel.calculateFov(50, 36);
        expect(hFov).toBeCloseTo(39.5977, 2);

        // Vertical FOV: 50mm lens on 24mm height: 2 * arctan(24 / 100) = 2 * arctan(0.24) = 27.0 deg
        const vFov = PhysicalCameraModel.calculateFov(50, 24);
        expect(vFov).toBeCloseTo(26.991, 2);

        // Inversion: calculate focal length back from FOV
        const invertedFocalLength = PhysicalCameraModel.calculateFocalLengthFromFov(hFov, 36);
        expect(invertedFocalLength).toBeCloseTo(50.0, 2);
    });

    it('computes complete optical frustum with anamorphic squeeze', () => {
        const sphericalFrustum = PhysicalCameraModel.calculateFrustum({
            sensorFormatPreset: 'full_frame_35mm',
            focalLengthMm: 50,
            apertureFStop: 2.8,
            anamorphicRatio: 1.0
        });

        expect(sphericalFrustum.horizontalFovDeg).toBeCloseTo(39.5977, 2);
        expect(sphericalFrustum.verticalFovDeg).toBeCloseTo(26.991, 2);
        expect(sphericalFrustum.aspectRatio).toBeCloseTo(1.5, 3);

        // 2x Anamorphic squeeze
        const anamorphicFrustum = PhysicalCameraModel.calculateFrustum({
            sensorFormatPreset: 'full_frame_35mm',
            focalLengthMm: 50,
            apertureFStop: 2.8,
            anamorphicRatio: 2.0
        });

        expect(anamorphicFrustum.verticalFovDeg).toBeCloseTo(26.991, 2);
        // Horizontal FOV should be significantly wider due to anamorphic de-squeeze
        expect(anamorphicFrustum.horizontalFovDeg).toBeGreaterThan(sphericalFrustum.horizontalFovDeg);
    });

    it('calculates Zeiss hyperfocal distance and near/far DoF boundaries', () => {
        const sensor = SENSOR_FORMAT_DIMENSIONS.full_frame_35mm;
        // 50mm lens at f/2.8
        const hyperfocal = PhysicalCameraModel.calculateHyperfocalDistance(50, 2.8, sensor.diagonalMm);
        // Hyperfocal distance should be approximately 30-32 meters
        expect(hyperfocal).toBeGreaterThan(25.0);
        expect(hyperfocal).toBeLessThan(35.0);

        // Subject at 3.0 meters (shallow depth of field)
        const shallowDof = PhysicalCameraModel.calculateDepthOfField(50, 2.8, 3.0, sensor.diagonalMm);
        expect(shallowDof.nearFocusLimitMeters).toBeLessThan(3.0);
        expect(shallowDof.farFocusLimitMeters).toBeGreaterThan(3.0);
        expect(shallowDof.isInfinitelyDeep).toBe(false);
        expect(shallowDof.dofThicknessMeters).toBeCloseTo(
            shallowDof.farFocusLimitMeters - shallowDof.nearFocusLimitMeters,
            3
        );

        // Subject at 40 meters (beyond hyperfocal) -> Far limit is Infinity
        const deepDof = PhysicalCameraModel.calculateDepthOfField(50, 2.8, 40.0, sensor.diagonalMm);
        expect(deepDof.isInfinitelyDeep).toBe(true);
        expect(deepDof.farFocusLimitMeters).toBe(Infinity);
    });

    it('calculates signed Circle of Confusion in sensor millimeters and viewport pixels', () => {
        const focusPlaneMeters = 5.0;
        const viewportHeightPx = 1080;

        // In-focus plane: blur diameter is 0
        const onPlane = PhysicalCameraModel.calculateCircleOfConfusion(
            50,
            2.8,
            focusPlaneMeters,
            focusPlaneMeters,
            viewportHeightPx
        );
        expect(onPlane.cocSensorMm).toBeCloseTo(0.0, 5);
        expect(onPlane.cocPixels).toBeCloseTo(0.0, 3);

        // Foreground (2.0m vs 5.0m focus): negative signed CoC
        const foreground = PhysicalCameraModel.calculateCircleOfConfusion(
            50,
            2.8,
            focusPlaneMeters,
            2.0,
            viewportHeightPx
        );
        expect(foreground.cocPixels).toBeLessThan(0);
        expect(Math.abs(foreground.cocPixels)).toBeGreaterThan(5.0);

        // Distant background (50.0m vs 5.0m focus): positive signed CoC
        const background = PhysicalCameraModel.calculateCircleOfConfusion(
            50,
            2.8,
            focusPlaneMeters,
            50.0,
            viewportHeightPx
        );
        expect(background.cocPixels).toBeGreaterThan(0);
    });

    it('performs exponential damping rack focus tracking towards target', () => {
        const camPos: [number, number, number] = [0, 10, 50];
        const targetPos: [number, number, number] = [0, 0, 0];
        const targetDistance = Math.sqrt(10 * 10 + 50 * 50); // ~50.99 meters

        // Initially focused at 5 meters
        let currentFocus = 5.0;
        const dt = 1.0 / 24.0; // 24 fps
        const lambda = 8.0;

        // Track focus across 12 frames (0.5s)
        for (let i = 0; i < 12; i++) {
            const state = PhysicalCameraModel.updateDynamicFocusTracking(
                camPos,
                targetPos,
                currentFocus,
                dt,
                lambda
            );
            expect(state.currentFocusDistanceMeters).toBeGreaterThan(currentFocus);
            expect(state.currentFocusDistanceMeters).toBeLessThanOrEqual(targetDistance);
            currentFocus = state.currentFocusDistanceMeters;
        }

        // After 12 frames of exponential damping, should be significantly closer to target distance
        expect(currentFocus).toBeGreaterThan(45.0);
    });

    it('synchronizes physical camera settings directly to THREE.PerspectiveCamera', () => {
        const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
        const config = {
            sensorFormatPreset: 'full_frame_35mm' as const,
            focalLengthMm: 85, // 85mm portrait / architectural telephoto
            apertureFStop: 1.4,
            focusDistanceMeters: 4.2
        };

        PhysicalCameraModel.applyToPerspectiveCamera(camera, config, 16 / 9);

        // Vertical FOV of 85mm on 24mm sensor height: 2 * arctan(24 / 170) = 16.09°
        expect(camera.fov).toBeCloseTo(16.09, 1);
        expect(camera.filmGauge).toBe(36.0);
        expect(camera.focus).toBe(4.2);
        expect(camera.userData.physicalCamera).toBeDefined();
        expect(camera.userData.physicalCamera.focalLengthMm).toBe(85);
    });
});

describe('Google3DTileBlockoutPipelineService Trajectory Integration', () => {
    it('populates optical and depth of field metadata on every frame', () => {
        const service = new Google3DTileBlockoutPipelineService();
        const anchor = { lat: 40.7484, lng: -73.9857, landmarkName: 'Empire State Building' };

        const trajectory = service.createDefaultTrajectory(anchor, {
            fps: 24,
            durationSec: 1.0,
            physicalCamera: {
                focalLengthMm: 50,
                apertureFStop: 2.8,
                sensorFormatPreset: 'full_frame_35mm'
            }
        });

        expect(trajectory.frames.length).toBe(24);
        const firstFrame = trajectory.frames[0];
        expect(firstFrame.focalLengthMm).toBe(50);
        expect(firstFrame.apertureFStop).toBe(2.8);
        expect(firstFrame.sensorFormat).toBe('full_frame_35mm');
        expect(firstFrame.focusDistanceMeters).toBeGreaterThan(0);
        expect(firstFrame.depthOfFieldNearMeters).toBeDefined();
        expect(firstFrame.depthOfFieldFarMeters).toBeDefined();
        expect(firstFrame.depthOfFieldNearMeters!).toBeLessThan(firstFrame.focusDistanceMeters!);
    });
});

describe('Gemini Physical Camera Agent Tools', () => {
    it('executes configure_physical_camera tool successfully', async () => {
        const result = await physicalCameraHandlers.configure_physical_camera({
            focalLengthMm: 35,
            apertureFStop: 1.8,
            sensorFormat: 'full_frame_35mm',
            focusDistanceMeters: 2.5
        });

        expect(result.summaryResult).toContain('35mm');
        expect(result.summaryResult).toContain('f/1.8');
        expect(result.summaryResult).toContain('Vertical FOV');
        const payload = result.resultPayload as any;
        expect(payload.frustum.verticalFovDeg).toBeGreaterThan(30);
        expect(payload.depthOfField.nearFocusLimitMeters).toBeLessThan(2.5);
    });

    it('executes camera_track_focus_target tool with rack focus smoothing', async () => {
        const result = await physicalCameraHandlers.camera_track_focus_target({
            cameraPosition: [0, 50, 100],
            targetPosition: [0, 0, 0],
            currentFocusDistanceMeters: 20.0,
            deltaTimeSec: 0.1,
            focalLengthMm: 50,
            apertureFStop: 2.8
        });

        expect(result.summaryResult).toContain('Tracked focus target');
        const payload = result.resultPayload as any;
        expect(payload.evaluatedDistanceMeters).toBeCloseTo(Math.sqrt(50 * 50 + 100 * 100), 2);
        expect(payload.smoothedFocusDistanceMeters).toBeGreaterThan(20.0);
        expect(payload.smoothedFocusDistanceMeters).toBeLessThan(payload.evaluatedDistanceMeters);
    });
});
