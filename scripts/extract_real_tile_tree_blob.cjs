const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function decodeJpg(buf) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: buf });
  return p.stdout;
}

function extractRealTreeBlob(options = {}) {
  const inputGlbPath = options.inputGlb || 'public/models/gap_grounded.glb';
  const outGlbPath = options.outputGlb || 'public/models/botanical_tests/real_tile_extracted_tree_blob.glb';
  
  // Default: Candidate 1 (Central Park Elm / Maple)
  const targetCenter = options.center || [-89.16, 65.71, -149.45];
  const radius = options.radius || 5.8;
  const yMin = options.yMin !== undefined ? options.yMin : 60.5;
  const yMax = options.yMax !== undefined ? options.yMax : 71.5;

  console.log(`[BlobExtractor] Loading 3D tile: ${inputGlbPath}`);
  const glbBuf = fs.readFileSync(inputGlbPath);
  const jsonLen = glbBuf.readUInt32LE(12);
  const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));
  const binOffset = 20 + jsonLen + 8;
  const binBuf = glbBuf.subarray(binOffset);

  console.log(`[BlobExtractor] Searching tree cylinder at [${targetCenter.join(', ')}], R=${radius}m, Y=[${yMin}, ${yMax}]m`);

  // First pass: identify intersecting meshes and their triangles
  const candidateMeshes = [];
  for (let mIdx = 0; mIdx < gltf.meshes.length; mIdx++) {
    const mesh = gltf.meshes[mIdx];
    const prim = mesh.primitives[0];
    const posAcc = gltf.accessors[prim.attributes.POSITION];
    if (!posAcc || !posAcc.min || !posAcc.max) continue;
    if (posAcc.max[0] < targetCenter[0] - radius || posAcc.min[0] > targetCenter[0] + radius) continue;
    if (posAcc.max[2] < targetCenter[2] - radius || posAcc.min[2] > targetCenter[2] + radius) continue;
    if (posAcc.max[1] < yMin || posAcc.min[1] > yMax) continue;

    candidateMeshes.push(mIdx);
  }

  console.log(`[BlobExtractor] Found ${candidateMeshes.length} candidate intersecting meshes: ${candidateMeshes.join(', ')}`);

  // Check texture images for intersecting meshes
  const meshTextures = new Map(); // mIdx -> { imgBuf, imgW, imgH, rgba }
  for (const mIdx of candidateMeshes) {
    const mesh = gltf.meshes[mIdx];
    const prim = mesh.primitives[0];
    const mat = prim.material !== undefined ? gltf.materials[prim.material] : null;
    const texIdx = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (texIdx !== undefined && gltf.textures && gltf.textures[texIdx]) {
      const imgIdx = gltf.textures[texIdx].source;
      const img = gltf.images[imgIdx];
      const bv = gltf.bufferViews[img.bufferView];
      const imgBuf = binBuf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);

      let imgW = 0, imgH = 0;
      for (let i = 2; i < imgBuf.length - 8; i++) {
        if (imgBuf[i] === 0xFF && (imgBuf[i+1] === 0xC0 || imgBuf[i+1] === 0xC2)) {
          imgH = imgBuf.readUInt16BE(i + 5);
          imgW = imgBuf.readUInt16BE(i + 7);
          break;
        }
      }
      let rgba = null;
      if (imgW > 0 && imgH > 0) {
        rgba = decodeJpg(imgBuf);
      }
      meshTextures.set(mIdx, { imgBuf, imgW, imgH, rgba });
    }
  }

  // Create atlas if multiple textures, or single image if one
  let atlasBuffer = null;
  const uvTransforms = new Map(); // mIdx -> { uScale, uOffset, vScale, vOffset }

  const uniqueTexMeshes = candidateMeshes.filter(m => meshTextures.has(m));
  if (uniqueTexMeshes.length === 1) {
    const t = meshTextures.get(uniqueTexMeshes[0]);
    atlasBuffer = t.imgBuf;
    uvTransforms.set(uniqueTexMeshes[0], { uScale: 1.0, uOffset: 0.0, vScale: 1.0, vOffset: 0.0 });
  } else if (uniqueTexMeshes.length >= 2) {
    // Create horizontal atlas using ffmpeg
    const m0 = uniqueTexMeshes[0], m1 = uniqueTexMeshes[1];
    const t0 = meshTextures.get(m0), t1 = meshTextures.get(m1);
    const tmp1 = path.join(path.dirname(outGlbPath), 'tmp_tile_tex0.jpg');
    const tmp2 = path.join(path.dirname(outGlbPath), 'tmp_tile_tex1.jpg');
    const atlasPath = path.join(path.dirname(outGlbPath), 'tree_tile_atlas.jpg');
    fs.mkdirSync(path.dirname(outGlbPath), { recursive: true });
    fs.writeFileSync(tmp1, t0.imgBuf);
    fs.writeFileSync(tmp2, t1.imgBuf);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp1, '-i', tmp2, '-filter_complex', 'hstack', '-q:v', '2', atlasPath]);
    atlasBuffer = fs.readFileSync(atlasPath);
    try { fs.unlinkSync(tmp1); fs.unlinkSync(tmp2); } catch (_) {}
    console.log(`[BlobExtractor] Created horizontal tile texture atlas: ${atlasPath} (${(atlasBuffer.length / 1024).toFixed(1)} KB)`);

    uvTransforms.set(m0, { uScale: 0.5, uOffset: 0.0, vScale: 1.0, vOffset: 0.0 });
    uvTransforms.set(m1, { uScale: 0.5, uOffset: 0.5, vScale: 1.0, vOffset: 0.0 });
  }

  const extractedVerts = [];
  const extractedIndices = [];
  let vegVertCount = 0;

  for (const mIdx of candidateMeshes) {
    const mesh = gltf.meshes[mIdx];
    const prim = mesh.primitives[0];
    const posAcc = gltf.accessors[prim.attributes.POSITION];
    const posBv = gltf.bufferViews[posAcc.bufferView];
    const posBytes = binBuf.subarray((posBv.byteOffset || 0) + (posAcc.byteOffset || 0));

    const normAcc = typeof prim.attributes.NORMAL === 'number' ? gltf.accessors[prim.attributes.NORMAL] : null;
    const normBv = normAcc ? gltf.bufferViews[normAcc.bufferView] : null;
    const normBytes = normBv ? binBuf.subarray((normBv.byteOffset || 0) + (normAcc.byteOffset || 0)) : null;

    const uvAcc = typeof prim.attributes.TEXCOORD_0 === 'number' ? gltf.accessors[prim.attributes.TEXCOORD_0] : null;
    const uvBv = uvAcc ? gltf.bufferViews[uvAcc.bufferView] : null;
    const uvBytes = uvBv ? binBuf.subarray((uvBv.byteOffset || 0) + (uvAcc.byteOffset || 0)) : null;

    const idxAcc = gltf.accessors[prim.indices];
    const idxBv = gltf.bufferViews[idxAcc.bufferView];
    const idxBytes = binBuf.subarray((idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0));

    const triCount = idxAcc.count / 3;
    const localVertMap = new Map();
    const texInfo = meshTextures.get(mIdx);
    const uvt = uvTransforms.get(mIdx) || { uScale: 1.0, uOffset: 0.0, vScale: 1.0, vOffset: 0.0 };

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

      const p0 = [posBytes.readFloatLE(i0 * 12), posBytes.readFloatLE(i0 * 12 + 4), posBytes.readFloatLE(i0 * 12 + 8)];
      const p1 = [posBytes.readFloatLE(i1 * 12), posBytes.readFloatLE(i1 * 12 + 4), posBytes.readFloatLE(i1 * 12 + 8)];
      const p2 = [posBytes.readFloatLE(i2 * 12), posBytes.readFloatLE(i2 * 12 + 4), posBytes.readFloatLE(i2 * 12 + 8)];

      const cx = (p0[0] + p1[0] + p2[0]) / 3.0;
      const cy = (p0[1] + p1[1] + p2[1]) / 3.0;
      const cz = (p0[2] + p1[2] + p2[2]) / 3.0;

      const dx = cx - targetCenter[0];
      const dz = cz - targetCenter[2];
      const dist2D = Math.sqrt(dx * dx + dz * dz);

      if (dist2D <= radius && cy >= yMin && cy <= yMax) {
        const triIdxs = [i0, i1, i2].map(vIdx => {
          if (localVertMap.has(vIdx)) {
            return localVertMap.get(vIdx);
          }

          const px = posBytes.readFloatLE(vIdx * 12);
          const py = posBytes.readFloatLE(vIdx * 12 + 4);
          const pz = posBytes.readFloatLE(vIdx * 12 + 8);

          let nx = 0, ny = 1, nz = 0;
          if (normBytes) {
            nx = normBytes.readFloatLE(vIdx * 12);
            ny = normBytes.readFloatLE(vIdx * 12 + 4);
            nz = normBytes.readFloatLE(vIdx * 12 + 8);
          }

          let origU = 0, origV = 0;
          if (uvBytes) {
            origU = uvBytes.readFloatLE(vIdx * 8);
            origV = uvBytes.readFloatLE(vIdx * 8 + 4);
          }

          let r = 0.5, g = 0.5, b = 0.5, a = 1.0;
          if (texInfo && texInfo.rgba && texInfo.imgW > 0 && texInfo.imgH > 0) {
            const tx = Math.min(texInfo.imgW - 1, Math.max(0, Math.floor(((origU % 1 + 1) % 1) * texInfo.imgW)));
            const ty = Math.min(texInfo.imgH - 1, Math.max(0, Math.floor(((origV % 1 + 1) % 1) * texInfo.imgH)));
            const pIdx = (ty * texInfo.imgW + tx) * 4;
            r = texInfo.rgba[pIdx] / 255.0;
            g = texInfo.rgba[pIdx + 1] / 255.0;
            b = texInfo.rgba[pIdx + 2] / 255.0;

            const sum = r + g + b + 0.001;
            const exg = (2.0 * g - r - b) / sum;
            if (exg > 0.08 && g > r * 1.05 && g > b) {
              vegVertCount++;
            }
          }

          // Remap UV into atlas coordinates
          const finalU = origU * uvt.uScale + uvt.uOffset;
          const finalV = origV * uvt.vScale + uvt.vOffset;

          const newIdx = extractedVerts.length;
          extractedVerts.push({
            pos: [px, py, pz],
            normal: [nx, ny, nz],
            uv: [finalU, finalV],
            color: [r, g, b, a]
          });
          localVertMap.set(vIdx, newIdx);
          return newIdx;
        });

        extractedIndices.push(triIdxs[0], triIdxs[1], triIdxs[2]);
      }
    }
  }

  console.log(`[BlobExtractor] Extracted ${extractedVerts.length} vertices and ${extractedIndices.length / 3} triangles (${vegVertCount} vegetative).`);

  if (extractedVerts.length === 0) {
    throw new Error('No vertices extracted within target cylinder.');
  }

  // Find bounds and ground level
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of extractedVerts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v.pos[k]);
      max[k] = Math.max(max[k], v.pos[k]);
    }
  }

  const spreadX = max[0] - min[0];
  const totalHeight = max[1] - min[1];
  const spreadZ = max[2] - min[2];
  const rootBaseX = (min[0] + max[0]) * 0.5;
  const rootBaseY = min[1];
  const rootBaseZ = (min[2] + max[2]) * 0.5;

  console.log(`[BlobExtractor] Raw Scan Dimensions: Height = ${totalHeight.toFixed(2)}m, Spread = ${spreadX.toFixed(2)}m x ${spreadZ.toFixed(2)}m`);
  console.log(`[BlobExtractor] Ground Level: Y=${rootBaseY.toFixed(2)}m, Centering root base to (0, 0, 0)...`);

  // Center tree so ground base is at (0, 0, 0)
  for (const v of extractedVerts) {
    v.pos[0] -= rootBaseX;
    v.pos[1] -= rootBaseY;
    v.pos[2] -= rootBaseZ;
  }

  // Pack into standard binary glTF 2.0 (.glb) with embedded authentic tile texture
  const glbOutputBuffer = packMeshToGlb(extractedVerts, extractedIndices, atlasBuffer);
  fs.mkdirSync(path.dirname(outGlbPath), { recursive: true });
  fs.writeFileSync(outGlbPath, glbOutputBuffer);
  console.log(`[BlobExtractor] Successfully saved extracted real tree blob to: ${outGlbPath} (${(glbOutputBuffer.length / 1024).toFixed(1)} KB)`);

  return {
    outGlbPath,
    vertexCount: extractedVerts.length,
    triangleCount: extractedIndices.length / 3,
    height: totalHeight,
    spreadX,
    spreadZ,
    vegVertCount
  };
}

function packMeshToGlb(verts, indices, atlasJpgBuffer = null) {
  // Construct binary buffers for POSITION, NORMAL, TEXCOORD_0, COLOR_0, and INDICES
  const numVerts = verts.length;
  const numIndices = indices.length;

  const posBuf = Buffer.alloc(numVerts * 12);
  const normBuf = Buffer.alloc(numVerts * 12);
  const uvBuf = Buffer.alloc(numVerts * 8);
  const colBuf = Buffer.alloc(numVerts * 16);

  let minPos = [Infinity, Infinity, Infinity], maxPos = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < numVerts; i++) {
    const v = verts[i];
    posBuf.writeFloatLE(v.pos[0], i * 12);
    posBuf.writeFloatLE(v.pos[1], i * 12 + 4);
    posBuf.writeFloatLE(v.pos[2], i * 12 + 8);

    normBuf.writeFloatLE(v.normal[0], i * 12);
    normBuf.writeFloatLE(v.normal[1], i * 12 + 4);
    normBuf.writeFloatLE(v.normal[2], i * 12 + 8);

    uvBuf.writeFloatLE(v.uv[0], i * 8);
    uvBuf.writeFloatLE(v.uv[1], i * 8 + 4);

    colBuf.writeFloatLE(v.color[0], i * 16);
    colBuf.writeFloatLE(v.color[1], i * 16 + 4);
    colBuf.writeFloatLE(v.color[2], i * 16 + 8);
    colBuf.writeFloatLE(v.color[3], i * 16 + 12);

    for (let k = 0; k < 3; k++) {
      minPos[k] = Math.min(minPos[k], v.pos[k]);
      maxPos[k] = Math.max(maxPos[k], v.pos[k]);
    }
  }

  // Use UNSIGNED_SHORT or UNSIGNED_INT
  const useUint32 = numVerts > 65535;
  const idxBuf = Buffer.alloc(numIndices * (useUint32 ? 4 : 2));
  for (let i = 0; i < numIndices; i++) {
    if (useUint32) {
      idxBuf.writeUInt32LE(indices[i], i * 4);
    } else {
      idxBuf.writeUInt16LE(indices[i], i * 2);
    }
  }

  // 4-byte padding helper
  function pad4(buf) {
    const rem = buf.length % 4;
    if (rem === 0) return buf;
    const pad = Buffer.alloc(4 - rem, 0);
    return Buffer.concat([buf, pad]);
  }

  const paddedPos = pad4(posBuf);
  const paddedNorm = pad4(normBuf);
  const paddedUv = pad4(uvBuf);
  const paddedCol = pad4(colBuf);
  const paddedIdx = pad4(idxBuf);

  const chunks = [paddedPos, paddedNorm, paddedUv, paddedCol, paddedIdx];

  let offset = 0;
  const bvPosOffset = offset; offset += paddedPos.length;
  const bvNormOffset = offset; offset += paddedNorm.length;
  const bvUvOffset = offset; offset += paddedUv.length;
  const bvColOffset = offset; offset += paddedCol.length;
  const bvIdxOffset = offset; offset += paddedIdx.length;

  let bvImgOffset = 0;
  let paddedImg = null;
  const hasTexture = atlasJpgBuffer && atlasJpgBuffer.length > 0;
  if (hasTexture) {
    paddedImg = pad4(atlasJpgBuffer);
    bvImgOffset = offset;
    offset += paddedImg.length;
    chunks.push(paddedImg);
  }

  const binBuffer = Buffer.concat(chunks);

  const gltf = {
    asset: { version: "2.0", generator: "Scratchbox Real 3D Tile Tree Extractor" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "RealTile_ExtractedTreeBlob" }],
    materials: [{
      name: "material_real_tile_photogrammetry",
      pbrMetallicRoughness: {
        baseColorFactor: [1.0, 1.0, 1.0, 1.0],
        roughnessFactor: 0.95,
        metallicFactor: 0.0
      },
      doubleSided: true
    }],
    meshes: [{
      name: "RealTileTree_Submesh",
      primitives: [{
        attributes: {
          POSITION: 0,
          NORMAL: 1,
          TEXCOORD_0: 2,
          COLOR_0: 3
        },
        indices: 4,
        material: 0
      }]
    }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: numVerts, type: "VEC3", min: minPos, max: maxPos },
      { bufferView: 1, byteOffset: 0, componentType: 5126, count: numVerts, type: "VEC3" },
      { bufferView: 2, byteOffset: 0, componentType: 5126, count: numVerts, type: "VEC2" },
      { bufferView: 3, byteOffset: 0, componentType: 5126, count: numVerts, type: "VEC4" },
      { bufferView: 4, byteOffset: 0, componentType: useUint32 ? 5125 : 5123, count: numIndices, type: "SCALAR" }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: bvPosOffset, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: bvNormOffset, byteLength: normBuf.length, target: 34962 },
      { buffer: 0, byteOffset: bvUvOffset, byteLength: uvBuf.length, target: 34962 },
      { buffer: 0, byteOffset: bvColOffset, byteLength: colBuf.length, target: 34962 },
      { buffer: 0, byteOffset: bvIdxOffset, byteLength: idxBuf.length, target: 34963 }
    ],
    buffers: [{ byteLength: binBuffer.length }]
  };

  if (hasTexture) {
    gltf.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0, texCoord: 0 };
    gltf.textures = [{ sampler: 0, source: 0 }];
    gltf.images = [{ bufferView: 5, mimeType: "image/jpeg" }];
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    gltf.bufferViews.push({
      buffer: 0,
      byteOffset: bvImgOffset,
      byteLength: atlasJpgBuffer.length
    });
  }

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const paddedJsonBuf = pad4(jsonBuf);

  // Pad JSON with spaces (0x20) per glTF spec
  const jsonDiff = paddedJsonBuf.length - jsonBuf.length;
  if (jsonDiff > 0) {
    for (let i = jsonBuf.length; i < paddedJsonBuf.length; i++) {
      paddedJsonBuf[i] = 0x20;
    }
  }

  const totalLength = 12 + 8 + paddedJsonBuf.length + 8 + binBuffer.length;
  const glbHeader = Buffer.alloc(12);
  glbHeader.writeUInt32LE(0x46546C67, 0); // "glTF"
  glbHeader.writeUInt32LE(2, 4);          // version 2
  glbHeader.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(paddedJsonBuf.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // "JSON"

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binBuffer.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4);  // "BIN\0"

  return Buffer.concat([glbHeader, jsonChunkHeader, paddedJsonBuf, binChunkHeader, binBuffer]);
}

if (require.main === module) {
  extractRealTreeBlob();
}

module.exports = { extractRealTreeBlob };
