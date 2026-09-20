const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's test telephoto viewpoints from Grand Army Plaza looking at the East facade roof / South wing roof
// We will test several positions along GAP (X = 65..85, Z = 15..45, Y = 68..78) with FOV 20..26
const candidatePoses = [
  // 0: GAP North looking SW at South-East roof
  { frame: 0, timeSec: 0.0, position: [75.0, 74.0, 20.0], target: [30.0, 71.0, 36.0], up: [0, 1, 0], fov: 24 },
  // 1: GAP Center looking SW at South-East roof
  { frame: 1, timeSec: 0.5, position: [75.0, 73.0, 28.0], target: [32.0, 71.5, 38.0], up: [0, 1, 0], fov: 22 },
  // 2: GAP South looking WNW at South-East corner
  { frame: 2, timeSec: 1.0, position: [75.0, 72.0, 36.0], target: [33.0, 71.5, 38.0], up: [0, 1, 0], fov: 20 },
  // 3: Further GAP North looking SW
  { frame: 3, timeSec: 1.5, position: [85.0, 76.0, 15.0], target: [31.0, 71.0, 35.0], up: [0, 1, 0], fov: 20 },
  // 4: GAP slightly lower, looking SW
  { frame: 4, timeSec: 2.0, position: [70.0, 70.0, 22.0], target: [30.0, 71.0, 36.0], up: [0, 1, 0], fov: 25 },
  // 5: GAP looking at North-East roof from South
  { frame: 5, timeSec: 2.5, position: [75.0, 74.0, 25.0], target: [31.0, 71.0, 5.0], up: [0, 1, 0], fov: 24 },
  // 6: GAP looking West at East Facade South Gable
  { frame: 6, timeSec: 3.0, position: [70.0, 72.0, 32.0], target: [31.0, 71.0, 33.0], up: [0, 1, 0], fov: 22 },
  // 7: GAP high telephoto
  { frame: 7, timeSec: 3.5, position: [80.0, 78.0, 22.0], target: [31.0, 71.5, 36.0], up: [0, 1, 0], fov: 18 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_telephoto_f0');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_telephoto_f0_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 telephoto candidate viewpoints from Grand Army Plaza with collision disabled...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Telephoto F0'
    },
    cameraPath: testPathFile,
    collision: {
      enabled: false
    },
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
      outputVideoPath: path.join(outputDir, 'test_telephoto.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering telephoto candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
