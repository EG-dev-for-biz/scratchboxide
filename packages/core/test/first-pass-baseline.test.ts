/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { applyFirstPassBaseline, firstPassRenderMode, keepOpenSceneRenderMode, userAsksForClay } from '../src/node/gemini/scene3d-first-pass-baseline';
import { DEFAULT_SCENE_RENDER_MODE, sceneRendersClay } from '../src/common/scene-atmosphere-opt-in';

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

describe('applyFirstPassBaseline (textured by default, clay on request)', () => {
    it('keeps the model-authored materials and strips sky and atmosphere the prompt did not ask for', () => {
        const out = applyFirstPassBaseline(modelAuthoredScene(), 'ferarri on road');
        expect(out.renderMode).toBe('pbr');
        expect(out.environment).toEqual({ lighting: 'studio', skybox: 'studio', ground: true });
        expect(out.atmosphere).toBeUndefined();
        for (const key of ['atmosphericScattering', 'godRays', 'diurnalLighting', 'bloomPass']) {
            expect(out.features).not.toHaveProperty(key);
        }
        expect(out.features).toMatchObject({ pbrMaterials: true, multiLayerWeathering: true, ssaoPass: true, studioPedestal: true });
    });

    it('opens textured when the model sends no render mode', () => {
        const { renderMode: _r, ...scene } = modelAuthoredScene();
        const out = applyFirstPassBaseline(scene, 'a lighthouse on a rocky point');
        expect(out.renderMode).toBe('pbr');
        expect(DEFAULT_SCENE_RENDER_MODE).toBe('pbr');
        expect(sceneRendersClay({})).toBe(false);
        expect(sceneRendersClay({ renderMode: 'clay' })).toBe(true);
    });

    it('leaves geometry and geodetic anchoring untouched', () => {
        const src = modelAuthoredScene();
        const out = applyFirstPassBaseline(src, 'ferarri on road');
        expect(out.customMeshes).toEqual(src.customMeshes);
        expect(out.cppGenerator).toEqual(src.cppGenerator);
        expect(out.geoAnchor).toEqual(src.geoAnchor);
    });

    it('honours an explicit atmosphere request', () => {
        const out = applyFirstPassBaseline(modelAuthoredScene(), 'a castle on a cliff at sunset');
        expect(out.renderMode).toBe('pbr');
        expect(out.environment.skybox).toBe('sunset');
        expect(out.features.atmosphericScattering).toBe(true);
        expect(out.atmosphere).toEqual({ enabled: true, timeOfDay: 19 });
    });

    it('builds in clay when the user asks for clay, whatever the model authored', () => {
        for (const prompt of [
            'build a double-decker bus in clay', 'show me the Hagia Sophia as a clay model',
            'an untextured massing model of a stadium', 'greybox a parking garage'
        ]) {
            expect(userAsksForClay(prompt), prompt).toBe(true);
            const out = applyFirstPassBaseline(modelAuthoredScene(), prompt);
            expect(out.renderMode, prompt).toBe('clay');
            // the materials stay authored: switching back to textured shows them again
            expect(out.features, prompt).toHaveProperty('pbrMaterials', true);
        }
    });

    it('takes the model\'s clay when it sends one (it read a clay request the words gate does not)', () => {
        expect(applyFirstPassBaseline({ ...modelAuthoredScene(), renderMode: 'clay' }, 'show only the shape of it').renderMode).toBe('clay');
    });

    it('gives a first-pass camera continuous autofocus and a narrow depth of field by default', () => {
        const src = { ...modelAuthoredScene(), camera: { position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number] } };
        const out = applyFirstPassBaseline(src, 'ferarri on road');
        expect(out.camera.lens).toEqual({ depthOfField: true, focusMode: 'auto', apertureFStop: 2.8 });
        // position and target themselves are untouched
        expect(out.camera.position).toEqual(src.camera.position);
        expect(out.camera.target).toEqual(src.camera.target);
    });

    it('keeps a model-authored lens unchanged (no default forced over it)', () => {
        const lens = { depthOfField: false, focusMode: 'manual' as const, focusDistanceMeters: 12 };
        const src = { ...modelAuthoredScene(), camera: { position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], lens } };
        const out = applyFirstPassBaseline(src, 'ferarri on road');
        expect(out.camera.lens).toEqual(lens);
    });

    it('adds no camera field when the model sent none (a scene with no camera stays that way)', () => {
        const out = applyFirstPassBaseline(modelAuthoredScene(), 'ferarri on road');
        expect(out.camera).toBeUndefined();
    });

    it('colour or material words never decide the render mode', () => {
        for (const prompt of ['build the Blue Mosque in Istanbul', 'build a red double-decker bus', 'a sports car with glossy PBR materials', 'Green Park, London']) {
            expect(userAsksForClay(prompt), prompt).toBe(false);
            expect(firstPassRenderMode(prompt), prompt).toBe('pbr');
        }
    });
});

describe('keepOpenSceneRenderMode', () => {
    it('keeps the open scene\'s render mode when the model sends none: a clay choice persists', () => {
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
