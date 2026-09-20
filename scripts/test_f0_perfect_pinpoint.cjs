const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// We know:
// Camera looking towards West (-X)
// Target Z smaller shifts scene to the LEFT (moving gable from 47% to 30%)
// Closer X (56-60) makes gable + turret fill frame
// Height Y ~ 71-72 frames the pediment and dome perfectly
const pinpointPoses = [
  {
    name: 'P1_X58_Y71_Z4_tgtZ0_fov42',
    position: [58.0, 71.0, 4.0],
    target: [26.0, 70.0, 0.0],
    fov: 42.0
  },
  {
    name: 'P2_X56_Y71.5_Z4.5_tgtZ0.5_fov44',
    position: [56.0, 71.5, 4.5],
    target: [26.0, 70.5, 0.5],
    fov: 44.0
  },
  {
    name: 'P3_X58_Y71.5_Z3.5_tgtZneg0.5_fov42',
    position: [58.0, 71.5, 3.5],
    target: [26.0, 70.5, -0.5],
    fov: 42.0
  },
  {
    name: 'P4_X54_Y71.0_Z5.0_tgtZ1.0_fov46',
    position: [54.0, 71.0, 5.0],
    target: [25.5, 70.0, 1.0],
    fov: 46.0
  },
  {
    name: 'P5_X60_Y72.0_Z3.0_tgtZneg1.0_fov40',
    position: [60.0, 72.0, 3.0],
    target: [26.5, 71.0, -1.0],
    fov: 40.0
  },
  {
    name: 'P6_X57_Y70.5_Z4.0_tgtZ0.0_fov43',
    position: [57.0, 70.5, 4.0],
    target: [26.0, 69.5, 0.0],
    fov: 43.0
  }
];

const testPathData = {
  totalFrames: pinpointPoses.length,
  fps: 24,
  durationSec: pinpointPoses.length * 0.5,
  frames: pinpointPoses.map((v, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: v.position,
    target: v.target,
    up: [0, 1, 0],
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_pinpoint');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_pinpoint_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${pinpointPoses.length} pinpoint variations for Frame 0...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 0 Pinpoint'
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
      outputVideoPath: path.join(outputDir, 'test_f0_pinpoint.mp4'),
      framesDir: outputDir
    }
  });

  fs.writeFileSync(path.join(outputDir, 'poses.json'), JSON.stringify(pinpointPoses, null, 2));
  console.log('Done rendering pinpoint variations!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
