const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Testing North Wing roofline corner turret and triangular dormer
// Camera is East of the North wing, looking slightly West/Southwest or West/Northwest
const testFrames = [
  // Option 0: Looking at North wing corner at eye level Y=72
  { frame: 0, timeSec: 0.0, position: [36.0, 71.0, 18.0], target: [24.0, 72.0, 12.0], up: [0, 1, 0], fov: 45 },
  // Option 1: Slightly lower Y=68 looking slightly up (+3 deg pitch)
  { frame: 1, timeSec: 0.5, position: [38.0, 68.0, 19.0], target: [24.0, 71.0, 12.0], up: [0, 1, 0], fov: 48 },
  // Option 2: Closer and slightly further north
  { frame: 2, timeSec: 1.0, position: [34.0, 69.0, 15.0], target: [22.0, 71.0, 10.0], up: [0, 1, 0], fov: 44 },
  // Option 3: Lower looking more upward
  { frame: 3, timeSec: 1.5, position: [36.0, 66.0, 18.0], target: [22.0, 72.0, 12.0], up: [0, 1, 0], fov: 50 },
  // Option 4: Slightly further back X=42, Y=70
  { frame: 4, timeSec: 2.0, position: [42.0, 70.0, 20.0], target: [24.0, 72.0, 11.0], up: [0, 1, 0], fov: 42 },
  // Option 5: Higher and looking at the copper dome peak
  { frame: 5, timeSec: 2.5, position: [36.0, 74.0, 18.0], target: [24.0, 74.0, 12.0], up: [0, 1, 0], fov: 46 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 2.5,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_roof_viewpoints');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_roof_camera_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 6 North wing roof candidate viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Roof Test 2'
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
      outputVideoPath: path.join(outputDir, 'test_roof.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'test_roof_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8106
  });

  console.log('Done rendering roof candidate viewpoints:', result);
}

main().catch(err => {
  console.error('Roof test error:', err);
  process.exit(1);
});
