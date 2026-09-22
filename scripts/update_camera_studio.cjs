const fs = require('fs');
const path = require('path');

const thumbB64 = fs.readFileSync('public/camera_demo_assets/thumb_plaza.jpg').toString('base64');
const thumbDataUri = `data:image/jpeg;base64,${thumbB64}`;

let html = fs.readFileSync('public/camera_choreography_studio.html', 'utf8');

// 1. Update PIP CSS
const oldPipCss = `    /* Picture-in-Picture: Director Viewfinder */
    .pip-viewfinder {
      position: absolute;
      top: 14px;
      right: 20px;
      width: 220px;
      height: 140px;
      background: #000;
      border: 2px solid var(--accent);
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 8px 30px rgba(0,0,0,0.8);
      display: flex;
      flex-direction: column;
    }
    .pip-header {
      background: rgba(15, 16, 21, 0.9);
      padding: 4px 8px;
      font-size: 10px;
      font-weight: 700;
      color: #c4b5fd;
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid #282a36;
    }`;

const newPipCss = `    /* Picture-in-Picture: Director Viewfinder (16:9 Widescreen) */
    .pip-viewfinder {
      position: absolute;
      top: 14px;
      right: 20px;
      width: 320px;
      height: 216px;
      background: #000;
      border: 2px solid var(--accent);
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.85);
      display: flex;
      flex-direction: column;
      z-index: 25;
    }
    .pip-header {
      background: rgba(15, 16, 21, 0.95);
      padding: 5px 8px;
      font-size: 10px;
      font-weight: 700;
      color: #c4b5fd;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #282a36;
    }
    .pip-modes {
      display: flex;
      gap: 3px;
      background: #111217;
      padding: 3px 6px;
      border-bottom: 1px solid #282a36;
    }
    .pip-mode-btn {
      flex: 1;
      padding: 3px 2px;
      font-size: 9.5px;
      font-weight: 600;
      background: #1a1c24;
      color: #94a3b8;
      border: 1px solid #2e344a;
      border-radius: 4px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .pip-mode-btn:hover {
      background: #282c3c;
      color: #fff;
    }
    .pip-mode-btn.active {
      background: #7c3aed;
      color: #fff;
      border-color: #a78bfa;
    }`;

if (html.includes(oldPipCss)) {
  html = html.replace(oldPipCss, newPipCss);
  console.log('Updated PIP CSS');
} else {
  console.log('Warning: oldPipCss not found');
}

// 2. Add Plaza Hotel button to Media Shelf
const oldShelf = `    <button class="media-thumb-btn" id="btnMedia2" onclick="switchMedia('carving')">
      <img src="data:image/png;base64,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" class="media-thumb-img" alt="Carving">
      <span>Relief Plaque</span>
    </button>`;

const newShelf = `    <button class="media-thumb-btn" id="btnMedia2" onclick="switchMedia('carving')">
      <img src="data:image/png;base64,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" class="media-thumb-img" alt="Carving">
      <span>Relief Plaque</span>
    </button>
    <button class="media-thumb-btn" id="btnMediaPlaza" onclick="switchMedia('plaza')">
      <img src="${thumbDataUri}" class="media-thumb-img" alt="Plaza Hotel Video">
      <span>🏛️ Plaza Hotel (15s Real Asset)</span>
    </button>`;

if (html.includes(oldShelf)) {
  html = html.replace(oldShelf, newShelf);
  console.log('Added Plaza Hotel button to media shelf');
} else {
  console.log('Warning: oldShelf not found');
}

// 3. Update PIP Viewfinder DOM with Mode switcher and real videos
const oldPipHtml = `    <!-- Picture in picture -->
    <div class="pip-viewfinder">
      <div class="pip-header">
        <span>DIRECTOR VIEWFINDER</span>
        <span style="color:#22c55e;">REC 24FPS</span>
      </div>
      <div style="position:relative; width:100%; height:100%; flex:1; overflow:hidden;">
        <canvas id="threeCanvasDirector" style="width:100%; height:100%; display:block;"></canvas>
        <div style="position:absolute; inset:0; pointer-events:none; border:1px solid rgba(255,255,255,0.15); margin:8px;">
          <div style="position:absolute; top:33.3%; left:0; right:0; height:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; top:66.6%; left:0; right:0; height:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; left:33.3%; top:0; bottom:0; width:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; left:66.6%; top:0; bottom:0; width:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:8px; height:8px; border:1px solid rgba(239,68,68,0.7); border-radius:50%;"></div>
        </div>
        <div style="position:absolute; bottom:4px; right:6px; font-size:9px; font-family:monospace; color:#38bdf8; background:rgba(0,0,0,0.6); padding:1px 4px; border-radius:3px;">35mm · f/2.8</div>
      </div>
    </div>`;

const newPipHtml = `    <!-- Picture in picture Director Viewfinder -->
    <div class="pip-viewfinder" id="pipViewfinder">
      <div class="pip-header">
        <span id="pipTitle">DIRECTOR VIEWFINDER</span>
        <span style="color:#22c55e;" id="pipRecBadge">● REC 24FPS</span>
      </div>
      <div class="pip-modes" id="pipModesBar">
        <button class="pip-mode-btn active" id="btnModeFrustum" onclick="setDirectorMode('frustum')">3D Frustum</button>
        <button class="pip-mode-btn" id="btnModeRealVideo" onclick="setDirectorMode('realVideo')">✨ Real DiT Video</button>
        <button class="pip-mode-btn" id="btnModeComparison" onclick="setDirectorMode('comparison')">⚡ 50/50 Split</button>
      </div>
      <div style="position:relative; width:100%; height:100%; flex:1; overflow:hidden; background:#040507;">
        <canvas id="threeCanvasDirector" style="width:100%; height:100%; display:block;"></canvas>
        <video id="viewfinderRealVideo" src="videos/plaza_hotel_omni_15s_720p.mp4" playsinline muted preload="auto" crossorigin="anonymous" style="width:100%; height:100%; object-fit:cover; display:none;"></video>
        <video id="viewfinderCompVideo" src="videos/plaza_hotel_comparison_15s_720p.mp4" playsinline muted preload="auto" crossorigin="anonymous" style="width:100%; height:100%; object-fit:contain; display:none;"></video>

        <!-- Rule of thirds & center target overlay -->
        <div style="position:absolute; inset:0; pointer-events:none; border:1px solid rgba(255,255,255,0.15); margin:6px;">
          <div style="position:absolute; top:33.3%; left:0; right:0; height:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; top:66.6%; left:0; right:0; height:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; left:33.3%; top:0; bottom:0; width:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; left:66.6%; top:0; bottom:0; width:1px; background:rgba(255,255,255,0.1);"></div>
          <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:8px; height:8px; border:1px solid rgba(239,68,68,0.7); border-radius:50%;"></div>
        </div>
        <div id="pipLensBadge" style="position:absolute; bottom:4px; right:6px; font-size:9px; font-family:monospace; color:#38bdf8; background:rgba(0,0,0,0.65); padding:1px 4px; border-radius:3px; border:1px solid rgba(56,189,248,0.3);">35mm · f/2.8</div>
        <div id="pipStatusBadge" style="position:absolute; bottom:4px; left:6px; font-size:8.5px; font-family:monospace; color:#c4b5fd; background:rgba(0,0,0,0.65); padding:1px 4px; border-radius:3px;">3D CINE OPTICAL FRUSTUM</div>
      </div>
    </div>`;

if (html.includes(oldPipHtml)) {
  html = html.replace(oldPipHtml, newPipHtml);
  console.log('Updated PIP Viewfinder HTML');
} else {
  console.log('Warning: oldPipHtml not found');
}

// 4. Update switchMedia and add setDirectorMode in script
const oldSwitchMedia = `  // -------------------------------------------------------------
  // MEDIA SWITCHER
  // -------------------------------------------------------------
  function switchMedia(key) {
    currentTargetKey = key;
    document.querySelectorAll('.media-thumb-btn').forEach(b => b.classList.remove('active'));
    if (key === 'breakdancer') {
      document.getElementById('btnMedia1').classList.add('active');
      loadCardTexture(EMBEDDED_ASSETS.breakdancer);
    } else if (key === 'carving') {
      document.getElementById('btnMedia2').classList.add('active');
      loadCardTexture(EMBEDDED_ASSETS.carving);
    } else {
      document.getElementById('btnMedia3').classList.add('active');
      loadCardTexture('');
    }
    updateBehindTheScenesData();
  }`;

const newSwitchMedia = `  // -------------------------------------------------------------
  // DIRECTOR VIEWFINDER MODES & REAL ASSET VIDEO
  // -------------------------------------------------------------
  let directorMode = 'frustum'; // 'frustum' | 'realVideo' | 'comparison'
  const realVideoEl = document.getElementById('viewfinderRealVideo');
  const compVideoEl = document.getElementById('viewfinderCompVideo');
  let plazaVideoTexture = null;

  function getPlazaVideoTexture() {
    if (!plazaVideoTexture && realVideoEl) {
      plazaVideoTexture = new THREE.VideoTexture(realVideoEl);
      plazaVideoTexture.colorSpace = THREE.SRGBColorSpace;
      plazaVideoTexture.minFilter = THREE.LinearFilter;
      plazaVideoTexture.magFilter = THREE.LinearFilter;
    }
    return plazaVideoTexture;
  }

  function setDirectorMode(mode) {
    directorMode = mode;
    document.querySelectorAll('.pip-mode-btn').forEach(b => b.classList.remove('active'));
    const cvs = document.getElementById('threeCanvasDirector');
    const vReal = realVideoEl;
    const vComp = compVideoEl;
    const statusBadge = document.getElementById('pipStatusBadge');
    const lensBadge = document.getElementById('pipLensBadge');

    if (mode === 'frustum') {
      document.getElementById('btnModeFrustum').classList.add('active');
      cvs.style.display = 'block';
      vReal.style.display = 'none';
      vComp.style.display = 'none';
      statusBadge.innerText = '3D CINE OPTICAL FRUSTUM';
      statusBadge.style.color = '#c4b5fd';
      lensBadge.innerText = '35mm · f/2.8';
    } else if (mode === 'realVideo') {
      document.getElementById('btnModeRealVideo').classList.add('active');
      cvs.style.display = 'none';
      vReal.style.display = 'block';
      vComp.style.display = 'none';
      statusBadge.innerText = 'REAL DIT SYNTHESIS (Omni 1.1)';
      statusBadge.style.color = '#38bdf8';
      lensBadge.innerText = '15.0s · 4K UHD';
      vReal.currentTime = currentTime;
      if (isPlaying && vReal.paused) vReal.play();
    } else if (mode === 'comparison') {
      document.getElementById('btnModeComparison').classList.add('active');
      cvs.style.display = 'none';
      vReal.style.display = 'none';
      vComp.style.display = 'block';
      statusBadge.innerText = 'BLOCKOUT (L) VS SYNTHESIS (R)';
      statusBadge.style.color = '#f59e0b';
      lensBadge.innerText = '50/50 SPLIT';
      vComp.currentTime = currentTime;
      if (isPlaying && vComp.paused) vComp.play();
    }
  }

  // -------------------------------------------------------------
  // MEDIA SWITCHER
  // -------------------------------------------------------------
  function switchMedia(key) {
    currentTargetKey = key;
    document.querySelectorAll('.media-thumb-btn').forEach(b => b.classList.remove('active'));

    if (key === 'breakdancer') {
      document.getElementById('btnMedia1').classList.add('active');
      cardMesh.geometry.dispose();
      cardMesh.geometry = new THREE.PlaneGeometry(1.6, 1.6);
      frameMesh.geometry.dispose();
      frameMesh.geometry = new THREE.EdgesGeometry(cardMesh.geometry);
      loadCardTexture(EMBEDDED_ASSETS.breakdancer);
      duration = 15.0;
      document.getElementById('durationVal').innerText = duration.toFixed(1) + 's';
      setDirectorMode('frustum');
    } else if (key === 'carving') {
      document.getElementById('btnMedia2').classList.add('active');
      cardMesh.geometry.dispose();
      cardMesh.geometry = new THREE.PlaneGeometry(1.6, 1.6);
      frameMesh.geometry.dispose();
      frameMesh.geometry = new THREE.EdgesGeometry(cardMesh.geometry);
      loadCardTexture(EMBEDDED_ASSETS.carving);
      duration = 15.0;
      document.getElementById('durationVal').innerText = duration.toFixed(1) + 's';
      setDirectorMode('frustum');
    } else if (key === 'plaza') {
      document.getElementById('btnMediaPlaza').classList.add('active');
      // 16:9 widescreen card
      cardMesh.geometry.dispose();
      cardMesh.geometry = new THREE.PlaneGeometry(2.4, 1.35);
      frameMesh.geometry.dispose();
      frameMesh.geometry = new THREE.EdgesGeometry(cardMesh.geometry);
      cardMat.map = getPlazaVideoTexture();
      cardMat.needsUpdate = true;
      duration = 15.0;
      document.getElementById('durationVal').innerText = '15.0s';
      // Load authentic 15s Plaza Hotel camera orbital flight
      keyframes = [
        { time: 0.0, azimuth: 0, elevation: 0, distance: 1.25 },
        { time: 0.14, azimuth: 25, elevation: 2, distance: 1.24 },
        { time: 0.28, azimuth: 50, elevation: 5, distance: 1.22 },
        { time: 0.42, azimuth: 75, elevation: 8, distance: 1.20 },
        { time: 0.57, azimuth: 100, elevation: 11, distance: 1.21 },
        { time: 0.71, azimuth: 125, elevation: 13, distance: 1.23 },
        { time: 0.85, azimuth: 152, elevation: 14, distance: 1.25 },
        { time: 1.0, azimuth: 180, elevation: 15, distance: 1.25 }
      ];
      activeKfIndex = 0;
      currentTime = 0;
      renderTimelineKeyframeMarkers();
      updateKeyframeSpheresIn3D();
      renderCameraAtTime(0);
      updatePlayheadUI();
      // Default to real video in Director Viewfinder!
      setDirectorMode('realVideo');
    } else {
      document.getElementById('btnMedia3').classList.add('active');
      cardMesh.geometry.dispose();
      cardMesh.geometry = new THREE.PlaneGeometry(1.6, 1.6);
      frameMesh.geometry.dispose();
      frameMesh.geometry = new THREE.EdgesGeometry(cardMesh.geometry);
      loadCardTexture('');
      setDirectorMode('frustum');
    }
    updateBehindTheScenesData();
  }`;

if (html.includes(oldSwitchMedia)) {
  html = html.replace(oldSwitchMedia, newSwitchMedia);
  console.log('Updated switchMedia and added setDirectorMode');
} else {
  console.log('Warning: oldSwitchMedia not found');
}

// 5. Update updateBehindTheScenesData prompt and JSON
const oldBehindScenes = `  function updateBehindTheScenesData() {
    const payload = {
      image_url: \`gs://bucket/inputs/\${currentTargetKey}_frame0.png\`,
      duration: duration,
      resolution: "720P",
      camera_trajectory: keyframes.map(kf => ({
        time: kf.time,
        azimuth: kf.azimuth,
        elevation: kf.elevation,
        distance: kf.distance
      }))
    };
    document.getElementById('payloadJson').innerText = JSON.stringify(payload, null, 2);

    const startKf = keyframes[0];
    const endKf = keyframes[keyframes.length - 1];
    const azDelta = endKf.azimuth - startKf.azimuth;
    const elDelta = endKf.elevation - startKf.elevation;

    let motion = "orbital rotational move";
    if (Math.abs(azDelta) >= 180) motion = "continuous 360-degree orbital sweep";
    else if (Math.abs(elDelta) > 30) motion = "vertical crane elevation move";
    else if (Math.abs(startKf.distance - endKf.distance) > 0.6) motion = "cinematic axial push-in";

    const prompt = \`"The same elements in the reference are rigid. Preserve every element exactly. \` +
      \`The entire scene is frozen. Only the camera moves. \` +
      \`A smooth \${motion} lasting \${duration}s \` +
      \`starting at azimuth \${startKf.azimuth}°, elevation \${startKf.elevation}° and ending at azimuth \${endKf.azimuth}°, elevation \${endKf.elevation}°. \` +
      \`Zero scene motion, pure camera motion."\`;

    document.getElementById('synthesizedPrompt').innerText = prompt;
  }`;

const newBehindScenes = `  function updateBehindTheScenesData() {
    let imageUrl = \`gs://scratchbox-assets/inputs/\${currentTargetKey}_frame0.png\`;
    if (currentTargetKey === 'plaza') {
      imageUrl = "public/videos/plaza_hotel_omni_15s_720p.mp4 (4K UHD 24fps Asset)";
    }

    const payload = {
      image_url: imageUrl,
      duration: duration,
      resolution: "720P",
      camera_trajectory: keyframes.map(kf => ({
        time: kf.time,
        azimuth: kf.azimuth,
        elevation: kf.elevation,
        distance: kf.distance
      }))
    };
    document.getElementById('payloadJson').innerText = JSON.stringify(payload, null, 2);

    const startKf = keyframes[0];
    const endKf = keyframes[keyframes.length - 1];
    const azDelta = endKf.azimuth - startKf.azimuth;
    const elDelta = endKf.elevation - startKf.elevation;

    let motion = "orbital rotational move";
    if (Math.abs(azDelta) >= 170) motion = "continuous orbital survey sweep";
    else if (Math.abs(elDelta) > 30) motion = "vertical crane elevation move";
    else if (Math.abs(startKf.distance - endKf.distance) > 0.6) motion = "cinematic axial push-in";

    let prompt = "";
    if (currentTargetKey === 'plaza') {
      prompt = \`"The architectural details of the Plaza Hotel mansard roof, dormer windows, and Beaux-Arts copper cupola remain completely rigid. Preserve every facade carving and copper patina texture exactly. The entire scene is frozen. Only the camera moves. A smooth \${motion} lasting \${duration}s starting at azimuth \${startKf.azimuth}°, elevation \${startKf.elevation}° and ending at azimuth \${endKf.azimuth}°, elevation \${endKf.elevation}°. Zero scene distortion, authentic architectural parallax."\`;
    } else {
      prompt = \`"The same elements in the reference are rigid. Preserve every element exactly. \` +
        \`The entire scene is frozen. Only the camera moves. \` +
        \`A smooth \${motion} lasting \${duration}s \` +
        \`starting at azimuth \${startKf.azimuth}°, elevation \${startKf.elevation}° and ending at azimuth \${endKf.azimuth}°, elevation \${endKf.elevation}°. \` +
        \`Zero scene motion, pure camera motion."\`;
    }

    document.getElementById('synthesizedPrompt').innerText = prompt;
  }`;

if (html.includes(oldBehindScenes)) {
  html = html.replace(oldBehindScenes, newBehindScenes);
  console.log('Updated updateBehindTheScenesData');
} else {
  console.log('Warning: oldBehindScenes not found');
}

// 6. Update scrubbing and toggle playback for video sync
const oldTogglePlayback = `  function togglePlayback() {
    isPlaying = !isPlaying;
    document.getElementById('btnPlay').innerText = isPlaying ? '❚❚' : '▶';
  }`;

const newTogglePlayback = `  function togglePlayback() {
    isPlaying = !isPlaying;
    document.getElementById('btnPlay').innerText = isPlaying ? '❚❚' : '▶';
    if (!isPlaying) {
      if (realVideoEl) realVideoEl.pause();
      if (compVideoEl) compVideoEl.pause();
    } else {
      if (currentTargetKey === 'plaza') {
        realVideoEl.play();
        if (directorMode === 'comparison') compVideoEl.play();
      }
    }
  }`;

if (html.includes(oldTogglePlayback)) {
  html = html.replace(oldTogglePlayback, newTogglePlayback);
  console.log('Updated togglePlayback');
}

const oldTriggerRender = `  function triggerRenderPreview() {
    // Play full animation preview
    currentTime = 0;
    isPlaying = true;
    document.getElementById('btnPlay').innerText = '❚❚';
  }`;

const newTriggerRender = `  function triggerRenderPreview() {
    currentTime = 0;
    isPlaying = true;
    document.getElementById('btnPlay').innerText = '❚❚';
    if (currentTargetKey === 'plaza') {
      realVideoEl.currentTime = 0;
      compVideoEl.currentTime = 0;
      realVideoEl.play();
      if (directorMode === 'comparison') compVideoEl.play();
    }
  }`;

if (html.includes(oldTriggerRender)) {
  html = html.replace(oldTriggerRender, newTriggerRender);
  console.log('Updated triggerRenderPreview');
}

// 7. Update animate loop and scrubTimeline
const oldScrubTimeline = `  function scrubTimeline(e) {
    const rect = document.getElementById('timelineTrack').getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    currentTime = ratio * duration;
    updatePlayheadUI();
    renderCameraAtTime(currentTime);
  }`;

const newScrubTimeline = `  function scrubTimeline(e) {
    const rect = document.getElementById('timelineTrack').getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    currentTime = ratio * duration;
    if (realVideoEl) realVideoEl.currentTime = currentTime;
    if (compVideoEl) compVideoEl.currentTime = currentTime;
    updatePlayheadUI();
    renderCameraAtTime(currentTime);
  }`;

if (html.includes(oldScrubTimeline)) {
  html = html.replace(oldScrubTimeline, newScrubTimeline);
  console.log('Updated scrubTimeline');
}

const oldAnimateLoop = `    if (isPlaying) {
      currentTime += dt;
      if (currentTime >= duration) {
        currentTime = 0;
        isPlaying = false;
        document.getElementById('btnPlay').innerText = '▶';
      }
      updatePlayheadUI();
      renderCameraAtTime(currentTime);
    }`;

const newAnimateLoop = `    if (isPlaying) {
      if (currentTargetKey === 'plaza' && realVideoEl && !isNaN(realVideoEl.duration)) {
        if (realVideoEl.paused) realVideoEl.play();
        if (compVideoEl && compVideoEl.paused && directorMode === 'comparison') compVideoEl.play();
        currentTime = realVideoEl.currentTime;
        if (currentTime >= duration || realVideoEl.ended) {
          currentTime = 0;
          realVideoEl.currentTime = 0;
          if (compVideoEl) compVideoEl.currentTime = 0;
          isPlaying = false;
          realVideoEl.pause();
          if (compVideoEl) compVideoEl.pause();
          document.getElementById('btnPlay').innerText = '▶';
        }
      } else {
        currentTime += dt;
        if (currentTime >= duration) {
          currentTime = 0;
          isPlaying = false;
          document.getElementById('btnPlay').innerText = '▶';
        }
      }
      updatePlayheadUI();
      renderCameraAtTime(currentTime);
    }`;

if (html.includes(oldAnimateLoop)) {
  html = html.replace(oldAnimateLoop, newAnimateLoop);
  console.log('Updated animate loop');
}

fs.writeFileSync('public/camera_choreography_studio.html', html, 'utf8');
console.log('Successfully written updated public/camera_choreography_studio.html!');
