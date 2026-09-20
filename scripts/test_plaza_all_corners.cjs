const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Testing multiple angles around both North and South wings of Plaza Hotel
const testFrames = [
  // 0: South Wing from East, looking West (camera at X=42, Z=38, looking at X=24, Z=36, Y=72)
  { frame: 0, timeSec: 0.0, position: [44.0, 72.0, 38.0], target: [24.0, 73.0, 35.0], up: [0, 1, 0], fov: 46 },
  // 1: South Wing from Southeast, looking Northwest (camera at X=45, Z=45, looking at X=26, Z=34, Y=72)
  { frame: 1, timeSec: 0.5, position: [45.0, 72.0, 45.0], target: [26.0, 73.0, 34.0], up: [0, 1, 0], fov: 46 },
  // 2: North Wing from East, looking West (camera at X=42, Z=8, looking at X=24, Z=9, Y=72)
  { frame: 2, timeSec: 1.0, position: [42.0, 72.0, 8.0], target: [24.0, 73.0, 9.0], up: [0, 1, 0], fov: 46 },
  // 3: North Wing from Northeast, looking Southwest (camera at X=42, Z=0, looking at X=24, Z=10, Y=72)
  { frame: 3, timeSec: 1.5, position: [42.0, 72.0, 0.0], target: [24.0, 73.0, 10.0], up: [0, 1, 0], fov: 46 },
  // 4: North Wing from North (Central Park South), looking South (camera at X=26, Z=-15, looking at X=26, Z=8, Y=72)
  { frame: 4, timeSec: 2.0, position: [26.0, 72.0, -15.0], target: [26.0, 73.0, 8.0], up: [0, 1, 0], fov: 46 },
  // 5: South Wing from South (58th St), looking North (camera at X=26, Z=55, looking at X=26, Z=35, Y=72)
  { frame: 5, timeSec: 2.5, position: [26.0, 72.0, 55.0], target: [26.0, 73.0, 35.0], up: [0, 1, 0], fov: 46 },
  // 6: South Wing close-up corner turret looking West-Northwest
  { frame: 6, timeSec: 3.0, position: [36.0, 70.0, 42.0], target: [24.0, 72.0, 36.0], up: [0, 1, 0], fov: 50 },
  // 7: North Wing close-up corner turret looking West-Southwest
  { frame: 7, timeSec: 3.5, position: [36.0, 70.0, 4.0], target: [24.0, 72.0, 10.0], up: [0, 1, 0], fov: 50 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 3.5,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_all_corners');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_all_corners_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 candidate corner viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC All Corners'
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
      outputVideoPath: path.join(outputDir, 'test_corners.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'test_corner_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8107
  });

  console.log('Done rendering corner candidate viewpoints:', result);
}

main().catch(err => {
  console.error('All corners test error:', err);
  process.exit(1);
});
