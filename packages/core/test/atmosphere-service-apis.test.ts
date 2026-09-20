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
    AtmosphereService,
    VolumetricGodRays,
    createVolumetricGodRays,
    SphericalHarmonics9,
    marchVolumetrics,
    henyeyGreensteinPhase,
    rayleighPhase,
    dualLobePhase,
    evaluateDensityAtHeight,
    calculateNOAASolarPosition,
    classifyDiurnalPhase,
    computeDiurnalLightingProfile,
    getPresetLightingState
} from '../src/browser';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    createDefaultToolRegistry,
    atmosphereHandlers,
    ATMOSPHERE_TOOL_DECLARATIONS
} from '../src/node/gemini/tool-registry';

describe('Atmospheric Capabilities First-Class APIs', () => {
    describe('volumetric-participating-media & Phase Functions', () => {
        it('calculates Henyey-Greenstein, Rayleigh, and dual-lobe phase functions', () => {
            const forwardPhase = henyeyGreensteinPhase(1.0, 0.8);
            const backwardPhase = henyeyGreensteinPhase(-1.0, 0.8);
            expect(forwardPhase).toBeGreaterThan(backwardPhase);

            const rayleighForward = rayleighPhase(1.0);
            const rayleighPerp = rayleighPhase(0.0);
            expect(rayleighForward).toBeGreaterThan(rayleighPerp);

            const dual = dualLobePhase(0.5, 0.75, -0.25, 0.85);
            expect(dual).toBeGreaterThan(0);
        });

        it('evaluates height-dependent medium density with exponential falloff', () => {
            const groundDensity = evaluateDensityAtHeight(0, { groundLevel: 0, density: 0.1, heightScale: 10 });
            const highDensity = evaluateDensityAtHeight(20, { groundLevel: 0, density: 0.1, heightScale: 10 });
            expect(groundDensity).toBeCloseTo(0.1, 4);
            expect(highDensity).toBeLessThan(groundDensity);
        });

        it('marches volumetrics and produces inscattered radiance with optical extinction', () => {
            const ro: [number, number, number] = [0, 2, 0];
            const rd: [number, number, number] = [0, 0, 1];
            const lightPos: [number, number, number] = [0, 50, 50];
            const lightColor: [number, number, number] = [1.0, 0.9, 0.8];

            const result = marchVolumetrics(ro, rd, 100, lightPos, lightColor, 5.0, {
                density: 0.05,
                heightScale: 8.0,
                anisotropy: 0.7
            }, 16);

            expect(result.transmittance).toBeGreaterThan(0.0);
            expect(result.transmittance).toBeLessThanOrEqual(1.0);
            expect(result.inscatteredRadiance[0]).toBeGreaterThan(0.0);
            expect(result.inscatteredRadiance[1]).toBeGreaterThan(0.0);
        });

        it('evaluates 9-coefficient Spherical Harmonics ambient irradiance', () => {
            const shGolden = SphericalHarmonics9.getSkyGoldenHourSH();
            const normalUp = new THREE.Vector3(0, 1, 0);
            const irradianceUp = shGolden.evaluateIrradiance(normalUp);
            expect(irradianceUp[0]).toBeGreaterThan(0);
            expect(irradianceUp[1]).toBeGreaterThan(0);
            expect(irradianceUp[2]).toBeGreaterThan(0);

            const shForest = SphericalHarmonics9.getSkyForestCanopySH();
            const irradianceForest = shForest.evaluateIrradiance([0, 1, 0]);
            expect(irradianceForest[1]).toBeGreaterThan(0); // High green component in forest
        });
    });

    describe('VolumetricGodRays Class & Factory', () => {
        it('instantiates, updates, and disposes volumetric god rays cleanly', () => {
            const scene = new THREE.Scene();
            const godRays = new VolumetricGodRays(scene, new THREE.Vector3(50, 70, 50), false, {
                intensity: 0.4,
                spreadRadius: 6.0,
                rayCount: 6
            });

            expect(godRays.group.children.length).toBe(6);
            expect(godRays.group.name).toBe('volumetric-god-rays');

            // Update time
            godRays.update(2.5, 0.016);
            expect(godRays.rayMaterial.uniforms.uTime.value).toBe(2.5);

            // Re-target sun
            godRays.setSunPosition(new THREE.Vector3(20, 30, 20));
            godRays.setIntensity(0.5);
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBe(0.5);

            godRays.setColor('#ffcc88');
            expect(godRays.rayMaterial.uniforms.uColor.value.r).toBeGreaterThan(0.9);

            godRays.dispose();
            expect(scene.children.includes(godRays.group)).toBe(false);
        });

        it('createVolumetricGodRays factory conforms to expected module interface', () => {
            const scene = new THREE.Scene();
            const mod = createVolumetricGodRays(scene, new THREE.Vector3(10, 20, 10), true);
            expect(mod.group).toBeDefined();
            mod.update(1.0, 0.016);
            mod.dispose();
        });
    });

    describe('AtmosphereService Unified Facade', () => {
        it('exposes complete static mathematical, radiometric, and ephemeris APIs', () => {
            const ephemeris = AtmosphereService.calculateSolarPosition(
                new Date('2026-06-21T20:00:00Z'),
                37.77,
                -122.41
            );
            expect(ephemeris.elevationDeg).toBeGreaterThan(45.0);

            const phase = AtmosphereService.classifyDiurnalPhase(ephemeris.elevationDeg);
            expect(phase).toBe('Midday');

            const profile = AtmosphereService.computeDiurnalProfile(45.0);
            expect(profile.phase).toBe('Afternoon');
            expect(profile.kelvinTemperature).toBeGreaterThan(5000);

            const presetState = AtmosphereService.getPresetLightingState('golden_hour');
            expect(presetState.elevationDeg).toBeCloseTo(5.2, 1);
            expect(presetState.kelvin).toBe(3200);

            const kelvinColor = AtmosphereService.kelvinToRGB(5500);
            expect(kelvinColor.r).toBeGreaterThan(0.8);
            const linearRgb = AtmosphereService.blackbodyKelvinToLinearRgb(5500);
            expect(linearRgb.length).toBe(3);

            const transmittance = AtmosphereService.computeBeerLambertTransmittance(1000, 2.0, 0.005, 2.5, 8000);
            expect(transmittance.r).toBeGreaterThan(0.0);
            expect(transmittance.r).toBeLessThan(1.0);

            const inscatter = AtmosphereService.computeInscatteringRadiance(1000);
            expect(inscatter.r).toBeGreaterThanOrEqual(0.0);
        });

        it('attaches to Three.js scene and coordinates sky dome, god rays, and updates', () => {
            const scene = new THREE.Scene();
            const atmosphere = new AtmosphereService({
                rayleigh: 2.2,
                mie: 0.006,
                cloudCoverage: 0.5
            });

            const handle = atmosphere.attach(scene, {}, {
                enableSkyDome: true,
                enableGodRays: true,
                enableCloudShadows: true
            });

            expect(handle.skyDomeModule).toBeDefined();
            expect(handle.godRays).toBeDefined();
            expect(handle.cloudShadows).toBeDefined();

            atmosphere.setDiurnalTimeOfDay(17.5);
            expect(atmosphere.config.timeOfDay).toBe(17.5);

            atmosphere.setClouds(0.7, 0.9, 150.0);
            expect(atmosphere.config.cloudCoverage).toBe(0.7);

            atmosphere.update(1.0, 0.016);

            atmosphere.dispose();
            expect(atmosphere.skyDomeModule).toBeUndefined();
            expect(atmosphere.godRays).toBeUndefined();
        });
    });

    describe('Direct Dispatch Atmospheric Operators', () => {
        it('registers and executes sb_configure_atmospheric_scattering', () => {
            const sceneData: any = { features: {} };
            const engine = createOperatorEngine(sceneData);

            const result = engine.executeOperator('sb_configure_atmospheric_scattering', {
                rayleigh: 3.5,
                mie: 0.01,
                cloudCoverage: 0.65,
                volumetricClouds: true
            });

            expect(result.success).toBe(true);
            const features = engine.getSceneData().features as any;
            expect(features.atmosphericScattering.rayleigh).toBe(3.5);
            expect(features.atmosphericScattering.cloudCoverage).toBe(0.65);
            expect(features.atmosphericScattering.volumetricClouds).toBe(true);
        });

        it('registers and executes sb_set_diurnal_time_of_day with presets and geo-coordinates', () => {
            const sceneData: any = { features: {} };
            const engine = createOperatorEngine(sceneData);

            // Preset
            const resPreset = engine.executeOperator('sb_set_diurnal_time_of_day', {
                preset: 'golden_hour'
            });
            expect(resPreset.success).toBe(true);
            expect(resPreset.data.phase).toBe('Golden Hour');
            const featuresPreset = engine.getSceneData().features as any;
            expect(featuresPreset.atmosphericScattering.sunElevation).toBeCloseTo(5.2, 1);

            // Geo coordinates
            const resGeo = engine.executeOperator('sb_set_diurnal_time_of_day', {
                latitude: 37.77,
                longitude: -122.41,
                isoDate: '2026-06-21T20:00:00Z'
            });
            expect(resGeo.success).toBe(true);
            expect(resGeo.data.elevation).toBeGreaterThan(45);
        });

        it('registers and executes sb_configure_aerial_perspective, cloud shadows, and god rays', () => {
            const sceneData: any = { features: {} };
            const engine = createOperatorEngine(sceneData);

            const resAerial = engine.executeOperator('sb_configure_aerial_perspective', {
                enabled: true,
                inscatteringIntensity: 0.85,
                aerialPerspectiveRange: 6000
            });
            expect(resAerial.success).toBe(true);
            let features = engine.getSceneData().features as any;
            expect(features.atmosphericScattering.aerialPerspectiveEnabled).toBe(true);

            const resShadows = engine.executeOperator('sb_configure_terrain_cloud_shadows', {
                enabled: true,
                cloudShadowIntensity: 0.6,
                cloudShadowScale: 220
            });
            expect(resShadows.success).toBe(true);
            features = engine.getSceneData().features as any;
            expect(features.atmosphericScattering.cloudShadowsEnabled).toBe(true);

            const resRays = engine.executeOperator('sb_add_volumetric_god_rays', {
                enabled: true,
                intensity: 0.35,
                color: '#fff0d0'
            });
            expect(resRays.success).toBe(true);
            features = engine.getSceneData().features as any;
            expect(features.godRays.enabled).toBe(true);
        });
    });

    describe('Gemini Agent Tool Registry & Handlers', () => {
        it('registers atmosphere tools in the default tool registry', () => {
            const registry = createDefaultToolRegistry();
            const names = registry.names('workspace');

            expect(names).toContain('atmosphere_calculate_solar_position');
            expect(names).toContain('atmosphere_get_diurnal_profile');
            expect(names).toContain('atmosphere_configure_scene');
        });

        it('executes atmosphere_calculate_solar_position tool handler', () => {
            const outcome = atmosphereHandlers.atmosphere_calculate_solar_position(
                { latitude: 37.77, longitude: -122.41, isoDate: '2026-06-21T20:00:00Z' },
                {} as any
            );
            expect(outcome.resultPayload.success).toBe(true);
            expect(outcome.resultPayload.elevationDeg).toBeGreaterThan(45);
            expect(outcome.resultPayload.phase).toBe('Midday');
            expect(outcome.summaryResult).toContain('Calculated NOAA solar ephemeris');
        });

        it('executes atmosphere_get_diurnal_profile tool handler', () => {
            const outcome = atmosphereHandlers.atmosphere_get_diurnal_profile(
                { elevationDeg: 5.0 },
                {} as any
            );
            expect(outcome.resultPayload.success).toBe(true);
            expect(outcome.resultPayload.phase).toBe('Golden Hour');
            expect(outcome.resultPayload.kelvinTemperature).toBeGreaterThan(3000);
            expect(outcome.resultPayload.kelvinTemperature).toBeLessThan(4500);
        });

        it('executes atmosphere_configure_scene tool handler', () => {
            const outcome = atmosphereHandlers.atmosphere_configure_scene(
                { preset: 'sunset', enableAerialPerspective: true, enableGodRays: true },
                {} as any
            );
            expect(outcome.resultPayload.success).toBe(true);
            expect(outcome.resultPayload.phase).toBe('Golden Hour');
            expect((outcome.resultPayload.config as any).godRays).toBeDefined();
        });
    });
});
