/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SKY_FILL, prepareFacadeMaterials } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/facadeMaterialLook';

describe('the staged twin material look', () => {
    it("lights a rough dielectric by the probe's irradiance in place of the hemisphere fill, and keeps glass and metal on the fill", async () => {
        const mat = new THREE.MeshStandardMaterial();
        mat.userData.sbMaterial = { provenanceIndices: [] };
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat));
        expect(await prepareFacadeMaterials({ scene, parser: { getDependency: async () => null } })).toBe(1);
        const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
        mat.onBeforeCompile(shader as never, {} as never);
        const f = shader.fragmentShader;
        // the sky's share of the texel's diffuse ramps in with roughness, never on metal
        expect(f).toContain(`float sbSky = smoothstep( ${SKY_FILL.from.toFixed(2)}, ${SKY_FILL.full.toFixed(2)}, material.roughness ) * ( 1.0 - metalnessFactor );`);
        // the hemisphere and ambient fill give way to the probe's irradiance by that share
        expect(f).toContain('irradiance *= 1.0 - sbSky;');
        expect(f).toContain('iblIrradiance *= sbSky;');
        // the reflection is weighed by whichever fill lights the texel against the probe's own light
        expect(f).toContain('radiance *= mix( 1.0, sbFill, sbSky );');
        // all of it after the probe's light is read (lights_fragment_maps) and before the indirect terms are summed
        const at = f.indexOf('#include <lights_fragment_maps>');
        expect(at).toBeGreaterThan(-1);
        expect(f.indexOf('float sbSky')).toBeGreaterThan(at);
        expect(f.indexOf('float sbSky')).toBeLessThan(f.indexOf('#include <lights_fragment_end>'));
        expect(SKY_FILL.from).toBeLessThan(SKY_FILL.full);
        expect(mat.customProgramCacheKey()).toMatch(/^sb-facade-v11:/);
    });
});
