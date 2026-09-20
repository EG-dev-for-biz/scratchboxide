const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9222',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  console.log('Started Chrome with PID', chromeProc.pid);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9222/json');
      if (targets && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
        targetWs = targets[0].webSocketDebuggerUrl;
        break;
      }
    } catch (e) {
      // waiting
    }
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP');
    chromeProc.kill();
    process.exit(1);
  }

  console.log('Connecting to WS:', targetWs);
  const ws = new WebSocket(targetWs);
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
  console.log('WS connected, enabling Page & Runtime');
  await send('Page.enable');
  await send('Runtime.enable');

  const navUrl = 'http://127.0.0.1:8094/s4d_multi_gallery.html?ts=' + Date.now();
  console.log('Navigating to', navUrl);
  await send('Page.navigate', { url: navUrl });

  // Wait 5 seconds for WebGL canvas and models to initialize
  console.log('Waiting 5s for full scene and UI mount...');
  await sleep(5000);

  // Evaluate document state
  const evalResult = await send('Runtime.evaluate', {
    expression: '({ title: document.title, activeBtn: document.querySelector(".district-btn.active")?.innerText, metrics: document.querySelector("#district-metrics b")?.innerText, videoSrc: document.querySelector("#ai-video-player")?.src })',
    returnByValue: true
  });
  console.log('Page state:', evalResult.result?.value);

  console.log('Capturing screenshot...');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(screenshot.data, 'base64');
  const outPath = path.resolve(__dirname, '../public/s4d_multi_gallery_final_verified.png');
  fs.writeFileSync(outPath, buf);
  console.log('Saved screenshot to', outPath, 'size:', buf.length);

  ws.close();
  chromeProc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
  console.log('Done!');
}

main().catch(console.error);
