const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = 9444;
const SERVER_PORT = 5198;
const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/2068ebed-7c21-4ac9-ad0f-ec6efa2d7818';
const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('======================================================================');
  console.log('  SCRATCHBOX IDE - DEMO EXECUTION & PROOF HARNESS');
  console.log('======================================================================');

  // 1. Launch HTTP Server on SERVER_PORT
  console.log(`[1/5] Launching HTTP static server on port ${SERVER_PORT}...`);
  const serverProc = spawn('node', [path.resolve(__dirname, 'serve_public.js'), String(SERVER_PORT)], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: 'ignore'
  });

  // Wait for server to respond
  let serverReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({
          host: '127.0.0.1',
          port: SERVER_PORT,
          path: '/hyperreal_map_tile_group_demo.html',
          timeout: 1000
        }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) {
        serverReady = true;
        console.log(`      Server confirmed online and serving /hyperreal_map_tile_group_demo.html`);
        break;
      }
    } catch {}
  }

  if (!serverReady) {
    if (serverProc) serverProc.kill('SIGKILL');
    throw new Error(`Failed to initialize HTTP server on port ${SERVER_PORT}`);
  }

  // 2. Launch Headless Chrome with WebGL
  console.log(`[2/5] Launching Headless Google Chrome on CDP port ${CDP_PORT}...`);
  const tmpUserDataDir = fs.mkdtempSync('/tmp/chrome_demo_exec_cdp_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpUserDataDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }

  if (!targetWs) {
    chromeProc.kill('SIGKILL');
    serverProc.kill('SIGKILL');
    throw new Error(`Could not establish CDP connection to Chrome on port ${CDP_PORT}`);
  }

  console.log(`      Connected to Chrome WebSocket: ${targetWs}`);
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

  async function takeScreenshot(filename, label) {
    console.log(`      Capturing [${label}] -> ${filename}`);
    await sleep(800); // Allow render buffer to flush
    const res = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf = Buffer.from(res.data, 'base64');
    const path1 = path.join(SCREENSHOTS_DIR, filename);
    const path2 = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(path1, buf);
    fs.writeFileSync(path2, buf);
    console.log(`      Saved (${(buf.length / 1024).toFixed(1)} KB)`);
    return path2;
  }

  // 3. Execute Hyperreal 3D Map Tile Group Demo
  console.log(`[3/5] Executing Hyperreal 3D Map Tile Group Inspection Demo...`);
  const demoUrl = `http://127.0.0.1:${SERVER_PORT}/hyperreal_map_tile_group_demo.html`;
  await sendCdp('Page.navigate', { url: demoUrl });

  // Wait for initial PBR model to load into Three.js
  await sleep(4000);

  // Check console / telemetry from the page
  const evalTelemetry = await sendCdp('Runtime.evaluate', {
    expression: `JSON.stringify({
      currentMode,
      loadedModels: Object.keys(loadedModels).filter(k => !!loadedModels[k]),
      canvasWidth: window.innerWidth,
      canvasHeight: window.innerHeight,
      threeMeshes: rootGroup ? rootGroup.children.length : 0
    })`,
    returnByValue: true
  });
  console.log(`      Telemetry: ${evalTelemetry?.result?.value}`);

  // Screenshot 1: Hyperreal PBR Digital Twin Mode
  await takeScreenshot('proof_hyperreal_pbr_twin.png', 'Mode 1: Hyperreal PBR Digital Twin');

  // Screenshot 2: 18% Studio Grey Clay Mode
  console.log('      Switching to 18% Studio Grey Clay Mode...');
  await sendCdp('Runtime.evaluate', { expression: `switchMode('clay');` });
  await sleep(2000);
  await takeScreenshot('proof_hyperreal_studio_grey_clay.png', 'Mode 2: 18% Studio Grey Clay (ADA Manhattan 4-RoSy)');

  // Screenshot 3: Raw Google 3D Tile Mode
  console.log('      Switching to Raw Google 3D Tile Mode...');
  await sendCdp('Runtime.evaluate', { expression: `switchMode('raw');` });
  await sleep(2000);
  await takeScreenshot('proof_hyperreal_raw_baseline.png', 'Mode 3: Raw Google 3D Tile Baseline');

  // Screenshot 4: Dynamic Solar Ephemeris & Lighting
  console.log('      Switching back to PBR & adjusting sun to low 18° golden hour...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      switchMode('pbr');
      document.getElementById('slider-altitude').value = '18';
      document.getElementById('slider-azimuth').value = '225';
      document.getElementById('slider-intensity').value = '2.8';
      updateSun();
    `
  });
  await sleep(2000);
  await takeScreenshot('proof_hyperreal_golden_hour_shadows.png', 'Dynamic Solar Ephemeris: 18° Low Sun with De-lighted Shadows');

  // 4. Execute SB-Veggie Demo
  console.log(`[4/5] Executing SB-Veggie Real Photogrammetry Inversion Demo...`);
  const veggieUrl = `http://127.0.0.1:${SERVER_PORT}/sb_veggie_real_demo.html`;
  await sendCdp('Page.navigate', { url: veggieUrl });

  // Wait for models to load
  await sleep(4000);

  // Check SB-Veggie telemetry
  const evalVeggie = await sendCdp('Runtime.evaluate', {
    expression: `JSON.stringify({
      currentMode: window.currentModeKey || 'side',
      canvas: !!document.getElementById('webgl-canvas')
    })`,
    returnByValue: true
  });
  console.log(`      SB-Veggie Telemetry: ${evalVeggie?.result?.value}`);

  // Screenshot 5: SB-Veggie Side-by-Side (Scan vs Fitted Tree)
  await takeScreenshot('proof_sb_veggie_side_by_side.png', 'SB-Veggie: Raw Scan Blob vs Fitted Hardwood Side-by-Side');

  // Screenshot 6: SB-Veggie Ghost Alignment Overlay
  console.log('      Switching SB-Veggie to Ghost Alignment Proof...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      const btn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.textContent.includes('Ghost'));
      if (btn) btn.click();
    `
  });
  await sleep(2500);
  await takeScreenshot('proof_sb_veggie_ghost_alignment.png', 'SB-Veggie: Ghost Scan Contour Alignment Overlay');

  // 5. Clean Teardown
  console.log(`[5/5] Cleaning up processes...`);
  ws.close();
  chromeProc.kill('SIGKILL');
  serverProc.kill('SIGKILL');

  console.log('======================================================================');
  console.log('  ALL DEMOS EXECUTED & PROOFS CAPTURED SUCCESSFULLY!');
  console.log('======================================================================');
}

main().catch(err => {
  console.error('Fatal Demo Execution Error:', err);
  process.exit(1);
});
