const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Test looking South / South-West (positive Z look direction)
const candidatePoses = [
  // 0: From North-East (Grand Army Plaza North) looking South-West
  { frame: 0, timeSec: 0.0, position: [30.0, 68.0, -20.0], target: [15.0, 70.0, 5.0], up: [0, 1, 0], fov: 42 },
  // 1: From North (Central Park South) looking South
  { frame: 1, timeSec: 0.5, position: [15.0, 68.0, -25.0], target: [15.0, 70.0, 5.0], up: [0, 1, 0], fov: 42 },
  // 2: From North-West looking South-East
  { frame: 2, timeSec: 1.0, position: [-5.0, 68.0, -20.0], target: [15.0, 70.0, 5.0], up: [0, 1, 0], fov: 42 },
  // 3: From East-North-East looking South-South-West
  { frame: 3, timeSec: 1.5, position: [40.0, 66.0, -10.0], target: [20.0, 70.0, 10.0], up: [0, 1, 0], fov: 40 },
  // 4: Closer North-East looking at North-East corner turret & dormer
  { frame: 4, timeSec: 2.0, position: [35.0, 68.0, -10.0], target: [22.0, 71.0, 6.0], up: [0, 1, 0], fov: 40 },
  // 5: Slightly higher and more angled
  { frame: 5, timeSec: 2.5, position: [38.0, 70.0, -5.0], target: [22.0, 71.0, 8.0], up: [0, 1, 0], fov: 38 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_look_south');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_look_south_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 look-south viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Look South'
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
      outputVideoPath: path.join(outputDir, 'test_look_south.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 's_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8117
  });

  console.log('Done rendering look south:', result);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
