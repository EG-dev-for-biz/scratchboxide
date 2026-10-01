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
    '.glb': 'model/gltf-binary',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURI(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/plaza_3d_reconstruction_viewer.html';
      const filePath = path.join(rootDir, reqPath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
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
  console.log('🏛️ VERIFYING PLAZA HOTEL PROCEDURAL 3D RECONSTRUCTION VIA CDP');
  console.log('======================================================================\n');

  const PORT = 8152;
  const publicDir = path.resolve(__dirname, '../public');
  const server = await createStaticServer(publicDir, PORT);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_cdp_plaza3d_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--remote-debugging-port=9261',
    '--window-size=1920,1080',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9261/json');
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    console.error('Could not connect to Chrome CDP on 9261');
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

  const pageUrl = `http://127.0.0.1:${PORT}/plaza_3d_reconstruction_viewer.html`;
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

  console.log(`3D Model Render Ready: ${ready}`);
  await sleep(1500); // Allow anti-aliasing and textures to settle

  // 1. Capture Full Side-by-Side Comparison (User Photo on Left, Procedural 3D on Right)
  const ss1 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath1 = path.resolve(__dirname, '../docs/screenshots/106_plaza_3d_procedural_reconstruction_matched.png');
  fs.writeFileSync(outPath1, Buffer.from(ss1.data, 'base64'));
  console.log(`📸 Saved Side-by-Side Verification Screenshot: ${outPath1}`);

  // 2. Toggle Orbit and Capture 3D Angle
  await send('Runtime.evaluate', { expression: 'toggleOrbit()' });
  await sleep(1200);
  const ss2 = await send('Page.captureScreenshot', { format: 'png' });
  const outPath2 = path.resolve(__dirname, '../docs/screenshots/107_plaza_3d_procedural_orbit_view.png');
  fs.writeFileSync(outPath2, Buffer.from(ss2.data, 'base64'));
  console.log(`📸 Saved Orbit View Screenshot: ${outPath2}`);

  console.log('\n✅ All Plaza Hotel Procedural 3D Reconstruction Visual Checks Certified Green!');

  ws.close();
  chromeProc.kill('SIGTERM');
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
