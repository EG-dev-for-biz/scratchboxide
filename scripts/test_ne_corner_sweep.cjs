const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Fine sweep of viewpoints around North-East corner (5th Ave / 59th St)
const candidatePoses = [
  // 0: camera [54.0, 72.5, 4.0], target [28.0, 71.5, 8.0], fov 42
  { frame: 0, timeSec: 0.0, position: [54.0, 72.5, 4.0], target: [28.0, 71.5, 8.0], up: [0, 1, 0], fov: 42 },
  // 1: camera [52.0, 72.0, 2.0], target [28.0, 71.0, 7.0], fov 44
  { frame: 1, timeSec: 0.5, position: [52.0, 72.0, 2.0], target: [28.0, 71.0, 7.0], up: [0, 1, 0], fov: 44 },
  // 2: camera [56.0, 73.0, 6.0], target [30.0, 72.0, 9.0], fov 40
  { frame: 2, timeSec: 1.0, position: [56.0, 73.0, 6.0], target: [30.0, 72.0, 9.0], up: [0, 1, 0], fov: 40 },
  // 3: camera [50.0, 73.0, 0.0], target [26.0, 71.5, 6.0], fov 46
  { frame: 3, timeSec: 1.5, position: [50.0, 73.0, 0.0], target: [26.0, 71.5, 6.0], up: [0, 1, 0], fov: 46 },
  // 4: camera [58.0, 74.0, 4.0], target [30.0, 72.0, 8.0], fov 38
  { frame: 4, timeSec: 2.0, position: [58.0, 74.0, 4.0], target: [30.0, 72.0, 8.0], up: [0, 1, 0], fov: 38 },
  // 5: camera [48.0, 71.5, 4.0], target [28.0, 71.0, 8.0], fov 46
  { frame: 5, timeSec: 2.5, position: [48.0, 71.5, 4.0], target: [28.0, 71.0, 8.0], up: [0, 1, 0], fov: 46 },
  // 6: camera [54.0, 71.0, -2.0], target [28.0, 71.0, 6.0], fov 42
  { frame: 6, timeSec: 3.0, position: [54.0, 71.0, -2.0], target: [28.0, 71.0, 6.0], up: [0, 1, 0], fov: 42 },
  // 7: camera [60.0, 73.5, 2.0], target [30.0, 71.5, 7.0], fov 36
  { frame: 7, timeSec: 3.5, position: [60.0, 73.5, 2.0], target: [30.0, 71.5, 7.0], up: [0, 1, 0], fov: 36 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_ne_corner_sweep');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_ne_corner_sweep_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 candidate viewpoints for North-East corner...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC NE Corner'
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
      outputVideoPath: path.join(outputDir, 'test_ne_corner.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering candidate viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
