const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9790 + Math.floor(Math.random() * 200);
const SERVER_PORT = 9335;
const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log('[CropProofs] Starting static file server on port ' + SERVER_PORT);
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

  console.log('[CropProofs] Launching Chrome to capture high-res callout crops...');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_crops_');

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
    const pageUrl = `http://127.0.0.1:${SERVER_PORT}/omnispatial_synthesis_demo.html`;
    console.log(`[CropProofs] Navigating to ${pageUrl}...`);
    await sendCdp('Page.navigate', { url: pageUrl });
    await sleep(4000);

    await sendCdp('Runtime.evaluate', {
      expression: `
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
        // Set 3D orbit layout to full viewport
        document.querySelectorAll('.top-nav, .hud-panel, .bottom-hud, .model-viewer-controls-overlay').forEach(el => el.style.display = 'none');
        document.getElementById('sideBySideView').style.display = 'none';
        document.getElementById('wipeSliderView').style.display = 'none';
        document.getElementById('loupeViewerLayout').style.display = 'none';

        const orbitLayout = document.getElementById('orbit3dLayout');
        orbitLayout.style.display = 'block';
        orbitLayout.style.position = 'fixed';
        orbitLayout.style.inset = '0';
        orbitLayout.style.zIndex = '999999';

        const mv = document.getElementById('mainModelViewer');
        if (mv) {
          mv.removeAttribute('poster');
          mv.removeAttribute('auto-rotate');
          mv.autoRotate = false;
          mv.setAttribute('camera-orbit', '-38deg 58deg 540m');
          mv.setAttribute('camera-target', '0m 10m 0m');
          mv.setAttribute('field-of-view', '32deg');
          mv.src = '/models/colosseum_stage3_master_pbr.glb';
        }
      `
    });

    console.log('[CropProofs] Waiting for 3D model to load in model-viewer...');
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const res = await sendCdp('Runtime.evaluate', {
        expression: `document.getElementById('mainModelViewer').loaded === true`,
        returnByValue: true
      });
      if (res && res.result && res.result.value === true) break;
    }
    await sleep(4000);

    // Crop 1: Arch of Constantine Close-Up (Undercut & Classical Arches)
    console.log('[CropProofs] Capturing Crop 1: Arch of Constantine...');
    const shot1 = await sendCdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 500, y: 640, width: 300, height: 260, scale: 2 }
    });
    const buf1 = Buffer.from(shot1.data, 'base64');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'proof_crop_arch_constantine.png'), buf1);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'proof_crop_arch_constantine.png'), buf1);
    console.log(`     ✅ Saved proof_crop_arch_constantine.png (${(buf1.length / 1024).toFixed(1)} KB)`);

    // Crop 2: Colosseum Interior Cavea & Intact Background Buildings
    console.log('[CropProofs] Capturing Crop 2: Colosseum Interior & Background...');
    const shot2 = await sendCdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 650, y: 140, width: 620, height: 480, scale: 2 }
    });
    const buf2 = Buffer.from(shot2.data, 'base64');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'proof_crop_interior_delighting.png'), buf2);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'proof_crop_interior_delighting.png'), buf2);
    console.log(`     ✅ Saved proof_crop_interior_delighting.png (${(buf2.length / 1024).toFixed(1)} KB)`);

    // Crop 3: Vector Road Ribbon & Beveled Granite Curbs (Basalt Cobblestone Proof)
    console.log('[CropProofs] Capturing Crop 3: Vector Road Ribbon & Curbs...');
    const shot3 = await sendCdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 180, y: 400, width: 550, height: 350, scale: 2 }
    });
    const buf3 = Buffer.from(shot3.data, 'base64');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'proof_crop_road_curbs.png'), buf3);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'proof_crop_road_curbs.png'), buf3);
    console.log(`     ✅ Saved proof_crop_road_curbs.png (${(buf3.length / 1024).toFixed(1)} KB)`);

    // Crop 4: Botanical Trees in Parco del Celio
    console.log('[CropProofs] Capturing Crop 4: Parco del Celio Botanical Trees...');
    const shot4 = await sendCdp('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 1180, y: 520, width: 500, height: 420, scale: 2 }
    });
    const buf4 = Buffer.from(shot4.data, 'base64');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'proof_crop_botanical_trees.png'), buf4);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'proof_crop_botanical_trees.png'), buf4);
    console.log(`     ✅ Saved proof_crop_botanical_trees.png (${(buf4.length / 1024).toFixed(1)} KB)`);

    console.log('[CropProofs] All callout crops successfully captured!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error('[CropProofs] Error:', err);
  process.exit(1);
});
