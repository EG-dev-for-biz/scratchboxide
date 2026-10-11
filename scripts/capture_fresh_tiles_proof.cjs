const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Clean proxy settings for local communication
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '*';

const CDP_PORT = 9750 + Math.floor(Math.random() * 200);
const SERVER_PORT = 5400 + Math.floor(Math.random() * 200);
const DEMO_URL = `http://127.0.0.1:${SERVER_PORT}/demos/showcase/colosseum_recolor_proof.html?left=pristine_tiles&right=recipe`;

const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
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
  console.log(`[Fresh Tiles Proof Capture] Starting server on port ${SERVER_PORT}, CDP Port ${CDP_PORT}...`);

  const serverProc = spawn('node', ['scripts/serve_public.cjs'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(SERVER_PORT), NO_PROXY: '*' },
    stdio: 'inherit'
  });

  let serverRunning = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({
          host: '127.0.0.1',
          port: SERVER_PORT,
          path: '/demos/showcase/colosseum_recolor_proof.html',
          timeout: 1500
        }, (r) => resolve(r.statusCode === 200));
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) {
        console.log(`[Fresh Tiles Proof Capture] Server ready on port ${SERVER_PORT}`);
        serverRunning = true;
        break;
      }
    } catch (_) {}
  }

  if (!serverRunning) {
    if (serverProc) serverProc.kill('SIGKILL');
    throw new Error(`Failed to start server on port ${SERVER_PORT}`);
  }

  // Launch Google Chrome headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_colosseum_fresh_cdp_');
  console.log(`[Fresh Tiles Proof Capture] Launching Google Chrome headless with CDP port ${CDP_PORT}...`);
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    '--remote-allow-origins=*',
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
    serverProc.kill('SIGKILL');
    throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
  }

  console.log('[Fresh Tiles Proof Capture] Connected to Chrome DevTools WebSocket: ' + targetWs);
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

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map(a => a.value || JSON.stringify(a)).join(' ');
        if (text.includes('Error') || text.includes('load') || text.includes('GLTF') || text.includes('pristine')) {
          console.log(`[Browser Console] ${text}`);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.error(`[Browser Exception] ${msg.params.exceptionDetails.text}`);
      }
    } catch (e) {}
  });

  async function takeProofShot(filename, description) {
    console.log(`  -> Capturing: ${filename} (${description})...`);
    await sleep(1000);
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shotRes.data, 'base64');

    const outPath1 = path.join(OUTPUT_DIR, filename);
    const outPath2 = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath1, pngBuf);
    fs.writeFileSync(outPath2, pngBuf);

    console.log(`     ✅ Saved: ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return outPath2;
  }

  async function waitForLoading() {
    for (let waitSec = 0; waitSec < 35; waitSec++) {
      await sleep(1000);
      const evalRes = await sendCdp('Runtime.evaluate', {
        expression: `
          (function() {
            const l = document.getElementById('loadingLeft');
            const r = document.getElementById('loadingRight');
            return (!l || l.style.display === 'none') && (!r || r.style.display === 'none');
          })()
        `,
        returnByValue: true
      });
      if (evalRes && evalRes.result && evalRes.result.value === true) {
        console.log(`[Fresh Tiles Proof Capture] Models settled in ~${waitSec + 1}s`);
        return true;
      }
    }
    return false;
  }

  try {
    console.log(`[Fresh Tiles Proof Capture] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    await waitForLoading();
    await sleep(2000);

    // Shot 1: Fresh Tiles vs Recipe PBR (Front Exterior)
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('front');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_fresh_tiles_vs_recipe.png',
      'Dual View: Fresh Undistorted Google 3D Tiles (538K Verts) vs Recipe PBR'
    );

    // Shot 2: Full View - Fresh Undistorted Photorealistic Google 3D Tiles
    console.log('[Fresh Tiles Proof Capture] Switching to full original view...');
    await sendCdp('Runtime.evaluate', { expression: `setMode('origOnly'); setCameraPreset('front');` });
    await sleep(1500);
    await takeProofShot(
      'colosseum_proof_fresh_tiles_fullview.png',
      'Full View: Fresh Undistorted Google 3D Tiles (538K Verts, 252 Leaf Textures)'
    );

    // Shot 3: Oblique Aerial View
    console.log('[Fresh Tiles Proof Capture] Switching to aerial preset...');
    await sendCdp('Runtime.evaluate', { expression: `setMode('sideBySide'); setCameraPreset('aerial');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_fresh_tiles_aerial.png',
      'Oblique Aerial: Fresh Leaf LOD Mesh Footprint & Proportions'
    );

    // Shot 4: Switch Left to Fresh Clay (Dual View)
    console.log('[Fresh Tiles Proof Capture] Switching Left to Fresh Studio Grey Clay...');
    await sendCdp('Runtime.evaluate', { expression: `switchLeftModel('pristine_clay');` });
    await waitForLoading();
    await sleep(1500);
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('front');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_fresh_clay_vs_recipe.png',
      'Dual View: Fresh 18% Studio Grey Clay vs Recipe PBR'
    );

    // Shot 5: Full View - Fresh Studio Grey Clay
    console.log('[Fresh Tiles Proof Capture] Switching Left Clay to full view...');
    await sendCdp('Runtime.evaluate', { expression: `setMode('origOnly'); setCameraPreset('front');` });
    await sleep(1500);
    await takeProofShot(
      'colosseum_proof_fresh_clay_fullview.png',
      'Full View: Fresh 18% Studio Grey Clay (538K Verts, Vitruvian Proportions)'
    );

    // Shot 6: Arch Vault Close-up with Fresh Clay
    console.log('[Fresh Tiles Proof Capture] Switching to arch preset with Fresh Clay...');
    await sendCdp('Runtime.evaluate', { expression: `setMode('sideBySide'); setCameraPreset('arch');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_fresh_clay_arch.png',
      'Arch Vault Inspection: Fresh Clay Anatomical Form'
    );

    console.log('\n========================================================================');
    console.log('✅ All Fresh Google 3D Tiles Visual Proofs Captured Successfully!');
    console.log('========================================================================\n');
  } catch (err) {
    console.error('❌ Capture error:', err);
  } finally {
    try { ws.close(); } catch (_) {}
    try { chromeProc.kill('SIGKILL'); } catch (_) {}
    if (serverProc) { try { serverProc.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
