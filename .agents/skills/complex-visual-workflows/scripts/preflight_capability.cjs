#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Pre-Flight Task Capability Resolver
 * Analyzes visual prompts to determine native support, mandatory staging rules,
 * and exact tools/services to invoke.
 *
 * Usage:
 *   node .agents/skills/complex-visual-workflows/scripts/preflight_capability.cjs "build a 3d sports car in monaco"
 ********************************************************************************/

const path = require('path');
const fs = require('fs');

function analyzeVisualPrompt(prompt) {
  const lower = prompt.toLowerCase();

  // 1. Domain Detection
  const is3D = /3d|mesh|model|geometry|car|vehicle|building|architecture|tree|sculpt|extrude|splat|gaussian|glb|gltf/i.test(lower);
  const isVideo = /video|matchmove|camera\s*track|cinematic|omni|footage|clip|flythrough|orbit|drone|timeline|cut|shot/i.test(lower);
  const isImagery = /image|photo|photoreal|render|texture|pbr|albedo|normal\s*map|beautify|turnaround|panorama|360|surfel/i.test(lower);

  // 2. Real-World Geographic Location Intent
  const locationMarkers = [
    'in ', 'at ', 'near ', 'around ', 'monaco', 'central park', 'new york', 'manhattan',
    'paris', 'eiffel', 'tokyo', 'shibuya', 'venice', 'rome', 'colosseum', 'san francisco',
    'high line', 'grand canyon', 'red rocks', 'london'
  ];
  let hasLocation = false;
  let detectedLocation = null;

  for (const mark of locationMarkers) {
    if (lower.includes(mark)) {
      hasLocation = true;
      if (['monaco', 'central park', 'new york', 'manhattan', 'paris', 'tokyo', 'shibuya', 'venice', 'rome', 'colosseum', 'san francisco'].some(city => lower.includes(city))) {
        const found = ['monaco', 'central park', 'new york', 'manhattan', 'paris', 'tokyo', 'shibuya', 'venice', 'rome', 'colosseum', 'san francisco'].find(city => lower.includes(city));
        detectedLocation = found.charAt(0).toUpperCase() + found.slice(1);
      }
      break;
    }
  }

  // 3. Unsupported Neural Capability Check
  const requiresTrellis = /trellis|triposr|image-to-3d|photo-to-3d|diffusion\s*mesh/i.test(lower);
  const requiresAnimateDiff = /animatediff|video-to-video\s*restyl|neural\s*style\s*transfer/i.test(lower);
  const requiresMarigold = /marigold|dense\s*depth\s*estimation/i.test(lower);
  const requiresCustomLora = /lora|custom\s*checkpoint|flux\s*lora|sdxl\s*checkpoint/i.test(lower);

  const isUnsupported = requiresTrellis || requiresAnimateDiff || requiresMarigold || requiresCustomLora;

  // 4. Staging Strategy Determination
  let stagingStrategy = '18% Studio Grey Clay Void (CAD/DCC default baseline)';
  if (hasLocation) {
    stagingStrategy = detectedLocation
      ? `Real-World Location Staging via Google 3D Tiles Studio Grey Clay (${detectedLocation})`
      : 'Real-World Location Staging via Google 3D Tiles Studio Grey Clay (Target Coordinates)';
  }

  // 5. Native Subsystems to Engage
  const nativeTools = [];
  const nativeHeaders = [];
  const cliCommands = [];

  if (is3D) {
    nativeTools.push('execute_3d_python_script (import scratchbox as sb)');
    nativeTools.push('google_3d_tiles_get_clay / google_3d_tiles_get_full_texture');
    nativeTools.push('stage_3d_vector_world (roads, curbs, parcels, traffic)');
    nativeTools.push('mesh_apply_deformers (explicit Bernstein FFD and non-linear deformers on a given GLB)');
    nativeHeaders.push('#include "scratchbox_engine.hpp"');
    nativeHeaders.push('#include "scratchbox_math.hpp"');
    nativeHeaders.push('#include "scratchbox_archie.hpp"');
    nativeHeaders.push('#include "scratchbox_veggie.hpp"');
    cliCommands.push('sbox bake --clay --resolution 4k');
  }

  if (isVideo) {
    nativeTools.push('adaptive_matchmove_resect_keyframe');
    nativeTools.push('adaptive_matchmove_synthesize_trajectory');
    nativeTools.push('video-timeline canvas primitive (HeadlessVideoEditorService)');
    nativeTools.push('atmosphere_configure_scene / atmosphere_harmonize_location_3d');
    cliCommands.push('sbox matchmove reference.mp4 --landmark "<landmark>" --render-mode textured --resolution 4k');
    cliCommands.push('node scripts/run_geo_camera_matchmove_pipeline.cjs --video <video> ...');
  }

  if (isImagery) {
    nativeTools.push('survey_beautify_station / spatial_ai_render_scene (AI Beautify Location Pipeline; the template is applied inside them)');
    nativeTools.push('generate_multi_angle_turnaround (Dual-Anchor Orbit Engine)');
    nativeTools.push('algorithmic_uv_rewrap (0.000 px drift, Sobel joint deepening)');
    nativeTools.push('pbr_material_synthesize (continuous biophysical R^20 manifold)');
  }

  return {
    prompt,
    classification: {
      is3D,
      isVideo,
      isImagery,
      hasRealWorldLocation: hasLocation,
      detectedLocation: detectedLocation || (hasLocation ? 'Generic Geodetic' : 'None (Studio Void)')
    },
    stagingStrategy,
    capability: {
      nativelySupported: !isUnsupported,
      rationale: isUnsupported
        ? 'Not supported: task requires neural diffusion / image-to-3D / specialized LoRAs that this app does not run.'
        : 'Task is fully achievable via Scratchbox native C++20 engine, Python nanobind, Google 3D Tiles, Omni 1.1, and matchmove services.',
      unsupportedNeeds: isUnsupported ? { requiresTrellis, requiresAnimateDiff, requiresMarigold, requiresCustomLora } : null
    },
    suggestedNativeTools: nativeTools,
    suggestedCppHeaders: nativeHeaders,
    recommendedCliCommands: cliCommands
  };
}

function main() {
  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) {
    console.error('Usage: node preflight_capability.cjs "<prompt>"');
    console.error('Example: node preflight_capability.cjs "build a 3d sports car in monaco"');
    process.exit(1);
  }

  const analysis = analyzeVisualPrompt(prompt);
  console.log('\n============================================================');
  console.log('⚡ Scratchbox Pre-Flight Visual Capability Resolver');
  console.log('============================================================\n');
  console.log(JSON.stringify(analysis, null, 2));
  console.log('\n============================================================');
  console.log(`NATIVELY SUPPORTED: [${analysis.capability.nativelySupported ? "YES" : "NO"}]`);
  console.log(`STAGING:           ${analysis.stagingStrategy}`);
  console.log('============================================================\n');
}

main();
