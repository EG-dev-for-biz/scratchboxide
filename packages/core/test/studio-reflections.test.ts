/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Studio reflections: a scene showing authored materials in a studio gets a neutral image-based light (a plain grey
 * room, never drawn as the background), so metals and glass have something to reflect; clay, sky, dark/space and
 * real-place scenes do not. The live check (metal read near black before, as steel after) is in
 * docs/processes/object_build_materials.md.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { classifyAtmosphere, syncAtmosphere, type AtmosphereInput } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';

const STUDIO: AtmosphereInput = { skybox: 'studio', lighting: 'studio', worldBranch: 'procedural/object-from-reference', renderMode: 'pbr', hasGeoCoordinates: false, has3DTiles: false };
const factories = { createVolumetricGodRays: () => ({ dispose: () => undefined }), createProceduralBiomeTerrain: () => ({ dispose: () => undefined }) };

describe('studio reflections', () => {
    it('are on for authored materials in a studio, off for clay, sky, space and real places', () => {
        expect(classifyAtmosphere(STUDIO).studioReflections).toBe(true);
        expect(classifyAtmosphere({ ...STUDIO, renderMode: 'shaded' }).studioReflections).toBe(true);
        expect(classifyAtmosphere({ ...STUDIO, renderMode: 'clay' }).studioReflections).toBe(false);
        expect(classifyAtmosphere({ ...STUDIO, atmosphericScattering: { enabled: true } }).studioReflections).toBe(false);
        expect(classifyAtmosphere({ ...STUDIO, skybox: 'deep_space' }).studioReflections).toBe(false);
        expect(classifyAtmosphere({ ...STUDIO, has3DTiles: true }).studioReflections).toBe(false);
        expect(classifyAtmosphere({ ...STUDIO, hasGeoCoordinates: true }).studioReflections).toBe(false);
    });

    it('leave the background and the scene untouched without a WebGL renderer, and are removed on dispose', () => {
        const scene = new THREE.Scene();
        const stack = { scene, gridHelper: new THREE.GridHelper(20, 20), container: { clientWidth: 800, clientHeight: 600 } as any, renderer: {} as any, camera: new THREE.PerspectiveCamera(), dispose: () => undefined };
        const handle = syncAtmosphere(stack, STUDIO, factories);
        expect(scene.environment).toBeNull();
        expect((scene.background as THREE.Color).getHex()).toBe(classifyAtmosphere(STUDIO).backgroundHex);
        handle.dispose();
        expect(scene.environment).toBeNull();
    });
});
