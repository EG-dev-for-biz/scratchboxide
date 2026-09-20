const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's test rotating up vector by +/- 29 degrees
const ang1 = 29 * Math.PI / 180;
const ang2 = -29 * Math.PI / 180;

const testPoses = [
  // 0: rotate +29 deg
  {
    frame: 0,
    timeSec: 0.0,
    position: [40.3, 11.0, 22.3],
    target: [40.3, 0.0, 22.3],
    up: [-Math.cos(ang1), 0.0, Math.sin(ang1)],
    fov: 55.0
  },
  // 1: rotate -29 deg
  {
    frame: 1,
    timeSec: 0.5,
    position: [40.3, 11.0, 22.3],
    target: [40.3, 0.0, 22.3],
    up: [-Math.cos(ang2), 0.0, Math.sin(ang2)],
    fov: 55.0
  }
];

const testPathData = {
  fps: 24,
  totalFrames: testPoses.length,
  durationSec: 1.0,
  frames: testPoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_nadir_angle');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testFile = path.join(process.cwd(), 'public/models/test_nadir_angle_path.json');
  fs.writeFileSync(testFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 2 angle tests for horizontal line alignment...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Nadir Angle Test'
    },
    cameraPath: testFile,
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
      outputVideoPath: path.join(outputDir, 'angle.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering angle test!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
