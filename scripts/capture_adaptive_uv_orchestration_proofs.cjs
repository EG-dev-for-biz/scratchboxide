const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9830 + Math.floor(Math.random() * 100);
const SERVER_PORT = 9340;
const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/00c121e9-891b-448f-93d3-9d80f39d2436');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('[OrchestratorCapture] Starting static HTTP server on port ' + SERVER_PORT);
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
        '.glb': 'model/gltf-binary'
      };
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });

  await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

  console.log('[OrchestratorCapture] Launching Chrome on CDP port ' + CDP_PORT);
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_orch_');

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
      const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      const pageTarget = res.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    chromeProc.kill('SIGKILL');
    server.close();
    throw new Error('Chrome connection failed');
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
    const pageUrl = `http://127.0.0.1:${SERVER_PORT}/adaptive_uv_orchestrator_showcase.html`;
    console.log(`[OrchestratorCapture] Navigating to ${pageUrl}...`);
    await sendCdp('Page.navigate', { url: pageUrl });
    await sleep(5000);

    // Wait for all 4 models to load in quad grid
    console.log('[OrchestratorCapture] Waiting for 3D GLB models to load and texture...');
    const startTime = Date.now();
    while (Date.now() - startTime < 90000) {
      const res = await sendCdp('Runtime.evaluate', {
        expression: `
          (() => {
            const ids = ['mvColosseumQuad', 'mvEsbQuad', 'mvCypressQuad', 'mvCadQuad'];
            return ids.map(id => {
              const el = document.getElementById(id);
              return { id, loaded: el ? !!el.loaded : false };
            });
          })()
        `,
        returnByValue: true
      });
      const list = res.result?.value || [];
      const allDone = list.length === 4 && list.every(item => item.loaded);
      console.log(`[OrchestratorCapture] Load progress (${Math.round((Date.now() - startTime)/1000)}s):`, list.map(x => `${x.id}:${x.loaded}`).join(' '));
      if (allDone) {
        console.log('[OrchestratorCapture] All 4 quad models are fully loaded!');
        break;
      }
      await sleep(3000);
    }
    await sleep(6000);

    // 1. Capture 4-Up Matrix
    console.log('[OrchestratorCapture] Capturing Plate 1: 4-Domain Multi-Domain Matrix...');
    const shot1 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf1 = Buffer.from(shot1.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'adaptive_uv_orchestrator_4up_matrix.png'), buf1);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'adaptive_uv_orchestrator_4up_matrix.png'), buf1);
    console.log(`     ✅ Saved adaptive_uv_orchestrator_4up_matrix.png (${(buf1.length / 1024).toFixed(1)} KB)`);

    // Helper for switching view and waiting for model load
    async function switchAndWait(mode, waitMs = 5000) {
      await sendCdp('Runtime.evaluate', {
        expression: `
          new Promise(resolve => {
            switchView('${mode}');
            const mv = document.getElementById('mainSingleViewer');
            if (!mv) return resolve(true);
            if (mv.loaded) return resolve(true);
            mv.addEventListener('load', () => resolve(true), { once: true });
            setTimeout(() => resolve(true), ${waitMs});
          })
        `,
        awaitPromise: true
      });
      await sleep(2000);
    }

    // 2. Capture Single View: Colosseum District (Recipe Hybrid)
    console.log('[OrchestratorCapture] Capturing Plate 2: Colosseum District (Recipe Hybrid)...');
    await switchAndWait('colosseum', 10000);
    const shot2 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf2 = Buffer.from(shot2.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'adaptive_uv_orchestrator_colosseum_recipe.png'), buf2);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'adaptive_uv_orchestrator_colosseum_recipe.png'), buf2);
    console.log(`     ✅ Saved adaptive_uv_orchestrator_colosseum_recipe.png (${(buf2.length / 1024).toFixed(1)} KB)`);

    // 3. Capture Single View: Empire State Building (Elevation-Stratified Conformal)
    console.log('[OrchestratorCapture] Capturing Plate 3: Empire State Building (Elevation Conformal)...');
    await switchAndWait('esb', 6000);
    const shot3 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf3 = Buffer.from(shot3.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'adaptive_uv_orchestrator_esb_elevation.png'), buf3);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'adaptive_uv_orchestrator_esb_elevation.png'), buf3);
    console.log(`     ✅ Saved adaptive_uv_orchestrator_esb_elevation.png (${(buf3.length / 1024).toFixed(1)} KB)`);

    // 4. Capture Single View: Mediterranean Cypress (Carrier Conformal)
    console.log('[OrchestratorCapture] Capturing Plate 4: Mediterranean Cypress (Carrier Conformal)...');
    await switchAndWait('cypress', 6000);
    const shot4 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf4 = Buffer.from(shot4.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'adaptive_uv_orchestrator_cypress_organic.png'), buf4);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'adaptive_uv_orchestrator_cypress_organic.png'), buf4);
    console.log(`     ✅ Saved adaptive_uv_orchestrator_cypress_organic.png (${(buf4.length / 1024).toFixed(1)} KB)`);

    // 5. Capture Single View: Cuboid CAD / Prop (Continuous Height-Blended Triplanar)
    console.log('[OrchestratorCapture] Capturing Plate 5: Analytical Cuboid CAD (Zero-Seam Triplanar)...');
    await switchAndWait('cad', 6000);
    const shot5 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf5 = Buffer.from(shot5.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'adaptive_uv_orchestrator_cad_triplanar.png'), buf5);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'adaptive_uv_orchestrator_cad_triplanar.png'), buf5);
    console.log(`     ✅ Saved adaptive_uv_orchestrator_cad_triplanar.png (${(buf5.length / 1024).toFixed(1)} KB)`);

    console.log('\n[OrchestratorCapture] All 5 screenshot plates captured and written to artifacts successfully!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error('[OrchestratorCapture Error]', err);
  process.exit(1);
});
