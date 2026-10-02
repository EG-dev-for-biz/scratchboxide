const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const CDP_PORT = 9288;
const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/f3c08385-17f2-408d-86d5-35ae48f68b84';
const DOCS_DIR = path.resolve(__dirname, '../docs/screenshots');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('[Capture] Launching Chrome CDP to inspect Colosseum 3DGS alignment...');
  const tmpDir = fs.mkdtempSync('/tmp/chrome_colosseum_align_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
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
    chromeProc.kill();
    throw new Error('Failed to connect to headless Chrome CDP');
  }

  const ws = new WebSocket(targetWs);
  await new Promise(r => ws.on('open', r));

  let msgId = 1;
  const sendCdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      } catch (e) {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await sendCdp('Page.enable');
  await sendCdp('Runtime.enable');
  await sendCdp('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  console.log('[Capture] Navigating to Geographic 3DGS Studio...');
  await sendCdp('Page.navigate', { url: 'http://127.0.0.1:5173/geographic_3dgs_studio.html?landmark=colosseum&mode=hybrid' });

  // Wait for model and splat to load
  console.log('[Capture] Waiting for Colosseum PBR mesh and 13.0M 3DGS splats to load...');
  let loaded = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const evalRes = await sendCdp('Runtime.evaluate', {
      expression: 'Boolean(window.__engineState && window.__engineState.ready && window.__engineState.splatLoaded)',
      returnByValue: true
    });
    if (evalRes && evalRes.result && evalRes.result.value) {
      loaded = true;
      break;
    }
  }

  if (!loaded) {
    console.warn('[Capture] Timeout waiting for full __engineState.ready, checking individual flags:');
    const flags = await sendCdp('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__engineState || {})',
      returnByValue: true
    });
    console.warn('  Flags:', flags?.result?.value);
  } else {
    console.log('  ✅ Colosseum Mesh + 3DGS Radiance Field Loaded!');
  }

  // Let shaders compile and textures settle
  await sleep(2500);

  async function snap(filename, label) {
    await sleep(800);
    const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf = Buffer.from(shot.data, 'base64');
    const artPath = path.join(ARTIFACT_DIR, filename);
    const docPath = path.join(DOCS_DIR, filename);
    fs.writeFileSync(artPath, buf);
    try { fs.writeFileSync(docPath, buf); } catch (_) {}
    console.log(`📸 [${label}] Saved ${(buf.length / 1024).toFixed(1)} KB -> ${filename}`);
  }

  // 1. Overview in Hybrid mode (3DGS overlaying 3D tile mesh)
  console.log('\n--- Capture 1: Hybrid Mode Overview ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('hybrid');
      window.setCameraPreset('survey_overview');
    `
  });
  await snap('aligned_colosseum_hybrid.png', 'Hybrid Mode Overview');

  // 2. Overview in Radiance Solo mode (pure 3DGS)
  console.log('\n--- Capture 2: Radiance Solo Mode Overview ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('splat');
      window.setCameraPreset('survey_overview');
    `
  });
  await snap('aligned_colosseum_radiance_solo.png', '3DGS Radiance Solo Overview');

  // 3. Overview in 3D Tile Mesh Solo (to demonstrate 1:1 silhouette alignment)
  console.log('\n--- Capture 3: 3D Tile Mesh Solo Overview ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('tile');
      window.setCameraPreset('survey_overview');
    `
  });
  await snap('aligned_colosseum_tile_solo.png', '3D Tile Mesh Solo Overview');

  // 4. Macro Arcade close-up (looking right at the multi-tier arches)
  console.log('\n--- Capture 4: Macro Arcade Arches Close-up (Hybrid) ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('hybrid');
      window.setCameraPreset('macro_arcade');
    `
  });
  await snap('aligned_colosseum_macro_arcade.png', 'Macro Arcade Arches (Hybrid)');

  // 5. Macro Arcade close-up in 3DGS Radiance Solo
  console.log('\n--- Capture 5: Macro Arcade Arches Close-up (3DGS Solo) ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('splat');
      window.setCameraPreset('macro_arcade');
    `
  });
  await snap('aligned_colosseum_arcade_solo.png', 'Macro Arcade Arches (3DGS Solo)');

  // 6. Towering North Facade (4 Storeys Intact)
  console.log('\n--- Capture 6: Towering North Facade (3DGS Solo) ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('splat');
      window.setCameraPreset('tactile_close');
    `
  });
  await snap('aligned_colosseum_north_facade.png', 'Towering North Facade (3DGS Solo)');

  // 7. Interior Arena & Hypogeum Trench View
  console.log('\n--- Capture 7: Interior Arena & Hypogeum Trench View ---');
  await sendCdp('Runtime.evaluate', {
    expression: `
      window.switchMode('hybrid');
      window.setCameraPreset('ultra_micro');
    `
  });
  await snap('aligned_colosseum_hypogeum_interior.png', 'Interior Hypogeum View (Hybrid)');

  ws.close();
  chromeProc.kill('SIGKILL');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n🎉 All studio alignment screenshots captured successfully!');
}

main().catch(err => {
  console.error('Capture script error:', err);
  process.exit(1);
});
