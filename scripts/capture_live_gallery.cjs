const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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
  const targets = await getJson('http://127.0.0.1:9222/json');
  console.log('Available targets on 9222:', targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })));

  const pageTarget = targets.find(t => t.type === 'page' && t.url.includes('s4d_multi_gallery.html')) ||
                     targets.find(t => t.type === 'page');

  if (!pageTarget) {
    throw new Error('No page target found on port 9222!');
  }

  console.log('Selected Page Target:', pageTarget.id, pageTarget.title, pageTarget.url);
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 });

  let id = 1;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const timer = setTimeout(() => {
        ws.removeListener('message', handler);
        reject(new Error(`Timeout waiting for CDP response: ${method}`));
      }, 15000);

      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === msgId) {
          clearTimeout(timer);
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

  const navUrl = 'http://127.0.0.1:8088/s4d_multi_gallery.html?ts=' + Date.now();
  console.log('Navigating to', navUrl);
  await send('Page.navigate', { url: navUrl });

  console.log('Waiting 4s for DOM and 3D viewport hydration...');
  await sleep(4000);

  // 1. Evaluate District 0
  const evalResult = await send('Runtime.evaluate', {
    expression: `({
      districtCount: evaluationsData.length,
      currentDistrictIdx: currentDistrictIdx,
      activeDistrictName: evaluationsData[currentDistrictIdx]?.name,
      metricsText: document.getElementById('district-metrics')?.innerText,
      storyboardCount: document.querySelectorAll('.storyboard-thumb').length,
      streamTitle: document.getElementById('stream-title')?.innerText,
      streamSpecs: document.getElementById('stream-specs')?.innerText,
      videoPlayerSrc: document.getElementById('ai-video-player')?.src,
      blockoutImgSrc: document.getElementById('cond-blockout-frame-img')?.src,
      startFrameImgSrc: document.getElementById('cond-start-frame-img')?.src
    })`,
    returnByValue: true
  });
  console.log('\n--- District 0 DOM State ---');
  console.log(JSON.stringify(evalResult.result?.value, null, 2));

  const brainDir = '/Users/eligreen/.gemini/antigravity/brain/302f27b2-ea15-4504-9423-02fca3dc2393';

  // 2. Capture Overview (Step 3 Omni Active + 8 Storyboard Beats + Metrics)
  console.log('\nCapturing Overview Screenshot (PNG)...');
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  const buf1 = Buffer.from(shot1.data, 'base64');
  const path1 = path.resolve(__dirname, '../public/gallery_collision_preview_overview.png');
  fs.writeFileSync(path1, buf1);
  fs.writeFileSync(path.join(brainDir, 'gallery_collision_preview_overview.png'), buf1);
  console.log('Saved Overview to', path1, 'size:', buf1.length);

  // 3. Switch to Step 1: <VIDEO_REF_0> Blockout
  console.log('\nSwitching to Step 1: <VIDEO_REF_0> Blockout Video...');
  await send('Runtime.evaluate', {
    expression: `document.getElementById('vbtn-block').click()`
  });
  await sleep(1500);

  const blockoutEval = await send('Runtime.evaluate', {
    expression: `({
      streamTitle: document.getElementById('stream-title')?.innerText,
      streamSpecs: document.getElementById('stream-specs')?.innerText,
      videoPlayerSrc: document.getElementById('ai-video-player')?.src
    })`,
    returnByValue: true
  });
  console.log('Blockout Stream State:', JSON.stringify(blockoutEval.result?.value, null, 2));

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  const buf2 = Buffer.from(shot2.data, 'base64');
  const path2 = path.resolve(__dirname, '../public/gallery_collision_preview_blockout.png');
  fs.writeFileSync(path2, buf2);
  fs.writeFileSync(path.join(brainDir, 'gallery_collision_preview_blockout.png'), buf2);
  console.log('Saved Blockout View to', path2, 'size:', buf2.length);

  // 4. Click Storyboard Beat 0 to test Lightbox Preview Modal
  console.log('\nClicking Storyboard Beat 0 for Lightbox Zoom...');
  await send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.storyboard-thumb')[0]?.click()`
  });
  await sleep(1000);

  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  const buf3 = Buffer.from(shot3.data, 'base64');
  const path3 = path.resolve(__dirname, '../public/gallery_collision_preview_lightbox.png');
  fs.writeFileSync(path3, buf3);
  fs.writeFileSync(path.join(brainDir, 'gallery_collision_preview_lightbox.png'), buf3);
  console.log('Saved Lightbox Modal to', path3, 'size:', buf3.length);

  // Close lightbox modal
  await send('Runtime.evaluate', {
    expression: `closeLightbox()`
  });

  ws.close();
  console.log('\n🎉 Successfully verified gallery and captured all 3 preview screenshots!');
}

main().catch(err => {
  console.error('Error during capture:', err);
  process.exit(1);
});
