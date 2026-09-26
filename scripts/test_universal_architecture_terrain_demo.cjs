/**
 * Automated Test & Visual Verification Runner for:
 * - Archie Authentic Building Structure Refinement
 * - SB-Terrain Multi-Material Ground Engine
 *
 * Verifies public/universal_architecture_terrain_demo.html across:
 * 1. Default View (Hero Perspective: Archie Refined Building + All Terrain Layers)
 * 2. Facade & Plinth Closeup (Bilateral Normal Smoothing + Watertight Plinth Foundation)
 * 3. SB-Terrain Multi-Material Ground (Basalt Cobblestone Pavers + Turf + Volcanic Tufa Rocks)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SCREENSHOTS_DIR = path.resolve(__dirname, '../docs/screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function createStaticServer(publicDir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/universal_architecture_terrain_demo.html';
      const filePath = path.join(publicDir, reqPath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found: ' + reqPath);
        return;
      }

      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.glb': 'model/gltf-binary'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Universal Demo Server active on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getJson(url) {
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
  console.log('======================================================================');
  console.log('🏛️ ARCHIE & SB-TERRAIN UNIVERSAL DEMO AUTOMATED VERIFICATION RUNNER');
  console.log('======================================================================\n');

  const PORT = 8172;
  const publicDir = path.resolve(__dirname, '../public');
  const server = await createStaticServer(publicDir, PORT);

  let browserWs = null;
  let chromeProc = null;

  // 1. Try connecting to active Chrome on port 9222 first
  try {
    const version = await getJson('http://127.0.0.1:9222/json/version');
    if (version && version.webSocketDebuggerUrl) {
      browserWs = version.webSocketDebuggerUrl;
      console.log('Connected to existing active Chrome instance on 9222');
    }
  } catch (e) {
    // Port 9222 not reachable, fallback to spawning headless chrome
  }

  if (!browserWs) {
    const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_archi_terrain_');
    const cleanEnv = { ...process.env };
    delete cleanEnv.http_proxy;
    delete cleanEnv.https_proxy;
    delete cleanEnv.all_proxy;
    delete cleanEnv.HTTP_PROXY;
    delete cleanEnv.HTTPS_PROXY;
    delete cleanEnv.ALL_PROXY;

    chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new',
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      `--user-data-dir=${tmpDir}`,
      '--remote-debugging-port=9268',
      '--window-size=1920,1080',
      'about:blank'
    ], { env: cleanEnv });

    console.log('Spawned Headless Chrome PID:', chromeProc.pid);

    for (let i = 0; i < 30; i++) {
      try {
        await sleep(300);
        const version = await getJson('http://127.0.0.1:9268/json/version');
        if (version && version.webSocketDebuggerUrl) {
          browserWs = version.webSocketDebuggerUrl;
          break;
        }
      } catch (err) {}
    }
  }

  if (!browserWs) {
    console.error('Could not connect to any Chrome CDP browser endpoint');
    if (chromeProc) chromeProc.kill();
    if (server) server.close();
    process.exit(1);
  }

  const ws = new WebSocket(browserWs, { maxPayload: 100 * 1024 * 1024 });
  let id = 1;

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === msgId) {
          ws.removeListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await new Promise(r => ws.on('open', r));

  // Create isolated target page
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  console.log('Created Target Page:', targetId);

  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  console.log('Attached Target Session:', sessionId);

  function sendSession(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === msgId) {
          ws.removeListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: msgId, sessionId, method, params }));
    });
  }

  await sendSession('Page.enable');
  await sendSession('Runtime.enable');
  await sendSession('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  const demoUrl = `http://127.0.0.1:${PORT}/universal_architecture_terrain_demo.html?ts=${Date.now()}`;
  console.log('Navigating to:', demoUrl);
  await sendSession('Page.navigate', { url: demoUrl });

  console.log('Waiting for WebGL rendering and procedural shaders to initialize...');
  await sleep(4000);

  async function saveScreenshot(filename, label) {
    console.log(`\n📸 Capturing: ${label}`);
    const shot = await sendSession('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    const outPath = path.join(SCREENSHOTS_DIR, filename);
    fs.writeFileSync(outPath, buf);
    console.log(`  ✓ Saved ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
    return outPath;
  }

  // 1. Initial State: Hero 45° perspective (Archie Refined Building + All 3 Terrain Layers)
  await saveScreenshot('62_universal_archi_and_sb_terrain_demo.png', 'Viewpoint 1: Hero Perspective (Archie Refined + All Terrain Layers)');

  // 2. Facade & Plinth Closeup (Switch to Travertine Limestone + Plinth camera view)
  console.log('\nChoreographing camera to Facade & Plinth Closeup with Travertine Limestone palette...');
  await sendSession('Runtime.evaluate', {
    expression: `setCameraView('facade'); setPalette('limestone');`
  });
  await sleep(1500);
  await saveScreenshot('63_archie_facade_smoothing_and_plinth.png', 'Viewpoint 2: Facade Smoothing & Watertight Foundation Plinth');

  // 3. Low-Angle Street & Terrain View (Basalt Cobblestone Pavers, Rolling Turf, Volcanic Tufa Rocks)
  console.log('\nChoreographing camera to Low-Angle Street & Terrain View...');
  await sendSession('Runtime.evaluate', {
    expression: `setCameraView('street'); setPalette('roman_ochre');`
  });
  await sleep(1500);
  await saveScreenshot('64_sb_terrain_multimaterial_layers.png', 'Viewpoint 3: SB-Terrain Systems (Cobblestone Pavers, Turf, Volcanic Tufa Rocks)');

  console.log('\nClosing target page...');
  await send('Target.closeTarget', { targetId });

  ws.close();
  if (chromeProc) chromeProc.kill();
  if (server) server.close();

  console.log('\n======================================================================');
  console.log('🎉 ALL 3 VERIFICATION SCREENSHOTS CAPTURED SUCCESSFULLY!');
  console.log('======================================================================\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Runner failed:', err);
  process.exit(1);
});
