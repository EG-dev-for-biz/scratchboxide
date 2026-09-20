const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const service = new Google3DTileBlockoutPipelineService();

async function main() {
  const framesDir = path.join(process.cwd(), 'public/videos/full_flight_frames');
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  const cameraPathFile = path.join(process.cwd(), 'public/models/plaza_hotel_camera_path.json');
  const outputVideoPath = path.join(process.cwd(), 'public/videos/plaza_hotel_blockout_camera.mp4');

  console.log('🚀 Starting Full 15-Second 360-Frame 3D Tile Blockout Render...');
  console.log(`Camera Path: ${cameraPathFile}`);
  console.log(`Target Video: ${outputVideoPath}`);

  const startTime = Date.now();
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel 15s Exact Matchmove'
    },
    cameraPath: cameraPathFile,
    lodQuality: {
      errorTarget: 0.5,
      resolutionWidth: 1280,
      resolutionHeight: 720,
      virtualSseWidth: 1920,
      virtualSseHeight: 1080,
      stableFramesThreshold: 2,
      maxSettleWaitMs: 3000
    },
    atmosphere: {
      renderMode: 'textured',
      roughness: 0.82,
      metalness: 0.02,
      skyColor: '#dce3eb',
      exposure: 1.05
    },
    output: {
      outputVideoPath: outputVideoPath,
      framesDir: framesDir
    }
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`🎉 3D Tile Blockout video render completed in ${durationSec}s!`);

  // Verify file exists and has non-zero size
  const stats = fs.statSync(outputVideoPath);
  console.log(`Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  const mirroredPath = path.join(process.cwd(), 'public/videos/google_tiles_textured_blockout_camera.mp4');
  fs.copyFileSync(outputVideoPath, mirroredPath);
  console.log(`Mirrored to: ${mirroredPath}`);
}

main().catch(err => {
  console.error('Fatal error rendering full flight:', err);
  process.exit(1);
});
