const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const PORT = 8160;
const CDP_PORT = 9280;
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.resolve(REPO_ROOT, 'docs/screenshots');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCSHRfQGTmZykmM4LA6mI7avjEQEkQive4';

// Red Rocks Amphitheatre Anchor
const LAT = 39.66555;
const LNG = -105.20525;
const ALT = 1932.0;

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

// Generate the direct Three.js + 3d-tiles-renderer HTML runner
function generateRunnerHtml() {
  // WGS-84 Local Tangent Plane Matrix at Red Rocks
  const WGS84_A = 6378137.0;
  const WGS84_F = 1.0 / 298.257223563;
  const WGS84_B = WGS84_A * (1.0 - WGS84_F);
  const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

  const latRad = LAT * (Math.PI / 180);
  const lngRad = LNG * (Math.PI / 180);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLng = Math.sin(lngRad);
  const cosLng = Math.cos(lngRad);

  const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  const x = (n + ALT) * cosLat * cosLng;
  const y = (n + ALT) * cosLat * sinLng;
  const z = ((1.0 - WGS84_E2) * n + ALT) * sinLat;

  const m00 = -sinLng;
  const m01 = cosLng;
  const m02 = 0;
  const m03 = -(m00 * x + m01 * y + m02 * z);

  const m10 = cosLat * cosLng;
  const m11 = cosLat * sinLng;
  const m12 = sinLat;
  const m13 = -(m10 * x + m11 * y + m12 * z);

  const m20 = sinLat * cosLng;
  const m21 = sinLat * sinLng;
  const m22 = -cosLat;
  const m23 = -(m20 * x + m21 * y + m22 * z);

  const matrixValues = [
    m00, m01, m02, m03,
    m10, m11, m12, m13,
    m20, m21, m22, m23,
    0,   0,   0,   1
  ];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Direct Google 3D Tile Textured Capture</title>
  <style>
    body { margin: 0; background: #0a0d18; overflow: hidden; font-family: -apple-system, sans-serif; }
    #container { width: 1920px; height: 1080px; position: absolute; top: 0; left: 0; }
    #hud { position: absolute; top: 16px; left: 16px; background: rgba(15, 23, 42, 0.85); color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 13px; z-index: 100; pointer-events: none; border: 1px solid rgba(56, 189, 248, 0.3); }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/addons/": "/node_modules/three/examples/jsm/",
      "3d-tiles-renderer": "/node_modules/3d-tiles-renderer/build/index.js",
      "3d-tiles-renderer/plugins": "/node_modules/3d-tiles-renderer/build/index.plugins.js"
    }
  }
  </script>
</head>
<body>
  <div id="hud">
    <div style="font-weight: 700; color: #38bdf8;">Google 3D Tiles Direct Photogrammetry Capture</div>
    <div id="status">Initializing 3D Tiles...</div>
    <div id="stats" style="font-size: 11px; opacity: 0.85; margin-top: 4px;">Downloading root octree...</div>
  </div>
  <div id="container"></div>

  <script type="module">
    import * as THREE from 'three';
    import { TilesRenderer } from '3d-tiles-renderer';
    import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/plugins';

    const container = document.getElementById('container');
    const statusEl = document.getElementById('status');
    const statsEl = document.getElementById('stats');

    const width = 1920;
    const height = 1080;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x181a2e);

    // Camera positioned at Mix Board (FOH) looking down towards stage and surrounding rocks
    const camera = new THREE.PerspectiveCamera(52, width / height, 0.5, 25000);
    camera.position.set(0, 18.0, 55.0);
    camera.lookAt(0, 4.0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    // Natural Colorado Sunlight + Ambient Hemispherical Skylight
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x5a3d31, 1.3);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff1e0, 2.2);
    sunLight.position.set(45, 75, 30);
    scene.add(sunLight);

    // 3D Tiles Setup
    const localMatrix = new THREE.Matrix4();
    localMatrix.set(${matrixValues.join(', ')});

    const tiles = new TilesRenderer();
    const auth = new GoogleCloudAuthPlugin({
      apiToken: '${API_KEY}',
      autoRefreshToken: true
    });
    tiles.registerPlugin(auth);

    tiles.group.matrix.copy(localMatrix);
    tiles.group.matrixAutoUpdate = false;
    scene.add(tiles.group);

    tiles.setCamera(camera);
    tiles.setResolution(camera, 3840, 2160); // 4K SSE budget for deepest leaf detail
    tiles.errorTarget = 0.5; // Leaf LOD threshold

    if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 24;
    if (tiles.parseQueue) tiles.parseQueue.maxJobs = 16;
    tiles.maxTilesProcessed = 1000;

    tiles.onLoadModel = (sceneModel) => {
      sceneModel.traverse((child) => {
        if (child.isMesh) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => {
            if (m) {
              m.side = THREE.DoubleSide;
              if (m.map) {
                m.map.colorSpace = THREE.SRGBColorSpace;
                if (renderer.capabilities) {
                  m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
                }
                m.map.generateMipmaps = true;
                m.map.minFilter = THREE.LinearMipmapLinearFilter;
                m.map.magFilter = THREE.LinearFilter;
              }
              m.roughness = Math.max(m.roughness ?? 0.65, 0.45);
              m.metalness = Math.min(m.metalness ?? 0.05, 0.15);
              m.needsUpdate = true;
            }
          });
        }
      });
    };

    let stableCount = 0;
    let isSettled = false;

    async function checkSettle() {
      camera.updateMatrixWorld();
      tiles.setCamera(camera);
      tiles.update();
      renderer.render(scene, camera);

      const stats = tiles.stats;
      statsEl.innerText = 'Downloading: ' + stats.downloading + ' | Parsing: ' + stats.parsing + ' | Loaded: ' + stats.loaded;

      if (stats.downloading === 0 && stats.parsing === 0 && stats.loaded > 15) {
        stableCount++;
        statusEl.innerText = 'Settling Leaf Tiles... (' + stableCount + '/20)';
        if (stableCount >= 20) {
          isSettled = true;
          window.__TILE_SETTLED__ = true;
          statusEl.innerText = '✅ Leaf Tiles Settled! Ready to Capture.';
          return;
        }
      } else {
        stableCount = 0;
        statusEl.innerText = 'Streaming Leaf LOD...';
      }

      requestAnimationFrame(checkSettle);
    }

    requestAnimationFrame(checkSettle);
  </script>
</body>
</html>`;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURI((req.url || '/').split('?')[0]);
  if (reqPath === '/' || reqPath === '/runner.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(generateRunnerHtml());
    return;
  }
  const filePath = path.join(REPO_ROOT, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(filePath).pipe(res);
});

async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`[Server] Direct Tile Capture server running at http://127.0.0.1:${PORT}`);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_direct_tile_');
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

  if (!targetWs) throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
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

  console.log('Navigating to direct tile capture runner...');
  await sendCdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/runner.html` });

  console.log('Waiting for Google 3D Tiles leaf stream to settle...');
  let settled = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const res = await sendCdp('Runtime.evaluate', {
      expression: 'Boolean(window.__TILE_SETTLED__)'
    });
    if (res && res.result && res.result.value === true) {
      settled = true;
      break;
    }
  }

  // Extra 1.5s for final raster flush
  await sleep(1500);

  console.log('Capturing full-resolution textured screenshot...');
  const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
  const outPath = path.join(SHOT_DIR, '68_direct_google_tile_textured_capture_red_rocks.png');
  fs.writeFileSync(outPath, Buffer.from(shotRes.data, 'base64'));

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`✅ SUCCESS! Saved direct photogrammetric tile capture to:`);
  console.log(`   ${outPath} (${sizeKb} KB)`);

  ws.close();
  chromeProc.kill('SIGKILL');
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
