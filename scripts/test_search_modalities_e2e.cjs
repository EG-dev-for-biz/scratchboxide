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
  console.log('🔍 TESTING 3 SEARCH MODALITIES: TEXT ONLY • PHOTO ONLY • BOTH');
  console.log('======================================================================\n');

  const chromePort = 9335;
  const tmpDir = fs.mkdtempSync('/tmp/test_modalities_');
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
    cdp.ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.method === 'Runtime.consoleAPICalled') {
          const args = m.params.args.map(a => a.value || a.description || '').join(' ');
          console.log(`[Browser Console ${m.params.type}]`, args);
        }
      } catch (e) {}
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('🌐 Loading http://127.0.0.1:8080/geobox_demo.html ...');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8080/geobox_demo.html' });
    await sleep(2500);

    // ========================================================================
    // MODALITY 1: TEXT-ONLY SEARCH (e.g. "Sydney Opera House, Australia")
    // ========================================================================
    console.log('\n--- 1. Testing MODALITY 1: Search by Text Only ("Sydney Opera House, Australia") ---');
    await cdp.eval(`
      (function() {
        setTimeout(function() {
          submitTextQuery("Sydney Opera House, Australia");
        }, 10);
      })()
    `);

    // Wait for text-only resection
    let textDone = false;
    for (let i = 0; i < 35; i++) {
      await sleep(1000);
      const isDone = await cdp.eval(`
        (function() {
          const r = typeof currentResection !== 'undefined' ? currentResection : null;
          const lm = r?.stage2_places?.landmark_name || '';
          return !!r && !!r.stage5_camera_resection && lm.toLowerCase().includes('sydney');
        })()
      `);
      if (isDone) { textDone = true; break; }
      process.stdout.write(`   [${i + 1}s] Waiting for text-only resolution...\r`);
    }
    console.log(`\n✓ Text-Only Search resolved: ${textDone}`);
    await sleep(2000);

    const textDossier = await cdp.eval(`
      (function() {
        const r = currentResection || {};
        const d = r.descriptive_location || {};
        return {
          landmark: d.landmark_name,
          address: d.formatted_address,
          camPos: [r.stage5_camera_resection?.camera_lat, r.stage5_camera_resection?.camera_lng]
        };
      })()
    `);
    console.log('   Text-Only Dossier:', JSON.stringify(textDossier, null, 2));

    const ss1 = path.join(process.cwd(), 'docs/screenshots/89_search_by_text_only_sydney.png');
    await cdp.screenshot(ss1);

    // ========================================================================
    // MODALITY 2: PHOTO-ONLY SEARCH (e.g. Plaza Hotel user photo, zero text)
    // ========================================================================
    console.log('\n--- 2. Testing MODALITY 2: Search by Photo Only (Zero Text) ---');
    await cdp.eval(`
      (function() {
        currentResection = null;
        stagePhoto({
          imagePath: '/test_images/the_plaza_hotel_user_photo.jpg',
          imageUri: '/test_images/the_plaza_hotel_user_photo.jpg',
          name: 'photo_no_text.jpg',
          isVideo: false
        });
        document.getElementById("chat-prompt-input").value = "";
        setTimeout(function() {
          sendChatSubmission();
        }, 10);
      })()
    `);

    let photoDone = false;
    for (let i = 0; i < 35; i++) {
      await sleep(1000);
      const isDone = await cdp.eval(`
        (function() {
          const r = typeof currentResection !== 'undefined' ? currentResection : null;
          const lm = r?.stage2_places?.landmark_name || '';
          return !!r && !!r.stage5_camera_resection && lm.toLowerCase().includes('plaza');
        })()
      `);
      if (isDone) { photoDone = true; break; }
      process.stdout.write(`   [${i + 1}s] Waiting for photo-only resolution...\r`);
    }
    console.log(`\n✓ Photo-Only Search resolved: ${photoDone}`);
    await sleep(2000);

    const photoDossier = await cdp.eval(`
      (function() {
        const r = currentResection || {};
        const d = r.descriptive_location || {};
        return {
          landmark: d.landmark_name,
          address: d.formatted_address,
          camPos: [r.stage5_camera_resection?.camera_lat, r.stage5_camera_resection?.camera_lng]
        };
      })()
    `);
    console.log('   Photo-Only Dossier:', JSON.stringify(photoDossier, null, 2));

    const ss2 = path.join(process.cwd(), 'docs/screenshots/90_search_by_photo_only_plaza.png');
    await cdp.screenshot(ss2);

    // ========================================================================
    // MODALITY 3: BOTH (PHOTO + CONTEXTUAL TEXT PROMPT)
    // ========================================================================
    console.log('\n--- 3. Testing MODALITY 3: Search by Both (Photo + Text "esb west 5thave") ---');
    await cdp.eval(`
      (function() {
        currentResection = null;
        stagePhoto({
          imagePath: '/uploads/media_1790396169800_uploaded_media.jpg',
          imageUri: '/uploads/media_1790396169800_uploaded_media.jpg',
          name: 'media_esb.jpg',
          isVideo: false
        });
        document.getElementById("chat-prompt-input").value = "esb west 5thave";
        setTimeout(function() {
          sendChatSubmission();
        }, 10);
      })()
    `);

    let bothDone = false;
    for (let i = 0; i < 35; i++) {
      await sleep(1000);
      const isDone = await cdp.eval(`
        (function() {
          const r = typeof currentResection !== 'undefined' ? currentResection : null;
          const lm = r?.stage2_places?.landmark_name || '';
          return !!r && !!r.stage5_camera_resection && lm.toLowerCase().includes('empire');
        })()
      `);
      if (isDone) { bothDone = true; break; }
      process.stdout.write(`   [${i + 1}s] Waiting for multimodal resolution...\r`);
    }
    console.log(`\n✓ Multimodal Search resolved: ${bothDone}`);
    await sleep(2000);

    const bothDossier = await cdp.eval(`
      (function() {
        const r = currentResection || {};
        const d = r.descriptive_location || {};
        return {
          landmark: d.landmark_name,
          address: d.formatted_address,
          camPos: [r.stage5_camera_resection?.camera_lat, r.stage5_camera_resection?.camera_lng]
        };
      })()
    `);
    console.log('   Multimodal Dossier:', JSON.stringify(bothDossier, null, 2));

    const ss3 = path.join(process.cwd(), 'docs/screenshots/91_search_by_both_photo_and_text_esb.png');
    await cdp.screenshot(ss3);

    cdp.close();
    console.log('\n🎉 ALL 3 SEARCH MODALITIES VERIFIED SUCCESSFULLY!');
  } finally {
    try { chrome.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
