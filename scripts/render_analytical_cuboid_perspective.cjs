/**
 * Render Analytical Synthetic Cuboid Blockout from Camera Perspective.
 * 
 * Sets up an ephemeral HTTP server, renders the 72 frames of the 3-second
 * trajectory via headless Chrome, and compiles public/videos/analytical_cuboid_blockout_camera.mp4.
 * 
 * NOTE: For Google Photorealistic 3D Tiles clay rendering, use
 * scripts/run_google_tiles_blockout_pipeline.cjs (Google3DTileBlockoutPipelineService).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');

const PORT = 8096;
const TOTAL_FRAMES = 72;
const STORYBOARD_BEATS = 8;
const FRAMES_DIR = path.resolve('public/videos/frames_analytical_cuboid');
const STORYBOARDS_DIR = path.resolve('public/storyboards_analytical_cuboid');
const VIDEOS_DIR = path.resolve('public/videos');

fs.mkdirSync(FRAMES_DIR, { recursive: true });
fs.mkdirSync(STORYBOARDS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// Read camera path JSON (fallback to analytical_cuboid_camera_path.json if present)
const cameraPathFile = fs.existsSync('public/models/analytical_cuboid_camera_path.json')
  ? 'public/models/analytical_cuboid_camera_path.json'
  : 'public/models/google_tiles_camera_path.json';
const cameraPathData = JSON.parse(fs.readFileSync(cameraPathFile, 'utf8'));

// Generate HTML client
const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Google Map 3D Tiles Clay Blockout - Camera Perspective Renderer</title>
  <style>
    body { margin: 0; background: #0c0f17; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; color: #fff; }
    #canvas { width: 1280px; height: 720px; display: block; }
    #status { position: absolute; bottom: 16px; left: 16px; background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(10px); padding: 8px 16px; border-radius: 8px; font-size: 13px; z-index: 100; border: 1px solid rgba(56, 189, 248, 0.3); }
    #hud { position: absolute; top: 16px; left: 16px; z-index: 90; display: flex; gap: 8px; }
    .badge { background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-size: 11px; font-weight: bold; padding: 5px 12px; border-radius: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
    .badge-amber { background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; color: #f59e0b; }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/addons/": "/node_modules/three/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <div id="hud">
    <div class="badge">SCRATCHBOX 3D ENGINE</div>
    <div class="badge badge-amber">&lt;VIDEO_REF_0&gt; GOOGLE MAP 3D TILES CLAY BLOCKOUT</div>
    <div class="badge">FIRST-PERSON CAMERA PERSPECTIVE</div>
  </div>
  <div id="status">Loading 3D Clay Environment (.glb)...</div>
  <canvas id="canvas" width="1280" height="720"></canvas>

  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    const pathData = ${JSON.stringify(cameraPathData)};
    const frames = pathData.frames;
    const TOTAL = frames.length;
    const statusEl = document.getElementById('status');
    const canvas = document.getElementById('canvas');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdce3eb); // Architectural sky overcast/clay ambient
    scene.fog = new THREE.FogExp2(0xdce3eb, 0.0022);

    const camera = new THREE.PerspectiveCamera(65, 1280 / 720, 0.5, 3000);
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1280, 720);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    // Architectural Studio Lighting
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x94a3b8, 0.85);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfffaed, 1.45);
    sunLight.position.set(150, 320, 100);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 1000;
    const d = 350;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.00005;
    sunLight.shadow.normalBias = 0.04;
    scene.add(sunLight);

    const skyFill = new THREE.DirectionalLight(0x93c5fd, 0.45);
    skyFill.position.set(-150, 180, -120);
    scene.add(skyFill);

    // Load GLB (Analytical cuboid model)
    const loader = new GLTFLoader();
    loader.load('/public/models/analytical_cuboid_blockout.glb', (gltf) => {
      const cityModel = gltf.scene;

      // Enhance materials with studio architectural clay response
      cityModel.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material) {
            child.material.roughness = 0.82;
            child.material.metalness = 0.02;
            child.material.side = THREE.FrontSide;
          }
        }
      });

      scene.add(cityModel);
      statusEl.innerText = "Model loaded! Starting camera flight recording...";
      setTimeout(recordCameraFrames, 400);
    }, undefined, (err) => {
      statusEl.innerText = "Error loading GLB: " + err.message;
      console.error(err);
    });

    async function recordCameraFrames() {
      for (let i = 0; i < TOTAL; i++) {
        const f = frames[i];

        // Apply exact 6-DOF camera pose
        camera.position.set(f.position[0], f.position[1], f.position[2]);
        camera.up.set(f.up[0], f.up[1], f.up[2]);
        camera.lookAt(f.target[0], f.target[1], f.target[2]);
        camera.fov = f.fov;
        camera.updateProjectionMatrix();

        renderer.render(scene, camera);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.96);
        statusEl.innerText = "Rendering camera frame " + (i + 1) + "/" + TOTAL + " (t=" + f.timeSec.toFixed(2) + "s)";

        await fetch('/upload-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i, total: TOTAL, dataUrl: dataUrl, timeSec: f.timeSec })
        });
      }

      statusEl.innerText = "All 72 camera-perspective frames recorded! Compiling video...";
      await fetch('/done', { method: 'POST' });
    }
  </script>
</body>
</html>`;

fs.writeFileSync('public/s4d_camera_render.html', htmlContent);
console.log('✅ Generated public/s4d_camera_render.html');

let receivedFrames = 0;
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];

  if (req.method === 'POST' && reqPath === '/upload-frame') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const base64Data = payload.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
        const filename = `frame_${String(payload.index).padStart(4, '0')}.jpg`;
        const filepath = path.join(FRAMES_DIR, filename);
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(filepath, buffer);

        if (payload.index === 0) {
          fs.writeFileSync('public/models/blockout_first_frame.jpg', buffer);
          console.log('📸 Stage 1 Viewport Still saved: public/models/blockout_first_frame.jpg');
        }

        // Save storyboard beat keyframe
        const beatStep = Math.floor(TOTAL_FRAMES / STORYBOARD_BEATS);
        if (payload.index % beatStep === 0 && Math.floor(payload.index / beatStep) < STORYBOARD_BEATS) {
          const beatIdx = Math.floor(payload.index / beatStep);
          const beatFilename = `beat_${String(beatIdx).padStart(2, '0')}.jpg`;
          fs.writeFileSync(path.join(STORYBOARDS_DIR, beatFilename), Buffer.from(base64Data, 'base64'));
          console.log(`📸 Storyboard Beat ${beatIdx + 1}/${STORYBOARD_BEATS} saved: ${beatFilename} (t=${payload.timeSec.toFixed(2)}s)`);
        }

        receivedFrames++;
        if (receivedFrames % 12 === 0 || receivedFrames === TOTAL_FRAMES) {
          console.log(`🎬 Captured Camera Frame ${receivedFrames}/${TOTAL_FRAMES} (${Math.round(receivedFrames / TOTAL_FRAMES * 100)}%)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
    return;
  }

  if (req.method === 'POST' && reqPath === '/done') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'complete' }));
    console.log('🎉 All 72 camera-perspective frames received! Compiling video via ffmpeg...');
    compileVideo();
    return;
  }

  // File serving
  if (reqPath === '/' || reqPath === '/s4d_camera_render.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(htmlContent);
  }

  // Normalize path relative to project root
  let localFile = path.join(process.cwd(), reqPath.replace(/^\//, ''));
  if (fs.existsSync(localFile) && fs.statSync(localFile).isFile()) {
    const ext = path.extname(localFile);
    const mimeMap = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.glb': 'model/gltf-binary',
      '.jpg': 'image/jpeg',
      '.png': 'image/png'
    };
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(localFile).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found: ' + reqPath);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Camera perspective recorder server running on http://127.0.0.1:${PORT}`);
  launchChrome();
});

let chromeProcess = null;
function launchChrome() {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmpDir = fs.mkdtempSync('/tmp/chrome_camera_rec_');
  const args = [
    '--headless=new',
    `--user-data-dir=${tmpDir}`,
    '--no-sandbox',
    '--no-proxy-server',
    '--proxy-bypass-list=*',
    '--use-gl=angle',
    '--use-angle=metal',
    '--window-size=1280,720',
    `http://127.0.0.1:${PORT}/s4d_camera_render.html`
  ];

  console.log('🌐 Launching headless Chrome with Metal acceleration in', tmpDir);
  const cleanEnv = { ...process.env };
  delete cleanEnv.http_proxy;
  delete cleanEnv.https_proxy;
  delete cleanEnv.all_proxy;
  delete cleanEnv.HTTP_PROXY;
  delete cleanEnv.HTTPS_PROXY;
  delete cleanEnv.ALL_PROXY;

  chromeProcess = spawn(chromePath, args, { env: cleanEnv });
  chromeProcess.stdout.on('data', d => console.log('[Chrome STDOUT]:', d.toString().trim()));
  chromeProcess.stderr.on('data', d => {
    const s = d.toString().trim();
    if (!s.includes('GLX') && !s.includes('dbus')) {
      console.log('[Chrome STDERR]:', s);
    }
  });
  chromeProcess.on('error', (err) => {
    console.error('Failed to launch Chrome:', err);
  });
}

function compileVideo() {
  if (chromeProcess) {
    chromeProcess.kill();
  }

  const mp4Output = path.join(VIDEOS_DIR, 'analytical_cuboid_blockout_camera.mp4');
  const webmOutput = path.join(VIDEOS_DIR, 'analytical_cuboid_blockout_camera.webm');

  console.log('🎥 Compiling 3-second camera blockout video via ffmpeg (24 fps, H.264)...');
  const ffmpegCmd = `/opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libx264 -pix_fmt yuv420p -b:v 5M "${mp4Output}" && /opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libvpx-vp9 -b:v 4M "${webmOutput}"`;

  exec(ffmpegCmd, (err, stdout, stderr) => {
    if (err) {
      console.error('❌ ffmpeg compilation error:', err);
    } else {
      console.log(`✅ Generated: ${mp4Output} (${(fs.statSync(mp4Output).size / 1024).toFixed(1)} KB)`);
      console.log(`✅ Generated: ${webmOutput} (${(fs.statSync(webmOutput).size / 1024).toFixed(1)} KB)`);
    }

    server.close(() => {
      console.log('🏁 Step 2 complete: Camera perspective animation and video ready!');
      process.exit(0);
    });
  });
}
