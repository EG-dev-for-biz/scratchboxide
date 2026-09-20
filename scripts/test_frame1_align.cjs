const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// 4 candidate viewpoints with eye-level elevation (Y=66.5 to 69.5) and target at Y=69-70.5
// Gable peak at 25%, Turret at 65%, Balcony bowl at center-left
const candidatePoses = [
  // 0: Camera at [58, 68.5, 5.0], target [33, 70.0, 5.5], FOV 38
  { frame: 0, timeSec: 0.0, position: [58.0, 68.5, 5.0], target: [33.0, 70.0, 5.5], up: [0, 1, 0], fov: 38.0 },
  // 1: Camera at [56, 67.5, 4.5], target [32.5, 69.5, 5.0], FOV 40
  { frame: 1, timeSec: 0.5, position: [56.0, 67.5, 4.5], target: [32.5, 69.5, 5.0], up: [0, 1, 0], fov: 40.0 },
  // 2: Camera at [60, 69.5, 5.5], target [33.5, 70.5, 6.0], FOV 36
  { frame: 2, timeSec: 1.0, position: [60.0, 69.5, 5.5], target: [33.5, 70.5, 6.0], up: [0, 1, 0], fov: 36.0 },
  // 3: Camera at [54, 66.5, 4.0], target [32.0, 69.0, 4.5], FOV 42
  { frame: 3, timeSec: 1.5, position: [54.0, 66.5, 4.0], target: [32.0, 69.0, 4.5], up: [0, 1, 0], fov: 42.0 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_frame1_align');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_frame1_align_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 alignment candidates for Frame 1...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 1 Alignment'
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
      outputVideoPath: path.join(outputDir, 'test_frame1_align.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering alignment candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
