const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const GRID_ANGLE = -29.0 * (Math.PI / 180.0);
const FACADE_NORMAL = [-Math.cos(GRID_ANGLE), 0.0, Math.sin(GRID_ANGLE)];

function getUpVector(tiltFraction) {
  // tiltFraction: 0 = horizontal (up = [0,1,0]), 1 = nadir (up = FACADE_NORMAL)
  const angle = tiltFraction * (Math.PI / 2.0);
  const rawUp = [
    Math.sin(angle) * FACADE_NORMAL[0],
    Math.cos(angle) * 1.0,
    Math.sin(angle) * FACADE_NORMAL[2]
  ];
  const upLen = Math.hypot(rawUp[0], rawUp[1], rawUp[2]) || 1.0;
  return [rawUp[0] / upLen, rawUp[1] / upLen, rawUp[2] / upLen];
}

const testKeyframes = [
  {
    name: 'f01_t0.0',
    position: [54.5, 70.8, 4.8],
    target: [25.5, 71.2, 1.2],
    tiltFraction: 0.0,
    fov: 46.0
  },
  {
    name: 'f03_t2.0',
    position: [54.0, 58.0, 4.0],
    target: [26.0, 56.5, 1.2],
    tiltFraction: 0.02,
    fov: 47.0
  },
  {
    name: 'f04_t3.0',
    position: [51.0, 42.0, 13.0],
    target: [24.0, 39.0, 14.0],
    tiltFraction: 0.05,
    fov: 48.0
  },
  {
    name: 'f05_t4.0',
    position: [48.0, 26.0, 21.0],
    target: [22.0, 22.0, 21.5],
    tiltFraction: 0.10,
    fov: 49.0
  },
  {
    name: 'f06_t5.0',
    position: [46.0, 19.0, 22.0],
    target: [28.0, 10.0, 22.2],
    tiltFraction: 0.40,
    fov: 50.0
  },
  {
    name: 'f07_t6.0',
    position: [44.5, 14.5, 22.6],
    target: [36.0, 4.0, 22.8],
    tiltFraction: 0.70,
    fov: 51.0
  },
  {
    name: 'f09_t8.0',
    position: [43.5, 10.5, 23.0],
    target: [42.0, 2.0, 23.0],
    tiltFraction: 0.85,
    fov: 52.0
  },
  {
    name: 'f15_t15.0',
    position: [42.6, 4.5, 23.5],
    target: [42.6, 0.0, 23.5],
    tiltFraction: 1.0,
    fov: 52.0
  }
];

const testPathData = {
  totalFrames: testKeyframes.length,
  fps: 24,
  durationSec: testKeyframes.length * 0.5,
  frames: testKeyframes.map((k, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: k.position,
    target: k.target,
    up: getUpVector(k.tiltFraction),
    fov: k.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_intermediate_keyframes');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_intermediate_keyframes_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${testKeyframes.length} intermediate keyframe candidates...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Trajectory Test'
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
      outputVideoPath: path.join(outputDir, 'test_intermediate.mp4'),
      framesDir: outputDir
    }
  });

  console.log(`Render complete! Frames saved in ${outputDir}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
