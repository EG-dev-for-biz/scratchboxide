/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sun glare: the measured veiling-glare law carries the share of the sun's energy the reference photos show round the
 * disc, the dome draws it as one overlay that dispose removes, and no glare is drawn into cube captures or for a
 * strength of 0.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLARE_K, GLARE_N, SUN_RADIUS_DEG, SunGlare } from '../src/browser/generative-canvas/services/atmosphere/SunGlare';
import { createAtmosphericSkyDome } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';
import { InvalidInputError } from '../src/common/errors/pipeline-errors';

describe('sun glare', () => {
    it('spreads ~2.8% of the sun\'s energy round the disc, inside the CIE eye-glare envelope near it', () => {
        // Integral of K * theta^-N (per sr, theta in degrees) over the sphere outside the disc.
        let fraction = 0;
        const d = 0.001;
        for (let t = SUN_RADIUS_DEG; t < 180; t += d) {
            fraction += GLARE_K * Math.pow(t + d / 2, -GLARE_N) * 2 * Math.PI * Math.sin(((t + d / 2) * Math.PI) / 180) * ((d * Math.PI) / 180);
        }
        expect(fraction).toBeGreaterThan(0.025);
        expect(fraction).toBeLessThan(0.032);
        for (const theta of [1, 2, 5]) expect(GLARE_K * Math.pow(theta, -GLARE_N)).toBeLessThanOrEqual(10 * Math.pow(theta, -2));
    });

    it('is one overlay in the scene, removed on dispose; sunGlare must be >= 0', () => {
        const scene = new THREE.Scene();
        const dome = createAtmosphericSkyDome(scene, false, { sunElevation: 30 });
        expect(dome.sunGlare).toBeInstanceOf(SunGlare);
        expect(scene.children).toContain(dome.sunGlare!.mesh);
        dome.dispose();
        expect(scene.children).not.toContain(dome.sunGlare!.mesh);
        expect(() => createAtmosphericSkyDome(new THREE.Scene(), false, { sunGlare: -1 })).toThrow(InvalidInputError);
    });

    it('draws nothing into cube captures or at strength 0', () => {
        const make = (strength: number) => new SunGlare({
            sunDirection: () => new THREE.Vector3(0, 0.5, -1).normalize(),
            sunIrradiance: () => new THREE.Color(1, 0.95, 0.9).multiplyScalar(3),
            sunElevationDeg: () => 30,
            skyCube: () => new THREE.CubeTexture(),
            clearDiscLuminance: () => 1,
            skyObjects: () => []
        }, strength);
        const camera = new THREE.PerspectiveCamera();
        const irradiance = (glare: SunGlare) => (glare.mesh.material as THREE.ShaderMaterial).uniforms.uSunIrradiance.value as THREE.Color;
        const cubeRenderer = { getRenderTarget: () => new THREE.WebGLCubeRenderTarget(4) } as unknown as THREE.WebGLRenderer;
        const capture = make(1);
        irradiance(capture).setRGB(1, 1, 1);
        capture.mesh.onBeforeRender(cubeRenderer, new THREE.Scene(), camera, capture.mesh.geometry, capture.mesh.material as THREE.Material, null as never);
        expect(irradiance(capture).getHex()).toBe(0);
        const off = make(0);
        irradiance(off).setRGB(1, 1, 1);
        off.mesh.onBeforeRender({ getRenderTarget: () => null } as unknown as THREE.WebGLRenderer, new THREE.Scene(), camera, off.mesh.geometry, off.mesh.material as THREE.Material, null as never);
        expect(irradiance(off).getHex()).toBe(0);
        capture.dispose(); off.dispose();
    });
});
