const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = 9333;
const SERVER_URL = 'http://127.0.0.1:5173/demos/showcase/image_to_adaptive_pbr_studio.html';
const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/fac2f623-5141-4d1e-80a3-cbffcf054542';
const OUTPUT_DIR = path.resolve(__dirname, '../public/test_output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
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
  console.log('[PBR Studio Capture] Launching Headless Chrome on CDP port ' + CDP_PORT);
  const tmpDir = fs.mkdtempSync('/tmp/chrome_pbr_studio_cdp_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1680,1050',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 40; i++) {
    try {
      await sleep(250);
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

  console.log('[PBR Studio Capture] Connected to Chrome DevTools WebSocket: ' + targetWs);
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

  console.log(`[PBR Studio Capture] Navigating to ${SERVER_URL}...`);
  await sendCdp('Page.navigate', { url: SERVER_URL });

  // Wait for Three.js scene and mesh to initialize
  await sleep(3000);

  async function takeProofShot(filename, description) {
    console.log(`  -> Capturing: ${filename} (${description})...`);
    await sleep(600); // Flush render buffer
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shotRes.data, 'base64');

    const outPath1 = path.join(OUTPUT_DIR, filename);
    const outPath2 = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath1, pngBuf);
    fs.writeFileSync(outPath2, pngBuf);

    console.log(`     ✅ Saved to ${outPath1} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return outPath1;
  }

  // 1. Initial Textured PBR View (Travertine with deep relief & local Retinex)
  await takeProofShot('proof_pbr_textured_relief.png', 'Full PBR Textured Mode with Metric Height Displacement');

  // 2. Seamless Toroidal Tiling & 2.0x UV Repeat
  await sendCdp('Runtime.evaluate', { expression: `toggleSeamlessTiling(); updateUvRepeat(2.0);` });
  await sleep(1000);
  await takeProofShot('proof_pbr_seamless_tiling_2x.png', 'Toroidal Seamless Boundary Feathering & 2x Repeat');

  // 3. 18% Studio Grey Clay Mode (ADA Universal Invariant)
  await sendCdp('Runtime.evaluate', { expression: `setRenderMode('clay');` });
  await sleep(1000);
  await takeProofShot('proof_pbr_18pct_studio_grey_clay.png', '18% Studio Grey Clay Mode (roughness: 0.85, metalness: 0.0)');

  // 4. Wireframe Inspection Mode (Subdivided Metric Mesh)
  await sendCdp('Runtime.evaluate', { expression: `toggleWireframe();` });
  await sleep(1000);
  await takeProofShot('proof_pbr_clay_wireframe_mesh.png', 'Continuous Metric Displacement Wireframe Mesh (65,536 Vertices)');

  // 5. Demo Panel Catalog / Gallery Verification
  console.log('[PBR Studio Capture] Navigating to http://127.0.0.1:5173/demos/index.html...');
  await sendCdp('Page.navigate', { url: 'http://127.0.0.1:5173/demos/index.html' });
  await sleep(2000);
  await takeProofShot('proof_demo_panel_catalog.png', 'Scratchbox Studio Demos Showcase Panel with Adaptive Image-to-PBR Card');

  ws.close();
  chromeProc.kill('SIGKILL');
  console.log('[PBR Studio Capture] All proofs captured successfully!');
}

main().catch(err => {
  console.error('[PBR Studio Capture] Error:', err);
  process.exit(1);
});
