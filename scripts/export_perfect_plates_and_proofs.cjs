const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9780 + Math.floor(Math.random() * 200);
const SERVER_PORT = process.env.PORT || 3030;
const DEMO_URL = `http://127.0.0.1:${SERVER_PORT}/omnispatial_synthesis_demo.html`;

const RENDERS_DIR = path.resolve(__dirname, '../public/renders/colosseum');
const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');

if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

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
  console.log('[PerfectPlates] Starting master export...');

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_perfect_');

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

  try {
    console.log(`[PerfectPlates] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    await sleep(3500);

    // Stop auto-advance timeouts
    await sendCdp('Runtime.evaluate', {
      expression: `
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
        activeLocationKey = 'colosseum';
        stageImages = locationDatasets['colosseum'].stages;
      `
    });

    // Helper: export pure WebGL frame via toDataURL
    async function exportModelViewerPlate(glbUrl, filename) {
      console.log(`[PerfectPlates] Exporting WebGL frame for ${glbUrl} -> ${filename}...`);
      const evalRes = await sendCdp('Runtime.evaluate', {
        expression: `
          new Promise((resolve) => {
            setViewMode('orbit-3d');
            const mv = document.getElementById('mainModelViewer');
            mv.removeAttribute('poster');
            mv.removeAttribute('auto-rotate');
            mv.autoRotate = false;
            mv.setAttribute('camera-orbit', '35deg 62deg 520m');
            mv.setAttribute('camera-target', '0m 0m 0m');
            mv.setAttribute('field-of-view', '30deg');

            const doExport = async () => {
              // Wait 2 seconds for PBR textures and lighting to compile
              await new Promise(r => setTimeout(r, 2500));
              try {
                const dataUrl = await mv.toDataURL('image/png');
                resolve(dataUrl);
              } catch (e) {
                resolve('error: ' + e.message);
              }
            };

            mv.addEventListener('load', doExport, { once: true });
            mv.src = '${glbUrl}';
            setTimeout(() => {
              if (mv.loaded) doExport();
              else resolve('timeout');
            }, 15000);
          });
        `,
        awaitPromise: true,
        returnByValue: true
      });

      const dataUrl = evalRes && evalRes.value;
      if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error(`Failed to export dataUrl: ${dataUrl}`);
      }

      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(base64, 'base64');

      const outRender = path.join(RENDERS_DIR, filename);
      const outArtifact = path.join(ARTIFACT_DIR, filename);
      fs.writeFileSync(outRender, buf);
      fs.writeFileSync(outArtifact, buf);
      console.log(`     ✅ Saved pure WebGL plate: ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
    }

    // 1. Export pure WebGL render plates for Stages 1, 2, and 3
    await exportModelViewerPlate('/models/colosseum_rome_pristine_clay_raw.glb', 'clean_stage1_clay.png');
    await exportModelViewerPlate('/models/colosseum_stage2_vector_refined.glb', 'clean_stage2_vector.png');
    await exportModelViewerPlate('/models/colosseum_stage3_master_pbr.glb', 'clean_stage3_master.png');

    // Update dataset paths with timestamp to bust cache
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

    async function takeScreenshot(filename, description) {
      console.log(`  -> Capturing: ${filename} (${description})...`);
      await sleep(1500);
      const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
      const pngBuf = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, filename), pngBuf);
      fs.writeFileSync(path.join(ARTIFACT_DIR, filename), pngBuf);
      console.log(`     ✅ Saved ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    }

    // 2. Capture Dual Split View: Stage 1 Raw Clay (Left) vs Stage 3 De-Lighted PBR (Right)
    console.log('[PerfectPlates] Capturing Dual Split View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('side-by-side');
        selectStage(3);
        document.getElementById('imgLeft').src = '/renders/colosseum/clean_stage1_clay.png';
        document.getElementById('imgRight').src = '/renders/colosseum/clean_stage3_master.png';
      `
    });
    await sleep(2000);
    await takeScreenshot('colosseum_master_app_dual_split.png', 'App Interface: Dual Split (Left: Stage 1 Raw Clay, Right: Stage 3 De-Lighted PBR & Vector Roads)');

    // 3. Capture Wipe Slider View
    console.log('[PerfectPlates] Capturing Interactive Wipe Slider View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('wipe');
        selectStage(3);
        const wipe = document.getElementById('wipeReveal');
        if (wipe) wipe.style.width = '48%';
        document.getElementById('imgWipeReveal').src = '/renders/colosseum/clean_stage1_clay.png';
        document.getElementById('imgWipeBase').src = '/renders/colosseum/clean_stage3_master.png';
      `
    });
    await sleep(2000);
    await takeScreenshot('colosseum_master_app_wipe_slider.png', 'App Interface: Interactive Wipe Split Slider');

    // 4. Capture 3D Free Orbit Overview
    console.log('[PerfectPlates] Capturing 3D Free Orbit Overview...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('orbit-3d');
        switchOrbitModel(3);
        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.removeAttribute('auto-rotate');
          mv.autoRotate = false;
          mv.setAttribute('camera-orbit', '-38deg 58deg 540m');
          mv.setAttribute('camera-target', '0m 10m 0m');
          mv.setAttribute('field-of-view', '32deg');
          if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
        }
      `
    });
    await sleep(4000);
    await takeScreenshot('colosseum_master_3d_orbit_overview.png', 'App Interface: 3D Free Orbit Overview');

    console.log('[PerfectPlates] All master plates successfully captured!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error('[PerfectPlates] Fatal error:', err);
  process.exit(1);
});
