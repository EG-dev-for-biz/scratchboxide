/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { cameraPathDurationMs, cameraPoseAt, normalizeCameraKeys, verticalFovDegOf, type CameraPathKey } from '../src/common/spatial/camera-path';
import { orbitFromPose, sceneCameraMovePose } from '../src/browser/generative-canvas/primitives/scene3d/cameraMove';

// A slow aerial push-in: from 180 m up and 140 m back to 120 m up and 20 m back over 40 s, zooming 24 -> 50 mm.
const pushIn: CameraPathKey[] = [
    { timeMs: 0, position: [0, 180, 140], target: [0, 10, -200], focalMm: 24, aspect: 2.39 },
    { timeMs: 40000, position: [0, 120, 20], target: [0, 10, -200], focalMm: 50, aspect: 2.39 }
];

describe('camera path', () => {
    it('holds the first and last poses outside the move, and passes through every key', () => {
        expect(cameraPoseAt(pushIn, -5)!.position).toEqual([0, 180, 140]);
        expect(cameraPoseAt(pushIn, 99999)!.position).toEqual([0, 120, 20]);
        const three = [...pushIn.slice(0, 1), { timeMs: 10000, position: [30, 160, 90] as [number, number, number], target: [0, 10, -200] as [number, number, number], focalMm: 30 }, { ...pushIn[1] }];
        const mid = cameraPoseAt(three, 10000)!;
        expect(mid.position).toEqual([30, 160, 90]);
        expect(mid.focalMm).toBeCloseTo(30, 9);
        expect(cameraPathDurationMs(three)).toBe(40000);
    });

    it('eases in and out: no velocity at the ends, the most in the middle, never overshooting', () => {
        const z = (t: number) => cameraPoseAt(pushIn, t)!.position[2];
        const startStep = z(0) - z(400), midStep = z(19800) - z(20200), endStep = z(39600) - z(40000);
        expect(startStep).toBeLessThan(0.05 * midStep);
        expect(endStep).toBeLessThan(0.05 * midStep);
        let last = Infinity;
        for (let t = 0; t <= 40000; t += 500) { expect(z(t)).toBeLessThanOrEqual(last + 1e-9); expect(z(t)).toBeGreaterThanOrEqual(20 - 1e-9); last = z(t); }
        expect(z(20000)).toBeCloseTo(80, 6); // symmetric about the middle
    });

    it('zooms evenly in log space and gives the lens its vertical field', () => {
        const mid = cameraPoseAt(pushIn, 20000)!;
        expect(mid.focalMm).toBeCloseTo(Math.sqrt(24 * 50), 6);
        expect(mid.aspect).toBe(2.39);
        expect(mid.sensorWidthMm).toBe(36);
        expect(mid.verticalFovDeg).toBeCloseTo(verticalFovDegOf(mid.focalMm, 36, 2.39), 9);
        expect(verticalFovDegOf(31.5, 36, 2.39)).toBeCloseTo(26.893, 2);
    });

    it('keeps only complete keys, sorted, one per time', () => {
        const keys = normalizeCameraKeys([
            pushIn[1], { timeMs: 5, position: [0, 0, 0], target: [0, 0, 0], focalMm: 35 }, { timeMs: -1, position: [0, 1, 0], target: [0, 0, 0], focalMm: 35 },
            { timeMs: 3, position: [0, 1, 0], target: [0, 0, 0], focalMm: 0 }, pushIn[0], null
        ]);
        expect(keys.map(k => k.timeMs)).toEqual([0, 40000]);
        expect(cameraPoseAt([], 0)).toBeNull();
    });

    it('drives the viewport orbit: the orbit puts the camera back at the pose, and a scene without a move gives none', () => {
        const pose = cameraPoseAt(pushIn, 12345)!;
        const o = orbitFromPose(pose.position, pose.target);
        const back = [pose.target[0] + o.distance * Math.sin(o.phi) * Math.sin(o.theta), pose.target[1] + o.distance * Math.cos(o.phi), pose.target[2] + o.distance * Math.sin(o.phi) * Math.cos(o.theta)];
        back.forEach((v, i) => expect(v).toBeCloseTo(pose.position[i], 6));
        expect(sceneCameraMovePose({ timeline: { camera: { keys: pushIn } } }, 20000)!.focalMm).toBeCloseTo(Math.sqrt(24 * 50), 6);
        expect(sceneCameraMovePose({ timeline: { camera: { keys: [pushIn[0]] } } }, 0)).toBeNull();
        expect(sceneCameraMovePose({}, 0)).toBeNull();
    });
});
