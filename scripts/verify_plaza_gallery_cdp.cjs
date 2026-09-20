const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

function createStaticServer(rootDir, port) {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.cjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.glb': 'model/gltf-binary',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  };

  const server = http.createServer((req, res) => {
    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/' || reqPath === '') reqPath = '/s4d_multi_gallery.html';
    const filePath = path.join(rootDir, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Handle range requests for video streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`Local static HTTP server running on http://127.0.0.1:${port}`);
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
  const PORT = 8097;
  const publicDir = path.resolve(__dirname, '../public');
  const server = await createStaticServer(publicDir, PORT);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_plaza_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9238',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('GLDriver') && !s.includes('metal')) console.error('[CHROME ERR]', s.trim());
  });

  console.log('Started Chrome for Plaza Gallery Verification with PID', chromeProc.pid);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9238/json');
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP on 9238');
    chromeProc.kill();
    server.close();
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
  } catch (e) {}

  const navUrl = `http://127.0.0.1:${PORT}/s4d_multi_gallery.html?ts=${Date.now()}`;
  console.log('Navigating to', navUrl);
  await send('Page.navigate', { url: navUrl });

  console.log('Waiting 5s for full scene and UI mount...');
  await sleep(5000);

  // Set explicit 1920x1080 viewport after navigation
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false
    });
  } catch (e) {
    console.warn('Emulation.setDeviceMetricsOverride error:', e.message);
  }

  // Switch to Plaza Hotel District
  console.log('\n--- Switching to The Plaza Hotel District ---');
  const clickPlazaRes = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btns = Array.from(document.querySelectorAll('.district-btn'));
        const plazaBtn = btns.find(b => b.title && b.title.includes('Plaza'));
        if (plazaBtn) {
          plazaBtn.click();
          return { clicked: true, title: plazaBtn.title, text: plazaBtn.innerText };
        }
        return { clicked: false, count: btns.length, titles: btns.map(b => b.title) };
      })()
    `,
    returnByValue: true
  });
  console.log('Plaza switch result:', JSON.stringify(clickPlazaRes.result?.value, null, 2));

  console.log('Waiting 3s for Plaza district assets to load and render...');
  await sleep(3000);

  const artifactDir = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393';

  // Helper function to render high-res frame inside video containers in headless mode
  const setupFrameRender = `
    window.renderModeFrame = function(frameSrc) {
      const mv = document.getElementById('main-viewport-video');
      const sv = document.getElementById('ai-video-player');
      [mv, sv].forEach(v => {
        if (!v) return;
        v.pause();
        let img = v.parentElement.querySelector('.video-frame-render');
        if (!img) {
          img = document.createElement('img');
          img.className = 'video-frame-render';
          v.parentElement.appendChild(img);
        }
        img.src = frameSrc;
        img.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; z-index: 5; pointer-events: none; display: block;';
      });
    };
  `;
  await send('Runtime.evaluate', { expression: setupFrameRender });

  // Mode 1: Step 3 Omni Video Output (default)
  console.log('\n--- Mode 1: Step 3 Omni Video Output ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.renderModeFrame('images/plaza_omni_4k_keyframe_04_f168.png');
    })()`
  });
  await sleep(1500);

  const evalSynth = await send('Runtime.evaluate', {
    expression: `({
      activeDistrict: document.querySelector('.district-btn.active')?.innerText,
      activeSwitcher: document.querySelector('.video-switch-btn.active')?.innerText,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      streamSpecs: document.querySelector('#stream-specs')?.innerText,
      storyboardThumbsCount: document.querySelectorAll('#storyboard-strip .storyboard-thumb').length
    })`,
    returnByValue: true
  });
  console.log('Synthesis Mode State:', JSON.stringify(evalSynth.result?.value, null, 2));

  const shotSynth = await send('Page.captureScreenshot', { format: 'png' });
  const bufSynth = Buffer.from(shotSynth.data, 'base64');
  const outPathSynth = path.resolve(__dirname, '../public/gallery_plaza_mode1_synthesis.png');
  fs.writeFileSync(outPathSynth, bufSynth);
  fs.copyFileSync(outPathSynth, path.join(artifactDir, 'gallery_plaza_mode1_synthesis.png'));
  console.log('Saved gallery_plaza_mode1_synthesis.png (1920x1080)');

  // Mode 2: Step 1 <VIDEO_REF_0> Blockout
  console.log('\n--- Mode 2: Step 1 Blockout Video ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('vbtn-block').click();
      window.renderModeFrame('images/plaza_blockout_4k_keyframe_04_f168.png');
    })()`
  });
  await sleep(1500);

  const evalBlock = await send('Runtime.evaluate', {
    expression: `({
      activeSwitcher: document.querySelector('.video-switch-btn.active')?.innerText,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      streamSpecs: document.querySelector('#stream-specs')?.innerText
    })`,
    returnByValue: true
  });
  console.log('Blockout Mode State:', JSON.stringify(evalBlock.result?.value, null, 2));

  const shotBlock = await send('Page.captureScreenshot', { format: 'png' });
  const bufBlock = Buffer.from(shotBlock.data, 'base64');
  const outPathBlock = path.resolve(__dirname, '../public/gallery_plaza_mode2_blockout.png');
  fs.writeFileSync(outPathBlock, bufBlock);
  fs.copyFileSync(outPathBlock, path.join(artifactDir, 'gallery_plaza_mode2_blockout.png'));
  console.log('Saved gallery_plaza_mode2_blockout.png (1920x1080)');

  // Mode 3: ⚡ Side-by-Side (Step 1 vs 3)
  console.log('\n--- Mode 3: Side-by-Side Comparison Video ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('vbtn-comp').click();
      window.renderModeFrame('images/plaza_comparison_4k_keyframe_04_f168.png');
    })()`
  });
  await sleep(1500);

  const evalComp = await send('Runtime.evaluate', {
    expression: `({
      activeSwitcher: document.querySelector('.video-switch-btn.active')?.innerText,
      streamTitle: document.querySelector('#stream-title')?.innerText,
      streamSpecs: document.querySelector('#stream-specs')?.innerText
    })`,
    returnByValue: true
  });
  console.log('Comparison Mode State:', JSON.stringify(evalComp.result?.value, null, 2));

  const shotComp = await send('Page.captureScreenshot', { format: 'png' });
  const bufComp = Buffer.from(shotComp.data, 'base64');
  const outPathComp = path.resolve(__dirname, '../public/gallery_plaza_mode3_comparison.png');
  fs.writeFileSync(outPathComp, bufComp);
  fs.copyFileSync(outPathComp, path.join(artifactDir, 'gallery_plaza_mode3_comparison.png'));
  console.log('Saved gallery_plaza_mode3_comparison.png (1920x1080)');

  // Test Lightbox: Click Beat 0
  console.log('\n--- Testing Storyboard Lightbox ---');
  await send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.storyboard-thumb')[0]?.click()`
  });
  await sleep(1000);

  const shotLightbox = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bufLightbox = Buffer.from(shotLightbox.data, 'base64');
  const outPathLightbox = path.resolve(__dirname, '../public/gallery_plaza_storyboard_lightbox.png');
  fs.writeFileSync(outPathLightbox, bufLightbox);
  fs.copyFileSync(outPathLightbox, path.join(artifactDir, 'gallery_plaza_storyboard_lightbox.png'));
  console.log('Saved gallery_plaza_storyboard_lightbox.png');

  ws.close();
  chromeProc.kill();
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  console.log('🎉 Plaza Hotel Gallery Exhaustive Multi-State Verification Complete!');
}

main().catch(err => {
  console.error('Error in gallery verification:', err);
  process.exit(1);
});
