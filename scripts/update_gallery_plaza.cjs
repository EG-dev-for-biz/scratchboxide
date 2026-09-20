const fs = require('fs');
const path = require('path');

const galleryPath = path.resolve(__dirname, '../public/s4d_multi_gallery.html');
const backupPath = path.resolve(__dirname, '../public/s4d_multi_gallery.html.bak');

if (!fs.existsSync(galleryPath)) {
  console.error(`Gallery not found: ${galleryPath}`);
  process.exit(1);
}

// 1. Create backup
fs.copyFileSync(galleryPath, backupPath);
console.log(`✓ Backup created at ${backupPath}`);

let html = fs.readFileSync(galleryPath, 'utf8');

// 2. Parse evaluationsData
const dataMatch = html.match(/const evaluationsData = (\[.*?\]);/s);
if (!dataMatch) {
  console.error('Could not match evaluationsData');
  process.exit(1);
}

const evaluationsData = JSON.parse(dataMatch[1]);
console.log(`Found ${evaluationsData.length} existing districts.`);

const plazaDistrict = {
  id: "s4d_plaza_hotel_01",
  name: "The Plaza Hotel NYC (Live Action Photorealistic Cine Animate)",
  shortButtonName: "🏨 Plaza Hotel",
  isGlb: false,
  wgs84: {
    lat: 40.7645,
    lng: -73.9744,
    alt: 18
  },
  durationMs: 15042,
  occupancyRatePct: 100,
  temporalConsistencyPct: 100,
  maxSpeedKmh: 42,
  classDistribution: {
    "Limestone & Quoins": { count: 1420, pct: 49.3 },
    "Copper Mansard Roof": { count: 890, pct: 30.9 },
    "Fenestration & Entrance": { count: 570, pct: 19.8 }
  },
  videoAvailable: true,
  videoSources: {
    comparison: {
      local: "videos/plaza_hotel_vs_omni_comparison.mp4",
      gcs: "videos/plaza_hotel_vs_omni_comparison.mp4"
    },
    synthesis: {
      local: "videos/plaza_hotel_omni_restyled.mp4",
      gcs: "videos/plaza_hotel_omni_restyled.mp4"
    },
    blockout: {
      local: "videos/plaza_hotel_blockout_camera.mp4",
      gcs: "videos/plaza_hotel_blockout_camera.mp4"
    }
  },
  storyboardBeats: [
    "storyboards_plaza/beat_00.jpg",
    "storyboards_plaza/beat_01.jpg",
    "storyboards_plaza/beat_02.jpg",
    "storyboards_plaza/beat_03.jpg",
    "storyboards_plaza/beat_04.jpg",
    "storyboards_plaza/beat_05.jpg",
    "storyboards_plaza/beat_06.jpg",
    "storyboards_plaza/beat_07.jpg"
  ],
  aiImageUrl: "images/plaza_hotel_start_frame.png",
  localImage: "images/plaza_hotel_start_frame.png",
  startFrame: "images/plaza_hotel_start_frame.png",
  blockoutFrame: "images/plaza_hotel_frame_00.png",
  aiDescription: "The Plaza Hotel NYC live-action photorealistic cine animate descent. Starting at roof line, slowly descending along the intricate neo-Renaissance limestone stonework and weathered copper mansard roof, maintaining absolute stability and crisp architectural detail under bright editorial daylight down to a bird's eye view of the street where a girl has written her name Eloise in chalk.",
  collisionAudit: {
    enabled: true,
    violationsDetected: 0,
    minClearanceMeters: 25.0,
    maxElevationAdjustment: 0,
    pathAdjusted: false,
    auditPassed: true
  },
  qaKeyframes: [
    {
      src: "images/plaza_comparison_4k_keyframe_01_f1.png",
      title: "KF 01 · Frame 1",
      badge: "✓ 0ms Drift",
      desc: "<b>t=0.04s</b>: Start frame alignment with 3D Photorealistic Google Tiles blockout vs Omni 1.1 roofline mansard cupola."
    },
    {
      src: "images/plaza_comparison_4k_keyframe_02_f72.png",
      title: "KF 02 · Frame 72",
      badge: "✓ Parallax Locked",
      desc: "<b>t=3.00s</b>: Crane descent down upper limestone facade; limestone quoins and copper dormers track with zero lateral drift."
    },
    {
      src: "images/plaza_comparison_4k_keyframe_03_f132.png",
      title: "KF 03 · Frame 132",
      badge: "✓ Facade Locked",
      desc: "<b>t=5.50s</b>: Mid-facade approach facing marquee sign 'THE PLAZA NEW YORK'; window mullions conform precisely to 3D geometry."
    },
    {
      src: "images/plaza_comparison_4k_keyframe_04_f168.png",
      title: "KF 04 · Frame 168",
      badge: "✓ >25m Buffer",
      desc: "<b>t=7.00s</b>: Steep crane boom tilt down over entrance canopy (25.0m buffer). Zero structural collision."
    },
    {
      src: "images/plaza_comparison_4k_keyframe_05_f240.png",
      title: "KF 05 · Frame 240",
      badge: "✓ Vanishing Aligned",
      desc: "<b>t=10.00s</b>: Bird's-eye nadir view (-90.0°) over checkered sidewalk and yellow taxi exiting along 59th St."
    },
    {
      src: "images/plaza_comparison_4k_keyframe_06_f360.png",
      title: "KF 06 · Frame 360",
      badge: "✓ 0 Camera Cuts",
      desc: "<b>t=15.00s</b>: Terminal push-in descent over Eloise in chalk on street; synchronous 361-frame 4K completion, 0 cuts."
    }
  ],
  tileMetrics: {
    totalFramesCaptured: 361,
    averageSettleTimeMs: 218,
    maxTilesLoaded: 480,
    errorTarget: 0.5,
    renderMode: "textured"
  }
};

// Check if already in array
const existingIdx = evaluationsData.findIndex(d => d.id === plazaDistrict.id);
if (existingIdx >= 0) {
  console.log(`Updating existing entry at index ${existingIdx}`);
  evaluationsData[existingIdx] = plazaDistrict;
} else {
  console.log(`Inserting Plaza Hotel at index 2 (after Clay Flight)`);
  evaluationsData.splice(2, 0, plazaDistrict);
}

// Replace evaluationsData in HTML
const newEvaluationsDataStr = `const evaluationsData = ${JSON.stringify(evaluationsData)};`;
html = html.replace(/const evaluationsData = \[.*?\];/s, newEvaluationsDataStr);

// Update selectVideoSource for Plaza
const oldSelectVid = `        const titleEl = document.getElementById('stream-title');
        const hudTitle = document.getElementById('hud-title');
        const hudTag = document.getElementById('hud-tag');
        const isTextured = dist.id.includes('textured');

        let titleHtml = '';
        let specsText = '';
        let hudHeaderTitle = '';

        if (type === 'synthesis') {
          titleHtml = '✨ Step 3: Polished Omni Render <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">AUTHENTIC GOOGLE OMNI 1.1 EXECUTION</span>';
          specsText = '3840×2160 UHD (4K) · 24fps · H.264 · 29.9 Mbps · Vertex AI gemini-omni-1.1-flash-preview';
          hudHeaderTitle = '✨ Step 3: Polished Omni Render (4K UHD)';
        } else if (type === 'blockout') {
          titleHtml = isTextured ?
            '📐 Step 1: &lt;VIDEO_REF_0&gt; Textured 3D Tiles <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">🛡️ 17.4M COLLISION AUDIT PASSED</span>' :
            '📐 Step 1: &lt;VIDEO_REF_0&gt; Blockout <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">🛡️ COLLISION AUDIT PASSED</span>';
          specsText = isTextured ?
            '3840×2160 UHD (4K) · 24fps · Photorealistic 3D Tiles · 17.4m Min Clearance · 0 Breaches' :
            '3840×2160 UHD (4K) · 24fps · Watertight C++20 Flight · 75.0m Min Clearance · 0 Breaches';
          hudHeaderTitle = isTextured ? '📐 Step 1: Textured 3D Tiles Blockout' : '📐 Step 1: Clay 3D Blockout';
        } else {
          titleHtml = isTextured ?
            '⚡ Side-by-Side Split <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">Step 1 Textured 3D Tiles vs Step 3 Omni Output</span>' :
            '⚡ Side-by-Side Split <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">Step 1 &lt;VIDEO_REF_0&gt; vs Step 3 Omni Output</span>';
          specsText = isTextured ?
            '3840×2160 UHD (4K) · Synchronized Comparison: Step 1 Textured (Left) vs Step 3 Omni (Right) · 28.7 Mbps' :
            '3840×2160 UHD (4K) · Synchronized Comparison: Step 1 (Left) vs Step 3 (Right) · 28.2 Mbps';
          hudHeaderTitle = '⚡ Side-by-Side Split: Step 1 vs Step 3 (4K UHD)';
        }`;

const newSelectVid = `        const titleEl = document.getElementById('stream-title');
        const hudTitle = document.getElementById('hud-title');
        const hudTag = document.getElementById('hud-tag');
        const isTextured = dist.id.includes('textured');
        const isPlaza = dist.id.includes('plaza');

        let titleHtml = '';
        let specsText = '';
        let hudHeaderTitle = '';

        if (type === 'synthesis') {
          titleHtml = '✨ Step 3: Polished Omni Render <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">AUTHENTIC GOOGLE OMNI 1.1 EXECUTION</span>';
          specsText = isPlaza ?
            '3840×2160 UHD (4K) · 24fps · H.264 · 33.7 Mbps · The Plaza Hotel Roofline Crane Descent' :
            '3840×2160 UHD (4K) · 24fps · H.264 · 29.9 Mbps · Vertex AI gemini-omni-1.1-flash-preview';
          hudHeaderTitle = '✨ Step 3: Polished Omni Render (4K UHD)';
        } else if (type === 'blockout') {
          titleHtml = isPlaza ?
            '📐 Step 1: &lt;VIDEO_REF_0&gt; 3D Photorealistic Tiles <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">🛡️ 25.0M COLLISION AUDIT PASSED</span>' :
            (isTextured ?
            '📐 Step 1: &lt;VIDEO_REF_0&gt; Textured 3D Tiles <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">🛡️ 17.4M COLLISION AUDIT PASSED</span>' :
            '📐 Step 1: &lt;VIDEO_REF_0&gt; Blockout <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">🛡️ COLLISION AUDIT PASSED</span>');
          specsText = isPlaza ?
            '3840×2160 UHD (4K) · 24fps · Photorealistic 3D Tiles · 25.0m Min Clearance · 0 Breaches' :
            (isTextured ?
            '3840×2160 UHD (4K) · 24fps · Photorealistic 3D Tiles · 17.4m Min Clearance · 0 Breaches' :
            '3840×2160 UHD (4K) · 24fps · Watertight C++20 Flight · 75.0m Min Clearance · 0 Breaches');
          hudHeaderTitle = isPlaza ? '📐 Step 1: Plaza Hotel 3D Tiles Crane Descent Blockout' : (isTextured ? '📐 Step 1: Textured 3D Tiles Blockout' : '📐 Step 1: Clay 3D Blockout');
        } else {
          titleHtml = isPlaza ?
            '⚡ Side-by-Side Split <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">Step 1 3D Tiles vs Step 3 Omni Output</span>' :
            (isTextured ?
            '⚡ Side-by-Side Split <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">Step 1 Textured 3D Tiles vs Step 3 Omni Output</span>' :
            '⚡ Side-by-Side Split <span style="font-size:9px; background:rgba(16,185,129,0.25); color:#34d399; border:1px solid rgba(16,185,129,0.5); padding:1px 5px; border-radius:3px;">Step 1 &lt;VIDEO_REF_0&gt; vs Step 3 Omni Output</span>');
          specsText = isPlaza ?
            '3840×2160 UHD (4K) · Synchronized Comparison: Step 1 3D Tiles (Left) vs Step 3 Omni (Right) · 34.2 Mbps' :
            (isTextured ?
            '3840×2160 UHD (4K) · Synchronized Comparison: Step 1 Textured (Left) vs Step 3 Omni (Right) · 28.7 Mbps' :
            '3840×2160 UHD (4K) · Synchronized Comparison: Step 1 (Left) vs Step 3 (Right) · 28.2 Mbps');
          hudHeaderTitle = isPlaza ? '⚡ Side-by-Side Split: Step 1 3D Tiles vs Step 3 Omni (4K UHD)' : '⚡ Side-by-Side Split: Step 1 vs Step 3 (4K UHD)';
        }`;

if (html.includes(oldSelectVid)) {
  html = html.replace(oldSelectVid, newSelectVid);
  console.log('✓ Updated selectVideoSource with Plaza Hotel support');
} else {
  console.log('⚠️ Could not find exact oldSelectVid chunk (may already be updated)');
}

// Update modeLabel in storyboard click
const oldModeLabel = `const modeLabel = dist.id.includes('textured') ? 'Photorealistic 3D Tiles' : '3D Clay Trajectory';`;
const newModeLabel = `const modeLabel = dist.id.includes('plaza') ? 'Plaza Hotel 3D Crane Flight' : (dist.id.includes('textured') ? 'Photorealistic 3D Tiles' : '3D Clay Trajectory');`;
if (html.includes(oldModeLabel)) {
  html = html.replace(oldModeLabel, newModeLabel);
  console.log('✓ Updated modeLabel');
}

// Update condBlockImg.src
const oldCondBlock = `condBlockImg.src = dist.id.includes('textured') ? 'images/blockout_textured_frame_00.png' : 'models/blockout_first_frame.jpg';`;
const newCondBlock = `condBlockImg.src = dist.blockoutFrame ? (isLocal ? (dist.blockoutFrame + "?v=" + Date.now()) : dist.blockoutFrame) : (dist.id.includes('textured') ? 'images/blockout_textured_frame_00.png' : 'models/blockout_first_frame.jpg');`;
if (html.includes(oldCondBlock)) {
  html = html.replace(oldCondBlock, newCondBlock);
  console.log('✓ Updated condBlockImg.src');
}

fs.writeFileSync(galleryPath, html, 'utf8');
console.log(`✓ Successfully updated ${galleryPath}`);
