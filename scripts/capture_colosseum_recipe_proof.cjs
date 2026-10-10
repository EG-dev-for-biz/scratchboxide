const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9550 + Math.floor(Math.random() * 300);
const SERVER_PORT = 5300 + Math.floor(Math.random() * 300);
const DEMO_URL = `http://127.0.0.1:${SERVER_PORT}/demos/showcase/colosseum_recolor_proof.html?left=original&right=recipe`;

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
  console.log(`[Recipe Proof Capture] Starting on Server Port ${SERVER_PORT}, CDP Port ${CDP_PORT}...`);

  // Start HTTP server
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
          path: '/demos/showcase/colosseum_recolor_proof.html',
          timeout: 1500
        }, (r) => resolve(r.statusCode === 200));
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (ok) {
        console.log(`[Recipe Proof Capture] Server ready on port ${SERVER_PORT}`);
        serverRunning = true;
        break;
      }
    } catch (err) {
      if (i > 30) console.log(`[Recipe Proof Capture] Poll retry (${i}):`, err.message);
    }
  }

  if (!serverRunning) {
    if (serverProc) serverProc.kill('SIGKILL');
    throw new Error(`Failed to start server on port ${SERVER_PORT}`);
  }

  // Launch Google Chrome headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_colosseum_recipe_cdp_');
  console.log(`[Recipe Proof Capture] Launching Google Chrome headless with CDP port ${CDP_PORT}...`);
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

  console.log('[Recipe Proof Capture] Connected to Chrome DevTools WebSocket: ' + targetWs);
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

  try {
    console.log(`[Recipe Proof Capture] Navigating to ${DEMO_URL}...`);
    await sendCdp('Page.navigate', { url: DEMO_URL });
    
    // Wait for models to load (colosseum_rome_textured.glb is 13MB, colosseum_rome_recipe_pbr.glb is 33MB)
    console.log('[Recipe Proof Capture] Waiting for GLTF models and recipe shader to initialize...');
    for (let waitSec = 0; waitSec < 30; waitSec++) {
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
        console.log(`[Recipe Proof Capture] Both models loaded in ~${waitSec + 1}s`);
        break;
      }
    }

    await sleep(2000);

    // Shot 1: Front Preset (Original Scan vs Upgraded Recipe PBR with Spanish tiles & Sanpietrini)
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('front');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_recipe_front.png',
      'Dual View: Original 3D Tiles vs Recipe PBR with Spanish Tiles, Sanpietrini Paving, & 5mm Bevels'
    );

    // Shot 2: Arch Preset (Curved Arcade Vaults & Through-Corridors)
    console.log('[Recipe Proof Capture] Switching to arch preset...');
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('arch');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_recipe_arch.png',
      'Close-up: Arcade Curved Vaults, De-Lighted Travertine, & Curvature Anti-Faceting'
    );

    // Shot 3: Foliage Preset (Perimeter Pine Trees & Roadways)
    console.log('[Recipe Proof Capture] Switching to foliage preset...');
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('foliage');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_recipe_foliage.png',
      'Botanical: Transferred Foliage Envelope Normals, Backlight Chlorophyll Glow, & Bitumen Roadways'
    );

    // Shot 4: Cornice Preset (Upper Attica & Dihedral Edge Bevels)
    console.log('[Recipe Proof Capture] Switching to cornice preset...');
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('cornice');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_recipe_cornice.png',
      'Architectural: 5mm Virtual Specular Bevels on Upper Cornice & Stone Pilasters'
    );

    // Shot 5: Aerial Preset (District-wide Urban Context & Barrel Tile Roofs)
    console.log('[Recipe Proof Capture] Switching to aerial preset...');
    await sendCdp('Runtime.evaluate', { expression: `setCameraPreset('aerial');` });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_recipe_aerial.png',
      'District Aerial: Surrounding Spanish Barrel Tile Roofs, Sanpietrini Cobblestones, & Locked Ruin Envelope'
    );

    // Shot 6: Material Classes Debug Pass (Verifying ADA classification)
    console.log('[Recipe Proof Capture] Switching to Material Classes Debug Pass (view 3)...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        document.getElementById('recipeView').value = '3';
        setRecipeOption('view', '3');
      `
    });
    await sleep(1200);
    await takeProofShot(
      'colosseum_proof_material_strata_debug.png',
      'Diagnostic View: Continuous Material Strata Classification (Travertine, Terracotta Roofs, Sanpietrini, Foliage, Windows)'
    );

    console.log('[Recipe Proof Capture] All proof captures completed successfully!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    serverProc.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error('[Recipe Proof Capture] Error:', err);
  process.exit(1);
});
