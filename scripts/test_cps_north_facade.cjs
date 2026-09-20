const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: camera [22.0, 68.0, -18.0], target [30.0, 70.0, 2.0], fov 44
  { frame: 0, timeSec: 0.0, position: [22.0, 68.0, -18.0], target: [30.0, 70.0, 2.0], up: [0, 1, 0], fov: 44 },
  // 1: camera [20.0, 66.0, -14.0], target [28.0, 69.5, 2.0], fov 46
  { frame: 1, timeSec: 0.5, position: [20.0, 66.0, -14.0], target: [28.0, 69.5, 2.0], up: [0, 1, 0], fov: 46 },
  // 2: camera [24.0, 70.0, -22.0], target [31.0, 70.5, 3.0], fov 40
  { frame: 2, timeSec: 1.0, position: [24.0, 70.0, -22.0], target: [31.0, 70.5, 3.0], up: [0, 1, 0], fov: 40 },
  // 3: camera [18.0, 65.0, -12.0], target [27.0, 69.0, 1.0], fov 48
  { frame: 3, timeSec: 1.5, position: [18.0, 65.0, -12.0], target: [27.0, 69.0, 1.0], up: [0, 1, 0], fov: 48 },
  // 4: camera [26.0, 71.0, -26.0], target [32.0, 71.0, 4.0], fov 36
  { frame: 4, timeSec: 2.0, position: [26.0, 71.0, -26.0], target: [32.0, 71.0, 4.0], up: [0, 1, 0], fov: 36 },
  // 5: camera [21.0, 67.0, -16.0], target [29.0, 70.0, 1.0], fov 42
  { frame: 5, timeSec: 2.5, position: [21.0, 67.0, -16.0], target: [29.0, 70.0, 1.0], up: [0, 1, 0], fov: 42 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_cps_north_facade');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_cps_north_facade_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 candidate viewpoints from Central Park South looking SE...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Central Park South Looking SE'
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
      outputVideoPath: path.join(outputDir, 'test_cps.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering Central Park South viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
