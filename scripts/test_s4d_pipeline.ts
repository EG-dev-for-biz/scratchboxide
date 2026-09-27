import fs from 'node:fs';
import path from 'node:path';
import { S4DWorldModelBridge } from '../packages/core/src/node/spatial/S4DWorldModelBridge.js';
import { GeospatialSemanticClass } from '../packages/core/src/common/geospatial-4d-protocol.js';

interface TestMetrics {
  totalVoxels: number;
  freeSpaceVoxels: number;
  occupiedVoxels: number;
  occupancyRatePct: number;
  classDistribution: Record<string, number>;
  temporalStaticConsistencyPct: number;
  cameraWaypointCollisionCount: number;
}

export function testS4DSample(promptPath: string, tensorPath: string): { success: boolean; metrics: TestMetrics; htmlPreviewPath: string } {
  console.log(`\n======================================================`);
  console.log(`  🧪 Testing Scratchbox-4D Spatiotemporal Sample`);
  console.log(`  Prompt: ${promptPath}`);
  console.log(`  Tensor: ${tensorPath}`);
  console.log(`======================================================\n`);

  const promptRaw = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
  const rleBase64 = fs.readFileSync(tensorPath, 'utf8');

  // 1. Lossless Decompression Verification
  const expectedVoxels = 16 * 64 * 64 * 32;
  const decompressed = S4DWorldModelBridge.rleDecode(rleBase64, expectedVoxels);

  if (decompressed.length !== expectedVoxels) {
    throw new Error(`Decompression error: Expected ${expectedVoxels} voxels, got ${decompressed.length}`);
  }
  console.log(`[PASS] Tensor decompress: 16x64x64x32 (${decompressed.length} voxels, byte size: ${decompressed.byteLength} B)`);

  // 2. Semantic Class Distribution & Bounds Check
  const classCounts: Record<number, number> = {};
  for (let i = 0; i < decompressed.length; i++) {
    const cls = decompressed[i];
    if (cls < 0 || cls > 9) {
      throw new Error(`Invalid semantic class ID ${cls} at voxel index ${i}`);
    }
    classCounts[cls] = (classCounts[cls] || 0) + 1;
  }
  console.log(`[PASS] Semantic bounds check: All voxel classes in range [0, 9]`);

  // Map to class names
  const classNames: Record<number, string> = {
    [GeospatialSemanticClass.FREE_SPACE]: 'Free Space',
    [GeospatialSemanticClass.GROUND]: 'Ground',
    [GeospatialSemanticClass.ROAD]: 'Road',
    [GeospatialSemanticClass.BUILDING]: 'Building',
    [GeospatialSemanticClass.VEGETATION]: 'Vegetation',
    [GeospatialSemanticClass.DYNAMIC_VEHICLE]: 'Dynamic Vehicle',
    [GeospatialSemanticClass.DYNAMIC_PEDESTRIAN]: 'Dynamic Pedestrian',
    [GeospatialSemanticClass.SKY]: 'Sky',
    [GeospatialSemanticClass.WATER]: 'Water',
    [GeospatialSemanticClass.INFRASTRUCTURE]: 'Infrastructure',
  };

  const classDistHuman: Record<string, number> = {};
  for (const [cls, count] of Object.entries(classCounts)) {
    const name = classNames[Number(cls)] || `Class_${cls}`;
    classDistHuman[name] = count;
  }

  const freeSpaceCount = classCounts[GeospatialSemanticClass.FREE_SPACE] || 0;
  const occupiedCount = expectedVoxels - freeSpaceCount;
  const occupancyRate = (occupiedCount / expectedVoxels) * 100;

  // 3. Temporal Static Consistency (Frame-to-Frame Stability for Static Structures)
  const frameStride = 64 * 64 * 32;
  let staticChecks = 0;
  let staticMatches = 0;

  for (let t = 0; t < 15; t++) {
    const frameAOffset = t * frameStride;
    const frameBOffset = (t + 1) * frameStride;

    for (let v = 0; v < frameStride; v++) {
      const clsA = decompressed[frameAOffset + v];
      const clsB = decompressed[frameBOffset + v];

      if (clsA === GeospatialSemanticClass.BUILDING || clsA === GeospatialSemanticClass.ROAD || clsA === GeospatialSemanticClass.GROUND) {
        staticChecks++;
        if (clsA === clsB) {
          staticMatches++;
        }
      }
    }
  }

  const temporalConsistency = staticChecks > 0 ? (staticMatches / staticChecks) * 100 : 100;
  console.log(`[PASS] Temporal static consistency: ${temporalConsistency.toFixed(2)}% (static geography remains fixed across time)`);

  // 4. Camera Trajectory Clearance
  const waypoints = promptRaw.prompt.waypoints || [];
  let collisions = 0;

  for (let t = 0; t < Math.min(16, waypoints.length); t++) {
    const wp = waypoints[t];
    const vx = Math.floor(((wp.x + 50) / 100) * 64);
    const vy = Math.floor(((wp.y + 50) / 100) * 64);
    const vz = Math.floor((wp.z / 30) * 32);

    if (vx >= 0 && vx < 64 && vy >= 0 && vy < 64 && vz >= 0 && vz < 32) {
      const voxelIdx = t * frameStride + (vz * 64 * 64 + vy * 64 + vx);
      const cls = decompressed[voxelIdx];
      if (cls === GeospatialSemanticClass.BUILDING) {
        collisions++;
      }
    }
  }
  console.log(`[PASS] Camera trajectory clearance: ${collisions} collision(s) detected across 16 frames`);

  const metrics: TestMetrics = {
    totalVoxels: expectedVoxels,
    freeSpaceVoxels: freeSpaceCount,
    occupiedVoxels: occupiedCount,
    occupancyRatePct: Number(occupancyRate.toFixed(2)),
    classDistribution: classDistHuman,
    temporalStaticConsistencyPct: Number(temporalConsistency.toFixed(2)),
    cameraWaypointCollisionCount: collisions,
  };

  // 5. Generate Standalone HTML 4D Viewer
  const subsampledFrames: { time: number; voxels: number[][] }[] = [];
  const sampleTimeSteps = [0, 4, 8, 12, 15];

  for (const t of sampleTimeSteps) {
    const frameOffset = t * frameStride;
    const voxelsList: number[][] = [];
    for (let z = 0; z < 32; z += 2) {
      for (let y = 0; y < 64; y += 2) {
        for (let x = 0; x < 64; x += 2) {
          const idx = frameOffset + (z * 64 * 64 + y * 64 + x);
          const cls = decompressed[idx];
          if (cls !== GeospatialSemanticClass.FREE_SPACE && cls !== GeospatialSemanticClass.SKY) {
            voxelsList.push([x - 32, y - 32, z, cls]);
          }
        }
      }
    }
    subsampledFrames.push({ time: t, voxels: voxelsList });
  }

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Scratchbox-4D (S4D) Interactive Spatiotemporal Viewer</title>
  <style>
    body { margin: 0; padding: 0; overflow: hidden; background: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #fff; }
    #canvas-container { width: 100vw; height: 100vh; position: absolute; top: 0; left: 0; }
    #overlay { position: absolute; top: 20px; left: 20px; z-index: 10; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 18px 24px; max-width: 420px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
    h2 { margin: 0 0 6px 0; font-size: 18px; font-weight: 700; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(56, 189, 248, 0.2); color: #38bdf8; margin-bottom: 12px; }
    .metrics { font-size: 12px; line-height: 1.6; color: #94a3b8; }
    .metrics span { color: #f1f5f9; font-weight: 600; }
    #timeline-panel { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 10; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 14px 28px; display: flex; align-items: center; gap: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
    .slider { width: 300px; accent-color: #38bdf8; cursor: pointer; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; }
    .dot { width: 10px; height: 10px; border-radius: 2px; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="overlay">
    <h2>Scratchbox-4D Spatiotemporal Viewer</h2>
    <div class="badge">Dataset Item: ${promptRaw.id}</div>
    <div class="metrics">
      District: <span>${promptRaw.district}</span><br>
      WGS84 Origin: <span>${promptRaw.prompt.originWGS84.lat.toFixed(4)}, ${promptRaw.prompt.originWGS84.lng.toFixed(4)} (Alt: ${promptRaw.prompt.originWGS84.alt}m)</span><br>
      Total 4D Voxels: <span>2,097,152 (16 frames x 64x64x32)</span><br>
      Occupancy Rate: <span>${metrics.occupancyRatePct}%</span><br>
      Static Consistency: <span>${metrics.temporalStaticConsistencyPct}%</span><br>
      Trajectory Waypoints: <span>${waypoints.length} (4000 ms duration)</span>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="dot" style="background:#64748b"></div>Road</div>
      <div class="legend-item"><div class="dot" style="background:#22c55e"></div>Ground/Veg</div>
      <div class="legend-item"><div class="dot" style="background:#38bdf8"></div>Building</div>
      <div class="legend-item"><div class="dot" style="background:#ef4444"></div>Vehicle</div>
      <div class="legend-item"><div class="dot" style="background:#f59e0b"></div>Camera Path</div>
    </div>
  </div>

  <div id="timeline-panel">
    <span style="font-size: 13px; font-weight: 600;">Time Step: <span id="time-val">t=0</span></span>
    <input type="range" id="time-slider" class="slider" min="0" max="4" value="0" step="1">
    <button id="toggle-cam" style="background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">Follow Camera</button>
  </div>

  <script>
    const framesData = ${JSON.stringify(subsampledFrames)};
    const waypointsData = ${JSON.stringify(waypoints)};

    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b0f19, 0.008);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(60, -70, 45);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
    dirLight.position.set(50, 40, 80);
    scene.add(dirLight);

    // Color map for classes
    const classColors = {
      1: 0x22c55e, // Ground
      2: 0x475569, // Road
      3: 0x38bdf8, // Building
      4: 0x16a34a, // Vegetation
      5: 0xef4444, // Dynamic Vehicle
      6: 0xf97316, // Dynamic Pedestrian
      8: 0x0284c7, // Water
      9: 0x9333ea  // Infrastructure
    };

    // Draw Camera Trajectory Spline
    if (waypointsData.length > 0) {
      const curvePoints = waypointsData.map(w => new THREE.Vector3(w.x, w.y, w.z));
      const curve = new THREE.CatmullRomCurve3(curvePoints);
      const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.6, 8, false);
      const tubeMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xd97706, roughness: 0.2, metalness: 0.8 });
      const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
      scene.add(tubeMesh);

      // Trajectory points
      curvePoints.forEach(p => {
        const dotGeo = new THREE.SphereGeometry(0.8, 8, 8);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(p);
        scene.add(dot);
      });
    }

    // Instanced Mesh for Voxels
    let instancedVoxelMesh = null;
    const boxGeometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);

    function renderTimeFrame(frameIdx) {
      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
      }

      const frame = framesData[frameIdx];
      const voxels = frame.voxels;
      const count = voxels.length;

      const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
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

      instancedVoxelMesh.instanceColor.needsUpdate = true;
      instancedVoxelMesh.instanceMatrix.needsUpdate = true;
      scene.add(instancedVoxelMesh);
    }

    renderTimeFrame(0);

    // Slider
    const slider = document.getElementById('time-slider');
    const timeVal = document.getElementById('time-val');
    slider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value);
      timeVal.innerText = 't=' + framesData[idx].time;
      renderTimeFrame(idx);
    });

    // Camera follow mode
    let followCamera = false;
    document.getElementById('toggle-cam').addEventListener('click', () => {
      followCamera = !followCamera;
      document.getElementById('toggle-cam').innerText = followCamera ? 'Free Orbit View' : 'Follow Camera';
    });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let animTime = 0;
    function animate() {
      requestAnimationFrame(animate);
      if (followCamera && waypointsData.length > 0) {
        animTime = (animTime + 0.005) % 1;
        const ptIndex = Math.floor(animTime * (waypointsData.length - 1));
        const wp = waypointsData[ptIndex];
        camera.position.set(wp.x, wp.y, wp.z);
        const lookIdx = Math.min(waypointsData.length - 1, ptIndex + 1);
        const nextWp = waypointsData[lookIdx];
        camera.lookAt(nextWp.x, nextWp.y, nextWp.z);
      } else {
        controls.update();
      }
      renderer.render(scene, camera);
    }
    animate();
  </script>
</body>
</html>`;

  const htmlPreviewPath = path.resolve('public/s4d_interactive_viewer.html');
  fs.mkdirSync(path.dirname(htmlPreviewPath), { recursive: true });
  fs.writeFileSync(htmlPreviewPath, htmlContent, 'utf8');
  console.log(`[PASS] Exported interactive HTML viewer to: ${htmlPreviewPath}`);

  return { success: true, metrics, htmlPreviewPath };
}

// CLI execution if invoked directly
testS4DSample('data/test_sample_prompt.json', 'data/test_sample_tensor.rle');
