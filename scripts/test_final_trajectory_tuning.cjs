const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const GRID_ANGLE = -29.0 * (Math.PI / 180.0);
const NADIR_UP = [-Math.cos(GRID_ANGLE), 0.0, Math.sin(GRID_ANGLE)];

const candidates = [
  // 0: Frame 0 (Confirmed match)
  {
    name: 'F0_proven_match',
    position: [54.5, 70.8, 4.8],
    target: [25.5, 71.2, 1.2],
    up: [0, 1, 0],
    fov: 46.0
  },
  // 1: Frame 72 candidate A: target Z=3.0 to keep turret on right
  {
    name: 'F72_candA_tgtZ3',
    position: [53.0, 52.0, 7.0],
    target: [26.0, 50.0, 3.0],
    up: [0, 1, 0],
    fov: 46.0
  },
  // 2: Frame 72 candidate B: target Z=2.0
  {
    name: 'F72_candB_tgtZ2',
    position: [52.0, 50.0, 8.0],
    target: [26.0, 48.0, 2.5],
    up: [0, 1, 0],
    fov: 47.0
  },
  // 3: Frame 168 (Canopy Marquee centered at t=7.0s)
  {
    name: 'F168_canopy_t7',
    position: [43.5, 18.0, 21.0],
    target: [37.0, 5.0, 21.0],
    up: [NADIR_UP[0] * 0.5, 0.866, NADIR_UP[2] * 0.5],
    fov: 52.0
  },
  // 4: Frame 240 (t=10.0s, canopy near top edge)
  {
    name: 'F240_canopy_top_t10',
    position: [43.0, 11.0, 22.5],
    target: [40.5, 2.0, 22.5],
    up: [NADIR_UP[0] * 0.8, 0.6, NADIR_UP[2] * 0.8],
    fov: 53.0
  },
  // 5: Frame 360 nadir candidate 1: X=43.0, Y=7.0, Z=23.8
  {
    name: 'F360_cand1_X43.0_Y7.0_Z23.8',
    position: [43.0, 7.0, 23.8],
    target: [43.0, 0.0, 23.8],
    up: NADIR_UP,
    fov: 52.0
  },
  // 6: Frame 360 nadir candidate 2: X=43.2, Y=6.5, Z=23.5
  {
    name: 'F360_cand2_X43.2_Y6.5_Z23.5',
    position: [43.2, 6.5, 23.5],
    target: [43.2, 0.0, 23.5],
    up: NADIR_UP,
    fov: 52.0
  }
];

const testPathData = {
  totalFrames: candidates.length,
  fps: 24,
  durationSec: candidates.length * 0.5,
  frames: candidates.map((v, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: v.position,
    target: v.target,
    up: v.up,
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_traj_tuning');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_traj_tuning_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${candidates.length} trajectory tuning frames...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Trajectory Tuning'
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
      outputVideoPath: path.join(outputDir, 'test_traj_tuning.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering trajectory tuning candidates!');
  candidates.forEach((p, idx) => {
    const frameNum = String(idx).padStart(4, '0');
    console.log(`Frame ${frameNum} -> ${p.name}`);
  });
}

main().catch(err => {
  console.error('Error running tuning test:', err);
  process.exit(1);
});
