const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Looking North-Northwest at the South-East corner from 58th St / Grand Army Plaza South
const candidatePoses = [
  // 0: pos Z=45, X=35 looking at Z=32, X=20
  { frame: 0, timeSec: 0.0, position: [35.0, 68.0, 48.0], target: [20.0, 71.0, 32.0], up: [0, 1, 0], fov: 42 },
  // 1: pos Z=50, X=40 looking at Z=32, X=22
  { frame: 1, timeSec: 0.5, position: [40.0, 68.0, 50.0], target: [22.0, 71.0, 32.0], up: [0, 1, 0], fov: 40 },
  // 2: pos Z=45, X=42 looking at Z=34, X=24
  { frame: 2, timeSec: 1.0, position: [42.0, 67.0, 46.0], target: [24.0, 71.0, 34.0], up: [0, 1, 0], fov: 38 },
  // 3: pos Z=52, X=36 looking at Z=30, X=18
  { frame: 3, timeSec: 1.5, position: [36.0, 69.0, 52.0], target: [18.0, 71.0, 30.0], up: [0, 1, 0], fov: 42 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_south_wing');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_south_wing_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 south-wing viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC South Wing'
    },
    cameraPath: testPathFile,
    lodQuality: {
      errorTarget: 0.5,
      resolutionWidth: 1280,
      resolutionHeight: 720,
      virtualSseWidth: 1920,
      virtualSseHeight: 1080,
      stableFramesThreshold: 4,
      maxSettleWaitMs: 8000
    },
    atmosphere: {
      renderMode: 'textured',
      roughness: 0.82,
      metalness: 0.02,
      skyColor: '#dce3eb',
      exposure: 1.05
    },
    collision: {
      enabled: false,
      minClearanceMeters: 5.0,
      autoAdjustAltitude: false
    },
    output: {
      outputVideoPath: path.join(outputDir, 'test_south_wing.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'sw_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8119
  });

  console.log('Done rendering south wing:', result);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
