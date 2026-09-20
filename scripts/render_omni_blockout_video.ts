import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { exec, spawn } from 'node:child_process';
import { OccSoraBridge } from '../packages/core/src/node/spatial/OccSoraBridge.js';
import { GeospatialSemanticClass } from '../packages/core/src/common/geospatial-4d-protocol.js';

const PORT = 8089;
const TOTAL_FRAMES = 72; // 3.0 seconds at 24 fps
const STORYBOARD_BEATS = 8;

const FRAMES_DIR = path.resolve('public/videos/frames');
const STORYBOARDS_DIR = path.resolve('public/storyboards');
const VIDEOS_DIR = path.resolve('public/videos');

fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(STORYBOARDS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// 1. Load Manhattan prompt and tensor
const promptRaw = JSON.parse(fs.readFileSync('data/test_sample_prompt.json', 'utf8'));
const rleBase64 = fs.readFileSync('data/test_sample_tensor.rle', 'utf8');

const expectedVoxels = 16 * 64 * 64 * 32;
const decompressed = OccSoraBridge.rleDecode(rleBase64, expectedVoxels);
const frameStride = 64 * 64 * 32;

// Subsample 8 frames for smooth time progression
const timeIndices = [0, 2, 4, 6, 8, 10, 12, 15];
const framesData: { time: number; voxels: number[][] }[] = [];

for (const t of timeIndices) {
  const off = t * frameStride;
  const vox: number[][] = [];
  for (let z = 0; z < 32; z += 2) {
    for (let y = 0; y < 64; y += 2) {
      for (let x = 0; x < 64; x += 2) {
        const idx = off + (z * 64 * 64 + y * 64 + x);
        const cls = decompressed[idx];
        if (cls !== GeospatialSemanticClass.FREE_SPACE && cls !== GeospatialSemanticClass.SKY) {
          vox.push([x - 32, y - 32, z, cls]);
        }
      }
    }
  }
  framesData.push({ time: t, voxels: vox });
}

const waypointsData = promptRaw.prompt.waypoints;

// 2. Generate the HTML recorder page
const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>S4D Blockout Reference Video Recorder</title>
  <style>
    body { margin: 0; background: #070a12; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; color: #fff; }
    #canvas { width: 1280px; height: 720px; display: block; }
    #status { position: absolute; bottom: 16px; left: 16px; background: rgba(11, 15, 25, 0.9); backdrop-filter: blur(8px); padding: 8px 16px; border-radius: 8px; font-size: 13px; z-index: 100; border: 1px solid rgba(56, 189, 248, 0.3); box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    #hud { position: absolute; top: 16px; left: 16px; z-index: 90; display: flex; gap: 8px; }
    .badge { background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-size: 11px; font-weight: bold; padding: 5px 12px; border-radius: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
    .badge-gold { background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; color: #f59e0b; }
    .badge-purple { background: rgba(168, 85, 247, 0.15); border: 1px solid #a855f7; color: #c084fc; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
  <div id="hud">
    <div class="badge">SCRATCHBOX-4D SPATIAL ENGINE</div>
    <div class="badge badge-gold">&lt;VIDEO_REF_0&gt; 3D BLOCKOUT</div>
    <div class="badge badge-purple">4D TRAJECTORY CONDITIONING</div>
  </div>
  <div id="status">Initializing 3D Blockout Renderer...</div>
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

    // Dynamic cinematic lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfef08a, 1.7);
    sunLight.position.set(70, -50, 90);
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
    fillLight.position.set(-60, 50, 30);
    scene.add(fillLight);

    const classColors = {
      1: 0x22c55e, // Ground
      2: 0x475569, // Road
      3: 0x38bdf8, // Buildings
      4: 0x16a34a, // Vegetation
      5: 0xef4444, // Vehicles
      6: 0xf97316, // Pedestrians
      8: 0x0284c7, // Water
      9: 0x9333ea  // Infrastructure
    };

    // Trajectory spline
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

    // Trajectory waypoint markers
    curvePoints.forEach((p, idx) => {
      const dotGeo = new THREE.SphereGeometry(1.0, 12, 12);
      const dotMat = new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x22c55e : (idx === curvePoints.length - 1 ? 0xef4444 : 0xfef08a) });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p);
      scene.add(dot);
    });

    // Drone / Camera flight head indicator
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

        // Position animated drone mesh along the flight trajectory
        const dronePos = curve.getPointAt(u);
        droneMesh.position.copy(dronePos);

        // Smooth cinematic orbital sweep over the Manhattan Canyon blockout
        // Sweeps azimuth from -75 deg to -35 deg, descending slightly to reveal skyscrapers
        const theta = -Math.PI * 0.45 + u * 0.65;
        const radius = 78 - 14 * Math.sin(u * Math.PI);
        const camX = radius * Math.cos(theta);
        const camY = radius * Math.sin(theta);
        const camZ = 46 - 10 * u;

        camera.position.set(camX, camY, camZ);
        // Track between the city center and the active drone
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

      statusEl.innerText = "All frames captured! Transferring to encoder...";
      await fetch('/done', { method: 'POST' });
    }

    setTimeout(recordAllFrames, 500);
  </script>
</body>
</html>`;

fs.writeFileSync('public/s4d_blockout_render.html', htmlContent);
console.log('✅ Generated public/s4d_blockout_render.html');

let receivedFrames = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/upload-frame') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const base64Data = payload.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
        const filename = `frame_${String(payload.index).padStart(4, '0')}.jpg`;
        const filepath = path.join(FRAMES_DIR, filename);
        fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

        const beatStep = Math.floor(TOTAL_FRAMES / STORYBOARD_BEATS);
        if (payload.index % beatStep === 0 && Math.floor(payload.index / beatStep) < STORYBOARD_BEATS) {
          const beatIdx = Math.floor(payload.index / beatStep);
          const beatFilename = `beat_${String(beatIdx).padStart(2, '0')}.jpg`;
          fs.writeFileSync(path.join(STORYBOARDS_DIR, beatFilename), Buffer.from(base64Data, 'base64'));
          console.log(`📸 Storyboard Beat ${beatIdx + 1}/${STORYBOARD_BEATS} saved: ${beatFilename}`);
        }

        receivedFrames++;
        if (receivedFrames % 12 === 0 || receivedFrames === TOTAL_FRAMES) {
          console.log(`🎞️  Captured Frame ${receivedFrames}/${TOTAL_FRAMES} (${(receivedFrames / TOTAL_FRAMES * 100).toFixed(0)}%)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
  } else if (req.method === 'POST' && req.url === '/done') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'complete' }));
    console.log('🎉 All 72 frames successfully transferred to server!');
    compileVideo();
  } else if (req.url === '/s4d_blockout_render.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(htmlContent);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Recorder server running on http://127.0.0.1:${PORT}`);
  launchChrome();
});

let chromeProcess: any = null;

function launchChrome() {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const args = [
    '--headless=new',
    '--user-data-dir=/tmp/chrome_blockout_rec',
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=metal',
    '--window-size=1280,720',
    `http://127.0.0.1:${PORT}/s4d_blockout_render.html`
  ];
  console.log(`🌐 Launching headless Chrome to capture blockout animation...`);
  chromeProcess = spawn(chromePath, args);
  chromeProcess.on('error', (err: any) => {
    console.error('Failed to launch Chrome:', err);
  });
}

function compileVideo() {
  if (chromeProcess) {
    chromeProcess.kill();
  }

  const mp4Output = path.join(VIDEOS_DIR, 's4d_manhattan_blockout_ref.mp4');
  const webmOutput = path.join(VIDEOS_DIR, 's4d_manhattan_blockout_ref.webm');

  console.log(`🎬 Compiling MP4 video via ffmpeg (24fps, H.264, 3.0s)...`);
  const ffmpegCmd = `/opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libx264 -pix_fmt yuv420p -b:v 4M "${mp4Output}" && /opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libvpx-vp9 -b:v 3M "${webmOutput}"`;

  exec(ffmpegCmd, (err, stdout, stderr) => {
    if (err) {
      console.error('❌ ffmpeg compilation error:', err);
    } else {
      console.log(`✅ Successfully generated: ${mp4Output} (${(fs.statSync(mp4Output).size / 1024).toFixed(1)} KB)`);
      console.log(`✅ Successfully generated: ${webmOutput} (${(fs.statSync(webmOutput).size / 1024).toFixed(1)} KB)`);
    }
    server.close(() => {
      console.log('🏁 Process complete. Exiting.');
      process.exit(0);
    });
  });
}
