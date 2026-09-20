const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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
  const version = await getJson('http://127.0.0.1:9222/json/version');
  const browserWs = version.webSocketDebuggerUrl;
  console.log('Connected to Browser WS:', browserWs);

  const ws = new WebSocket(browserWs);
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

  // Create new target page
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', width: 1920, height: 1080 });
  console.log('Created Target:', targetId);

  // Attach to target
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  console.log('Attached Session:', sessionId);

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

  const url = 'http://127.0.0.1:8094/s4d_multi_gallery.html?ts=' + Date.now();
  console.log('Navigating to', url);
  await sendSession('Page.navigate', { url });

  console.log('Waiting 6 seconds for WebGL render & UI population...');
  await sleep(6000);

  // Check state
  const state = await sendSession('Runtime.evaluate', {
    expression: '({ activeDistrict: document.querySelector(".district-btn.active")?.innerText, metrics: document.querySelector("#district-metrics b")?.innerText, video: document.querySelector("#ai-video-player")?.src })',
    returnByValue: true
  });
  console.log('Evaluated State:', state.result?.value);

  console.log('Capturing screenshot...');
  const screenshot = await sendSession('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(screenshot.data, 'base64');
  const outPath = path.resolve(__dirname, '../public/s4d_multi_gallery_final_verified.png');
  fs.writeFileSync(outPath, buf);
  console.log('Successfully saved screenshot to', outPath, 'Bytes:', buf.length);

  ws.close();
}

main().catch(console.error);
