import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import {
  detectRealWorldLocationIntent,
  synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Google3DTileService } from '../src/browser/generative-canvas/services/Google3DTileService';
import { GooglePhotorealistic3DTilesLayer } from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { CLAY_PRESETS } from '../src/browser/generative-canvas/services/TileClayProcessor';

async function runTests() {
  console.log('🗺️ Running Real-World 3D Tile Scene Synthesis Test Suite...\n');

  // =========================================================================
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
    assert.ok(locPlaza?.landmarkName.toLowerCase().includes('plaza'), 'Should extract Plaza Hotel as landmark');
    assert.strictEqual(locPlaza?.elevationSource, 'online_geocoding_required');

    // Vector feature detection: Manhattan anchor
    const promptManhattan = 'race car in Manhattan';
    const locManhattan = detectRealWorldLocationIntent(promptManhattan);
    assert.ok(locManhattan, 'Should detect Manhattan location');
    assert.strictEqual(locManhattan?.isRealWorld, true);
    assert.ok(Math.abs((locManhattan?.lat ?? 0) - 40.7484) < 0.05, 'Should match Manhattan vector anchor latitude');
    assert.ok(Math.abs((locManhattan?.lng ?? 0) - (-73.9857)) < 0.05, 'Should match Manhattan vector anchor longitude');

    // Explicit coordinate detection
    const promptCoords = '3D scene at 40.7644, -73.9744';
    const locCoords = detectRealWorldLocationIntent(promptCoords);
    assert.ok(locCoords, 'Should detect explicit coordinates');
    assert.strictEqual(locCoords?.isRealWorld, true);
    assert.ok(Math.abs((locCoords?.lat ?? 0) - 40.7644) < 0.001);
    assert.ok(Math.abs((locCoords?.lng ?? 0) - (-73.9744)) < 0.001);

    // General landmark intent recognition
    const landmarkPrompts = [
      'Eiffel Tower Paris',
      'Tokyo Tower',
      'Ferry Building SF',
      'create a 3d model of The Plaza Hotel in NYC',
      'show 3d view of Chrysler Building',
      'reconstruct Brooklyn Bridge in 3d',
      'model of Colosseum in Rome',
      'explore 3d map of Taj Mahal',
      'render 3d environment of Shibuya Crossing',
      'view 3d representation of Sydney Opera House',
      'synthesize 3d reconstruction of Burj Khalifa'
    ];

    for (const prompt of landmarkPrompts) {
      const loc = detectRealWorldLocationIntent(prompt);
      assert.ok(loc, `Should detect geographic intent for: "${prompt}"`);
      assert.strictEqual(loc?.isRealWorld, true);
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

    console.log(' ✓ Test 1 Passed: Real-world geographic intents accurately detected with online-first geocoding contract.');
  }

  // =========================================================================
  // Test 2: Online-Only Resolution & Actionable Error on Unreachable Sources
  // =========================================================================
  console.log('Testing 2: Online-Only Resolution & Actionable Error on Unreachable Sources...');
  {
    const tileService = Google3DTileService.getInstance();

    // 1. Explicit coordinates resolve synchronously without mock fixtures
    const coordRes = tileService.resolveLocationSync({ lat: 40.7644, lng: -73.9744, elevation: 18.0 });
    assert.strictEqual(coordRes.isResolved, true);
    assert.strictEqual(coordRes.lat, 40.7644);
    assert.strictEqual(coordRes.lng, -73.9744);

    // 2. Unreachable online sources must throw an actionable error, NOT silently default to mock coordinates
    let errorThrown = false;
    try {
      await tileService.resolveLocation('unresolvable-fictional-location-12345XYZ');
    } catch (err: any) {
      errorThrown = true;
      // Wording changed in 025cfe0 ("ADA Zero-Presets: Could not resolve geodetic coordinates or
      // reach Google Maps 3D Tiles data sources ..."); the contract is still an actionable error.
      assert.ok(
        err.message.includes('reach Google Maps 3D Tiles data sources'),
        'Error should inform user that online data sources cannot be reached'
      );
    }
    assert.strictEqual(errorThrown, true, 'Should throw actionable error when online sources are unreachable');

    console.log(' ✓ Test 2 Passed: Online resolution enforced and silent offline fallbacks retired.');
  }

  // =========================================================================
  // Test 3: Zero Synthetic JS Primitive Boxes & Pure Clay Default
  // =========================================================================
  console.log('Testing 3: Zero Synthetic JS Primitive Boxes & Pure Clay Default...');
  {
    const prompt = 'build a 3d scene of the plaza hotel NYC';
    const scene = synthesizeContextual3DScene(prompt, {
      location: { lat: 40.7644, lng: -73.9744, elevation: 18.0 }
    });

    assert.ok(scene, 'Should synthesize a 3D scene');
    assert.strictEqual(scene.renderMode, 'clay', 'Real-world initial scene must default to Studio Grey Clay');
    assert.strictEqual(scene.environment?.skybox, 'studio', 'Skybox must default to neutral studio');
    assert.strictEqual(scene.environment?.lighting, 'studio', 'Lighting must default to neutral studio');

    // Verify ZERO fake building boxes in customMeshes (Tile streaming handles geometry)
    assert.strictEqual(scene.customMeshes?.length ?? 0, 0, 'Must have zero synthetic extruded building boxes');

    // Verify 3D tile streaming anchor is registered in objects
    assert.ok(scene.objects && scene.objects.length > 0, 'Should contain Media4DObject streaming anchor');
    const tileAnchor = scene.objects[0];
    assert.strictEqual(tileAnchor.content?.type, 'map-3d', 'Object content type must be map-3d');

    console.log(' ✓ Test 3 Passed: Zero synthetic JS boxes detected, pure 18% grey clay mode enforced.');
  }

  // =========================================================================
  // Test 4: Atmosphere and Ephemeris are Strictly Opt-In
  // =========================================================================
  console.log('Testing 4: Atmosphere and Ephemeris are Strictly Opt-In...');
  {
    // Default prompt: no atmospheric keywords -> atmospheric scattering disabled
    const sceneDefault = synthesizeContextual3DScene('build a 3d scene of the plaza hotel NYC', {
      location: { lat: 40.7644, lng: -73.9744, elevation: 18.0 }
    });
    assert.strictEqual(
      sceneDefault.features?.atmosphericScattering,
      undefined,
      'Atmospheric scattering must NOT be enabled without explicit opt-in'
    );

    // Explicit opt-in prompt: golden hour light requested
    const sceneOptIn = synthesizeContextual3DScene('Tokyo Tower in golden hour light with atmosphere and sunset', {
      location: { lat: 35.6586, lng: 139.7454, elevation: 25.0 }
    });
    assert.ok(sceneOptIn.features?.atmosphericScattering, 'Atmospheric scattering should be enabled on explicit opt-in');
    assert.ok(sceneOptIn.features.atmosphericScattering.enabled, 'Atmospheric scattering should be active');

    console.log(' ✓ Test 4 Passed: Atmosphere and ephemeris are strictly opt-in.');
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
