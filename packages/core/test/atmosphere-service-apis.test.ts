/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { InvalidInputError, MissingInputError } from '../src/common/errors/pipeline-errors';
import { calculateNOAASolarPosition } from '../src/browser/generative-canvas/services/atmosphere/solar-position';
import { instantAtLocalMeanSolarTime } from '../src/common/coordinate/solarPosition';
import { createAtmosphericSkyDome } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';
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

    describe('golden hour\'s softer shadow edge reaches the actual sun light', () => {
        it('sets sunLight.shadow.radius from diurnalProfile.shadowSoftness (was computed but never applied)', () => {
            const golden = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 3, sunAzimuth: 180 });
            expect(golden.diurnalProfile.isGoldenHour).toBe(true);
            expect(golden.diurnalProfile.shadowSoftness).toBeCloseTo(1.8, 6);
            expect(golden.sunLight.shadow!.radius).toBeCloseTo(1.8, 6);

            const midday = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 45, sunAzimuth: 180 });
            expect(midday.diurnalProfile.isGoldenHour).toBe(false);
            expect(midday.sunLight.shadow!.radius).toBeCloseTo(1, 6);
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

        it('a cloud in front of the sun dims and diffuses the rays, composed with (not replacing) the configured intensity', () => {
            const scene = new THREE.Scene();
            const godRays = new VolumetricGodRays(scene, new THREE.Vector3(50, 70, 50), false, { intensity: 0.4 });
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBe(0.4);

            // a thick cloud (SunGlare's cloudVisibility 0.2) dims the rays to a fifth of the configured intensity
            godRays.setCloudVisibility(0.2);
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBeCloseTo(0.08, 6);

            // the cloud clears: back to the full configured intensity
            godRays.setCloudVisibility(1);
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBeCloseTo(0.4, 6);

            // changing the configured intensity while a cloud still covers the sun keeps it dimmed by the same share
            godRays.setCloudVisibility(0.5);
            godRays.setIntensity(0.6);
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBeCloseTo(0.3, 6);

            // out of range visibility is clamped, never inverted or amplified
            godRays.setCloudVisibility(-1);
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBeCloseTo(0, 6);
            godRays.setCloudVisibility(5);
            expect(godRays.rayMaterial.uniforms.uIntensity.value).toBeCloseTo(0.6, 6);
        });

        it('createVolumetricGodRays factory conforms to expected module interface', () => {
            const scene = new THREE.Scene();
            const mod = createVolumetricGodRays(scene, new THREE.Vector3(10, 20, 10), true);
            expect(mod.group).toBeDefined();
            mod.update(1.0, 0.016);
            mod.setCloudVisibility(0.5);
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
            // The direct beam at 45° through clear air is about 4500-5600 K (the sun itself is ~5800 K before the air).
            expect(profile.kelvinTemperature).toBeGreaterThan(4500);
            expect(profile.kelvinTemperature).toBeLessThan(5600);

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
            // the dome sits gigantic and centred exactly on the camera (followCamera): three's default per-object
            // frustum test is least reliable at exactly that size/distance and can wrongly cull the whole sky
            // depending on framing (confirmed live - a built scene's sky silently failed to draw). Never culled.
            expect(handle.skyDomeModule.skyDome.frustumCulled).toBe(false);

            atmosphere.setDiurnalTimeOfDay(17.5, 37.77, -122.41);
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

        it('sb_set_diurnal_time_of_day: timeOfDay places the sun at local mean solar time at the location', () => {
            const engine = createOperatorEngine({ features: {} } as any);
            const res = engine.executeOperator('sb_set_diurnal_time_of_day', { latitude: 40.73, longitude: -73.99, timeOfDay: 9, isoDate: '2026-03-20T00:00:00Z' });
            expect(res.success).toBe(true);
            const expected = calculateNOAASolarPosition(instantAtLocalMeanSolarTime(2026, 2, 20, 9, -73.99), 40.73, -73.99);
            expect(res.data.elevation).toBeCloseTo(expected.elevationDeg, 6);
            expect(res.data.azimuth).toBeCloseTo(expected.azimuthDeg, 6);
            expect((engine.getSceneData().features as any).atmosphericScattering.timeOfDay).toBe(9);
        });

        it('sb_set_diurnal_time_of_day: timeOfDay is kept only while it is what placed the sun', () => {
            const engine = createOperatorEngine({ features: {} } as any);
            expect(engine.executeOperator('sb_set_diurnal_time_of_day', { latitude: 40.73, longitude: -73.99, timeOfDay: 9 }).success).toBe(true);
            expect(engine.executeOperator('sb_set_diurnal_time_of_day', { preset: 'night' }).success).toBe(true);
            expect((engine.getSceneData().features as any).atmosphericScattering.timeOfDay).toBeUndefined();
            // A time alongside another sun source is a contradiction, not something to drop silently
            const both = engine.executeOperator('sb_set_diurnal_time_of_day', { preset: 'night', timeOfDay: 12, latitude: 40.73, longitude: -73.99 });
            expect(both.success).toBe(false);
            expect(both.error).toMatch(/timeOfDay/);
        });

        it('getPresetLightingState: an unknown or empty preset is a typed error, not midday', () => {
            expect(() => getPresetLightingState('neon')).toThrow(InvalidInputError);
            expect(() => getPresetLightingState('')).toThrow(InvalidInputError);
            expect(() => getPresetLightingState('neon')).toThrow(/golden_hour/);
            expect(getPresetLightingState('Golden_Hour').elevationDeg).toBeCloseTo(5.2, 6);
            const engine = createOperatorEngine({ features: {} } as any);
            const res = engine.executeOperator('sb_set_diurnal_time_of_day', { preset: 'neon' });
            expect(res.success).toBe(false);
            expect(res.errorCode).toBe('invalid_input');
        });

        it('sb_setup_lighting: a lighting name that is not a time-of-day preset sets no sun', () => {
            const engine = createOperatorEngine({ features: {}, environment: {} } as any);
            const res = engine.executeOperator('sb_setup_lighting', { preset: 'neon' });
            expect(res.success).toBe(true);
            expect(res.data.sunElevation).toBeUndefined();
            expect((engine.getSceneData() as any).environment.lighting).toBe('neon');
            // ...and atmosphere, which needs a sun, says so
            const atm = engine.executeOperator('sb_setup_lighting', { preset: 'neon', enableAtmosphere: true });
            expect(atm.success).toBe(false);
        });

        it('AtmosphereService.setDiurnalTimeOfDay needs a location; it does not assume one', () => {
            const atmosphere = new AtmosphereService({});
            atmosphere.attach(new THREE.Scene(), {}, { enableSkyDome: true });
            expect(() => atmosphere.setDiurnalTimeOfDay(17.5)).toThrow(MissingInputError);
            expect(atmosphere.config.timeOfDay).toBeUndefined();
            expect(() => createAtmosphericSkyDome(new THREE.Scene(), false, { timeOfDay: 8 })).toThrow(MissingInputError);
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
            // A sun 5° up crosses ~10 air masses: a deep orange beam of roughly 2000-3200 K.
            expect(outcome.resultPayload.kelvinTemperature).toBeGreaterThan(2000);
            expect(outcome.resultPayload.kelvinTemperature).toBeLessThan(3200);
            expect(outcome.resultPayload.kelvinSource).toBe('spectral-beam');
        });

        it('executes atmosphere_configure_scene tool handler', () => {
            const outcome = atmosphereHandlers.atmosphere_configure_scene(
                { preset: 'sunset', enableAerialPerspective: true, enableGodRays: true },
                {} as any
            );
            // no 3D scene is open: the sun is computed but nothing is lit, and the result says so
            expect(outcome.resultPayload.success).toBe(false);
            expect(outcome.resultPayload.applied).toBe(false);
            expect(outcome.summaryResult).toMatch(/^NOT applied: no 3D scene is open/);
            expect(outcome.resultPayload.phase).toBe('Golden Hour');
            const cfg = outcome.resultPayload.config as any;
            expect(cfg.godRays).toEqual({ enabled: true });
            // Clouds and cloud shadows were not asked for, so none are added (they used to be always on at 45%).
            expect(cfg.volumetricClouds).toBe(false);
            expect(cfg.cloudShadowsEnabled).toBe(false);
            expect(cfg.cloudCoverage).toBeUndefined();
            expect(cfg.aerialPerspectiveEnabled).toBe(true);
            // No canned scattering constants.
            expect(cfg.rayleigh).toBeUndefined();
            expect(cfg.mie).toBeUndefined();
            expect(cfg.inscatteringIntensity).toBeUndefined();
        });

        it('atmosphere_configure_scene adds clouds only when a coverage is given; aerial perspective comes with the sky unless turned off', () => {
            const plain = atmosphereHandlers.atmosphere_configure_scene({ sunElevationDeg: 30, sunAzimuthDeg: 200 }, {} as any);
            const plainCfg = plain.resultPayload.config as any;
            expect(plainCfg.volumetricClouds).toBe(false);
            expect(plainCfg.aerialPerspectiveEnabled).toBe(true);
            const off = atmosphereHandlers.atmosphere_configure_scene({ sunElevationDeg: 30, sunAzimuthDeg: 200, enableAerialPerspective: false }, {} as any);
            expect((off.resultPayload.config as any).aerialPerspectiveEnabled).toBe(false);
            expect(plainCfg.godRays).toBeUndefined();
            expect(plainCfg.sunElevation).toBe(30);

            const cloudy = atmosphereHandlers.atmosphere_configure_scene({ sunElevationDeg: 30, sunAzimuthDeg: 200, cloudCoverage: 0.3, enableCloudShadows: true }, {} as any);
            const cloudyCfg = cloudy.resultPayload.config as any;
            expect(cloudyCfg.volumetricClouds).toBe(true);
            expect(cloudyCfg.cloudCoverage).toBe(0.3);
            expect(cloudyCfg.cloudShadowsEnabled).toBe(true);
            expect(cloudyCfg.cloudAltitude).toBeUndefined();
        });

        it('atmosphere_configure_scene needs a time for coordinates and a sun from somewhere (no "now", no 45/180 default)', () => {
            expect(() => atmosphereHandlers.atmosphere_configure_scene({ latitude: 41.89, longitude: 12.49 }, {} as any)).toThrow(MissingInputError);
            expect(() => atmosphereHandlers.atmosphere_configure_scene({}, {} as any)).toThrow(MissingInputError);
            const iso = '2026-06-21T09:00:00Z';
            const res = atmosphereHandlers.atmosphere_configure_scene({ latitude: 41.89, longitude: 12.49, isoDate: iso }, {} as any);
            const ephem = calculateNOAASolarPosition(new Date(iso), 41.89, 12.49);
            expect((res.resultPayload.config as any).sunElevation).toBeCloseTo(ephem.elevationDeg, 9);
            expect((res.resultPayload.config as any).sunAzimuth).toBeCloseTo(ephem.azimuthDeg, 9);
            expect(() => atmosphereHandlers.atmosphere_calculate_solar_position({ latitude: 41.89, longitude: 12.49 }, {} as any)).toThrow(MissingInputError);
        });

        it('atmosphere_get_diurnal_profile uses the turbidity it is given', () => {
            const clear = atmosphereHandlers.atmosphere_get_diurnal_profile({ elevationDeg: 10, turbidity: 2 }, {} as any).resultPayload as any;
            const hazy = atmosphereHandlers.atmosphere_get_diurnal_profile({ elevationDeg: 10, turbidity: 8 }, {} as any).resultPayload as any;
            expect(clear.turbidity).toBe(2);
            expect(hazy.turbidity).toBe(8);
            expect(clear.kelvinSource).toBe('spectral-beam');
            expect(clear.turbidityUsed).toBe(2);
            // More aerosol scatters more blue out of the beam: a warmer (lower CCT), redder sun.
            expect(hazy.kelvinTemperature).toBeLessThan(clear.kelvinTemperature);
            expect(hazy.directSunTransmittance[2]).toBeLessThan(clear.directSunTransmittance[2]);
            const none = atmosphereHandlers.atmosphere_get_diurnal_profile({ elevationDeg: 10 }, {} as any).resultPayload as any;
            expect(none.turbidity).toBeUndefined();
            expect(none.kelvinSource).toBe('spectral-beam');
            expect(none.turbidityUsed).toBe(2.4);
            const set = atmosphereHandlers.atmosphere_get_diurnal_profile({ elevationDeg: -4 }, {} as any).resultPayload as any;
            expect(set.kelvinSource).toBe('diurnal-profile');
            expect(set.sunIlluminanceLux).toBeUndefined();
        });
    });
});
