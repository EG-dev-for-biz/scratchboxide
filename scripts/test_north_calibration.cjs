const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// We want to test North Wing camera poses for Frame 0 (t=0)
// To match ref_f0.jpg:
// - Triangular dormer on LEFT
// - Round copper turret on RIGHT
// - Solow skyscraper visible behind the dormer (left background)
// - Mansard roof visible behind turret (right background)

const candidatePoses = [
  // 0: Camera at X=44, Y=73.5, Z=14; target at X=24, Y=73.0, Z=7.5, fov=44
  { frame: 0, timeSec: 0.0, position: [44.0, 73.5, 14.0], target: [24.0, 73.0, 7.5], up: [0, 1, 0], fov: 44 },
  // 1: Camera slightly closer X=41, Y=73.0, Z=13; target at X=24, Y=73.0, Z=7.5, fov=46
  { frame: 1, timeSec: 0.5, position: [41.0, 73.0, 13.0], target: [24.0, 73.0, 7.5], up: [0, 1, 0], fov: 46 },
  // 2: Camera at X=42, Y=74.0, Z=15; target at X=24, Y=73.5, Z=8.5, fov=42
  { frame: 2, timeSec: 1.0, position: [42.0, 74.0, 15.0], target: [24.0, 73.5, 8.5], up: [0, 1, 0], fov: 42 },
  // 3: Camera at X=40, Y=73.5, Z=14; target at X=23.5, Y=73.0, Z=8.0, fov=44
  { frame: 3, timeSec: 1.5, position: [40.0, 73.5, 14.0], target: [23.5, 73.0, 8.0], up: [0, 1, 0], fov: 44 },
  // 4: Camera at X=43, Y=72.5, Z=12; target at X=24.5, Y=72.5, Z=6.5, fov=44
  { frame: 4, timeSec: 2.0, position: [43.0, 72.5, 12.0], target: [24.5, 72.5, 6.5], up: [0, 1, 0], fov: 44 },
  // 5: Frame 72 candidate: Booming down facade along North Wing towards court
  { frame: 5, timeSec: 2.5, position: [42.0, 52.0, 14.0], target: [24.0, 48.0, 12.0], up: [0, 1, 0], fov: 44 },
  // 6: Frame 168 candidate: Steep downward tilt over entrance canopy
  { frame: 6, timeSec: 3.0, position: [40.5, 25.0, 17.0], target: [34.0, 6.0, 17.5], up: [0, 1, 0], fov: 50 },
  // 7: Frame 360 candidate: Nadir overhead looking straight down at street & lane line
  { frame: 7, timeSec: 3.5, position: [39.0, 11.0, 18.0], target: [39.0, 0.0, 18.0], up: [-0.875, 0.0, -0.485], fov: 50 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_north_calib');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_north_calib_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 calibration viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC North Calib'
    },
    cameraPath: testPathFile,
    lodQuality: {
      errorTarget: 0.5,
      resolutionWidth: 1920,
      resolutionHeight: 1080,
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
    collision: {
      enabled: false,
      minClearanceMeters: 5.0,
      autoAdjustAltitude: false
    },
    output: {
      outputVideoPath: path.join(outputDir, 'test_north_calib.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'calib_f0.jpg'),
      fps: 24,
      bitrate: '8M'
    },
    port: 8111
  });

  console.log('Done rendering calibration viewpoints:', result);
}

main().catch(err => {
  console.error('Calibration test error:', err);
  process.exit(1);
});
