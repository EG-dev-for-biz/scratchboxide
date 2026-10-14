const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9820 + Math.floor(Math.random() * 100);
const SERVER_PORT = 9334;
const RENDERS_DIR = path.resolve(__dirname, '../public/renders/colosseum');
const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('[VerifiedPlates] Starting static file server on port ' + SERVER_PORT);
  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${SERVER_PORT}`);
      let filePath = path.join(PUBLIC_DIR, decodeURIComponent(parsedUrl.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.glb': 'model/gltf-binary'
      };
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });

  await new Promise(r => server.listen(SERVER_PORT, '127.0.0.1', r));

  console.log('[VerifiedPlates] Launching Chrome...');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_plates_');

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', d => console.log('[Chrome stderr]', d.toString().trim()));
  chromeProc.stdout.on('data', d => console.log('[Chrome stdout]', d.toString().trim()));
  chromeProc.on('exit', code => console.log('[Chrome exit]', code));

  let targetWs = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      const pageTarget = res.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    chromeProc.kill('SIGKILL');
    server.close();
    throw new Error('Chrome connection failed');
  }

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

  try {
    const pageUrl = `http://127.0.0.1:${SERVER_PORT}/omnispatial_synthesis_demo.html`;
    console.log(`[VerifiedPlates] Navigating to ${pageUrl}...`);
    await sendCdp('Page.navigate', { url: pageUrl });
    await sleep(4000);

    // Disable auto-timers
    await sendCdp('Runtime.evaluate', {
      expression: `
        if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
        activeLocationKey = 'colosseum';
      `
    });

    // Ensure orbit 3D layout is active and load model once upfront
    console.log('[VerifiedPlates] Setting up 3D viewport and loading Stage 3 Master PBR model...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        document.querySelectorAll('.top-nav, .hud-panel, .bottom-hud, .model-viewer-controls-overlay').forEach(el => el.style.display = 'none');
        document.getElementById('sideBySideView').style.display = 'none';
        document.getElementById('wipeSliderView').style.display = 'none';
        document.getElementById('loupeViewerLayout').style.display = 'none';

        const orbitLayout = document.getElementById('orbit3dLayout');
        orbitLayout.style.display = 'block';
        orbitLayout.style.position = 'fixed';
        orbitLayout.style.inset = '0';
        orbitLayout.style.zIndex = '999999';

        const mv = document.getElementById('mainModelViewer');
        if (typeof mv.dismissPoster === 'function') mv.dismissPoster();
        mv.removeAttribute('poster');
        mv.removeAttribute('bounds');
        mv.setAttribute('min-camera-orbit', 'auto auto 5m');
        mv.setAttribute('max-camera-orbit', 'auto auto 2000m');
        mv.setAttribute('min-field-of-view', '5deg');
        mv.minCameraOrbit = 'auto auto 5m';
        mv.maxCameraOrbit = 'auto auto 2000m';
        mv.minFieldOfView = '5deg';
        if (mv.shadowRoot) {
          const p = mv.shadowRoot.querySelector('#default-poster, [name="poster"], .slot.poster');
          if (p) p.style.display = 'none';
        }
        mv.removeAttribute('auto-rotate');
        mv.autoRotate = false;
        mv.setAttribute('camera-orbit', '-38deg 58deg 540m');
        mv.setAttribute('camera-target', '0m 10m 0m');
        mv.setAttribute('field-of-view', '32deg');
        mv.cameraOrbit = '-38deg 58deg 540m';
        mv.cameraTarget = '0m 10m 0m';
        mv.fieldOfView = '32deg';

        if (!mv.src || !mv.src.includes('colosseum_stage3_master_pbr.glb')) {
          mv.src = '/models/colosseum_stage3_master_pbr.glb';
        }
      `
    });

    // Poll until model loaded
    console.log('[VerifiedPlates] Waiting for model to load and GPU textures to upload...');
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const res = await sendCdp('Runtime.evaluate', {
        expression: `document.getElementById('mainModelViewer').loaded === true`,
        returnByValue: true
      });
      if (res && res.result && res.result.value === true) break;
    }
    await sleep(4000); // Wait for GPU PBR pipeline to fully compile

    async function renderAngle(orbit, target, fov, filename, label) {
      console.log(`[VerifiedPlates] Rendering ${label} (${filename})...`);
      const camCheck = await sendCdp('Runtime.evaluate', {
        expression: `
          (() => {
            const mv = document.getElementById('mainModelViewer');
            if (typeof mv.dismissPoster === 'function') mv.dismissPoster();
            mv.removeAttribute('poster');
            mv.removeAttribute('bounds');
            mv.setAttribute('min-camera-orbit', 'auto auto 5m');
            mv.setAttribute('max-camera-orbit', 'auto auto 2000m');
            mv.setAttribute('min-field-of-view', '5deg');
            mv.minCameraOrbit = 'auto auto 5m';
            mv.maxCameraOrbit = 'auto auto 2000m';
            mv.minFieldOfView = '5deg';
            if (mv.shadowRoot) {
              const p = mv.shadowRoot.querySelector('#default-poster, [name="poster"], .slot.poster');
              if (p) p.style.display = 'none';
            }
            mv.setAttribute('camera-orbit', '${orbit}');
            mv.setAttribute('camera-target', '${target}');
            mv.setAttribute('field-of-view', '${fov}');
            mv.cameraOrbit = '${orbit}';
            mv.cameraTarget = '${target}';
            mv.fieldOfView = '${fov}';
            if (typeof mv.jumpCameraToGoal === 'function') mv.jumpCameraToGoal();
            const curOrbit = mv.getCameraOrbit ? mv.getCameraOrbit() : null;
            const curTarget = mv.getCameraTarget ? mv.getCameraTarget() : null;
            return { curOrbit, curTarget };
          })()
        `,
        returnByValue: true
      });
      console.log(`     Cam check:`, JSON.stringify(camCheck?.result?.value));
      await sleep(2500); // Allow camera jump and progressive rendering

      const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
      const buf = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(RENDERS_DIR, filename), buf);
      fs.writeFileSync(path.join(ARTIFACT_DIR, filename), buf);
      console.log(`     ✅ Saved ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
    }

    // 1. Overview Orbit (Colosseum, Basalt Road, Parco del Celio, Intact Background Buildings)
    await renderAngle('-38deg 58deg 540m', '0m 10m 0m', '32deg', 'clean_stage3_master.png', 'Overview Master Orbit');

    // 2. Telephoto Close-up on the Road & Beveled Curbs
    await renderAngle('-25deg 72deg 75m', '-40m 5m -20m', '24deg', 'proof_crop_road_basalt_curbs.png', 'Road & Beveled Curbs Close-up');

    // 3. Telephoto Close-up on Parco del Celio Botanical Trees & Slender Cypresses
    await renderAngle('0deg 75deg 70m', '20m 10m 95m', '28deg', 'proof_crop_botanical_cypress_pines.png', 'Botanical Trees & Cypresses Close-up');

    // 4. Telephoto Close-up on Arch of Constantine showing open undercuts
    await renderAngle('115deg 78deg 65m', '-140.6m 12m -47.1m', '24deg', 'proof_crop_arch_constantine_undercut.png', 'Arch of Constantine Undercut Close-up');

    // 5. Telephoto Close-up on Colosseum Travertine Facade & Interior Cavea (Remade from Street View Travertine)
    await renderAngle('-45deg 65deg 90m', '15m 25m -15m', '24deg', 'proof_crop_interior_delighting.png', 'Colosseum Interior & Travertine Facade Close-up');

    // 6. Return camera to Overview Master Orbit before un-hiding HUD
    await renderAngle('-38deg 58deg 540m', '0m 10m 0m', '32deg', 'clean_stage3_master.png', 'Overview Master Orbit');

    // 7. Now render full interactive app screenshot in Orbit Mode with UI visible
    console.log('[VerifiedPlates] Capturing App Interface with 3D Orbit View (with HUD)...');
    await sendCdp('Runtime.evaluate', {
      expression: `
        const orbitLayout = document.getElementById('orbit3dLayout');
        orbitLayout.style.position = '';
        orbitLayout.style.inset = '';
        orbitLayout.style.zIndex = '';
        orbitLayout.style.display = 'block';

        document.querySelectorAll('.top-nav, .hud-panel, .bottom-hud, .model-viewer-controls-overlay').forEach(el => {
          el.style.display = '';
        });

        document.getElementById('sideBySideView').style.display = 'none';
        document.getElementById('wipeSliderView').style.display = 'none';
        document.getElementById('loupeViewerLayout').style.display = 'none';

        document.getElementById('modeSideBySide').classList.remove('active');
        document.getElementById('modeWipe').classList.remove('active');
        document.getElementById('modeLoupe').classList.remove('active');
        document.getElementById('modeOrbit').classList.add('active');
      `
    });
    await sleep(2500);
    const shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'colosseum_clean_app_3d_orbit_verified.png'), buf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'colosseum_clean_app_3d_orbit_verified.png'), buf);
    console.log(`     ✅ Saved colosseum_clean_app_3d_orbit_verified.png (${(buf.length / 1024).toFixed(1)} KB)`);

    console.log('[VerifiedPlates] All verified screenshots successfully rendered!');
  } finally {
    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error('[VerifiedPlates] Error:', err);
  process.exit(1);
});
