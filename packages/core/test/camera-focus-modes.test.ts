/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The camera's focus modes (manual, auto focus, a tracked point or object) without a GPU: the sb_set_camera_lens
 * rules and their undo, the scene data round trip (a reload), the AF depth pick and focus-pull maths, a tracked point
 * following a moving camera and a moving object (the real ViewportFocusController), the lost-target notice, and the
 * configure_physical_camera tool setting each mode. The viewport's own AF depth read and the panel are covered in
 * headless Chrome by viewport-camera-focus.test.ts.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { lensCommands, runCameraCommands } from '../src/browser/generative-canvas/primitives/scene3d/cameraSettings';
import { planViewportOptics } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import {
    DEFAULT_AUTO_FOCUS_AREA_FRACTION,
    DEFAULT_FOCUS_PULL_SECONDS,
    ViewportFocusController,
    autoFocusHalfExtentUv,
    depthBufferToViewDepth,
    effectiveFocusMode,
    focusPullStep,
    robustNearestDepth,
    unpackRgbaDepth
} from '../src/browser/generative-canvas/primitives/scene3d/viewportFocus';
import { physicalCameraHandlers } from '../src/node/gemini/tools/spatial-tools';

const base = (): Scene3DData => ({
    title: 'Colonnade',
    camera: { position: [0, 2.5, 6], target: [3.6, 2.5, -4], fov: 16.07, lens: { focalLengthMm: 85, sensorWidthMm: 36, sensorHeightMm: 24, apertureFStop: 1.4, focusDistanceMeters: 20, depthOfField: true } }
} as Scene3DData);

describe('sb_set_camera_lens focus modes', () => {
    it('switches manual -> auto -> track point -> track object -> manual, each one undo away', () => {
        const engine = new DirectDispatchOperatorEngine(base());
        const lens = () => engine.getSceneData().camera!.lens!;

        expect(engine.dispatch('sb_set_camera_lens', { focusMode: 'auto', autoFocusAreaFraction: 0.15, focusPullSeconds: 0.5 }).success).toBe(true);
        expect(lens()).toMatchObject({ focusMode: 'auto', autoFocusAreaFraction: 0.15, focusPullSeconds: 0.5, focusDistanceMeters: 20 });
        expect(planViewportOptics(lens()).passes).toEqual(['depth-of-field', 'output']);

        // a point: implies track, and replaces auto
        expect(engine.dispatch('sb_set_camera_lens', { focusPoint: { objectId: 'hero', localPosition: [3.6, 2.5, -12] } }).success).toBe(true);
        expect(lens()).toMatchObject({ focusMode: 'track', focusPoint: { objectId: 'hero', localPosition: [3.6, 2.5, -12] } });
        expect(effectiveFocusMode(lens())).toBe('track');

        // a whole object replaces the point
        expect(engine.dispatch('sb_set_camera_lens', { focusObjectId: 'hero' }).success).toBe(true);
        expect(lens().focusPoint).toBeUndefined();
        expect(lens()).toMatchObject({ focusMode: 'track', focusObjectId: 'hero' });

        // a distance on its own is manual focus again
        expect(engine.dispatch('sb_set_camera_lens', { focusDistanceMeters: 7.5 }).success).toBe(true);
        expect(lens().focusObjectId).toBeUndefined();
        expect(effectiveFocusMode(lens())).toBe('manual');
        expect(lens().focusDistanceMeters).toBe(7.5);
        // the AF settings are kept for the next switch to auto
        expect(lens().focusPullSeconds).toBe(0.5);

        // undo walks back through each mode
        expect(engine.undo()).toBe(true);
        expect(lens()).toMatchObject({ focusMode: 'track', focusObjectId: 'hero' });
        expect(engine.undo()).toBe(true);
        expect(lens()).toMatchObject({ focusMode: 'track', focusPoint: { objectId: 'hero' } });
        expect(engine.undo()).toBe(true);
        expect(lens().focusMode).toBe('auto');
        expect(engine.undo()).toBe(true);
        expect(lens().focusMode).toBeUndefined();
        expect(effectiveFocusMode(lens())).toBe('manual');
        expect(engine.redo()).toBe(true);
        expect(lens().focusMode).toBe('auto');
    });

    it('refuses what the viewport cannot draw, changing nothing', () => {
        const engine = new DirectDispatchOperatorEngine(base());
        const before = JSON.stringify(engine.getSceneData().camera);
        const refused = (params: Record<string, unknown>, why: RegExp) => {
            const res = engine.dispatch('sb_set_camera_lens', params);
            expect(res.success).toBe(false);
            expect(res.error).toMatch(why);
            expect(JSON.stringify(engine.getSceneData().camera)).toBe(before);
        };
        refused({ focusMode: 'predictive-eye-af' }, /not one the viewport draws \(manual, auto, track\)/);
        refused({ focusMode: 'track' }, /needs a focusPoint .* or a focusObjectId/);
        refused({ autoFocusAreaFraction: 0 }, /autoFocusAreaFraction must be in \(0, 1\]/);
        refused({ autoFocusAreaFraction: 1.5 }, /autoFocusAreaFraction/);
        refused({ focusPullSeconds: -1 }, /focusPullSeconds must be/);
        refused({ focusPoint: { objectId: 'hero', localPosition: [1, Number.NaN, 2] } }, /focusPoint needs localPosition/);
        refused({ focusPoint: { objectId: 'hero', localPosition: [1, 2, 3] }, focusObjectId: 'hero' }, /not both/);
        refused({ focusPoint: { objectId: 'ghost', worldPosition: [1, 2, 3] } }, /'ghost' is not a customMesh or object in the scene data/);
    });

    it('converts a world point to the local frame of a customMesh (position, rotation, scale)', () => {
        const scene = { ...base(), customMeshes: [{ id: 'col', name: 'Column', type: 'box', position: [4, 0, -12], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] }] } as unknown as Scene3DData;
        const engine = new DirectDispatchOperatorEngine(scene);
        expect(engine.dispatch('sb_set_camera_lens', { focusPoint: { objectId: 'col', worldPosition: [4, 2.5, -10] } }).success).toBe(true);
        const p = engine.getSceneData().camera!.lens!.focusPoint!;
        expect(p.objectId).toBe('col');
        // back to world through the same transform
        const m = new THREE.Matrix4().compose(new THREE.Vector3(4, 0, -12), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), new THREE.Vector3(2, 2, 2));
        const w = new THREE.Vector3(...p.localPosition).applyMatrix4(m);
        expect(w.x).toBeCloseTo(4, 9);
        expect(w.y).toBeCloseTo(2.5, 9);
        expect(w.z).toBeCloseTo(-10, 9);
    });

    it('the panel\'s commands keep the lens consistent and survive a JSON round trip (a reload)', () => {
        const scene = base();
        const out = runCameraCommands(scene, lensCommands(scene.camera, { focusMode: 'auto', autoFocusAreaFraction: 0.08, focusPullSeconds: 0.25 }));
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const reloaded = JSON.parse(JSON.stringify({ ...scene, camera: out.camera })) as Scene3DData;
        expect(reloaded.camera!.lens).toMatchObject({ focusMode: 'auto', autoFocusAreaFraction: 0.08, focusPullSeconds: 0.25 });
        const controller = new ViewportFocusController();
        controller.configure(reloaded.camera!.lens);
        expect(controller.focusMode).toBe('auto');
        expect(controller.measures).toBe(true);
        expect(controller.areaFraction).toBe(0.08);
        // a legacy lens (focusObjectId, no focusMode) reads as tracking the object
        expect(effectiveFocusMode({ focusObjectId: 'bust' })).toBe('track');
        // auto focus with no stored distance still draws depth of field (the viewport measures the distance)
        expect(planViewportOptics({ focalLengthMm: 85, apertureFStop: 1.4, focusMode: 'auto' }).passes).toContain('depth-of-field');
        expect(planViewportOptics({ focalLengthMm: 85, apertureFStop: 1.4, focusMode: 'track', focusPoint: { localPosition: [0, 0, -5] } }).passes).toContain('depth-of-field');
    });
});

describe('auto focus maths', () => {
    it('takes the nearest robust depth of the AF samples, ignoring sky and a single stray near pixel', () => {
        // 25 samples: 12 on a column at ~10.6 m, 12 on the far wall at ~42 m, one stray pixel at 3 m, sky as 0
        const samples = [3, ...Array(12).fill(10.6), ...Array(11).fill(42), 0];
        expect(robustNearestDepth(samples)).toBe(10.6);
        expect(robustNearestDepth([0, 0, Number.NaN, -1])).toBeNull();
        expect(robustNearestDepth([25])).toBe(25);
        // the quantile is continuous: 0 is the nearest sample, 1 the farthest
        expect(robustNearestDepth(samples, 0)).toBe(3);
        expect(robustNearestDepth(samples, 1)).toBe(42);
    });

    it('glides in dioptres with the focus-pull time constant: 63 % of the way after one tau, frame rate independent', () => {
        const tau = 0.3, from = 20, to = 10.6;
        const after = (fps: number, seconds: number) => {
            let d = from;
            for (let i = 0; i < Math.round(seconds * fps); i++) d = focusPullStep(d, to, 1 / fps, tau);
            return d;
        };
        const expected = 1 / (1 / to + (1 / from - 1 / to) * Math.exp(-1));
        expect(after(60, tau)).toBeCloseTo(expected, 6);
        expect(after(20, tau)).toBeCloseTo(expected, 6); // 6 frames of 50 ms = one tau, as 18 of 16.7 ms
        // smooth: every frame moves part of the way, never past the target
        let d = from;
        const seq: number[] = [];
        for (let i = 0; i < 90; i++) { d = focusPullStep(d, to, 1 / 60, tau); seq.push(d); }
        seq.forEach((v, i) => { expect(v).toBeLessThan(i ? seq[i - 1] : from); expect(v).toBeGreaterThan(to); });
        expect(seq[89]).toBeCloseTo(to, 1);
        // tau 0 snaps
        expect(focusPullStep(from, to, 1 / 60, 0)).toBe(to);
    });

    it('reads the depth buffer as the bokeh pass does: packed RGBA bytes -> raw depth -> metres along the view axis', () => {
        const near = 0.1, far = 2000;
        for (const d of [0.5, 10.63, 42.15, 900]) {
            const raw = (far / (far - near)) * (1 - near / d); // perspective depth of a point d metres along the axis
            // packDepthToRGBA as the shader writes it, to bytes
            const pf = [1, 256, 65536, 16777216];
            let vuf = Math.floor(raw * pf[3]);
            const af = raw * pf[3] - vuf;
            const bf = vuf / 256 - Math.floor(vuf / 256); vuf = Math.floor(vuf / 256);
            const gf = vuf / 256 - Math.floor(vuf / 256); vuf = Math.floor(vuf / 256);
            const bytes = [vuf / 255, gf * 256 / 255, bf * 256 / 255, af].map(v => Math.round(v * 255));
            const back = depthBufferToViewDepth(unpackRgbaDepth(bytes[0], bytes[1], bytes[2], bytes[3]), near, far)!;
            expect(Math.abs(back - d) / d).toBeLessThan(1e-3);
        }
        expect(depthBufferToViewDepth(unpackRgbaDepth(255, 255, 255, 255), near, far)).toBeNull(); // the cleared far plane: sky
    });

    it('sizes the AF area by the frame height, inside an overscanned render target', () => {
        const [hu, hv] = autoFocusHalfExtentUv(0.1, { width: 1600, height: 900, renderWidth: 1600, renderHeight: 900 });
        expect(hv).toBeCloseTo(0.05, 9);
        expect(hu * 1600).toBeCloseTo(hv * 900, 9); // square in pixels
        const [, hv2] = autoFocusHalfExtentUv(0.1, { width: 1600, height: 900, renderWidth: 1960, renderHeight: 1102 });
        expect(hv2 * 1102).toBeCloseTo(45, 9); // the same 90 px square in the larger target
        expect(DEFAULT_AUTO_FOCUS_AREA_FRACTION).toBe(0.1);
        expect(DEFAULT_FOCUS_PULL_SECONDS).toBe(0.3);
    });
});

describe('a tracked point (the real ViewportFocusController)', () => {
    const setup = () => {
        const scene = new THREE.Scene();
        const hero = new THREE.Group();
        hero.name = 'hero';
        scene.add(hero);
        const camera = new THREE.PerspectiveCamera(16.07, 1.5, 0.1, 2000);
        const resolve = (id: string) => scene.getObjectByName(id);
        const controller = new ViewportFocusController();
        controller.configure({ focalLengthMm: 85, apertureFStop: 1.4, focusMode: 'track', focusPoint: { objectId: 'hero', localPosition: [3.6, 2.5, -12] }, focusDistanceMeters: 18 });
        const frame = { width: 1500, height: 1000, renderWidth: 1500, renderHeight: 1000 };
        const measure = (issues: string[] = []) => controller.focusDistance(null as unknown as THREE.WebGLRenderer, camera, null, frame, resolve, 0, issues);
        const depthOf = (p: THREE.Vector3) => p.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
        const place = (pos: [number, number, number], look: [number, number, number]) => {
            camera.position.set(...pos);
            camera.lookAt(...look);
            camera.updateMatrixWorld();
        };
        return { scene, hero, camera, controller, measure, depthOf, place };
    };

    it('follows a moving camera: the focus distance is the point\'s depth along the view axis every frame', () => {
        const { camera, measure, depthOf, place } = setup();
        const point = new THREE.Vector3(3.6, 2.5, -12);
        // an orbit around the point
        for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 0.8 - 0.4 * Math.PI;
            place([3.6 + 15 * Math.sin(a), 4, -12 + 15 * Math.cos(a)], [0, 2.5, -20]);
            expect(measure()).toBeCloseTo(depthOf(point), 9);
        }
        expect(camera.position.y).toBe(4);
    });

    it('follows a moving (animated) object: the point is stored in its local frame', () => {
        const { hero, measure, depthOf, place, controller } = setup();
        place([0, 2.5, 6], [3.6, 2.5, -12]);
        for (let i = 0; i < 10; i++) {
            hero.position.set(0, 0, -i * 1.5);
            hero.rotation.y = i * 0.05;
            hero.updateMatrixWorld();
            const world = new THREE.Vector3(3.6, 2.5, -12).applyMatrix4(hero.matrixWorld);
            expect(measure()).toBeCloseTo(depthOf(world), 9);
            expect(controller.status.worldPoint![2]).toBeCloseTo(world.z, 9);
        }
    });

    it('a lost object holds the last distance and says so; it resumes when the object returns', () => {
        const { scene, hero, measure, place, controller } = setup();
        place([0, 2.5, 6], [3.6, 2.5, -12]);
        const before = measure()!;
        scene.remove(hero);
        const issues: string[] = [];
        expect(measure(issues)).toBe(before);
        expect(issues).toEqual([`focus: the tracked point's object 'hero' is not in the viewport; holding the last focus distance ${before.toFixed(2)} m`]);
        expect(controller.status.notice).toBe(issues[0]);
        // a camera that turns away so the point is behind it: held too
        scene.add(hero);
        place([0, 2.5, 6], [0, 2.5, 20]);
        const behind: string[] = [];
        expect(measure(behind)).toBe(before);
        expect(behind[0]).toMatch(/behind the camera .* holding the last focus distance/);
        place([0, 2.5, 6], [3.6, 2.5, -12]);
        const back: string[] = [];
        expect(measure(back)).toBeCloseTo(before, 9);
        expect(back).toEqual([]);
    });

    it('a world point without an object stays where it is', () => {
        const { camera, controller, place } = setup();
        controller.configure({ focalLengthMm: 50, apertureFStop: 2, focusMode: 'track', focusPoint: { localPosition: [0, 0, -10] } });
        place([0, 0, 0], [0, 0, -1]);
        expect(controller.focusDistance(null as unknown as THREE.WebGLRenderer, camera, null, { width: 10, height: 10, renderWidth: 10, renderHeight: 10 }, () => undefined, 0, [])).toBeCloseTo(10, 9);
    });
});

describe('configure_physical_camera sets each focus mode', () => {
    const withScene = (data: Scene3DData) => ({ request: { activeArtifact: { id: 'scene-colonnade', type: '3d-scene', title: 'Colonnade', version: 1, data } } }) as any;
    const scene = () => ({ ...base(), customMeshes: [{ id: 'col', name: 'Column', type: 'box', position: [4, 0, -12] }] } as unknown as Scene3DData);
    const run = async (args: Record<string, unknown>, data: Scene3DData = scene()) => await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 85, apertureFStop: 1.4, ...args }, withScene(data)) as any;

    it('auto focus with an AF area and pull time', async () => {
        const out = await run({ focusMode: 'auto', autoFocusAreaFraction: 0.12, focusPullSeconds: 0.4 });
        expect(out.resultPayload.applied).toBe(true);
        expect(out.resultPayload.artifact.data.camera.lens).toMatchObject({ focusMode: 'auto', autoFocusAreaFraction: 0.12, focusPullSeconds: 0.4 });
        expect(out.resultPayload.focus).toMatchObject({ mode: 'auto', autoFocusAreaFraction: 0.12, focusPullSeconds: 0.4 });
        expect(out.resultPayload.passes).toContain('depth-of-field');
        expect(out.resultPayload.depthOfField).toBeUndefined(); // no fixed limits for a moving plane of focus
        expect(out.summaryResult).toMatch(/auto focus on the centre of the frame \(AF area 12 % of the frame height, 0\.4 s focus pull/);
    });

    it('a point on an object, given in local or world coordinates, and a fixed world point', async () => {
        let out = await run({ focusPoint: { objectId: 'col', localPosition: [0, 2.5, 0.4] } });
        expect(out.resultPayload.artifact.data.camera.lens).toMatchObject({ focusMode: 'track', focusPoint: { objectId: 'col', localPosition: [0, 2.5, 0.4] } });
        out = await run({ focusPoint: { objectId: 'col', worldPosition: [4, 2.5, -11.6] } });
        const p = out.resultPayload.artifact.data.camera.lens.focusPoint;
        expect(p.objectId).toBe('col');
        p.localPosition.forEach((v: number, i: number) => expect(v).toBeCloseTo([0, 2.5, 0.4][i], 9));
        out = await run({ focusPoint: { worldPosition: [0, 1, -30] } });
        expect(out.resultPayload.artifact.data.camera.lens.focusPoint).toEqual({ localPosition: [0, 1, -30] });
        expect(out.resultPayload.focus.mode).toBe('track');
    });

    it('a whole object, then back to manual with a distance', async () => {
        const tracked = await run({ focusObjectId: 'col' });
        expect(tracked.resultPayload.artifact.data.camera.lens).toMatchObject({ focusMode: 'track', focusObjectId: 'col' });
        const manual = await run({ focusDistanceMeters: 12 }, tracked.resultPayload.artifact.data);
        const lens = manual.resultPayload.artifact.data.camera.lens;
        expect(lens.focusObjectId).toBeUndefined();
        expect(effectiveFocusMode(lens)).toBe('manual');
        expect(lens.focusDistanceMeters).toBe(12);
    });

    it('keeps a mode the panel set when the agent only changes the lens, and refuses an unknown mode', async () => {
        const auto = (await run({ focusMode: 'auto' })).resultPayload.artifact.data;
        const out = await run({ focalLengthMm: 50 }, auto);
        expect(out.resultPayload.artifact.data.camera.lens.focusMode).toBe('auto');
        expect(out.summaryResult).toContain('The camera keeps its auto focus.');
        const bad = await run({ focusMode: 'face-detect' });
        expect(bad.resultPayload.applied).toBe(false);
        expect(bad.summaryResult).toMatch(/NOT applied.*focusMode 'face-detect' is not one the viewport draws/);
        const noTarget = await run({ focusMode: 'track' });
        expect(noTarget.resultPayload.applied).toBe(false);
    });
});
