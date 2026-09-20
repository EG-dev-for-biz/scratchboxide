const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// 16-frame 360 orbit around the Plaza Hotel roof at Y=70
const orbitPoses = [];
const centerX = 20.0;
const centerZ = 20.0;
const centerY = 70.0;
const radius = 35.0; // 35 meters from center
const numFrames = 16;

for (let i = 0; i < numFrames; i++) {
  const angle = (i / numFrames) * Math.PI * 2;
  const x = centerX + Math.cos(angle) * radius;
  const z = centerZ + Math.sin(angle) * radius;
  orbitPoses.push({
    frame: i,
    timeSec: i * 0.25,
    position: [parseFloat(x.toFixed(1)), 72.0, parseFloat(z.toFixed(1))],
    target: [centerX, 70.0, centerZ],
    up: [0, 1, 0],
    fov: 50
  });
}

const testPathData = {
  totalFrames: orbitPoses.length,
  fps: 24,
  durationSec: numFrames * 0.25,
  frames: orbitPoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/survey_roof_orbit');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/survey_roof_orbit_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 16-frame 360 orbit around Plaza Hotel roof...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Roof Orbit Survey'
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
      outputVideoPath: path.join(outputDir, 'orbit.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering roof orbit survey!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
