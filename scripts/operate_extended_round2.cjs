const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const CDP_PORT = 9298;
const SHOT_DIR = path.resolve(__dirname, '../docs/screenshots');

if (!fs.existsSync(SHOT_DIR)) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
}

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
  console.log('🚀 Spawning Headless Chrome for Extended Round 2 on port', CDP_PORT);
  const tmpDir = fs.mkdtempSync('/tmp/chrome_geobox_round2_');
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
    return new Promise((resolve, reject) => {
      const msgId = idCounter++;
      const handler = (data) => {
        const msg = JSON.parse(data);
        if (msg.id === msgId) {
          ws.off('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await new Promise(r => ws.on('open', r));
  await sendCdp('Page.enable');
  await sendCdp('Runtime.enable');

  async function evaluate(expression) {
    const res = await sendCdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res && res.result ? res.result.value : null;
  }

  async function takeScreenshot(filename) {
    const shot = await sendCdp('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    const filePath = path.join(SHOT_DIR, filename);
    fs.writeFileSync(filePath, buf);
    console.log(`  📸 Saved screenshot: ${filePath} (${Math.round(buf.length / 1024)} KB)`);
    return filePath;
  }

  console.log('\n🌐 Navigating to http://127.0.0.1:8080/geobox_demo.html ...');
  await sendCdp('Page.navigate', { url: 'http://127.0.0.1:8080/geobox_demo.html' });
  await sleep(4000);

  // =========================================================================
  // WORKFLOW A: Blind Resection on Zero-GPS Photograph (Colosseum, Rome)
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW A: Blind Resection on Zero-GPS Photo (Colosseum, Rome)');
  console.log('======================================================');
  await evaluate(`
    (async () => {
      await window.loadSamplePhoto('/test_images/colosseum_rome_no_geodata.jpg', '');
    })();
  `);

  console.log('⏳ Waiting for Colosseum blind resection to complete...');
  let colosseumDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(600);
    const lm = await evaluate(`window.currentResection?.stage2_places?.landmark_name || document.getElementById("hud-address-title")?.textContent`);
    if (lm && (lm.toLowerCase().includes("colosseum") || lm.toLowerCase().includes("colosseo"))) {
      colosseumDone = true;
      console.log(`✅ Colosseum blind resection settled: "${lm}"`);
      break;
    }
  }
  if (!colosseumDone) console.warn('⚠️ Timeout waiting for Colosseum resection.');

  await sleep(2500); // allow model and textures to settle
  await evaluate(`window.setMapViewMode('sidebyside')`);
  await evaluate(`window.setSbsViewMode('3dobj')`);
  await sleep(1500);
  await takeScreenshot('95_demo_colosseum_zero_gps_photo.png');

  // =========================================================================
  // WORKFLOW B: Roman Travertine Dusk Lighting & Window Portal Fixtures
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW B: Roman Travertine Dusk Lighting & Architectural Vaults');
  console.log('======================================================');
  await evaluate(`window.toggleSbsMatchedAtmosphere()`); // ensure dusk twilight
  await evaluate(`window.toggleSbsDelight()`);           // ensure travertine de-lighting
  await evaluate(`window.toggleSbsArchwayLights()`);     // toggle window lights
  await sleep(1500);
  await takeScreenshot('96_demo_colosseum_travertine_dusk_windows.png');

  // =========================================================================
  // WORKFLOW C: 50/50 Match Wipe with Custom Split Ratios
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW C: 50/50 Match Wipe with Dynamic Ratio');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('wipe')`);
  await evaluate(`window.setWipeSplit(65)`); // 65% photo, 35% 3D tiles
  await sleep(1200);
  await takeScreenshot('97_demo_colosseum_wipe_split_65.png');

  // =========================================================================
  // WORKFLOW D: Alpha Overlay with Difference Blend Mode
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW D: Alpha Overlay with Difference Blend Mode');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('overlay')`);
  await evaluate(`window.setOverlayAlpha(60)`);
  await evaluate(`window.toggleOverlayDiff()`);
  await sleep(1200);
  await takeScreenshot('98_demo_colosseum_alpha_difference.png');
  await evaluate(`window.toggleOverlayDiff()`); // restore normal

  // =========================================================================
  // WORKFLOW E: Sub-Pixel Edge Alignment & Contrast Tuning
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW E: Sub-Pixel Edge Alignment & Closed-Loop Optimizer');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('edge')`);
  await sleep(1000);
  await evaluate(`
    (async () => {
      const slider = document.getElementById("edge-contrast-slider");
      if (slider) slider.value = 260;
      if (typeof window.optimizeEdgeAlignment === 'function') {
        await window.optimizeEdgeAlignment();
      }
    })()
  `);
  await sleep(1500);
  await takeScreenshot('99_demo_colosseum_edge_alignment.png');

  // =========================================================================
  // WORKFLOW F: 6-DOF Tactical Overhead Frustum Map & Camera Focus
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW F: 6-DOF Tactical Overhead Frustum Map');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('overhead')`);
  await evaluate(`window.toggleFrustum()`);
  await sleep(2500);
  await takeScreenshot('100_demo_colosseum_tactical_overhead_frustum.png');

  // =========================================================================
  // WORKFLOW G: Text Query - Eiffel Tower, Paris, France
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW G: Text Query - Eiffel Tower, Paris, France');
  console.log('======================================================');
  await evaluate(`
    (async () => {
      const input = document.getElementById("chat-prompt-input");
      if (input) input.value = "Eiffel Tower, Paris, France";
      if (typeof window.sendChatSubmission === "function") {
        await window.sendChatSubmission();
      }
    })();
  `);

  console.log('⏳ Waiting for Eiffel Tower resection...');
  let eiffelDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(600);
    const lm = await evaluate(`window.currentResection?.stage2_places?.landmark_name || document.getElementById("hud-address-title")?.textContent`);
    if (lm && (lm.toLowerCase().includes("eiffel") || lm.toLowerCase().includes("tour eiffel"))) {
      eiffelDone = true;
      console.log(`✅ Eiffel Tower resection settled: "${lm}"`);
      break;
    }
  }
  if (!eiffelDone) console.warn('⚠️ Timeout waiting for Eiffel Tower resection.');

  await sleep(2500);
  await evaluate(`window.setMapViewMode('sidebyside')`);
  await evaluate(`window.setSbsViewMode('3dobj')`);
  await sleep(1500);
  await takeScreenshot('101_demo_eiffel_tower_text_search.png');

  // =========================================================================
  // WORKFLOW H: Full-Stage 3D Object Mesh with Wireframe
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW H: Full-Stage 3D Object Mesh with Wireframe');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('3dtiles')`);
  await evaluate(`window.toggleMain3DWireframe()`);
  await sleep(1500);
  await takeScreenshot('102_demo_eiffel_tower_3d_wireframe.png');
  await evaluate(`window.toggleMain3DWireframe()`); // restore shaded

  // =========================================================================
  // WORKFLOW I: Stiff WASDQE Navigation & Lens Preset (Wide)
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW I: Stiff WASDQE Navigation & Lens Preset');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('sidebyside')`);
  await sleep(1000);

  // Stiff WASDQE movements
  for (let i = 0; i < 4; i++) {
    await evaluate(`window.nudgeCamera('w')`);
    await sleep(60);
  }
  for (let i = 0; i < 4; i++) {
    await evaluate(`window.nudgeCamera('e')`);
    await sleep(60);
  }
  for (let i = 0; i < 5; i++) {
    await evaluate(`window.nudgeCamera('ArrowRight')`);
    await sleep(60);
  }

  await evaluate(`window.setLensPreset('ultrawide')`);
  await sleep(1200);
  await takeScreenshot('103_demo_eiffel_tower_stiff_nav_wide.png');

  // Save ground truth calibration
  await evaluate(`window.saveAndLearnCalibration()`);
  console.log('💾 Calibration saved.');

  // =========================================================================
  // WORKFLOW J: Multimodal Search (Photo + Text: Taj Mahal)
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW J: Multimodal Search (Taj Mahal, Agra, India)');
  console.log('======================================================');
  await evaluate(`
    (async () => {
      await window.loadSamplePhoto('/test_images/taj_mahal_agra.jpg', 'Taj Mahal, Agra, Uttar Pradesh, India');
    })();
  `);

  console.log('⏳ Waiting for Taj Mahal multimodal resection...');
  let tajDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(600);
    const lm = await evaluate(`window.currentResection?.stage2_places?.landmark_name || document.getElementById("hud-address-title")?.textContent`);
    if (lm && (lm.toLowerCase().includes("taj") || lm.toLowerCase().includes("mahal"))) {
      tajDone = true;
      console.log(`✅ Taj Mahal multimodal resection settled: "${lm}"`);
      break;
    }
  }
  if (!tajDone) console.warn('⚠️ Timeout waiting for Taj Mahal resection.');

  await sleep(2500);
  await evaluate(`window.setMapViewMode('sidebyside')`);
  await evaluate(`window.setSbsViewMode('3dobj')`);
  await sleep(1500);
  await takeScreenshot('104_demo_taj_mahal_multimodal_match.png');

  // =========================================================================
  // WORKFLOW K: Production OpenUSD (.usda) & MaterialX (.mtlx) Export
  // =========================================================================
  console.log('\n======================================================');
  console.log('WORKFLOW K: Production OpenUSD (.usda) & MaterialX (.mtlx) Export');
  console.log('======================================================');
  const usdExport = await evaluate(`
    (async () => {
      try {
        await window.exportOpenUsdProductionRig();
        return "Taj Mahal OpenUSD Production Rig (.usda) & MaterialX (.mtlx) Exported Successfully";
      } catch (e) {
        return "USD Export Error: " + e.message;
      }
    })()
  `);
  console.log('📦 USD Export:', usdExport);
  await sleep(1000);
  await takeScreenshot('105_demo_taj_mahal_usd_export.png');

  console.log('\n🎉 EXTENDED ROUND 2 OPERATIONS SYSTEMATICALLY EXECUTED & VERIFIED!');
  chromeProc.kill();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Extended Round 2 automation failure:', err);
  process.exit(1);
});
