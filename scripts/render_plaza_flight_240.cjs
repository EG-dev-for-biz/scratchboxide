const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

// Load .env
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  });
}

const service = new Google3DTileBlockoutPipelineService();

async function main() {
  const framesDir = path.join(process.cwd(), 'public/videos/frames_plaza_240');
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  const cameraPathFile = path.join(process.cwd(), 'public/models/plaza_hotel_camera_path_240.json');
  const outputVideoPath = path.join(process.cwd(), 'public/videos/plaza_hotel_blockout_240.mp4');

  console.log('🚀 Starting Calibrated 240-Frame (10s) 3D Tile Blockout Render via Three.js / Google 3D Tiles...');
  console.log(`Camera Path: ${cameraPathFile}`);
  console.log(`Target Video: ${outputVideoPath}`);

  const startTime = Date.now();
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel 10s Exact Matchmove'
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
    collision: {
      enabled: false
    },
    output: {
      outputVideoPath: outputVideoPath,
      framesDir: framesDir
    }
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`🎉 Calibrated 3D Tile Blockout render completed in ${durationSec}s!`);
}

main().catch(err => {
  console.error('Fatal error rendering 240-frame flight:', err);
  process.exit(1);
});
