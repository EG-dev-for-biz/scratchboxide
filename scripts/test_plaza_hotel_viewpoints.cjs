const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const testFrames = [
  // Frame 0: Roofline vista facing corner turret & dormer
  { frame: 0, timeSec: 0.0, position: [45.0, 90.0, 32.0], target: [12.0, 78.0, 15.0], up: [0, 1, 0], fov: 62 },
  // Frame 1: Upper facade descent
  { frame: 1, timeSec: 0.75, position: [44.0, 68.0, 28.0], target: [18.0, 52.0, 18.0], up: [0, 1, 0], fov: 63 },
  // Frame 2: Mid facade descent revealing canopy
  { frame: 2, timeSec: 1.5, position: [43.0, 46.0, 25.0], target: [25.0, 24.0, 22.0], up: [-0.3, 0.95, -0.2], fov: 64 },
  // Frame 3: Lower facade & steep tilt over canopy
  { frame: 3, timeSec: 2.25, position: [41.0, 26.0, 21.0], target: [38.0, 8.0, 19.0], up: [-0.7, 0.4, -0.58], fov: 65 },
  // Frame 4: Bird's eye street view directly over entrance street with marquee at top
  { frame: 4, timeSec: 3.0, position: [39.0, 16.0, 18.0], target: [39.0, 0.0, 18.0], up: [-0.85, 0.05, -0.52], fov: 65 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 3.0,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_plaza_viewpoints');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_plaza_camera_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 5 test viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Test'
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
      outputVideoPath: path.join(outputDir, 'test_viewpoints.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'test_first_frame.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8104
  });

  console.log('Done rendering test viewpoints:', result);
}

main().catch(err => {
  console.error('Test viewpoints error:', err);
  process.exit(1);
});
