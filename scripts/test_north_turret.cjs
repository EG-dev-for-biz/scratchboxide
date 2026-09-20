const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Testing exact line up of North Wing turret (on right) and dormer (on left)
const testFrames = [
  // 0: Camera at X=48, Z=10, looking at X=24, Z=8, Y=72.5, fov=44
  { frame: 0, timeSec: 0.0, position: [48.0, 72.5, 10.0], target: [24.0, 72.5, 8.0], up: [0, 1, 0], fov: 44 },
  // 1: Camera at X=45, Z=10, looking at X=25, Z=7.5, Y=72.5, fov=44
  { frame: 1, timeSec: 0.5, position: [45.0, 72.5, 10.0], target: [25.0, 72.5, 7.5], up: [0, 1, 0], fov: 44 },
  // 2: Camera at X=44, Z=8, looking at X=24, Z=6.5, Y=72.0, fov=44
  { frame: 2, timeSec: 1.0, position: [44.0, 72.0, 8.0], target: [24.0, 72.0, 6.5], up: [0, 1, 0], fov: 44 },
  // 3: Camera at X=46, Z=8, looking at X=24, Z=6.5, Y=72.0, fov=44
  { frame: 3, timeSec: 1.5, position: [46.0, 72.0, 8.0], target: [24.0, 72.0, 6.5], up: [0, 1, 0], fov: 44 },
  // 4: Camera at X=42, Z=11, looking at X=23, Z=8.0, Y=72.5, fov=46
  { frame: 4, timeSec: 2.0, position: [42.0, 72.5, 11.0], target: [23.0, 72.5, 8.0], up: [0, 1, 0], fov: 46 },
  // 5: Camera at X=40, Z=10, looking at X=24, Z=7.0, Y=72.0, fov=46
  { frame: 5, timeSec: 2.5, position: [40.0, 72.0, 10.0], target: [24.0, 72.0, 7.0], up: [0, 1, 0], fov: 46 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 3.0,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_north_turret');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_north_turret_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 North Turret candidate viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC North Turret'
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
      skyBox: false,
      groundPlane: false
    },
    outputDirectory: outputDir,
    outputVideoPath: path.join(outputDir, 'test_north_turret.mp4')
  });

  console.log('Done rendering North Turret viewpoints:', result);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
