const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');

const PORT = 8098;
const TOTAL_FRAMES = 72; // 3.0s at 24fps
const VIDEOS_DIR = path.resolve('public/videos');

// Extract evaluationsData from s4d_multi_gallery.html
const htmlContent = fs.readFileSync('public/s4d_multi_gallery.html', 'utf8');
const match = htmlContent.match(/const evaluationsData = (\[[\s\S]*?\]);\s*(?:let|const|var)/);
if (!match) {
  console.error('Could not find evaluationsData in s4d_multi_gallery.html');
  process.exit(1);
}
const allData = JSON.parse(match[1]);

const targetDistricts = [
  { key: 'shibuya', data: allData[2] },
  { key: 'alpine', data: allData[3] },
  { key: 'dubai', data: allData[4] }
];

let currentDistrictIndex = 0;

function generateRendererHtml(dist) {
  const framesData = dist.frames;
  const waypointsData = dist.waypoints;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>S4D Blockout Video Recorder - ${dist.name}</title>
  <style>
    body { margin: 0; background: #070a12; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; color: #fff; }
    #canvas { width: 1280px; height: 720px; display: block; }
    #status { position: absolute; bottom: 16px; left: 16px; background: rgba(11, 15, 25, 0.9); backdrop-filter: blur(8px); padding: 8px 16px; border-radius: 8px; font-size: 13px; z-index: 100; border: 1px solid rgba(56, 189, 248, 0.3); }
    #hud { position: absolute; top: 16px; left: 16px; z-index: 90; display: flex; gap: 8px; }
    .badge { background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-size: 11px; font-weight: bold; padding: 5px 12px; border-radius: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
    .badge-gold { background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; color: #f59e0b; }
    .badge-purple { background: rgba(168, 85, 247, 0.15); border: 1px solid #a855f7; color: #c084fc; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
  <div id="hud">
    <div class="badge">SCRATCHBOX-4D ENGINE</div>
    <div class="badge badge-gold">&lt;VIDEO_REF_0&gt; 3D BLOCKOUT</div>
    <div class="badge badge-purple">${dist.name}</div>
  </div>
  <div id="status">Initializing ${dist.name} Blockout...</div>
  <canvas id="canvas" width="1280" height="720"></canvas>

  <script>
    const framesData = ${JSON.stringify(framesData)};
    const waypointsData = ${JSON.stringify(waypointsData)};
    const TOTAL_FRAMES = ${TOTAL_FRAMES};
    const statusEl = document.getElementById('status');
    const canvas = document.getElementById('canvas');

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070a12, 0.007);

    const camera = new THREE.PerspectiveCamera(54, 1280 / 720, 0.1, 1000);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1280, 720);
    renderer.setClearColor(0x070a12, 1);
    renderer.shadowMap.enabled = true;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfef08a, 1.7);
    sunLight.position.set(70, -50, 90);
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
    fillLight.position.set(-60, 50, 30);
    scene.add(fillLight);

    const classColors = {
      1: 0x22c55e, 2: 0x475569, 3: 0x38bdf8, 4: 0x16a34a,
      5: 0xef4444, 6: 0xf97316, 8: 0x0284c7, 9: 0x9333ea
    };

    const curvePoints = waypointsData.map(w => new THREE.Vector3(w.x, w.y, w.z));
    const curve = new THREE.CatmullRomCurve3(curvePoints);
    const tubeGeo = new THREE.TubeGeometry(curve, 100, 0.75, 8, false);
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xd97706,
      emissiveIntensity: 0.9,
      roughness: 0.2,
      metalness: 0.8
    });
    scene.add(new THREE.Mesh(tubeGeo, tubeMat));

    curvePoints.forEach((p, idx) => {
      const dotGeo = new THREE.SphereGeometry(1.0, 12, 12);
      const dotMat = new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x22c55e : (idx === curvePoints.length - 1 ? 0xef4444 : 0xfef08a) });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p);
      scene.add(dot);
    });

    const droneGeo = new THREE.SphereGeometry(1.5, 16, 16);
    const droneMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, emissive: 0x0284c7, emissiveIntensity: 1.0, roughness: 0.1 });
    const droneMesh = new THREE.Mesh(droneGeo, droneMat);
    scene.add(droneMesh);

    let instancedVoxelMesh = null;
    const boxGeometry = new THREE.BoxGeometry(1.82, 1.82, 1.82);

    function renderTimeFrame(frameIdx) {
      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
      }
      const frame = framesData[frameIdx];
      const voxels = frame.voxels;
      const count = voxels.length;

      const material = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.15 });
      instancedVoxelMesh = new THREE.InstancedMesh(boxGeometry, material, count);
      instancedVoxelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();

      for (let i = 0; i < count; i++) {
        const [x, y, z, cls] = voxels[i];
        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        instancedVoxelMesh.setMatrixAt(i, dummy.matrix);

        const hexColor = classColors[cls] || 0x64748b;
        color.setHex(hexColor);
        instancedVoxelMesh.setColorAt(i, color);
      }

      instancedVoxelMesh.instanceMatrix.needsUpdate = true;
      if (instancedVoxelMesh.instanceColor) instancedVoxelMesh.instanceColor.needsUpdate = true;
      scene.add(instancedVoxelMesh);
    }

    async function recordAllFrames() {
      statusEl.innerText = "Starting 3D Blockout Recording (72 frames)...";
      
      for (let i = 0; i < TOTAL_FRAMES; i++) {
        const u = i / (TOTAL_FRAMES - 1);
        const timeIdx = Math.min(framesData.length - 1, Math.floor(u * (framesData.length - 1)));
        renderTimeFrame(timeIdx);

        const dronePos = curve.getPointAt(u);
        droneMesh.position.copy(dronePos);

        const theta = -Math.PI * 0.45 + u * 0.65;
        const radius = 78 - 14 * Math.sin(u * Math.PI);
        const camX = radius * Math.cos(theta);
        const camY = radius * Math.sin(theta);
        const camZ = 46 - 10 * u;

        camera.position.set(camX, camY, camZ);
        camera.lookAt(dronePos.x * 0.4, dronePos.y * 0.4, 12);

        renderer.render(scene, camera);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        statusEl.innerText = "Recording frame " + (i + 1) + "/" + TOTAL_FRAMES + " (t=" + (u * 3.0).toFixed(2) + "s)";

        await fetch('/upload-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i, total: TOTAL_FRAMES, dataUrl: dataUrl, u: u })
        });
      }

      statusEl.innerText = "All frames captured!";
      await fetch('/done', { method: 'POST' });
    }

    setTimeout(recordAllFrames, 400);
  </script>
</body>
</html>`;
}

let activeChrome = null;
let currentFramesDir = '';
let receivedCount = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/upload-frame') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const base64Data = payload.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
        const filename = `frame_${String(payload.index).padStart(4, '0')}.jpg`;
        fs.writeFileSync(path.join(currentFramesDir, filename), Buffer.from(base64Data, 'base64'));
        receivedCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
  } else if (req.method === 'POST' && req.url === '/done') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'complete' }));
    onDistrictFramesDone();
  } else if (req.url === '/recorder.html') {
    const dist = targetDistricts[currentDistrictIndex];
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateRendererHtml(dist.data));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Blockout Batch Server running on port ${PORT}`);
  processNextDistrict();
});

function processNextDistrict() {
  if (currentDistrictIndex >= targetDistricts.length) {
    console.log('🎉 ALL DISTRICT BLOCKOUTS PROCESSED SUCCESSFULLY!');
    server.close(() => process.exit(0));
    return;
  }

  const dist = targetDistricts[currentDistrictIndex];
  console.log(`\n======================================================`);
  console.log(`🎬 Processing District [${currentDistrictIndex + 1}/${targetDistricts.length}]: ${dist.data.name} (${dist.key})`);
  console.log(`======================================================`);

  currentFramesDir = path.resolve(`public/videos/frames_${dist.key}`);
  fs.mkdirSync(currentFramesDir, { recursive: true });
  receivedCount = 0;

  launchHeadlessChrome();
}

function launchHeadlessChrome() {
  const tmpDir = fs.mkdtempSync('/tmp/chrome_blockout_');
  activeChrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    '--no-sandbox',
    '--no-proxy-server',
    `--user-data-dir=${tmpDir}`,
    '--window-size=1280,720',
    `http://127.0.0.1:${PORT}/recorder.html`
  ]);

  activeChrome.on('error', (err) => {
    console.error('Failed to launch Chrome:', err);
  });
}

function onDistrictFramesDone() {
  if (activeChrome) {
    activeChrome.kill();
    activeChrome = null;
  }

  const dist = targetDistricts[currentDistrictIndex];
  const blockoutMp4 = path.join(VIDEOS_DIR, `s4d_${dist.key}_blockout_ref.mp4`);
  const synthMp4 = path.join(VIDEOS_DIR, `s4d_${dist.key}_omni_synthesis.mp4`);
  const compMp4 = path.join(VIDEOS_DIR, `s4d_${dist.key}_comparison.mp4`);

  console.log(`🎥 Compiling Blockout MP4 for ${dist.key}...`);
  const ffmpegBlockout = `/opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${currentFramesDir}/frame_%04d.jpg" -c:v libx264 -pix_fmt yuv420p -b:v 4M "${blockoutMp4}"`;

  exec(ffmpegBlockout, (err) => {
    if (err) {
      console.error(`❌ ffmpeg blockout error for ${dist.key}:`, err);
    } else {
      console.log(`✅ Generated: ${blockoutMp4} (${(fs.statSync(blockoutMp4).size / 1024).toFixed(1)} KB)`);
      
      console.log(`⚡ Compiling Comparison Split MP4 for ${dist.key}...`);
      const ffmpegComp = `/opt/homebrew/bin/ffmpeg -y -i "${blockoutMp4}" -i "${synthMp4}" -filter_complex "[0:v]scale=640:720:force_original_aspect_ratio=increase,crop=640:720[left];[1:v]scale=640:720:force_original_aspect_ratio=increase,crop=640:720[right];[left][right]hstack[v]" -map "[v]" -t 3.0 -r 24 -c:v libx264 -pix_fmt yuv420p -b:v 4M "${compMp4}"`;
      
      exec(ffmpegComp, (err2) => {
        if (err2) {
          console.error(`❌ ffmpeg comparison error for ${dist.key}:`, err2);
        } else {
          console.log(`✅ Generated: ${compMp4} (${(fs.statSync(compMp4).size / 1024).toFixed(1)} KB)`);
        }
        
        currentDistrictIndex++;
        processNextDistrict();
      });
    }
  });
}
