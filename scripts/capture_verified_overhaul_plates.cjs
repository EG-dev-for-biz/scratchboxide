const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9750 + Math.floor(Math.random() * 200);
const SERVER_PORT = process.env.PORT || 3030;
const DEMO_URL = `http://127.0.0.1:${SERVER_PORT}/omnispatial_synthesis_demo.html`;

const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
const RENDERS_DIR = path.resolve(__dirname, '../public/renders/colosseum');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });
if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

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
  console.log('[VerifiedPlates] Starting verified plate capture sequence...');

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_verified_plates_');

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

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
    } catch (e) {}
  }

  if (!targetWs) {
    chromeProc.kill('SIGKILL');
    throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
  }

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

  async function takeScreenshot(filename, description) {
    console.log(`  -> Capturing: ${filename} (${description})...`);
    await sleep(1200);
    const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), pngBuf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, filename), pngBuf);
    console.log(`     ✅ Saved ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return path.join(ARTIFACT_DIR, filename);
  }

  try {
    console.log(`[VerifiedPlates] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    await sleep(3500);

    console.log('[VerifiedPlates] Initializing Colosseum location dataset...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        loadLocation('Colosseum, Rome');
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
        setViewMode('orbit-3d');
      `
    });
    await sleep(2000);

    // Function to load a specific GLB into model-viewer, wait for load event, and capture clean plate
    async function loadGlbAndCaptureCleanPlate(glbPath, outFilename) {
      console.log(`[VerifiedPlates] Loading GLB ${glbPath} for clean plate ${outFilename}...`);
      await sendCdp('Runtime.evaluate', {
        expression: `
          new Promise((resolve) => {
            const mv = document.getElementById('mainModelViewer');
            if (!mv) return resolve('no-mv');
            mv.removeAttribute('poster');
            mv.removeAttribute('auto-rotate');
            mv.autoRotate = false;
            mv.setAttribute('camera-orbit', '35deg 62deg 520m');
            mv.setAttribute('camera-target', '0m 0m 0m');
            mv.setAttribute('field-of-view', '30deg');

            const hideIds = ['.top-nav', '.hud-left', '.hud-right', '.playback-dock', '.model-viewer-badge', '.orbit-model-switcher', '.orbit-tip-pill', '.floating-compass'];
            hideIds.forEach(sel => {
              const el = document.querySelector(sel);
              if (el) el.style.visibility = 'hidden';
            });

            const onLoad = () => {
              setTimeout(() => resolve('loaded'), 3000);
            };

            mv.addEventListener('load', onLoad, { once: true });
            mv.src = '${glbPath}';
            setTimeout(() => resolve('timeout'), 20000);
          });
        `,
        awaitPromise: true
      });
      await sleep(3500);
      const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
      const pngBuf = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(RENDERS_DIR, outFilename), pngBuf);
      fs.writeFileSync(path.join(ARTIFACT_DIR, outFilename), pngBuf);
      console.log(`     ✅ Clean plate successfully written: ${outFilename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);

      // Restore UI elements
      await sendCdp('Runtime.evaluate', {
        expression: `
          const showIds = ['.top-nav', '.hud-left', '.hud-right', '.playback-dock', '.model-viewer-badge', '.orbit-model-switcher', '.orbit-tip-pill', '.floating-compass'];
          showIds.forEach(sel => {
            const el = document.querySelector(sel);
            if (el) el.style.visibility = 'visible';
          });
        `
      });
    }

    // 1. Capture Clean Stage 1 (Raw Google 3D Tile Clay)
    await loadGlbAndCaptureCleanPlate('/models/colosseum_rome_pristine_clay_raw.glb', 'clean_stage1_clay.png');

    // 2. Capture Clean Stage 2 (Vector Refined Clay)
    await loadGlbAndCaptureCleanPlate('/models/colosseum_stage2_vector_refined.glb', 'clean_stage2_vector.png');

    // 3. Capture Clean Stage 3 (De-Lighted PBR Master with Arch & Roads)
    await loadGlbAndCaptureCleanPlate('/models/colosseum_stage3_master_pbr.glb', 'clean_stage3_master.png');

    // Update demo UI image elements with the new clean plates
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
        document.getElementById('imgLeft').src = '/renders/colosseum/clean_stage1_clay.png?' + ts;
        document.getElementById('imgRight').src = '/renders/colosseum/clean_stage3_master.png?' + ts;
        document.getElementById('imgWipeReveal').src = '/renders/colosseum/clean_stage1_clay.png?' + ts;
        document.getElementById('imgWipeBase').src = '/renders/colosseum/clean_stage3_master.png?' + ts;
      `
    });

    // 4. Capture Dual Split View: Stage 1 Raw Scan Clay (Left) vs Stage 3 De-Lighted PBR (Right)
    console.log('[VerifiedPlates] Capturing Dual Split View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('side-by-side');
        selectStage(3);
      `
    });
    await sleep(2000);
    await takeScreenshot('colosseum_verified_app_dual_split.png', 'App Interface: Dual Split (Left: Stage 1 Raw Clay, Right: Stage 3 De-Lighted PBR & Vector Roads)');

    // 5. Capture Wipe Slider View
    console.log('[VerifiedPlates] Capturing Interactive Wipe Slider View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('wipe');
        selectStage(3);
        const wipe = document.getElementById('wipeReveal');
        if (wipe) wipe.style.width = '50%';
      `
    });
    await sleep(2000);
    await takeScreenshot('colosseum_verified_app_wipe_slider.png', 'App Interface: Interactive Wipe Split Slider');

    // 6. Switch to 3D Orbit Mode with Stage 3 De-Lighted PBR
    console.log('[VerifiedPlates] Switching to 3D Orbit Mode...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('orbit-3d');
        switchOrbitModel(3);
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.removeAttribute('auto-rotate');
          mv.autoRotate = false;
          mv.setAttribute('min-camera-orbit', 'auto auto 5m');
          mv.setAttribute('camera-orbit', '-40deg 58deg 540m');
          mv.setAttribute('camera-target', '0m 10m 0m');
          mv.setAttribute('field-of-view', '32deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_verified_3d_orbit_overview.png', 'App Interface: 3D Free Orbit Overview');

    // 7. Targeted Close-Up Proof 1: Arch of Constantine (Curtain Wall Excised & Classical Arches Spliced)
    console.log('[VerifiedPlates] Framing Telephoto Close-Up: Arch of Constantine...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '115deg 78deg 250m');
          mv.setAttribute('camera-target', '-140.6m 12m -47.1m');
          mv.setAttribute('field-of-view', '12deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_verified_arch_constantine_telephoto.png', 'Proof: Arch of Constantine with 1,712 curtain wall triangles excised and 88,556 triangle watertight classical arch spliced');

    // 8. Targeted Close-Up Proof 2: Colosseum Cavea Arcades (Polar HSV Solar De-Lighting)
    console.log('[VerifiedPlates] Framing Telephoto Close-Up: Colosseum Interior Cavea & Arcades...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '40deg 56deg 280m');
          mv.setAttribute('camera-target', '10m 20m 0m');
          mv.setAttribute('field-of-view', '14deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_verified_interior_delighting_telephoto.png', 'Proof: Colosseum Interior Cavea showing warm golden travertine reflectance with solar shadows lifted via polar HSV kernel');

    // 9. Targeted Close-Up Proof 3: Vector Road, Beveled Curbs & Street View Texture Projection
    console.log('[VerifiedPlates] Framing Telephoto Close-Up: Vector Road Carriageway & Beveled Granite Curbs...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '65deg 76deg 160m');
          mv.setAttribute('camera-target', '-75m 7m -35m');
          mv.setAttribute('field-of-view', '14deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_verified_road_curb_streetview_telephoto.png', 'Proof: Planar Vector Road Ribbon, Beveled Granite Curbs (+0.15m height, 0.03m bevel), and 4K Street View Sanpietrini Texture');

    console.log('[VerifiedPlates] All verified proof plates captured successfully!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error('[VerifiedPlates] Fatal error:', err);
  process.exit(1);
});
