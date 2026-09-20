const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Camera positioned on 58th St side, looking North-East towards the South-East corner turret
// So that the South gable is on the LEFT, and the corner turret is on the RIGHT!
const candidatePoses = [
  // 0: camera at X=16, Z=54, looking at X=30, Z=38, Y=70
  { frame: 0, timeSec: 0.0, position: [16.0, 70.0, 54.0], target: [30.0, 72.0, 38.0], up: [0, 1, 0], fov: 42 },
  // 1: camera at X=20, Z=56, looking at X=32, Z=40, Y=71
  { frame: 1, timeSec: 0.5, position: [20.0, 71.0, 56.0], target: [32.0, 72.0, 40.0], up: [0, 1, 0], fov: 40 },
  // 2: camera at X=18, Z=50, looking at X=28, Z=38, Y=70
  { frame: 2, timeSec: 1.0, position: [18.0, 70.0, 50.0], target: [28.0, 71.5, 38.0], up: [0, 1, 0], fov: 44 },
  // 3: camera at X=22, Z=52, looking at X=32, Z=38, Y=72
  { frame: 3, timeSec: 1.5, position: [22.0, 72.0, 52.0], target: [32.0, 72.5, 38.0], up: [0, 1, 0], fov: 42 },
  // 4: camera closer: X=24, Z=48, looking at X=32, Z=38, Y=72
  { frame: 4, timeSec: 2.0, position: [24.0, 71.5, 48.0], target: [32.0, 72.0, 38.0], up: [0, 1, 0], fov: 46 },
  // 5: camera at X=26, Z=50, looking at X=34, Z=39, Y=72
  { frame: 5, timeSec: 2.5, position: [26.0, 72.0, 50.0], target: [34.0, 72.0, 39.0], up: [0, 1, 0], fov: 44 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_south_gable_turret');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_south_gable_turret_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 candidate viewpoints for South gable + corner turret...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC South Gable Turret'
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
    output: {
      outputVideoPath: path.join(outputDir, 'test_gable_turret.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering candidate viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
