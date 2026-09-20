/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    kelvinToRgb,
    CINEMATIC_RIGS,
    buildThreeJsLightingRig,
    computeSceneBudgetTelemetry
} from '../src/browser/generative-canvas/primitives/scene3d/lightingRigs';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Light 3D Scenes & Cinematic Lighting Mastery', () => {

    describe('1. Planckian Blackbody Kelvin Color Conversion', () => {
        it('should accurately compute warm tungsten/candle tones (1850K - 2800K)', () => {
            const candle = kelvinToRgb(1850);
            expect(candle.r).toBeGreaterThan(0.9);
            expect(candle.g).toBeLessThan(candle.r);
            expect(candle.b).toBeLessThan(0.1); // Warm amber candle flame

            const tungsten = kelvinToRgb(2800);
            expect(tungsten.r).toBeGreaterThan(0.9);
            expect(tungsten.g).toBeGreaterThan(0.3);
            expect(tungsten.b).toBeGreaterThan(candle.b);
        });

        it('should accurately compute neutral daylight and cool sky tones (5600K - 7500K)', () => {
            const daylight = kelvinToRgb(5600);
            expect(daylight.r).toBeGreaterThan(0.7);
            expect(daylight.g).toBeGreaterThan(0.7);
            expect(daylight.b).toBeGreaterThan(0.7);

            const coolSky = kelvinToRgb(7500);
            expect(coolSky.b).toBeGreaterThan(0.95);
            expect(coolSky.b).toBeGreaterThan(coolSky.r); // Blue-rich cool sky
        });
    });

    describe('2. Cinematic & Studio Lighting Rigs Catalog', () => {
        it('should export all 8 cinematic and studio lighting rigs with complete physical properties', () => {
            const expectedRigs = [
                'three_point_studio',
                'rembrandt_chiaroscuro',
                'paramount_glamour',
                'film_noir_split',
                'golden_hour_sunset',
                'cyberpunk_dual_rim',
                'torchlight_campfire',
                'high_key_product'
            ];

            for (const rigKey of expectedRigs) {
                const rig = CINEMATIC_RIGS[rigKey];
                expect(rig).toBeDefined();
                expect(rig.name).toBe(rigKey);
                expect(rig.label.length).toBeGreaterThan(0);
                expect(rig.description.length).toBeGreaterThan(0);
                expect(rig.lights.length).toBeGreaterThan(0);
            }
        });

        it('should build Three.js light instances with proper shadow casting and attenuation', () => {
            const studioLights = buildThreeJsLightingRig('three_point_studio');
            expect(Array.isArray(studioLights)).toBe(true);
            // Punctual lights + ambient light
            expect(studioLights.length).toBe(CINEMATIC_RIGS.three_point_studio.lights.length + 1);

            // Three-point rig should have point/directional key light with shadow casting
            const hasShadowCaster = studioLights.some(l => l.castShadow);
            expect(hasShadowCaster).toBe(true);

            // Rembrandt rig should have steep angle key light
            const rembrandtLights = buildThreeJsLightingRig('rembrandt_chiaroscuro');
            expect(rembrandtLights.some(l => l instanceof THREE.SpotLight)).toBe(true);
            expect(rembrandtLights.length).toBeGreaterThanOrEqual(4);

            // Cyberpunk rig should feature dual rim kickers
            const cyberpunkLights = buildThreeJsLightingRig('cyberpunk_dual_rim');
            expect(cyberpunkLights.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('3. Lightweight Scene Budget Telemetry & Performance Analyzer', () => {
        it('should evaluate empty or lightweight scenes as within web budget (60 FPS)', () => {
            const scene = new THREE.Scene();
            const geometry = new THREE.BoxGeometry(1, 1, 1);
            const material = new THREE.MeshStandardMaterial({ color: 0x336699 });
            const mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);

            const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
            dirLight.castShadow = true;
            scene.add(dirLight);

            const telemetry = computeSceneBudgetTelemetry(scene);
            expect(telemetry.meshCount).toBe(1);
            expect(telemetry.totalVertices).toBe(24);
            expect(telemetry.totalTriangles).toBe(12);
            expect(telemetry.lightCount).toBe(1);
            expect(telemetry.shadowCasters).toBe(1);
            expect(telemetry.withinWebBudget).toBe(true);
            expect(telemetry.estimatedFps).toBe(60);
            expect(telemetry.estimatedFrameTimeMs).toBeLessThan(16.7);
        });

        it('should generate optimization recommendations when polygon budget or shadow count is high', () => {
            const scene = new THREE.Scene();
            // Add high poly sphere
            const highPolySphere = new THREE.SphereGeometry(5, 128, 128);
            const mesh = new THREE.Mesh(highPolySphere, new THREE.MeshStandardMaterial());
            scene.add(mesh);

            // Add 4 shadow-casting lights
            for (let i = 0; i < 4; i++) {
                const light = new THREE.SpotLight(0xffffff, 1.0);
                light.castShadow = true;
                scene.add(light);
            }

            const telemetry = computeSceneBudgetTelemetry(scene);
            expect(telemetry.shadowCasters).toBe(4);
            expect(telemetry.recommendations.some(r => r.includes('shadow casting'))).toBe(true);
        });
    });

    describe('4. Direct Dispatch Operators for Lighting & Budget Optimization', () => {
        it('should execute sb_setup_lighting_rig operator to configure cinematic rigs', () => {
            const initialScene: Scene3DData = {
                id: 'test_scene_1',
                title: 'Test Lighting Rig',
                environment: {
                    cinematicRig: 'three_point_studio',
                    lightingKelvin: 5600
                }
            };

            const engine = createOperatorEngine(initialScene);
            const result = engine.dispatch('sb_setup_lighting_rig', {
                preset: 'golden_hour_sunset',
                kelvin: 2400
            });

            expect(result.success).toBe(true);
            expect(result.data.rig).toBe('golden_hour_sunset');
            expect(engine.getSceneData().environment?.cinematicRig).toBe('golden_hour_sunset');
            expect(engine.getSceneData().environment?.lightingKelvin).toBe(2400);
        });

        it('should execute sb_add_light operator to add punctual lights with physical Kelvin and falloff', () => {
            const initialScene: Scene3DData = {
                id: 'test_scene_2',
                title: 'Test Light Creation',
                environment: {}
            };

            const threeScene = new THREE.Scene();
            const engine = createOperatorEngine(initialScene);
            engine.attachThreeScene(threeScene);

            const result = engine.dispatch('sb_add_light', {
                type: 'spot',
                kelvin: 3200,
                intensity: 1500,
                position: [0, 5, 2],
                direction: [0, -1, 0],
                castShadow: true,
                innerConeAngle: 0.3,
                outerConeAngle: 0.8
            });

            expect(result.success).toBe(true);
            expect(result.data.totalCustomLights).toBe(1);

            // Three.js scene should have the new light added
            const addedLight = threeScene.children.find(c => c instanceof THREE.SpotLight) as THREE.SpotLight | undefined;
            expect(addedLight).toBeDefined();
            expect(addedLight?.castShadow).toBe(true);
        });

        it('should execute sb_optimize_light_budget operator to analyze and trim shadow casters', () => {
            const initialScene: Scene3DData = {
                id: 'test_scene_3',
                title: 'Test Budget Optimization',
                environment: {}
            };

            const threeScene = new THREE.Scene();
            for (let i = 0; i < 4; i++) {
                const light = new THREE.DirectionalLight(0xffffff, 1.0);
                light.castShadow = true;
                threeScene.add(light);
            }

            const engine = createOperatorEngine(initialScene);
            engine.attachThreeScene(threeScene);

            const result = engine.dispatch('sb_optimize_light_budget', {
                maxShadowCasters: 2,
                autoApply: true
            });

            expect(result.success).toBe(true);
            expect(result.data.telemetry.shadowCasters).toBeLessThanOrEqual(2);
            expect(result.data.autoApplied).toBe(true);
        });
    });
});
