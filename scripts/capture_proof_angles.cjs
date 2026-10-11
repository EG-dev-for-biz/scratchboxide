const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931';
const OUTPUT_DIR = '/Users/eligreen/dev/scratchbox-ide-master/public/screenshots';

async function main() {
  // Discover running Chrome CDP
  const targets = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9734/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  }).catch(async () => {
    // If 9734 is down, check 9222
    return new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9222/json', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
  });

  const page = targets.find(t => t.type === 'page' && t.url.includes('omnispatial_synthesis_demo.html')) || targets.find(t => t.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) {
    console.error('No suitable Chrome CDP page found');
    process.exit(1);
  }

  console.log(`[Proof Capture] Connecting to: ${page.webSocketDebuggerUrl}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);

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

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function takeShot(filename, desc) {
    console.log(`[Proof Capture] Capturing ${filename}: ${desc}...`);
    const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    const buf = Buffer.from(shotRes.data, 'base64');
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), buf);
    fs.writeFileSync(path.join(ARTIFACT_DIR, filename), buf);
    console.log(`   -> Saved ${filename} (${(buf.length / 1024).toFixed(1)} KB)`);
  }

  // 1. Switch to 3D Orbit View and disable auto-rotate
  await sendCdp('Runtime.evaluate', {
    expression: `
      setMode('orbit');
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.removeAttribute('auto-rotate');
        mv.src = '/models/colosseum_stage3_master_pbr.glb';
      }
    `
  });
  await sleep(4000);

  // 2. Vantage A: Ground-Level Human View looking north at Via Nicola Salvi palazzo
  console.log('[Proof Capture] Setting camera to Ground-Level Facade View...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.cameraOrbit = '20deg 82deg 180m';
        mv.cameraTarget = '40m 22m -110m';
        if (mv.jumpCameraToGoal) mv.jumpCameraToGoal();
      }
    `
  });
  await sleep(3500);
  await takeShot('colosseum_proof_ground_facade_curtain_wall_fix.png', 'Via Nicola Salvi Ground-Level Facade & Curtain Wall Excision');

  // 3. Vantage B: Top-Down Orthographic Plan View looking directly down at Colosseum + Parco del Celio + Colle Oppio
  console.log('[Proof Capture] Setting camera to Orthographic Top-Down Plan View...');
  await sendCdp('Runtime.evaluate', {
    expression: `
      const mv = document.getElementById('mainModelViewer');
      if (mv) {
        mv.cameraOrbit = '0deg 2deg 520m';
        mv.cameraTarget = '16m 20m -21m';
        if (mv.jumpCameraToGoal) mv.jumpCameraToGoal();
      }
    `
  });
  await sleep(3500);
  await takeShot('colosseum_proof_orthographic_plan_celio_coverage.png', 'Clean Circular Boundary & Complete Canopy Coverage');

  ws.close();
  console.log('[Proof Capture] Finished successfully!');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
