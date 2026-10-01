#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI Runner for the Google 3D Tile Camera Blockout Video Pipeline (<VIDEO_REF_0>)
 *
 * Usage:
 *   node scripts/run_google_tiles_blockout_pipeline.cjs [options]
 *
 * Options:
 *   --address <string>   Arbitrary address or coordinates (e.g. "Midtown Manhattan, coordinates: 40.748400, -73.985700")
 *   --mode <mode>        Operational mode: 'textured' (full texture) or 'greybox' / 'clay' (default: clay)
 *   --lat <num>          Geodetic Latitude (default: 40.7484405)
 *   --lng <num>          Geodetic Longitude (default: -73.9856644)
 *   --elevation <num>    Elevation above MSL in meters (default: 15.0)
 *   --camera-path <path> Path to camera trajectory JSON (optional: auto-synthesized if omitted)
 *   --error-target <num> Tile LOD error target (default: 0.5, maximum quality)
 *   --atmosphere <mode>  Shading mode: 'clay', 'greybox', or 'textured' (default: clay)
 *   --clay-preset <name> Clay preset: 'warm-clay' or 'studio-grey' (default: warm-clay)
 *   --output <path>      Output MP4 path (default: dynamic based on mode)
 *   --port <num>         Local HTTP runner port (default: 8098)
 */

const path = require('path');
const fs = require('fs');

// Dynamically import or compile via ts-node/built dist, or invoke the standalone class logic
const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const address = getArg('--address', getArg('--query', null));
const mode = getArg('--mode', null);
const rawAtmosphere = getArg('--atmosphere', mode || 'clay');
const isTextured = rawAtmosphere === 'textured' || rawAtmosphere === 'photoreal' || rawAtmosphere === 'full-texture';
const atmosphere = isTextured ? 'textured' : 'clay';
const clayPreset = getArg('--clay-preset', mode === 'greybox' || mode === 'graybox' ? 'studio-grey' : 'warm-clay');

const latArg = getArg('--lat', null);
const lngArg = getArg('--lng', null);
const lat = latArg !== null ? parseFloat(latArg) : (address ? undefined : 40.7484405);
const lng = lngArg !== null ? parseFloat(lngArg) : (address ? undefined : -73.9856644);
const elevation = parseFloat(getArg('--elevation', '15.0'));

const cameraPath = getArg('--camera-path', null);
const errorTarget = parseFloat(getArg('--error-target', '0.5'));
const defaultOutput = isTextured ? 'public/videos/google_tiles_textured_blockout_camera.mp4' : 'public/videos/google_tiles_clay_blockout_camera.mp4';
const output = getArg('--output', defaultOutput);
const minClearance = parseFloat(getArg('--min-clearance', '12.0'));
const width = parseInt(getArg('--width', '3840'), 10);
const height = parseInt(getArg('--height', '2160'), 10);
const bitrate = getArg('--bitrate', '25M');
const port = parseInt(getArg('--port', '8098'), 10);
const offlineMock = args.includes('--offline-mock');

// Import the service directly from compiled dist
const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');

async function main() {
  const service = new Google3DTileBlockoutPipelineService(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/opt/homebrew/bin/ffmpeg'
  );

  let anchor;
  if (address) {
    anchor = await service.resolveAddress(address);
  } else if (lat !== undefined && lng !== undefined) {
    anchor = {
      lat,
      lng,
      elevation,
      landmarkName: `Geodetic Anchor (${lat.toFixed(6)}, ${lng.toFixed(6)})`
    };
  } else {
    anchor = await service.resolveAddress('Midtown Manhattan, coordinates: 40.748400, -73.985700');
  }

  console.log('========================================================================');
  console.log('🏛️ Google Photorealistic 3D Tile Camera Blockout Pipeline (<VIDEO_REF_0>)');
  console.log('========================================================================');
  console.log(`📍 Geodetic Anchor: ${anchor.landmarkName} (lat=${anchor.lat.toFixed(6)}, lng=${anchor.lng.toFixed(6)}, elevation=${anchor.elevation}m)`);
  console.log(`🎥 Camera Path:     ${cameraPath || 'Auto-Synthesized Flight Corridor (72 frames, waypoints [0, 18, 36, 54, 71])'}`);
  console.log(`🎯 LOD Quality:     errorTarget=${errorTarget} (Maximum Quality Leaf LOD)`);
  console.log(`🖥️ Resolution:      ${width}x${height} (4K UHD), Bitrate: ${bitrate}`);
  console.log(`🎨 Atmosphere:      mode=${atmosphere}, preset=${clayPreset}`);
  console.log(`📼 Target Video:    ${output}`);
  console.log('========================================================================\n');

  const request = {
    address,
    geoAnchor: anchor,
    mode: isTextured ? 'textured' : (mode || 'clay'),
    cameraPath: cameraPath || undefined,
    lodQuality: {
      errorTarget,
      resolutionWidth: width,
      resolutionHeight: height,
      virtualSseWidth: 3840,
      virtualSseHeight: 2160,
      stableFramesThreshold: 15,
      maxSettleWaitMs: 25000
    },
    atmosphere: {
      renderMode: atmosphere,
      clayPreset,
      clayColor: clayPreset === 'studio-grey' ? '#b0b8c4' : '#dcd6cd',
      roughness: 0.82,
      metalness: 0.02,
      skyColor: '#dce3eb',
      fogExp2Density: 0.0022,
      exposure: isTextured ? 1.0 : 1.15
    },
    collision: {
      enabled: true,
      minClearanceMeters: minClearance,
      autoAdjustAltitude: true
    },
    output: {
      outputVideoPath: output,
      framesDir: isTextured ? 'public/videos/frames_textured' : 'public/videos/frames_clay',
      firstFramePath: isTextured ? 'public/models/blockout_textured_first_frame.jpg' : 'public/models/blockout_first_frame.jpg',
      firstFramePngPath: isTextured ? 'public/images/blockout_textured_frame_00.png' : 'public/images/blockout_frame_00.png',
      storyboardsDir: isTextured ? 'public/storyboards_textured' : 'public/storyboards_clay',
      manifestPath: isTextured ? 'public/videos/google_tiles_textured_manifest.json' : 'public/videos/google_tiles_blockout_manifest.json',
      fps: 24,
      bitrate
    },
    port,
    offlineMock
  };

  try {
    const result = await service.run(request);
    console.log('\n========================================================================');
    console.log('✅ Pipeline Execution Completed Successfully!');
    console.log(`🎥 Video Reference:    ${result.videoRef}`);
    console.log(`📼 Output MP4:         ${result.outputVideoPath}`);
    console.log(`📸 Frame 0 (<IMAGE_REF_0> Precursor): ${result.firstFramePath}`);
    console.log(`🖼️ PNG Frame 0:        ${result.firstFramePngPath}`);
    console.log(`🎬 Total Frames:       ${result.frameCount} (${result.durationSec}s @ ${result.fps}fps)`);
    console.log(`📊 Avg Settle Time:    ${result.tileMetrics.averageSettleTimeMs} ms/frame`);
    console.log(`🛡️ Collision Audit:    Passed=${result.collisionAudit?.auditPassed}, Min Clearance=${result.collisionAudit?.minClearanceMeters}m, Violations=${result.collisionAudit?.violationsDetected}`);
    console.log(`📑 Manifest JSON:      ${result.manifestPath}`);
    if (isTextured) {
      const aliasPath = path.resolve('public/videos/google_tiles_textured_camera.mp4');
      fs.copyFileSync(result.outputVideoPath, aliasPath);
      console.log(`🔗 Created convenience alias: ${aliasPath}`);
    }
    console.log('========================================================================\n');
  } catch (err) {
    console.error('❌ Pipeline execution failed:', err);
    process.exit(1);
  }
}

main();
