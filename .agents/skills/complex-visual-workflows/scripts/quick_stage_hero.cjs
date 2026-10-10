#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Quick Staging Helper for Hero Assets and Real-World Locations
 * Validates 18% Grey Clay baseline, staging coordinates, and Google 3D Tiles queries.
 *
 * Usage:
 *   node .agents/skills/complex-visual-workflows/scripts/quick_stage_hero.cjs --model model.glb
 *   node .agents/skills/complex-visual-workflows/scripts/quick_stage_hero.cjs --location "Monaco"
 ********************************************************************************/

const fs = require('fs');
const path = require('path');

const LANDMARK_COORDINATES = {
  'monaco': { lat: 43.7384, lng: 7.4246, alt: 15.0, heading: 42.0, name: 'Monaco GP Harbor' },
  'central park': { lat: 40.785091, lng: -73.968285, alt: 28.0, heading: 29.0, name: 'Central Park NYC' },
  'the plaza hotel': { lat: 40.76448, lng: -73.97444, alt: 18.0, heading: 125.0, name: 'The Plaza Hotel' },
  'empire state building': { lat: 40.748441, lng: -73.985664, alt: 381.0, heading: 29.0, name: 'Empire State Building' },
  'colosseum': { lat: 41.89021, lng: 12.49223, alt: 22.0, heading: 0.0, name: 'Colosseum Rome' },
  'eiffel tower': { lat: 48.85837, lng: 2.29448, alt: 33.0, heading: 45.0, name: 'Eiffel Tower Paris' },
  'venice beach': { lat: 33.9850, lng: -118.4695, alt: 4.0, heading: 220.0, name: 'Venice Beach Boardwalk' },
  'shibuya': { lat: 35.6595, lng: 139.7004, alt: 16.0, heading: 180.0, name: 'Shibuya Crossing Tokyo' }
};

function main() {
  const args = process.argv.slice(2);
  let modelPath = null;
  let locationQuery = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && i + 1 < args.length) modelPath = args[++i];
    else if (args[i] === '--location' && i + 1 < args.length) locationQuery = args[++i];
  }

  console.log('\n============================================================');
  console.log('🏛️  Scratchbox Staging & Grounding Advisor');
  console.log('============================================================\n');

  if (locationQuery) {
    const key = locationQuery.toLowerCase().trim();
    const match = LANDMARK_COORDINATES[key] || Object.entries(LANDMARK_COORDINATES).find(([k]) => key.includes(k))?.[1];

    if (match) {
      console.log(`Found Geodetic Landmark Preset: ${match.name}`);
      console.log(JSON.stringify({
        landmark: match.name,
        geodetic: {
          latitude: match.lat,
          longitude: match.lng,
          elevationMsl: match.alt,
          headingDegrees: match.heading
        },
        stagingRoutes: {
          google3DTilesClay: `getGoogle3DTilesClay({ lat: ${match.lat}, lng: ${match.lng}, radiusMeters: 250, errorTarget: 0.5 })`,
          vectorWorld: `stage_3d_vector_world({ center: [${match.lat}, ${match.lng}], radiusMeters: 300, heroStaging: true })`,
          matchmoveCmd: `sbox matchmove reference.mp4 --lat ${match.lat} --lng ${match.lng} --alt ${match.alt} --heading ${match.heading} --resolution 4k`
        }
      }, null, 2));
    } else {
      console.log(`Custom Location Query: "${locationQuery}"`);
      console.log(`Use geodetic coordinate extraction or VectorWorldPopulatorService to stage.`);
    }
  }

  if (modelPath) {
    const fullPath = path.resolve(modelPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`Model file not found: ${fullPath}`);
      process.exit(1);
    }
    console.log(`Model target: ${fullPath}`);
    console.log(`To verify geometric complexity:`);
    console.log(`  node .agents/skills/complex-visual-workflows/scripts/verify_visual_asset.cjs "${fullPath}"`);
  }

  if (!modelPath && !locationQuery) {
    console.log('Usage:');
    console.log('  node quick_stage_hero.cjs --location "Monaco"');
    console.log('  node quick_stage_hero.cjs --model output.glb');
  }
  console.log('\n============================================================\n');
}

main();
