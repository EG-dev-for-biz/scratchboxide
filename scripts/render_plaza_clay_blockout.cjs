const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');

const PORT = 8145;
const publicDir = path.resolve(__dirname, '../public');
const framesDir = path.join(publicDir, 'videos/frames_clay_plaza');
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

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
  console.log('========================================================================');
  console.log('🏛️ RENDERING 361-FRAME PLAZA HOTEL STUDIO GREY CLAY BLOCKOUT VIDEO');
  console.log('========================================================================');

  let framesWritten = 0;
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.png': 'image/png',
    '.jpg': 'image/jpeg'
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/save-frame') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { index, data } = JSON.parse(body);
          const base64Data = data.replace(/^data:image\/jpeg;base64,/, '');
          const filename = path.join(framesDir, `frame_${String(index).padStart(4, '0')}.jpg`);
          fs.writeFileSync(filename, Buffer.from(base64Data, 'base64'));
          framesWritten++;
          if (framesWritten % 30 === 0 || framesWritten === 361) {
            console.log(`💾 Saved clay frame ${framesWritten} / 361`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500);
          res.end(e.message);
        }
      });
      return;
    }

    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/' || reqPath === '') reqPath = '/render_plaza_clay_runner.html';
    const filePath = path.join(publicDir, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
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

  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`Local runner server started on http://127.0.0.1:${PORT}`);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_clay_render_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    '--remote-debugging-port=9271',
    `--user-data-dir=${tmpDir}`,
    '--window-size=1280,720',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 40; i++) {
    try {
      await sleep(300);
      const targets = await getJson('http://127.0.0.1:9271/json');
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) throw new Error('Could not connect to Chrome on port 9271');
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
  await sendCdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/render_plaza_clay_runner.html` });

  console.log('⏳ Rendering frames in WebGL...');
  let done = false;
  while (!done) {
    await sleep(500);
    const evalRes = await sendCdp('Runtime.evaluate', { expression: 'window.__DONE__' });
    if (evalRes && evalRes.result && evalRes.result.value === true) {
      done = true;
    }
    if (framesWritten >= 361) {
      done = true;
    }
  }

  console.log(`✅ All ${framesWritten} frames rendered! Closing Chrome...`);
  ws.close();
  chromeProc.kill('SIGKILL');
  server.close();

  // Encode with ffmpeg
  const outputClayVideo = path.join(publicDir, 'videos/plaza_hotel_clay_blockout_camera.mp4');
  console.log('🎬 Encoding video via ffmpeg to:', outputClayVideo);
  execSync(`ffmpeg -y -framerate 24 -i "${path.join(framesDir, 'frame_%04d.jpg')}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 18 -movflags +faststart "${outputClayVideo}"`, { stdio: 'inherit' });

  // Update canonical blockout video
  const canonicalBlockout = path.join(publicDir, 'videos/plaza_hotel_blockout_camera.mp4');
  fs.copyFileSync(outputClayVideo, canonicalBlockout);
  console.log(`✅ Updated canonical blockout video: ${canonicalBlockout}`);

  // Extract 25 dense keyframe snapshots in clay mode
  console.log('📸 Extracting 25 dense keyframe snapshots in Studio Grey Clay mode...');
  execSync('node scripts/extract_dense_matchmove_keyframes.cjs', { stdio: 'inherit' });

  console.log('\n========================================================================');
  console.log('🎉 STUDIO GREY CLAY BLOCKOUT VIDEO & KEYFRAMES GENERATED SUCCESSFULLY!');
  console.log('========================================================================');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
