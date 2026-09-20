const { Google3DTileBlockoutPipelineService } = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
const fs = require('fs');
const path = require('path');

const service = new Google3DTileBlockoutPipelineService();
const fullPath = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/models/plaza_hotel_camera_path.json'), 'utf8'));

// Sample the 5 key milestone frames
const milestoneIndices = [0, 72, 168, 264, 360];
const sampleFrames = milestoneIndices.map((idx, sampleIdx) => {
  const f = fullPath.frames[idx];
  return {
    ...f,
    frame: sampleIdx,
    originalFrame: idx
  };
});

const previewPathData = {
  fps: 24,
  totalFrames: sampleFrames.length,
  durationSec: sampleFrames.length * 0.5,
  frames: sampleFrames
};

async function main() {
  const outputDir = path.join(process.cwd(), 'public/videos/milestones_preview');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const previewFile = path.join(process.cwd(), 'public/models/milestones_preview_path.json');
  fs.writeFileSync(previewFile, JSON.stringify(previewPathData, null, 2));

  console.log('Rendering 5 key milestone frames: 0 (roof), 72 (facade), 168 (canopy), 264 (near-nadir), 360 (nadir)...');
  await service.run({
    geoAnchor: {
      lat: 40.7645,
      lng: -73.9744,
      elevation: 18.0,
      landmarkName: 'The Plaza Hotel NYC Milestones Preview'
    },
    cameraPath: previewFile,
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
      outputVideoPath: path.join(outputDir, 'milestones.mp4'),
      framesDir: outputDir
    }
  });
  console.log('Done rendering milestone preview!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
