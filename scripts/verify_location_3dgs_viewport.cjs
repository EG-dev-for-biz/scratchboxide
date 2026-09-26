const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const CDP_PORT = 9288;
const SHOT_DIR = path.resolve(__dirname, '../docs/screenshots');

if (!fs.existsSync(SHOT_DIR)) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
}

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
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu-watchdog',
    '--use-gl=angle',
    '--use-angle=metal',
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

  try {
    const url = 'http://localhost:8080/camera_space_visualizer.html';
    console.log(`\n📸 Navigating to ${url}...`);
    await sendCdp('Page.navigate', { url });

    console.log('⏳ Waiting for 3D visualizer to initialize...');
    await sleep(2000);

    // Switch to 3DGS mode
    console.log('✦ Switching to 3D Gaussian Splatting mode...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        if (window.setViewLayout) {
          window.setViewLayout('3dgs');
        }
      `
    });

    await sleep(3000);

    // Capture screenshot of the 3DGS viewport
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const outPath = path.join(SHOT_DIR, '96_location_nano_banana_3dgs_verified.png');
    fs.writeFileSync(outPath, Buffer.from(shotRes.data, 'base64'));
    console.log(`✅ Saved screenshot: 96_location_nano_banana_3dgs_verified.png (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
