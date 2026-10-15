/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { applyClayFirstPassBaseline, keepOpenSceneRenderMode } from '../src/node/gemini/scene3d-clay-baseline';

/** Shape of what Gemini actually mounted for the prompt "ferarri on road". */
const modelAuthoredScene = () => ({
    title: 'Ferrari Supercar on Mountain Highway',
    renderMode: 'pbr',
    environment: { lighting: 'golden_hour', skybox: 'sunset', ground: true, fog: true, lightingKelvin: 3200 },
    atmosphere: { enabled: true, timeOfDay: 19 },
    features: {
        pbrMaterials: true, curvatureAO: true, multiLayerWeathering: true, cinematic3PointLighting: true,
        studioPedestal: true, atmosphericScattering: true, ssaoPass: true, diurnalLighting: true,
        godRays: true, bloomPass: true
    },
    customMeshes: [{ id: 'car-body-main', type: 'box', position: [0, 0.48, 0], material: { color: '#dc143c' } }],
    cppGenerator: { enabled: true, sourceCode: '#include "scratchbox_engine.hpp"\n' },
    geoAnchor: { active: true, lat: 40.6333, lng: 14.6029 }
});

describe('applyClayFirstPassBaseline', () => {
    it('strips model-authored sky, atmosphere and materials from a first-pass scene', () => {
        const out = applyClayFirstPassBaseline(modelAuthoredScene(), 'ferarri on road');
        expect(out.renderMode).toBe('clay');
        expect(out.environment).toEqual({ lighting: 'studio', skybox: 'studio', ground: true });
        expect(out.atmosphere).toBeUndefined();
        for (const key of ['atmosphericScattering', 'godRays', 'diurnalLighting', 'bloomPass', 'pbrMaterials', 'multiLayerWeathering']) {
            expect(out.features).not.toHaveProperty(key);
        }
        expect(out.features).toMatchObject({ ssaoPass: true, studioPedestal: true });
    });

    it('leaves geometry and geodetic anchoring untouched', () => {
        const src = modelAuthoredScene();
        const out = applyClayFirstPassBaseline(src, 'ferarri on road');
        expect(out.customMeshes).toEqual(src.customMeshes);
        expect(out.cppGenerator).toEqual(src.cppGenerator);
        expect(out.geoAnchor).toEqual(src.geoAnchor);
    });

    it('honours an explicit atmosphere request but keeps clay surfaces', () => {
        const out = applyClayFirstPassBaseline(modelAuthoredScene(), 'a castle on a cliff at sunset');
        expect(out.renderMode).toBe('clay');
        expect(out.environment.skybox).toBe('sunset');
        expect(out.features.atmosphericScattering).toBe(true);
        expect(out.atmosphere).toEqual({ enabled: true, timeOfDay: 19 });
    });

    it('builds every first pass in clay, whatever colour or material words the prompt has', () => {
        // Colour words decide nothing: "Blue Mosque" and "Hagia Sophia", "red bus" and "bus" are all clay.
        for (const prompt of [
            'build the Blue Mosque in Istanbul', 'build the Hagia Sophia in Istanbul',
            'build a red double-decker bus', 'build a double-decker bus',
            'a sports car with glossy PBR materials', 'Green Park, London'
        ]) {
            const out = applyClayFirstPassBaseline(modelAuthoredScene(), prompt);
            expect(out.renderMode, prompt).toBe('clay');
            expect(out.features, prompt).not.toHaveProperty('pbrMaterials');
            expect(out.environment.skybox, prompt).toBe('studio');
        }
    });
});

describe('keepOpenSceneRenderMode', () => {
    it('keeps the open scene\'s render mode when the model sends none', () => {
        expect(keepOpenSceneRenderMode({}, 'clay').renderMode).toBe('clay');
        expect(keepOpenSceneRenderMode({ title: 'x' }, 'pbr').renderMode).toBe('pbr');
    });

    it('takes the model\'s render mode when it sends one: leaving clay is the model\'s call', () => {
        expect(keepOpenSceneRenderMode({ renderMode: 'pbr' }, 'clay').renderMode).toBe('pbr');
        expect(keepOpenSceneRenderMode({ renderMode: 'clay' }, 'pbr').renderMode).toBe('clay');
    });

    it('does nothing when there is no open render mode', () => {
        const data = { renderMode: undefined };
        expect(keepOpenSceneRenderMode(data, undefined)).toBe(data);
    });
});
