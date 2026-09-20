const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Manhattan grid angle is ~29 deg.
// Test 4 up-vectors around 29 deg:
// angle in radians:
const angles = [20, 26, 29, 34];
const candidateNadirPoses = angles.map((deg, idx) => {
  const rad = (deg * Math.PI) / 180;
  // Up vector in X-Z plane: [-sin(rad), 0, -cos(rad)]
  const upX = -Math.sin(rad);
  const upZ = -Math.cos(rad);
  return {
    frame: idx,
    timeSec: idx * 0.5,
    position: [38.5, 12.0, 10.5],
    target: [38.5, 0.0, 10.5],
    up: [upX, 0, upZ],
    fov: 46.0
  };
});

const testPathData = {
  totalFrames: candidateNadirPoses.length,
  fps: 24,
  durationSec: candidateNadirPoses.length * 0.5,
  frames: candidateNadirPoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_nadir_align');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_nadir_align_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 Nadir Alignment Candidates...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Nadir Alignment'
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
      outputVideoPath: path.join(outputDir, 'test_nadir_align.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering Nadir Alignment candidates!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
