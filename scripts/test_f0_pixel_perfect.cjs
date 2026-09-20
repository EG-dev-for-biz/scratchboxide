const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: camera [48.0, 65.0, 0.0], target [32.0, 69.5, 5.0], fov 36
  { frame: 0, timeSec: 0.0, position: [48.0, 65.0, 0.0], target: [32.0, 69.5, 5.0], up: [0, 1, 0], fov: 36 },
  // 1: camera [46.0, 64.0, 0.0], target [31.0, 69.0, 5.0], fov 38
  { frame: 1, timeSec: 0.5, position: [46.0, 64.0, 0.0], target: [31.0, 69.0, 5.0], up: [0, 1, 0], fov: 38 },
  // 2: camera [50.0, 66.0, -1.0], target [33.0, 70.0, 5.0], fov 35
  { frame: 2, timeSec: 1.0, position: [50.0, 66.0, -1.0], target: [33.0, 70.0, 5.0], up: [0, 1, 0], fov: 35 },
  // 3: camera [45.0, 65.0, 1.0], target [31.0, 69.5, 6.0], fov 36
  { frame: 3, timeSec: 1.5, position: [45.0, 65.0, 1.0], target: [31.0, 69.5, 6.0], up: [0, 1, 0], fov: 36 },
  // 4: camera [47.0, 63.5, 1.0], target [32.0, 68.5, 6.0], fov 38
  { frame: 4, timeSec: 2.0, position: [47.0, 63.5, 1.0], target: [32.0, 68.5, 6.0], up: [0, 1, 0], fov: 38 },
  // 5: camera [49.0, 65.0, 1.0], target [33.0, 69.5, 6.5], fov 34
  { frame: 5, timeSec: 2.5, position: [49.0, 65.0, 1.0], target: [33.0, 69.5, 6.5], up: [0, 1, 0], fov: 34 },
  // 6: camera [46.0, 63.0, -1.0], target [31.0, 68.5, 4.5], fov 38
  { frame: 6, timeSec: 3.0, position: [46.0, 63.0, -1.0], target: [31.0, 68.5, 4.5], up: [0, 1, 0], fov: 38 },
  // 7: camera [48.0, 66.0, 2.0], target [32.0, 70.0, 7.0], fov 34
  { frame: 7, timeSec: 3.5, position: [48.0, 66.0, 2.0], target: [32.0, 70.0, 7.0], up: [0, 1, 0], fov: 34 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_pixel_perfect');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_pixel_perfect_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 candidate viewpoints for pixel-perfect Frame 0...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Pixel Perfect F0'
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
      outputVideoPath: path.join(outputDir, 'test_f0_perfect.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering pixel-perfect Frame 0 candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
