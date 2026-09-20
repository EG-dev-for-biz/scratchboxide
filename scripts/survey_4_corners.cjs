const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const candidatePoses = [
  // 0: SE corner from GAP (looking NW)
  { frame: 0, timeSec: 0.0, position: [46.0, 68.0, 48.0], target: [30.0, 71.0, 36.0], up: [0, 1, 0], fov: 45 },
  // 1: SE corner from 58th St (looking NE)
  { frame: 1, timeSec: 0.5, position: [26.0, 68.0, 52.0], target: [32.0, 71.0, 38.0], up: [0, 1, 0], fov: 45 },
  // 2: SE corner from GAP looking SW
  { frame: 2, timeSec: 1.0, position: [48.0, 68.0, 32.0], target: [32.0, 71.0, 40.0], up: [0, 1, 0], fov: 45 },
  // 3: NE corner from GAP (looking SW)
  { frame: 3, timeSec: 1.5, position: [48.0, 68.0, 8.0], target: [32.0, 71.0, 0.0], up: [0, 1, 0], fov: 45 },
  // 4: NE corner from GAP (looking NW)
  { frame: 4, timeSec: 2.0, position: [48.0, 68.0, -8.0], target: [32.0, 71.0, 0.0], up: [0, 1, 0], fov: 45 },
  // 5: NE corner from 59th St (looking SE)
  { frame: 5, timeSec: 2.5, position: [24.0, 68.0, -12.0], target: [32.0, 71.0, 2.0], up: [0, 1, 0], fov: 45 },
  // 6: NE corner from 59th St (looking SW)
  { frame: 6, timeSec: 3.0, position: [38.0, 68.0, -12.0], target: [26.0, 71.0, 4.0], up: [0, 1, 0], fov: 45 },
  // 7: East Facade Center (looking West)
  { frame: 7, timeSec: 3.5, position: [52.0, 70.0, 20.0], target: [30.0, 70.0, 20.0], up: [0, 1, 0], fov: 50 },
  // 8: South Facade Center (looking North)
  { frame: 8, timeSec: 4.0, position: [18.0, 70.0, 55.0], target: [18.0, 70.0, 35.0], up: [0, 1, 0], fov: 50 },
  // 9: North Facade Center (looking South)
  { frame: 9, timeSec: 4.5, position: [18.0, 70.0, -18.0], target: [18.0, 70.0, 5.0], up: [0, 1, 0], fov: 50 },
  // 10: SW corner from 58th St (looking NE)
  { frame: 10, timeSec: 5.0, position: [-10.0, 68.0, 52.0], target: [4.0, 71.0, 38.0], up: [0, 1, 0], fov: 45 },
  // 11: NW corner from 59th St (looking SE)
  { frame: 11, timeSec: 5.5, position: [-10.0, 68.0, -12.0], target: [4.0, 71.0, 4.0], up: [0, 1, 0], fov: 45 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/survey_4_corners');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/survey_4_corners_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 12 comprehensive corner surveys...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC 4 Corners Survey'
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
      outputVideoPath: path.join(outputDir, 'survey_4_corners.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering 4 corners survey!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
