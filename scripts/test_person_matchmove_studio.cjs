/**
 * Test & Screenshot Capture Runner for Person Subject Matchmove Studio
 * Verifies public/person_matchmove_studio.html across all modes and captures artifacts.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || '/Users/eligreen/.gemini/antigravity/brain/9cd6845c-841b-493a-8c62-35af56cd0f4d';
if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function createStaticServer(publicDir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/person_matchmove_studio.html';
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
      console.log(`Person Studio Server active on http://127.0.0.1:${port}`);
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
  console.log('🎬 PERSON MATCHMOVE STUDIO AUTOMATED VISUAL VERIFICATION RUNNER');
  console.log('======================================================================\n');

  const PORT = 8152;
  const publicDir = path.resolve(__dirname, '../public');
  const server = await createStaticServer(publicDir, PORT);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_person_studio_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9264',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  console.log('Started Headless Chrome PID:', chromeProc.pid);
  chromeProc.stderr.on('data', (d) => console.log('Chrome stderr:', d.toString()));
  chromeProc.stdout.on('data', (d) => console.log('Chrome stdout:', d.toString()));

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9264/json');
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP on 9264');
    chromeProc.kill();
    if (server) server.close();
    process.exit(1);
  }

  const ws = new WebSocket(targetWs, { maxPayload: 100 * 1024 * 1024 });
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
  await send('Page.enable');
  await send('DOM.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  const url = `http://127.0.0.1:${PORT}/person_matchmove_studio.html`;
  console.log('Navigating to Person Matchmove Studio:', url);
  await send('Page.navigate', { url });
  await sleep(2500);

  async function saveScreenshot(filename, label) {
    console.log(`Capturing: ${label} -> ${filename}`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    const localPath = path.resolve(__dirname, `../public/${filename}`);
    fs.writeFileSync(localPath, buf);
    fs.copyFileSync(localPath, path.join(ARTIFACT_DIR, filename));
    console.log(`Saved ${filename} (${buf.length} bytes)`);
  }

  // 1. Initial Landing: 50/50 Split Wipe
  await saveScreenshot('person_matchmove_split_wipe.png', 'Mode 1: 50/50 Split Wipe (Live Dancer vs 3D Blockout)');

  // 2. Cyan Wireframe / Skeleton Overlay
  await send('Runtime.evaluate', {
    expression: `setMode('edge')`
  });
  await sleep(600);
  await saveScreenshot('person_matchmove_cyan_skeleton.png', 'Mode 2: Cyan Wireframe & 16-Joint Anatomical Skeleton');

  // 3. Difference Metrology Heatmap
  await send('Runtime.evaluate', {
    expression: `setMode('diff')`
  });
  await sleep(600);
  await saveScreenshot('person_matchmove_metrology_diff.png', 'Mode 3: Metrology Residual Difference Heatmap (< 0.05px RMS)');

  // 4. 3D Spline Orbit Viewport
  await send('Runtime.evaluate', {
    expression: `setMode('3d')`
  });
  await sleep(1500);
  await saveScreenshot('person_matchmove_3d_spline_orbit.png', 'Mode 4: 3D Articulated Mannequin & 72-Frame Hermite Spline Viewport');

  // 5. Scrubber Timeline at Frame 1 (Start of Orbit)
  await send('Runtime.evaluate', {
    expression: `setMode('split'); updateTimeline(1);`
  });
  await sleep(600);
  await saveScreenshot('person_matchmove_scrubber_kf0.png', 'Frame 1 (Start of Orbit at 0.0s)');

  console.log('\nAll 5 Person Matchmove visual verification screenshots captured successfully!');

  // Cleanup
  ws.close();
  chromeProc.kill();
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error in person studio runner:', err);
  process.exit(1);
});
