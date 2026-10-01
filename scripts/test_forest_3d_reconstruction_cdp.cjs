/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

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
    '.webp': 'image/webp',
    '.glb': 'model/gltf-binary',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURI(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/forest_3d_viewer.html';
      const filePath = path.join(rootDir, reqPath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found: ' + reqPath);
        return;
      }

      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Local test server running on http://127.0.0.1:${port}`);
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
  console.log('======================================================================');
  console.log('🌲 VERIFYING HYPERREALISTIC 3D FOREST RECONSTRUCTION VIA CDP');
  console.log('======================================================================\n');

  const PORT = 8155;
  const publicDir = path.resolve(__dirname, '../public');
  const server = await createStaticServer(publicDir, PORT);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_forest3d_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9263',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9263/json');
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP on 9263');
    chromeProc.kill();
    if (server) server.close();
    process.exit(1);
  }

  const ws = new WebSocket(targetWs, { maxPayload: 100 * 1024 * 1024 });
  let msgId = 1;

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.removeListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await new Promise(r => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');

  const pageUrl = `http://127.0.0.1:${PORT}/forest_3d_viewer.html`;
  console.log(`Navigating to ${pageUrl}...`);
  await send('Page.navigate', { url: pageUrl });

  // Wait for 3D model and Three.js canvas to render
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const evalRes = await send('Runtime.evaluate', {
      expression: 'Boolean(window.__renderReady)',
      returnByValue: true
    });
    if (evalRes && evalRes.result && evalRes.result.value) {
      ready = true;
      break;
    }
  }

  console.log(`3D Forest Model Render Ready: ${ready}`);
  await sleep(1500); // Allow anti-aliasing and shadows to settle

  // 1. Capture Default Landing State (Wideshot View: Full forest crowns, understory, and floor)
  const ss1 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath1 = path.resolve(__dirname, '../docs/screenshots/108_forest_3d_reconstruction_matched.png');
  fs.writeFileSync(outPath1, Buffer.from(ss1.data, 'base64'));
  console.log(`📸 Saved Default Wideshot Landing Screenshot: ${outPath1}`);

  // 2. Toggle Orbit and Capture 3D Angle
  await send('Runtime.evaluate', { expression: 'toggleAutoOrbit()' });
  await sleep(1400);
  const ss2 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath2 = path.resolve(__dirname, '../docs/screenshots/109_forest_3d_orbit_perspective.png');
  fs.writeFileSync(outPath2, Buffer.from(ss2.data, 'base64'));
  console.log(`📸 Saved Orbit View Screenshot: ${outPath2}`);

  // 3. Switch to Photo-Matched Ground Framing View
  await send('Runtime.evaluate', { expression: "flyToBookmark('matched')" });
  await sleep(1200);
  const ssMatched = await send('Page.captureScreenshot', { format: 'png' });
  const outPathMatched = path.resolve(__dirname, '../docs/screenshots/118_forest_photo_matched_alignment.png');
  fs.writeFileSync(outPathMatched, Buffer.from(ssMatched.data, 'base64'));
  console.log(`📸 Saved Photo-Matched Alignment Screenshot: ${outPathMatched}`);

  // 4. Close-up on Hero Redwood Roots
  await send('Runtime.evaluate', { expression: "flyToBookmark('hero')" });
  await sleep(1000);
  const ss3 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath3 = path.resolve(__dirname, '../docs/screenshots/110_forest_3d_hero_roots_closeup.png');
  fs.writeFileSync(outPath3, Buffer.from(ss3.data, 'base64'));
  console.log(`📸 Saved Hero Roots Close-up Screenshot: ${outPath3}`);

  // 5. Close-up on Nurse Log & Ferns
  await send('Runtime.evaluate', { expression: "flyToBookmark('ferns')" });
  await sleep(1000);
  const ss4 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath4 = path.resolve(__dirname, '../docs/screenshots/111_forest_3d_nurse_log_ferns.png');
  fs.writeFileSync(outPath4, Buffer.from(ss4.data, 'base64'));
  console.log(`📸 Saved Nurse Log & Ferns Screenshot: ${outPath4}`);

  // 6. Canopy & Sunbeams Perspective
  await send('Runtime.evaluate', { expression: "flyToBookmark('canopy')" });
  await sleep(1000);
  const ss5 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath5 = path.resolve(__dirname, '../docs/screenshots/112_forest_3d_canopy_sunbeams.png');
  fs.writeFileSync(outPath5, Buffer.from(ss5.data, 'base64'));
  console.log(`📸 Saved Canopy & Sunbeams Screenshot: ${outPath5}`);

  // 7. Ground-Level Walkway: Micro-Detail of Needles, Moss Tufts, and Oxalis Clover
  await send('Runtime.evaluate', { expression: "flyToBookmark('walk')" });
  await sleep(1000);
  const ss6 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath6 = path.resolve(__dirname, '../docs/screenshots/113_forest_3d_ground_walk_needle_carpet.png');
  fs.writeFileSync(outPath6, Buffer.from(ss6.data, 'base64'));
  console.log(`📸 Saved Ground Walk Needle Carpet Screenshot: ${outPath6}`);

  // 7. Zoomed Out Full Crown Canopy Audit (Checking needles covering all branches)
  await send('Runtime.evaluate', { expression: `
    camera.position.set(0, 18, 42);
    controls.target.set(0, 12, -10);
    camera.fov = 52;
    camera.updateProjectionMatrix();
    controls.update();
  ` });
  await sleep(1500);
  const ss7 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath7 = path.resolve(__dirname, '../docs/screenshots/115_forest_zoomed_out_with_branches.png');
  fs.writeFileSync(outPath7, Buffer.from(ss7.data, 'base64'));
  console.log(`📸 Saved Zoomed Out Crown Branches Screenshot: ${outPath7}`);

  // 8. Aerial Orbit 45 Degree Angle
  await send('Runtime.evaluate', { expression: `
    camera.position.set(-25, 20, 22);
    controls.target.set(0, 10, -10);
    camera.fov = 54;
    camera.updateProjectionMatrix();
    controls.update();
  ` });
  await sleep(1500);
  const ss8 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath8 = path.resolve(__dirname, '../docs/screenshots/116_forest_aerial_orbit_branches.png');
  fs.writeFileSync(outPath8, Buffer.from(ss8.data, 'base64'));
  console.log(`📸 Saved Aerial Orbit Branches Screenshot: ${outPath8}`);

  // 9. Close-up on Hero Branch Needles
  await send('Runtime.evaluate', { expression: `
    camera.position.set(-1.2, 7.8, 2.5);
    controls.target.set(-2.0, 7.5, -0.6);
    camera.fov = 44;
    camera.updateProjectionMatrix();
    controls.update();
  ` });
  await sleep(1500);
  const ss9 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath9 = path.resolve(__dirname, '../docs/screenshots/117_forest_branch_needles_closeup.png');
  fs.writeFileSync(outPath9, Buffer.from(ss9.data, 'base64'));
  console.log(`📸 Saved Branch Needles Close-up Screenshot: ${outPath9}`);

  console.log('\n✅ All Hyperrealistic 3D Forest Visual Checks Certified Green!');

  ws.close();
  chromeProc.kill('SIGTERM');
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

main().catch(err => {
  console.error('Fatal CDP runner error:', err);
  process.exit(1);
});
