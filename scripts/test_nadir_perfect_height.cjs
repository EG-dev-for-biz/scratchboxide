const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const GRID_ANGLE = -29.0 * (Math.PI / 180.0);
const NADIR_UP = [-Math.cos(GRID_ANGLE), 0.0, Math.sin(GRID_ANGLE)];

const nadirPoses = [
  {
    name: 'N1_X42.8_Y4.2_Z23.5_fov50',
    position: [42.8, 4.2, 23.5],
    target: [42.8, 0.0, 23.5],
    up: NADIR_UP,
    fov: 50.0
  },
  {
    name: 'N2_X43.0_Y4.5_Z23.5_fov52',
    position: [43.0, 4.5, 23.5],
    target: [43.0, 0.0, 23.5],
    up: NADIR_UP,
    fov: 52.0
  },
  {
    name: 'N3_X43.2_Y4.8_Z23.5_fov52',
    position: [43.2, 4.8, 23.5],
    target: [43.2, 0.0, 23.5],
    up: NADIR_UP,
    fov: 52.0
  },
  {
    name: 'N4_X42.6_Y4.5_Z23.5_fov52',
    position: [42.6, 4.5, 23.5],
    target: [42.6, 0.0, 23.5],
    up: NADIR_UP,
    fov: 52.0
  },
  {
    name: 'N5_X43.0_Y5.2_Z23.5_fov52',
    position: [43.0, 5.2, 23.5],
    target: [43.0, 0.0, 23.5],
    up: NADIR_UP,
    fov: 52.0
  }
];

const testPathData = {
  totalFrames: nadirPoses.length,
  fps: 24,
  durationSec: nadirPoses.length * 0.5,
  frames: nadirPoses.map((v, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: v.position,
    target: v.target,
    up: v.up,
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_nadir_height');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_nadir_height_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${nadirPoses.length} nadir height candidates...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Nadir Pinpoint'
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
      outputVideoPath: path.join(outputDir, 'test_nadir_height.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering nadir candidates!');
  nadirPoses.forEach((p, idx) => {
    const frameNum = String(idx).padStart(4, '0');
    console.log(`Frame ${frameNum} -> ${p.name}`);
  });
}

main().catch(err => {
  console.error('Error running nadir test:', err);
  process.exit(1);
});
