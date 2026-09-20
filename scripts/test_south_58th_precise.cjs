const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: camera [36.0, 68.0, 52.0], target [28.0, 71.0, 36.0], fov 46
  { frame: 0, timeSec: 0.0, position: [36.0, 68.0, 52.0], target: [28.0, 71.0, 36.0], up: [0, 1, 0], fov: 46 },
  // 1: camera [34.0, 67.0, 50.0], target [27.0, 70.5, 36.0], fov 48
  { frame: 1, timeSec: 0.5, position: [34.0, 67.0, 50.0], target: [27.0, 70.5, 36.0], up: [0, 1, 0], fov: 48 },
  // 2: camera [38.0, 68.5, 54.0], target [29.0, 71.0, 37.0], fov 44
  { frame: 2, timeSec: 1.0, position: [38.0, 68.5, 54.0], target: [29.0, 71.0, 37.0], up: [0, 1, 0], fov: 44 },
  // 3: camera [32.0, 66.0, 48.0], target [26.0, 70.0, 36.0], fov 50
  { frame: 3, timeSec: 1.5, position: [32.0, 66.0, 48.0], target: [26.0, 70.0, 36.0], up: [0, 1, 0], fov: 50 },
  // 4: camera [35.0, 69.0, 52.0], target [28.5, 71.5, 37.0], fov 44
  { frame: 4, timeSec: 2.0, position: [35.0, 69.0, 52.0], target: [28.5, 71.5, 37.0], up: [0, 1, 0], fov: 44 },
  // 5: camera [37.0, 67.5, 50.0], target [30.0, 70.5, 37.0], fov 46
  { frame: 5, timeSec: 2.5, position: [37.0, 67.5, 50.0], target: [30.0, 70.5, 37.0], up: [0, 1, 0], fov: 46 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_south_58th_precise');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_south_58th_precise_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 candidate viewpoints for 58th St South facade...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC 58th St South Facade'
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
      outputVideoPath: path.join(outputDir, 'test_58th.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering 58th St South facade viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
