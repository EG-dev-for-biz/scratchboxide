const fs = require('fs');

const candidates = [
  { name: 'Candidate 0 (Oak)', center: [-33.17, 63.29, -125.77], radius: 6.5, yMin: 55.0, yMax: 72.0 },
  { name: 'Candidate 1 (Elm)', center: [-89.16, 65.71, -149.45], radius: 5.5, yMin: 59.0, yMax: 72.0 },
  { name: 'Candidate 2 (Grove Tree)', center: [-130.33, 73.87, -179.75], radius: 7.0, yMin: 65.0, yMax: 82.0 }
];

const glbBuf = fs.readFileSync('public/models/gap_grounded.glb');
const jsonLen = glbBuf.readUInt32LE(12);
const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));
const binOffset = 20 + jsonLen + 8;
const binBuf = glbBuf.subarray(binOffset);

for (const cand of candidates) {
  let trisCount = 0;
  for (const mIdx of [73, 74, 75]) {
    const mesh = gltf.meshes[mIdx];
    const prim = mesh.primitives[0];
    const posAcc = gltf.accessors[prim.attributes.POSITION];
    const posBv = gltf.bufferViews[posAcc.bufferView];
    const posBytes = binBuf.subarray((posBv.byteOffset || 0) + (posAcc.byteOffset || 0));

    const idxAcc = gltf.accessors[prim.indices];
    const idxBv = gltf.bufferViews[idxAcc.bufferView];
    const idxBytes = binBuf.subarray((idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0));

    const triCount = idxAcc.count / 3;
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

      const cx = (x0 + x1 + x2) / 3.0, cy = (y0 + y1 + y2) / 3.0, cz = (z0 + z1 + z2) / 3.0;
      const dx = cx - cand.center[0], dz = cz - cand.center[2];
      if (Math.sqrt(dx*dx + dz*dz) <= cand.radius && cy >= cand.yMin && cy <= cand.yMax) {
        trisCount++;
      }
    }
  }
  console.log(`${cand.name}: ${trisCount} triangles`);
}
