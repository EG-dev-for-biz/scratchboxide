const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Test 6 precise variations of Frame 0
const candidatePoses = [
  // Var 0: Baseline from plaza_hotel_camera_path.json
  { frame: 0, timeSec: 0.0, position: [54.0, 70.5, -1.0], target: [29.5, 69.5, 5.0], up: [0, 1, 0], fov: 40.0, desc: 'baseline' },

  // Var 1: Higher target (more level gaze, bringing turret dome up)
  { frame: 1, timeSec: 0.5, position: [54.0, 71.0, -1.0], target: [29.5, 72.5, 5.0], up: [0, 1, 0], fov: 38.0, desc: 'level_gaze_fov38' },

  // Var 2: Slightly closer in X (pos X=51.5), target Y=72.0, fov 36
  { frame: 2, timeSec: 1.0, position: [51.5, 71.5, -1.0], target: [29.0, 72.0, 5.0], up: [0, 1, 0], fov: 36.0, desc: 'closer_fov36' },

  // Var 3: Adjusted Z (Z=0.0 to bring turret slightly more left/centered), target Y=72.5, fov 37
  { frame: 3, timeSec: 1.5, position: [52.5, 71.0, 0.0], target: [29.0, 72.5, 5.5], up: [0, 1, 0], fov: 37.0, desc: 'z0_fov37' },

  // Var 4: Pos [53.0, 71.2, -0.5], Target [29.5, 73.0, 5.2], fov 37.5
  { frame: 4, timeSec: 2.0, position: [53.0, 71.2, -0.5], target: [29.5, 73.0, 5.2], up: [0, 1, 0], fov: 37.5, desc: 'tuned_target73' },

  // Var 5: Pos [52.0, 71.5, -0.5], Target [30.0, 73.5, 5.0], fov 35.0
  { frame: 5, timeSec: 2.5, position: [52.0, 71.5, -0.5], target: [30.0, 73.5, 5.0], up: [0, 1, 0], fov: 35.0, desc: 'tight_fov35' }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_micro');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_micro_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 micro-variations for Frame 0...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 0 Calibration'
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
      outputVideoPath: path.join(outputDir, 'test_f0_micro.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering Frame 0 micro-variations!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
