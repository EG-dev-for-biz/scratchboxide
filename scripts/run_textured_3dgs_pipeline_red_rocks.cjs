const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');

const PORT = 8165;
const CDP_PORT = 9285;
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.resolve(REPO_ROOT, 'docs/screenshots');
const PUBLIC_DIR = path.resolve(REPO_ROOT, 'public');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCSHRfQGTmZykmM4LA6mI7avjEQEkQive4';

// Red Rocks Amphitheatre Geodetic Anchor
const ANCHOR = {
  lat: 39.66555,
  lng: -105.20525,
  elevationMeters: 1932.0,
  headingDeg: 285.0,
  formattedAddress: 'Red Rocks Amphitheatre, Morrison, Colorado, USA'
};

// 4 Calibrated Survey Stations covering the Amphitheatre:
// Center stage is at local [5.2, 4.46, 0.0]
const SURVEY_STATIONS = [
  {
    id: 1,
    name: 'Mix Board (FOH) Center Overview',
    camPos: [-22.0, 13.5, 0.0],
    targetPos: [5.2, 4.46, 0.0],
    fov: 52,
    desc: 'Front-of-House soundboard overview looking down onto stage deck and backdrop rocks'
  },
  {
    id: 2,
    name: 'VIP Front Row Stage Vista',
    camPos: [-4.0, 6.8, 0.0],
    targetPos: [5.2, 5.2, 0.0],
    fov: 58,
    desc: 'Stage-level intimate perspective of natural stone platform and acoustic sound shell'
  },
  {
    id: 3,
    name: 'South Amphitheatre Oblique (Creation Rock)',
    camPos: [12.0, 24.0, 45.0],
    targetPos: [0.0, 8.0, 0.0],
    fov: 54,
    desc: 'Elevated southern vista capturing towering red sandstone monoliths and seating bowl'
  },
  {
    id: 4,
    name: 'High Aerial Drone Basin Survey',
    camPos: [-35.0, 48.0, -32.0],
    targetPos: [5.2, 4.46, 0.0],
    fov: 56,
    desc: 'High-altitude drone survey encompassing the geological basin and Denver horizon'
  }
];

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

function generateRunnerHtml() {
  const WGS84_A = 6378137.0;
  const WGS84_F = 1.0 / 298.257223563;
  const WGS84_B = WGS84_A * (1.0 - WGS84_F);
  const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

  const latRad = ANCHOR.lat * (Math.PI / 180);
  const lngRad = ANCHOR.lng * (Math.PI / 180);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLng = Math.sin(lngRad);
  const cosLng = Math.cos(lngRad);

  const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  const x = (n + ANCHOR.elevationMeters) * cosLat * cosLng;
  const y = (n + ANCHOR.elevationMeters) * cosLat * sinLng;
  const z = ((1.0 - WGS84_E2) * n + ANCHOR.elevationMeters) * sinLat;

  const m00 = -sinLng;
  const m01 = cosLng;
  const m02 = 0;
  const m03 = -(m00 * x + m01 * y + m02 * z);

  const m10 = cosLat * cosLng;
  const m11 = cosLat * sinLng;
  const m12 = sinLat;
  const m13 = -(m10 * x + m11 * y + m12 * z);

  const m20 = sinLat * cosLng;
  const m21 = sinLat * sinLng;
  const m22 = -cosLat;
  const m23 = -(m20 * x + m21 * y + m22 * z);

  const matrixValues = [
    m00, m01, m02, m03,
    m10, m11, m12, m13,
    m20, m21, m22, m23,
    0,   0,   0,   1
  ];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Red Rocks Multi-Station Google 3D Tiles Streamer</title>
  <style>
    body { margin: 0; background: #0a0d18; overflow: hidden; font-family: -apple-system, sans-serif; }
    #container { width: 1920px; height: 1080px; position: absolute; top: 0; left: 0; }
    #hud { position: absolute; top: 16px; left: 16px; background: rgba(15, 23, 42, 0.88); color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 13px; z-index: 100; pointer-events: none; border: 1px solid rgba(56, 189, 248, 0.3); }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/addons/": "/node_modules/three/examples/jsm/",
      "3d-tiles-renderer": "/node_modules/3d-tiles-renderer/build/index.js",
      "3d-tiles-renderer/plugins": "/node_modules/3d-tiles-renderer/build/index.plugins.js"
    }
  }
  </script>
</head>
<body>
  <div id="hud">
    <div style="font-weight: 700; color: #38bdf8;">Red Rocks Multi-Station Google 3D Tiles Streamer</div>
    <div id="status">Initializing 3D Tiles...</div>
    <div id="stats" style="font-size: 11px; opacity: 0.85; margin-top: 4px;">Downloading root octree...</div>
  </div>
  <div id="container"></div>

  <script type="module">
    import * as THREE from 'three';
    import { TilesRenderer } from '3d-tiles-renderer';
    import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/plugins';

    const container = document.getElementById('container');
    const statusEl = document.getElementById('status');
    const statsEl = document.getElementById('stats');

    const width = 1920;
    const height = 1080;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x181a2e);

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.5, 25000);
    camera.position.set(-22.0, 13.5, 0.0);
    camera.lookAt(5.2, 4.46, 0.0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x5a3d31, 1.3);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff1e0, 2.2);
    sunLight.position.set(45, 75, 30);
    scene.add(sunLight);

    const localMatrix = new THREE.Matrix4();
    localMatrix.set(${matrixValues.join(', ')});

    const tiles = new TilesRenderer();
    const auth = new GoogleCloudAuthPlugin({
      apiToken: '${API_KEY}',
      autoRefreshToken: true
    });
    tiles.registerPlugin(auth);

    tiles.group.matrix.copy(localMatrix);
    tiles.group.matrixAutoUpdate = false;
    scene.add(tiles.group);

    tiles.setCamera(camera);
    tiles.setResolution(camera, 3840, 2160); // 4K SSE budget for deepest leaf detail
    tiles.errorTarget = 0.5;

    if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 24;
    if (tiles.parseQueue) tiles.parseQueue.maxJobs = 16;
    tiles.maxTilesProcessed = 1200;

    tiles.onLoadModel = (sceneModel) => {
      sceneModel.traverse((child) => {
        if (child.isMesh) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => {
            if (m) {
              m.side = THREE.DoubleSide;
              if (m.map) {
                m.map.colorSpace = THREE.SRGBColorSpace;
                if (renderer.capabilities) {
                  m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
                }
                m.map.generateMipmaps = true;
                m.map.minFilter = THREE.LinearMipmapLinearFilter;
                m.map.magFilter = THREE.LinearFilter;
              }
              m.roughness = Math.max(m.roughness ?? 0.65, 0.45);
              m.metalness = Math.min(m.metalness ?? 0.05, 0.15);
              m.needsUpdate = true;
            }
          });
        }
      });
    };

    window.__setStationPose = (camPos, targetPos, horizontalFovDeg) => {
      const hFov = horizontalFovDeg || 52;
      const vFovDeg = 2.0 * Math.atan(Math.tan((hFov * Math.PI / 180.0) / 2.0) * (height / width)) * (180.0 / Math.PI);
      camera.fov = vFovDeg;
      camera.aspect = width / height;
      camera.position.set(camPos[0], camPos[1], camPos[2]);
      camera.lookAt(targetPos[0], targetPos[1], targetPos[2]);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      tiles.setCamera(camera);
      tiles.update();
      window.__stationSettled = false;
      stableCount = 0;
    };

    let stableCount = 0;
    function checkSettle() {
      camera.updateMatrixWorld();
      tiles.setCamera(camera);
      tiles.update();
      renderer.render(scene, camera);

      const stats = tiles.stats;
      statsEl.innerText = 'Downloading: ' + stats.downloading + ' | Parsing: ' + stats.parsing + ' | Loaded: ' + stats.loaded;

      if (stats.downloading === 0 && stats.parsing === 0 && stats.loaded > 15) {
        stableCount++;
        statusEl.innerText = 'Settling Tiles... (' + stableCount + '/15)';
        if (stableCount >= 15) {
          window.__stationSettled = true;
          statusEl.innerText = '✅ Tiles Settled for Current Station';
        }
      } else {
        stableCount = 0;
        statusEl.innerText = 'Streaming Leaf LOD Tiles...';
      }

      requestAnimationFrame(checkSettle);
    }

    requestAnimationFrame(checkSettle);
  </script>
</body>
</html>`;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURI((req.url || '/').split('?')[0]);
  if (reqPath === '/' || reqPath === '/runner.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(generateRunnerHtml());
    return;
  }
  const filePath = path.join(REPO_ROOT, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(filePath).pipe(res);
});

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING END-TO-END PHOTOREAL 3DGS VENUE PIPELINE (RED ROCKS)');
  console.log('========================================================================');

  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`[Stage 1] Direct Tile Streamer running at http://127.0.0.1:${PORT}`);

  const outDir = path.join(PUBLIC_DIR, 'tilesets/red_rocks');
  const stationsDir = path.join(outDir, 'stations');
  fs.mkdirSync(stationsDir, { recursive: true });

  const capturedStations = [];
  const needCapture = process.argv.includes('--force-capture') || SURVEY_STATIONS.some(st => {
    const sIdStr = String(st.id).padStart(3, '0');
    const p = path.join(stationsDir, `station_${sIdStr}_beautified.png`);
    return !fs.existsSync(p) || fs.statSync(p).size < 100000;
  });

  if (needCapture) {
    const tmpDir = fs.mkdtempSync('/tmp/chrome_pipeline_');
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

    await sendCdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/runner.html` });

    console.log('[Stage 2] Capturing direct authentic textured plates across 4 survey stations...');

    for (let sIdx = 0; sIdx < SURVEY_STATIONS.length; sIdx++) {
      const st = SURVEY_STATIONS[sIdx];
      const sIdStr = String(st.id).padStart(3, '0');
      console.log(`\n  -> Station ${st.id}/4: "${st.name}"...`);

      await sendCdp('Runtime.evaluate', {
        expression: `window.__setStationPose(${JSON.stringify(st.camPos)}, ${JSON.stringify(st.targetPos)}, ${st.fov})`
      });

      // Wait for leaf LOD tiles to settle
      let settled = false;
      for (let i = 0; i < 60; i++) {
        await sleep(400);
        const res = await sendCdp('Runtime.evaluate', { expression: 'Boolean(window.__stationSettled)' });
        if (res && res.result && res.result.value === true) {
          settled = true;
          break;
        }
      }
      await sleep(800); // raster buffer flush

      const shotRes = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
      const pngBuf = Buffer.from(shotRes.data, 'base64');
      const platePath = path.join(stationsDir, `station_${sIdStr}_beautified.png`);
      fs.writeFileSync(platePath, pngBuf);
      console.log(`     Saved direct textured plate: ${path.basename(platePath)} (${(pngBuf.length / 1024).toFixed(1)} KB)`);

      capturedStations.push({
        ...st,
        platePath,
        sIdStr
      });
    }

    ws.close();
    chromeProc.kill('SIGKILL');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  } else {
    console.log('[Stage 2] Found 4 valid authentic textured plates on disk. Reusing without re-streaming.');
    for (const st of SURVEY_STATIONS) {
      const sIdStr = String(st.id).padStart(3, '0');
      const platePath = path.join(stationsDir, `station_${sIdStr}_beautified.png`);
      capturedStations.push({
        ...st,
        platePath,
        sIdStr
      });
    }
  }

  server.close();

  // Stage 3: Load matching GLB mesh to render pose-exact depth buffers and unproject
  console.log('\n[Stage 3] Loading Red Rocks mesh and rendering metric depth buffers...');
  const glbPath = path.join(PUBLIC_DIR, 'models/red_rocks_amphitheatre.glb');
  const { SurveyStationRenderService } = await import('../packages/core/dist/node/spatial/SurveyStationRenderService.js');
  const { cameraBasis } = await import('../packages/core/dist/common/spatial/SurveySynthesisEngine.js');

  const renderService = new SurveyStationRenderService();
  await renderService.loadMesh(glbPath);

  const bakerBin = path.join(REPO_ROOT, 'build/station_to_splats');
  const width = 1920;
  const height = 1080;
  const bakedSplatPaths = [];

  for (const st of capturedStations) {
    const dx = st.targetPos[0] - st.camPos[0];
    const dy = st.targetPos[1] - st.camPos[1];
    const dz = st.targetPos[2] - st.camPos[2];
    const dist = Math.hypot(dx, dy, dz) || 1.0;
    const fwd = [dx / dist, dy / dist, dz / dist];

    const stationPose = {
      id: st.id,
      name: st.name,
      fovDegrees: st.fov,
      aspectRatio: width / height,
      positionLocalENU: st.camPos,
      forwardVector: fwd,
      upVector: [0, 1, 0]
    };

    const blockout = renderService.renderStationBlockout(stationPose, { width, height, minGroundClearance: 0 });
    const blockoutPath = path.join(stationsDir, `station_${st.sIdStr}_blockout.png`);
    fs.writeFileSync(blockoutPath, blockout.png);

    const base = path.join(stationsDir, `station_${st.sIdStr}`);
    const rgbPath = `${base}.rgb`;
    const depthPath = `${base}.depth.f32`;
    const posePath = `${base}.pose.json`;
    const splatPath = `${base}.splat`;

    // Decode textured PNG into raw RGB24
    execSync(`ffmpeg -y -v error -i "${st.platePath}" -vf "scale=${width}:${height}" -f rawvideo -pix_fmt rgb24 "${rgbPath}"`);

    // Write depth buffer
    const depthBuf = Buffer.from(blockout.depth.buffer, blockout.depth.byteOffset, blockout.depth.byteLength);
    fs.writeFileSync(depthPath, depthBuf);

    // Write pose JSON
    const { right, up, forward } = cameraBasis(fwd, [0, 1, 0]);
    const poseObj = {
      fx: blockout.intrinsics.fx,
      fy: blockout.intrinsics.fy,
      cx: blockout.intrinsics.cx,
      cy: blockout.intrinsics.cy,
      eye: st.camPos,
      right,
      up,
      forward,
      cameraAltitude: st.camPos[1],
      depthKind: 'camera-z'
    };
    fs.writeFileSync(posePath, JSON.stringify(poseObj, null, 2));

    console.log(`[Stage 4] Baking Station ${st.id} into oriented 3D Gaussian Splats with 2D EWA Covariance...`);
    const bakeCmd = `"${bakerBin}" --rgb "${rgbPath}" --depth "${depthPath}" --width ${width} --height ${height} --pose "${posePath}" --out-splat "${splatPath}" --stride 1 --station-altitude ${st.camPos[1]} --sigma-scale 0.95 --min-cos-incidence 0.15 --exclude-underside --2dgs --json`;
    const bakeOut = execSync(bakeCmd, { maxBuffer: 16 * 1024 * 1024 }).toString();
    const bakeRes = JSON.parse(bakeOut.trim());
    const splatCount = bakeRes.numSplats ?? bakeRes.splatCount ?? (fs.statSync(splatPath).size / 32);
    console.log(`     Bake Result: ${splatCount.toLocaleString()} 3D Gaussian surfels (${(fs.statSync(splatPath).size / 1024 / 1024).toFixed(2)} MB)`);

    // Clean up temporary raw files
    try { fs.unlinkSync(rgbPath); } catch (_) {}
    try { fs.unlinkSync(depthPath); } catch (_) {}

    bakedSplatPaths.push({ splatPath, alt: st.camPos[1] });
  }

  // Stage 5: Spatial Voxel-Hash Fusion across views
  console.log('\n[Stage 5] Fusing 4 station splat clouds with normal-incidence weighting...');
  const listPath = path.join(outDir, 'stations_to_fuse.txt');
  fs.writeFileSync(listPath, bakedSplatPaths.map(s => `${s.splatPath} ${s.alt}`).join('\n'));

  const fusedSplatPath = path.join(outDir, 'fused.splat');
  const fuseCmd = `"${bakerBin}" --fuse-list "${listPath}" --voxel-size 0.045 --crop-radius 190.0 --exclude-underside --out-splat "${fusedSplatPath}" --json`;
  const fuseOut = execSync(fuseCmd, { maxBuffer: 32 * 1024 * 1024 }).toString();
  const fuseRes = JSON.parse(fuseOut.trim());
  console.log(`✅ FUSION COMPLETE: ${fuseRes.fusedSplatCount.toLocaleString()} Fused 3D Gaussians!`);
  console.log(`   File: ${fusedSplatPath} (${(fs.statSync(fusedSplatPath).size / 1024 / 1024).toFixed(2)} MB)`);

  // Stage 6: Update public model files & 3D Tileset
  console.log('\n[Stage 6] Packaging OGC 3D Tileset and compressed SPZ asset...');
  const { Splat3DTilesService } = await import('../packages/core/dist/node/spatial/Splat3DTilesService.js');
  const { SplatService } = await import('../packages/core/dist/node/3d-engine/splat-service.js');

  const splatTiler = new Splat3DTilesService();
  await splatTiler.convert({
    inputPath: fusedSplatPath,
    outDir,
    origin: { lat: ANCHOR.lat, lng: ANCHOR.lng, alt: ANCHOR.elevationMeters },
    headingDeg: ANCHOR.headingDeg
  });

  const splatService = new SplatService();
  const spzPath = path.join(outDir, 'fused.spz');
  await splatService.runPipeline({ inputPath: fusedSplatPath, outSpzPath: spzPath });

  // Update public/models/ copies
  const pubModelSplat = path.join(PUBLIC_DIR, 'models/red_rocks_venue.splat');
  const pubModelSpz = path.join(PUBLIC_DIR, 'models/red_rocks_venue.spz');
  fs.copyFileSync(fusedSplatPath, pubModelSplat);
  if (fs.existsSync(spzPath)) fs.copyFileSync(spzPath, pubModelSpz);
  console.log(`   Updated ${pubModelSplat} and ${pubModelSpz}`);

  // Stage 7: Capture updated visual verification screenshots from multiple camera views
  console.log('\n[Stage 7] Capturing visual proof screenshots from all 3 camera viewpoints...');
  execSync('node scripts/capture_red_rocks_photoreal.cjs', { stdio: 'inherit' });

  console.log('\n========================================================================');
  console.log('🎉 PIPELINE COMPLETED SUCCESSFULLY WITH DIRECT TEXTURED TILE STREAMING!');
  console.log('========================================================================');
}

main().catch(err => {
  console.error('Pipeline error:', err);
  process.exit(1);
});
