const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

// Let's test nadir (overhead) views at 4 candidate entrance locations:
// 1. East facade (Grand Army Plaza) center (X=39, Z=20)
// 2. East facade south (X=39, Z=30)
// 3. North facade (Central Park South) center (X=20, Z=-15)
// 4. South facade (58th St) center (X=20, Z=45)
const candidatePoses = [
  { frame: 0, timeSec: 0.0, position: [39.0, 18.0, 18.0], target: [39.0, 0.0, 18.0], up: [0, 0, -1], fov: 60 },
  { frame: 1, timeSec: 0.5, position: [39.0, 18.0, 26.0], target: [39.0, 0.0, 26.0], up: [0, 0, -1], fov: 60 },
  { frame: 2, timeSec: 1.0, position: [20.0, 18.0, -10.0], target: [20.0, 0.0, -10.0], up: [0, 0, -1], fov: 60 },
  { frame: 3, timeSec: 1.5, position: [20.0, 18.0, 42.0], target: [20.0, 0.0, 42.0], up: [0, 0, -1], fov: 60 }
];

const testPathData = {
  totalFrames: candidatePoses.length,
  fps: 24,
  durationSec: candidatePoses.length * 0.5,
  frames: candidatePoses
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/find_canopy');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/find_canopy_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 4 nadir views to locate exact canopy position...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Canopy Search'
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
      outputVideoPath: path.join(outputDir, 'canopy.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering canopy search!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
