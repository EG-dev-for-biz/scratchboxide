/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { applyClayFirstPassBaseline, releaseClayOnMaterialRequest } from '../src/node/gemini/scene3d-clay-baseline';

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

    it('honours an explicit material request but keeps the neutral studio', () => {
        const out = applyClayFirstPassBaseline(modelAuthoredScene(), 'a sports car with glossy PBR materials');
        expect(out.renderMode).toBe('pbr');
        expect(out.features.pbrMaterials).toBe(true);
        expect(out.environment.skybox).toBe('studio');
        expect(out.features).not.toHaveProperty('atmosphericScattering');
    });
});

describe('releaseClayOnMaterialRequest', () => {
    it('leaves clay for pbr when a follow-up asks for materials', () => {
        expect(releaseClayOnMaterialRequest({ renderMode: 'clay' }, 'now paint it rosso corsa', 'clay').renderMode).toBe('pbr');
        expect(releaseClayOnMaterialRequest({ renderMode: 'clay' }, 'make the car red with blue stripes', 'clay').renderMode).toBe('pbr');
        expect(releaseClayOnMaterialRequest({ renderMode: 'clay' }, 'give it a metallic chrome look', 'clay').renderMode).toBe('pbr');
        expect(releaseClayOnMaterialRequest({}, 'apply textures', 'clay').renderMode).toBe('pbr');
        expect(releaseClayOnMaterialRequest({ renderMode: 'shaded' }, 'apply textures', 'clay').renderMode).toBe('shaded');
    });

    it('keeps clay on geometry-only follow-ups even if the model picks another mode', () => {
        expect(releaseClayOnMaterialRequest({ renderMode: 'pbr' }, 'make the spoiler taller', 'clay').renderMode).toBe('clay');
    });

    it('does nothing once the scene has left clay', () => {
        const data = { renderMode: 'pbr' };
        expect(releaseClayOnMaterialRequest(data, 'make the spoiler taller', 'pbr')).toBe(data);
    });
});
