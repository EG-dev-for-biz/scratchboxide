#!/usr/bin/env node
/********************************************************************************
 * Plaza Hotel NYC Pipeline Runner (<VIDEO_REF_0> & Video Synthesis)
 *
 * Runs the Google 3D Tile Blockout Pipeline specifically anchored at:
 * The Plaza Hotel NYC (Lat: 40.7645, Lng: -73.9744, Elevation: 18.0m)
 ********************************************************************************/

const path = require('path');
const fs = require('fs');

const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');

const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const atmosphere = getArg('--atmosphere', 'textured');
const isTextured = atmosphere === 'textured' || atmosphere === 'photoreal';
const clayPreset = getArg('--clay-preset', 'warm-clay');
const errorTarget = parseFloat(getArg('--error-target', '0.5'));
const port = parseInt(getArg('--port', '8102'), 10);
const width = parseInt(getArg('--width', '3840'), 10);
const height = parseInt(getArg('--height', '2160'), 10);
const bitrate = getArg('--bitrate', '25M');

async function main() {
  console.log('========================================================================');
  console.log('🏨 The Plaza Hotel NYC — 3D Photorealistic Tiles Blockout Pipeline');
  console.log('========================================================================');
  console.log(`📍 Geodetic Anchor: lat=40.764500, lng=-73.974400, elevation=18.0m`);
  console.log(`🎥 Camera Path:     public/models/plaza_hotel_camera_path.json`);
  console.log(`🎨 Atmosphere:      mode=${atmosphere}`);
  console.log(`🖥️ Resolution:      ${width}x${height} (4K UHD)`);
  console.log('========================================================================\n');

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const ffmpegPath = '/opt/homebrew/bin/ffmpeg';

  const service = new Google3DTileBlockoutPipelineService(chromePath, ffmpegPath);

  const request = {
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC (Central Park South)'
    },
    cameraPath: 'public/models/plaza_hotel_camera_path.json',
    lodQuality: {
      errorTarget,
      resolutionWidth: width,
      resolutionHeight: height,
      virtualSseWidth: 3840,
      virtualSseHeight: 2160,
      stableFramesThreshold: 8,
      maxSettleWaitMs: 15000
    },
    atmosphere: {
      renderMode: atmosphere,
      clayPreset,
      clayColor: clayPreset === 'studio-grey' ? '#b0b8c4' : '#dcd6cd',
      roughness: 0.82,
      metalness: 0.02,
      skyColor: '#dce3eb',
      fogExp2Density: 0.0022,
      exposure: isTextured ? 1.05 : 1.15
    },
    collision: {
      enabled: false
    },
    output: {
      outputVideoPath: 'public/videos/plaza_hotel_blockout_camera.mp4',
      framesDir: 'public/videos/frames_plaza',
      firstFramePath: 'public/models/plaza_hotel_first_frame.jpg',
      firstFramePngPath: 'public/images/plaza_hotel_frame_00.png',
      storyboardsDir: 'public/storyboards_plaza',
      manifestPath: 'public/videos/plaza_hotel_blockout_manifest.json',
      fps: 24,
      bitrate
    },
    port
  };

  try {
    const result = await service.run(request);
    if (result.firstFramePngPath && fs.existsSync(result.firstFramePngPath)) {
      fs.copyFileSync(result.firstFramePngPath, path.join(process.cwd(), 'public/images/plaza_hotel_start_frame.png'));
    }
    console.log('\n========================================================================');
    console.log('✅ Plaza Hotel Blockout Pipeline Completed Successfully!');
    console.log(`🎥 Video Reference:    ${result.videoRef}`);
    console.log(`📼 Output MP4:         ${result.outputVideoPath}`);
    console.log(`📸 Frame 0:            ${result.firstFramePath}`);
    console.log(`🖼️ PNG Frame 0:        ${result.firstFramePngPath}`);
    console.log(`🎬 Total Frames:       ${result.frameCount} (${result.durationSec}s @ ${result.fps}fps)`);
    console.log(`🛡️ Collision Audit:    Passed=${result.collisionAudit?.auditPassed}, Min Clearance=${result.collisionAudit?.minClearanceMeters}m`);
    console.log('========================================================================\n');
  } catch (err) {
    console.error('❌ Pipeline execution failed:', err);
    process.exit(1);
  }
}

main();
