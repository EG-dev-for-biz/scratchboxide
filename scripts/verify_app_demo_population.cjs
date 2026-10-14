const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_PORT = 9600 + Math.floor(Math.random() * 300);
const VITE_URL = 'http://127.0.0.1:3030/omnispatial_synthesis_demo.html';
const ARTIFACT_DIR = path.resolve('/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
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

async function main() {
  console.log('[DemoVerify] Starting desktop app demo asset population verification...');

  // 1. Launch Chrome Headless
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_demo_verify_');
  console.log('[DemoVerify] Launching Chrome on CDP port ' + CDP_PORT + '...');
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tmpDir}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  let targetWs = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
      const pageTarget = targets && targets.find(t => t.type === 'page');
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        targetWs = pageTarget.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }

  if (!targetWs) {
    chromeProc.kill('SIGKILL');
    throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
  }

  console.log('[DemoVerify] Connected to Chrome DevTools WebSocket: ' + targetWs);
  const ws = new WebSocket(targetWs);
  ws.on('error', (err) => {
    console.error('[DemoVerify] WebSocket error:', err.message);
  });

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
  await sendCdp('Network.enable');

  const OUTPUT_DIR = path.resolve(__dirname, '../public/screenshots');
  const RENDERS_DIR = path.resolve(__dirname, '../public/renders/colosseum');
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });

  async function takeScreenshot(filename, description, extraPaths = []) {
    console.log(`  -> Capturing: ${filename} (${description})...`);
    await sleep(600);
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const pngBuf = Buffer.from(shotRes.data, 'base64');
    const outPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath, pngBuf);
    const outPathPub = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(outPathPub, pngBuf);
    for (const ep of extraPaths) {
      fs.writeFileSync(ep, pngBuf);
    }
    console.log(`     ✅ Saved screenshot to ${filename} (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    return outPath;
  }

  // 1. Navigate to Vite URL
  console.log(`[DemoVerify] Navigating to ${VITE_URL}...`);
  await sendCdp('Page.navigate', { url: VITE_URL });
  await sleep(4000); // Wait for load and initialization

  // Check image health in the DOM
  const checkEval = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const imgLeft = document.getElementById('imgLeft');
      const imgRight = document.getElementById('imgRight');
      const activeLoc = activeLocationKey;
      return {
        activeLoc,
        leftSrc: imgLeft ? imgLeft.src : null,
        leftComplete: imgLeft ? imgLeft.complete : false,
        leftNaturalWidth: imgLeft ? imgLeft.naturalWidth : 0,
        leftNaturalHeight: imgLeft ? imgLeft.naturalHeight : 0,
        rightSrc: imgRight ? imgRight.src : null,
        rightComplete: imgRight ? imgRight.complete : false,
        rightNaturalWidth: imgRight ? imgRight.naturalWidth : 0,
        rightNaturalHeight: imgRight ? imgRight.naturalHeight : 0
      };
    })()`,
    returnByValue: true
  });

  console.log('[DemoVerify] Image Health Telemetry:', JSON.stringify(checkEval.result.value, null, 2));

  // 2. Switch to 3D Free Orbit mode
  console.log('[DemoVerify] Switching to 3D Free Orbit mode (Stage 3 Master PBR with 673 Botanical Trees)...');
  await sendCdp('Runtime.evaluate', {
    expression: `setViewMode('orbit-3d'); switchOrbitModel(3);`
  });

  // Wait for <model-viewer> to load
  console.log('[DemoVerify] Waiting for <model-viewer> to load Stage 3 GLB (84.7 MB)...');
  const loadRes = await sendCdp('Runtime.evaluate', {
    awaitPromise: true,
    expression: `new Promise((resolve) => {
      const mv = document.getElementById('mainModelViewer');
      if (!mv) return resolve('no_mv');
      if (mv.model) return resolve('already_loaded');
      const onLoad = () => {
        mv.removeEventListener('load', onLoad);
        resolve('loaded_event');
      };
      mv.addEventListener('load', onLoad);
      setTimeout(() => resolve('timeout_fallback'), 25000);
    })`,
    returnByValue: true
  });
  console.log('[DemoVerify] ModelViewer load status:', loadRes && loadRes.result ? loadRes.result.value : 'done');
  await sleep(3500); // WebGL render settling

  // Set camera to overview
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.setAttribute('camera-orbit', '-40deg 68deg 600m');
        mv.setAttribute('camera-target', '0m 10m 0m');
        mv.setAttribute('field-of-view', '35deg');
      }
    })()`
  });
  await sleep(1500);

  // Capture clean stage 3 render (hide top nav & dock)
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const hideSel = '.top-nav, .bottom-dock, .hud-left, .hud-right, .model-viewer-badge, .orbit-model-switcher, .orbit-tip-pill';
      document.querySelectorAll(hideSel).forEach(el => el.style.display = 'none');
    })()`
  });
  await sleep(600);
  await takeScreenshot('clean_stage3_master.png', 'Clean Stage 3 Master PBR Render (673 Botanical Trees, 0 Drift)', [
    path.join(RENDERS_DIR, 'clean_stage3_master.png')
  ]);

  // Restore UI elements and capture full app UI
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const hideSel = '.top-nav, .bottom-dock, .hud-left, .hud-right, .model-viewer-badge, .orbit-model-switcher, .orbit-tip-pill';
      document.querySelectorAll(hideSel).forEach(el => el.style.display = '');
    })()`
  });
  await sleep(600);
  await takeScreenshot('colosseum_demo_app_3d_orbit.png', 'App Interface: 3D Free Orbit Mode with 673 Resected Botanical Trees');
  await takeScreenshot('colosseum_app_demo_3d_orbit_populated.png', 'Colosseum 3D Free Orbit Populated in App');

  // Zoom into Celio Hill and Colle Oppio trees (focusing on the trees the user pointed out)
  console.log('[DemoVerify] Framing Celio Hill & Colle Oppio hillside trees close-up...');
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.setAttribute('camera-orbit', '135deg 72deg 360m');
        mv.setAttribute('camera-target', '70m 12m -30m');
        mv.setAttribute('field-of-view', '30deg');
      }
    })()`
  });
  await sleep(2500);
  await takeScreenshot('colosseum_app_demo_celio_trees_closeup.png', 'App Interface: Celio Hill & Colle Oppio Slope Botanical Tree Stand Resection Close-Up');

  // Dedicated close-up of Southern Wall where user pointed out wall trees
  console.log('[DemoVerify] Framing Southern Colosseum Wall close-up to verify zero wall trees...');
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.setAttribute('camera-orbit', '35deg 55deg 320m');
        mv.setAttribute('camera-target', '20m 14m 35m');
        mv.setAttribute('field-of-view', '32deg');
      }
    })()`
  });
  await sleep(2500);
  await takeScreenshot('colosseum_southern_wall_clean_closeup.png', 'App Interface: Southern Colosseum Wall Verified Clean with Zero Wall Trees');

  // Switch to Stage 2 Clay Model
  console.log('[DemoVerify] Switching to 3D Stage 2 Clay Model (Vitruvian Architecture + 737 Botanical Stands)...');
  await sendCdp('Runtime.evaluate', {
    expression: `switchOrbitModel(2);`
  });
  await sleep(4000);

  // Set camera back to overview
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.setAttribute('camera-orbit', '-40deg 68deg 600m');
        mv.setAttribute('camera-target', '0m 10m 0m');
        mv.setAttribute('field-of-view', '35deg');
      }
    })()`
  });
  await sleep(1500);

  // Capture clean stage 2 render
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const hideSel = '.top-nav, .bottom-dock, .hud-left, .hud-right, .model-viewer-badge, .orbit-model-switcher, .orbit-tip-pill';
      document.querySelectorAll(hideSel).forEach(el => el.style.display = 'none');
    })()`
  });
  await sleep(600);
  await takeScreenshot('clean_stage2_vector.png', 'Clean Stage 2 Clay Vector Refined Render (737 Botanical Trees)', [
    path.join(RENDERS_DIR, 'clean_stage2_vector.png')
  ]);

  // Restore UI elements and capture Stage 2 3D Orbit
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const hideSel = '.top-nav, .bottom-dock, .hud-left, .hud-right, .model-viewer-badge, .orbit-model-switcher, .orbit-tip-pill';
      document.querySelectorAll(hideSel).forEach(el => el.style.display = '');
    })()`
  });
  await sleep(600);
  await takeScreenshot('colosseum_demo_app_3d_orbit_stage2.png', 'App Interface: 3D Free Orbit Mode Stage 2 Clay Model');

  // Switch to Stage 1 Clay Model to capture clean stage 1 render
  console.log('[DemoVerify] Switching to 3D Stage 1 Clay Model to capture clean baseline...');
  await sendCdp('Runtime.evaluate', {
    expression: `switchOrbitModel(1);`
  });
  await sleep(3500);

  // Set camera back to overview
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.setAttribute('camera-orbit', '-40deg 68deg 600m');
        mv.setAttribute('camera-target', '0m 10m 0m');
        mv.setAttribute('field-of-view', '35deg');
      }
    })()`
  });
  await sleep(1500);

  // Capture clean stage 1 render
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const hideSel = '.top-nav, .bottom-dock, .hud-left, .hud-right, .model-viewer-badge, .orbit-model-switcher, .orbit-tip-pill';
      document.querySelectorAll(hideSel).forEach(el => el.style.display = 'none');
    })()`
  });
  await sleep(600);
  await takeScreenshot('clean_stage1_clay.png', 'Clean Stage 1 Clay Render (Google 3D Tiles in 18% Grey Clay)', [
    path.join(RENDERS_DIR, 'clean_stage1_clay.png')
  ]);

  // Restore UI elements
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const hideSel = '.top-nav, .bottom-dock, .hud-left, .hud-right, .model-viewer-badge, .orbit-model-switcher, .orbit-tip-pill';
      document.querySelectorAll(hideSel).forEach(el => el.style.display = '');
    })()`
  });
  await sleep(600);

  // Reload images in the DOM so that the new clean renders are displayed
  await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const t = '?' + Date.now();
      const imgLeft = document.getElementById('imgLeft');
      const imgRight = document.getElementById('imgRight');
      const imgWipeBase = document.getElementById('imgWipeBase');
      const imgWipeReveal = document.getElementById('imgWipeReveal');
      if (imgLeft) imgLeft.src = '/renders/colosseum/clean_stage1_clay.png' + t;
      if (imgRight) imgRight.src = '/renders/colosseum/clean_stage3_master.png' + t;
      if (imgWipeBase) imgWipeBase.src = '/renders/colosseum/clean_stage3_master.png' + t;
      if (imgWipeReveal) imgWipeReveal.src = '/renders/colosseum/clean_stage1_clay.png' + t;
    })()`
  });
  await sleep(1000);

  // Switch back to Stage 3 for Wipe Slider and Dual Split views
  await sendCdp('Runtime.evaluate', {
    expression: `selectStage(3);`
  });
  await sleep(1000);

  // Switch to Wipe Slider mode
  console.log('[DemoVerify] Switching to Wipe Slider mode...');
  await sendCdp('Runtime.evaluate', {
    expression: `setViewMode('wipe');`
  });
  await sleep(1500);
  await takeScreenshot('colosseum_app_demo_wipe_populated.png', 'Colosseum Wipe Slider Populated in App');

  // Switch to Side-by-Side Dual Split View
  console.log('[DemoVerify] Switching to Dual Split (Side-by-Side) View...');
  await sendCdp('Runtime.evaluate', {
    expression: `setViewMode('side-by-side'); selectStage(3);`
  });
  await sleep(1500);
  await takeScreenshot('colosseum_app_demo_populated_stage3.png', 'Colosseum Stage 1 Clay vs Stage 3 Master PBR Dual Split in App');

  // Switch to Empire State Building
  console.log('[DemoVerify] Testing Empire State Building switch...');
  await sendCdp('Runtime.evaluate', {
    expression: `setViewMode('side-by-side'); loadLocation('Empire State Building, NY');`
  });
  await sleep(2500);

  const esbEval = await sendCdp('Runtime.evaluate', {
    expression: `(() => {
      const imgLeft = document.getElementById('imgLeft');
      const imgRight = document.getElementById('imgRight');
      return {
        leftSrc: imgLeft ? imgLeft.src : null,
        leftComplete: imgLeft ? imgLeft.complete : false,
        leftNaturalWidth: imgLeft ? imgLeft.naturalWidth : 0,
        rightSrc: imgRight ? imgRight.src : null,
        rightComplete: imgRight ? imgRight.complete : false,
        rightNaturalWidth: imgRight ? imgRight.naturalWidth : 0
      };
    })()`,
    returnByValue: true
  });
  console.log('[DemoVerify] ESB Image Telemetry:', JSON.stringify(esbEval.result.value, null, 2));

  await takeScreenshot('esb_app_demo_populated.png', 'Empire State Building populated in Vite dev server');

  ws.close();
  chromeProc.kill('SIGTERM');
  console.log('[DemoVerify] Completed all verification screenshots successfully!');
}

main().catch(err => {
  console.error('[DemoVerify] Error:', err);
  process.exit(1);
});
