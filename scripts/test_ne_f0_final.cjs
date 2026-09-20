const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: camera [54.0, 72.5, 0.0], target [30.0, 71.0, 5.0], fov 40
  { frame: 0, timeSec: 0.0, position: [54.0, 72.5, 0.0], target: [30.0, 71.0, 5.0], up: [0, 1, 0], fov: 40 },
  // 1: camera [52.0, 72.0, 1.0], target [29.0, 71.0, 6.0], fov 42
  { frame: 1, timeSec: 0.5, position: [52.0, 72.0, 1.0], target: [29.0, 71.0, 6.0], up: [0, 1, 0], fov: 42 },
  // 2: camera [55.0, 73.0, -1.0], target: [31.0, 71.5, 5.5], fov 38
  { frame: 2, timeSec: 1.0, position: [55.0, 73.0, -1.0], target: [31.0, 71.5, 5.5], up: [0, 1, 0], fov: 38 },
  // 3: camera [53.0, 71.5, 0.0], target: [29.5, 70.5, 5.5], fov 40
  { frame: 3, timeSec: 1.5, position: [53.0, 71.5, 0.0], target: [29.5, 70.5, 5.5], up: [0, 1, 0], fov: 40 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_ne_f0_final');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_ne_f0_final_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 candidate viewpoints for NE corner final F0...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC NE F0 Final'
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
      outputVideoPath: path.join(outputDir, 'test_final_f0.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering final F0 candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
