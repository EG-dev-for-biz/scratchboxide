import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

if (typeof FileReader === 'undefined') {
  global.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(buf => {
        this.result = buf;
        if (this.onload) this.onload({ target: this });
        if (this.onloadend) this.onloadend({ target: this });
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buf => {
        this.result = 'data:application/octet-stream;base64,' + Buffer.from(buf).toString('base64');
        if (this.onload) this.onload({ target: this });
        if (this.onloadend) this.onloadend({ target: this });
      });
    }
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../public/models/sydney_opera_house_textured.glb');

// Export scene at bottom


const scene = new THREE.Scene();
scene.name = "SydneyOperaHouse_3DModel";

// Materials
const podiumMat = new THREE.MeshStandardMaterial({
  color: 0x8a8780, // Pinkish-grey granite aggregate
  roughness: 0.82,
  metalness: 0.10,
  name: "PodiumGranite"
});

const shellMat = new THREE.MeshStandardMaterial({
  color: 0xf8f6f0, // Iconic Swedish Höganäs glossy off-white & cream chevron ceramic tiles
  roughness: 0.28,
  metalness: 0.08,
  name: "CeramicTiles_ShellWhite"
});

const glassMat = new THREE.MeshStandardMaterial({
  color: 0x242018, // Bronze-tinted solar acoustic glass
  roughness: 0.12,
  metalness: 0.85,
  name: "BronzeCurtainGlass"
});

const waterMat = new THREE.MeshStandardMaterial({
  color: 0x1a3344, // Sydney Harbour deep ocean water
  roughness: 0.20,
  metalness: 0.80,
  name: "HarbourWater"
});

// 1. Water Plane (Sydney Harbour Bennelong Point)
const waterGeo = new THREE.PlaneGeometry(380, 380, 16, 16);
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.rotation.x = -Math.PI / 2;
waterMesh.position.y = 0;
scene.add(waterMesh);

// 2. Granite Podium Plinth (Bennelong Point)
const podiumGeo = new THREE.BoxGeometry(110, 12, 175);
const podiumMesh = new THREE.Mesh(podiumGeo, podiumMat);
podiumMesh.position.set(0, 6, 0);
scene.add(podiumMesh);

// Ceremonial steps leading up to podium from South
for (let step = 0; step < 8; step++) {
  const stepGeo = new THREE.BoxGeometry(90 - step * 4, 1.2, 8 + step * 4);
  const stepMesh = new THREE.Mesh(stepGeo, podiumMat);
  stepMesh.position.set(0, step * 1.2 + 0.6, 95 + step * 3.5);
  scene.add(stepMesh);
}

// Helper to create an authentic spherical sail / shell
function createShell(width, height, depth, thickness = 1.2) {
  const group = new THREE.Group();
  const segments = 24;
  const geom = new THREE.BufferGeometry();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Parabolic vaulted shell profile tapering to pointed peak
  for (let i = 0; i <= segments; i++) {
    const t = i / segments; // 0 (base) to 1 (peak)
    const y = t * height;
    const curWidth = width * (1.0 - Math.pow(t, 1.35));
    const curDepth = depth * (1.0 - t * 0.7);

    // Arch contour across width
    for (let j = 0; j <= segments; j++) {
      const u = (j / segments) * 2 - 1; // -1 to +1
      const archFactor = Math.sqrt(Math.max(0, 1 - u * u));
      const x = u * curWidth * 0.5;
      const z = -archFactor * curDepth * (0.8 + 0.2 * (1 - t));

      positions.push(x, y, z);
      
      // Compute outward normal
      const nx = x / (curWidth * 0.5 + 1e-4);
      const ny = 0.4;
      const nz = z / (curDepth + 1e-4);
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / len, ny / len, nz / len);
      uvs.push(j / segments, t);
    }
  }

  const stride = segments + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = (i + 1) * stride + (j + 1);
      const d = i * stride + (j + 1);
      indices.push(a, b, c);
      indices.push(a, c, d);
      // Double sided
      indices.push(a, c, b);
      indices.push(a, d, c);
    }
  }

  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const shellMesh = new THREE.Mesh(geom, shellMat);
  group.add(shellMesh);

  // Infill bronze glass wall beneath the mouth of the shell
  const glassGeo = new THREE.BufferGeometry();
  const gPositions = [
    -width * 0.45, 0, 0,
    width * 0.45, 0, 0,
    0, height * 0.92, -depth * 0.2
  ];
  const gNormals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const gUvs = [0, 0, 1, 0, 0.5, 1];
  glassGeo.setAttribute('position', new THREE.Float32BufferAttribute(gPositions, 3));
  glassGeo.setAttribute('normal', new THREE.Float32BufferAttribute(gNormals, 3));
  glassGeo.setAttribute('uv', new THREE.Float32BufferAttribute(gUvs, 2));
  glassGeo.setIndex([0, 1, 2, 0, 2, 1]);
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  group.add(glassMesh);

  return group;
}

// 3. Concert Hall (Western Major Hall - 4 pairs of interlocking soaring shells)
const concertHallGroup = new THREE.Group();
concertHallGroup.position.set(-20, 12, -10);

const ch1 = createShell(38, 54, 34); // Peak sail (66m above sea level)
ch1.position.set(0, 0, -32);
concertHallGroup.add(ch1);

const ch2 = createShell(34, 46, 30);
ch2.position.set(0, 0, -6);
concertHallGroup.add(ch2);

const ch3 = createShell(30, 36, 26);
ch3.position.set(0, 0, 18);
concertHallGroup.add(ch3);

const ch4 = createShell(24, 26, 20);
ch4.position.set(0, 0, 38);
concertHallGroup.add(ch4);

scene.add(concertHallGroup);

// 4. Opera Theatre / Joan Sutherland Theatre (Eastern Sister Hall - 4 pairs of shells)
const operaTheatreGroup = new THREE.Group();
operaTheatreGroup.position.set(24, 12, -6);

const ot1 = createShell(34, 48, 30);
ot1.position.set(0, 0, -28);
operaTheatreGroup.add(ot1);

const ot2 = createShell(30, 40, 26);
ot2.position.set(0, 0, -4);
operaTheatreGroup.add(ot2);

const ot3 = createShell(26, 32, 22);
ot3.position.set(0, 0, 18);
operaTheatreGroup.add(ot3);

const ot4 = createShell(20, 22, 18);
ot4.position.set(0, 0, 36);
operaTheatreGroup.add(ot4);

scene.add(operaTheatreGroup);

// 5. Bennelong Restaurant Shells (Smaller southern shells)
const restGroup = new THREE.Group();
restGroup.position.set(2, 12, 54);
const r1 = createShell(22, 24, 18);
r1.position.set(0, 0, 0);
restGroup.add(r1);
scene.add(restGroup);

console.log("Exporting Sydney Opera House standardized binary glTF (.glb)...");
await new Promise((resolve, reject) => {
  const exporter = new GLTFExporter();
  exporter.parse(
    scene,
    (result) => {
      fs.writeFileSync(outPath, Buffer.from(result));
      console.log(`✅ Successfully generated authentic Sydney Opera House 3D model (${(result.byteLength / 1024).toFixed(1)} KB) at: ${outPath}`);
      resolve();
    },
    (error) => {
      console.error("Failed to export GLB:", error);
      reject(error);
    },
    { binary: true }
  );
});
