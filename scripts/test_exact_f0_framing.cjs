const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // Pose 0: Camera at Y=58, Target at Y=62 (slight upward pitch +8°)
  {
    name: 'pose0_Y58_tgtY62',
    position: [54.0, 58.0, 0.5],
    target: [27.5, 62.0, 1.5],
    up: [0, 1, 0],
    fov: 44.0
  },
  // Pose 1: Camera at Y=60, Target at Y=63 (slight upward pitch +6°)
  {
    name: 'pose1_Y60_tgtY63',
    position: [54.0, 60.0, 0.5],
    target: [27.5, 63.0, 1.5],
    up: [0, 1, 0],
    fov: 44.0
  },
  // Pose 2: Camera at Y=62, Target at Y=64 (pitch +4°)
  {
    name: 'pose2_Y62_tgtY64',
    position: [54.0, 62.0, 0.5],
    target: [27.5, 64.0, 1.5],
    up: [0, 1, 0],
    fov: 44.0
  },
  // Pose 3: Camera at Y=64, Target at Y=66 (pitch +4°)
  {
    name: 'pose3_Y64_tgtY66',
    position: [53.5, 64.0, 0.5],
    target: [27.5, 66.0, 1.5],
    up: [0, 1, 0],
    fov: 44.0
  },
  // Pose 4: Camera at Y=56, Target at Y=61 (pitch +10°)
  {
    name: 'pose4_Y56_tgtY61',
    position: [54.0, 56.0, 0.5],
    target: [27.5, 61.0, 1.5],
    up: [0, 1, 0],
    fov: 44.0
  }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses.map((v, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: v.position,
    target: v.target,
    up: v.up,
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_exact_f0_framing');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_exact_f0_framing_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${candidatePoses.length} exact framing poses for Frame 0...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Exact Frame 0 Framing'
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
      outputVideoPath: path.join(outputDir, 'test_framing.mp4'),
      framesDir: outputDir
    }
  });

  fs.writeFileSync(path.join(outputDir, 'poses.json'), JSON.stringify(candidatePoses, null, 2));
  console.log('Done rendering exact framing poses!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
