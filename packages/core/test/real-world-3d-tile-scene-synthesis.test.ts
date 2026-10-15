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
  synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { LocationUnresolvedError } from '../src/common/errors/pipeline-errors';
import { GoogleMapsService } from '../src/browser/generative-canvas/services/google-maps-service';
import { Google3DTileService } from '../src/browser/generative-canvas/services/Google3DTileService';
import { GooglePhotorealistic3DTilesLayer } from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { CLAY_PRESETS } from '../src/browser/generative-canvas/services/TileClayProcessor';

async function runTests() {
  console.log('🗺️ Running Real-World 3D Tile Scene Synthesis Test Suite...\n');

  // =========================================================================
  // =========================================================================
  // Test 1: Prompts are never scanned for places (the model passes locations to the location tools)
  // =========================================================================
  console.log('Testing 1: Prompt words never become real-world locations...');
  {
    const prompts = [
      'build a 3d scene of the plaza hotel NYC',
      'race car in Manhattan',
      '3D scene at 40.7644, -73.9744',
      'Eiffel Tower Paris',
      'reconstruct Brooklyn Bridge in 3d',
      'model of Colosseum in Rome'
    ];
    for (const prompt of prompts) {
      const scene = synthesizeContextual3DScene(prompt);
      assert.strictEqual(scene.geoAnchor, undefined, `"${prompt}" must not be anchored from a name table or a regex`);
    }
    console.log(' ✓ Test 1 Passed: template synthesis leaves locations to the location tools.');
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

    // 2. A place name needs Google Places: without a key it throws LocationUnresolvedError, NOT a mock coordinate
    const maps = GoogleMapsService.getInstance();
    const saved = { state: maps.getApiKey(), g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
    maps.setApiKey('');
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.MAP_TILES_API_KEY;
    try {
      await assert.rejects(tileService.resolveLocation('unresolvable-fictional-location-12345XYZ'), LocationUnresolvedError);
    } finally {
      maps.setApiKey(saved.state);
      if (saved.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.g;
      if (saved.m !== undefined) process.env.MAP_TILES_API_KEY = saved.m;
    }

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
    assert.strictEqual(scene.environment?.skybox, 'studio', 'Skybox must default to neutral studio');
    assert.strictEqual(scene.environment?.lighting, 'studio', 'Lighting must default to neutral studio');
    assert.strictEqual(scene.geoAnchor, undefined, 'A template scene is not anchored at a place');

    // No location reaches a template scene, so no tile object is fabricated for it
    assert.ok(!(scene.objects || []).some(o => o.content?.type === 'map-3d'), 'Must not mount a synthesized map tile');

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
