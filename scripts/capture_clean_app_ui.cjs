const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9790 + Math.floor(Math.random() * 200);
const SERVER_PORT = 9336;
const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log('[AppScreenshots] Starting static file server on port ' + SERVER_PORT);
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

  console.log('[AppScreenshots] Launching Chrome...');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_app_shots_');

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
    console.log(`[AppScreenshots] Navigating to ${pageUrl}...`);
    await sendCdp('Page.navigate', { url: pageUrl });
    await sleep(4000);

    // Bust image cache inside DOM and disable timers
    await sendCdp('Runtime.evaluate', {
      expression: `
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
        activeLocationKey = 'colosseum';
        const ts = Date.now();
        stageImages[1].beauty = '/renders/colosseum/clean_stage1_clay.png?' + ts;
        stageImages[2].beauty = '/renders/colosseum/clean_stage2_vector.png?' + ts;
        stageImages[3].beauty = '/renders/colosseum/clean_stage3_master.png?' + ts;
        document.getElementById('imgLeft').src = stageImages[1].beauty;
        document.getElementById('imgRight').src = stageImages[3].beauty;
        document.getElementById('imgWipeReveal').src = stageImages[1].beauty;
        document.getElementById('imgWipeBase').src = stageImages[3].beauty;
      `
    });

    // 1. Capture Dual Split Mode
    console.log('[AppScreenshots] Capturing Dual Split View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('side-by-side');
        selectStage(3);
      `
    });
    await sleep(2500);
    const shot1 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf1 = Buffer.from(shot1.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_dual_split.png'), buf1);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_dual_split.png'), buf1);
    console.log(`     ✅ Saved colosseum_clean_app_dual_split.png (${(buf1.length / 1024).toFixed(1)} KB)`);

    // 2. Capture Wipe Split Mode
    console.log('[AppScreenshots] Capturing Wipe Split View...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('wipe');
        selectStage(3);
        const wipe = document.getElementById('wipeReveal');
        if (wipe) wipe.style.width = '50%';
        const handle = document.getElementById('wipeHandle');
        if (handle) handle.style.left = '50%';
      `
    });
    await sleep(2500);
    const shot2 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf2 = Buffer.from(shot2.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_wipe_slider.png'), buf2);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_wipe_slider.png'), buf2);
    console.log(`     ✅ Saved colosseum_clean_app_wipe_slider.png (${(buf2.length / 1024).toFixed(1)} KB)`);

    // 3. Capture 3D Orbit Viewport Mode (with UI intact)
    console.log('[AppScreenshots] Capturing 3D Orbit View (with HUD)...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        setViewMode('orbit-3d');
        switchOrbitModel(3);
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
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const res = await sendCdp('Runtime.evaluate', {
        expression: `document.getElementById('mainModelViewer').loaded === true`,
        returnByValue: true
      });
      if (res && res.result && res.result.value === true) break;
    }
    await sleep(3500);
    const shot3 = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf3 = Buffer.from(shot3.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_3d_orbit.png'), buf3);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_3d_orbit.png'), buf3);
    console.log(`     ✅ Saved colosseum_clean_app_3d_orbit.png (${(buf3.length / 1024).toFixed(1)} KB)`);

    console.log('[AppScreenshots] All app viewports successfully captured!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error('[AppScreenshots] Error:', err);
  process.exit(1);
});
