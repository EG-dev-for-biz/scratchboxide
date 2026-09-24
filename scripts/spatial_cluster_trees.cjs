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

// Gather all vegetative vertices across Mesh 73 and 74
const allVegVerts = [];

for (const mIdx of [73, 74]) {
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

  const triCount = idxAcc.count / 3;
  const meshTris = [];
  for (let t = 0; t < triCount; t++) {
    let i0, i1, i2;
    if (idxAcc.componentType === 5123) {
      i0 = idxBytes.readUInt16LE(t * 6);
      i1 = idxBytes.readUInt16LE(t * 6 + 2);
      i2 = idxBytes.readUInt16LE(t * 6 + 4);
    } else {
      i0 = idxBytes.readUInt32LE(t * 12);
      i1 = idxBytes.readUInt32LE(t * 12 + 4);
      i2 = idxBytes.readUInt32LE(t * 12 + 8);
    }
    meshTris.push([i0, i1, i2]);
  }

  for (let v = 0; v < posAcc.count; v++) {
    const x = posBytes.readFloatLE(v * 12);
    const y = posBytes.readFloatLE(v * 12 + 4);
    const z = posBytes.readFloatLE(v * 12 + 8);

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
      allVegVerts.push({
        mIdx,
        vIdx: v,
        pos: [x, y, z],
        color: [r/255, g/255, b/255],
        meshTris
      });
    }
  }
}

console.log('Total vegetative vertices across Mesh 73 & 74:', allVegVerts.length);

// Euclidean clustering with radius = 4.0 meters
const clusterLabels = new Array(allVegVerts.length).fill(-1);
let numClusters = 0;
const d2Max = 4.0 * 4.0;

for (let i = 0; i < allVegVerts.length; i++) {
  if (clusterLabels[i] !== -1) continue;
  const queue = [i];
  clusterLabels[i] = numClusters;

  while (queue.length > 0) {
    const curr = queue.pop();
    const p1 = allVegVerts[curr].pos;

    for (let j = 0; j < allVegVerts.length; j++) {
      if (clusterLabels[j] !== -1) continue;
      const p2 = allVegVerts[j].pos;
      const dx = p1[0] - p2[0];
      const dy = p1[1] - p2[1];
      const dz = p1[2] - p2[2];
      if (dx*dx + dy*dy + dz*dz <= d2Max) {
        clusterLabels[j] = numClusters;
        queue.push(j);
      }
    }
  }
  numClusters++;
}

console.log('Formed', numClusters, 'Euclidean tree clusters.');

// Aggregate clusters
const clusters = [];
for (let c = 0; c < numClusters; c++) {
  const members = [];
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < allVegVerts.length; i++) {
    if (clusterLabels[i] === c) {
      members.push(allVegVerts[i]);
      const p = allVegVerts[i].pos;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  clusters.push({
    clusterId: c,
    count: members.length,
    bounds: {
      min: min.map(v => v.toFixed(2)),
      max: max.map(v => v.toFixed(2)),
      size: size.map(v => v.toFixed(2)),
      center: [((min[0]+max[0])/2).toFixed(2), ((min[1]+max[1])/2).toFixed(2), ((min[2]+max[2])/2).toFixed(2)]
    },
    members
  });
}

clusters.sort((a, b) => b.count - a.count);

// Filter clusters that look like realistic individual trees:
// Height: 4m to 16m, Spread: 3m to 14m, count >= 20 verts
const treeCandidates = clusters.filter(c => {
  const h = parseFloat(c.bounds.size[1]);
  const sx = parseFloat(c.bounds.size[0]);
  const sz = parseFloat(c.bounds.size[2]);
  return h >= 3.5 && h <= 18.0 && sx >= 2.5 && sx <= 16.0 && sz >= 2.5 && sz <= 16.0 && c.count >= 20;
});

console.log('Realistic individual tree candidates:', treeCandidates.length);
treeCandidates.forEach((c, idx) => {
  console.log(`Candidate ${idx}: Cluster ${c.clusterId} (${c.count} veg verts)`);
  console.log(`  Height: ${c.bounds.size[1]}m, Spread: ${c.bounds.size[0]}m × ${c.bounds.size[2]}m`);
  console.log(`  Center: [${c.bounds.center.join(', ')}]m`);
  console.log(`  Elevation: Y = [${c.bounds.min[1]}, ${c.bounds.max[1]}]m`);
});
