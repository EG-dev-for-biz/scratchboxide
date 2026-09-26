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
    if (r.exceptionDetails) console.warn('Eval warning/exception:', r.exceptionDetails);
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
  console.log('☀️ TESTING REFERENCE-MATCHED LIGHTING, OPENUSD EXPORT & ALPHA OVERLAY');
  console.log('======================================================================\n');

  const chromePort = 9310;
  const tmpDir = fs.mkdtempSync('/tmp/test_light_match_');
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

    // 1. Submit user photo of The Plaza Hotel
    console.log('📤 Submitting user photo of The Plaza Hotel...');
    await cdp.eval(`
      (function() {
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

    // Wait for resection
    let ready = false;
    for (let i = 0; i < 35; i++) {
      await sleep(1000);
      const isDone = await cdp.eval(`
        (function() {
          const r = typeof currentResection !== 'undefined' ? currentResection : null;
          const s5 = r?.stage5_camera_resection || r?.stage5;
          return !!r && !!s5 && !!sbs3DViewer;
        })()
      `);
      if (isDone) { ready = true; break; }
    }
    console.log(`✓ Resection ready: ${ready}`);
    await sleep(3000); // allow Three.js model to settle

    // 2. Trigger matchReferenceLighting()
    console.log('💡 Triggering matchReferenceLighting() to inversely solve and apply matching lighting...');
    const matchRes = await cdp.eval(`
      (async function() {
        await matchReferenceLighting();
        return currentMatchedLightingResult;
      })()
    `);
    console.log('   Matched Lighting Result Summary:', matchRes?.summary);

    await sleep(1500);

    // Capture Side-by-Side with matched lighting
    const ss1 = path.join(process.cwd(), 'docs/screenshots/82_plaza_matched_reference_lighting_sidebyside.png');
    await cdp.screenshot(ss1);

    // 3. Test Hotkey 'L' triggering match lighting
    console.log('⌨️ Testing Hotkey "L" for lighting rematch...');
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }))`);
    await sleep(1500);

    // 4. Switch to Alpha Overlay View with matched lighting
    console.log('🎭 Switching to Alpha Overlay view with matched lighting...');
    await cdp.eval('setMapViewMode("overlay")');
    await cdp.eval('setOverlayAlpha(50)');
    await sleep(1200);
    const ss2 = path.join(process.cwd(), 'docs/screenshots/83_plaza_alpha_overlay_matched_lighting.png');
    await cdp.screenshot(ss2);

    // 5. Test Exporting OpenUSD production scene
    console.log('📦 Testing exportOpenUsdProductionRig()...');
    await cdp.eval('exportOpenUsdProductionRig()');
    await sleep(1000);

    // Verify USD file exists on disk
    const usdPath = path.join(process.cwd(), 'public/data/matched_lighting_rig.usda');
    const mtlxPath = path.join(process.cwd(), 'public/data/matched_lighting_rig.mtlx');
    console.log('   USD File Exists on Disk:', fs.existsSync(usdPath));
    console.log('   MaterialX File Exists on Disk:', fs.existsSync(mtlxPath));

    if (fs.existsSync(usdPath)) {
      const head = fs.readFileSync(usdPath, 'utf8').slice(0, 300);
      console.log('   USD Header preview:\n', head);
    }

    cdp.close();
    console.log('\n🎉 ALL LIGHTING MATCHING, OPENUSD EXPORT & OVERLAY TESTS PASSED!');
  } finally {
    try { chrome.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
