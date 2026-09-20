const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // Pose 0: Pitch ~+4°, Y=69.0 -> target Y=71.2
  {
    name: 'pose0_Y69_pitch4_fov45',
    position: [54.5, 69.0, 4.8],
    target: [25.5, 71.2, 1.2],
    fov: 45.0
  },
  // Pose 1: Pitch ~+6°, Y=68.0 -> target Y=71.2
  {
    name: 'pose1_Y68_pitch6_fov46',
    position: [54.5, 68.0, 4.8],
    target: [25.5, 71.2, 1.2],
    fov: 46.0
  },
  // Pose 2: Proven match baseline Y=70.8 -> target Y=71.2, fov 46
  {
    name: 'pose2_Y70.8_pitch1_fov46',
    position: [54.5, 70.8, 4.8],
    target: [25.5, 71.2, 1.2],
    fov: 46.0
  },
  // Pose 3: Slightly pulled back X=56.0, Y=69.5 -> target Y=71.2, fov 44
  {
    name: 'pose3_X56_Y69.5_fov44',
    position: [56.0, 69.5, 4.5],
    target: [25.5, 71.2, 1.2],
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
    up: [0, 1, 0],
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_candidates_check');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_candidates_check_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${candidatePoses.length} candidate poses for Frame 0...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 0 Candidates'
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
      outputVideoPath: path.join(outputDir, 'test_candidates.mp4'),
      framesDir: outputDir
    }
  });

  fs.writeFileSync(path.join(outputDir, 'poses.json'), JSON.stringify(candidatePoses, null, 2));
  console.log('Done rendering candidate poses!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
