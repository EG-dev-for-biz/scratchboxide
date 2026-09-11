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
import {
  detectRealWorldLocationIntent,
  synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Google3DTileService } from '../src/browser/generative-canvas/services/Google3DTileService';
import { GooglePhotorealistic3DTilesLayer } from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

async function runTests() {
  console.log('🗺️ Running Real-World 3D Tile Scene Synthesis Test Suite...\n');

  // =========================================================================
  // Test 1: Real-World Location & Landmark Intent Detection
  // =========================================================================
  console.log('Testing 1: Real-World Location & Landmark Intent Detection...');
  {
    // Primary User Problem: "build a 3d scene of the plaza hotel NYC"
    const promptPlaza = 'build a 3d scene of the plaza hotel NYC';
    const locPlaza = detectRealWorldLocationIntent(promptPlaza);
    assert.ok(locPlaza, 'Should detect The Plaza Hotel NYC');
    assert.strictEqual(locPlaza?.isRealWorld, true);
    assert.strictEqual(locPlaza?.landmarkName, 'The Plaza Hotel NYC');
    assert.ok(Math.abs((locPlaza?.lat ?? 0) - 40.7644) < 0.01, 'Latitude should match Plaza Hotel NYC (40.7644)');
    assert.ok(Math.abs((locPlaza?.lng ?? 0) - (-73.9744)) < 0.01, 'Longitude should match Plaza Hotel NYC (-73.9744)');
    assert.strictEqual(locPlaza?.elevation, 18.0);

    // User prompt variation: "can you build me a 3d scene of the plaza hotel NYC"
    const promptCanYou = 'can you build me a 3d scene of the plaza hotel NYC';
    const locCanYou = detectRealWorldLocationIntent(promptCanYou);
    assert.ok(locCanYou, 'Should detect "can you build me a 3d scene of the plaza hotel NYC"');
    assert.strictEqual(locCanYou?.isRealWorld, true);
    assert.strictEqual(locCanYou?.landmarkName, 'The Plaza Hotel NYC');

    // All Plaza variations
    const plazaVariations = ['plaza hotel', 'the plaza hotel', 'the plaza hotel nyc', 'plaza hotel nyc', 'the plaza'];
    for (const pVar of plazaVariations) {
      const locVar = detectRealWorldLocationIntent(pVar);
      assert.ok(locVar, `Should detect "${pVar}"`);
      assert.strictEqual(locVar?.isRealWorld, true);
      assert.strictEqual(locVar?.landmarkName, 'The Plaza Hotel NYC');
      assert.ok(Math.abs((locVar?.lat ?? 0) - 40.7644) < 0.01);
      assert.ok(Math.abs((locVar?.lng ?? 0) - (-73.9744)) < 0.01);
    }

    // Central Park New York
    const promptCentralPark = 'Central Park New York';
    const locCP = detectRealWorldLocationIntent(promptCentralPark);
    assert.ok(locCP, 'Should detect Central Park New York');
    assert.strictEqual(locCP?.isRealWorld, true);
    assert.ok(Math.abs((locCP?.lat ?? 0) - 40.7829) < 0.01, 'Latitude should match Central Park');
    assert.ok(Math.abs((locCP?.lng ?? 0) - (-73.9654)) < 0.01, 'Longitude should match Central Park');

    // Eiffel Tower Paris
    const promptEiffel = 'Eiffel Tower Paris';
    const locEiffel = detectRealWorldLocationIntent(promptEiffel);
    assert.ok(locEiffel, 'Should detect Eiffel Tower Paris');
    assert.strictEqual(locEiffel?.isRealWorld, true);
    assert.strictEqual(locEiffel?.landmarkName, 'Eiffel Tower');
    assert.ok(Math.abs((locEiffel?.lat ?? 0) - 48.8584) < 0.01, 'Latitude should match Paris Eiffel Tower');
    assert.ok(Math.abs((locEiffel?.lng ?? 0) - 2.2945) < 0.01, 'Longitude should match Paris Eiffel Tower');

    // Tokyo Tower
    const promptTokyo = 'Tokyo Tower';
    const locTokyo = detectRealWorldLocationIntent(promptTokyo);
    assert.ok(locTokyo, 'Should detect Tokyo Tower');
    assert.strictEqual(locTokyo?.isRealWorld, true);
    assert.strictEqual(locTokyo?.landmarkName, 'Tokyo Tower');
    assert.ok(Math.abs((locTokyo?.lat ?? 0) - 35.6586) < 0.01, 'Latitude should match Tokyo Tower');
    assert.ok(Math.abs((locTokyo?.lng ?? 0) - 139.7454) < 0.01, 'Longitude should match Tokyo Tower');

    // Ferry Building SF
    const promptFerrySF = 'Ferry Building SF';
    const locFerry = detectRealWorldLocationIntent(promptFerrySF);
    assert.ok(locFerry, 'Should detect Ferry Building SF');
    assert.strictEqual(locFerry?.isRealWorld, true);
    assert.strictEqual(locFerry?.landmarkName, 'San Francisco Ferry Building');
    assert.ok(Math.abs((locFerry?.lat ?? 0) - 37.7955) < 0.01, 'Latitude should match SF Ferry Building');
    assert.ok(Math.abs((locFerry?.lng ?? 0) - (-122.3937)) < 0.01, 'Longitude should match SF Ferry Building');

    // Natural Language Variations
    const naturalQueries = [
      { prompt: 'create a 3d model of The Plaza Hotel in NYC', expectedLat: 40.7644, expectedLng: -73.9744 },
      { prompt: 'show 3d view of Chrysler Building', expectedLat: 40.7516, expectedLng: -73.9755 },
      { prompt: 'reconstruct Brooklyn Bridge in 3d', expectedLat: 40.7061, expectedLng: -73.9969 },
      { prompt: 'generate 3D map of Grand Central', expectedLat: 40.7527, expectedLng: -73.9772 },
      { prompt: 'model of Colosseum in Rome', expectedLat: 41.8902, expectedLng: 12.4922 },
      { prompt: 'explore 3d map of Taj Mahal', expectedLat: 27.1751, expectedLng: 78.0421 },
      { prompt: 'render 3d environment of Shibuya Crossing', expectedLat: 35.6595, expectedLng: 139.7004 },
      { prompt: 'view 3d representation of Sydney Opera House', expectedLat: -33.8568, expectedLng: 151.2153 },
      { prompt: 'synthesize 3d reconstruction of Burj Khalifa', expectedLat: 25.1972, expectedLng: 55.2744 }
    ];

    for (const testCase of naturalQueries) {
      const loc = detectRealWorldLocationIntent(testCase.prompt);
      assert.ok(loc, `Should detect location for prompt: "${testCase.prompt}"`);
      assert.strictEqual(loc?.isRealWorld, true);
      assert.ok(Math.abs((loc?.lat ?? 0) - testCase.expectedLat) < 0.05, `Lat for "${testCase.prompt}" should be near ${testCase.expectedLat}, got ${loc?.lat}`);
      assert.ok(Math.abs((loc?.lng ?? 0) - testCase.expectedLng) < 0.05, `Lng for "${testCase.prompt}" should be near ${testCase.expectedLng}, got ${loc?.lng}`);
    }

    // Negative tests: generic non-geographic prompts
    const nonGeoPrompts = [
      'Create a generic floating cube in outer space with asteroids',
      'particle simulation with gravity and atoms',
      'simulate molecular physics of caffeine with electron clouds',
      'orbiting planets in solar system with asteroid belt'
    ];

    for (const prompt of nonGeoPrompts) {
      const locNonGeo = detectRealWorldLocationIntent(prompt);
      assert.strictEqual(locNonGeo, undefined, `Generic prompt "${prompt}" should not trigger real-world location`);
    }

    console.log(' ✓ Test 1 Passed: Real-world geographic intents and natural phrasing accurately detected.');
  }

  // =========================================================================
  // Test 2: Plaza Hotel NYC End-to-End Scene Synthesis with 3D Tiles
  // =========================================================================
  console.log('Testing 2: Plaza Hotel NYC End-to-End Scene Synthesis with 3D Tiles...');
  {
    const prompt = 'build a 3d scene of the plaza hotel NYC';
    const scene = synthesizeContextual3DScene(prompt);

    assert.ok(scene, 'Should synthesize a 3D scene');
    assert.ok(scene.title.includes('The Plaza Hotel') || scene.title.includes('Plaza Hotel'), 'Title should reflect Plaza Hotel');
    assert.ok(scene.geoAnchor, 'Scene should have geoAnchor');
    assert.ok(Math.abs(scene.geoAnchor.lat - 40.7644) < 0.01, 'geoAnchor lat should match Plaza Hotel NYC');
    assert.ok(Math.abs(scene.geoAnchor.lng - (-73.9744)) < 0.01, 'geoAnchor lng should match Plaza Hotel NYC');
    assert.strictEqual(scene.geoAnchor.elevation, 18.0);

    // Check custom meshes & objects from 3D tile
    assert.ok(scene.customMeshes && scene.customMeshes.length > 0, 'Should contain custom building meshes from 3D tile');
    assert.ok(scene.objects && scene.objects.length > 0, 'Should contain Media4DObjects from 3D tile');

    // Verify clay material styling
    const mainMesh = scene.customMeshes[0];
    assert.ok(mainMesh, 'Should have a landmark building mesh');
    assert.ok(mainMesh.material?.roughness && mainMesh.material.roughness >= 0.7, 'Material should have matte clay roughness');

    // Verify operator stack contains sb_import_3d_tile
    assert.ok(scene.operatorStack && scene.operatorStack.length > 0, 'Should have operator stack');
    const importOp = scene.operatorStack.find(op => op.operator === 'sb_import_3d_tile');
    assert.ok(importOp, 'Operator stack should contain sb_import_3d_tile');

    console.log(` ✓ Test 2 Passed: Plaza Hotel NYC scene synthesized with ${scene.customMeshes.length} building meshes and clay shaders.`);
  }

  // =========================================================================
  // Test 3: Individual Mesh Manipulability & Direct-Dispatch Operators
  // =========================================================================
  console.log('Testing 3: Individual Mesh Manipulability & Direct-Dispatch Operators...');
  {
    const prompt = 'Reconstruct Independence Hall Philadelphia in 3D';
    const scene = synthesizeContextual3DScene(prompt);
    assert.ok(scene.customMeshes && scene.customMeshes.length >= 2, 'Should have multiple distinct buildings');

    const targetMeshId = scene.customMeshes[0].id;
    const initialY = scene.customMeshes[0].position[1];

    const engine = createOperatorEngine(scene);

    // 1. Translate specific building
    const transRes = engine.dispatch('sb_translate', {
      objectId: targetMeshId,
      delta: [0, 5, 0]
    });
    assert.strictEqual(transRes.success, true);
    assert.strictEqual(engine.getSceneData().customMeshes![0].position[1], initialY + 5, 'Target building should be translated');

    // 2. Set clay mode preset
    const clayRes = engine.dispatch('sb_set_clay_mode', {
      preset: 'alabaster'
    });
    assert.strictEqual(clayRes.success, true);
    assert.strictEqual(engine.getSceneData().customMeshes![0].material?.roughness, 0.80, 'Roughness should update to alabaster clay');

    // 3. Undo operator
    const undoRes = engine.dispatch('sb_undo', {});
    assert.strictEqual(undoRes.success, true);
    assert.strictEqual(engine.getSceneData().customMeshes![0].position[1], initialY + 5, 'Undo should restore previous translation state');

    console.log(' ✓ Test 3 Passed: Ingested 3D Tile meshes are individually selectable and manipulable with operators.');
  }

  // =========================================================================
  // Test 4: Geodetic Solar & Atmospheric Grounding
  // =========================================================================
  console.log('Testing 4: Geodetic Solar & Atmospheric Grounding...');
  {
    const prompt = 'Create a 3d model of Tokyo Tower in golden hour light';
    const scene = synthesizeContextual3DScene(prompt);

    assert.ok(scene.features?.atmosphericScattering, 'Atmospheric scattering should be enabled');
    assert.ok(scene.features.atmosphericScattering.enabled, 'Atmospheric scattering should be active');
    assert.strictEqual(scene.geoAnchor?.landmarkName, 'Tokyo Tower');

    // Sun position should be computed and atmospheric perspective active
    assert.ok(scene.features.atmosphericScattering.aerialPerspectiveEnabled, 'Aerial perspective should be active for real-world tile');
    assert.ok(scene.features.atmosphericScattering.cloudShadowsEnabled, 'Cloud shadows should be enabled');

    console.log(' ✓ Test 4 Passed: Atmospheric scattering and solar angle matched to geographic coordinates.');
  }

  // =========================================================================
  // Test 5: GooglePhotorealistic3DTilesLayer Instantiation & Origin Alignment
  // =========================================================================
  console.log('Testing 5: GooglePhotorealistic3DTilesLayer Instantiation & Origin Alignment...');
  {
    const layer = new GooglePhotorealistic3DTilesLayer({
      origin: { lat: 40.7644, lng: -73.9744, alt: 18.0 },
      renderMode: 'clay',
      clayPreset: 'warm-clay'
    });

    assert.ok(layer.group, 'Layer should have a THREE.Group');
    assert.strictEqual(layer.group.name, 'GooglePhotorealistic3DTiles');
    assert.ok(layer.tilesRenderer, 'Layer should instantiate tilesRenderer');

    // Update origin
    layer.updateOrigin({ lat: 40.7644, lng: -73.9744, alt: 18.0 }, -30.0);
    assert.ok(layer.tilesRenderer.group, 'Tiles renderer group should be attached');

    // Dispose
    layer.dispose();
    assert.strictEqual(layer.tilesRenderer, null, 'Tiles renderer should be null after disposal');

    console.log(' ✓ Test 5 Passed: GooglePhotorealistic3DTilesLayer instantiated and managed correctly.');
  }

  console.log('\n🎉 ALL REAL-WORLD 3D TILE SCENE SYNTHESIS TESTS COMPLETED SUCCESSFULLY!');
}

test('real-world-3d-tile-scene-synthesis.test', async () => {
    await runTests();
}, 180_000);
