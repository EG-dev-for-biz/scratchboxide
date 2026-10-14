const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9700 + Math.floor(Math.random() * 200);
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
  console.log('[OverhaulProof] Starting capture of de-lighting, mesh improvement & streetview proof shots...');

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_overhaul_proof_');
  console.log(`[OverhaulProof] Launching Chrome on port ${CDP_PORT}...`);

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

  console.log('[OverhaulProof] Connected to Chrome DevTools WebSocket: ' + targetWs);
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
    await sleep(1000);
    const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shot.data, 'base64');
    const out1 = path.join(OUTPUT_DIR, filename);
    const out2 = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(out1, pngBuf);
    fs.writeFileSync(out2, pngBuf);
    console.log(`     ✅ Saved ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return out2;
  }

  try {
    console.log(`[OverhaulProof] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    await sleep(3500);

    console.log('[OverhaulProof] Initializing Colosseum location dataset...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        loadLocation('Colosseum, Rome');
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
      `
    });
    await sleep(2000);

    // 1. Capture Clean Renders for Stage 1, Stage 2, and Stage 3 from <model-viewer>
    async function captureCleanStageRender(stage, filename) {
      console.log(`[OverhaulProof] Capturing clean render plate for Stage ${stage} -> ${filename}...`);
      await sendCdp('Runtime.evaluate', {
        expression: `
          new Promise((resolve) => {
            const mv = document.getElementById('mainModelViewer');
            if (!mv) return resolve('no-mv');
            mv.removeAttribute('poster');

            setViewMode('orbit-3d');
            selectStage(${stage});
            
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

            if (mv.loaded) {
              setTimeout(() => resolve('already-loaded'), 2500);
            } else {
              mv.addEventListener('load', () => setTimeout(() => resolve('loaded'), 2500), { once: true });
              setTimeout(() => resolve('timeout'), 15000);
            }
          });
        `,
        awaitPromise: true
      });
      await sleep(3000);
      const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
      const pngBuf = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(RENDERS_DIR, filename), pngBuf);
      fs.writeFileSync(path.join(ARTIFACT_DIR, filename), pngBuf);
      console.log(`     ✅ Clean plate saved: ${filename}`);

      // Restore UI
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

    await captureCleanStageRender(1, 'clean_stage1_clay.png');
    await captureCleanStageRender(2, 'clean_stage2_vector.png');
    await captureCleanStageRender(3, 'clean_stage3_master.png');

    // Update demo state with newly captured plates
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
    await sleep(2000);

    // PROOF 1: Dual Split View (Raw Clay vs Overhauled De-Lighted PBR with Vector Roads)
    await takeScreenshot('colosseum_overhaul_app_dual_split.png', 'App Interface: Dual Split showing Raw Clay vs Overhauled De-Lighted PBR');

    // PROOF 2: Interactive Wipe Slider View
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('wipe');
        selectStage(3);
        const wipe = document.getElementById('wipeReveal');
        if (wipe) wipe.style.width = '50%';
        const imgWipeReveal = document.getElementById('imgWipeReveal');
        if (imgWipeReveal) imgWipeReveal.src = '/renders/colosseum/clean_stage1_clay.png';
        const imgWipeBase = document.getElementById('imgWipeBase');
        if (imgWipeBase) imgWipeBase.src = '/renders/colosseum/clean_stage3_master.png';
      `
    });
    await sleep(2000);
    await takeScreenshot('colosseum_overhaul_app_wipe_slider.png', 'App Interface: Interactive Wipe Split');

    // PROOF 3: 3D Free Orbit Overview
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('orbit-3d');
        switchOrbitModel(3);
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.removeAttribute('auto-rotate');
          mv.autoRotate = false;
          mv.setAttribute('camera-orbit', '-40deg 58deg 540m');
          mv.setAttribute('camera-target', '0m 10m 0m');
          mv.setAttribute('field-of-view', '32deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    console.log('[OverhaulProof] Waiting for model-viewer WebGL PBR pipeline to settle...');
    await sleep(5000);
    await takeScreenshot('colosseum_overhaul_3d_orbit_overview.png', 'App Interface: 3D Free Orbit Overview with Arch, Roads, and De-Lighted Colosseum');

    // PROOF 4: Targeted Close-Up 1 - Watertight Arch of Constantine (Curtain Wall Excised & Classical Arches Spliced)
    console.log('[OverhaulProof] Framing Close-up: Arch of Constantine (Curtain wall excision proof)...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '115deg 78deg 75m');
          mv.setAttribute('camera-target', '-140.6m 12m -47.1m');
          mv.setAttribute('field-of-view', '28deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_overhaul_arch_constantine_closeup.png', 'Proof: Arch of Constantine with Curtain Wall Excised, Open Coffered Vaults & Corinthian Columns');

    // PROOF 5: Targeted Close-Up 2 - Colosseum Interior Cavea & Arcades (Solar De-Lighting Proof)
    console.log('[OverhaulProof] Framing Close-up: Colosseum Cavea Arcades (Solar De-Lighting proof)...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '40deg 55deg 220m');
          mv.setAttribute('camera-target', '10m 22m 0m');
          mv.setAttribute('field-of-view', '26deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_overhaul_interior_delighting_closeup.png', 'Proof: Colosseum Interior Cavea showing Lifted Warm Golden Travertine & Neutralized Solar Shadows');

    // PROOF 6: Targeted Close-Up 3 - Vector Road, Beveled Curbs & Street View Texture Projection
    console.log('[OverhaulProof] Framing Close-up: Vector Road & Curb (Street View Texture proof)...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '65deg 75deg 60m');
          mv.setAttribute('camera-target', '-65m 8m -35m');
          mv.setAttribute('field-of-view', '26deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_overhaul_road_curb_streetview_closeup.png', 'Proof: Planar Vector Carriageway with Beveled Granite Curbs and Street View PBR Texturing');

    // PROOF 7: Stage 2 Vector-Refined Clay Mode in 3D Orbit
    console.log('[OverhaulProof] Switching to Stage 2 Clay Model in 3D Orbit...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        switchOrbitModel(2);
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.setAttribute('camera-orbit', '-40deg 58deg 540m');
          mv.setAttribute('camera-target', '0m 10m 0m');
          mv.setAttribute('field-of-view', '32deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_overhaul_stage2_vector_clay_orbit.png', 'App Interface: Stage 2 Vector-Refined Clay Model with Excised Arch & Planar Roads');

    console.log('[OverhaulProof] All proof screenshots successfully captured!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error('[OverhaulProof] Fatal error:', err);
  process.exit(1);
});
