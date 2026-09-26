const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');

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

class CdpConnection {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.callbacks.has(msg.id)) {
          const { resolve, reject } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async screenshot(outPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
    console.log(`📸 Saved screenshot: ${outPath}`);
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  const chromePort = 9285;
  const tmpDir = fs.mkdtempSync('/tmp/chrome_plaza_cam_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    `--remote-debugging-port=${chromePort}`,
    '--window-size=1280,720',
    'about:blank'
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        await sleep(300);
        const targets = await getJson(`http://127.0.0.1:${chromePort}/json`);
        const pageTarget = targets && targets.find(t => t.type === 'page');
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          targetWs = pageTarget.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }

    const cdp = new CdpConnection(targetWs);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8080/geobox_demo.html' });
    await sleep(2500);

    // Load Plaza Hotel model directly into sbs3DViewer and test candidate camera poses
    console.log('Testing Plaza Hotel Camera Poses in Three.js...');
    const result = await cdp.eval(`
      new Promise((resolve, reject) => {
        window.currentResection = {
          stage2_places: { landmark_name: "The Plaza Hotel, NYC" },
          stage5_camera_resection: { heading_deg: 215.3, pitch_deg: 18.0, standoff_distance_m: 65.0 }
        };

        const sbs = window.sbs3DViewer;
        const loader = new THREE.GLTFLoader();
        loader.load(
          "/models/google_tiles_textured_area.glb",
          (gltf) => {
            // Remove previous models
            const toRemove = [];
            sbs.scene.traverse(c => {
              if (c.isMesh) toRemove.push(c);
            });
            toRemove.forEach(m => {
              if (m.parent) m.parent.remove(m);
            });

            sbs.scene.add(gltf.scene);

            // Set authentic daylight atmosphere for NYC
            sbs.scene.background = new THREE.Color(0xdce3eb);

            // Candidate Street Level Looking Upward at Plaza Facade & Turret:
            // Camera at Grand Army Plaza sidewalk, looking NW up at corner turret
            const camPos = new THREE.Vector3(56.0, 2.0, 36.0);
            const targetPos = new THREE.Vector3(26.0, 48.0, 8.0);

            sbs.camera.position.copy(camPos);
            sbs.camera.lookAt(targetPos);
            sbs.controls.target.copy(targetPos);
            sbs.camera.fov = 52.0;
            sbs.camera.updateProjectionMatrix();
            sbs.controls.update();
            sbs.renderNow();

            resolve({
              loaded: true,
              pos: [sbs.camera.position.x, sbs.camera.position.y, sbs.camera.position.z],
              target: [sbs.controls.target.x, sbs.controls.target.y, sbs.controls.target.z]
            });
          },
          undefined,
          reject
        );
      })
    `);
    console.log('Render result:', result);
    await sleep(1000);

    const outPath = path.resolve(__dirname, '../docs/screenshots/74_plaza_street_view_camera_pose.png');
    await cdp.screenshot(outPath);
    console.log(`Saved screenshot to ${outPath}`);

    cdp.close();
  } finally {
    try { chromeProc.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
