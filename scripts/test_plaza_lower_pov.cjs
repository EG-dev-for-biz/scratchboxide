const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Testing lower POV and looking up viewpoints around North Wing (Z ~ 4.0)
const testFrames = [
  // 0: Reference baseline from dense blockout (too elevated, looking down)
  { frame: 0, timeSec: 0.0, position: [57.0, 82.0, 4.0], target: [35.0, 70.0, 4.0], up: [0, 1, 0], fov: 46 },
  // 1: Y=74 looking at Y=75 (slight upward tilt)
  { frame: 1, timeSec: 0.5, position: [56.0, 74.0, 4.0], target: [35.0, 75.0, 4.0], up: [0, 1, 0], fov: 46 },
  // 2: Y=71 looking at Y=74 (moderate upward tilt)
  { frame: 2, timeSec: 1.0, position: [55.0, 71.0, 4.0], target: [34.0, 74.5, 4.0], up: [0, 1, 0], fov: 46 },
  // 3: Y=68 looking at Y=74 (distinct upward tilt)
  { frame: 3, timeSec: 1.5, position: [54.0, 68.0, 4.0], target: [33.0, 74.0, 4.0], up: [0, 1, 0], fov: 46 },
  // 4: Y=66 looking at Y=73 (lower POV, upward tilt)
  { frame: 4, timeSec: 2.0, position: [53.0, 66.0, 4.0], target: [32.0, 73.0, 4.0], up: [0, 1, 0], fov: 46 },
  // 5: Y=68 looking at Y=74, slightly shifted Z=4.5 (framing turret better)
  { frame: 5, timeSec: 2.5, position: [54.0, 68.0, 4.8], target: [33.0, 73.5, 4.2], up: [0, 1, 0], fov: 45 },
  // 6: Y=66 looking at Y=73, slightly shifted Z=5.2 (framing gable & turret)
  { frame: 6, timeSec: 3.0, position: [52.0, 66.0, 5.2], target: [32.0, 73.0, 4.5], up: [0, 1, 0], fov: 44 },
  // 7: Y=64 looking at Y=72 (lowest POV, pronounced upward pitch)
  { frame: 7, timeSec: 3.5, position: [50.0, 64.0, 4.5], target: [30.0, 72.0, 4.0], up: [0, 1, 0], fov: 44 }
];

const testPathData = {
  totalFrames: testFrames.length,
  fps: 24,
  durationSec: 3.5,
  frames: testFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_lower_pov');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_lower_pov_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 candidate lower-POV viewpoints...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Lower POV'
    },
    cameraPath: testPathFile,
    lodQuality: {
      errorTarget: 0.5,
      resolutionWidth: 1920,
      resolutionHeight: 1080,
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
      outputVideoPath: path.join(outputDir, 'test_lower_pov.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'test_lower_pov_f0.jpg'),
      fps: 24,
      bitrate: '8M'
    },
    port: 8109
  });

  console.log('Done rendering lower POV viewpoints:', result);
}

main().catch(err => {
  console.error('Lower POV test error:', err);
  process.exit(1);
});
