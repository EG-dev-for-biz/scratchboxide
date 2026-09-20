const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's create a 4-view survey of the roof:
// 1. Bird's eye looking down from Y=120 over [X=35, Z=5]
// 2. Frontal view from East (Grand Army Plaza) [X=65, Y=70, Z=0] looking at [X=25, Y=68, Z=0]
// 3. Northeast angle [X=55, Y=72, Z=-20] looking at [X=25, Y=68, Z=5]
// 4. North angle [X=30, Y=72, Z=-35] looking at [X=28, Y=68, Z=5]

const surveyPoses = [
  // 1. High-angle top-down overview
  { frame: 0, timeSec: 0.0, position: [35.0, 130.0, 5.0], target: [35.0, 60.0, 5.0], up: [0, 0, -1], fov: 60.0, desc: 'birds_eye_topdown' },

  // 2. High-angle angled overview
  { frame: 1, timeSec: 0.5, position: [75.0, 100.0, -10.0], target: [28.0, 68.0, 5.0], up: [0, 1, 0], fov: 50.0, desc: 'high_angle_angled' },

  // 3. Facade East view at roof level
  { frame: 2, timeSec: 1.0, position: [65.0, 72.0, 5.0], target: [25.0, 68.0, 5.0], up: [0, 1, 0], fov: 45.0, desc: 'facade_east_level' },

  // 4. Northeast angle at roof level (similar to Frame 0)
  { frame: 3, timeSec: 1.5, position: [55.0, 72.0, -15.0], target: [28.0, 68.0, 5.0], up: [0, 1, 0], fov: 45.0, desc: 'northeast_roof_level' }
];

const testPathData = {
  totalFrames: surveyPoses.length,
  fps: 24,
  durationSec: surveyPoses.length * 0.5,
  frames: surveyPoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/roof_survey');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/roof_survey_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 roof survey views...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel Roof Survey'
    },
    cameraPath: testPathFile,
    collision: { enabled: false },
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
      outputVideoPath: path.join(outputDir, 'roof_survey.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering roof survey views!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
