const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Exact candidate poses testing standoff, target azimuth, and FOV
const candidatePoses = [
  // A: Standoff ~22m, looking at midpoint between turret (Z~4) and gable (Z~12)
  { frame: 0, timeSec: 0.0, position: [46.0, 72.2, 0.0], target: [26.5, 72.2, 7.5], up: [0, 1, 0], fov: 44.0 },
  // B: Slightly closer (~20m), slightly higher target Z
  { frame: 1, timeSec: 0.5, position: [45.0, 72.2, -0.5], target: [26.0, 72.2, 7.0], up: [0, 1, 0], fov: 45.0 },
  // C: Standoff ~24m, FOV 42
  { frame: 2, timeSec: 1.0, position: [48.0, 72.2, 0.5], target: [27.5, 72.2, 7.5], up: [0, 1, 0], fov: 42.0 },
  // D: Slightly shifted X/Z
  { frame: 3, timeSec: 1.5, position: [47.0, 72.0, -1.0], target: [27.0, 72.0, 6.5], up: [0, 1, 0], fov: 43.0 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_frame1_exact');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_frame1_exact_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 candidate viewpoints for Frame 1 exact resection...');
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
      outputVideoPath: path.join(outputDir, 'test_frame1_exact.mp4'),
      framesDir: outputDir
    },
    port: 8109
  });
  console.log('Done rendering Frame 1 candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
