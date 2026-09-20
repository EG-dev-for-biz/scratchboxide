const fs = require('fs');
const path = require('path');

const galleryPath = path.resolve(__dirname, '../public/s4d_multi_gallery.html');
let html = fs.readFileSync(galleryPath, 'utf8');

// 1. Locate and parse evaluationsData
const dataMatch = html.match(/const evaluationsData = (\[.*?\]);/s);
if (!dataMatch) {
  console.error('Could not match evaluationsData in gallery HTML');
  process.exit(1);
}

const evaluationsData = JSON.parse(dataMatch[1]);
console.log(`Parsed ${evaluationsData.length} districts.`);

// 2. Update Textured District (s4d_google_tiles_textured_01)
const texturedDist = evaluationsData.find(d => d.id === 's4d_google_tiles_textured_01');
if (texturedDist) {
  texturedDist.storyboardBeats = [
    "storyboards_textured/beat_00.jpg",
    "storyboards_textured/beat_01.jpg",
    "storyboards_textured/beat_02.jpg",
    "storyboards_textured/beat_03.jpg",
    "storyboards_textured/beat_04.jpg",
    "storyboards_textured/beat_05.jpg",
    "storyboards_textured/beat_06.jpg",
    "storyboards_textured/beat_07.jpg"
  ];

  texturedDist.collisionAudit = {
    enabled: true,
    violationsDetected: 0,
    minClearanceMeters: 17.39,
    maxElevationAdjustment: 0,
    pathAdjusted: false,
    auditPassed: true
  };

  texturedDist.tileMetrics = {
    totalFramesCaptured: 72,
    averageSettleTimeMs: 315,
    maxTilesLoaded: 524,
    errorTarget: 0.5,
    renderMode: "textured"
  };

  texturedDist.blockoutFrame = "images/blockout_textured_frame_00.png";
  texturedDist.startFrame = "images/start_frame_01_omni.png";

  texturedDist.videoSources = {
    comparison: {
      local: "videos/google_tiles_textured_vs_omni_comparison.mp4",
      gcs: "https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_textured_vs_omni_comparison.mp4"
    },
    synthesis: {
      local: "videos/google_tiles_omni_restyled.mp4",
      gcs: "https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_omni_restyled.mp4"
    },
    blockout: {
      local: "videos/google_tiles_textured_blockout_camera.mp4",
      gcs: "https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_textured_blockout_camera.mp4"
    }
  };
  console.log('✅ Updated texturedDist (s4d_google_tiles_textured_01) with textured assets.');
} else {
  console.warn('⚠️ texturedDist (s4d_google_tiles_textured_01) not found!');
}

// 3. Update Clay District (s4d_google_tiles_clay_01)
const clayDist = evaluationsData.find(d => d.id === 's4d_google_tiles_clay_01');
if (clayDist) {
  clayDist.storyboardBeats = [
    "storyboards_clay/beat_00.jpg",
    "storyboards_clay/beat_01.jpg",
    "storyboards_clay/beat_02.jpg",
    "storyboards_clay/beat_03.jpg",
    "storyboards_clay/beat_04.jpg",
    "storyboards_clay/beat_05.jpg",
    "storyboards_clay/beat_06.jpg",
    "storyboards_clay/beat_07.jpg"
  ];

  clayDist.collisionAudit = {
    enabled: true,
    violationsDetected: 0,
    minClearanceMeters: 75.0,
    maxElevationAdjustment: 0,
    pathAdjusted: false,
    auditPassed: true
  };

  clayDist.tileMetrics = {
    totalFramesCaptured: 72,
    averageSettleTimeMs: 282,
    maxTilesLoaded: 524,
    errorTarget: 0.5,
    renderMode: "clay"
  };

  clayDist.blockoutFrame = "models/blockout_first_frame.jpg";
  clayDist.startFrame = "images/start_frame_01_omni.png";

  clayDist.videoSources = {
    comparison: {
      local: "videos/google_tiles_clay_vs_omni_real_comparison.mp4",
      gcs: "https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_clay_vs_omni_comparison.mp4"
    },
    synthesis: {
      local: "videos/google_tiles_omni_restyled.mp4",
      gcs: "https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_omni_restyled.mp4"
    },
    blockout: {
      local: "videos/google_tiles_clay_blockout_camera.mp4",
      gcs: "https://scratchbox-canvas-4danyone-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_clay_blockout_camera.mp4"
    }
  };
  console.log('✅ Updated clayDist (s4d_google_tiles_clay_01) with clay assets.');
} else {
  console.warn('⚠️ clayDist (s4d_google_tiles_clay_01) not found!');
}

// 4. Validate Asset Integrity before writing HTML
const publicDir = path.resolve(__dirname, '../public');
const districtsToCheck = [texturedDist, clayDist].filter(Boolean);

for (const dist of districtsToCheck) {
  // Validate videoSources
  for (const [key, srcObj] of Object.entries(dist.videoSources)) {
    const fullPath = path.join(publicDir, srcObj.local);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Asset verification failed for district ${dist.id}: ${key} file not found at ${fullPath}`);
    }
    const stat = fs.statSync(fullPath);
    if (stat.size === 0) {
      throw new Error(`Asset verification failed for district ${dist.id}: ${key} file is 0 bytes at ${fullPath}`);
    }
    // Verify semantic match: textured district must not have clay video
    if (dist.id.includes('textured') && srcObj.local.includes('clay')) {
      throw new Error(`Semantic mismatch: textured district ${dist.id} has clay asset ${srcObj.local}`);
    }
    // Verify semantic match: clay district must not have textured video
    if (dist.id.includes('clay') && srcObj.local.includes('textured')) {
      throw new Error(`Semantic mismatch: clay district ${dist.id} has textured asset ${srcObj.local}`);
    }
  }

  // Validate storyboardBeats
  for (const beat of dist.storyboardBeats) {
    const fullPath = path.join(publicDir, beat);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Asset verification failed for district ${dist.id}: storyboard file not found at ${fullPath}`);
    }
  }
}
console.log('🛡️ All district assets verified on disk and passed semantic checks!');

// 5. Replace evaluationsData in HTML
html = html.replace(/const evaluationsData = \[.*?\];/s, `const evaluationsData = ${JSON.stringify(evaluationsData)};`);

// 6. Update Conditioning Card 1 to be dynamic per district or use blockout_textured_frame_00.png for default
html = html.replace(
  'src="models/blockout_first_frame.jpg"',
  'src="images/blockout_textured_frame_00.png"'
);

fs.writeFileSync(galleryPath, html, 'utf8');
console.log('✅ Successfully updated public/s4d_multi_gallery.html with validated assets!');
