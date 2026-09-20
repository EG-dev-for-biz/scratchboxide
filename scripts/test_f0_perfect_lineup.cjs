const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Candidate viewpoints to capture dormer on left and SE corner turret on right
const candidatePoses = [
  // 0: pos [42.0, 71.0, 52.0], target [28.0, 72.0, 36.0], fov 44
  { frame: 0, timeSec: 0.0, position: [42.0, 71.0, 52.0], target: [28.0, 72.0, 36.0], up: [0, 1, 0], fov: 44 },
  // 1: pos [44.0, 71.5, 50.0], target: [29.0, 72.0, 36.0], fov 42
  { frame: 1, timeSec: 0.5, position: [44.0, 71.5, 50.0], target: [29.0, 72.0, 36.0], up: [0, 1, 0], fov: 42 },
  // 2: pos [46.0, 72.0, 48.0], target: [30.0, 72.0, 35.0], fov 42
  { frame: 2, timeSec: 1.0, position: [46.0, 72.0, 48.0], target: [30.0, 72.0, 35.0], up: [0, 1, 0], fov: 42 },
  // 3: pos [40.0, 71.0, 50.0], target: [26.0, 72.0, 36.0], fov 46
  { frame: 3, timeSec: 1.5, position: [40.0, 71.0, 50.0], target: [26.0, 72.0, 36.0], up: [0, 1, 0], fov: 46 },
  // 4: pos [38.0, 70.5, 48.0], target: [25.0, 71.5, 36.0], fov 46
  { frame: 4, timeSec: 2.0, position: [38.0, 70.5, 48.0], target: [25.0, 71.5, 36.0], up: [0, 1, 0], fov: 46 },
  // 5: pos [44.0, 70.5, 54.0], target: [28.0, 72.0, 37.0], fov 40
  { frame: 5, timeSec: 2.5, position: [44.0, 70.5, 54.0], target: [28.0, 72.0, 37.0], up: [0, 1, 0], fov: 40 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_perfect_lineup');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_perfect_lineup_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 candidate viewpoints for F0 lineup...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC F0 Lineup'
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
      outputVideoPath: path.join(outputDir, 'test_f0_lineup.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering candidate viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
