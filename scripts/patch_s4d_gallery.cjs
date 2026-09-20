const fs = require('fs');
const path = require('path');

const galleryPath = path.resolve('public/s4d_multi_gallery.html');
const lines = fs.readFileSync(galleryPath, 'utf8').split('\n');

// Line 223 (0-indexed 222) contains: const evaluationsData = [...];
let evalLineIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('    const evaluationsData = [') || lines[i].startsWith('const evaluationsData = [')) {
    evalLineIdx = i;
    break;
  }
}

if (evalLineIdx === -1) {
  console.error('Could not find line starting with const evaluationsData = [');
  process.exit(1);
}

console.log(`Found evaluationsData at line ${evalLineIdx + 1}`);
const line = lines[evalLineIdx];
const prefix = line.indexOf('[');
const suffix = line.lastIndexOf('];');

if (prefix === -1 || suffix === -1) {
  console.error('Bracket markers not found on evaluationsData line');
  process.exit(1);
}

const jsonStr = line.slice(prefix, suffix + 1);
const evaluationsData = JSON.parse(jsonStr);

console.log(`Successfully parsed ${evaluationsData.length} districts.`);

// Update District 2: Tokyo Shibuya Commercial
evaluationsData[2].videoAvailable = true;
evaluationsData[2].videoSources = {
  comparison: {
    local: "videos/s4d_shibuya_comparison.mp4",
    gcs: "videos/s4d_shibuya_comparison.mp4"
  },
  synthesis: {
    local: "videos/s4d_shibuya_omni_synthesis.mp4",
    gcs: "videos/s4d_shibuya_omni_synthesis.mp4"
  },
  blockout: {
    local: "videos/s4d_shibuya_blockout_ref.mp4",
    gcs: "videos/s4d_shibuya_blockout_ref.mp4"
  }
};
evaluationsData[2].storyboardBeats = [
  "storyboards/shibuya_beat_01.jpg",
  "storyboards/shibuya_beat_02.jpg",
  "storyboards/shibuya_beat_03.jpg",
  "storyboards/shibuya_beat_04.jpg",
  "storyboards/shibuya_beat_05.jpg",
  "storyboards/shibuya_beat_06.jpg",
  "storyboards/shibuya_beat_07.jpg",
  "storyboards/shibuya_beat_08.jpg"
];
evaluationsData[2].aiImageUrl = "images/shibuya_ai.png";
evaluationsData[2].localImage = "images/shibuya_ai.png";
evaluationsData[2].aiDescription = "Tokyo Shibuya high-density commercial crossing conditioned on 6-DOF pedestrian & aerial blockout trajectory, synthesized into photorealistic rain-slicked neon cinema via Google Omni 1.1 Flash.";

// Update District 3: Alpine Mountain Ridge
evaluationsData[3].videoAvailable = true;
evaluationsData[3].videoSources = {
  comparison: {
    local: "videos/s4d_alpine_comparison.mp4",
    gcs: "videos/s4d_alpine_comparison.mp4"
  },
  synthesis: {
    local: "videos/s4d_alpine_omni_synthesis.mp4",
    gcs: "videos/s4d_alpine_omni_synthesis.mp4"
  },
  blockout: {
    local: "videos/s4d_alpine_blockout_ref.mp4",
    gcs: "videos/s4d_alpine_blockout_ref.mp4"
  }
};
evaluationsData[3].storyboardBeats = [
  "storyboards/alpine_beat_01.jpg",
  "storyboards/alpine_beat_02.jpg",
  "storyboards/alpine_beat_03.jpg",
  "storyboards/alpine_beat_04.jpg",
  "storyboards/alpine_beat_05.jpg",
  "storyboards/alpine_beat_06.jpg",
  "storyboards/alpine_beat_07.jpg",
  "storyboards/alpine_beat_08.jpg"
];
evaluationsData[3].aiImageUrl = "images/alpine_ai.png";
evaluationsData[3].localImage = "images/alpine_ai.png";
evaluationsData[3].aiDescription = "Alpine Mountain Ridge high-altitude craggy summit flight conditioned on spatial voxel terrain, synthesized with authentic snow drifts and sunrise lighting via Google Omni 1.1 Flash.";

// Update District 4: Dubai Marina Waterfront
evaluationsData[4].videoAvailable = true;
evaluationsData[4].videoSources = {
  comparison: {
    local: "videos/s4d_dubai_comparison.mp4",
    gcs: "videos/s4d_dubai_comparison.mp4"
  },
  synthesis: {
    local: "videos/s4d_dubai_omni_synthesis.mp4",
    gcs: "videos/s4d_dubai_omni_synthesis.mp4"
  },
  blockout: {
    local: "videos/s4d_dubai_blockout_ref.mp4",
    gcs: "videos/s4d_dubai_blockout_ref.mp4"
  }
};
evaluationsData[4].storyboardBeats = [
  "storyboards/dubai_beat_01.jpg",
  "storyboards/dubai_beat_02.jpg",
  "storyboards/dubai_beat_03.jpg",
  "storyboards/dubai_beat_04.jpg",
  "storyboards/dubai_beat_05.jpg",
  "storyboards/dubai_beat_06.jpg",
  "storyboards/dubai_beat_07.jpg",
  "storyboards/dubai_beat_08.jpg"
];
evaluationsData[4].aiImageUrl = "images/dubai_ai.png";
evaluationsData[4].localImage = "images/dubai_ai.png";
evaluationsData[4].aiDescription = "Dubai Marina Waterfront luxury skyscraper canyon and yacht canal conditioned on 6-DOF coastal aerial trajectory, synthesized with azure waters and glass reflections via Google Omni 1.1 Flash.";

// Re-write line 223
const indent = line.slice(0, prefix);
lines[evalLineIdx] = indent + JSON.stringify(evaluationsData) + ';';

let content = lines.join('\n');

// 2. Update CSS for Omni Video Output Telemetry & Export Bar
const cssToInsert = `
    /* Omni Video Stream Banner */
    .omni-stream-banner { background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95)); border: 1px solid rgba(168, 85, 247, 0.35); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
    .stream-info { display: flex; flex-direction: column; gap: 2px; }
    .stream-title { font-size: 11px; font-weight: 700; color: #e2e8f0; display: flex; align-items: center; gap: 6px; }
    .stream-specs { font-size: 9px; color: #94a3b8; font-family: monospace; }
    .btn-export-omni { background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; text-decoration: none; font-size: 10px; font-weight: 700; padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 4px; }
    .btn-export-omni:hover { background: linear-gradient(135deg, #c084fc, #818cf8); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(168,85,247,0.4); }
`;

if (!content.includes('omni-stream-banner')) {
  content = content.replace('.pipeline-summary {', cssToInsert + '\n    .pipeline-summary {');
}

// 3. Rename Tab
content = content.replace(
  '<button class="ai-tab active" id="tab-video" onclick="switchMediaMode(\'video\')">🎬 Video Stream</button>',
  '<button class="ai-tab active" id="tab-video" onclick="switchMediaMode(\'video\')">🎬 Omni Video Output</button>'
);

// 4. Insert Omni Stream Banner in video container
const bannerHtml = `
      <!-- Omni Video Output Telemetry & Export Bar -->
      <div class="omni-stream-banner" id="omni-stream-banner">
        <div class="stream-info">
          <div class="stream-title" id="stream-title">✨ Polished Omni Render <span style="font-size:9px; background:rgba(168,85,247,0.25); color:#c084fc; border:1px solid rgba(168,85,247,0.5); padding:1px 5px; border-radius:3px;">Google Omni 1.1 Flash</span></div>
          <div class="stream-specs" id="stream-specs">1280×720 · 24fps Cinema Cadence · H.264 High Profile</div>
        </div>
        <a id="btn-export-omni" class="btn-export-omni" href="videos/google_tiles_omni_restyled.mp4" download="omni_video_output.mp4" title="Download active Omni Video stream">
          ⬇ Export Video (.mp4)
        </a>
      </div>
`;

if (!content.includes('id="omni-stream-banner"')) {
  content = content.replace(
    '<div id="video-container" class="active">\n      <div class="media-box">',
    '<div id="video-container" class="active">' + bannerHtml + '      <div class="media-box">'
  );
}

// 5. Update selectVideoSource to update export link and stream specs
const selectVideoSourceOld = `      const dist = evaluationsData[currentDistrictIdx];
      const videoEl = document.getElementById('ai-video-player');
      if (dist.videoSources && dist.videoSources[type]) {
        const srcObj = dist.videoSources[type];
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        videoEl.src = isLocal ? srcObj.local : srcObj.gcs;
        videoEl.load();
        videoEl.play().catch(e => console.log('Autoplay muted:', e));
      }`;

const selectVideoSourceNew = `      const dist = evaluationsData[currentDistrictIdx];
      const videoEl = document.getElementById('ai-video-player');
      if (dist.videoSources && dist.videoSources[type]) {
        const srcObj = dist.videoSources[type];
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const activeSrc = isLocal ? srcObj.local : srcObj.gcs;
        videoEl.src = activeSrc;
        videoEl.load();
        videoEl.play().catch(e => console.log('Autoplay muted:', e));

        const exportBtn = document.getElementById('btn-export-omni');
        if (exportBtn) {
          exportBtn.href = activeSrc;
          exportBtn.download = (dist.shortButtonName || dist.id) + '_' + type + '.mp4';
        }

        const titleEl = document.getElementById('stream-title');
        if (titleEl) {
          if (type === 'synthesis') {
            titleEl.innerHTML = '✨ Polished Omni Render <span style="font-size:9px; background:rgba(168,85,247,0.25); color:#c084fc; border:1px solid rgba(168,85,247,0.5); padding:1px 5px; border-radius:3px;">Google Omni 1.1 Flash</span>';
          } else if (type === 'blockout') {
            titleEl.innerHTML = '📐 &lt;VIDEO_REF_0&gt; Blockout <span style="font-size:9px; background:rgba(56,189,248,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.5); padding:1px 5px; border-radius:3px;">6-DOF Kinematics</span>';
          } else {
            titleEl.innerHTML = '⚡ Side-by-Side Split <span style="font-size:9px; background:rgba(245,158,11,0.2); color:#fbbf24; border:1px solid rgba(245,158,11,0.5); padding:1px 5px; border-radius:3px;">Blockout vs Omni</span>';
          }
        }
      }`;

content = content.replace(selectVideoSourceOld, selectVideoSourceNew);

// 6. Update district button rendering to show Omni badge
content = content.replace(
  "btn.innerText = d.shortButtonName || d.name.split(' ')[0];",
  "btn.innerHTML = (d.shortButtonName || d.name.split(' ')[0]) + (d.videoAvailable ? ' <span style=\"font-size:8px; color:#38bdf8; font-weight:700;\">● OMNI</span>' : '');"
);

fs.writeFileSync(galleryPath, content, 'utf8');
console.log('✅ Successfully patched public/s4d_multi_gallery.html with Omni Video Outputs across all districts!');
