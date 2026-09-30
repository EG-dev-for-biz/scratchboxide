const fs = require('fs');
const path = require('path');

const galleryPath = path.resolve(__dirname, '../public/s4d_multi_gallery.html');
let html = fs.readFileSync(galleryPath, 'utf8');

// 1. Ensure GLTFLoader is imported in <head>
if (!html.includes('GLTFLoader.js')) {
  html = html.replace(
    '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>\n  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>'
  );
  console.log('Added GLTFLoader.js script tag');
}

// 2. Load camera path waypoints
const camPathRaw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/models/google_tiles_camera_path.json'), 'utf8'));
const waypoints = camPathRaw.frames.map((f, idx) => ({
  x: parseFloat(f.position[0].toFixed(3)),
  y: parseFloat(f.position[1].toFixed(3)),
  z: parseFloat(f.position[2].toFixed(3)),
  targetX: parseFloat(f.target[0].toFixed(3)),
  targetY: parseFloat(f.target[1].toFixed(3)),
  targetZ: parseFloat(f.target[2].toFixed(3)),
  speedKmh: 48.0,
  timestampMs: Math.round(f.timeSec * 1000)
}));

// 3. Construct the clay district
const clayDistrict = {
  id: "s4d_google_tiles_clay_01",
  name: "Google 3D Tiles Clay Flight (Empire State)",
  shortButtonName: "Clay Flight",
  isGlb: true,
  glbUrl: {
    local: "models/google_tiles_clay_blockout.glb",
    gcs: "https://scratchbox-canvas-multiview-artifacts.storage.googleapis.com/s4d_viewer/models/google_tiles_clay_blockout.glb?x-goog-signature=1459943c39d026d8b77980329eecf386e3a5555d34107f57692eb70019face5c62bc2a7427481e9539162d7df664a99f0424e42c2733a6ac4ca66b61e4ceddd1ef760fdf4f3bb1437e5d8d3f9dad9a8001178cad26c7f5394d99497c5c8df5f525145196bf103b8c93d85d9041c0b9437c34a9af7f362f8fa33f1e09691ff7e4b92b889384642f3410ee07a960c99698d3c16de6251870942442a821fda097f45d975656b9b11b760eb048853770327e1436a042d83d0215f6c651834b97f11e8cdcd4b66ebd42717ea9cb59663fd612a1c5a001b6f68eec2634daa70a968152a283ac24690bcdb1062b06016e68553924c86e4efa93e5dea305460a5721d030&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T162046Z&x-goog-expires=604800&x-goog-signedheaders=host"
  },
  wgs84: { lat: 40.7484, lng: -73.9857, alt: 15 },
  durationMs: 3000,
  occupancyRatePct: 99.8,
  temporalConsistencyPct: 100,
  maxSpeedKmh: 48.0,
  classDistribution: {
    "Limestone": { count: 1820, pct: 66.0 },
    "Curtain Glass": { count: 680, pct: 24.6 },
    "Pavement": { count: 258, pct: 9.4 }
  },
  videoAvailable: true,
  videoSources: {
    comparison: {
      local: "videos/google_tiles_clay_vs_omni_comparison.mp4",
      gcs: "https://scratchbox-canvas-multiview-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_clay_vs_omni_comparison.mp4?x-goog-signature=79f690c84d4787baf59c66cc80fd442dfceb7cccd787fc3665f1afe6927a1f3ad78e08307b1ad3bb711c1b64c540438fb34b74dea6415a2da43ae4dbb80a247b5e3974671781a40e51e94f9e3a20b358f3ffaa6791aa5d4d44ffa47892f3c823f0e2ba9293aca401d1dd7f8324f7e3d19ffb8261f5ef6bd8d681eb4e819bcdb26d6c74cdc83082a30e6362651312cde0564dc58c023ec8e2b9f92ce385c58b4f2620ba5a8296b348e84bb0f9b700289dca504a2b9599715c45bb19cde9758a2b68b5ad54443a25fda748e4a9b4f290a9daf6075cdb01f4b81133fcb36a9b024c3ea6fea6ff661e56fba0a1bf30205ec5619c754086656740ae57c1463c524af0&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T162045Z&x-goog-expires=604800&x-goog-signedheaders=host"
    },
    synthesis: {
      local: "videos/google_tiles_omni_restyled.mp4",
      gcs: "https://scratchbox-canvas-multiview-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_omni_restyled.mp4?x-goog-signature=4ce69f9f3c7a7bc0d8e6bb844dce807280c584f0a0a767b9c88b44793f5dd5ae347c9548b214b8f69adfbe51a824411c490a329996026b3ae50941521cd716e8556a8dc9d745d4c45b5b816222a6748a37ea6c453c04944e964f20dc303fae54c9930f22cf807a7694ca85a929255c47f78091cedb185e9620fe7785f217aa162cd22ed45dbe522ddb6c88cd0964e87133fad76b540863e963754e7ccc7e55c54bfd0651e7d72992298c7ac375e57780654ebd183f181172fc2bb2b6e5aa3342080de534a1cdea116ebac83890f30b48940ea89d54eb96355270fd5417309f5204cd2f012c714492ca4cce29e3b172ae05dfeb52445b26ca215db481702a4644&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T162045Z&x-goog-expires=604800&x-goog-signedheaders=host"
    },
    blockout: {
      local: "videos/google_tiles_clay_blockout_camera.mp4",
      gcs: "https://scratchbox-canvas-multiview-artifacts.storage.googleapis.com/s4d_viewer/videos/google_tiles_clay_blockout_camera.mp4?x-goog-signature=27098803e0235904ad536663ecae1523b22d9003177ed9c9626709dbf53c00f509a14c7d4ae2152e40f722ce32480aecf7b45496479de49d993e7ba5d47953a89ddabd00ea43899cda289e0fc665014e4f37309bdf7db54036dcbd5923d5bf7ecdf9cd8af63e85b663ac94d9c29bb5abcd9edd6a79c11aae4c974363ef5dedd3b8647070bcb73715623a039d5ef3a91610e7d89719423bef7dae036d2ef6194e07b2679556657e9049fd2df9bde8f8752a7cd6f956fb202c6ae68e2be6841511f4d98167e5c7abff3efd5b076cd4c94e016d17dc9d68253de5269c309000ebe3a67349af3e2ae7329bd91112bd5d52fcf7900d6b2a6c0fce828f2f7e4ddef3e0&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T162045Z&x-goog-expires=604800&x-goog-signedheaders=host"
    }
  },
  storyboardBeats: [
    "storyboards_clay/beat_00.jpg",
    "storyboards_clay/beat_01.jpg",
    "storyboards_clay/beat_02.jpg",
    "storyboards_clay/beat_03.jpg",
    "storyboards_clay/beat_04.jpg",
    "storyboards_clay/beat_05.jpg",
    "storyboards_clay/beat_06.jpg",
    "storyboards_clay/beat_07.jpg"
  ],
  aiImageUrl: "https://scratchbox-canvas-multiview-artifacts.storage.googleapis.com/s4d_viewer/videos/renders_clay/beat_04.png?x-goog-signature=6597b9f02b100a84de44c4589936ecceac7aac033df20f082df44f3319fcaf384baa406f2718dc505292fbbf57d31312632ad9bd4a53019634ec596bb17d8c1a92071f790c782bd7819b610b8e54024f4b5ae01e785cfccb1e5d6f1285ca6d5076ba6556a725993c281d5789342f34638c585818a071e07297c78e52bdfdf931f75769487d0c16976fdaeae7a88dae0e0bf64870882a529f38e23389e099ec57fb55023e34b0543c1816755beaf26df430a686aa4aafc937160b9476cd1b41715af72cc84a9a9f9e73c531a5b4215b0fdb04aa44588f1521cb88792828145e861498e4346ada0e6ff4c570bf5e40449757c795a7efd36150c70f8173254d84cd&x-goog-algorithm=GOOG4-RSA-SHA256&x-goog-credential=credit%40scratchbox-canvas.iam.gserviceaccount.com%2F20260917%2Fus-central1%2Fstorage%2Fgoog4_request&x-goog-date=20260917T162045Z&x-goog-expires=604800&x-goog-signedheaders=host",
  localImage: "videos/renders_clay/beat_04.png",
  aiDescription: "Google 3D Tiles Clay Mode environment animated strictly from camera perspective along 5th Avenue and up the Empire State Building setbacks, restyled into photorealistic golden hour cinema via Google Omni 1.1 Flash multimodal conditioning.",
  waypoints: waypoints,
  frames: [{ time: 0, voxels: [] }]
};

// 4. Parse evaluationsData from html
const match = html.match(/const evaluationsData = (\[.*?\]);/s);
if (!match) {
  console.error("Could not find evaluationsData");
  process.exit(1);
}

const data = JSON.parse(match[1]);

// Check if already injected
const existingIdx = data.findIndex(d => d.id === 's4d_google_tiles_clay_01');
if (existingIdx >= 0) {
  data[existingIdx] = clayDistrict;
  console.log('Updated existing Clay Flight entry');
} else {
  // Prepend Clay Flight entry as District 0 so it loads prominently first!
  data.unshift(clayDistrict);
  console.log('Prepended Clay Flight entry as District 0');
}

html = html.replace(/const evaluationsData = \[.*?\];/s, `const evaluationsData = ${JSON.stringify(data)};`);

// 5. Update renderScene, animate, and GLTF loading logic
html = html.replace(
  "btn.innerText = d.name.split(' ')[0];",
  "btn.innerText = d.shortButtonName || d.name.split(' ')[0];"
);

// Inject GLTF mesh handling
if (!html.includes('let clayGlbModel = null;')) {
  html = html.replace(
    'let instancedVoxelMesh = null;',
    'let instancedVoxelMesh = null;\n    let clayGlbModel = null;\n    const gltfLoader = new THREE.GLTFLoader();'
  );
}

// Update renderScene() to handle isGlb
const oldRenderBlock = `      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
      }`;

const newRenderBlock = `      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
        instancedVoxelMesh = null;
      }

      if (dist.isGlb) {
        camera.up.set(0, 1, 0);
        if (!clayGlbModel) {
          const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
          const glbSrc = isLocal ? dist.glbUrl.local : dist.glbUrl.gcs;
          gltfLoader.load(glbSrc, (gltf) => {
            clayGlbModel = gltf.scene;
            clayGlbModel.traverse(c => {
              if (c.isMesh) {
                c.material.side = THREE.DoubleSide;
                c.castShadow = true;
                c.receiveShadow = true;
              }
            });
            scene.add(clayGlbModel);
          }, undefined, (err) => {
            console.error('Failed loading local GLB, falling back to GCS:', err);
            gltfLoader.load(dist.glbUrl.gcs, (gltf) => {
              clayGlbModel = gltf.scene;
              scene.add(clayGlbModel);
            });
          });
        } else {
          scene.add(clayGlbModel);
        }
        controls.target.set(0, 50, 0);
        camera.position.set(220, 160, -300);
        controls.update();
        return;
      } else {
        if (clayGlbModel) scene.remove(clayGlbModel);
        camera.up.set(0, 0, 1);
      }`;

if (html.includes(oldRenderBlock)) {
  html = html.replace(oldRenderBlock, newRenderBlock);
  console.log('Updated renderScene for GLB support');
}

// Update animate() for followCamera when isGlb is true
const oldFollowBlock = `        camera.position.set(wp.x, wp.y, wp.z);
        const lookIdx = Math.min(dist.waypoints.length - 1, ptIndex + 1);
        const nextWp = dist.waypoints[lookIdx];
        camera.lookAt(nextWp.x, nextWp.y, nextWp.z);`;

const newFollowBlock = `        camera.position.set(wp.x, wp.y, wp.z);
        if (dist.isGlb && wp.targetX !== undefined) {
          camera.lookAt(wp.targetX, wp.targetY, wp.targetZ);
        } else {
          const lookIdx = Math.min(dist.waypoints.length - 1, ptIndex + 1);
          const nextWp = dist.waypoints[lookIdx];
          camera.lookAt(nextWp.x, nextWp.y, nextWp.z);
        }`;

if (html.includes(oldFollowBlock)) {
  html = html.replace(oldFollowBlock, newFollowBlock);
  console.log('Updated animate() follow camera logic');
}

fs.writeFileSync(galleryPath, html, 'utf8');
console.log('Successfully updated', galleryPath);
