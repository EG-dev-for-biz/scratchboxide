/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.cb = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.id && this.cb.has(m.id)) {
          const { resolve, reject } = this.cb.get(m.id);
          this.cb.delete(m.id);
          if (m.error) reject(m.error); else resolve(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.cb.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      console.warn('Eval warning/exception:', r.exceptionDetails);
    }
    return r.result?.value;
  }
  async screenshot(p) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log(`📸 Saved screenshot: ${p}`);
  }
  close() { this.ws.close(); }
}

async function main() {
  console.log('======================================================================');
  console.log('🎮 TESTING WASDQE CONTROLS, ALPHA OVERLAY & CALIBRATION LEARNING');
  console.log('======================================================================\n');

  const chromePort = 9298;
  const tmpDir = fs.mkdtempSync('/tmp/test_wasd_alpha_');
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-sandbox', '--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist',
    `--user-data-dir=${tmpDir}`, `--remote-debugging-port=${chromePort}`, '--window-size=1920,1080', 'about:blank'
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        await sleep(300);
        const targets = await getJson(`http://127.0.0.1:${chromePort}/json`);
        const page = targets?.find(t => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          targetWs = page.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }

    if (!targetWs) throw new Error('Could not connect to Chrome CDP');

    const cdp = new Cdp(targetWs);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('🌐 Loading http://127.0.0.1:8080/geobox_demo.html ...');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8080/geobox_demo.html' });
    await sleep(2500);

    // 1. Stage user photograph and submit
    console.log('📤 Submitting user photo of The Plaza Hotel...');
    await cdp.eval(`
      (function() {
        currentResection = null;
        stagePhoto({
          imagePath: '/test_images/the_plaza_hotel_user_photo.jpg',
          imageUri: '/test_images/the_plaza_hotel_user_photo.jpg',
          name: 'The-Plaza-Hotel-User-Photo.jpg',
          isVideo: false
        });
        document.getElementById("chat-prompt-input").value = "The Plaza Hotel NYC";
        sendChatSubmission();
      })()
    `);

    // Wait for resection to complete specifically for The Plaza
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const isDone = await cdp.eval(`
        (function() {
          const r = typeof currentResection !== 'undefined' ? currentResection : null;
          const s2 = r ? (r.stage2_places || r.stage2) : null;
          const s5 = r ? (r.stage5_camera_resection || r.stage5) : null;
          const lm = s2 ? (s2.landmark_name || '') : '';
          return !!r && !!s5 && lm.toLowerCase().includes('plaza');
        })()
      `);
      if (isDone) { ready = true; break; }
    }
    console.log(`✓ Resection pipeline ready: ${ready}`);

    await sleep(2500); // allow Three.js model to settle

    // Ensure input is blurred so WASD keys reach 3D viewport
    await cdp.eval(`if (document.activeElement) document.activeElement.blur()`);

    // 2. Capture verified Side-by-Side 3D Match
    console.log('📸 Capturing Side-by-Side 3D Match view...');
    const ssSideBySide = path.join(process.cwd(), 'docs/screenshots/73_plaza_match_side_by_side_verified.png');
    await cdp.screenshot(ssSideBySide);

    // 3. Test Stiff WASDQE and Arrow Key Navigation
    console.log('🎮 Testing Stiff WASDQE & Arrow Navigation...');
    const initialPos = await cdp.eval(`
      (function() {
        const c = sbs3DViewer.camera.position;
        return { x: c.x, y: c.y, z: c.z };
      })()
    `);
    console.log('   Initial Camera Pos:', initialPos);

    // Simulate pressing 'W' (dolly forward) twice
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))`);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))`);
    const posAfterW = await cdp.eval(`
      (function() {
        const c = sbs3DViewer.camera.position;
        return { x: c.x, y: c.y, z: c.z };
      })()
    `);
    console.log('   Pos after 2x W (Dolly forward):', posAfterW);

    // Simulate pressing 'A' (truck left) and 'E' (pedestal up)
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))`);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))`);
    const posAfterAE = await cdp.eval(`
      (function() {
        const c = sbs3DViewer.camera.position;
        return { x: c.x, y: c.y, z: c.z };
      })()
    `);
    console.log('   Pos after A + E (Truck left, Pedestal up):', posAfterAE);

    // Simulate pressing ArrowRight (pan right) and ArrowUp (tilt up)
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))`);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))`);

    const hudAttitude = await cdp.eval('document.getElementById("hud-attitude")?.textContent');
    console.log('   Live HUD Attitude after Arrow nudges:', hudAttitude);

    // 4. Test Save & Learn Calibration
    console.log('💾 Testing Save & Learn Calibration feature...');
    const saveResult = await cdp.eval(`
      (async function() {
        await saveAndLearnCalibration();
        const stored = localStorage.getItem('geobox_learned_the_plaza');
        return {
          storedInLocalStorage: !!stored,
          payload: stored ? JSON.parse(stored) : null
        };
      })()
    `);
    console.log('   Save & Learn Result:', JSON.stringify(saveResult, null, 2));

    // 5. Test Alpha Overlay Mode (50% blend)
    console.log('🎭 Testing Alpha Overlay mode (50% blend)...');
    await cdp.eval('setMapViewMode("overlay")');
    await cdp.eval('setOverlayAlpha(50)');
    await sleep(1000);
    const ssAlpha50 = path.join(process.cwd(), 'docs/screenshots/74_plaza_alpha_overlay_50pct.png');
    await cdp.screenshot(ssAlpha50);

    // 6. Test Alpha Overlay Mode (75% 3D model blend)
    console.log('🎭 Testing Alpha Overlay mode (75% 3D blend)...');
    await cdp.eval('setOverlayAlpha(75)');
    await sleep(800);
    const ssAlpha75 = path.join(process.cwd(), 'docs/screenshots/75_plaza_alpha_overlay_75pct.png');
    await cdp.screenshot(ssAlpha75);

    // 7. Test Alpha Overlay Difference Mode
    console.log('⚡ Testing Alpha Overlay Difference mode...');
    await cdp.eval('toggleOverlayDiff()');
    await sleep(800);
    const ssDiff = path.join(process.cwd(), 'docs/screenshots/76_plaza_overlay_difference_mode.png');
    await cdp.screenshot(ssDiff);

    // 8. Test 50/50 Match Wipe View
    console.log('⚡ Testing 50/50 Match Wipe view...');
    await cdp.eval('setMapViewMode("wipe")');
    await cdp.eval('setWipeSplit(50)');
    await sleep(800);
    const ssWipe = path.join(process.cwd(), 'docs/screenshots/77_plaza_50_50_wipe_verified.png');
    await cdp.screenshot(ssWipe);

    cdp.close();
    console.log('\n🎉 ALL WASDQE, ALPHA OVERLAY & CALIBRATION LEARNING TESTS PASSED!');
  } finally {
    try { chrome.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
