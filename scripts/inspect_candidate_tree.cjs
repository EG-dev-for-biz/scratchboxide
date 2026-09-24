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

// Candidate 1: Center [-89.16, 65.71, -149.45]
const targetCenter = [-89.16, 65.71, -149.45];
const radius = 6.0; // 6m radius cylinder
const yMin = 58.0;  // ground level
const yMax = 72.0;  // tree apex

console.log('Inspecting tree blob at', targetCenter, 'within radius', radius);

let collectedVerts = 0;
let collectedTris = 0;

for (const mIdx of [73, 74]) {
  const mesh = gltf.meshes[mIdx];
  const prim = mesh.primitives[0];
  const posAcc = gltf.accessors[prim.attributes.POSITION];
  const posBv = gltf.bufferViews[posAcc.bufferView];
  const posBytes = binBuf.subarray((posBv.byteOffset || 0) + (posAcc.byteOffset || 0));

  const idxAcc = gltf.accessors[prim.indices];
  const idxBv = gltf.bufferViews[idxAcc.bufferView];
  const idxBytes = binBuf.subarray((idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0));

  const triCount = idxAcc.count / 3;
  let inCylTris = 0;
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

    const x0 = posBytes.readFloatLE(i0 * 12), y0 = posBytes.readFloatLE(i0 * 12 + 4), z0 = posBytes.readFloatLE(i0 * 12 + 8);
    const x1 = posBytes.readFloatLE(i1 * 12), y1 = posBytes.readFloatLE(i1 * 12 + 4), z1 = posBytes.readFloatLE(i1 * 12 + 8);
    const x2 = posBytes.readFloatLE(i2 * 12), y2 = posBytes.readFloatLE(i2 * 12 + 4), z2 = posBytes.readFloatLE(i2 * 12 + 8);

    const cx = (x0 + x1 + x2) / 3.0;
    const cy = (y0 + y1 + y2) / 3.0;
    const cz = (z0 + z1 + z2) / 3.0;

    const dx = cx - targetCenter[0];
    const dz = cz - targetCenter[2];
    const dist2D = Math.sqrt(dx*dx + dz*dz);

    if (dist2D <= radius && cy >= yMin && cy <= yMax) {
      inCylTris++;
    }
  }
  console.log(`Mesh ${mIdx}: found ${inCylTris} triangles in tree cylinder.`);
  collectedTris += inCylTris;
}
console.log('Total triangles in tree cylinder:', collectedTris);
