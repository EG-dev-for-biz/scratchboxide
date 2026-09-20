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
  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_preview_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9235',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('GLDriver') && !s.includes('metal')) console.error('[CHROME ERR]', s.trim());
  });

  console.log('Started Chrome for Gallery Verification with PID', chromeProc.pid);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9235/json');
      if (targets && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
        targetWs = targets[0].webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP on 9235');
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
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false
    });
  } catch (e) {
    // Optional on newer headless targets
  }

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

  const navUrl = 'http://127.0.0.1:8094/s4d_multi_gallery.html?ts=' + Date.now();
  console.log('Navigating to', navUrl);
  await send('Page.navigate', { url: navUrl });

  console.log('Waiting 5s for full scene, 3D WebGL, and UI mount...');
  await sleep(5000);

  // 1. Evaluate document state
  const evalResult = await send('Runtime.evaluate', {
    expression: `({
      title: document.title,
      activeDistrict: document.querySelector('.district-btn.active')?.innerText,
      metricsText: document.querySelector('#district-metrics')?.innerText,
      storyboardThumbsCount: document.querySelectorAll('#storyboard-strip .storyboard-thumb').length,
      videoSrc: document.querySelector('#ai-video-player')?.src,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      streamSpecs: document.querySelector('#stream-specs')?.innerText
    })`,
    returnByValue: true
  });
  console.log('--- Page State ---');
  console.log(JSON.stringify(evalResult.result?.value, null, 2));

  // 2. Capture Main Gallery View (Overview with 3D model, Collision Audit metrics, and Storyboard strip)
  console.log('Capturing Main Gallery Overview screenshot...');
  const screenshot1 = await send('Page.captureScreenshot', { format: 'png' });
  const buf1 = Buffer.from(screenshot1.data, 'base64');
  const outPath1 = path.resolve(__dirname, '../public/gallery_collision_preview.png');
  fs.writeFileSync(outPath1, buf1);
  console.log('Saved screenshot 1 to', outPath1, 'size:', buf1.length);

  // Copy to artifacts dir
  const brainDir = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393';
  fs.copyFileSync(outPath1, path.join(brainDir, 'gallery_collision_preview.png'));

  // 3. Switch to Step 1 Blockout Video
  console.log('Switching to Step 1: <VIDEO_REF_0> Blockout video...');
  await send('Runtime.evaluate', {
    expression: `document.getElementById('vbtn-block').click()`
  });
  await sleep(1500);

  const blockoutEval = await send('Runtime.evaluate', {
    expression: `({
      streamTitle: document.querySelector('#stream-title')?.innerText,
      streamSpecs: document.querySelector('#stream-specs')?.innerText,
      videoSrc: document.querySelector('#ai-video-player')?.src
    })`,
    returnByValue: true
  });
  console.log('Blockout view state:', blockoutEval.result?.value);

  const screenshot2 = await send('Page.captureScreenshot', { format: 'png' });
  const buf2 = Buffer.from(screenshot2.data, 'base64');
  const outPath2 = path.resolve(__dirname, '../public/gallery_blockout_video_selected.png');
  fs.writeFileSync(outPath2, buf2);
  fs.copyFileSync(outPath2, path.join(brainDir, 'gallery_blockout_video_selected.png'));
  console.log('Saved screenshot 2 to', outPath2);

  // 4. Click Storyboard Beat 0 to test Lightbox Preview
  console.log('Clicking Storyboard Beat 0 to test Lightbox Preview modal...');
  await send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.storyboard-thumb')[0]?.click()`
  });
  await sleep(1000);

  const lightboxEval = await send('Runtime.evaluate', {
    expression: `({
      lightboxOpen: document.getElementById('lightbox').classList.contains('open'),
      lightboxImgSrc: document.getElementById('lightbox-img')?.src,
      lightboxCaption: document.getElementById('lightbox-caption')?.innerText
    })`,
    returnByValue: true
  });
  console.log('Lightbox state:', lightboxEval.result?.value);

  const screenshot3 = await send('Page.captureScreenshot', { format: 'png' });
  const buf3 = Buffer.from(screenshot3.data, 'base64');
  const outPath3 = path.resolve(__dirname, '../public/gallery_storyboard_lightbox.png');
  fs.writeFileSync(outPath3, buf3);
  fs.copyFileSync(outPath3, path.join(brainDir, 'gallery_storyboard_lightbox.png'));
  console.log('Saved screenshot 3 to', outPath3);

  ws.close();
  chromeProc.kill();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  console.log('✅ Visual verification complete!');
}

main().catch(err => {
  console.error('Error running CDP test:', err);
  process.exit(1);
});
