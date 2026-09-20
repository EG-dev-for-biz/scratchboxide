const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: camera [42.0, 72.0, 52.0], target [26.0, 72.0, 34.0], fov 46
  { frame: 0, timeSec: 0.0, position: [42.0, 72.0, 52.0], target: [26.0, 72.0, 34.0], up: [0, 1, 0], fov: 46 },
  // 1: camera [40.0, 71.5, 50.0], target: [26.0, 71.5, 34.0], fov 44
  { frame: 1, timeSec: 0.5, position: [40.0, 71.5, 50.0], target: [26.0, 71.5, 34.0], up: [0, 1, 0], fov: 44 },
  // 2: camera [38.0, 71.0, 48.0], target: [25.0, 71.5, 33.0], fov 42
  { frame: 2, timeSec: 1.0, position: [38.0, 71.0, 48.0], target: [25.0, 71.5, 33.0], up: [0, 1, 0], fov: 42 },
  // 3: camera [44.0, 72.5, 54.0], target: [27.0, 72.0, 35.0], fov 42
  { frame: 3, timeSec: 1.5, position: [44.0, 72.5, 54.0], target: [27.0, 72.0, 35.0], up: [0, 1, 0], fov: 42 },
  // 4: camera [42.0, 70.5, 48.0], target: [28.0, 71.5, 34.0], fov 48
  { frame: 4, timeSec: 2.0, position: [42.0, 70.5, 48.0], target: [28.0, 71.5, 34.0], up: [0, 1, 0], fov: 48 },
  // 5: camera [36.0, 70.0, 46.0], target: [24.0, 71.0, 32.0], fov 44
  { frame: 5, timeSec: 2.5, position: [36.0, 70.0, 46.0], target: [24.0, 71.0, 32.0], up: [0, 1, 0], fov: 44 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_south_perfect_f0');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_south_perfect_f0_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 candidate viewpoints for South Wing F0...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC South Wing F0'
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
      outputVideoPath: path.join(outputDir, 'test_south_f0.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering South Wing F0 viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
