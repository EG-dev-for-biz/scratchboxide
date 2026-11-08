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
import { MATTE_REFLECTION, prepareFacadeMaterials } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/facadeMaterialLook';

describe('the staged twin material look', () => {
    it("draws a rough dielectric's probe reflection in proportion to its fill, and a smooth or metal one whole", async () => {
        const mat = new THREE.MeshStandardMaterial();
        mat.userData.sbMaterial = { provenanceIndices: [] };
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat));
        expect(await prepareFacadeMaterials({ scene, parser: { getDependency: async () => null } })).toBe(1);
        const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
        mat.onBeforeCompile(shader as never, {} as never);
        // the probe's reflection weighed by the hemisphere and ambient fill against the probe's own irradiance, from roughness
        // `from` to `full`, never on metal
        expect(shader.fragmentShader).toContain(`smoothstep( ${MATTE_REFLECTION.from.toFixed(2)}, ${MATTE_REFLECTION.full.toFixed(2)}, material.roughness ) * ( 1.0 - metalnessFactor )`);
        expect(shader.fragmentShader).toContain('dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) )');
        // the weight is applied after the probe's radiance is read and before its diffuse is taken out
        const f = shader.fragmentShader, i = f.indexOf('sbFill'), j = f.indexOf('iblIrradiance *= 0.0');
        expect(f.indexOf('#include <lights_fragment_maps>')).toBeGreaterThan(-1);
        expect(i).toBeGreaterThan(f.indexOf('#include <lights_fragment_maps>'));
        expect(j).toBeGreaterThan(i);
        expect(MATTE_REFLECTION.from).toBeLessThan(MATTE_REFLECTION.full);
        expect(mat.customProgramCacheKey()).toMatch(/^sb-facade-v10:/);
    });
});
