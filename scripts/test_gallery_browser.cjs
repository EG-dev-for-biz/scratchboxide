const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { spawn } = require('child_process');

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const tmpDir = fs.mkdtempSync('/tmp/chrome_diag_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--disable-gpu',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9224',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9224/json');
      if (targets && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
        targetWs = targets[0].webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    console.error('Failed to connect to Chrome on 9224');
    chromeProc.kill();
    process.exit(1);
  }

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
  await send('Page.enable');
  await send('Runtime.enable');

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

  const url = 'http://127.0.0.1:8088/s4d_multi_gallery.html?t=' + Date.now();
  console.log('Navigating to', url);
  await send('Page.navigate', { url });

  await sleep(3000);

  const res = await send('Runtime.evaluate', {
    expression: `({
      districtCount: evaluationsData.length,
      currentDistrictIdx: currentDistrictIdx,
      activeDistrictName: evaluationsData[currentDistrictIdx]?.name,
      tabVideoText: document.getElementById('tab-video')?.innerText,
      streamTitle: document.getElementById('stream-title')?.innerText,
      exportBtnHref: document.getElementById('btn-export-omni')?.href,
      exportBtnDownload: document.getElementById('btn-export-omni')?.download,
      videoPlayerSrc: document.getElementById('ai-video-player')?.src,
      storyboardCount: document.querySelectorAll('.storyboard-thumb').length,
      firstStoryboardImg: document.querySelector('.storyboard-thumb img')?.src
    })`,
    returnByValue: true
  });

  console.log('DOM Evaluation Result:\n', JSON.stringify(res.result?.value, null, 2));

  // Test District 2 (Shibuya)
  console.log('\n--- Switching to District 2 (Tokyo Shibuya) ---');
  await send('Runtime.evaluate', {
    expression: `
      const btns = document.querySelectorAll('.district-btn');
      btns[2].click();
    `
  });
  await sleep(1500);

  const resShibuya = await send('Runtime.evaluate', {
    expression: `({
      currentDistrictIdx: currentDistrictIdx,
      activeDistrictName: evaluationsData[currentDistrictIdx]?.name,
      tabVideoText: document.getElementById('tab-video')?.innerText,
      streamTitle: document.getElementById('stream-title')?.innerText,
      exportBtnHref: document.getElementById('btn-export-omni')?.href,
      exportBtnDownload: document.getElementById('btn-export-omni')?.download,
      videoPlayerSrc: document.getElementById('ai-video-player')?.src,
      storyboardCount: document.querySelectorAll('.storyboard-thumb').length,
      firstStoryboardImg: document.querySelector('.storyboard-thumb img')?.src
    })`,
    returnByValue: true
  });
  console.log('Shibuya Evaluation Result:\n', JSON.stringify(resShibuya.result?.value, null, 2));

  // Test Screenshot capture with JPEG format (which is much faster and smaller than raw uncompressed PNG)
  console.log('\nCapturing screenshot of Shibuya as JPEG...');
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  const buf = Buffer.from(shot.data, 'base64');
  const artifactPath = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393/s4d_omni_gallery_shibuya_verified.jpg';
  fs.writeFileSync(artifactPath, buf);
  console.log('Saved JPEG screenshot to', artifactPath, 'size:', buf.length);

  ws.close();
  chromeProc.kill();
  console.log('Diagnostics completed successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
