/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport camera panel's edits as operator commands (scene3d/cameraSettings.ts), run through the real
 * sb_set_camera / sb_set_camera_lens operators, across the 8-200 mm focal range; the configure_physical_camera tool
 * and the optics plan at both ends of it; and the reload rule for a stored pose.
 */

import { describe, expect, it } from 'vitest';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import {
    effectiveFocalLength,
    focalLengthCommands,
    focalLengthForFov,
    keepsStoredPose,
    lensCommands,
    liveViewMatches,
    resetCameraCommands,
    runCameraCommands,
    sensorCommands,
    verticalFovDeg,
    withLivePose
} from '../src/browser/generative-canvas/primitives/scene3d/cameraSettings';
import { focalToSlider, sliderToFocal, FOCAL_RANGE_MM } from '../src/browser/generative-canvas/primitives/scene3d/CameraSettingsControl';
import { distortionOverscan, planViewportOptics, MAX_OVERSCAN } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { physicalCameraHandlers } from '../src/node/gemini/tools/spatial-tools';

const deg = (r: number) => (r * 180) / Math.PI;
const scene = (camera?: Scene3DData['camera']): Scene3DData => ({ title: 'Colonnade', ...(camera ? { camera } : {}) } as Scene3DData);
const base = () => scene({ position: [0, 1.7, 12], target: [0, 1.7, 0], fov: 45 });

describe('camera panel commands through the real operators', () => {
    it('8 mm on full frame: about 112.6 degrees vertical (132 horizontal), fov and lens written together', () => {
        const out = runCameraCommands(base(), focalLengthCommands(base().camera, 8));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.camera!.fov).toBeCloseTo(deg(2 * Math.atan(24 / 16)), 2);
        expect(out.camera!.fov).toBeCloseTo(112.62, 1);
        expect(deg(2 * Math.atan(36 / 16))).toBeCloseTo(132.08, 1);
        expect(out.camera!.lens).toEqual({ focalLengthMm: 8, sensorWidthMm: 36, sensorHeightMm: 24 });
        expect(out.camera!.position).toEqual([0, 1.7, 12]);
    });

    it('200 mm on full frame: about 6.87 degrees vertical', () => {
        const out = runCameraCommands(base(), focalLengthCommands(base().camera, 200));
        expect(out.ok && out.camera!.fov).toBeCloseTo(deg(2 * Math.atan(24 / 400)), 2);
        expect(out.ok && out.camera!.fov).toBeCloseTo(6.867, 2);
        expect(out.ok && out.camera!.lens?.focalLengthMm).toBe(200);
    });

    it('a sensor change keeps the focal length and moves the field of view', () => {
        const at50 = runCameraCommands(base(), focalLengthCommands(base().camera, 50));
        if (!at50.ok) throw new Error(at50.error);
        const s35 = runCameraCommands(scene(at50.camera), sensorCommands(at50.camera, 24.89, 18.66));
        if (!s35.ok) throw new Error(s35.error);
        expect(s35.camera!.lens?.focalLengthMm).toBe(50);
        expect(s35.camera!.fov).toBeCloseTo(verticalFovDeg(50, 18.66), 2);
    });

    it('depth of field on a camera with no lens takes the focal length its field of view already gives', () => {
        const cam = base().camera;
        const derived = effectiveFocalLength(cam);
        expect(derived.derived).toBe(true);
        expect(derived.mm).toBeCloseTo(focalLengthForFov(45, 24), 6);
        const out = runCameraCommands(base(), lensCommands(cam, { apertureFStop: 1.4, focusDistanceMeters: 6, depthOfField: true }));
        if (!out.ok) throw new Error(out.error);
        expect(out.camera!.fov).toBe(45);
        expect(out.camera!.lens).toMatchObject({ apertureFStop: 1.4, focusDistanceMeters: 6, depthOfField: true, sensorHeightMm: 24 });
        expect(out.camera!.lens!.focalLengthMm).toBeCloseTo(28.97, 2);
        expect(planViewportOptics(out.camera!.lens).passes).toContain('depth-of-field');
    });

    it('a refused command changes nothing (all or nothing)', () => {
        const cam = { ...base().camera!, lens: { focalLengthMm: 24 } };
        const out = runCameraCommands(scene(cam), lensCommands(cam, { focusDistanceMeters: 0.001 }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.error).toMatch(/inside the 24 mm focal length/);
    });

    it('reset removes the lens, puts the unset 45 degree field of view back and clears a saved pose', () => {
        const cam = { ...base().camera!, fov: 112.6, keepPoseOnLoad: true, lens: { focalLengthMm: 8, distortion: { k1: -0.02 } } };
        const out = runCameraCommands(scene(cam), resetCameraCommands());
        if (!out.ok) throw new Error(out.error);
        expect(out.camera!.lens).toBeUndefined();
        expect(out.camera!.fov).toBe(45);
        expect(out.camera!.keepPoseOnLoad).toBeUndefined();
    });

    it('panel edits carry the live pose unless the view already stands at the stored one', () => {
        const cam = base().camera!;
        const same = withLivePose(focalLengthCommands(cam, 35), cam, { position: [0, 1.7, 12.00001], target: [0, 1.7, 0] });
        expect(same[0]).toEqual({ operator: 'sb_set_camera', params: { fov: expect.any(Number) } });
        const moved = withLivePose(lensCommands(cam, { apertureFStop: 2 }), cam, { position: [3, 2, 9], target: [0, 1, 0] });
        expect(moved[0]).toEqual({ operator: 'sb_set_camera', params: { position: [3, 2, 9], target: [0, 1, 0] } });
        expect(liveViewMatches({ x: 0, y: 1.7, z: 12 }, { x: 0, y: 1.7, z: 0 }, [0, 1.7, 12], [0, 1.7, 0])).toBe(true);
    });

    it('a reload keeps a saved pose or the pose a lens was set for, and re-frames otherwise', () => {
        expect(keepsStoredPose(base().camera)).toBe(false);
        expect(keepsStoredPose({ ...base().camera!, keepPoseOnLoad: true })).toBe(true);
        expect(keepsStoredPose({ ...base().camera!, lens: { focalLengthMm: 85 } })).toBe(true);
        const saved = runCameraCommands(base(), [{ operator: 'sb_set_camera', params: { keepPoseOnLoad: true } }]);
        expect(saved.ok && saved.camera!.keepPoseOnLoad).toBe(true);
    });

    it('the focal slider is log-scaled over 8-200 mm', () => {
        expect(FOCAL_RANGE_MM).toEqual({ min: 8, max: 200 });
        expect(focalToSlider(8)).toBe(0);
        expect(focalToSlider(200)).toBe(1000);
        expect(focalToSlider(4)).toBe(0);
        expect(sliderToFocal(0)).toBe(8);
        expect(sliderToFocal(1000)).toBe(200);
        // 8-40 mm (5x) gets half the travel, as does 40-200 mm
        expect(sliderToFocal(500)).toBeCloseTo(40, 0);
        for (const mm of [8, 14, 24, 35, 50, 85, 135, 200]) expect(Math.abs(sliderToFocal(focalToSlider(mm)) - mm) / mm).toBeLessThan(0.004);
    });
});

describe('the ends of the focal range in the optics plan and the agent tool', () => {
    it('8 mm with a mild barrel: drawn with a finite overscan; a wide-frame fold is reported, a square-frame fold refused', () => {
        const fov = verticalFovDeg(8, 24);
        const mild = runCameraCommands(scene({ position: [0, 1.7, 12], target: [0, 1.7, 0], fov }), [{ operator: 'sb_set_camera_lens', params: { focalLengthMm: 8, distortion: { k1: -0.01 } } }]);
        if (!mild.ok) throw new Error(mild.error);
        const plan = planViewportOptics(mild.camera!.lens);
        const o = distortionOverscan(plan.distortion!, fov, 16 / 9);
        expect(o.folds).toBe(false);
        expect(o.overscan).toBeGreaterThan(1);
        expect(Number.isFinite(o.overscan)).toBe(true);
        // the viewport renders at most MAX_OVERSCAN and reports what it could not
        expect(MAX_OVERSCAN).toBe(2);
        // k1 = -0.02 cannot reach the corners of a 16:9 frame at 112.6 degrees (the barrel's displayed radius peaks
        // below them): kept, with the aspect it can be drawn up to
        const wide = runCameraCommands(scene({ position: [0, 1.7, 12], target: [0, 1.7, 0], fov }), [{ operator: 'sb_set_camera_lens', params: { distortion: { k1: -0.02 } } }]);
        if (!wide.ok) throw new Error(wide.error);
        expect(wide.issues.join(' ')).toMatch(/folds back \(no inverse\) on frames wider than 1\.\d\d:1/);
        expect(distortionOverscan(planViewportOptics(wide.camera!.lens).distortion!, fov, 16 / 9).folds).toBe(true);
        const strong = runCameraCommands(scene({ position: [0, 1.7, 12], target: [0, 1.7, 0], fov }), [{ operator: 'sb_set_camera_lens', params: { distortion: { k1: -0.2 } } }]);
        expect(strong.ok).toBe(false);
        if (!strong.ok) expect(strong.error).toMatch(/fold back inside a square 112\.6° frame/);
    });

    it('200 mm: the same k1 is a near-identity at 6.9 degrees', () => {
        const fov = verticalFovDeg(200, 24);
        const out = runCameraCommands(scene({ position: [0, 1.7, 12], target: [0, 1.7, 0], fov }), [{ operator: 'sb_set_camera_lens', params: { focalLengthMm: 200, distortion: { k1: -0.2 } } }]);
        if (!out.ok) throw new Error(out.error);
        const o = distortionOverscan(planViewportOptics(out.camera!.lens).distortion!, fov, 16 / 9);
        expect(o.folds).toBe(false);
        expect(o.overscan).toBeLessThan(1.01);
    });

    for (const [mm, vfov] of [[8, 112.62], [200, 6.867]] as const) {
        it(`configure_physical_camera applies ${mm} mm`, async () => {
            const active = { id: 's', type: '3d-scene', title: 'Colonnade', version: 1, data: base() };
            const out = await physicalCameraHandlers.configure_physical_camera(
                { focalLengthMm: mm, apertureFStop: 2.8, focusDistanceMeters: 6, sensorFormat: 'full_frame_35mm' },
                { request: { activeArtifact: active } } as any
            ) as any;
            expect(out.resultPayload.applied).toBe(true);
            expect(out.resultPayload.appliedFovDeg).toBeCloseTo(vfov, 1);
            const data = out.resultPayload.artifact.data as Scene3DData;
            expect(data.camera!.fov).toBeCloseTo(vfov, 1);
            expect(data.camera!.lens!.focalLengthMm).toBe(mm);
            expect(out.resultPayload.passes).toContain('depth-of-field');
        });
    }

    it('configure_physical_camera refuses a non-positive focal length', async () => {
        const active = { id: 's', type: '3d-scene', title: 'Colonnade', version: 1, data: base() };
        const out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 0, apertureFStop: 2.8 }, { request: { activeArtifact: active } } as any) as any;
        expect(out.status).toBe('failed');
        expect(out.summaryResult).toMatch(/NOT applied/);
    });
});
