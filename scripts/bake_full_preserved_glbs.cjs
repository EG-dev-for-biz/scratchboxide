const fs = require('fs');
const path = require('path');

/**
 * Multiplies a 3D vector [x, y, z] by a 4x4 matrix (column-major array of 16 numbers).
 */
function applyMatrix4(m, x, y, z) {
  const nx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const ny = m[1] * x + m[5] * y + m[9] * z + m[13];
  const nz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1.0;
  return [nx / w, ny / w, nz / w];
}

/**
 * Multiplies a 3D normal [x, y, z] by the rotational part of a 4x4 matrix and normalizes.
 */
function applyRotationNormal(m, x, y, z) {
  let nx = m[0] * x + m[4] * y + m[8] * z;
  let ny = m[1] * x + m[5] * y + m[9] * z;
  let nz = m[2] * x + m[6] * y + m[10] * z;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-8) {
    nx /= len;
    ny /= len;
    nz /= len;
  }
  return [nx, ny, nz];
}

/**
 * Multiplies two 4x4 matrices in column-major order: out = a * b.
 */
function multiplyMatrices(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/**
 * Converts node translation/rotation/scale or matrix into a single 4x4 matrix.
 */
function getNodeLocalMatrix(node) {
  if (node.matrix && node.matrix.length === 16) {
    return [...node.matrix];
  }
  const m = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ];
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1]; // [x, y, z, w]
  const s = node.scale || [1, 1, 1];

  const x = r[0], y = r[1], z = r[2], w = r[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const sx = s[0], sy = s[1], sz = s[2];

  m[0] = (1 - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[3] = 0;

  m[4] = (xy - wz) * sy;
  m[5] = (1 - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[7] = 0;

  m[8] = (xz + wy) * sz;
  m[9] = (yz - wx) * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[11] = 0;

  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;

  return m;
}

/**
 * Unpacks binary .glb into JSON and binary Buffer.
 */
function unpackGlb(glbBuffer) {
  const magic = glbBuffer.readUInt32LE(0);
  if (magic !== 0x46546C67) {
    throw new Error('Not a valid GLB binary file (magic mismatch)');
  }
  const version = glbBuffer.readUInt32LE(4);
  const totalLength = glbBuffer.readUInt32LE(8);
  const jsonChunkLen = glbBuffer.readUInt32LE(12);
  const jsonChunkType = glbBuffer.readUInt32LE(16);
  if (jsonChunkType !== 0x4E4F534A) {
    throw new Error('Invalid GLB structure: first chunk is not JSON');
  }
  const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonChunkLen);
  const gltf = JSON.parse(jsonStr);

  let binBuffer = Buffer.alloc(0);
  let offset = 20 + jsonChunkLen;
  if (offset < totalLength) {
    const binChunkLen = glbBuffer.readUInt32LE(offset);
    const binChunkType = glbBuffer.readUInt32LE(offset + 4);
    if (binChunkType === 0x004E4942) {
      binBuffer = Buffer.from(glbBuffer.subarray(offset + 8, offset + 8 + binChunkLen));
    }
  }

  return { gltf, binBuffer };
}

/**
 * Packs gltf object and binary Buffer back into a single binary .glb Buffer.
 */
function packGlb(gltf, binBuffer) {
  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');

  // Pad JSON to 4-byte boundary with spaces (0x20)
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  const jsonChunk = Buffer.alloc(jsonChunkLen, 0x20);
  jsonBuf.copy(jsonChunk, 0);

  // Pad BIN to 4-byte boundary with null bytes (0x00)
  const binPad = (4 - (binBuffer.length % 4)) % 4;
  const binChunkLen = binBuffer.length + binPad;
  const binChunk = Buffer.alloc(binChunkLen, 0x00);
  binBuffer.copy(binChunk, 0);

  const totalLength = 12 + (8 + jsonChunkLen) + (8 + binChunkLen);
  const out = Buffer.alloc(totalLength);

  // Header
  out.writeUInt32LE(0x46546C67, 0); // 'glTF'
  out.writeUInt32LE(2, 4);          // version
  out.writeUInt32LE(totalLength, 8);

  // JSON Chunk
  out.writeUInt32LE(jsonChunkLen, 12);
  out.writeUInt32LE(0x4E4F534A, 16); // 'JSON'
  jsonChunk.copy(out, 20);

  // BIN Chunk
  const binHeaderOffset = 20 + jsonChunkLen;
  out.writeUInt32LE(binChunkLen, binHeaderOffset);
  out.writeUInt32LE(0x004E4942, binHeaderOffset + 4); // 'BIN\0'
  binChunk.copy(out, binHeaderOffset + 8);

  return out;
}

/**
 * Recursively computes the world matrix for each node in a glTF scene graph.
 */
function computeNodeWorldMatrices(gltf) {
  const nodeCount = gltf.nodes ? gltf.nodes.length : 0;
  const worldMatrices = new Array(nodeCount);
  const visited = new Set();

  function traverse(nodeIdx, parentMat) {
    if (visited.has(nodeIdx)) return;
    visited.add(nodeIdx);
    const node = gltf.nodes[nodeIdx];
    const localMat = getNodeLocalMatrix(node);
    const worldMat = parentMat ? multiplyMatrices(parentMat, localMat) : localMat;
    worldMatrices[nodeIdx] = worldMat;

    if (node.children && node.children.length > 0) {
      for (const childIdx of node.children) {
        traverse(childIdx, worldMat);
      }
    }
  }

  const defaultSceneIdx = gltf.scene !== undefined ? gltf.scene : 0;
  if (gltf.scenes && gltf.scenes[defaultSceneIdx] && gltf.scenes[defaultSceneIdx].nodes) {
    for (const rootIdx of gltf.scenes[defaultSceneIdx].nodes) {
      traverse(rootIdx, null);
    }
  }

  for (let i = 0; i < nodeCount; i++) {
    if (!visited.has(i)) {
      traverse(i, null);
    }
  }

  return worldMatrices;
}

/**
 * Completely non-destructive baking:
 * - Computes true world bounds across ALL vertices
 * - Preserves 100% of triangles (NO subterranean culling)
 * - Preserves 100% of surrounding buildings, trees, and terrain (NO radial squashing)
 * - Grounds lowest elevation vertex to Y = 0.00m (or customFloor)
 * - Centers horizontally at (0, 0)
 */
function bakeFullPreservedGlb(srcGlbPath, outGlbPaths, customCenter = null, customFloorY = null) {
  console.log(`\n========================================================================`);
  console.log(`Baking full preserved model: ${srcGlbPath}`);
  console.log(`Targets: ${outGlbPaths.join(', ')}`);

  const rawBuffer = fs.readFileSync(srcGlbPath);
  const { gltf, binBuffer } = unpackGlb(rawBuffer);
  const worldMatrices = computeNodeWorldMatrices(gltf);

  // Pass 1: find full world-space bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let totalVertices = 0;
  let totalTriangles = 0;

  for (let nIdx = 0; nIdx < (gltf.nodes ? gltf.nodes.length : 0); nIdx++) {
    const node = gltf.nodes[nIdx];
    if (node.mesh === undefined || gltf.meshes[node.mesh] === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    const worldMat = worldMatrices[nIdx] || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

    for (const prim of mesh.primitives || []) {
      if (!prim.attributes || prim.attributes.POSITION === undefined) continue;
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const posView = gltf.bufferViews[posAcc.bufferView];
      const byteOffset = (posView.byteOffset || 0) + (posAcc.byteOffset || 0);
      const stride = posView.byteStride || 12;

      for (let i = 0; i < posAcc.count; i++) {
        const off = byteOffset + i * stride;
        const px = binBuffer.readFloatLE(off);
        const py = binBuffer.readFloatLE(off + 4);
        const pz = binBuffer.readFloatLE(off + 8);
        const [tx, ty, tz] = applyMatrix4(worldMat, px, py, pz);

        if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
        if (tz < minZ) minZ = tz; if (tz > maxZ) maxZ = tz;
        totalVertices++;
      }

      if (prim.indices !== undefined) {
        const indAcc = gltf.accessors[prim.indices];
        totalTriangles += indAcc.count / 3;
      } else {
        totalTriangles += posAcc.count / 3;
      }
    }
  }

  const floorY = customFloorY !== null ? customFloorY : minY;
  const centerX = customCenter && customCenter.x !== undefined ? customCenter.x : (minX + maxX) / 2;
  const centerZ = customCenter && customCenter.z !== undefined ? customCenter.z : (minZ + maxZ) / 2;

  console.log(`  Source Raw Bounds:`);
  console.log(`    X: [${minX.toFixed(2)}, ${maxX.toFixed(2)}] (span: ${(maxX - minX).toFixed(2)}m)`);
  console.log(`    Y: [${minY.toFixed(2)}, ${maxY.toFixed(2)}] (span: ${(maxY - minY).toFixed(2)}m)`);
  console.log(`    Z: [${minZ.toFixed(2)}, ${maxZ.toFixed(2)}] (span: ${(maxZ - minZ).toFixed(2)}m)`);
  console.log(`    Meshes: ${gltf.meshes.length}, Vertices: ${totalVertices}, Triangles: ${totalTriangles}`);
  console.log(`  Grounding & Centering Offsets:`);
  console.log(`    Shift X: ${(-centerX).toFixed(4)}m`);
  console.log(`    Shift Y: ${(-floorY).toFixed(4)}m (grounding lowest elevation to 0.00m)`);
  console.log(`    Shift Z: ${(-centerZ).toFixed(4)}m`);
  console.log(`  [Atomic Building Integrity]: Zero roof capping or horizontal planar slicing enforced ($Y_max = +inf$).`);

  // Pass 2: Transform all positions and normals directly into binary buffer
  for (let nIdx = 0; nIdx < (gltf.nodes ? gltf.nodes.length : 0); nIdx++) {
    const node = gltf.nodes[nIdx];
    if (node.mesh === undefined || gltf.meshes[node.mesh] === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    const worldMat = worldMatrices[nIdx] || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

    for (const prim of mesh.primitives || []) {
      if (!prim.attributes || prim.attributes.POSITION === undefined) continue;

      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const posView = gltf.bufferViews[posAcc.bufferView];
      const posByteOffset = (posView.byteOffset || 0) + (posAcc.byteOffset || 0);
      const posStride = posView.byteStride || 12;

      let pMin = [Infinity, Infinity, Infinity];
      let pMax = [-Infinity, -Infinity, -Infinity];

      for (let i = 0; i < posAcc.count; i++) {
        const off = posByteOffset + i * posStride;
        const px = binBuffer.readFloatLE(off);
        const py = binBuffer.readFloatLE(off + 4);
        const pz = binBuffer.readFloatLE(off + 8);
        const [tx, ty, tz] = applyMatrix4(worldMat, px, py, pz);

        const finalX = tx - centerX;
        const finalY = ty - floorY; // 100% authentic elevation preserved, lowest at 0.00m
        const finalZ = tz - centerZ;

        binBuffer.writeFloatLE(finalX, off);
        binBuffer.writeFloatLE(finalY, off + 4);
        binBuffer.writeFloatLE(finalZ, off + 8);

        if (finalX < pMin[0]) pMin[0] = finalX; if (finalX > pMax[0]) pMax[0] = finalX;
        if (finalY < pMin[1]) pMin[1] = finalY; if (finalY > pMax[1]) pMax[1] = finalY;
        if (finalZ < pMin[2]) pMin[2] = finalZ; if (finalZ > pMax[2]) pMax[2] = finalZ;
      }

      posAcc.min = pMin;
      posAcc.max = pMax;

      if (prim.attributes.NORMAL !== undefined) {
        const normAcc = gltf.accessors[prim.attributes.NORMAL];
        const normView = gltf.bufferViews[normAcc.bufferView];
        const normByteOffset = (normView.byteOffset || 0) + (normAcc.byteOffset || 0);
        const normStride = normView.byteStride || 12;

        let nMin = [Infinity, Infinity, Infinity];
        let nMax = [-Infinity, -Infinity, -Infinity];

        for (let i = 0; i < normAcc.count; i++) {
          const off = normByteOffset + i * normStride;
          const nx = binBuffer.readFloatLE(off);
          const ny = binBuffer.readFloatLE(off + 4);
          const nz = binBuffer.readFloatLE(off + 8);
          const [rx, ry, rz] = applyRotationNormal(worldMat, nx, ny, nz);

          binBuffer.writeFloatLE(rx, off);
          binBuffer.writeFloatLE(ry, off + 4);
          binBuffer.writeFloatLE(rz, off + 8);

          if (rx < nMin[0]) nMin[0] = rx; if (rx > nMax[0]) nMax[0] = rx;
          if (ry < nMin[1]) nMin[1] = ry; if (ry > nMax[1]) nMax[1] = ry;
          if (rz < nMin[2]) nMin[2] = rz; if (rz > nMax[2]) nMax[2] = rz;
        }

        normAcc.min = nMin;
        normAcc.max = nMax;
      }
    }
  }

  // Reset node matrices
  for (const node of gltf.nodes || []) {
    delete node.translation;
    delete node.rotation;
    delete node.scale;
    node.matrix = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
  }

  // Pack GLB
  const bakedGlb = packGlb(gltf, binBuffer);

  for (const outPath of outGlbPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, bakedGlb);
    console.log(`  Saved: ${outPath} (${(bakedGlb.length / (1024 * 1024)).toFixed(2)} MB)`);
  }

  console.log(`  Verification: Preserved 100% of triangles (${totalTriangles}), Y in [0.00m, ${(maxY - floorY).toFixed(2)}m]`);
}

function run() {
  const models = [
    {
      name: 'Rome Colosseum Full District',
      source: 'public/models/colosseum_rome_shape_grounded.glb',
      customCenter: { x: 0, z: 0 },
      customFloorY: -42.06,
      targets: [
        'public/models/colosseum_grounded.glb',
        'public/models/colosseum_clay.glb'
      ]
    },
    {
      name: 'Midtown Manhattan & Empire State Building',
      source: 'public/models/nyc_empire_state_building_pbr_enhanced.glb',
      customCenter: { x: -0.1148, z: -0.1921 },
      customFloorY: -33.16,
      targets: [
        'public/models/esb_grounded.glb',
        'public/models/esb_clay.glb'
      ]
    },
    {
      name: 'Grand Army Plaza & Central Park District',
      source: 'public/models/nyc_grand_army_plaza_raw.glb',
      customCenter: { x: 86.535, z: 75.63 },
      customFloorY: -936.87,
      targets: [
        'public/models/gap_grounded.glb',
        'public/models/gap_clay.glb'
      ]
    }
  ];

  for (const m of models) {
    bakeFullPreservedGlb(m.source, m.targets, m.customCenter, m.customFloorY);
  }
}

run();
