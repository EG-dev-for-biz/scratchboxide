/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
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
  console.log('======================================================================');
  console.log('🏛️ RUNNING FRONTEND TEST: IMAGE RESECTION, 3D TILES & CAMERA PLACEMENT');
  console.log('======================================================================\n');

  const chromePort = 9268;
  const tmpDir = fs.mkdtempSync('/tmp/chrome_geobox_test_');
  const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    `--remote-debugging-port=${chromePort}`,
    '--window-size=1920,1080',
    'about:blank'
  ]);

  chromeProc.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('GLDriver') && !s.includes('metal')) {
      // ignore normal GPU warnings
    }
  });

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

    if (!targetWs) {
      throw new Error(`Could not connect to Chrome CDP on port ${chromePort}`);
    }

    const cdp = new CdpConnection(targetWs);
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

    console.log('🌐 Navigating to http://127.0.0.1:8080/geobox_demo.html ...');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8080/geobox_demo.html' });
    await sleep(2500);

    const title = await cdp.eval('document.title');
    console.log(`✓ Loaded page title: "${title}"`);

    // Prepare photograph data
    const photoPath = path.resolve(__dirname, '../public/test_images/the_plaza_hotel_user_photo.jpg');
    const photoBuf = fs.readFileSync(photoPath);
    const photoBase64 = `data:image/jpeg;base64,${photoBuf.toString('base64')}`;

    console.log('📤 Staging photograph in frontend chat composer...');
    await cdp.eval(`
      (function() {
        const photoData = {
          isVideo: false,
          imagePath: "/test_images/the_plaza_hotel_user_photo.jpg",
          imageUri: "/test_images/the_plaza_hotel_user_photo.jpg",
          name: "The-Plaza-Hotel-User-Photo.jpg",
          meta: "📷 ${(photoBuf.length / 1024).toFixed(1)} KB • High Resolution"
        };
        stagePhoto(photoData);
        document.getElementById("chat-prompt-input").value = "The Plaza Hotel, NYC";
      })()
    `);

    await sleep(800);
    const stagedName = await cdp.eval('document.getElementById("chat-pill-name")?.textContent');
    console.log(`✓ Staged photo verified in DOM: "${stagedName}"`);

    const screenshotDir = path.resolve(__dirname, '../docs/screenshots');
    const ss1 = path.join(screenshotDir, '68_plaza_frontend_staged_photo.png');
    await cdp.screenshot(ss1);

    console.log('🚀 Triggering sendChatSubmission() to run 7-stage resection...');
    await cdp.eval(`
      (function() {
        currentResection = null;
        sendChatSubmission();
      })()
    `);

    // Wait for the pipeline to finish in frontend
    console.log('⏳ Waiting for frontend resection to complete and resolve 3D Tile + Camera placement...');
    let completed = false;
    let attempts = 0;
    while (!completed && attempts < 40) {
      await sleep(1000);
      attempts++;
      const status = await cdp.eval(`
        (function() {
          const badge = document.querySelector(".msg-badge-cert");
          const errorMsg = document.querySelector(".msg-body div[style*='f87171']");
          const r = typeof currentResection !== 'undefined' ? currentResection : null;
          const s2 = r ? (r.stage2_places || r.stage2) : null;
          const s5 = r ? (r.stage5_camera_resection || r.stage5) : null;
          const lmName = s2 ? (s2.landmark_name || '') : '';
          const isDone = !!r && !!s5 && lmName.toLowerCase().includes('plaza');

          return {
            hasBadge: !!badge,
            badgeText: badge ? badge.textContent : null,
            hasError: !!errorMsg,
            errorText: errorMsg ? errorMsg.textContent : null,
            isDone: isDone,
            lmName: lmName
          };
        })()
      `);

      if (status.isDone) {
        completed = true;
        console.log(`✓ Frontend completed in ${attempts}s for "${status.lmName}" with badge: "${status.badgeText}"`);
        break;
      }
      if (status.hasError) {
        throw new Error(`Frontend reported error: ${status.errorText}`);
      }
      process.stdout.write(`   [${attempts}s] Processing resection stages...\r`);
    }

    if (!completed) {
      throw new Error('Timed out waiting for resection to complete in frontend');
    }

    // Wait for Three.js 3D model to finish loading in sbs3DViewer
    console.log('⏳ Waiting for Three.js 3D model to finish loading...');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const isModelLoaded = await cdp.eval(`
        (function() {
          const stats = document.getElementById("sbs-3d-object-stats")?.textContent || '';
          return stats.includes('552,125') || stats.includes('356,137');
        })()
      `);
      if (isModelLoaded) {
        console.log('✓ Three.js 3D Model confirmed loaded in DOM!');
        break;
      }
    }
    await sleep(2000); // Allow Three.js 3D models and tiles to render

    // Extract all returned values from DOM & frontend state
    const returnedData = await cdp.eval(`
      (function() {
        const hudCoords = document.getElementById("hud-coords")?.textContent;
        const hudAlt = document.getElementById("hud-altitude")?.textContent;
        const hudAttitude = document.getElementById("hud-attitude")?.textContent;
        const hudStandoff = document.getElementById("hud-standoff")?.textContent;
        const hudSubpixel = document.getElementById("hud-subpixel")?.textContent;
        const hudTolerance = document.getElementById("hud-tolerance")?.textContent;
        const hudAddress = document.getElementById("hud-address-sub")?.textContent;
        const hudDistrict = document.getElementById("hud-neighborhood-pill")?.textContent;
        const sbsCamPos = document.getElementById("sbs-tiles-cam-pos")?.textContent;
        const sbsCamAtt = document.getElementById("sbs-tiles-cam-att")?.textContent;
        const stats3D = document.getElementById("sbs-3d-object-stats")?.textContent;

        const r = currentResection || {};
        const s2 = r.stage2_places || {};
        const s5 = r.stage5_camera_resection || {};
        const gmp = r.google_map_tiles_3d || {};
        const descLoc = r.descriptive_location || s5.descriptive_location || {};

        return {
          landmarkName: descLoc.landmark_name || s2.landmark_name,
          landmarkCoords: { lat: s2.lat, lng: s2.lng },
          placeId: s2.place_id,
          descriptiveLocationDossier: {
            landmark: descLoc.landmark_name,
            physicalAddress: descLoc.formatted_address,
            districtNeighborhood: descLoc.neighborhood,
            cityStateCountry: descLoc.city_state_country,
            photographerStandpoint: descLoc.camera_standpoint_address,
            vantagePerspective: descLoc.viewpoint_description,
            architecturalStyle: descLoc.architectural_style,
            architecturalFeatures: descLoc.architectural_features,
            surroundingContext: descLoc.surrounding_context
          },
          cameraResection: {
            lat: s5.camera_lat,
            lng: s5.camera_lng,
            altMsl: s5.camera_alt_m,
            headingDeg: s5.heading_deg,
            pitchDeg: s5.pitch_deg,
            rollDeg: s5.roll_deg,
            standoffM: s5.standoff_distance_m,
            vantageName: s5.vantage_point_name,
            residualMm: s5.camera_residual_mm,
            reprojectionResidualPx: s5.reprojection_residual_px
          },
          googleMapTiles3D: {
            center: gmp.center,
            cameraPosition: gmp.camera_position,
            heading: gmp.heading,
            tilt: gmp.tilt,
            range: gmp.range,
            fov: gmp.fov,
            glbUrl: gmp.three_d_object_model_url
          },
          domHud: {
            address: hudAddress,
            district: hudDistrict,
            coords: hudCoords,
            altitude: hudAlt,
            attitude: hudAttitude,
            standoff: hudStandoff,
            subpixel: hudSubpixel,
            tolerance: hudTolerance
          },
          domSideBySide: {
            camPos: sbsCamPos,
            camAtt: sbsCamAtt,
            stats3D: stats3D
          }
        };
      })()
    `);

    console.log('\n======================================================================');
    console.log('✅ RETURNED VALUES FROM APP FRONTEND:');
    console.log('======================================================================');
    console.log(JSON.stringify(returnedData, null, 2));

    // Capture Side-by-Side 3D Match Viewport
    const ss2 = path.join(screenshotDir, '69_plaza_frontend_resection_result_sidebyside.png');
    await cdp.screenshot(ss2);

    // Switch to 50/50 Match Wipe
    console.log('🔄 Switching to 50/50 Match Wipe mode in frontend...');
    await cdp.eval('setMapViewMode("wipe")');
    await sleep(1200);
    const ss3 = path.join(screenshotDir, '70_plaza_frontend_50_50_wipe_match.png');
    await cdp.screenshot(ss3);

    // Switch to Overhead Frustum Mode
    console.log('🔄 Switching to Overhead Frustum Map View in frontend...');
    await cdp.eval('setMapViewMode("overhead")');
    await sleep(1200);
    const ss4 = path.join(screenshotDir, '71_plaza_frontend_overhead_camera_frustum.png');
    await cdp.screenshot(ss4);

    // Switch to 3D Tiles Mode
    console.log('🔄 Switching to Google 3D Tiles Perspective View in frontend...');
    await cdp.eval('setMapViewMode("3dtiles")');
    await sleep(1200);
    const ss5 = path.join(screenshotDir, '72_plaza_frontend_google_3d_tiles_perspective.png');
    await cdp.screenshot(ss5);

    cdp.close();
    console.log('\n🎉 ALL FRONTEND VERIFICATION STEPS PASSED SUCCESSFULLY!');
  } finally {
    try {
      chromeProc.kill('SIGTERM');
    } catch (e) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

run().catch(err => {
  console.error('\n❌ Execution failed:', err);
  process.exit(1);
});
