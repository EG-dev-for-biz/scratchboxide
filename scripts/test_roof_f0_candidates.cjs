const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's test 10 viewpoints around the roof to get the exact Gable-on-Left, Turret-on-Right alignment
const candidatePoses = [
  // 0: East of NE corner looking West-NW
  { frame: 0, timeSec: 0.0, position: [56.0, 72.0, 5.0], target: [30.0, 71.0, 0.0], up: [0, 1, 0], fov: 38 },
  // 1: East of NE corner looking West
  { frame: 1, timeSec: 0.5, position: [56.0, 72.0, 2.0], target: [30.0, 71.0, 2.0], up: [0, 1, 0], fov: 38 },
  // 2: East of NE corner looking West-SW
  { frame: 2, timeSec: 1.0, position: [56.0, 72.0, -2.0], target: [30.0, 71.0, 5.0], up: [0, 1, 0], fov: 38 },
  // 3: Central Park South side looking South-East
  { frame: 3, timeSec: 1.5, position: [25.0, 72.0, -16.0], target: [32.0, 71.0, 2.0], up: [0, 1, 0], fov: 38 },
  // 4: Central Park South side looking South
  { frame: 4, timeSec: 2.0, position: [30.0, 72.0, -16.0], target: [32.0, 71.0, 0.0], up: [0, 1, 0], fov: 38 },
  // 5: 58th St side looking North-East
  { frame: 5, timeSec: 2.5, position: [25.0, 72.0, 55.0], target: [32.0, 71.0, 38.0], up: [0, 1, 0], fov: 38 },
  // 6: 58th St side looking North-West (at SW corner)
  { frame: 6, timeSec: 3.0, position: [15.0, 72.0, 55.0], target: [2.0, 71.0, 38.0], up: [0, 1, 0], fov: 38 },
  // 7: West courtyard looking North-East
  { frame: 7, timeSec: 3.5, position: [8.0, 72.0, 20.0], target: [30.0, 71.0, 5.0], up: [0, 1, 0], fov: 42 },
  // 8: West courtyard looking South-East
  { frame: 8, timeSec: 4.0, position: [8.0, 72.0, 20.0], target: [30.0, 71.0, 35.0], up: [0, 1, 0], fov: 42 },
  // 9: East side, closer, slightly lower looking NW at NE corner
  { frame: 9, timeSec: 4.5, position: [48.0, 69.0, 8.0], target: [32.0, 71.0, 0.0], up: [0, 1, 0], fov: 40 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_roof_f0_candidates');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_roof_f0_candidates_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 10 roof candidate viewpoints...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Roof Candidates'
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
      outputVideoPath: path.join(outputDir, 'candidates.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering roof candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
