const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9336;
const SERVER_PORT = 5188;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}/vector_spatial_intelligence_demo.html`;
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary'
};

const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/29954617-6067-4894-8ba1-420c57425aea');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

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

function startStaticServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      let reqPath = decodeURIComponent(parsedUrl.pathname);
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(PUBLIC_DIR, reqPath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[StagingCapture] Embedded static HTTP server listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

async function main() {
  console.log('[StagingCapture] Starting intelligent staging capture sequence...');

  // 1. Start embedded HTTP server
  const server = await startStaticServer(SERVER_PORT);

  // 2. Launch Google Chrome headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_staging_cdp_');
  console.log('[StagingCapture] Launching Google Chrome headless with CDP port ' + CDP_PORT + '...');
  const chromeProc = spawn(chromePath, [
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

  let chromeStderr = '';
  chromeProc.stderr.on('data', d => { chromeStderr += d.toString(); });

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
    if (server) server.close();
    console.error('[StagingCapture] Chrome stderr:', chromeStderr);
    throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
  }

  console.log('[StagingCapture] Connected to Chrome DevTools WebSocket: ' + targetWs);
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
  await sendCdp('Network.enable');
  await sendCdp('Network.setCacheDisabled', { cacheDisabled: true });

  async function takeProofShot(filename, description) {
    console.log(`  -> Capturing: ${filename} (${description})...`);
    await sleep(800);
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shotRes.data, 'base64');

    const outPath1 = path.join(OUTPUT_DIR, filename);
    const outPath2 = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath1, pngBuf);
    fs.writeFileSync(outPath2, pngBuf);

    console.log(`     ✅ Saved to ${outPath1} & artifact dir (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return outPath2;
  }

  // Navigate to Vector Spatial Intelligence & Semantic Roadmap Studio
  console.log(`[StagingCapture] Navigating to Studio: ${SERVER_URL}...`);
  await sendCdp('Page.navigate', { url: SERVER_URL });
  await sleep(4500); // Allow GLB models, cadastre, and ensemble staging to initialize

  // 1. Default Complex Multi-Tier Ensemble Vantage (Page Load Default)
  console.log('[StagingCapture] Capturing default complex multi-tier ensemble vantage...');
  await takeProofShot('default_complex_01_ensemble_street_vantage.png', 'Default Complex Multi-Tier Ensemble Vantage on load: Hero Vehicle in Lane 3, Sidewalk Cafe, Streetlamps, Trees, Traffic, and 10 Art Deco Towers');

  // 2. High-Angle Aerial Cadastral Plan
  console.log('[StagingCapture] Switching to Aerial Cadastral Plan...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      document.getElementById('cam-aerial').click();
    `
  });
  await sleep(1500);
  await takeProofShot('default_complex_02_cadastral_district_plan.png', 'Aerial Cadastral Plan showing 10 surrounding Midtown blocks, sidewalks, crosswalks, and multi-tier staged anchors');

  // 3. Cinematic Street Level Perspective
  console.log('[StagingCapture] Switching to Cinematic Street Level...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      document.getElementById('cam-cinematic').click();
    `
  });
  await sleep(1500);
  await takeProofShot('default_complex_03_cinematic_street_level.png', 'Cinematic Street Level Perspective looking past Hero Vehicle and Sidewalk Cafe toward Art Deco towers');

  // 4. Return to Ensemble Vantage & Active Inspector Telemetry
  console.log('[StagingCapture] Returning to Midtown Ensemble Vantage...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      document.getElementById('cam-ensemble').click();
    `
  });
  await sleep(1500);
  await takeProofShot('default_complex_04_active_inspector_telemetry.png', 'Midtown Ensemble Vantage with active Entity Spatial Intelligence panel displaying Hero Vehicle telemetry');

  ws.close();
  chromeProc.kill('SIGKILL');
  server.close();

  console.log('[StagingCapture] All 4 high-resolution complex default proof screenshots captured successfully!');
}

main().catch(err => {
  console.error('[StagingCapture] Error:', err);
  process.exit(1);
});
