const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9550 + Math.floor(Math.random() * 300);
const SERVER_PORT = 5300 + Math.floor(Math.random() * 300);
const DEMO_URL = `http://127.0.0.1:${SERVER_PORT}/omnispatial_synthesis_demo.html`;

const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('[Colosseum Demo Capture] Starting capture sequence on port ' + SERVER_PORT + '...');

  // Start HTTP server
  console.log('[Colosseum Demo Capture] Launching scripts/serve_public.js on port ' + SERVER_PORT + '...');
  const serverProc = spawn('node', ['scripts/serve_public.js', String(SERVER_PORT)], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: 'inherit'
  });

  let serverRunning = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const ok = await new Promise((resolve, reject) => {
        const req = http.get({
          host: '127.0.0.1',
          port: SERVER_PORT,
          path: '/omnispatial_synthesis_demo.html',
          timeout: 1500
        }, (r) => {
          resolve(r.statusCode === 200);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (ok) {
        console.log('[Colosseum Demo Capture] Server ready on port ' + SERVER_PORT);
        serverRunning = true;
        break;
      }
    } catch (err) {
      if (i > 30) console.log('[Colosseum Demo Capture] Poll retry (' + i + '):', err.message);
    }
  }

  if (!serverRunning) {
    if (serverProc) serverProc.kill('SIGKILL');
    throw new Error(`Failed to start server on port ${SERVER_PORT}`);
  }

  // Launch Google Chrome headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_colosseum_demo_cdp_');
  console.log('[Colosseum Demo Capture] Launching Google Chrome headless with CDP port ' + CDP_PORT + ' and user data dir: ' + tmpDir);
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('ERROR') || msg.includes('DevTools')) {
      console.log('[Chrome STDERR]', msg.trim());
    }
  });

  let targetWs = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {
      if (i > 60) console.log('[Chrome Poll Retry]', e.message);
    }
  }

  if (!targetWs) {
    chromeProc.kill('SIGKILL');
    serverProc.kill('SIGKILL');
    throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
  }

  console.log('[Colosseum Demo Capture] Connected to Chrome DevTools WebSocket: ' + targetWs);
  const ws = new WebSocket(targetWs);

  let idCounter = 1;
  function sendCdp(method, params = {}) {
    return new Promise((resolve) => {
      const msgId = idCounter++;
      const handler = (data) => {
        const msg = JSON.parse(data);
        if (msg.id === msgId) {
          ws.off('message', handler);
          resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await new Promise(r => ws.on('open', r));
  await sendCdp('Page.enable');
  await sendCdp('Runtime.enable');

  async function takeProofShot(filename, description) {
    console.log(`  -> Capturing: ${filename} (${description})...`);
    await sleep(800);
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shotRes.data, 'base64');

    const outPath1 = path.join(OUTPUT_DIR, filename);
    const outPath2 = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath1, pngBuf);
    fs.writeFileSync(outPath2, pngBuf);

    console.log(`     ✅ Saved: ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return outPath2;
  }

  try {
    // 1. Navigate to Omnispatial Multi-Sensor Synthesis Demo
    console.log(`[Colosseum Demo Capture] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    await sleep(3000);

    // 2. Load Colosseum, Rome via prompt execution
    console.log('[Colosseum Demo Capture] Executing prompt: "Colosseum, Rome"...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        loadLocation('Colosseum, Rome');
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
      `
    });
    await sleep(2000);

    // 2b. Extract clean 3D renders from <model-viewer> for each stage via CDP
    console.log('[Colosseum Demo Capture] Generating clean renders for Stages 1, 2, 3 in 3D orbit...');

    async function captureCleanStageRender(stage, filename) {
      console.log(`[Colosseum Demo Capture] Capturing clean render for Stage ${stage}...`);
      await sendCdp('Runtime.evaluate', {
        expression: `
          new Promise((resolve) => {
            const mv = document.getElementById('mainModelViewer');
            if (!mv) return resolve('no-mv');
            mv.removeAttribute('poster');

            setViewMode('orbit-3d');
            selectStage(${stage});
            
            mv.removeAttribute('auto-rotate');
            mv.setAttribute('camera-orbit', '35deg 62deg 520m');
            mv.setAttribute('camera-target', '0m 0m 0m');
            mv.setAttribute('field-of-view', '30deg');

            const hideIds = ['.app-header', '.hud-left', '.hud-right', '.playback-dock', '.model-viewer-badge', '.orbit-model-switcher', '.orbit-tip-pill'];
            hideIds.forEach(sel => {
              const el = document.querySelector(sel);
              if (el) el.style.visibility = 'hidden';
            });

            if (mv.loaded) {
              setTimeout(() => resolve('already-loaded'), 2500);
            } else {
              mv.addEventListener('load', () => setTimeout(() => resolve('loaded'), 2500), { once: true });
              setTimeout(() => resolve('timeout'), 12000);
            }
          });
        `,
        awaitPromise: true
      });
      await sleep(2500); // Allow WebGL frames to settle
      const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
      const pngBuf = Buffer.from(shot.data, 'base64');
      const outPath = path.resolve(__dirname, '../public/renders/colosseum', filename);
      fs.writeFileSync(outPath, pngBuf);
      console.log(`     ✅ Clean stage render saved: ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);

      // Restore UI elements
      await sendCdp('Runtime.evaluate', {
        expression: `
          const showIds = ['.app-header', '.hud-left', '.hud-right', '.playback-dock', '.model-viewer-badge', '.orbit-model-switcher', '.orbit-tip-pill'];
          showIds.forEach(sel => {
            const el = document.querySelector(sel);
            if (el) el.style.visibility = 'visible';
          });
        `
      });
      return true;
    }

    await captureCleanStageRender(1, 'clean_stage1_clay.png');
    await captureCleanStageRender(2, 'clean_stage2_vector.png');
    await captureCleanStageRender(3, 'clean_stage3_master.png');

    // Update locationDatasets in running page with newly generated clean renders
    await sendCdp('Runtime.evaluate', {
      expression: `
        const ts = Date.now();
        locationDatasets['colosseum'].stages[1].beauty = '/renders/colosseum/clean_stage1_clay.png?' + ts;
        locationDatasets['colosseum'].stages[1].albedo = '/renders/colosseum/clean_stage1_clay.png?' + ts;
        locationDatasets['colosseum'].stages[2].beauty = '/renders/colosseum/clean_stage2_vector.png?' + ts;
        locationDatasets['colosseum'].stages[2].albedo = '/renders/colosseum/clean_stage2_vector.png?' + ts;
        locationDatasets['colosseum'].stages[3].beauty = '/renders/colosseum/clean_stage3_master.png?' + ts;
        locationDatasets['colosseum'].stages[3].albedo = '/renders/colosseum/clean_stage3_master.png?' + ts;
        stageImages = locationDatasets['colosseum'].stages;
        setViewMode('side-by-side');
        document.getElementById('imgLeft').src = '/renders/colosseum/clean_stage1_clay.png?' + ts;
        document.getElementById('imgRight').src = '/renders/colosseum/clean_stage3_master.png?' + ts;
        selectStage(3);
      `
    });
    await sleep(1500);

    // Screenshot 1: Dual Split View (Stage 1 Raw Scan vs Stage 3 De-Lighted Travertine PBR & Umbrella Pines)
    await takeProofShot(
      'colosseum_demo_app_dual_split.png',
      'App Interface: Dual Split View showing Raw Google 3D Tile vs Stage 3 De-Lighted Travertine PBR'
    );

    // Screenshot 2: Stage 2 Grounded Ruin & Vector Reshaping
    console.log('[Colosseum Demo Capture] Switching to Stage 2: Grounded Ruin & Vector Reshaping...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        selectStage(2);
      `
    });
    await sleep(1500);
    await takeProofShot(
      'colosseum_demo_app_stage2_reshaping.png',
      'App Interface: Stage 2 Hollow Ambulatory Arches and Preserved Historical Ruin Fracture'
    );

    // Screenshot 3: Interactive Wipe Slider View
    console.log('[Colosseum Demo Capture] Switching to Wipe Slider Mode...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('wipe');
        selectStage(3);
        const wipe = document.getElementById('wipeReveal');
        if (wipe) wipe.style.width = '48%';
        const imgWipeReveal = document.getElementById('imgWipeReveal');
        if (imgWipeReveal) imgWipeReveal.src = '/renders/colosseum/clean_stage1_clay.png';
        const imgWipeBase = document.getElementById('imgWipeBase');
        if (imgWipeBase) imgWipeBase.src = '/renders/colosseum/clean_stage3_master.png';
      `
    });
    await sleep(1500);
    await takeProofShot(
      'colosseum_demo_app_wipe_slider.png',
      'App Interface: Interactive Wipe Slider comparing Photogrammetric Scan with De-Lighted PBR'
    );

    // Screenshot 4: Macro Detail Loupe View
    console.log('[Colosseum Demo Capture] Switching to Macro Detail Loupe View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('loupe');
        const imgLoupeBase = document.getElementById('imgLoupeBase');
        if (imgLoupeBase) imgLoupeBase.src = '/renders/colosseum/clean_stage3_master.png';
        const loupeGlass = document.getElementById('loupeGlass');
        if (loupeGlass) {
          loupeGlass.style.display = 'block';
          loupeGlass.style.left = '960px';
          loupeGlass.style.top = '480px';
          loupeGlass.style.backgroundImage = 'url(/renders/colosseum/clean_stage3_master.png)';
          loupeGlass.style.backgroundSize = '3840px 2160px';
          loupeGlass.style.backgroundPosition = '-1920px -1080px';
        }
      `
    });
    await sleep(1500);
    await takeProofShot(
      'colosseum_demo_app_detail_loupe.png',
      'App Interface: 2.5x Macro Detail Loupe inspecting De-Lighted Travertine and Ashlar Relief'
    );

    // Screenshot 5: 3D Free Orbit Mode (<model-viewer> with authentic .glb)
    console.log('[Colosseum Demo Capture] Switching to 3D Free Orbit Mode...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('orbit-3d');
        switchOrbitModel(3);
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.cameraOrbit = '-45deg 42deg 540m';
          mv.cameraTarget = '40m 20m 0m';
        }
      `
    });
    console.log('  -> Waiting for <model-viewer> load and render frames...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        new Promise((resolve) => {
          const mv = document.getElementById('mainModelViewer');
          if (!mv) return resolve('no-mv');
          if (mv.loaded) return resolve('already-loaded');
          mv.addEventListener('load', () => resolve('loaded'), { once: true });
          setTimeout(() => resolve('timeout'), 20000);
        });
      `,
      awaitPromise: true
    });
    await sleep(5000); // Allow WebGL frames and PBR materials to settle
    await takeProofShot(
      'colosseum_demo_app_3d_orbit.png',
      'App Interface: 3D Free Orbit Mode with Google model-viewer rendering Colosseum PBR GLB'
    );

    // Screenshot 5b: Ground-Level Human Vantage (Northern Facade & Curtain Wall Fix Verification)
    console.log('[Colosseum Demo Capture] Positioning camera at Ground-Level Northern Facade vantage...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '25deg 78deg 280m');
          mv.setAttribute('camera-target', '50m 25m -120m');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeProofShot(
      'colosseum_proof_ground_facade_curtain_wall_fix.png',
      'App Interface: Ground-Level verification showing intact Via Nicola Salvi building facade and eliminated curtain walls'
    );

    // Screenshot 5c: Orthographic Top-Down Plan View (Perimeter Boundary & Parco del Celio Coverage)
    console.log('[Colosseum Demo Capture] Positioning camera at Orthographic Top-Down Plan View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '0deg 5deg 620m');
          mv.setAttribute('camera-target', '16m 20m -21m');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeProofShot(
      'colosseum_proof_orthographic_plan_celio_coverage.png',
      'App Interface: Orthographic top-down plan showing clean circular perimeter boundary and complete Parco del Celio canopy coverage'
    );

    // Screenshot 6: 3D Stage 2 Vector & Botanical Clay Mode
    console.log('[Colosseum Demo Capture] Switching to 3D Stage 2 Clay Model...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        switchOrbitModel(2);
      `
    });
    await sleep(4000);
    await takeProofShot(
      'colosseum_demo_app_3d_orbit_stage2.png',
      'App Interface: 3D Free Orbit Mode rendering Stage 2 Clay Vitruvian Architecture and Botanical Stands'
    );

    console.log('[Colosseum Demo Capture] All screenshots captured successfully!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    serverProc.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error('[Colosseum Demo Capture] Error:', err);
  process.exit(1);
});
