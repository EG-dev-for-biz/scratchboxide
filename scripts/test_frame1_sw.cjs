const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Camera positioned North of the corner (Z = -2 to -8m), looking South-West (towards Z = 6-8m, X = 33-35m)
// This places Solow building behind the left edge of the gable, gable at X~25-30%, and turret at X~65-70%
const candidatePoses = [
  // 0: Camera at [50, 68.0, -4.0], target [33.0, 70.0, 5.0], FOV 34
  { frame: 0, timeSec: 0.0, position: [50.0, 68.0, -4.0], target: [33.0, 70.0, 5.0], up: [0, 1, 0], fov: 34.0 },
  // 1: Camera at [52, 68.5, -6.0], target [33.5, 70.5, 4.5], FOV 32
  { frame: 1, timeSec: 0.5, position: [52.0, 68.5, -6.0], target: [33.5, 70.5, 4.5], up: [0, 1, 0], fov: 32.0 },
  // 2: Camera at [48, 67.5, -2.0], target [32.5, 69.5, 5.5], FOV 36
  { frame: 2, timeSec: 1.0, position: [48.0, 67.5, -2.0], target: [32.5, 69.5, 5.5], up: [0, 1, 0], fov: 36.0 },
  // 3: Camera at [54, 69.0, -8.0], target [34.0, 71.0, 4.0], FOV 30
  { frame: 3, timeSec: 1.5, position: [54.0, 69.0, -8.0], target: [34.0, 71.0, 4.0], up: [0, 1, 0], fov: 30.0 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_frame1_sw');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_frame1_sw_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 South-West candidate viewpoints for Frame 1...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 1 SW Exact Match'
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
      outputVideoPath: path.join(outputDir, 'test_frame1_sw.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering South-West candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
