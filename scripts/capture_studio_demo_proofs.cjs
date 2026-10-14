const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Clean proxy settings to ensure direct local loopback communication
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.all_proxy;
delete process.env.ALL_PROXY;
process.env.NO_PROXY = '*';

const CDP_PORT = 9800 + Math.floor(Math.random() * 100);
const SERVER_PORT = process.env.STUDIO_PORT ? parseInt(process.env.STUDIO_PORT, 10) : (5500 + Math.floor(Math.random() * 200));
const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/00c121e9-891b-448f-93d3-9d80f39d2436');

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
  console.log(`[Demo Proof Capture] Target server port ${SERVER_PORT}, CDP Port ${CDP_PORT}...`);

  let serverProc = null;
  if (!process.env.STUDIO_PORT) {
    serverProc = spawn('node', ['scripts/serve_public.cjs'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(SERVER_PORT), NO_PROXY: '*' },
      stdio: 'inherit'
    });
  }

  let serverRunning = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get({
          host: '127.0.0.1',
          port: SERVER_PORT,
          path: '/sbhuman_hand_pose_studio.html',
          timeout: 1500
        }, (r) => {
          console.log(`[HealthCheck] status: ${r.statusCode}`);
          resolve(r.statusCode === 200);
        });
        req.on('error', (err) => {
          if (i === 10) console.log(`[HealthCheck] error:`, err.message);
          resolve(false);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) {
        console.log(`[Demo Proof Capture] Server ready on port ${SERVER_PORT}`);
        serverRunning = true;
        break;
      }
    } catch (e) {
      console.log('[HealthCheck] catch:', e.message);
    }
  }

  if (!serverRunning) {
    if (serverProc) serverProc.kill('SIGKILL');
    throw new Error(`Failed to start server on port ${SERVER_PORT}`);
  }

  // Launch Google Chrome headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_sbhuman_studio_cdp_');
  console.log(`[Demo Proof Capture] Launching Google Chrome headless with CDP port ${CDP_PORT}...`);
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('DevTools listening') || s.includes('ERROR')) {
      console.log('[Chrome Stderr]', s.trim());
    }
  });

  let cdpReady = false;
  let pageTarget = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        cdpReady = true;
        break;
      }
    } catch (err) {
      if (i === 10 || i === 20) console.log(`[CDP Retry ${i}]`, err.message);
    }
  }

  if (!cdpReady || !pageTarget) {
    chromeProc.kill('SIGKILL');
    if (serverProc) serverProc.kill('SIGKILL');
    throw new Error(`Google Chrome headless failed to start CDP on port ${CDP_PORT}`);
  }
  console.log(`[Demo Proof Capture] CDP connected. Target WebSocket: ${pageTarget.webSocketDebuggerUrl}`);

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let msgId = 1;
  const pendingRequests = new Map();

  ws.on('message', (raw) => {
    const res = JSON.parse(raw);
    if (res.method === 'Runtime.consoleAPICalled') {
      const msg = (res.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' ');
      console.log('   [Page Console]', msg);
    }
    if (res.method === 'Runtime.exceptionThrown') {
      console.error('   [Page Exception]', res.params.exceptionDetails && res.params.exceptionDetails.text, res.params.exceptionDetails && res.params.exceptionDetails.exception && res.params.exceptionDetails.exception.description);
    }
    if (res.id && pendingRequests.has(res.id)) {
      const { resolve, reject } = pendingRequests.get(res.id);
      pendingRequests.delete(res.id);
      if (res.error) reject(new Error(JSON.stringify(res.error)));
      else resolve(res.result);
    }
  });

  await new Promise(r => ws.on('open', r));

  function sendCdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    await sendCdp('Page.enable');
    await sendCdp('Runtime.enable');
    await sendCdp('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false
    });

    const targetUrl = `http://127.0.0.1:${SERVER_PORT}/sbhuman_hand_pose_studio.html?model=hyperreal`;
    console.log(`[Demo Proof Capture] Navigating to: ${targetUrl}`);
    await sendCdp('Page.navigate', { url: targetUrl });

    // Wait for page and 3D assets to load
    console.log('[Demo Proof Capture] Waiting for WebGL scene and Hyper-Real asset loading...');
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const evalRes = await sendCdp('Runtime.evaluate', {
        expression: '({ ready: window._hyperRealReady, mesh: Boolean(window.hyperRealMesh), preset: Boolean(window.setCameraPreset) })',
        returnByValue: true
      });
      if (i % 5 === 0) {
        console.log(`[Check ${i}] State:`, evalRes && evalRes.result && evalRes.result.value);
      }
      if (evalRes && evalRes.result && evalRes.result.value && evalRes.result.value.ready && evalRes.result.value.preset) {
        console.log(`[Demo Proof Capture] Hand studio fully initialized in ${i * 0.5}s!`);
        break;
      }
    }

    // Additional settling time for shaders and PBR textures
    await sleep(2500);

    const shots = [
      {
        filename: 'demo_proof_01_user_ref_dorsal_upright.png',
        title: 'User Reference Match: Upright Dorsal PBR (Veins, Extensor Tendons & Nails)',
        setup: `
          window.loadUserReference('dorsal');
        `
      },
      {
        filename: 'demo_proof_02_user_ref_palmar_upright.png',
        title: 'User Reference Match: Upright Palmar PBR ("this strong" Tattoo & Flexion Creases)',
        setup: `
          window.loadUserReference('palmar');
        `
      },
      {
        filename: 'demo_proof_03_macro_fingernail_histology.png',
        title: 'Histological Macro: Squoval Fingernail, Ivory Free Edge & Lateral Seals',
        setup: `
          window.loadUserReference('dorsal');
          window.setCameraPreset('macro_nail');
          const hud3 = document.getElementById('ref-photo-compare-modal');
          if (hud3) hud3.style.display = 'none';
        `
      },
      {
        filename: 'demo_proof_04_macro_palmar_tattoo.png',
        title: 'Macro Decal: Subcutaneous "this strong" Cursive Wrist Tattoo & Volar Creases',
        setup: `
          window.loadUserReference('palmar');
          window.setCameraPreset('macro_tattoo');
          const hud4 = document.getElementById('ref-photo-compare-modal');
          if (hud4) hud4.style.display = 'none';
        `
      },
      {
        filename: 'demo_proof_05_interactive_studio_overview.png',
        title: 'Interactive Studio Overview: User Reference Drawer & Multimodal Controls',
        setup: `
          window.setModelMode('hyperreal');
          window.setHandChirality('left');
          window.setCameraPreset('ref_dorsal_upright');
          window.setShadingMode('pbr');
          const refDrawer = document.getElementById('ref-library-drawer');
          if (refDrawer) refDrawer.style.display = 'flex';
          const btnToggleRef = document.getElementById('btn-toggle-ref-library');
          if (btnToggleRef) btnToggleRef.classList.add('active');
          const hud5 = document.getElementById('ref-photo-compare-modal');
          if (hud5) hud5.style.display = 'none';
        `
      }
    ];

    const capturedPaths = [];

    for (let idx = 0; idx < shots.length; idx++) {
      const shot = shots[idx];
      console.log(`[Demo Proof Capture] (${idx + 1}/${shots.length}) Staging: ${shot.title}...`);
      await sendCdp('Runtime.evaluate', { expression: shot.setup });
      await sleep(1500); // Allow render loop & transitions to settle

      const ss = await sendCdp('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(ss.data, 'base64');

      const outPath = path.join(OUTPUT_DIR, shot.filename);
      const artPath = path.join(ARTIFACT_DIR, shot.filename);

      fs.writeFileSync(outPath, buf);
      fs.writeFileSync(artPath, buf);

      console.log(`✅ Captured [${shot.filename}] (${buf.length.toLocaleString()} bytes)`);
      capturedPaths.push({ title: shot.title, filename: shot.filename, size: buf.length, path: artPath });
    }

    console.log('\n========================================');
    console.log('🎉 ALL 5 DEMO PROOF SCREENSHOTS CAPTURED');
    console.log('========================================');
    capturedPaths.forEach(p => {
      console.log(`- ${p.title}: ${p.filename} (${(p.size / 1024).toFixed(1)} KB)`);
    });

  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    if (serverProc) serverProc.kill('SIGKILL');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(err => {
  console.error('[Demo Proof Capture] Fatal Error:', err);
  process.exit(1);
});
