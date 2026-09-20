const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Grid angle for Plaza Hotel facade facing Grand Army Plaza
const GRID_ANGLE = -29.0 * (Math.PI / 180.0);
const NADIR_UP = [-Math.cos(GRID_ANGLE), 0.0, Math.sin(GRID_ANGLE)];

const testPoses = [
  // 0: Frame 0 Candidate (P4 fine tuned with slightly higher target Y)
  {
    name: 'F0_fine_tuned',
    position: [54.5, 70.8, 4.8],
    target: [25.5, 71.2, 1.2],
    up: [0, 1, 0],
    fov: 46.0
  },
  // 1: Frame 72 (Descent along East Facade)
  {
    name: 'F72_facade_descent',
    position: [52.0, 48.0, 9.0],
    target: [25.0, 46.0, 6.0],
    up: [0, 1, 0],
    fov: 48.0
  },
  // 2: Frame 168 (Canopy Marquee "THE PLAZA NEW YORK")
  {
    name: 'F168_canopy_marquee',
    position: [44.5, 14.0, 22.5],
    target: [38.0, 4.0, 22.5],
    up: [NADIR_UP[0] * 0.45, 0.893, NADIR_UP[2] * 0.45],
    fov: 52.0
  },
  // 3: Frame 360 Candidate A: X=43.5, Y=7.5, Z=23.5
  {
    name: 'F360_candA_X43.5_Y7.5_Z23.5',
    position: [43.5, 7.5, 23.5],
    target: [43.5, 0.0, 23.5],
    up: NADIR_UP,
    fov: 52.0
  },
  // 4: Frame 360 Candidate B: X=45.0, Y=7.0, Z=24.0
  {
    name: 'F360_candB_X45.0_Y7.0_Z24.0',
    position: [45.0, 7.0, 24.0],
    target: [45.0, 0.0, 24.0],
    up: NADIR_UP,
    fov: 52.0
  },
  // 5: Frame 360 Candidate C: X=46.0, Y=6.5, Z=24.5
  {
    name: 'F360_candC_X46.0_Y6.5_Z24.5',
    position: [46.0, 6.5, 24.5],
    target: [46.0, 0.0, 24.5],
    up: NADIR_UP,
    fov: 52.0
  },
  // 6: Frame 360 Candidate D: X=45.0, Y=8.5, Z=24.0
  {
    name: 'F360_candD_X45.0_Y8.5_Z24.0',
    position: [45.0, 8.5, 24.0],
    target: [45.0, 0.0, 24.0],
    up: NADIR_UP,
    fov: 54.0
  }
];

const testPathData = {
  totalFrames: testPoses.length,
  fps: 24,
  durationSec: testPoses.length * 0.5,
  frames: testPoses.map((v, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: v.position,
    target: v.target,
    up: v.up,
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_keyframes_pinpoint');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_keyframes_pinpoint_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${testPoses.length} pinpoint keyframe candidates...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Keyframe Pinpoint'
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
      outputVideoPath: path.join(outputDir, 'test_keyframes_pinpoint.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering keyframe pinpoint candidates!');
  testPoses.forEach((p, idx) => {
    const frameNum = String(idx).padStart(4, '0');
    console.log(`Frame ${frameNum} -> ${p.name}`);
  });
}

main().catch(err => {
  console.error('Error running keyframe pinpoint:', err);
  process.exit(1);
});
