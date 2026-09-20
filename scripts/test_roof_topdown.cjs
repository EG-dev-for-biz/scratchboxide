const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const testFrames = [
  // 0: Overhead bird's eye view of the whole Plaza Hotel roof
  { frame: 0, timeSec: 0.0, position: [20.0, 140.0, 20.0], target: [20.0, 60.0, 20.0], up: [0, 0, -1], fov: 65 },
  // 1: Angled bird's eye view from East looking West over roof
  { frame: 1, timeSec: 0.5, position: [80.0, 110.0, 20.0], target: [20.0, 60.0, 20.0], up: [0, 1, 0], fov: 55 },
  // 2: Angled bird's eye view from North looking South over roof
  { frame: 2, timeSec: 1.0, position: [20.0, 110.0, -40.0], target: [20.0, 60.0, 20.0], up: [0, 1, 0], fov: 55 },
  // 3: Angled bird's eye view from South looking North over roof
  { frame: 3, timeSec: 1.5, position: [20.0, 110.0, 80.0], target: [20.0, 60.0, 20.0], up: [0, 1, 0], fov: 55 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 1.5,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_roof_topdown');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_roof_topdown_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering top-down roof overview...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Roof'
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
    outputDirectory: outputDir,
    outputVideoPath: path.join(outputDir, 'test_roof.mp4'),
    saveFrames: true
  });
  console.log('Done rendering roof overview!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
