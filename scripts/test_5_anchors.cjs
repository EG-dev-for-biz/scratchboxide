const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();

const anchorFrames = [
  // Keyframe 1 (0.0s): Established rooftop gable & corner turret looking South-West
  { frame: 0, timeSec: 0.0, position: [52.0, 68.5, -6.0], target: [33.5, 70.5, 4.5], up: [0, 1, 0], fov: 32.0 },
  // Keyframe 2 (3.75s): Mid-facade crane descent tracking turret & balconies
  { frame: 1, timeSec: 3.75, position: [44.0, 46.0, -1.0], target: [33.5, 42.0, 5.0], up: [0, 1, 0], fov: 36.0 },
  // Keyframe 3 (7.5s): Lower facade entrance approach looking at portico canopy
  { frame: 2, timeSec: 7.5, position: [40.0, 24.0, 5.0], target: [34.0, 15.0, 9.0], up: [0, 1, 0], fov: 40.0 },
  // Keyframe 4 (11.25s): High-angle pitch transition over canopy
  { frame: 3, timeSec: 11.25, position: [37.0, 16.0, 9.5], target: [36.0, 3.0, 10.5], up: [0, 1, 0], fov: 44.0 },
  // Keyframe 5 (15.0s): Pure nadir top-down orthographic look at sidewalk & roadway
  { frame: 4, timeSec: 15.0, position: [36.5, 11.5, 11.0], target: [36.5, 0.0, 11.0], up: [0, 0, -1], fov: 48.0 }
];

const testPathData = {
  totalFrames: anchorFrames.length,
  fps: 24,
  durationSec: 15.0,
  frames: anchorFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/test_5_anchors');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const testPathFile = path.join(process.cwd(), 'public/models/test_5_anchors_path.json');
  fs.writeFileSync(testPathFile, JSON.stringify(testPathData, null, 2));

  console.log('Rendering 5 Anchor Keyframes across 15s flight...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel 5 Anchor Keyframes'
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
      outputVideoPath: path.join(outputDir, 'test_5_anchors.mp4'),
      framesDir: outputDir
    }
  });

  console.log('Done rendering 5 Anchor Keyframes!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
