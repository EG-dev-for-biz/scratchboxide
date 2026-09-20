const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function decodeRgbaFromStream(inBuf) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg decode failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(inBuf);
    proc.stdin.end();
  });
}

async function scaleAndSharpen(inBuf, targetW, targetH) {
  return new Promise((resolve, reject) => {
    const vf = `scale=${targetW}:${targetH}:flags=lanczos,unsharp=5:5:2.2:5:5:0.0`;
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg filter failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(inBuf);
    proc.stdin.end();
  });
}

async function encodeJpeg(rgbaBuf, w, h, qv = 3) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${w}x${h}`,
      '-i', 'pipe:0',
      '-q:v', `${qv}`,
      '-f', 'mjpeg',
      'pipe:1'
    ]);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg encode failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(rgbaBuf);
    proc.stdin.end();
  });
}

(async () => {
  const startTime = Date.now();
  console.log('=== MULTI-MESH SHAPE-GROUNDED 3D TEXTURE SYNTHESIZER ===');

  const glbPath = path.resolve('public/models/colosseum_rome_textured.glb');
  const glbBuffer = fs.readFileSync(glbPath);
  const jsonLen = glbBuffer.readUInt32LE(12);
  const gltf = JSON.parse(glbBuffer.toString('utf8', 20, 20 + jsonLen));

  const binOffset = 20 + jsonLen;
  const binChunkLen = glbBuffer.readUInt32LE(binOffset);
  const binBuffer = glbBuffer.subarray(binOffset + 8, binOffset + 8 + binChunkLen);

  function getAccessorData(accIndex) {
    const acc = gltf.accessors[accIndex];
    const bv = gltf.bufferViews[acc.bufferView];
    const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const count = acc.count;
    if (acc.componentType === 5126) {
      const numComponents = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
      return new Float32Array(binBuffer.buffer, binBuffer.byteOffset + offset, count * numComponents);
    } else if (acc.componentType === 5123) {
      return new Uint16Array(binBuffer.buffer, binBuffer.byteOffset + offset, count);
    } else if (acc.componentType === 5125) {
      return new Uint32Array(binBuffer.buffer, binBuffer.byteOffset + offset, count);
    }
  }

  // Decode AI Travertine Texture
  const aiTexPath = 'public/models/ai_travertine_detail.png';
  const aiW = 1024, aiH = 1024;
  console.log(`Loading AI Travertine texture from: ${aiTexPath}`);
  const aiRgba = await decodeRgbaFromStream(fs.readFileSync(aiTexPath));

  function sampleAiTexture(u, v) {
    let uu = u - Math.floor(u);
    let vv = v - Math.floor(v);
    const px = Math.min(aiW - 1, Math.max(0, Math.floor(uu * aiW)));
    const py = Math.min(aiH - 1, Math.max(0, Math.floor(vv * aiH)));
    const idx = (py * aiW + px) * 4;
    return [aiRgba[idx], aiRgba[idx + 1], aiRgba[idx + 2]];
  }

  // Complete Colosseum architectural wall meshes (74 meshes)
  // Covering every concentric arcade tier, column, inner arena wall, and grand standing facade (up to 61m high)
  const targetMeshIndices = [
    39, // Primary close-up arcade target (processed at 2048x2048 for 4x micro-detail loupe)
    0, 1, 2, 3, 4, 5, 6, 7, 8,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    30, 31, 32, 33, 35, 36,
    40, 41, 42, 43, 44, 45, 47, 48, 49,
    50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
    70, 71, 72, 73, 74, 75, 76, 77, 78
  ];

  console.log(`Targeting ${targetMeshIndices.length} architectural facade & arcade meshes across the Roman Colosseum...`);

  const worldMetersPerTile = 2.4;
  const invScale = 1.0 / worldMetersPerTile;

  // Map to store replaced bufferViews
  const replacedBvs = new Map();

  for (let mIdx = 0; mIdx < targetMeshIndices.length; mIdx++) {
    const meshIdx = targetMeshIndices[mIdx];
    const meshStartTime = Date.now();
    const mesh = gltf.meshes[meshIdx];
    const prim = mesh.primitives[0];

    const positions = getAccessorData(prim.attributes.POSITION);
    const uvs = getAccessorData(prim.attributes.TEXCOORD_0);
    const indices = getAccessorData(prim.indices);
    const numTris = indices.length / 3;

    // Texture image
    const matIdx = prim.material;
    const texIdx = gltf.materials[matIdx]?.pbrMetallicRoughness?.baseColorTexture?.index;
    const imgIdx = texIdx !== undefined ? gltf.textures[texIdx].source : meshIdx;
    const img = gltf.images[imgIdx];
    const origBv = gltf.bufferViews[img.bufferView];
    const origImgBuf = binBuffer.subarray(origBv.byteOffset, origBv.byteOffset + origBv.byteLength);

    // Mesh 39 uses 2048x2048 for maximum extreme close-up loupe fidelity; others use 1024x1024 for optimal speed & streaming
    const targetDim = meshIdx === 39 ? 2048 : 1024;
    const qv = meshIdx === 39 ? 2 : 3;

    // Scale and sharpen base photogrammetry
    const baseRgba = await scaleAndSharpen(origImgBuf, targetDim, targetDim);
    const outRgba = Buffer.from(baseRgba);

    const W = targetDim;
    const H = targetDim;
    let processedPixels = 0;

    for (let t = 0; t < numTris; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];

      const x0 = positions[i0 * 3], y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
      const x1 = positions[i1 * 3], y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];
      const x2 = positions[i2 * 3], y2 = positions[i2 * 3 + 1], z2 = positions[i2 * 3 + 2];

      const u0 = uvs[i0 * 2] * (W - 1), v0 = (1.0 - uvs[i0 * 2 + 1]) * (H - 1);
      const u1 = uvs[i1 * 2] * (W - 1), v1 = (1.0 - uvs[i1 * 2 + 1]) * (H - 1);
      const u2 = uvs[i2 * 2] * (W - 1), v2 = (1.0 - uvs[i2 * 2 + 1]) * (H - 1);

      // Face normal
      const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const nX = nx / len;
      const nY = ny / len;
      const nZ = nz / len;

      // Architectural Wall vs Horizontal Ground/Road discriminator:
      // Vertical facades and columns have |nY| < 0.45; flat roads/ground have |nY| > 0.70.
      // Only apply Roman travertine ashlar masonry to architectural vertical surfaces!
      const absNy = Math.abs(nY);
      const wallFactor = Math.max(0.0, Math.min(1.0, (0.65 - absNy) / 0.25));

      // If this triangle is flat ground/road/pavement, keep original photogrammetry road/lawn!
      if (wallFactor <= 0.001) continue;

      // Triplanar weights
      const pWX = Math.pow(Math.abs(nX), 4);
      const pWY = Math.pow(Math.abs(nY), 4);
      const pWZ = Math.pow(Math.abs(nZ), 4);
      const totalW = pWX + pWY + pWZ || 1;
      const wBlendX = pWX / totalW;
      const wBlendY = pWY / totalW;
      const wBlendZ = pWZ / totalW;

      const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
      if (Math.abs(det) < 1e-6) continue;
      const invDet = 1.0 / det;

      const minPx = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
      const maxPx = Math.min(W - 1, Math.ceil(Math.max(u0, u1, u2)));
      const minPy = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
      const maxPy = Math.min(H - 1, Math.ceil(Math.max(v0, v1, v2)));

      const aiInfluence = 0.55 * wallFactor;
      const origInfluence = 1.0 - aiInfluence;

      for (let py = minPy; py <= maxPy; py++) {
        for (let px = minPx; px <= maxPx; px++) {
          const w0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * invDet;
          if (w0 < -0.001 || w0 > 1.001) continue;
          const w1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * invDet;
          if (w1 < -0.001 || (w0 + w1) > 1.001) continue;
          const w2 = 1.0 - w0 - w1;
          if (w2 < -0.001) continue;

          // 3D world coordinate
          const wx = w0 * x0 + w1 * x1 + w2 * x2;
          const wy = w0 * y0 + w1 * y1 + w2 * y2;
          const wz = w0 * z0 + w1 * z1 + w2 * z2;

          const idx = (py * W + px) * 4;
          const rOrig = baseRgba[idx];
          const gOrig = baseRgba[idx + 1];
          const bOrig = baseRgba[idx + 2];

          // Sample triplanar projection
          const sampleX = sampleAiTexture(wz * invScale, wy * invScale);
          const sampleY = sampleAiTexture(wx * invScale, wz * invScale);
          const sampleZ = sampleAiTexture(wx * invScale, wy * invScale);

          const aiR = wBlendX * sampleX[0] + wBlendY * sampleY[0] + wBlendZ * sampleZ[0];
          const aiG = wBlendX * sampleX[1] + wBlendY * sampleY[1] + wBlendZ * sampleZ[1];
          const aiB = wBlendX * sampleX[2] + wBlendY * sampleY[2] + wBlendZ * sampleZ[2];

          let lightFactor = 1.0;
          if (nY < -0.10) {
            lightFactor -= Math.min(1.0, (-nY - 0.10) / 0.85) * 0.32;
          } else if (nY > 0.25) {
            lightFactor += Math.min(1.0, (nY - 0.25) / 0.70) * 0.16;
          }

          // Fuse AI travertine grain with base color tone
          const blendR = (rOrig * origInfluence + (rOrig * (aiR / 185.0)) * aiInfluence) * lightFactor;
          const blendG = (gOrig * origInfluence + (gOrig * (aiG / 185.0)) * aiInfluence) * lightFactor;
          const blendB = (bOrig * origInfluence + (bOrig * (aiB / 185.0)) * aiInfluence) * lightFactor;

          outRgba[idx] = Math.min(255, Math.max(0, Math.round(blendR)));
          outRgba[idx + 1] = Math.min(255, Math.max(0, Math.round(blendG)));
          outRgba[idx + 2] = Math.min(255, Math.max(0, Math.round(blendB)));

          processedPixels++;
        }
      }
    }

    const enhancedJpegBuf = await encodeJpeg(outRgba, W, H, qv);
    replacedBvs.set(img.bufferView, enhancedJpegBuf);
    img.mimeType = 'image/jpeg';

    const elapsedMs = Date.now() - meshStartTime;
    console.log(`[${mIdx + 1}/${targetMeshIndices.length}] Mesh ${meshIdx} (${numTris} tris, ${targetDim}²): ${processedPixels} px mapped in ${elapsedMs}ms -> ${(enhancedJpegBuf.length / 1024).toFixed(1)} KB JPEG`);
  }

  // Repack GLB with all updated bufferViews
  console.log('Repacking GLB with updated facade textures...');
  const processedBvs = [];
  for (let i = 0; i < gltf.bufferViews.length; i++) {
    if (replacedBvs.has(i)) {
      processedBvs.push(replacedBvs.get(i));
    } else {
      const bv = gltf.bufferViews[i];
      const slice = binBuffer.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      processedBvs.push(Buffer.from(slice));
    }
  }

  let currentOffset = 0;
  const alignedChunks = [];
  for (let i = 0; i < processedBvs.length; i++) {
    const chunk = processedBvs[i];
    gltf.bufferViews[i].byteOffset = currentOffset;
    gltf.bufferViews[i].byteLength = chunk.length;
    alignedChunks.push(chunk);
    currentOffset += chunk.length;
    const rem = currentOffset % 4;
    if (rem !== 0) {
      const pad = 4 - rem;
      alignedChunks.push(Buffer.alloc(pad));
      currentOffset += pad;
    }
  }

  const newBinBuf = Buffer.concat(alignedChunks);
  gltf.buffers[0].byteLength = newBinBuf.length;

  let newJsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonRem = newJsonBuf.length % 4;
  if (jsonRem !== 0) {
    newJsonBuf = Buffer.concat([newJsonBuf, Buffer.alloc(4 - jsonRem, 0x20)]);
  }

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0);
  header.writeUInt32LE(2, 4);
  const totalGlbLen = 12 + 8 + newJsonBuf.length + 8 + newBinBuf.length;
  header.writeUInt32LE(totalGlbLen, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(newJsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4E4F534A, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(newBinBuf.length, 0);
  binHeader.writeUInt32LE(0x004E4942, 4);

  const finalGlb = Buffer.concat([header, jsonHeader, newJsonBuf, binHeader, newBinBuf]);
  const outGlbPath = 'public/models/colosseum_rome_shape_grounded.glb';
  fs.writeFileSync(outGlbPath, finalGlb);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 SUCCESS! Enhanced ${targetMeshIndices.length} facade meshes in ${totalTime}s.`);
  console.log(`Saved repacked GLB: ${outGlbPath} (${(finalGlb.length / (1024 * 1024)).toFixed(2)} MB)`);
})();
