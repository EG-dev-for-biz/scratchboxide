const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const HTTP_PORT = 8154;
const CDP_PORT = 9274;
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const SHOT_DIR = path.resolve(__dirname, '../docs/screenshots');

if (!fs.existsSync(SHOT_DIR)) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.splat': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream'
};

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

const server = http.createServer((req, res) => {
  let reqPath = decodeURI((req.url || '/').split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/red_rocks_performer_demo.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
});

async function main() {
  await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));
  console.log(`[Server] Static server running on http://127.0.0.1:${HTTP_PORT}`);

  const tmpDir = fs.mkdtempSync('/tmp/chrome_red_rocks_cdp_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 40; i++) {
    try {
      await sleep(250);
      const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
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

  async function captureShot(url, filename) {
    console.log(`\n📸 Navigating to ${url}...`);
    await sendCdp('Page.navigate', { url });

    // Wait until Google 3D Tiles, 3DGS Venue, and Performer Mesh are completely loaded and rendered
    console.log('⏳ Waiting for Google 3D Tiles, 3DGS Venue and 3D Performer to load and render...');
    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      const res = await sendCdp('Runtime.evaluate', {
        expression: 'Boolean(window.__redRocksReady && window.__venueReady && window.__performerReady && typeof renderer !== "undefined" && renderer.info.render.frame > 15)'
      });
      if (res && res.result && res.result.value === true) {
        ready = true;
        break;
      }
    }
    // Allow an extra 2.0s for WebGL textures, splats & shadows to fully settle
    await sleep(2000);

    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const outPath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(shotRes.data, 'base64'));
    console.log(`✅ Saved screenshot: ${filename} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
  }

  try {
    // 1. VIP Front Row View in full 3DGS Venue environment with 3D Mesh performer
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?cam=vip_front&mode=mesh&env=3dgs_venue`,
      '65_red_rocks_photoreal_splats_vip_front.png'
    );

    // 2. Mix Board (FOH) Soundboard view overlooking 3DGS red sandstone canyon & seating bowl with 3D Mesh performer
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?cam=mix_board&mode=mesh&env=3dgs_venue`,
      '66_red_rocks_photoreal_splats_mix_board.png'
    );

    // 3. Aerial Drone Survey (Complete 3.06M Gaussian splat venue reconstruction) with 3D Mesh performer
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?cam=aerial_survey&mode=mesh&env=3dgs_venue`,
      '67_red_rocks_photoreal_splats_aerial_drone.png'
    );

    // 4. Top-Down High-Altitude Complete District Survey (Full 450m Geodetic Terrain Coverage)
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?cam=top_down&mode=mesh&env=3dgs_venue`,
      '68_red_rocks_photoreal_splats_top_down.png'
    );

    // 5. Full District Seamless Composite: 3DGS Venue Foreground + Google 3D Tiles Background
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?cam=top_down&mode=mesh&env=composite_photoreal`,
      '69_red_rocks_photoreal_full_district_composite.png'
    );

    // 6. 3D Spline Flight Trajectory Keyframe 1: Stage Deck & Performer (flightT = 0.00)
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?flightT=0.00&mode=mesh&env=3dgs_venue`,
      '85_red_rocks_flight_frame_01_deck_sweep.png'
    );

    // 7. 3D Spline Flight Trajectory Keyframe 2: Wing & Under-Canopy Upward Banking (flightT = 0.20)
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?flightT=0.20&mode=mesh&env=3dgs_venue`,
      '86_red_rocks_flight_frame_02_under_canopy.png'
    );

    // 8. 3D Spline Flight Trajectory Keyframe 3: Backstage Chute & Creation Rock Face (flightT = 0.40)
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?flightT=0.40&mode=mesh&env=3dgs_venue`,
      '87_red_rocks_flight_frame_03_creation_rock.png'
    );

    // 9. 3D Spline Flight Trajectory Keyframe 4: Raked Amphitheatre Seating Bowl Ascending Flight (flightT = 0.65)
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?flightT=0.65&mode=mesh&env=3dgs_venue`,
      '88_red_rocks_flight_frame_04_seating_climb.png'
    );

    // 10. 3D Spline Flight Trajectory Keyframe 5: High-Altitude Concourse & Monolith Ridge Survey (flightT = 0.85)
    await captureShot(
      `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?flightT=0.85&mode=mesh&env=3dgs_venue`,
      '89_red_rocks_flight_frame_05_aerial_apex.png'
    );

    console.log('\n🎉 ALL RED ROCKS PHOTOREAL GAUSSIAN SPLAT CAPTURES COMPLETE!');
  } finally {
    try { ws.close(); } catch (_) {}
    try { chromeProc.kill('SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
