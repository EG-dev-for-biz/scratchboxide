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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_omni_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9228',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', d => console.error('[CHROME ERR]', d.toString()));
  chromeProc.stdout.on('data', d => console.log('[CHROME OUT]', d.toString()));

  console.log('Started Chrome for Omni Verification with PID', chromeProc.pid);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9228/json');
      if (targets && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
        targetWs = targets[0].webSocketDebuggerUrl;
        break;
      }
    } catch (e) {
      // waiting
    }
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP on 9228');
    chromeProc.kill();
    process.exit(1);
  }

  console.log('Connecting to WS:', targetWs);
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
  console.log('WS connected, enabling Page & Runtime');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.consoleAPICalled') {
        console.log('[BROWSER CONSOLE]', msg.params.type, msg.params.args.map(a => a.value || a.description).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        console.error('[BROWSER EXCEPTION]', msg.params.exceptionDetails);
      }
    } catch (e) {}
  });

  const navUrl = 'http://127.0.0.1:8088/s4d_multi_gallery.html?ts=' + Date.now();
  console.log('Navigating to', navUrl);
  await send('Page.navigate', { url: navUrl });

  console.log('Waiting 5s for full scene and Omni Video Output UI mount...');
  await sleep(5000);

  // Evaluate document state on district 0
  const evalResult = await send('Runtime.evaluate', {
    expression: `({
      title: document.title,
      activeTab: document.querySelector('.ai-tab.active')?.innerText,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      streamSpecs: document.querySelector('#stream-specs')?.innerText,
      exportHref: document.querySelector('#btn-export-omni')?.href,
      exportDownload: document.querySelector('#btn-export-omni')?.download,
      videoSrc: document.querySelector('#ai-video-player')?.src,
      activeDistrict: document.querySelector('.district-btn.active')?.innerText,
      storyboardThumbsCount: document.querySelectorAll('.storyboard-thumb').length,
      allButtons: Array.from(document.querySelectorAll('.district-btn')).map(b => b.innerText)
    })`,
    returnByValue: true
  });
  console.log('Initial District State:', JSON.stringify(evalResult.result?.value, null, 2));

  const artifactDir = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393';

  console.log('Capturing District 0 (Clay Flight) screenshot...');
  const shot0 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf0 = Buffer.from(shot0.data, 'base64');
  fs.writeFileSync(path.join(artifactDir, 's4d_omni_gallery_clay_flight.png'), buf0);
  console.log('Saved s4d_omni_gallery_clay_flight.png, size:', buf0.length);

  // Switch to District 2 (Tokyo Shibuya Commercial)
  console.log('\n--- Switching to District 2 (Tokyo Shibuya) ---');
  const clickRes2 = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = document.querySelectorAll('.district-btn');
        if (btns[2]) {
          btns[2].click();
          return { clicked: true, text: btns[2].innerText };
        }
        return { clicked: false, count: btns.length };
      })()
    `,
    returnByValue: true
  });
  console.log('Click Shibuya result:', clickRes2.result?.value);
  await sleep(3000);

  const evalShibuya = await send('Runtime.evaluate', {
    expression: `({
      activeDistrict: document.querySelector('.district-btn.active')?.innerText,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      exportHref: document.querySelector('#btn-export-omni')?.href,
      exportDownload: document.querySelector('#btn-export-omni')?.download,
      videoSrc: document.querySelector('#ai-video-player')?.src,
      storyboardThumbsCount: document.querySelectorAll('.storyboard-thumb').length
    })`,
    returnByValue: true
  });
  console.log('Shibuya District State:', JSON.stringify(evalShibuya.result?.value, null, 2));

  console.log('Capturing Shibuya Omni Video Output screenshot...');
  const shotShibuya = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bufShibuya = Buffer.from(shotShibuya.data, 'base64');
  fs.writeFileSync(path.join(artifactDir, 's4d_omni_gallery_shibuya.png'), bufShibuya);
  console.log('Saved s4d_omni_gallery_shibuya.png, size:', bufShibuya.length);

  // Switch to District 4 (Dubai Marina Waterfront)
  console.log('\n--- Switching to District 4 (Dubai Marina) ---');
  const clickRes4 = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = document.querySelectorAll('.district-btn');
        if (btns[4]) {
          btns[4].click();
          return { clicked: true, text: btns[4].innerText };
        }
        return { clicked: false, count: btns.length };
      })()
    `,
    returnByValue: true
  });
  console.log('Click Dubai result:', clickRes4.result?.value);
  await sleep(3000);

  const evalDubai = await send('Runtime.evaluate', {
    expression: `({
      activeDistrict: document.querySelector('.district-btn.active')?.innerText,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      exportHref: document.querySelector('#btn-export-omni')?.href,
      exportDownload: document.querySelector('#btn-export-omni')?.download,
      videoSrc: document.querySelector('#ai-video-player')?.src,
      storyboardThumbsCount: document.querySelectorAll('.storyboard-thumb').length
    })`,
    returnByValue: true
  });
  console.log('Dubai District State:', JSON.stringify(evalDubai.result?.value, null, 2));

  console.log('Capturing Dubai Omni Video Output screenshot...');
  const shotDubai = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bufDubai = Buffer.from(shotDubai.data, 'base64');
  fs.writeFileSync(path.join(artifactDir, 's4d_omni_gallery_dubai.png'), bufDubai);
  console.log('Saved s4d_omni_gallery_dubai.png, size:', bufDubai.length);

  ws.close();
  chromeProc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  console.log('🎉 Omni Video Output Verification Complete!');
}

main().catch(err => {
  console.error('Error in verification:', err);
  process.exit(1);
});
