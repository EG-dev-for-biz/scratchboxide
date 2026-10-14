const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9810 + Math.floor(Math.random() * 150);
const SERVER_PORT = 9333;
const DEMO_URL = `http://127.0.0.1:${SERVER_PORT}/omnispatial_synthesis_demo.html`;

const RENDERS_DIR = path.resolve(__dirname, '../public/renders/colosseum');
const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

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
  console.log('[CleanPlates] Starting local HTTP static server on port 9333...');
  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${SERVER_PORT}`);
      let filePath = path.join(PUBLIC_DIR, decodeURIComponent(parsedUrl.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.glb': 'model/gltf-binary',
        '.wasm': 'application/wasm'
      };
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error: ' + err.message);
    }
  });

  await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));
  console.log(`[CleanPlates] Static server listening at http://127.0.0.1:${SERVER_PORT}`);

  console.log('[CleanPlates] Launching Chrome for clean render plates & demo verification...');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_clean_');

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
    server.close();
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
    console.log(`[CleanPlates] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    await sleep(4000);

    // Cancel all auto-advance timers so page state doesn't mutate unexpectedly
    await sendCdp('Runtime.evaluate', {
      expression: `
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
        activeLocationKey = 'colosseum';
        stageImages = locationDatasets['colosseum'].stages;
      `
    });

    // Function to render pure 3D plate with zero UI
    async function captureIsolated3DPlate(glbPath, outFilename) {
      console.log(`[CleanPlates] Capturing clean 3D plate for ${glbPath} -> ${outFilename}...`);
      
      await sendCdp('Runtime.evaluate', {
        expression: `
          // Hide all UI overlays
          document.querySelectorAll('.top-nav, .hud-panel, .bottom-hud, .model-viewer-controls-overlay').forEach(el => el.style.display = 'none');
          document.getElementById('sideBySideView').style.display = 'none';
          document.getElementById('wipeSliderView').style.display = 'none';
          document.getElementById('loupeViewerLayout').style.display = 'none';
          
          const orbitLayout = document.getElementById('orbit3dLayout');
          orbitLayout.style.display = 'block';
          orbitLayout.style.position = 'fixed';
          orbitLayout.style.inset = '0';
          orbitLayout.style.zIndex = '999999';

          const mv = document.getElementById('mainModelViewer');
          mv.removeAttribute('poster');
          mv.removeAttribute('auto-rotate');
          mv.autoRotate = false;
          mv.setAttribute('camera-orbit', '-38deg 58deg 540m');
          mv.setAttribute('camera-target', '0m 10m 0m');
          mv.setAttribute('field-of-view', '32deg');

          window.__modelLoaded = false;
          window.__loadError = false;
          mv.addEventListener('load', () => { window.__modelLoaded = true; }, { once: true });
          mv.addEventListener('error', (e) => { window.__loadError = true; }, { once: true });
          mv.src = '${glbPath}';
        `
      });

      // Poll until model load event fires
      let loaded = false;
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        const res = await sendCdp('Runtime.evaluate', {
          expression: `window.__modelLoaded === true && document.getElementById('mainModelViewer').loaded === true`,
          returnByValue: true
        });
        if (res && res.result && res.result.value === true) {
          loaded = true;
          break;
        }
      }
      console.log(`     Model load status: ${loaded ? 'LOADED' : 'TIMED_OUT'}. Waiting 4s for PBR compilation...`);
      await sleep(4000);

      const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
      const buf = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(RENDERS_DIR, outFilename), buf);
      fs.writeFileSync(path.join(ARTIFACT_DIR, outFilename), buf);
      console.log(`     ✅ Clean 3D plate saved: ${outFilename} (${(buf.length / 1024).toFixed(1)} KB)`);
    }

    // 1. Capture clean 3D master plate for Stage 3
    console.log('[CleanPlates] Re-rendering clean Stage 3 Master plate...');
    await captureIsolated3DPlate('/models/colosseum_stage3_master_pbr.glb', 'clean_stage3_master.png');

    // 2. Restore UI overlays and bind the new clean plates to datasets
    console.log('[CleanPlates] Restoring UI and updating image sources...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        document.querySelectorAll('.top-nav, .hud-panel, .bottom-hud, .model-viewer-controls-overlay').forEach(el => el.style.display = '');
        const orbitLayout = document.getElementById('orbit3dLayout');
        orbitLayout.style.position = '';
        orbitLayout.style.inset = '';
        orbitLayout.style.zIndex = '';

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
    await sleep(2000);

    // 3. Capture Dual Split Mode (Side-by-Side: Stage 1 Raw Clay vs Stage 3 De-Lighted PBR)
    console.log('[CleanPlates] Capturing Dual Split View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('side-by-side');
        selectStage(3);
      `
    });
    await sleep(2500);
    let shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    let buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_dual_split.png'), buf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_dual_split.png'), buf);
    console.log(`     ✅ Dual Split screenshot saved (${(buf.length / 1024).toFixed(1)} KB)`);

    // 4. Capture Interactive Wipe Split Mode
    console.log('[CleanPlates] Capturing Interactive Wipe Split View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('wipe');
        selectStage(3);
        const wipe = document.getElementById('wipeReveal');
        if (wipe) wipe.style.width = '50%';
      `
    });
    await sleep(2500);
    shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_wipe_slider.png'), buf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_wipe_slider.png'), buf);
    console.log(`     ✅ Wipe Split screenshot saved (${(buf.length / 1024).toFixed(1)} KB)`);

    // 5. Capture Interactive 3D Orbit Viewport Mode
    console.log('[CleanPlates] Capturing 3D Orbit Mode...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('orbit-3d');
        switchOrbitModel(3);
        const mv = document.getElementById('mainModelViewer');
        mv.setAttribute('camera-orbit', '-40deg 60deg 520m');
        mv.setAttribute('camera-target', '10m 5m -20m');
      `
    });
    await sleep(4000);
    shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_3d_orbit.png'), buf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_3d_orbit.png'), buf);
    console.log(`     ✅ 3D Orbit screenshot saved (${(buf.length / 1024).toFixed(1)} KB)`);

    // 6. Capture Targeted Close-up on the Road and Cypress Trees
    console.log('[CleanPlates] Capturing Road & Cypress close-up...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const mv = document.getElementById('mainModelViewer');
        mv.setAttribute('camera-orbit', '-12deg 75deg 210m');
        mv.setAttribute('camera-target', '-40m 10m -35m');
      `
    });
    await sleep(3500);
    shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_road_and_cypress_closeup.png'), buf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_road_and_cypress_closeup.png'), buf);
    console.log(`     ✅ Road & Cypress close-up saved (${(buf.length / 1024).toFixed(1)} KB)`);

    console.log('[CleanPlates] Complete! All plates and app screenshots successfully generated.');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error('[CleanPlates] Fatal error:', err);
  process.exit(1);
});
