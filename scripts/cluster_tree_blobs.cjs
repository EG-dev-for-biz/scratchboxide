const fs = require('fs');
const { spawnSync } = require('child_process');

function decodeJpg(buf) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: buf });
  return p.stdout;
}

const glbBuf = fs.readFileSync('public/models/gap_grounded.glb');
const jsonLen = glbBuf.readUInt32LE(12);
const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));
const binOffset = 20 + jsonLen + 8;
const binBuf = glbBuf.subarray(binOffset);

const mIdx = 74; // Mesh 74
const mesh = gltf.meshes[mIdx];
const prim = mesh.primitives[0];
const mat = gltf.materials[prim.material];
const texIdx = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
const imgIdx = gltf.textures[texIdx].source;
const img = gltf.images[imgIdx];
const bv = gltf.bufferViews[img.bufferView];
const imgBuf = binBuf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);

let w = 0, h = 0;
for (let i = 2; i < imgBuf.length - 8; i++) {
  if (imgBuf[i] === 0xFF && (imgBuf[i+1] === 0xC0 || imgBuf[i+1] === 0xC2)) {
    h = imgBuf.readUInt16BE(i + 5);
    w = imgBuf.readUInt16BE(i + 7);
    break;
  }
}
const rgba = decodeJpg(imgBuf);

const posAcc = gltf.accessors[prim.attributes.POSITION];
const posBv = gltf.bufferViews[posAcc.bufferView];
const posBytes = binBuf.subarray((posBv.byteOffset || 0) + (posAcc.byteOffset || 0));

const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
const uvBv = gltf.bufferViews[uvAcc.bufferView];
const uvBytes = binBuf.subarray((uvBv.byteOffset || 0) + (uvAcc.byteOffset || 0));

const idxAcc = gltf.accessors[prim.indices];
const idxBv = gltf.bufferViews[idxAcc.bufferView];
const idxBytes = binBuf.subarray((idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0));

// Read vertices
const verts = [];
const isVeg = new Array(posAcc.count).fill(false);
const vegIndices = [];

for (let v = 0; v < posAcc.count; v++) {
  const x = posBytes.readFloatLE(v * 12);
  const y = posBytes.readFloatLE(v * 12 + 4);
  const z = posBytes.readFloatLE(v * 12 + 8);
  verts.push({ x, y, z });

  const u = uvBytes.readFloatLE(v * 8);
  const vCoord = uvBytes.readFloatLE(v * 8 + 4);

  const px = Math.min(w - 1, Math.max(0, Math.floor(((u % 1 + 1) % 1) * w)));
  const py = Math.min(h - 1, Math.max(0, Math.floor(((vCoord % 1 + 1) % 1) * h)));
  const pIdx = (py * w + px) * 4;
  const r = rgba[pIdx];
  const g = rgba[pIdx + 1];
  const b = rgba[pIdx + 2];

  const sum = r + g + b + 0.001;
  const exg = (2.0 * g - r - b) / sum;
  if (exg > 0.08 && g > r * 1.05 && g > b) {
    isVeg[v] = true;
    vegIndices.push(v);
  }
}

// Read triangles
const tris = [];
const triCount = idxAcc.count / 3;
for (let t = 0; t < triCount; t++) {
  let i0, i1, i2;
  if (idxAcc.componentType === 5123) { // UNSIGNED_SHORT
    i0 = idxBytes.readUInt16LE(t * 6);
    i1 = idxBytes.readUInt16LE(t * 6 + 2);
    i2 = idxBytes.readUInt16LE(t * 6 + 4);
  } else if (idxAcc.componentType === 5125) { // UNSIGNED_INT
    i0 = idxBytes.readUInt32LE(t * 12);
    i1 = idxBytes.readUInt32LE(t * 12 + 4);
    i2 = idxBytes.readUInt32LE(t * 12 + 8);
  }
  tris.push([i0, i1, i2]);
}

// Build adjacency graph of veg triangles
const vegTris = tris.filter(t => isVeg[t[0]] || isVeg[t[1]] || isVeg[t[2]]);
console.log('Vegetative triangles in Mesh 74:', vegTris.length, 'out of', tris.length);

// Connected components via shared vertices
const adj = new Map();
vegTris.forEach((tri, tIdx) => {
  for (let k = 0; k < 3; k++) {
    const v = tri[k];
    if (!adj.has(v)) adj.set(v, []);
    adj.get(v).push(tIdx);
  }
});

const visitedTris = new Set();
const clusters = [];

for (let t = 0; t < vegTris.length; t++) {
  if (visitedTris.has(t)) continue;
  const clusterTris = [];
  const queue = [t];
  visitedTris.add(t);

  while (queue.length > 0) {
    const currT = queue.pop();
    clusterTris.push(vegTris[currT]);
    const tri = vegTris[currT];
    for (let k = 0; k < 3; k++) {
      const v = tri[k];
      const neighbors = adj.get(v) || [];
      for (const n of neighbors) {
        if (!visitedTris.has(n)) {
          visitedTris.add(n);
          queue.push(n);
        }
      }
    }
  }

  // Get unique verts in this cluster
  const clusterVertsSet = new Set();
  clusterTris.forEach(tri => {
    clusterVertsSet.add(tri[0]);
    clusterVertsSet.add(tri[1]);
    clusterVertsSet.add(tri[2]);
  });

  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const vIdx of clusterVertsSet) {
    const p = verts[vIdx];
    min[0] = Math.min(min[0], p.x);
    min[1] = Math.min(min[1], p.y);
    min[2] = Math.min(min[2], p.z);
    max[0] = Math.max(max[0], p.x);
    max[1] = Math.max(max[1], p.y);
    max[2] = Math.max(max[2], p.z);
  }

  clusters.push({
    clusterId: clusters.length,
    vertCount: clusterVertsSet.size,
    triCount: clusterTris.length,
    bounds: {
      x: [min[0].toFixed(1), max[0].toFixed(1)],
      y: [min[1].toFixed(1), max[1].toFixed(1)],
      z: [min[2].toFixed(1), max[2].toFixed(1)],
      size: [(max[0]-min[0]).toFixed(1), (max[1]-min[1]).toFixed(1), (max[2]-min[2]).toFixed(1)]
    },
    clusterTris,
    vertIndices: Array.from(clusterVertsSet)
  });
}

clusters.sort((a, b) => b.vertCount - a.vertCount);
console.log('Found', clusters.length, 'connected vegetation clusters.');
clusters.slice(0, 10).forEach(c => {
  console.log(`Cluster ${c.clusterId}: ${c.vertCount} verts, ${c.triCount} tris, Size: [${c.bounds.size.join(', ')}]m, Y: [${c.bounds.y.join(', ')}]m, X: [${c.bounds.x.join(', ')}]m, Z: [${c.bounds.z.join(', ')}]m`);
});
