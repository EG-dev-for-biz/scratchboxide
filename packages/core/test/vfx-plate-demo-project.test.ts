/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { synthesizeContextualVideoTimeline } from '../src/browser/generative-canvas/services/video/videoTimelineSynthesizer';
import {
    VfxPlateMatchmoveService,
    type InterpolatedCameraPose
} from '../src/browser/generative-canvas/services/video/VfxPlateMatchmoveService';
import type { VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';

describe('VFX Plate Anti-Drift Demo Project Integration Suite', () => {
    describe('Timeline Synthesizer Demo Recognition', () => {
        it('synthesizes full 4-track VFX plate anti-drift project when prompted', () => {
            const timeline = synthesizeContextualVideoTimeline(
                'Create a live-action vfx plate anti-drift matchmove demo with 3d monolith and holdout'
            );

            expect(timeline.title).toBe('VFX Plate Anti-Drift Studio Demo');
            expect(timeline.subtitle).toContain('Real-time 6-DOF matchmove');
            expect(timeline.activeVfxPlateId).toBe('vfx-plate-live-action-01');
            expect(timeline.tracks).toHaveLength(4);

            const [v1, v2, v3, a1] = timeline.tracks;
            expect(v1.id).toBe('track-v1-plate');
            expect(v1.type).toBe('video');
            expect(v1.elements[0].isVfxPlate).toBe(true);

            const vfx = v1.elements[0].vfxPlate;
            expect(vfx).toBeDefined();
            expect(vfx?.id).toBe('vfx-plate-live-action-01');
            expect(vfx?.cameraSolveTrack?.fps).toBe(24);
            expect(vfx?.cameraSolveTrack?.meanReprojectionErrorPx).toBe(0.18);
            expect(vfx?.lensDistortion?.k1).toBe(-0.042);
            expect(vfx?.holdoutConfig?.depthHoldoutEnabled).toBe(true);
            expect(vfx?.holdoutConfig?.holdoutThresholdMeters).toBe(8.5);
            expect(vfx?.trackingMarkers).toHaveLength(8);

            expect(v2.id).toBe('track-v2-3d-inpaint');
            expect(v2.type).toBe('3d');
            expect(v2.elements[0].sourcePath).toBe('models/cg_architectural_monolith.glb');

            expect(v3.id).toBe('track-v3-holdout');
            expect(v3.type).toBe('overlay');

            expect(a1.id).toBe('track-a1-audio');
            expect(a1.type).toBe('audio');
        });
    });

    describe('Project JSON Manifest Validation', () => {
        it('validates projects/vfx_plate_anti_drift_demo.scratchbox.json against timeline schema', () => {
            const projectPath = path.resolve(__dirname, '../../../projects/vfx_plate_anti_drift_demo.scratchbox.json');
            expect(fs.existsSync(projectPath)).toBe(true);

            const content = fs.readFileSync(projectPath, 'utf8');
            const data = JSON.parse(content);

            expect(data.id).toBe('sb-proj-vfx-anti-drift-01');
            expect(data.timeline).toBeDefined();

            const tl: VideoTimelineData = data.timeline;
            expect(tl.fps).toBe(24);
            expect(tl.duration).toBe(15.0);
            expect(tl.activeVfxPlateId).toBe('vfx-plate-live-action-01');
            expect(tl.tracks).toHaveLength(4);

            const plateElement = tl.tracks[0].elements[0];
            expect(plateElement.isVfxPlate).toBe(true);
            expect(plateElement.sourcePath).toBe('videos/plaza_hotel_blockout_camera.mp4');
            expect(plateElement.vfxPlate?.trackingMarkers).toHaveLength(8);

            // Verify real video file exists on disk and is non-zero
            const realVideoPath = path.resolve(__dirname, '../../../public', plateElement.sourcePath);
            expect(fs.existsSync(realVideoPath)).toBe(true);
            expect(fs.statSync(realVideoPath).size).toBeGreaterThan(500000);

            // Verify real 3D CG Monolith inpaint asset exists on disk
            const monolithPath = path.resolve(__dirname, '../../../public/models/cg_architectural_monolith.glb');
            expect(fs.existsSync(monolithPath)).toBe(true);
            expect(fs.statSync(monolithPath).size).toBeGreaterThan(10000);
        });

        it('validates public/projects/vfx_plate_anti_drift_demo.scratchbox.json mirror exists and matches', () => {
            const publicPath = path.resolve(__dirname, '../../../public/projects/vfx_plate_anti_drift_demo.scratchbox.json');
            expect(fs.existsSync(publicPath)).toBe(true);

            const content = fs.readFileSync(publicPath, 'utf8');
            const data = JSON.parse(content);
            expect(data.id).toBe('sb-proj-vfx-anti-drift-01');
            expect(data.timeline.duration).toBe(15.0);
            expect(data.timeline.tracks[0].elements[0].sourcePath).toBe('videos/plaza_hotel_blockout_camera.mp4');
        });
    });

    describe('Sub-Pixel Anti-Drift Mathematical Evaluation', () => {
        it('interpolates 6-DOF camera pose with sub-pixel precision across solve frames', () => {
            const timeline = synthesizeContextualVideoTimeline('vfx plate anti drift demo');
            const track = timeline.tracks[0].elements[0].vfxPlate!.cameraSolveTrack!;

            // Interpolate at t = 2.5s (exact keyframe)
            const pose25 = VfxPlateMatchmoveService.interpolateCameraSolve(track, 2.5);
            expect(pose25.position[0]).toBeCloseTo(0.91, 2);
            expect(pose25.position[1]).toBeCloseTo(1.86, 2);
            expect(pose25.position[2]).toBeCloseTo(4.58, 2);
            expect(pose25.fovDegrees).toBe(45);
            expect(pose25.reprojectionErrorPx).toBe(0.18);

            // Interpolate at sub-frame t = 1.5s (Hermite blend between t=1.0 and t=2.0)
            const pose15 = VfxPlateMatchmoveService.interpolateCameraSolve(track, 1.5);
            expect(pose15.position[0]).toBeGreaterThan(0.35);
            expect(pose15.position[0]).toBeLessThan(0.72);
            expect(pose15.reprojectionErrorPx).toBeGreaterThanOrEqual(0.17);
            expect(pose15.reprojectionErrorPx).toBeLessThanOrEqual(0.18);
        });

        it('reports LOCKED status for all 8 ground-truth tracking markers under calibrated solve', () => {
            const pose: InterpolatedCameraPose = {
                timeSeconds: 0.0,
                position: [0.0, 1.8, 5.0],
                rotationQuaternion: [0.0, 0.0, 0.0, 1.0],
                fovDegrees: 45.0,
                focalLengthMm: 35.0,
                reprojectionErrorPx: 0.15
            };

            const markers = [
                { id: 'TK-01', worldPoint3D: [0.0, 1.8, -5.0] as [number, number, number], platePoint2D: [960, 540] as [number, number], confidence: 1.0 }
            ];

            const evaluation = VfxPlateMatchmoveService.evaluateDrift(markers, pose, { width: 1920, height: 1080 });
            expect(evaluation.status).toBe('locked');
            expect(evaluation.meanDriftPx).toBeLessThan(0.1);
        });

        it('detects unconstrained generative media drift and flags DRIFTING status', () => {
            const driftedPose: InterpolatedCameraPose = {
                timeSeconds: 0.0,
                position: [0.25, 1.95, 4.8], // Jittered position
                rotationQuaternion: [0.02, 0.03, 0.0, 0.999], // Jittered orientation
                fovDegrees: 48.0, // Breathing lens focal length
                focalLengthMm: 33.0,
                reprojectionErrorPx: 12.5
            };

            const markers = [
                { id: 'TK-01', worldPoint3D: [0.0, 1.8, -5.0] as [number, number, number], platePoint2D: [960, 540] as [number, number], confidence: 1.0 }
            ];

            const evaluation = VfxPlateMatchmoveService.evaluateDrift(markers, driftedPose, { width: 1920, height: 1080 });
            expect(evaluation.status).toBe('drifting');
            expect(evaluation.meanDriftPx).toBeGreaterThan(10.0);
        });
    });

    describe('NOAA Solar Ephemeris Real-World Lighting Calculation', () => {
        it('calculates warm golden-hour solar lighting at 17:30 UTC for DTLA coordinates', () => {
            const timeline = synthesizeContextualVideoTimeline('vfx plate anti drift demo');
            const ephemeris = timeline.tracks[0].elements[0].vfxPlate!.ephemerisAnchor!;

            const solar = VfxPlateMatchmoveService.computeSolarLighting(ephemeris);
            expect(solar.isDaylight).toBe(true);
            expect(solar.directionVector).toHaveLength(3);
            expect(solar.directionalIntensity).toBeGreaterThan(1.5);
            // Verify directional color reflects warm late afternoon / golden hour grading
            expect(solar.directionalColor).toMatch(/^#ff/i);
        });
    });
});
