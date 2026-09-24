const fs = require('fs');
const glbBuf = fs.readFileSync('public/models/botanical_tests/real_tile_extracted_tree_blob.glb');
const jsonLen = glbBuf.readUInt32LE(12);
const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));
const binBuf = glbBuf.subarray(20 + jsonLen + 8);

const posAcc = gltf.accessors[0];
const colAcc = gltf.accessors[3];
const idxAcc = gltf.accessors[4];

const verts = [];
for (let i = 0; i < posAcc.count; i++) {
  verts.push({
    x: binBuf.readFloatLE(i * 12),
    y: binBuf.readFloatLE(i * 12 + 4),
    z: binBuf.readFloatLE(i * 12 + 8),
    r: binBuf.readFloatLE(posAcc.count * (12 + 12 + 8) + i * 16),
    g: binBuf.readFloatLE(posAcc.count * (12 + 12 + 8) + i * 16 + 4),
    b: binBuf.readFloatLE(posAcc.count * (12 + 12 + 8) + i * 16 + 8)
  });
}

const triCount = idxAcc.count / 3;
const tris = [];
const adj = new Map();

for (let t = 0; t < triCount; t++) {
  const i0 = binBuf.readUInt16LE(posAcc.count * 48 + t * 6);
  const i1 = binBuf.readUInt16LE(posAcc.count * 48 + t * 6 + 2);
  const i2 = binBuf.readUInt16LE(posAcc.count * 48 + t * 6 + 4);
  tris.push([i0, i1, i2]);
  for (const v of [i0, i1, i2]) {
    if (!adj.has(v)) adj.set(v, []);
    adj.get(v).push(t);
  }
}

const visited = new Set();
const components = [];
for (let t = 0; t < triCount; t++) {
  if (visited.has(t)) continue;
  const comp = [];
  const q = [t];
  visited.add(t);
  while (q.length > 0) {
    const cur = q.pop();
    comp.push(cur);
    for (const v of tris[cur]) {
      for (const n of adj.get(v) || []) {
        if (!visited.has(n)) {
          visited.add(n);
          q.push(n);
        }
      }
    }
  }
  // calculate component bounds and veg count
  const compVerts = new Set();
  let vegCount = 0;
  let minY = Infinity, maxY = -Infinity;
  comp.forEach(tIdx => {
    for (const v of tris[tIdx]) {
      if (!compVerts.has(v)) {
        compVerts.add(v);
        const pt = verts[v];
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
        const sum = pt.r + pt.g + pt.b + 0.001;
        const exg = (2 * pt.g - pt.r - pt.b) / sum;
        if (exg > 0.08 && pt.g > pt.r * 1.05) vegCount++;
      }
    }
  });
  components.push({
    triCount: comp.length,
    vertCount: compVerts.size,
    vegCount,
    yRange: [minY.toFixed(2), maxY.toFixed(2)],
    height: (maxY - minY).toFixed(2)
  });
}

components.sort((a, b) => b.triCount - a.triCount);
console.log('Connected mesh components in extracted blob:', components.length);
components.slice(0, 10).forEach((c, idx) => {
  console.log(`Comp ${idx}: ${c.triCount} tris, ${c.vertCount} verts, ${c.vegCount} veg verts, Y=[${c.yRange.join(', ')}]m, Height=${c.height}m`);
});
