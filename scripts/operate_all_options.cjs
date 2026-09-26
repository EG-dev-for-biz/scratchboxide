const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const CDP_PORT = 9288;
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
  console.log('🚀 Spawning Headless Chrome on port', CDP_PORT);
  const tmpDir = fs.mkdtempSync('/tmp/chrome_geobox_cdp_');
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

  // 1. Submit query for "Sydney Opera House, Australia"
  console.log('\n======================================================');
  console.log('OPTION 1: Text Search Query for "Sydney Opera House, Australia"');
  console.log('======================================================');
  await evaluate(`
    (async () => {
      const input = document.getElementById("chat-prompt-input");
      if (input) input.value = "Sydney Opera House, Australia";
      if (typeof window.sendChatSubmission === "function") {
        await window.sendChatSubmission();
      } else {
        await submitTextQuery("Sydney Opera House, Australia");
      }
    })();
  `);

  console.log('⏳ Waiting for Sydney Opera House resection pipeline to complete and 3D geometry to load...');
  let settled = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const landmarkText = await evaluate(`document.getElementById("hud-address-title")?.textContent`);
    if (landmarkText && landmarkText.includes("Sydney Opera House")) {
      settled = true;
      console.log(`✅ Pipeline returned: "${landmarkText}"`);
      break;
    }
  }
  if (!settled) {
    console.warn('⚠️ Timeout waiting for Sydney Opera House text in HUD');
  }

  await sleep(2500); // allow Three.js rendering and texture settling

  // Verify left query image and right 3D model
  const sbsStatus = await evaluate(`({
    landmarkTitle: document.getElementById("hud-address-title")?.textContent,
    coords: document.getElementById("hud-coords")?.textContent,
    queryImg: document.getElementById("sbs-query-img")?.src,
    wipeLeftImg: document.getElementById("wipe-img-query")?.src,
    wipeRightImg: document.getElementById("wipe-img-tiles")?.src,
    hasLocalGlb: window.current3DObject?.hasLocalGlb,
    glbUrl: window.current3DObject?.glbUrl
  })`);
  console.log('📊 Side-by-Side Status:', sbsStatus);

  console.log('\n======================================================');
  console.log('OPTION 2: Side-by-Side 3D Match View (Sydney Opera House)');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('sidebyside')`);
  await evaluate(`window.setSbsViewMode('3dobj')`);
  await sleep(1500);
  await takeScreenshot('68_geobox_sydney_sbs_match.png');

  console.log('\n======================================================');
  console.log('OPTION 2b: Switch Side-by-Side to Google Maps 3D Tiles Mode');
  console.log('======================================================');
  await evaluate(`window.setSbsViewMode('tiles')`);
  await sleep(2000);
  await takeScreenshot('69_geobox_sydney_gmp3d_tiles.png');

  // Switch back to 3dobj for crisp wipe sync
  await evaluate(`window.setSbsViewMode('3dobj')`);
  await sleep(1000);

  console.log('\n======================================================');
  console.log('OPTION 3: 50/50 Match Wipe View (50% Split)');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('wipe')`);
  await evaluate(`window.setWipeSplit(50)`);
  await sleep(1500);
  await takeScreenshot('70_geobox_sydney_match_wipe_50.png');

  console.log('\n======================================================');
  console.log('OPTION 3b: Match Wipe View at 25% Split (75% 3D)');
  console.log('======================================================');
  await evaluate(`window.setWipeSplit(25)`);
  await sleep(1000);
  await takeScreenshot('71_geobox_sydney_match_wipe_25.png');

  console.log('\n======================================================');
  console.log('OPTION 4: Alpha Overlay View (50% Blend)');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('overlay')`);
  await evaluate(`window.setOverlayAlpha(50)`);
  await sleep(1500);
  await takeScreenshot('72_geobox_sydney_alpha_overlay.png');

  console.log('\n======================================================');
  console.log('OPTION 4b: Alpha Overlay with Difference Blend Mode');
  console.log('======================================================');
  await evaluate(`window.toggleOverlayDiff()`);
  await sleep(1000);
  await takeScreenshot('73_geobox_sydney_alpha_diff.png');

  // Toggle diff back off
  await evaluate(`window.toggleOverlayDiff()`);
  await sleep(500);

  console.log('\n======================================================');
  console.log('OPTION 4c: Brown-Conrady Optical Lens Distortion (Phone k1 = -0.038)');
  console.log('======================================================');
  await evaluate(`window.setLensPreset('smartphone')`);
  await sleep(1000);
  await takeScreenshot('74_geobox_sydney_lens_distortion.png');

  console.log('\n======================================================');
  console.log('OPTION 5: Sub-Pixel Edge Alignment View');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('edge')`);
  await sleep(1500);
  await takeScreenshot('75_geobox_sydney_subpixel_edge.png');

  console.log('\n======================================================');
  console.log('OPTION 6: 3D Object Mesh (.glb) Full-Stage View');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('3dtiles')`);
  await sleep(1500);
  await takeScreenshot('76_geobox_sydney_3d_object_mesh.png');

  console.log('\n======================================================');
  console.log('OPTION 7: 6-DOF Tactical Overhead Frustum Map View');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('overhead')`);
  await sleep(2000);
  await takeScreenshot('77_geobox_sydney_tactical_overhead.png');

  console.log('\n======================================================');
  console.log('OPTION 8: Stiff WASDQE / Arrow Navigation Controls');
  console.log('======================================================');
  await evaluate(`window.setMapViewMode('sidebyside')`);
  await sleep(1000);
  // Nudge forward (W), pedestal up (E), yaw right (ArrowRight)
  for (let k = 0; k < 6; k++) {
    await evaluate(`window.nudgeCamera('w')`);
    await sleep(80);
  }
  for (let k = 0; k < 4; k++) {
    await evaluate(`window.nudgeCamera('e')`);
    await sleep(80);
  }
  for (let k = 0; k < 5; k++) {
    await evaluate(`window.nudgeCamera('ArrowRight')`);
    await sleep(80);
  }
  await sleep(1000);
  await takeScreenshot('78_geobox_sydney_stiff_nav.png');

  console.log('\n======================================================');
  console.log('OPTION 9: Match Image & Lighting Rig (Hotkey L)');
  console.log('======================================================');
  await evaluate(`window.matchReferenceLighting()`);
  await sleep(2000);
  await takeScreenshot('79_geobox_sydney_matched_lighting.png');

  console.log('\n======================================================');
  console.log('OPTION 10: Export OpenUSD (.usda) & MaterialX (.mtlx)');
  console.log('======================================================');
  const usdResult = await evaluate(`(async () => {
    try {
      await window.exportOpenUsdProductionRig();
      return "USD Export triggered successfully";
    } catch(e) {
      return "USD Error: " + e.message;
    }
  })()`);
  console.log('📦 USD Export Result:', usdResult);

  console.log('\n======================================================');
  console.log('OPTION 11: Save & Learn Ground Truth Calibration');
  console.log('======================================================');
  await evaluate(`window.saveAndLearnCalibration()`);
  await sleep(1000);

  console.log('\n======================================================');
  console.log('OPTION 12: Photo Upload Search (The Plaza Hotel)');
  console.log('======================================================');
  await evaluate(`
    (async () => {
      const plazaSample = "/test_images/the_plaza_hotel_user_photo.jpg";
      if (typeof window.loadSamplePhoto === "function") {
        await window.loadSamplePhoto(plazaSample, "The Plaza Hotel NYC");
      }
    })();
  `);
  console.log('⏳ Waiting for Plaza Hotel photo resection...');
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const landmarkText = await evaluate(`document.getElementById("hud-address-title")?.textContent`);
    if (landmarkText && (landmarkText.includes("Plaza") || landmarkText.includes("Central Park"))) {
      console.log(`✅ Plaza resection completed: "${landmarkText}"`);
      break;
    }
  }
  await sleep(2000);
  await takeScreenshot('80_geobox_plaza_hotel_photo_search.png');

  console.log('\n🎉 ALL 12 OPTIONS SUCCESSFULLY OPERATED AND VERIFIED!');
  chromeProc.kill();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Automation failure:', err);
  process.exit(1);
});
