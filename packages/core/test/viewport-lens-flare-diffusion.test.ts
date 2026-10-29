/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Lens flare and diffusion (a Black Pro-Mist) on the scene lens: planned only when asked for, validated by
 * sb_set_camera_lens; lateral colour drawn on its own; and the sun's glare easing toward its measured visibility instead
 * of stepping with each probe read (the flicker under depth of field).
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_DIFFUSION_SPREAD, DEFAULT_FLARE, planViewportOptics } from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { mergeCameraLens } from '../src/browser/generative-canvas/services/operators/lighting-camera-operators';
import { SunGlare, VISIBILITY_EASE_SECONDS } from '../src/browser/generative-canvas/services/atmosphere/SunGlare';
import { haltonJitter, isCameraCut, TemporalAAPass } from '../src/browser/generative-canvas/services/optics/TemporalAAPass';

describe('lens flare and diffusion on the scene lens', () => {
    it('plans each only when asked for, with defaults filled in and values held to their ranges', () => {
        expect(planViewportOptics({ flare: { amount: 0 }, diffusion: { strength: 0 } }).passes).toEqual([]);
        const plan = planViewportOptics({ flare: { amount: 0.3 }, diffusion: { strength: 0.06 } });
        expect(plan.passes).toEqual(['lens-flare', 'diffusion', 'output']);
        expect(plan.issues).toEqual([]);
        expect(plan.flare).toEqual({ amount: 0.3, ...DEFAULT_FLARE });
        expect(plan.diffusion).toEqual({ strength: 0.06, spread: DEFAULT_DIFFUSION_SPREAD });
        const held = planViewportOptics({ flare: { amount: 3, ghosts: 20, halo: 2, streak: -1 }, diffusion: { strength: 0.2, spread: 9 } });
        expect(held.flare).toEqual({ amount: 1, ghosts: 8, halo: 1, streak: 0, threshold: DEFAULT_FLARE.threshold });
        expect(held.diffusion!.spread).toBe(0.5);
    });

    it('draws chromatic aberration without any distortion coefficient', () => {
        const plan = planViewportOptics({ distortion: { k1: 0, chromaticAberration: 0.004 } });
        expect(plan.passes).toEqual(['lens-distortion', 'output']);
        expect(plan.distortion!.chromaticAberration).toBe(0.004);
        expect(planViewportOptics({ distortion: { k1: 0 } }).passes).toEqual([]);
    });

    it('merges flare and diffusion fields, removes them with null, and refuses values out of range', () => {
        const on = mergeCameraLens(undefined, { flare: { amount: 0.3 }, diffusion: { strength: 0.06 } }, 45)!;
        expect(on.flare).toEqual({ amount: 0.3 });
        expect(on.diffusion).toEqual({ strength: 0.06 });
        const more = mergeCameraLens(on, { flare: { ghosts: 6, streak: 0.5 }, diffusion: { spread: 0.08 } }, 45)!;
        expect(more.flare).toEqual({ amount: 0.3, ghosts: 6, streak: 0.5 });
        expect(more.diffusion).toEqual({ strength: 0.06, spread: 0.08 });
        expect(mergeCameraLens(more, { flare: null, diffusion: null }, 45)).toBeUndefined();
        expect(() => mergeCameraLens(on, { flare: { amount: 1.5 } }, 45)).toThrow(/flare.amount/);
        expect(() => mergeCameraLens(on, { flare: { ghosts: 2.5 } }, 45)).toThrow(/ghosts/);
        expect(() => mergeCameraLens(on, { flare: { threshold: 0 } }, 45)).toThrow(/threshold/);
        expect(() => mergeCameraLens(on, { diffusion: { strength: -0.1 } }, 45)).toThrow(/strength/);
        expect(() => mergeCameraLens(on, { diffusion: { spread: 0.9 } }, 45)).toThrow(/spread/);
    });
});

describe('the sun glare under a changing visibility', () => {
    const glare = () => new SunGlare({
        sunDirection: () => new THREE.Vector3(0, 0.5, -1).normalize(),
        sunIrradiance: () => new THREE.Color(1, 1, 1),
        sunElevationDeg: () => 30,
        skyCube: () => new THREE.CubeTexture(),
        clearDiscLuminance: () => 1,
        skyObjects: () => []
    }, 1);

    it('glides toward a new visibility over its time constant, never jumping to it', () => {
        const g = glare();
        expect(g.ease(1, 0)).toBe(1);
        // the probe now reads the sun half hidden: one 60 Hz frame later the glare has moved only a few percent
        const next = g.ease(0.5, 1000 / 60);
        expect(next).toBeLessThan(1);
        expect(next).toBeGreaterThan(0.95);
        // after one time constant, 1 - 1/e of the way
        let t = 1000 / 60, v = next;
        while (t < VISIBILITY_EASE_SECONDS * 1000) { t += 1000 / 60; v = g.ease(0.5, t); }
        expect(v).toBeGreaterThan(0.5 + 0.5 * Math.exp(-1) - 0.03);
        expect(v).toBeLessThan(0.5 + 0.5 * Math.exp(-1) + 0.03);
        g.dispose();
    });

    it('reaches the same value at any frame rate', () => {
        const at = (fps: number) => { const g = glare(); g.ease(1, 0); let v = 1; for (let t = 1000 / fps; t <= 500 + 1e-6; t += 1000 / fps) v = g.ease(0, t); g.dispose(); return v; };
        expect(Math.abs(at(30) - at(120))).toBeLessThan(0.01);
    });
});

describe('temporal anti-aliasing jitter', () => {
    it('covers the pixel evenly over its cycle, centred on it', () => {
        const pts = Array.from({ length: 8 }, (_, i) => haltonJitter(i));
        for (const [x, y] of pts) { expect(Math.abs(x)).toBeLessThan(0.5); expect(Math.abs(y)).toBeLessThan(0.5); }
        expect(new Set(pts.map(p => p.join(','))).size).toBe(8);
        const mx = pts.reduce((a, p) => a + p[0], 0) / 8, my = pts.reduce((a, p) => a + p[1], 0) / 8;
        expect(Math.abs(mx)).toBeLessThan(0.1);
        expect(Math.abs(my)).toBeLessThan(0.1);
        expect(haltonJitter(8)).toEqual(haltonJitter(0));
    });

    it('offsets the projection by a sub-pixel step and restores it after the draw', () => {
        const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
        camera.updateProjectionMatrix();
        const before = camera.projectionMatrix.clone();
        const taa = new TemporalAAPass();
        taa.beginJitter(camera, 800, 400);
        const [jx, jy] = taa.jitter;
        // a point straight ahead lands jx pixels off the centre
        const p = new THREE.Vector3(0, 0, -10).applyMatrix4(camera.projectionMatrix);
        expect(p.x * 400).toBeCloseTo(jx, 4);
        expect(p.y * 200).toBeCloseTo(jy, 4);
        taa.endJitter(camera);
        expect(camera.projectionMatrix.equals(before)).toBe(true);
        taa.dispose();
    });
});

describe('temporal anti-aliasing on a camera cut', () => {
    const cam = (yawDeg: number, fov = 45) => {
        const c = new THREE.PerspectiveCamera(fov, 1.5, 0.1, 100);
        c.rotation.y = THREE.MathUtils.degToRad(yawDeg);
        c.updateMatrixWorld();
        return c;
    };
    const pose = (c: THREE.PerspectiveCamera) => ({ forward: c.getWorldDirection(new THREE.Vector3()), fov: c.fov });

    it('calls a sharp turn or zoom a cut, and a pan or a walk not', () => {
        expect(isCameraCut(null, cam(0))).toBe(false);
        expect(isCameraCut(pose(cam(0)), cam(2))).toBe(false);
        expect(isCameraCut(pose(cam(0)), cam(25))).toBe(true);
        expect(isCameraCut(pose(cam(0)), cam(0, 30))).toBe(true);
        const walked = cam(0);
        walked.position.set(5, 0, -3);
        walked.updateMatrixWorld();
        expect(isCameraCut(pose(cam(0)), walked)).toBe(false);
    });
});

describe('the chat puts flare, diffusion and the anti-aliasing switch on the lens', () => {
    it('configure_physical_camera passes them through, and an amount of 0 removes the flare', async () => {
        const { physicalCameraHandlers } = await import('../src/node/gemini/tools/spatial-tools');
        const scene = { camera: { position: [0, 1.6, 5], target: [0, 1, 0], fov: 40 }, customMeshes: [] };
        const ctx = (data: unknown) => ({ request: { activeArtifact: { id: 's', type: '3d-scene', title: 't', version: 1, data } } }) as any;
        let out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 50, apertureFStop: 2.8, flare: { amount: 0.3, streak: 0.4 }, diffusion: { strength: 0.12 }, temporalAntiAliasing: false }, ctx(scene)) as any;
        expect(out.resultPayload.applied).toBe(true);
        const lens = out.resultPayload.artifact.data.camera.lens;
        expect(lens.flare).toEqual({ amount: 0.3, streak: 0.4 });
        expect(lens.diffusion).toEqual({ strength: 0.12 });
        expect(lens.temporalAntiAliasing).toBe(false);
        out = await physicalCameraHandlers.configure_physical_camera({ focalLengthMm: 50, apertureFStop: 2.8, flare: { amount: 0 } }, ctx(out.resultPayload.artifact.data)) as any;
        expect(out.resultPayload.artifact.data.camera.lens.flare).toBeUndefined();
        expect(out.resultPayload.artifact.data.camera.lens.diffusion).toEqual({ strength: 0.12 });
    });
});
