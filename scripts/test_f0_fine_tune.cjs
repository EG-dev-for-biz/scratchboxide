const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: [52, 68, -1] -> target [30, 69, 5]
  { frame: 0, timeSec: 0.0, position: [52.0, 68.0, -1.0], target: [30.0, 69.0, 5.0], up: [0, 1, 0], fov: 40 },
  // 1: [50, 67, 0] -> target [29, 68, 5]
  { frame: 1, timeSec: 0.5, position: [50.0, 67.0, 0.0], target: [29.0, 68.0, 5.0], up: [0, 1, 0], fov: 42 },
  // 2: [53, 69, 0] -> target [30, 70, 5]
  { frame: 2, timeSec: 1.0, position: [53.0, 69.0, 0.0], target: [30.0, 70.0, 5.0], up: [0, 1, 0], fov: 39 },
  // 3: [48, 66, 1] -> target [28, 67, 5]
  { frame: 3, timeSec: 1.5, position: [48.0, 66.0, 1.0], target: [28.0, 67.0, 5.0], up: [0, 1, 0], fov: 44 },
  // 4: [54, 70, -1.5] -> target [31, 70, 5]
  { frame: 4, timeSec: 2.0, position: [54.0, 70.0, -1.5], target: [31.0, 70.0, 5.0], up: [0, 1, 0], fov: 38 },
  // 5: [51, 68.5, -0.5] -> target [30, 69.5, 5]
  { frame: 5, timeSec: 2.5, position: [51.0, 68.5, -0.5], target: [30.0, 69.5, 5.0], up: [0, 1, 0], fov: 41 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_fine_tune');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_fine_tune_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 fine-tuned F0 candidates...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC F0 Fine Tune'
    },
    cameraPath: testPathFile,
    collision: { enabled: false },
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
      outputVideoPath: path.join(outputDir, 'fine_tune.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering fine-tune candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
