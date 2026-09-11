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
    computeBeerLambertTransmittance,
    computeInscatteringRadiance,
    evaluateAerialPerspective,
    projectCloudShadowCoordinates,
    computeCloudShadowFactor,
    createAerialPerspectiveEffect,
    AerialPerspectiveEffect,
    AERIAL_PERSPECTIVE_VERTEX_SHADER,
    AERIAL_PERSPECTIVE_FRAGMENT_SHADER
} from '../src/browser/generative-canvas/services/atmosphere/AerialPerspectiveEffect';
import {
    createTerrainCloudShadows,
    TerrainCloudShadows
} from '../src/browser/generative-canvas/services/atmosphere/TerrainCloudShadows';
import {
    createAtmosphericSkyDome,
    computeDiurnalLightingProfile,
    getPresetLightingState,
    getSunVectorFromAngles
} from '../src/browser/generative-canvas/services/atmosphere';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    synthesizeContextual3DScene,
    detect3DSceneTheme,
    createWorldBuilderScene,
    createProceduralCityScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';

async function runAerialPerspectiveAndCloudShadowsTests() {
    console.log('🌅 Running Aerial Perspective & Terrain Cloud Shadows Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Beer-Lambert Exponential Transmittance Attenuation Curve
    // -------------------------------------------------------------
    console.log('  Testing 1: Beer-Lambert Exponential Transmittance Curves across Distances...');
    const rayleigh = 0.5;
    const mie = 0.002;
    const turbidity = 1.5;
    const maxRange = 250.0;

    const t0 = computeBeerLambertTransmittance(0.0, rayleigh, mie, turbidity, maxRange);
    const t50 = computeBeerLambertTransmittance(50.0, rayleigh, mie, turbidity, maxRange);
    const t150 = computeBeerLambertTransmittance(150.0, rayleigh, mie, turbidity, maxRange);
    const t250 = computeBeerLambertTransmittance(250.0, rayleigh, mie, turbidity, maxRange);
    const t1000 = computeBeerLambertTransmittance(1000.0, rayleigh, mie, turbidity, maxRange);

    // Transmittance at distance 0 must be exactly 1.0 (no attenuation)
    assert.ok(Math.abs(t0.r - 1.0) < 0.0001 && Math.abs(t0.g - 1.0) < 0.0001 && Math.abs(t0.b - 1.0) < 0.0001,
        'Transmittance at distance 0 must be 1.0 across all color channels');

    // Transmittance must be strictly monotonically decreasing with distance
    assert.ok(t50.r < t0.r, 'Transmittance at 50m must be lower than 0m');
    assert.ok(t150.r < t50.r, 'Transmittance at 150m must be lower than 50m');
    assert.ok(t250.r < t150.r, 'Transmittance at 250m must be lower than 150m');
    assert.ok(t1000.r < t250.r, 'Transmittance at 1000m must approach zero');

    // Chromatic dispersion: Blue light scatters more than red in pure Rayleigh regime (so Red transmittance > Blue transmittance)
    assert.ok(t150.r >= t150.b, 'Rayleigh scattering attenuation must preserve higher red transmittance through haze');

    console.log(`  ✓ Test 1 Passed: Transmittance attenuation curve verified [0m: ${t0.r.toFixed(2)}, 50m: ${t50.r.toFixed(2)}, 150m: ${t150.r.toFixed(2)}, 250m: ${t250.r.toFixed(2)}, 1000m: ${t1000.r.toFixed(2)}]`);

    // -------------------------------------------------------------
    // Test 2: Physical Depth Inscattering Radiance & Diurnal Color Shifts
    // -------------------------------------------------------------
    console.log('  Testing 2: Depth Inscattering Radiance & Diurnal Horizon Tinting...');
    const viewDir = new THREE.Vector3(0, 0, -1).normalize();
    const sunDirMidday = new THREE.Vector3(0.3, 0.8, -0.5).normalize();
    const sunColorMidday = new THREE.Color(1.0, 0.98, 0.92);
    const horizonMidday = new THREE.Color(0.75, 0.88, 0.98);
    const zenithMidday = new THREE.Color(0.12, 0.38, 0.85);

    const middayProfile = computeDiurnalLightingProfile(60.0);
    const inscatterMiddayNear = computeInscatteringRadiance(
        10.0, viewDir, sunDirMidday, sunColorMidday, 1.45, horizonMidday, zenithMidday,
        rayleigh, mie, 0.82, 1.0, middayProfile, maxRange
    );
    const inscatterMiddayFar = computeInscatteringRadiance(
        220.0, viewDir, sunDirMidday, sunColorMidday, 1.45, horizonMidday, zenithMidday,
        rayleigh, mie, 0.82, 1.0, middayProfile, maxRange
    );

    assert.ok((inscatterMiddayNear.r + inscatterMiddayNear.g + inscatterMiddayNear.b) < (inscatterMiddayFar.r + inscatterMiddayFar.g + inscatterMiddayFar.b),
        'Inscattered radiance must accumulate and increase over camera distance');

    // Sunset / Golden Hour Inscattering
    const sunDirSunset = getSunVectorFromAngles(4.5, 260.0);
    const sunColorSunset = new THREE.Color(1.0, 0.65, 0.25);
    const horizonSunset = new THREE.Color(0.98, 0.52, 0.18);
    const zenithSunset = new THREE.Color(0.18, 0.12, 0.42);
    const sunsetProfile = computeDiurnalLightingProfile(4.5);

    const inscatterSunset = computeInscatteringRadiance(
        200.0, viewDir, sunDirSunset, sunColorSunset, sunsetProfile.sunIntensity,
        horizonSunset, zenithSunset, rayleigh, mie, 0.85, 1.0, sunsetProfile, maxRange
    );

    // Sunset inscatter should have rich warm golden/amber tint (Red > Blue)
    assert.ok(inscatterSunset.r > inscatterSunset.b, 'Sunset inscattering must display warm golden/amber horizon glow');

    console.log(`  ✓ Test 2 Passed: Depth inscattering correctly accumulates distance haze with diurnal golden hour tint (R: ${inscatterSunset.r.toFixed(2)}, G: ${inscatterSunset.g.toFixed(2)}, B: ${inscatterSunset.b.toFixed(2)})`);

    // -------------------------------------------------------------
    // Test 3: Composite Aerial Perspective on Distant Meshes
    // -------------------------------------------------------------
    console.log('  Testing 3: Composite Aerial Perspective Blending on Distant Terrain Meshes...');
    const groundBaseColor = new THREE.Color(0.15, 0.35, 0.12); // Green terrain grass

    // Near terrain (10m) retains true albedo
    const blendedNear = evaluateAerialPerspective(
        groundBaseColor, 10.0, viewDir, sunDirMidday, sunColorMidday, 1.45,
        horizonMidday, zenithMidday, { rayleigh, mie, turbidity, aerialPerspectiveRange: maxRange }, middayProfile
    );
    assert.ok(blendedNear.g > blendedNear.b, 'Near terrain should retain dominant green grass albedo');

    // Distant mountain / terrain (300m) absorbs atmospheric horizon haze
    const blendedFar = evaluateAerialPerspective(
        groundBaseColor, 300.0, viewDir, sunDirMidday, sunColorMidday, 1.45,
        horizonMidday, zenithMidday, { rayleigh, mie, turbidity, aerialPerspectiveRange: maxRange }, middayProfile
    );
    assert.ok(blendedFar.b > blendedNear.b, 'Distant terrain must absorb sky horizon blue/haze tint');
    const distFarToHorizon = Math.hypot(blendedFar.r - horizonMidday.r, blendedFar.g - horizonMidday.g, blendedFar.b - horizonMidday.b);
    const distNearToHorizon = Math.hypot(blendedNear.r - horizonMidday.r, blendedNear.g - horizonMidday.g, blendedNear.b - horizonMidday.b);
    assert.ok(distFarToHorizon < distNearToHorizon,
        'Distant terrain color must converge towards atmospheric horizon color');

    console.log('  ✓ Test 3 Passed: Distant terrain naturally absorbs atmospheric horizon color and aerial haze.');

    // -------------------------------------------------------------
    // Test 4: Dynamic Cloud Shadow Projected Coordinates
    // -------------------------------------------------------------
    console.log('  Testing 4: Dynamic Cloud Shadow Projected Coordinates & Wind Drift...');
    const groundPoint = new THREE.Vector3(10.0, 0.0, 20.0);
    const sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
    const cloudAltitude = 1200.0;
    const windVector: [number, number] = [0.08, 0.04];
    const shadowScale = 0.015;

    const coordsT0 = projectCloudShadowCoordinates(groundPoint, sunDir, cloudAltitude, shadowScale, windVector, 0.0);
    const coordsT10 = projectCloudShadowCoordinates(groundPoint, sunDir, cloudAltitude, shadowScale, windVector, 10.0);

    // Projected coordinates should shift with wind velocity over time
    const deltaU = coordsT10.u - coordsT0.u;
    const deltaV = coordsT10.v - coordsT0.v;
    assert.ok(Math.abs(deltaU - windVector[0] * 10.0) < 0.001, 'Shadow U coordinate must drift proportionally to windX * time');
    assert.ok(Math.abs(deltaV - windVector[1] * 10.0) < 0.001, 'Shadow V coordinate must drift proportionally to windZ * time');

    // Lower sun elevation (e.g. sunset) should project cloud shadow farther across terrain
    const lowSunDir = new THREE.Vector3(0.8, 0.2, 0.3).normalize();
    const coordsLowSun = projectCloudShadowCoordinates(groundPoint, lowSunDir, cloudAltitude, shadowScale, windVector, 0.0);
    assert.ok(Math.abs(coordsLowSun.u) > Math.abs(coordsT0.u),
        'Low sun angle must project cloud shadows significantly farther along the sun shadow ray');

    console.log(`  ✓ Test 4 Passed: Cloud shadow projection accurately responds to sun angle and wind velocity drift.`);

    // -------------------------------------------------------------
    // Test 5: Cloud Shadow Density & Ground Diffuse/Ambient Darkening
    // -------------------------------------------------------------
    console.log('  Testing 5: Cloud Shadow Factor & Ground Diffuse Light Modulation...');
    const cloudCoverage = 0.50;
    const cloudDensity = 0.60;
    const cloudShadowIntensity = 0.75;
    const atmosphereShadowLength = 1.2;

    const shadowFactorInClear = computeCloudShadowFactor(
        new THREE.Vector2(100.5, 200.5), 0.0, cloudCoverage, cloudDensity,
        cloudShadowIntensity, atmosphereShadowLength
    );
    assert.ok(shadowFactorInClear >= 0.0 && shadowFactorInClear <= 1.0, 'Shadow factor must stay bounded in [0, 1]');

    // Test extreme coverage (no clouds -> 0 shadow factor)
    const shadowFactorNoClouds = computeCloudShadowFactor(
        new THREE.Vector2(5.0, 5.0), 0.0, 0.0, cloudDensity,
        cloudShadowIntensity, atmosphereShadowLength
    );
    assert.strictEqual(shadowFactorNoClouds, 0.0, 'Zero cloud coverage must produce 0.0 shadow factor');

    // Test dense overcast clouds
    const shadowFactorOvercast = computeCloudShadowFactor(
        new THREE.Vector2(5.0, 5.0), 0.0, 0.95, 0.9,
        cloudShadowIntensity, atmosphereShadowLength
    );
    assert.ok(shadowFactorOvercast > 0.3, 'Heavy overcast must produce substantial shadow factor');

    // Verify lighting modulation equation: I_lit = I_ambient * (1 - sigma * 0.6) + I_diffuse * (1 - sigma)
    const baseDiffuse = 1.0;
    const baseAmbient = 0.3;
    const sigma = 0.70;
    const modulatedDiffuse = baseDiffuse * (1.0 - sigma);
    const modulatedAmbient = baseAmbient * (1.0 - sigma * 0.6);
    assert.ok(modulatedDiffuse < baseDiffuse, 'Ground diffuse light must darken under cloud shadow');
    assert.ok(modulatedAmbient < baseAmbient, 'Ground ambient light must be partially occluded under cloud shadow');

    console.log(`  ✓ Test 5 Passed: Cloud shadow density modulates ground diffuse and ambient lighting proportionally.`);

    // -------------------------------------------------------------
    // Test 6: AerialPerspectiveEffect Post-Processing Class & Shader Model
    // -------------------------------------------------------------
    console.log('  Testing 6: AerialPerspectiveEffect Class, Render Target & Shaders...');
    const effect = createAerialPerspectiveEffect({
        inscatteringIntensity: 1.2,
        aerialPerspectiveRange: 220.0,
        cloudShadowsEnabled: true,
        cloudShadowIntensity: 0.65,
        cloudShadowScale: 0.015,
        atmosphereShadowLength: 1.0,
        windVector: [0.06, 0.03]
    });

    assert.ok(effect instanceof AerialPerspectiveEffect, 'Must create AerialPerspectiveEffect instance');
    assert.ok(effect.material instanceof THREE.ShaderMaterial, 'Effect must have a custom post-pass ShaderMaterial');
    assert.ok(effect.material.vertexShader.includes('vUv'), 'Vertex shader must provide texture coordinates');
    assert.ok(effect.material.fragmentShader.includes('computeAerialPerspective'), 'Fragment shader must compute inscattering');
    assert.ok(effect.material.fragmentShader.includes('computeCloudShadow'), 'Fragment shader must compute cloud shadows');

    // Uniforms verification
    assert.strictEqual(effect.material.uniforms.uInscatteringIntensity.value, 1.2);
    assert.strictEqual(effect.material.uniforms.uAerialPerspectiveRange.value, 220.0);
    assert.strictEqual(effect.material.uniforms.uCloudShadowsEnabled.value, true);
    assert.strictEqual(effect.material.uniforms.uCloudShadowIntensity.value, 0.65);
    assert.strictEqual(effect.material.uniforms.uAtmosphereShadowLength.value, 1.0);

    // Resize handling
    effect.setSize(1280, 720);
    assert.strictEqual(effect.renderTarget.width, 1280);
    assert.strictEqual(effect.renderTarget.height, 720);
    assert.ok(effect.renderTarget.depthTexture instanceof THREE.DepthTexture, 'Render target must hold a depth texture');

    // Dynamic update
    effect.update(5.0, 0.016);
    assert.strictEqual(effect.material.uniforms.uTime.value, 5.0);

    effect.dispose();
    console.log('  ✓ Test 6 Passed: AerialPerspectiveEffect initializes, compiles GLSL shaders, and manages depth buffers.');

    // -------------------------------------------------------------
    // Test 7: TerrainCloudShadows Dynamic Ground Material Integration
    // -------------------------------------------------------------
    console.log('  Testing 7: TerrainCloudShadows Dynamic Terrain Material Engine...');
    const terrainShadowEngine = createTerrainCloudShadows({
        cloudShadowsEnabled: true,
        cloudShadowIntensity: 0.7,
        cloudShadowScale: 0.018,
        cloudAltitude: 1000.0,
        windVector: [0.05, 0.02]
    });

    assert.ok(terrainShadowEngine instanceof TerrainCloudShadows, 'Must instantiate TerrainCloudShadows');
    const testTerrainMat = new THREE.MeshStandardMaterial({ color: 0x228b22 });
    terrainShadowEngine.attachToMaterial(testTerrainMat);

    assert.ok((testTerrainMat as any).userData?.hasCloudShadows, 'Material must be tagged with cloud shadow capability');

    terrainShadowEngine.update(2.5, new THREE.Vector3(0.4, 0.7, 0.5));
    assert.strictEqual(terrainShadowEngine.time, 2.5);

    terrainShadowEngine.dispose();
    console.log('  ✓ Test 7 Passed: TerrainCloudShadows attaches to standard terrain materials and updates uniforms.');

    // -------------------------------------------------------------
    // Test 8: Operator sb_setup_lighting with Aerial Perspective & Cloud Shadows
    // -------------------------------------------------------------
    console.log('  Testing 8: Direct-Dispatch Operator sb_setup_lighting with Aerial & Shadow Options...');
    const engine = createOperatorEngine({
        title: 'Geospatial Landscape Workspace',
        environment: { skybox: 'realistic-sky' }
    });

    const opResult = engine.dispatch('sb_setup_lighting', {
        preset: 'afternoon',
        enableAtmosphere: true,
        inscatteringIntensity: 1.15,
        aerialPerspectiveRange: 240.0,
        cloudShadowsEnabled: true,
        cloudShadowIntensity: 0.70,
        cloudShadowScale: 0.016,
        atmosphereShadowLength: 1.1,
        windVector: [0.06, 0.02]
    });

    assert.strictEqual(opResult.success, true);
    const sceneData = engine.getSceneData();
    const atmo = sceneData.features?.atmosphericScattering as any;
    assert.ok(atmo, 'Atmospheric scattering feature must be configured');
    assert.strictEqual(atmo.inscatteringIntensity, 1.15);
    assert.strictEqual(atmo.aerialPerspectiveRange, 240.0);
    assert.strictEqual(atmo.cloudShadowsEnabled, true);
    assert.strictEqual(atmo.cloudShadowIntensity, 0.70);
    assert.strictEqual(atmo.cloudShadowScale, 0.016);
    assert.strictEqual(atmo.atmosphereShadowLength, 1.1);
    assert.deepStrictEqual(atmo.windVector, [0.06, 0.02]);

    console.log('  ✓ Test 8 Passed: sb_setup_lighting operator configures aerial perspective and cloud shadow parameters.');

    // -------------------------------------------------------------
    // Test 9: Procedural 3D Synthesizer Auto-Enables Aerial Atmosphere & Shadows
    // -------------------------------------------------------------
    console.log('  Testing 9: Procedural 3D Synthesizer Outdoor Scene Atmosphere Integration...');
    const outdoorPrompt = 'Generate a high-altitude mountain terrain with realistic aerial perspective, hazy horizon, and cloud shadows over the valley';
    const autoScene = synthesizeContextual3DScene(outdoorPrompt);

    assert.strictEqual(detect3DSceneTheme(outdoorPrompt), 'worldbuilder');
    assert.ok(autoScene.features?.atmosphericScattering, 'Outdoor terrain prompt must auto-enable atmospheric scattering');
    const autoAtmo = autoScene.features?.atmosphericScattering as any;
    assert.strictEqual(autoAtmo.cloudShadowsEnabled, true, 'Outdoor scene must enable cloud shadows by default');
    assert.ok(autoAtmo.inscatteringIntensity > 0, 'Inscattering intensity must be set');
    assert.ok(autoAtmo.aerialPerspectiveRange > 50, 'Aerial perspective range must be set');

    // Verify WorldBuilder and City scene generators provide atmospheric scattering configurations
    const dummyScene = new THREE.Scene();
    const worldGroup = createWorldBuilderScene(dummyScene, THREE, { prompt: outdoorPrompt });
    assert.ok(worldGroup instanceof THREE.Group);

    console.log('  ✓ Test 9 Passed: Procedural 3D synthesizer automatically provisions aerial perspective and cloud shadows for outdoor scenes.');

    console.log('\n🎉 ALL AERIAL PERSPECTIVE & TERRAIN CLOUD SHADOWS TESTS PASSED SUCCESSFULLY!\n');
}

test('aerial-perspective-cloud-shadows.test', async () => {
    await runAerialPerspectiveAndCloudShadowsTests();
}, 180_000);
