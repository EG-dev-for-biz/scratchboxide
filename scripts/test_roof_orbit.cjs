const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Plaza Hotel center is approx [15, 70, 20]
// Let's place 12 cameras at radius 35m around [15, 70, 20] at height Y=72
const center = [15.0, 72.0, 20.0];
const radius = 35.0;
const numAngles = 12;

const frames = [];
for (let i = 0; i < numAngles; i++) {
  const angle = (i / numAngles) * 2 * Math.PI;
  const x = center[0] + radius * Math.cos(angle);
  const z = center[2] + radius * Math.sin(angle);
  frames.push({
    frame: i,
    timeSec: i * 0.25,
    position: [Math.round(x * 10) / 10, 73.0, Math.round(z * 10) / 10],
    target: [center[0], 71.0, center[2]],
    up: [0, 1, 0],
    fov: 50
  });
}

const testPathData = {
  totalFrames: frames.length,
  fps: 24,
  durationSec: frames.length * 0.25,
  frames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_roof_orbit');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_roof_orbit_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 12 orbit viewpoints around Plaza roof...');
  const result = await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Orbit'
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
      outputVideoPath: path.join(outputDir, 'test_roof_orbit.mp4'),
      framesDir: outputDir,
      firstFramePath: path.join(outputDir, 'orbit_f0.jpg'),
      fps: 24,
      bitrate: '5M'
    },
    port: 8109
  });

  console.log('Done rendering orbit viewpoints:', result);
}

main().catch(err => {
  console.error('Orbit test error:', err);
  process.exit(1);
});
