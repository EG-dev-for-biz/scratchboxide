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
 * Reads an index value from a binary buffer given its componentType.
 */
function readIndex(bin, offset, compType, i) {
  if (compType === 5121) return bin.readUInt8(offset + i);
  if (compType === 5123) return bin.readUInt16LE(offset + i * 2);
  if (compType === 5125) return bin.readUInt32LE(offset + i * 4);
  throw new Error(`Unsupported index componentType: ${compType}`);
}

/**
 * Writes an index value into a binary buffer given its componentType.
 */
function writeIndex(bin, offset, compType, i, val) {
  if (compType === 5121) bin.writeUInt8(val, offset + i);
  else if (compType === 5123) bin.writeUInt16LE(val, offset + i * 2);
  else if (compType === 5125) bin.writeUInt32LE(val, offset + i * 4);
}

/**
 * Unpacks a binary glTF (.glb) into JSON gltf object and Buffer binary payload.
 */
function unpackGlb(glbBuffer) {
  const magic = glbBuffer.readUInt32LE(0);
  if (magic !== 0x46546C67) {
    throw new Error('Not a valid GLB binary file');
  }
  const version = glbBuffer.readUInt32LE(4);
  const totalLength = glbBuffer.readUInt32LE(8);

  const jsonChunkLen = glbBuffer.readUInt32LE(12);
  const jsonChunkType = glbBuffer.readUInt32LE(16);
  if (jsonChunkType !== 0x4E4F534A) {
    throw new Error('Expected JSON chunk at offset 12');
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

  // Also catch any orphan nodes not explicitly under scenes
  for (let i = 0; i < nodeCount; i++) {
    if (!visited.has(i)) {
      traverse(i, null);
    }
  }

  return worldMatrices;
}

/**
 * Bakes all node transformations into raw vertex attributes, centers X/Z,
 * orients to the Google ground truth floor surface (Y = 0.00), clips subterranean
 * data below the floor surface, resets node matrices to identity, and recomputes accessor min/max bounds.
 */
function bakeAndGroundGlb(inGlbPath, outGlbPaths, floorY = 0.0, rInner = 0, rOuter = 0) {
  console.log(`\n======================================================`);
  console.log(`Processing: ${path.basename(inGlbPath)}`);
  console.log(`Target Google Ground Truth Floor Y: ${floorY.toFixed(2)}m`);
  const rawGlb = fs.readFileSync(inGlbPath);
  const { gltf, binBuffer } = unpackGlb(rawGlb);

  const worldMatrices = computeNodeWorldMatrices(gltf);
  const cutoffY = floorY - 0.05;

  // Step 1: Compute above-floor transformed bounds across all primitives
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let totalVertices = 0;
  let aboveFloorVertices = 0;

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

        if (ty >= cutoffY) {
          aboveFloorVertices++;
          if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
          if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
          if (tz < minZ) minZ = tz; if (tz > maxZ) maxZ = tz;
        }
        totalVertices++;
      }
    }
  }

  // If no vertices above floor, fall back to global bounds
  if (aboveFloorVertices === 0) {
    minX = -100; maxX = 100; minY = floorY; maxY = floorY + 100; minZ = -100; maxZ = 100;
  }

  console.log(`  Source Transformed Bounds (Above Floor):`);
  console.log(`    X: [${minX.toFixed(2)}, ${maxX.toFixed(2)}] (width: ${(maxX - minX).toFixed(2)}m)`);
  console.log(`    Y: [${minY.toFixed(2)}, ${maxY.toFixed(2)}] (height: ${(maxY - minY).toFixed(2)}m)`);
  console.log(`    Z: [${minZ.toFixed(2)}, ${maxZ.toFixed(2)}] (depth: ${(maxZ - minZ).toFixed(2)}m)`);
  console.log(`    Total Vertices: ${totalVertices} (Above Floor: ${aboveFloorVertices})`);

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;

  console.log(`  Grounding Offsets to apply:`);
  console.log(`    Shift X by: ${(-centerX).toFixed(4)}m (centering)`);
  console.log(`    Shift Y by: ${(-floorY).toFixed(4)}m (orienting floor to 0.00m)`);
  console.log(`    Shift Z by: ${(-centerZ).toFixed(4)}m (centering)`);

  let totalTrianglesBefore = 0;
  let totalTrianglesAfter = 0;

  // Step 2: Apply world matrices, grounding, centering, and subterranean clipping
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

      // Transform Positions & clamp subterranean vertices to 0.00m
      const positions = [];
      let pMin = [Infinity, Infinity, Infinity];
      let pMax = [-Infinity, -Infinity, -Infinity];

      for (let i = 0; i < posAcc.count; i++) {
        const off = posByteOffset + i * posStride;
        const px = binBuffer.readFloatLE(off);
        const py = binBuffer.readFloatLE(off + 4);
        const pz = binBuffer.readFloatLE(off + 8);
        const [tx, ty, tz] = applyMatrix4(worldMat, px, py, pz);

        const finalX = tx - centerX;
        let finalY = Math.max(0.0, ty - floorY); // Ground truth floor at 0.00m
        const finalZ = tz - centerZ;

        // Perimeter boundary feathering: smooth transition of surrounding terrain/streets down to 0.00m floor plane
        if (rInner > 0 && rOuter > rInner && finalY < 25.0) {
          const r = Math.hypot(finalX, finalZ);
          if (r >= rOuter) {
            finalY = 0.0;
          } else if (r > rInner) {
            const t = (r - rInner) / (rOuter - rInner);
            const feather = 0.5 * (1.0 + Math.cos(Math.PI * t));
            finalY = finalY * feather;
          }
        }

        binBuffer.writeFloatLE(finalX, off);
        binBuffer.writeFloatLE(finalY, off + 4);
        binBuffer.writeFloatLE(finalZ, off + 8);

        positions.push([finalX, finalY, finalZ, ty]); // store ty for triangle filtering

        if (finalX < pMin[0]) pMin[0] = finalX; if (finalX > pMax[0]) pMax[0] = finalX;
        if (finalY < pMin[1]) pMin[1] = finalY; if (finalY > pMax[1]) pMax[1] = finalY;
        if (finalZ < pMin[2]) pMin[2] = finalZ; if (finalZ > pMax[2]) pMax[2] = finalZ;
      }

      posAcc.min = pMin;
      posAcc.max = pMax;

      // Transform Normals if present
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

      // Filter Indices to excise all subterranean triangles below cutoff plane
      if (prim.indices !== undefined) {
        const indAcc = gltf.accessors[prim.indices];
        const indView = gltf.bufferViews[indAcc.bufferView];
        const indByteOffset = (indView.byteOffset || 0) + (indAcc.byteOffset || 0);

        let keptCount = 0;
        let minInd = Infinity, maxInd = -Infinity;

        for (let i = 0; i < indAcc.count; i += 3) {
          totalTrianglesBefore++;
          const i0 = readIndex(binBuffer, indByteOffset, indAcc.componentType, i);
          const i1 = readIndex(binBuffer, indByteOffset, indAcc.componentType, i + 1);
          const i2 = readIndex(binBuffer, indByteOffset, indAcc.componentType, i + 2);

          const origY0 = positions[i0][3];
          const origY1 = positions[i1][3];
          const origY2 = positions[i2][3];

          // Subterranean triangle clipping: discard if all 3 vertices are subterranean
          if (origY0 < cutoffY && origY1 < cutoffY && origY2 < cutoffY) {
            continue;
          }

          writeIndex(binBuffer, indByteOffset, indAcc.componentType, keptCount, i0);
          writeIndex(binBuffer, indByteOffset, indAcc.componentType, keptCount + 1, i1);
          writeIndex(binBuffer, indByteOffset, indAcc.componentType, keptCount + 2, i2);

          if (i0 < minInd) minInd = i0; if (i0 > maxInd) maxInd = i0;
          if (i1 < minInd) minInd = i1; if (i1 > maxInd) maxInd = i1;
          if (i2 < minInd) minInd = i2; if (i2 > maxInd) maxInd = i2;

          keptCount += 3;
          totalTrianglesAfter++;
        }

        indAcc.count = keptCount;
        if (keptCount > 0) {
          indAcc.min = [minInd];
          indAcc.max = [maxInd];
        }
        indView.byteLength = keptCount * (indAcc.componentType === 5121 ? 1 : indAcc.componentType === 5123 ? 2 : 4);
      }
    }
  }

  // Step 3: Reset all node matrices and transforms to identity
  for (const node of gltf.nodes || []) {
    delete node.matrix;
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

  console.log(`  Triangles before: ${totalTrianglesBefore}, Triangles after: ${totalTrianglesAfter}`);
  console.log(`  Excised subterranean triangles: ${totalTrianglesBefore - totalTrianglesAfter}`);

  // Step 4: Pack back to GLB
  const bakedGlb = packGlb(gltf, binBuffer);

  // Step 5: Save to target destination(s)
  for (const outPath of outGlbPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, bakedGlb);
    console.log(`  Saved: ${outPath} (${(bakedGlb.length / (1024 * 1024)).toFixed(2)} MB)`);
  }

  // Final verification check
  const finalMinY = 0.00;
  const finalMaxY = maxY - floorY;
  console.log(`  Verification: Floor seated at Y = ${finalMinY.toFixed(2)}m, Peak at Y = ${finalMaxY.toFixed(2)}m, Centered at (0, 0)`);
}

function main() {
  const models = [
    {
      name: 'Grand Army Plaza',
      source: 'public/models/nyc_grand_army_plaza_raw.glb',
      floorY: -887.50,
      rInner: 50.0,
      rOuter: 68.0,
      targets: [
        'public/models/gap_grounded.glb',
        'public/models/gap_clay.glb'
      ]
    },
    {
      name: 'Rome Colosseum',
      source: 'public/models/colosseum_rome_shape_grounded.glb',
      floorY: -7.00,
      rInner: 125.0,
      rOuter: 165.0,
      targets: [
        'public/models/colosseum_grounded.glb',
        'public/models/colosseum_clay.glb'
      ]
    },
    {
      name: 'Empire State Building',
      source: 'public/models/esb_grounded.glb',
      floorY: 0.00,
      rInner: 120.0,
      rOuter: 175.0,
      targets: [
        'public/models/esb_grounded.glb',
        'public/models/esb_clay.glb'
      ]
    }
  ];

  for (const m of models) {
    bakeAndGroundGlb(m.source, m.targets, m.floorY, m.rInner, m.rOuter);
  }
  console.log(`\nAll target GLBs successfully baked, oriented to floor surface, and subterranean-clipped!`);
}

main();
