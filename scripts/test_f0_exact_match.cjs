const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's test 6 refined camera poses for Frame 0:
// We want:
// - Gable centered around X ~ 28-32% of frame
// - Turret centered around X ~ 70-75% of frame
// - Solow building visible behind gable on left
// - Finial and roofline framed accurately
const f0Variations = [
  {
    name: 'var1_Z_neg6_Y70',
    position: [64.0, 70.0, -6.0],
    target: [25.0, 70.0, 4.0],
    fov: 38.0
  },
  {
    name: 'var2_Z_neg4_Y69',
    position: [65.0, 69.0, -4.0],
    target: [25.5, 69.5, 4.5],
    fov: 37.0
  },
  {
    name: 'var3_Z_neg2_Y69',
    position: [66.0, 69.5, -2.0],
    target: [26.0, 70.0, 4.0],
    fov: 36.0
  },
  {
    name: 'var4_Z_neg4_Y71',
    position: [63.0, 71.0, -4.0],
    target: [25.0, 70.5, 4.5],
    fov: 38.0
  },
  {
    name: 'var5_Z_neg8_Y70',
    position: [63.0, 70.5, -8.0],
    target: [24.5, 70.5, 3.5],
    fov: 39.0
  },
  {
    name: 'var6_Z_neg5_Y68',
    position: [67.0, 68.5, -5.0],
    target: [26.0, 69.5, 4.0],
    fov: 36.5
  }
];

const testPathData = {
  totalFrames: f0Variations.length,
  fps: 24,
  durationSec: f0Variations.length * 0.5,
  frames: f0Variations.map((v, i) => ({
    frame: i,
    timeSec: i * 0.5,
    position: v.position,
    target: v.target,
    up: [0, 1, 0],
    fov: v.fov
  }))
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_match');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_match_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log(`Rendering ${f0Variations.length} test variations for Frame 0...`);
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 0 Match'
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
      outputVideoPath: path.join(outputDir, 'test_f0_match.mp4'),
      framesDir: outputDir
    }
  });

  // Save manifest of the variations for inspection
  fs.writeFileSync(path.join(outputDir, 'variations.json'), JSON.stringify(f0Variations, null, 2));
  console.log('Done rendering test variations!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
