const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// We want the building/canopy at the TOP of the frame, street at the BOTTOM.
// Vector from street to building is into the hotel facade (-X, and either +Z or -Z).
const candidateNadirPoses = [
  // 0: up = [-0.875, 0, -0.485]
  { frame: 0, timeSec: 0.0, position: [42.0, 16.0, 10.5], target: [42.0, 0.0, 10.5], up: [-0.875, 0, -0.485], fov: 46.0 },
  // 1: up = [-0.875, 0, 0.485]
  { frame: 1, timeSec: 0.5, position: [42.0, 16.0, 10.5], target: [42.0, 0.0, 10.5], up: [-0.875, 0, 0.485], fov: 46.0 },
  // 2: up = [-1.0, 0, 0.0] (pure West)
  { frame: 2, timeSec: 1.0, position: [42.0, 16.0, 10.5], target: [42.0, 0.0, 10.5], up: [-1.0, 0, 0.0], fov: 46.0 }
];

const testPathData = {
  totalFrames: candidateNadirPoses.length,
  fps: 24,
  durationSec: 1.5,
  frames: candidateNadirPoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_nadir_up');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_nadir_up_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 3 Nadir Up Candidates...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Nadir Up'
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
      outputVideoPath: path.join(outputDir, 'test_nadir_up.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering Nadir Up candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
