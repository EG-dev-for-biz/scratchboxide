const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Testing multiple poses around North Wing (Z around 6 to 18)
const testFrames = [
  // 0: Looking at North Wing from East (camera at X=48, Z=14, looking at X=24, Z=12, Y=72)
  { frame: 0, timeSec: 0.0, position: [48.0, 72.0, 14.0], target: [24.0, 73.0, 12.0], up: [0, 1, 0], fov: 46 },
  // 1: Slightly lower and further back (camera at X=46, Z=16, looking at X=24, Z=10, Y=70)
  { frame: 1, timeSec: 0.5, position: [46.0, 70.0, 16.0], target: [24.0, 72.0, 10.0], up: [0, 1, 0], fov: 46 },
  // 2: Closer to dormer and turret (camera at X=40, Z=15, looking at X=24, Z=11, Y=71)
  { frame: 2, timeSec: 1.0, position: [40.0, 71.0, 15.0], target: [24.0, 72.0, 11.0], up: [0, 1, 0], fov: 46 },
  // 3: Slightly to the north (camera at X=44, Z=10, looking at X=22, Z=10, Y=72)
  { frame: 3, timeSec: 1.5, position: [44.0, 72.0, 10.0], target: [22.0, 72.5, 10.0], up: [0, 1, 0], fov: 46 },
  // 4: Elevating to 74m (camera at X=42, Z=14, looking at X=24, Z=11, Y=73)
  { frame: 4, timeSec: 2.0, position: [42.0, 73.5, 14.0], target: [24.0, 73.0, 11.0], up: [0, 1, 0], fov: 44 },
  // 5: Matching ref_f0 framing: dormer on left, turret on right (camera at X=38, Z=16, looking at X=22, Z=11, Y=72)
  { frame: 5, timeSec: 2.5, position: [38.0, 72.0, 16.0], target: [22.0, 72.5, 11.5], up: [0, 1, 0], fov: 42 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 3.0,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_north_wing');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_north_wing_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 North Wing candidate viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC North Wing'
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
    outputVideoPath: path.join(outputDir, 'test_north_wing.mp4')
  });

  console.log('Done rendering North Wing viewpoints:', result);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
