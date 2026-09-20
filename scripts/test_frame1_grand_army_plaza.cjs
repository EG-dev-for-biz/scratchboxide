const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's test standoff distances further back (X=55 to 65m) and slightly higher/lower Y,
// aiming at the turret (X~35, Y~78, Z~0) and gable (X~34, Y~74, Z~12).
// In omni_sample_01.jpg:
// Gable apex is around X: 25-30% of screen, Y: 10-15% of screen
// Balcony bowl is around X: 25-30%, Y: 50%
// Turret apex is around X: 65-70%, Y: 8-10%
// Turret fills right half from X: 45% to 95%
// Background Solow building on left
const candidatePoses = [
  // 0: X=58, Y=76, Z=5, looking at [30, 75, 6], FOV 42
  { frame: 0, timeSec: 0.0, position: [58.0, 76.0, 5.0], target: [30.0, 75.0, 6.0], up: [0, 1, 0], fov: 42.0 },
  // 1: X=62, Y=77, Z=6, looking at [31, 76, 5], FOV 39
  { frame: 1, timeSec: 0.5, position: [62.0, 77.0, 6.0], target: [31.0, 76.0, 5.0], up: [0, 1, 0], fov: 39.0 },
  // 2: X=55, Y=75, Z=3, looking at [29, 74, 5], FOV 45
  { frame: 2, timeSec: 1.0, position: [55.0, 75.0, 3.0], target: [29.0, 74.0, 5.0], up: [0, 1, 0], fov: 45.0 },
  // 3: X=65, Y=78, Z=8, looking at [32, 76, 6], FOV 36
  { frame: 3, timeSec: 1.5, position: [65.0, 78.0, 8.0], target: [32.0, 76.0, 6.0], up: [0, 1, 0], fov: 36.0 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_frame1_gap');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_frame1_gap_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 Grand Army Plaza candidate viewpoints for Frame 1...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Frame 1 Exact Match'
    },
    cameraPath: testPathFile,
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
      outputVideoPath: path.join(outputDir, 'test_frame1_gap.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering Grand Army Plaza candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
