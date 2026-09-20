const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // A: Looking at North Wing from Grand Army Plaza (cam at Z=6, target at Z=6)
  { frame: 0, timeSec: 0.0, position: [50.0, 72.0, 6.0], target: [24.0, 72.0, 6.0], up: [0, 1, 0], fov: 44 },
  // B: Looking at South Wing from Grand Army Plaza (cam at Z=34, target at Z=34)
  { frame: 1, timeSec: 0.5, position: [50.0, 72.0, 34.0], target: [24.0, 72.0, 34.0], up: [0, 1, 0], fov: 44 },
  // C: Looking at North Wing from Z=0 (Central Park South corner looking South-West)
  { frame: 2, timeSec: 1.0, position: [48.0, 72.0, 0.0], target: [24.0, 72.0, 10.0], up: [0, 1, 0], fov: 44 },
  // D: Looking at North Wing from Z=14 looking West-Northwest (target at Z=6)
  { frame: 3, timeSec: 1.5, position: [52.0, 72.0, 14.0], target: [24.0, 72.0, 6.0], up: [0, 1, 0], fov: 44 },
  // E: Looking at South Wing from Z=40 looking West-Northwest (target at Z=32)
  { frame: 4, timeSec: 2.0, position: [52.0, 72.0, 42.0], target: [24.0, 72.0, 32.0], up: [0, 1, 0], fov: 44 },
  // F: Looking at South Wing from Z=28 looking West-Southwest (target at Z=36)
  { frame: 5, timeSec: 2.5, position: [52.0, 72.0, 26.0], target: [24.0, 72.0, 36.0], up: [0, 1, 0], fov: 44 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_views_6');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_views_6_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 candidate viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC 6 Views'
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
    collision: {
      enabled: false,
      minClearanceMeters: 5.0,
      autoAdjustAltitude: false
    },
    output: {
      outputVideoPath: path.join(outputDir, 'test_views_6.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'v_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8113
  });

  console.log('Done rendering 6 views:', result);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
