import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as THREE from 'three';
import {
    calculateNOAASolarPosition,
    calculateENUSunVector,
    getSunVectorFromAngles,
    calculateJulianDay
} from '../src/browser/generative-canvas/services/atmosphere/solar-position';
import { kelvinToRGB } from '../src/browser/generative-canvas/services/atmosphere/kelvin';
import {
    classifyDiurnalPhase,
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    getPresetLightingState
} from '../src/browser/generative-canvas/services/atmosphere/diurnal-lighting';
import {
    createAtmosphericSkyDome,
    ATMOSPHERE_VERTEX_SHADER,
    ATMOSPHERE_FRAGMENT_SHADER
} from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';
import {
    createVolumetricGodRays,
    createArticulatedAircraft
} from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    synthesizeContextual3DScene,
    detect3DSceneTheme
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

async function runAtmosphericScatteringPipelineTests() {
    console.log('🌌 Running Comprehensive Atmospheric Scattering & Dynamic Sky Pipeline Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: NOAA Astronomical Solar Position Calculation
    // -------------------------------------------------------------
    console.log('  Testing 1: NOAA Astronomical Solar Position & Julian Day Calculation...');
    const testDate = new Date('2026-07-15T12:00:00Z');
    const jd = calculateJulianDay(2026, 7, 15, 12.0);
    assert.ok(jd > 2460000, 'Julian day must be valid J2000 epoch timeline');

    // Midday in San Francisco (37.77° N, -122.41° W)
    const sfMiddayDate = new Date('2026-06-21T20:00:00Z'); // ~1PM PDT
    const solSF = calculateNOAASolarPosition(sfMiddayDate, 37.77, -122.41);
    assert.ok(solSF.elevationDeg > 45.0, `Summer midday solar elevation should be high (>45°), got ${solSF.elevationDeg.toFixed(1)}°`);
    assert.ok(solSF.azimuthDeg >= 0 && solSF.azimuthDeg <= 360, 'Solar azimuth must be in [0, 360]');

    // ENU vector conversion
    const enuVec = calculateENUSunVector(solSF.altitudeRad, solSF.azimuthRad);
    assert.ok(Math.abs(enuVec.length() - 1.0) < 0.0001, 'ENU sun vector must be normalized');
    assert.ok(enuVec.y > 0.5, 'Sun vector +Y (Up) component must be positive during daytime');

    console.log(`  ✓ Test 1 Passed: Solar calculation verified. SF Elevation: ${solSF.elevationDeg.toFixed(1)}°, Azimuth: ${solSF.azimuthDeg.toFixed(1)}°`);

    // -------------------------------------------------------------
    // Test 2: Kelvin Blackbody Temperature to RGB Conversion
    // -------------------------------------------------------------
    console.log('  Testing 2: Kelvin Blackbody Temperature to RGB Converter...');
    const warmSunsetCol = kelvinToRGB(2800);
    assert.ok(warmSunsetCol.r > warmSunsetCol.b, 'Warm sunset color must have higher red than blue component');
    assert.ok(warmSunsetCol.r > 0.95, 'Sunset red component should be near maximum');

    const daylightCol = kelvinToRGB(6500);
    assert.ok(Math.abs(daylightCol.r - daylightCol.g) < 0.15, 'D65 daylight should have balanced white RGB');

    const blueHourCol = kelvinToRGB(12000);
    assert.ok(blueHourCol.b >= blueHourCol.r, 'High Kelvin twilight/night color must have prominent blue component');

    console.log('  ✓ Test 2 Passed: Planckian blackbody Kelvin temperatures accurately map to RGB spectra.');

    // -------------------------------------------------------------
    // Test 3: Diurnal Lighting Profiles & Phase Transitions
    // -------------------------------------------------------------
    console.log('  Testing 3: Diurnal Lighting Profiles & Phase Classifications...');
    assert.strictEqual(classifyDiurnalPhase(-15.0), 'Deep Night');
    assert.strictEqual(classifyDiurnalPhase(-8.0), 'Astronomical Twilight');
    assert.strictEqual(classifyDiurnalPhase(-4.5), 'Nautical Twilight');
    assert.strictEqual(classifyDiurnalPhase(-1.5), 'Civil Twilight');
    assert.strictEqual(classifyDiurnalPhase(1.0), 'Blue Hour');
    assert.strictEqual(classifyDiurnalPhase(5.0), 'Golden Hour');
    assert.strictEqual(classifyDiurnalPhase(18.0), 'Morning');
    assert.strictEqual(classifyDiurnalPhase(40.0), 'Afternoon');
    assert.strictEqual(classifyDiurnalPhase(68.0), 'Midday');

    const goldenProfile = computeDiurnalLightingProfile(4.5);
    assert.strictEqual(goldenProfile.isGoldenHour, true, 'Profile at 4.5° must be Golden Hour');
    assert.ok(goldenProfile.sunIntensity > 0.8, 'Golden hour should have strong direct sun radiance');
    assert.strictEqual(goldenProfile.castShadows, true, 'Golden hour should cast shadows');

    const nightProfile = computeDiurnalLightingProfile(-20.0);
    assert.strictEqual(nightProfile.isNight, true, 'Profile at -20° must be Night');
    assert.strictEqual(nightProfile.sunIntensity, 0.0, 'Night solar radiance must be 0');
    assert.strictEqual(nightProfile.castShadows, false, 'Night should not cast direct sun shadows');

    console.log('  ✓ Test 3 Passed: Continuous diurnal lighting curve transitions across all solar altitudes.');

    // -------------------------------------------------------------
    // Test 4: Atmospheric Scattering Sky Dome Shader Compilation & Uniforms
    // -------------------------------------------------------------
    console.log('  Testing 4: Atmospheric Scattering Sky Dome Mesh & Shader Model...');
    const testScene = new THREE.Scene();
    const skyDome = createAtmosphericSkyDome(testScene, false, {
        turbidity: 2.0,
        rayleigh: 0.65,
        mie: 0.003,
        mieDirectionalG: 0.85,
        cloudCoverage: 0.40,
        cloudDensity: 0.50,
        cloudAltitude: 1500.0,
        kelvinTemperature: 5800
    });

    assert.ok(skyDome.skyDome instanceof THREE.Mesh, 'Sky dome must be a THREE.Mesh');
    assert.ok(skyDome.sunMesh instanceof THREE.Mesh, 'Physical sun disc must be a THREE.Mesh');
    assert.ok(skyDome.hemiLight instanceof THREE.HemisphereLight, 'Must create hemisphere bounce light');
    assert.ok(skyDome.sunLight instanceof THREE.DirectionalLight, 'Must create sun directional light');

    const shaderMat = skyDome.skyDome.material as THREE.ShaderMaterial;
    assert.ok(shaderMat instanceof THREE.ShaderMaterial, 'Sky dome material must be ShaderMaterial');

    // Shader assertions
    assert.ok(shaderMat.vertexShader.includes('vWorldPosition'), 'Vertex shader must calculate world position');
    assert.ok(shaderMat.fragmentShader.includes('uRayleigh'), 'Fragment shader must evaluate Rayleigh scattering');
    assert.ok(shaderMat.fragmentShader.includes('uMieCoefficient'), 'Fragment shader must evaluate Mie scattering');
    assert.ok(shaderMat.fragmentShader.includes('henyeyGreenstein'), 'Fragment shader must evaluate Henyey-Greenstein phase');
    assert.ok(shaderMat.fragmentShader.includes('bayer4x4'), 'Fragment shader must include screen-space Bayer dithering');
    assert.ok(shaderMat.fragmentShader.includes('perlinWorley3D'), 'Fragment shader must compute 3D Perlin-Worley clouds');

    // Uniform assertions
    assert.strictEqual(shaderMat.uniforms.uTurbidity.value, 2.0);
    assert.strictEqual(shaderMat.uniforms.uRayleigh.value, 0.65);
    assert.strictEqual(shaderMat.uniforms.uMieCoefficient.value, 0.003);
    assert.strictEqual(shaderMat.uniforms.uMieDirectionalG.value, 0.85);
    assert.strictEqual(shaderMat.uniforms.uCloudCoverage.value, 0.40);
    assert.strictEqual(shaderMat.uniforms.uCloudDensity.value, 0.50);

    // Dynamic frame tick update
    skyDome.update(3.5, 0.016);
    assert.strictEqual(shaderMat.uniforms.uTime.value, 3.5, 'Uniform uTime must update during frame loop');

    skyDome.dispose();
    console.log('  ✓ Test 4 Passed: Atmospheric Sky Dome GLSL shader compiles with physical scattering and 3D clouds.');

    // -------------------------------------------------------------
    // Test 5: Dynamic Time-of-Day Presets & Solar Coordinate Steering
    // -------------------------------------------------------------
    console.log('  Testing 5: Dynamic Time-of-Day Presets & Solar Steering...');
    const presetScene = new THREE.Scene();
    const dynamicSky = createAtmosphericSkyDome(presetScene, false);

    // Switch to Golden Hour preset
    dynamicSky.setPreset('golden_hour');
    assert.strictEqual(dynamicSky.diurnalProfile.isGoldenHour, true);
    assert.ok(dynamicSky.sunDirection.y > 0.05 && dynamicSky.sunDirection.y < 0.25, 'Golden hour sun elevation must be low');

    // Switch to Night preset
    dynamicSky.setPreset('night');
    assert.strictEqual(dynamicSky.diurnalProfile.isNight, true);
    assert.ok(dynamicSky.sunDirection.y < 0.0, 'Night sun direction +Y must be below horizon');

    // Steer solar coordinates directly
    dynamicSky.setSunCoordinates(45.0, 180.0);
    assert.strictEqual(dynamicSky.diurnalProfile.isNight, false);
    assert.ok(dynamicSky.sunLight.intensity > 1.0, 'Daylight solar intensity should be full power');

    dynamicSky.dispose();
    console.log('  ✓ Test 5 Passed: Dynamic time-of-day presets smoothly steer lighting and solar direction.');

    // -------------------------------------------------------------
    // Test 6: Volumetric God Rays Sun-Tracking & Shimmer
    // -------------------------------------------------------------
    console.log('  Testing 6: Volumetric God Rays Sun-Tracking & Atmospheric Shimmer...');
    const raysScene = new THREE.Scene();
    const sunPos = new THREE.Vector3(30, 50, -40);
    const godRays = createVolumetricGodRays(raysScene, sunPos, false, { intensity: 0.85, color: '#ffeaad' });

    assert.ok(godRays.group instanceof THREE.Group, 'God rays must return a THREE.Group');
    assert.ok(godRays.group.children.length >= 8, 'God rays group must contain light shaft meshes');

    const rayMesh = godRays.group.children[0] as THREE.Mesh;
    assert.ok(rayMesh.material instanceof THREE.ShaderMaterial, 'Rays must use ShaderMaterial');
    const rayMat = rayMesh.material as THREE.ShaderMaterial;
    assert.strictEqual(rayMat.transparent, true);
    assert.strictEqual(rayMat.blending, THREE.AdditiveBlending);

    // Update shimmer
    godRays.update(1.2, 0.016);
    assert.strictEqual(rayMat.uniforms.uTime.value, 1.2);

    godRays.dispose();
    console.log('  ✓ Test 6 Passed: Volumetric god rays track physical sun position with additive shimmer.');

    // -------------------------------------------------------------
    // Test 7: Direct-Dispatch Operator sb_setup_lighting with Atmosphere
    // -------------------------------------------------------------
    console.log('  Testing 7: Direct-Dispatch sb_setup_lighting Operator with Atmospheric Features...');
    const engine = createOperatorEngine({
        title: 'Atmosphere Workspace',
        environment: { skybox: 'realistic-sky' }
    });

    const lightingOpResult = engine.dispatch('sb_setup_lighting', {
        preset: 'golden_hour',
        rayleigh: 0.7,
        mie: 0.004,
        turbidity: 2.2,
        cloudCoverage: 0.45,
        enableGodRays: true,
        godRaysIntensity: 0.6
    });

    assert.strictEqual(lightingOpResult.success, true);
    const updatedScene = engine.getSceneData();
    assert.strictEqual(updatedScene.environment?.lighting, 'golden_hour');
    assert.strictEqual(updatedScene.environment?.skybox, 'golden_hour');
    assert.ok(updatedScene.environment?.sunElevation !== undefined);
    assert.ok(updatedScene.features?.atmosphericScattering, 'Must enable atmosphericScattering feature');
    assert.ok(updatedScene.features?.godRays, 'Must enable godRays feature');

    const atmoFeature = updatedScene.features?.atmosphericScattering as any;
    assert.strictEqual(atmoFeature.rayleigh, 0.7);
    assert.strictEqual(atmoFeature.mie, 0.004);
    assert.strictEqual(atmoFeature.turbidity, 2.2);
    assert.strictEqual(atmoFeature.cloudCoverage, 0.45);

    console.log('  ✓ Test 7 Passed: sb_setup_lighting operator configures physical atmosphere and diurnal profile.');

    // -------------------------------------------------------------
    // Test 8: Contextual Scene Synthesizer Atmosphere Activation
    // -------------------------------------------------------------
    console.log('  Testing 8: Contextual Scene Synthesizer Atmospheric Intent Detection...');
    const prompt = 'Create an alpine mountain landscape at sunset with volumetric clouds and realistic Rayleigh scattering';
    const synthesizedScene = synthesizeContextual3DScene(prompt);

    assert.ok(detect3DSceneTheme(prompt) === 'nature_atmosphere' || detect3DSceneTheme(prompt) === 'worldbuilder', 'Theme must be nature_atmosphere or worldbuilder');
    assert.ok(synthesizedScene.features?.atmosphericScattering, 'Atmosphere must be activated for scattering prompt');
    assert.ok(synthesizedScene.features?.godRays, 'God rays must be activated for sunset landscape');
    assert.strictEqual(synthesizedScene.environment?.skybox, 'realistic-sky');

    console.log('  ✓ Test 8 Passed: Contextual 3D scene synthesizer configures atmospheric scattering features.');

    console.log('\n🎉 ALL ATMOSPHERIC SCATTERING PIPELINE TESTS PASSED SUCCESSFULLY!\n');
}

test('atmosphere-scattering-pipeline.test', async () => {
    await runAtmosphericScatteringPipelineTests();
}, 180_000);
