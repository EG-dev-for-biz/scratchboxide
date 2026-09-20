/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    VfxPlateMatchmoveService,
    type InterpolatedCameraPose
} from '../src/browser/generative-canvas/services/video/VfxPlateMatchmoveService';
import { Video3DLayerRenderer } from '../src/browser/generative-canvas/services/video/Video3DLayerRenderer';
import type {
    CameraSolveTrack,
    CameraSolveFrame,
    GeodeticEphemerisAnchor,
    TrackingMarker2D3D,
    TimelineElement
} from '../src/browser/generative-canvas/services/video/videoTypes';

function createMockRenderer(): THREE.WebGLRenderer {
    return {
        setSize: () => {},
        getRenderTarget: () => null,
        setRenderTarget: () => {},
        setClearColor: () => {},
        clear: () => {},
        render: () => {},
        dispose: () => {}
    } as unknown as THREE.WebGLRenderer;
}

describe('VfxPlateMatchmoveService - Anti-Drift Math & Sub-Frame Solving', () => {
    describe('Sub-frame Camera Solve Interpolation', () => {
        it('handles empty frames array safely', () => {
            const track: CameraSolveTrack = {
                id: 'track-0',
                fps: 24,
                totalFrames: 0,
                coordinateSystem: 'threejs',
                sensorWidthMm: 36,
                sensorHeightMm: 24,
                frames: []
            };

            const pose = VfxPlateMatchmoveService.interpolateCameraSolve(track, 1.5);
            expect(pose.position).toEqual([0, 2, 5]);
            expect(pose.fovDegrees).toBe(45);
            expect(pose.rotationQuaternion).toEqual([0, 0, 0, 1]);
        });

        it('returns exact values when matching frame time', () => {
            const frames: CameraSolveFrame[] = [
                {
                    frameNumber: 0,
                    timeSeconds: 0.0,
                    position: [1, 2, 3],
                    rotationQuaternion: [0, 0, 0, 1],
                    fovDegrees: 50.0,
                    reprojectionErrorPx: 0.25
                },
                {
                    frameNumber: 24,
                    timeSeconds: 1.0,
                    position: [2, 4, 6],
                    rotationQuaternion: [0, 0.7071, 0, 0.7071],
                    fovDegrees: 40.0,
                    reprojectionErrorPx: 0.35
                }
            ];

            const track: CameraSolveTrack = {
                id: 'track-1',
                fps: 24,
                totalFrames: 2,
                coordinateSystem: 'threejs',
                sensorWidthMm: 36,
                sensorHeightMm: 24,
                frames
            };

            const pose0 = VfxPlateMatchmoveService.interpolateCameraSolve(track, 0.0);
            expect(pose0.position[0]).toBeCloseTo(1.0);
            expect(pose0.position[1]).toBeCloseTo(2.0);
            expect(pose0.position[2]).toBeCloseTo(3.0);
            expect(pose0.fovDegrees).toBeCloseTo(50.0);

            const pose1 = VfxPlateMatchmoveService.interpolateCameraSolve(track, 1.0);
            expect(pose1.position[0]).toBeCloseTo(2.0);
            expect(pose1.position[1]).toBeCloseTo(4.0);
            expect(pose1.position[2]).toBeCloseTo(6.0);
            expect(pose1.fovDegrees).toBeCloseTo(40.0);
        });

        it('smoothly interpolates position (Hermite) and rotation (slerp) between frames', () => {
            const frames: CameraSolveFrame[] = [
                {
                    frameNumber: 0,
                    timeSeconds: 0.0,
                    position: [0, 0, 0],
                    rotationQuaternion: [0, 0, 0, 1],
                    fovDegrees: 60.0
                },
                {
                    frameNumber: 1,
                    timeSeconds: 1.0,
                    position: [10, 0, 0],
                    rotationQuaternion: [0, 1, 0, 0], // 180 deg around Y
                    fovDegrees: 30.0
                }
            ];

            const track: CameraSolveTrack = {
                id: 'track-2',
                fps: 24,
                totalFrames: 2,
                coordinateSystem: 'threejs',
                sensorWidthMm: 36,
                sensorHeightMm: 24,
                frames
            };

            const mid = VfxPlateMatchmoveService.interpolateCameraSolve(track, 0.5);
            // Midpoint position should be 5.0
            expect(mid.position[0]).toBeCloseTo(5.0, 1);
            expect(mid.fovDegrees).toBeCloseTo(45.0, 1);
            // Midpoint quaternion should have magnitude 1.0
            const q = mid.rotationQuaternion;
            const mag = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
            expect(mag).toBeCloseTo(1.0, 4);
        });
    });

    describe('Sensor & Lens Trigonometry', () => {
        it('calculates focal length from FOV and sensor height accurately', () => {
            // Sensor height = 24mm, FOV = 45 deg
            // f = 12 / tan(22.5 deg) ≈ 28.97 mm
            const fl = VfxPlateMatchmoveService.fovToFocalLength(45, 24);
            expect(fl).toBeCloseTo(28.97, 1);

            // Invert back to FOV
            const fov = VfxPlateMatchmoveService.focalLengthToFov(fl, 24);
            expect(fov).toBeCloseTo(45, 2);
        });

        it('handles 35mm and 50mm classic lenses', () => {
            const fov35 = VfxPlateMatchmoveService.focalLengthToFov(35, 24);
            const fov50 = VfxPlateMatchmoveService.focalLengthToFov(50, 24);
            // 35mm on 24mm height has wider FOV than 50mm
            expect(fov35).toBeGreaterThan(fov50);
            expect(fov50).toBeCloseTo(26.99, 1);
        });
    });

    describe('Astronomical Solar Ephemeris & Lighting Lock', () => {
        it('computes unit-length solar direction vector for real-world filming location', () => {
            const anchor: GeodeticEphemerisAnchor = {
                lat: 34.0522, // Los Angeles
                lng: -118.2437,
                alt: 100,
                headingDegrees: 0,
                utcTimestampIso: '2026-06-21T20:00:00.000Z', // Summer Solstice near solar noon in LA
                sunLockActive: true
            };

            const lighting = VfxPlateMatchmoveService.computeSolarLighting(anchor);
            const v = lighting.directionVector;
            const len = Math.hypot(v[0], v[1], v[2]);
            expect(len).toBeCloseTo(1.0, 4);
            // In LA at summer noon, sun should be well above the horizon (positive Y)
            expect(v[1]).toBeGreaterThan(0.5);
            expect(lighting.directionalIntensity).toBeGreaterThan(2.0);
        });

        it('accounts for compass heading rotation around Y axis', () => {
            const anchorNorth: GeodeticEphemerisAnchor = {
                lat: 34.0522,
                lng: -118.2437,
                alt: 100,
                headingDegrees: 0,
                utcTimestampIso: '2026-06-21T20:00:00.000Z',
                sunLockActive: true
            };
            const anchorEast: GeodeticEphemerisAnchor = {
                ...anchorNorth,
                headingDegrees: 90
            };

            const lightNorth = VfxPlateMatchmoveService.computeSolarLighting(anchorNorth);
            const lightEast = VfxPlateMatchmoveService.computeSolarLighting(anchorEast);

            // Vertical altitude (Y component) should be identical regardless of set compass heading
            expect(lightNorth.directionVector[1]).toBeCloseTo(lightEast.directionVector[1], 4);
            // Horizontal components must rotate
            expect(lightNorth.directionVector[0]).not.toBeCloseTo(lightEast.directionVector[0], 2);
        });
    });

    describe('Optical Lens Distortion (Brown-Conrady)', () => {
        it('is identity when distortion coefficients are zero', () => {
            const [u, v] = VfxPlateMatchmoveService.distortPoint(0.5, 0.25, { k1: 0, k2: 0 });
            expect(u).toBeCloseTo(0.5);
            expect(v).toBeCloseTo(0.25);
        });

        it('inverts radial distortion with high precision via Newton-Raphson solver', () => {
            const distortion = { k1: -0.05, k2: 0.01 };
            const origU = 0.65;
            const origV = 0.40;

            const [distU, distV] = VfxPlateMatchmoveService.distortPoint(origU, origV, distortion);
            const [undistU, undistV] = VfxPlateMatchmoveService.undistortPoint(distU, distV, distortion);

            expect(undistU).toBeCloseTo(origU, 3);
            expect(undistV).toBeCloseTo(origV, 3);
        });
    });

    describe('Reprojection Anti-Drift Evaluation', () => {
        it('reports LOCKED when 3D markers project accurately to 2D plate markers', () => {
            const pose: InterpolatedCameraPose = {
                position: [0, 0, 5],
                rotationQuaternion: [0, 0, 0, 1], // Identity facing -Z
                fovDegrees: 60,
                focalLengthMm: 35
            };

            // Point at [0, 0, 0], in front of camera at distance 5 down -Z optical axis
            // Projected point should be right in the center of a 1920x1080 screen (960, 540)
            const markers: TrackingMarker2D3D[] = [
                {
                    id: 'm1',
                    platePoint2D: [960, 540],
                    worldPoint3D: [0, 0, 0],
                    confidence: 1.0
                }
            ];

            const evaluation = VfxPlateMatchmoveService.evaluateDrift(markers, pose, { width: 1920, height: 1080 });
            expect(evaluation.status).toBe('locked');
            expect(evaluation.meanDriftPx).toBeLessThan(0.01);
            expect(evaluation.maxDriftPx).toBeLessThan(0.01);
        });

        it('reports DRIFTING when tracking error exceeds max permitted threshold', () => {
            const pose: InterpolatedCameraPose = {
                position: [0, 0, 5],
                rotationQuaternion: [0, 0, 0, 1],
                fovDegrees: 60,
                focalLengthMm: 35
            };

            // Marker at [0, 0, 0] projects to (960, 540), but plate marker is recorded at (980, 550) -> 22.36 px error
            const markers: TrackingMarker2D3D[] = [
                {
                    id: 'm-drift',
                    platePoint2D: [980, 550],
                    worldPoint3D: [0, 0, 0],
                    confidence: 1.0
                }
            ];

            const evaluation = VfxPlateMatchmoveService.evaluateDrift(markers, pose, { width: 1920, height: 1080 });
            expect(evaluation.status).toBe('drifting');
            expect(evaluation.meanDriftPx).toBeGreaterThan(20);
        });
    });
});

describe('Video3DLayerRenderer - Live-Action Matchmove & Sun Lock Integration', () => {
    it('applies 6-DOF camera solve during renderAtTime', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1920,
            height: 1080,
            renderer: mockRenderer
        });

        const solveTrack: CameraSolveTrack = {
            id: 'solve-track-vfx',
            fps: 24,
            totalFrames: 2,
            coordinateSystem: 'threejs',
            sensorWidthMm: 36,
            sensorHeightMm: 24,
            frames: [
                {
                    frameNumber: 0,
                    timeSeconds: 0.0,
                    position: [10, 20, 30],
                    rotationQuaternion: [0, 0, 0, 1],
                    fovDegrees: 38.5
                },
                {
                    frameNumber: 24,
                    timeSeconds: 1.0,
                    position: [15, 22, 35],
                    rotationQuaternion: [0, 0, 0, 1],
                    fovDegrees: 38.5
                }
            ]
        };

        const clip: TimelineElement = {
            id: 'clip-3d-vfx',
            trackId: 'track-vfx',
            type: '3d',
            name: 'VFX Synthetic Extension',
            startTime: 0,
            duration: 5,
            trimStart: 0,
            trimEnd: 5,
            vfxPlate: {
                plateId: 'plate-live-action',
                cameraSolve: solveTrack
            }
        };

        layerRenderer.renderAtTime(clip, 0.0);
        // Video3DLayerRenderer camera position should match frame 0
        const cam = (layerRenderer as any).camera as THREE.PerspectiveCamera;
        expect(cam.position.x).toBeCloseTo(10);
        expect(cam.position.y).toBeCloseTo(20);
        expect(cam.position.z).toBeCloseTo(30);
        expect(cam.fov).toBeCloseTo(38.5);

        // Render at 1.0 sec
        layerRenderer.renderAtTime(clip, 1.0);
        expect(cam.position.x).toBeCloseTo(15);
        expect(cam.position.y).toBeCloseTo(22);
        expect(cam.position.z).toBeCloseTo(35);

        layerRenderer.dispose();
    });

    it('locks directional light to astronomical sun vector when sunLockActive is enabled', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1920,
            height: 1080,
            renderer: mockRenderer
        });

        const clip: TimelineElement = {
            id: 'clip-sun-lock',
            trackId: 'track-vfx',
            type: '3d',
            name: 'VFX Synthetic Building',
            startTime: 0,
            duration: 5,
            trimStart: 0,
            trimEnd: 5,
            vfxPlate: {
                geodeticAnchor: {
                    lat: 34.0522,
                    lng: -118.2437,
                    alt: 100,
                    headingDegrees: 45,
                    utcTimestampIso: '2026-06-21T20:00:00.000Z',
                    sunLockActive: true
                }
            }
        };

        layerRenderer.renderAtTime(clip, 0.0);

        const lightGroup = (layerRenderer as any).lightGroup as THREE.Group;
        expect(lightGroup.children.length).toBeGreaterThan(0);

        layerRenderer.dispose();
    });

    it('renders depth holdout silhouette pass without throwing', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1280,
            height: 720,
            renderer: mockRenderer
        });

        const clip: TimelineElement = {
            id: 'clip-holdout',
            trackId: 'track-holdout',
            type: '3d',
            name: 'Foreground Actor Proxy',
            startTime: 0,
            duration: 5,
            trimStart: 0,
            trimEnd: 5,
            vfxPlate: {
                antiDrift: {
                    depthHoldoutEnabled: true,
                    depthThresholdMeters: 8.0,
                    edgeFeatherPx: 3
                }
            }
        };

        const tex = layerRenderer.renderDepthHoldout(clip, 0.5);
        expect(tex).toBeDefined();

        layerRenderer.dispose();
    });
});
