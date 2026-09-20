const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // --- NORTH-EAST CORNER (59th St & Grand Army Plaza) ---
  // Looking at East facade of NE corner: gable on left, turret on right
  // Turret is at corner (X ~ 34, Z ~ 0). Gable is at X ~ 32, Z ~ 8.
  // To have gable on LEFT and turret on RIGHT:
  // Camera needs to be East of the building (X ~ 45..50), looking West/Northwest towards Z ~ 4
  { frame: 0, timeSec: 0.0, position: [48.0, 64.0, 10.0], target: [32.0, 69.0, 3.0], up: [0, 1, 0], fov: 38 },
  { frame: 1, timeSec: 0.5, position: [46.0, 65.0, 8.0], target: [30.0, 70.0, 2.0], up: [0, 1, 0], fov: 42 },
  { frame: 2, timeSec: 1.0, position: [44.0, 66.0, 6.0], target: [28.0, 70.5, 1.0], up: [0, 1, 0], fov: 45 },
  { frame: 3, timeSec: 1.5, position: [50.0, 63.0, 12.0], target: [32.0, 68.0, 4.0], up: [0, 1, 0], fov: 36 },

  // --- SOUTH-EAST CORNER (58th St & Grand Army Plaza) ---
  // Turret is at corner (X ~ 34, Z ~ 40). Gable on South facade is at X ~ 22, Z ~ 38.
  // To have gable on LEFT and turret on RIGHT:
  // Camera needs to be South of the building (Z ~ 50..55), looking North/Northeast towards X ~ 28, Z ~ 38
  { frame: 4, timeSec: 2.0, position: [26.0, 64.0, 54.0], target: [30.0, 69.0, 38.0], up: [0, 1, 0], fov: 40 },
  { frame: 5, timeSec: 2.5, position: [24.0, 65.0, 52.0], target: [29.0, 70.0, 38.0], up: [0, 1, 0], fov: 44 },
  
  // Or looking at East facade of SE corner:
  // Turret is at X ~ 34, Z ~ 40. Gable is at X ~ 32, Z ~ 32.
  // To have gable on LEFT and turret on RIGHT:
  // Camera needs to be at X ~ 48, Z ~ 28 looking at X ~ 32, Z ~ 36
  { frame: 6, timeSec: 3.0, position: [48.0, 64.0, 28.0], target: [32.0, 69.0, 36.0], up: [0, 1, 0], fov: 40 },
  { frame: 7, timeSec: 3.5, position: [46.0, 65.0, 30.0], target: [31.0, 70.0, 37.0], up: [0, 1, 0], fov: 44 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_both_corners_closeup');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_both_corners_closeup_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 8 candidate viewpoints for closeup corners...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Both Corners Closeup'
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
      outputVideoPath: path.join(outputDir, 'test_corners.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering candidate viewpoints!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
