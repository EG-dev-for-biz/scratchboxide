const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  { frame: 0, timeSec: 0.0, position: [56.0, 72.0, 5.0], target: [22.0, 71.0, 13.0], up: [0, 1, 0], fov: 42 },
  { frame: 1, timeSec: 0.5, position: [58.0, 72.0, 6.0], target: [22.0, 71.0, 13.0], up: [0, 1, 0], fov: 40 },
  { frame: 2, timeSec: 1.0, position: [60.0, 72.0, 7.0], target: [22.0, 71.0, 13.0], up: [0, 1, 0], fov: 38 },
  { frame: 3, timeSec: 1.5, position: [58.0, 73.5, 4.0], target: [22.0, 71.5, 12.0], up: [0, 1, 0], fov: 40 },
  { frame: 4, timeSec: 2.0, position: [56.0, 71.0, 7.0], target: [22.0, 70.5, 14.0], up: [0, 1, 0], fov: 42 },
  { frame: 5, timeSec: 2.5, position: [62.0, 73.0, 8.0], target: [20.0, 71.0, 14.0], up: [0, 1, 0], fov: 36 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_f0_perfect');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_f0_perfect_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 f0 perfect sweep candidates...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC F0 Sweep'
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
      outputVideoPath: path.join(outputDir, 'test_f0_perfect.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'perf_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8118
  });

  console.log('Done rendering f0 sweep:', result);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
