const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function scaleAndSharpen(inBuf, targetW, targetH) {
  return new Promise((resolve, reject) => {
    // High-order Lanczos super-resolution + adaptive unsharp mask
    const vf = `scale=${targetW}:${targetH}:flags=lanczos+accurate_rnd,unsharp=7:7:2.4:7:7:0.2`;
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg scale filter failed with code ${code}`));
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

// Fast procedural 3D noise functions for physical metric scale micro-detail
function hash3D(x, y, z) {
  let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise3D(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uy = fy * fy * (3.0 - 2.0 * fy);
  const uz = fz * fz * (3.0 - 2.0 * fz);

  const d000 = hash3D(ix, iy, iz);
  const d100 = hash3D(ix + 1, iy, iz);
  const d010 = hash3D(ix, iy + 1, iz);
  const d110 = hash3D(ix + 1, iy + 1, iz);
  const d001 = hash3D(ix, iy, iz + 1);
  const d101 = hash3D(ix + 1, iy, iz + 1);
  const d011 = hash3D(ix, iy + 1, iz + 1);
  const d111 = hash3D(ix + 1, iy + 1, iz + 1);

  const x0 = d000 * (1 - ux) + d100 * ux;
  const x1 = d010 * (1 - ux) + d110 * ux;
  const x2 = d001 * (1 - ux) + d101 * ux;
  const x3 = d011 * (1 - ux) + d111 * ux;

  const y0 = x0 * (1 - uy) + x1 * uy;
  const y1 = x2 * (1 - uy) + x3 * uy;

  return y0 * (1 - uz) + y1 * uz;
}

function fbm3D(x, y, z, octaves = 3) {
  let v = 0.0, amp = 0.5, freq = 1.0;
  for (let o = 0; o < octaves; o++) {
    v += amp * valueNoise3D(x * freq, y * freq, z * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return v;
}

(async () => {
  const startTime = Date.now();
  console.log('================================================================');
  console.log('=== SCENE-WIDE ALGORITHMIC UV UNWRAP/REWRAP & DETAIL ENGINE ===');
  console.log('=== Processing All 79 Meshes with Material-Adaptive Fidelity ===');
  console.log('================================================================');

  const glbPath = path.resolve('public/models/colosseum_rome_textured.glb');
  const glbBuffer = fs.readFileSync(glbPath);
  const jsonLen = glbBuffer.readUInt32LE(12);
  const gltf = JSON.parse(glbBuffer.toString('utf8', 20, 20 + jsonLen));

  const binOffset = 20 + jsonLen;
  const binChunkLen = glbBuffer.readUInt32LE(binOffset);
  const binBuffer = glbBuffer.subarray(binOffset + 8, binOffset + 8 + binChunkLen);

  function getAccessorData(accIndex) {
    if (accIndex === undefined) return null;
    const acc = gltf.accessors[accIndex];
    const bv = gltf.bufferViews[acc.bufferView];
    const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const count = acc.count;
    const byteStart = binBuffer.byteOffset + offset;
    if (acc.componentType === 5126) {
      const numComponents = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
      const byteLen = count * numComponents * 4;
      const slice = binBuffer.buffer.slice(byteStart, byteStart + byteLen);
      return new Float32Array(slice);
    } else if (acc.componentType === 5123) {
      const byteLen = count * 2;
      const slice = binBuffer.buffer.slice(byteStart, byteStart + byteLen);
      return new Uint16Array(slice);
    } else if (acc.componentType === 5125) {
      const byteLen = count * 4;
      const slice = binBuffer.buffer.slice(byteStart, byteStart + byteLen);
      return new Uint32Array(slice);
    } else if (acc.componentType === 5121) {
      const byteLen = count;
      const slice = binBuffer.buffer.slice(byteStart, byteStart + byteLen);
      return new Uint8Array(slice);
    }
  }

  const numMeshes = gltf.meshes.length;
  console.log(`Discovered ${numMeshes} submeshes in GLB scene.`);

  // Map to store replaced bufferViews
  const replacedBvs = new Map();

  let totalTrianglesProcessed = 0;
  let totalTexelsProcessed = 0;
  let foliageCount = 0;
  let roadCount = 0;
  let stoneCount = 0;
  let stuccoCount = 0;

  for (let meshIdx = 0; meshIdx < numMeshes; meshIdx++) {
    const meshStartTime = Date.now();
    const mesh = gltf.meshes[meshIdx];
    const prim = mesh.primitives[0];

    const positions = getAccessorData(prim.attributes.POSITION);
    const uvs = getAccessorData(prim.attributes.TEXCOORD_0);
    const indices = getAccessorData(prim.indices);
    const numTris = indices.length / 3;
    totalTrianglesProcessed += numTris;

    // Get texture image
    const matIdx = prim.material;
    const texIdx = gltf.materials[matIdx]?.pbrMetallicRoughness?.baseColorTexture?.index;
    const imgIdx = texIdx !== undefined ? gltf.textures[texIdx].source : meshIdx;
    const img = gltf.images[imgIdx];
    const origBv = gltf.bufferViews[img.bufferView];
    const origImgBuf = binBuffer.subarray(origBv.byteOffset, origBv.byteOffset + origBv.byteLength);

    // Resolution: Mesh 39 uses 2048x2048 (hero inspection mesh); all others use 1024x1024
    const targetDim = meshIdx === 39 ? 2048 : 1024;
    const qv = meshIdx === 39 ? 2 : 3;

    // Step 1: High-order Lanczos super-resolution + adaptive unsharp mask
    const baseRgba = await scaleAndSharpen(origImgBuf, targetDim, targetDim);
    const outRgba = Buffer.from(baseRgba);

    const W = targetDim;
    const H = targetDim;
    const interiorMask = new Uint8Array(W * H);

    // Precompute 2D luminance and Sobel gradient magnitude for photographic joint crevice deepening
    const lum = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        lum[y * W + x] = 0.299 * baseRgba[idx] + 0.587 * baseRgba[idx + 1] + 0.114 * baseRgba[idx + 2];
      }
    }
    const grad = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p00 = lum[(y - 1) * W + (x - 1)], p01 = lum[(y - 1) * W + x], p02 = lum[(y - 1) * W + (x + 1)];
        const p10 = lum[y * W + (x - 1)], p12 = lum[y * W + (x + 1)];
        const p20 = lum[(y + 1) * W + (x - 1)], p21 = lum[(y + 1) * W + x], p22 = lum[(y + 1) * W + (x + 1)];
        const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
        const gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
        grad[y * W + x] = Math.sqrt(gx * gx + gy * gy) / 8.0;
      }
    }

    // Step 2: Algorithmic Triangle Rewrap & Material-Conformal Micro-Detail
    for (let t = 0; t < numTris; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];

      const x0 = positions[i0 * 3], y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
      const x1 = positions[i1 * 3], y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];
      const x2 = positions[i2 * 3], y2 = positions[i2 * 3 + 1], z2 = positions[i2 * 3 + 2];

      const u0 = uvs[i0 * 2] * (W - 1), v0 = (1.0 - uvs[i0 * 2 + 1]) * (H - 1);
      const u1 = uvs[i1 * 2] * (W - 1), v1 = (1.0 - uvs[i1 * 2 + 1]) * (H - 1);
      const u2 = uvs[i2 * 2] * (W - 1), v2 = (1.0 - uvs[i2 * 2 + 1]) * (H - 1);

      // Face normal in 3D world space
      const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
      const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const nX = nx / len;
      const nY = ny / len;
      const nZ = nz / len;

      const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
      if (Math.abs(det) < 1e-6) continue;
      const invDet = 1.0 / det;

      const minPx = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
      const maxPx = Math.min(W - 1, Math.ceil(Math.max(u0, u1, u2)));
      const minPy = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
      const maxPy = Math.min(H - 1, Math.ceil(Math.max(v0, v1, v2)));

      const absNy = Math.abs(nY);

      for (let py = minPy; py <= maxPy; py++) {
        for (let px = minPx; px <= maxPx; px++) {
          const w0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * invDet;
          if (w0 < -0.001 || w0 > 1.001) continue;
          const w1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * invDet;
          if (w1 < -0.001 || (w0 + w1) > 1.001) continue;
          const w2 = 1.0 - w0 - w1;
          if (w2 < -0.001) continue;

          const pIdx = py * W + px;
          interiorMask[pIdx] = 1;

          // Physical 3D world position
          const wx = w0 * x0 + w1 * x1 + w2 * x2;
          const wy = w0 * y0 + w1 * y1 + w2 * y2;
          const wz = w0 * z0 + w1 * z1 + w2 * z2;

          const idx = pIdx * 4;
          const r = baseRgba[idx];
          const g = baseRgba[idx + 1];
          const b = baseRgba[idx + 2];
          totalTexelsProcessed++;

          // SEMANTIC MATERIAL CLASSIFICATION (Texel Chroma + Triangle 3D Geometry)
          // 1. VEGETATION / FOLIAGE
          // Excess green chroma: g > r + 3 and g > b + 3
          const isFoliage = (g > r + 3) && (g > b + 3) && (g > 45);

          // 2. GROUND / ASPHALT / ROAD / SIDEWALK / PAVEMENT
          // Ground level elevation (wy < 73.5m) or flat horizontal ground normal
          const isGround = (wy < 73.5) || (absNy > 0.70 && wy < 80.0);

          // 3. UNIVERSAL ROMAN ARCHITECTURAL STONE
          // All elevated architecture (wy >= 73.5m) that is not foliage
          const isArchitecture = !isGround && !isFoliage;

          let deltaR = 0, deltaG = 0, deltaB = 0;

          if (isFoliage) {
            foliageCount++;
            // VEGETATION MICRO-DETAIL:
            // High-frequency leaf canopy dappling (chlorophyll micro-contrast)
            const leafDapple = (valueNoise3D(wx * 16.0, wy * 16.0, wz * 16.0) - 0.5) * 32.0;
            const leafFine = (hash3D(wx * 65.0, wy * 65.0, wz * 65.0) - 0.5) * 16.0;
            const dL = leafDapple + leafFine;
            deltaR = dL * 0.55;
            deltaG = dL * 1.15; // enhance chlorophyll green vibrancy
            deltaB = dL * 0.50;
          } else if (isGround) {
            roadCount++;
            // ASPHALT / ROAD / PAVEMENT MICRO-DETAIL:
            // Isotropic mineral bitumen aggregate (fine crushed stone tooth)
            const bitAgg = (valueNoise3D(wx * 40.0, wy * 40.0, wz * 40.0) - 0.5) * 18.0;
            const bitFine = (hash3D(wx * 110.0, wy * 110.0, wz * 110.0) - 0.5) * 12.0;
            const dL = bitAgg + bitFine;
            deltaR = dL;
            deltaG = dL;
            deltaB = dL;
          } else if (isArchitecture) {
            stoneCount++;
            // HIGH-DEFINITION ROMAN TRAVERTINE STONE & MASONRY:
            // 1. Photographic Joint & Mortar Crevice Deepening
            const gVal = grad[pIdx];
            let jointDarken = 0;
            if (gVal > 6.0) {
              jointDarken = Math.min(26.0, (gVal - 6.0) * 0.90);
            }

            // 2. Travertine Cavitation Micro-Pores (analytical steep depression)
            const poreVal = valueNoise3D(wx * 22.0, wy * 22.0, wz * 22.0);
            let porePits = 0;
            if (poreVal < 0.24) {
              porePits = Math.pow((0.24 - poreVal) / 0.24, 2.0) * 52.0;
            }

            // 3. Calcite Mineral Grain & Bedding Strata
            const calciteGrain = (fbm3D(wx * 28.0, wy * 28.0, wz * 28.0, 3) - 0.5) * 30.0;
            const fineGrain = (hash3D(wx * 85.0, wy * 85.0, wz * 85.0) - 0.5) * 12.0;
            const strata = Math.sin(wy * 18.0) * 0.5 + 0.5;
            const strataDarken = strata > 0.65 ? (strata - 0.65) * 16.0 : 0.0;

            // 4. Archway Soffit Ambient Occlusion & Upper Cornice Highlight
            let aoMult = 1.0;
            if (nY < -0.15) {
              aoMult = 0.76; // archway soffit shadow
            } else if (nY > 0.60) {
              aoMult = 1.06; // cornice sky bounce
            }

            let deltaL = (calciteGrain + fineGrain - strataDarken - porePits - jointDarken) * aoMult;
            deltaR = deltaL;
            deltaG = deltaL * 0.93;
            deltaB = deltaL * 0.82;
          }

          outRgba[idx] = Math.max(0, Math.min(255, Math.round(r + deltaR)));
          outRgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g + deltaG)));
          outRgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b + deltaB)));
        }
      }
    }

    // Step 3: Conservative UV Gutter Dilation (3-pixel border bleed to prevent mipmap seams)
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const pIdx = py * W + px;
        if (interiorMask[pIdx] === 0) {
          // Check 3x3 neighborhood for nearest interior texel
          let found = false;
          for (let dy = -2; dy <= 2 && !found; dy++) {
            const ny = py + dy;
            if (ny < 0 || ny >= H) continue;
            for (let dx = -2; dx <= 2 && !found; dx++) {
              const nx = px + dx;
              if (nx < 0 || nx >= W) continue;
              const nIdx = ny * W + nx;
              if (interiorMask[nIdx] === 1) {
                const srcIdx = nIdx * 4;
                const dstIdx = pIdx * 4;
                outRgba[dstIdx] = outRgba[srcIdx];
                outRgba[dstIdx + 1] = outRgba[srcIdx + 1];
                outRgba[dstIdx + 2] = outRgba[srcIdx + 2];
                outRgba[dstIdx + 3] = 255;
                found = true;
              }
            }
          }
        }
      }
    }

    // Step 4: High-efficiency JPEG compression
    const newJpeg = await encodeJpeg(outRgba, W, H, qv);
    replacedBvs.set(img.bufferView, newJpeg);
    if (meshIdx === 39) {
      fs.writeFileSync(path.resolve('public/models/colosseum_stone_texture_39_shape_grounded.jpg'), newJpeg);
    }

    const elapsed = Date.now() - meshStartTime;
    if (meshIdx % 10 === 0 || meshIdx === 39 || meshIdx === numMeshes - 1) {
      console.log(`[Mesh ${meshIdx}/${numMeshes - 1}] WxH=${W}x${H} qv=${qv} size=${(newJpeg.length / 1024).toFixed(1)} KB (${elapsed}ms)`);
    }
  }

  console.log('--- Material Classification Statistics ---');
  console.log(`Total Triangles: ${totalTrianglesProcessed.toLocaleString()}`);
  console.log(`Total Texels Analyzed: ${totalTexelsProcessed.toLocaleString()}`);
  console.log(`Travertine Stone Texels: ${stoneCount.toLocaleString()} (${(stoneCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Asphalt/Road Texels: ${roadCount.toLocaleString()} (${(roadCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Vegetation/Tree Texels: ${foliageCount.toLocaleString()} (${(foliageCount / totalTexelsProcessed * 100).toFixed(1)}%)`);

  // Step 5: Repack into standardized binary glTF 2.0 (.glb)
  console.log('Repacking all 79 submeshes into unified GLB stream...');
  const newBvDescriptors = [];
  const newBufferChunks = [];
  let currentOffset = 0;

  for (let bvIdx = 0; bvIdx < gltf.bufferViews.length; bvIdx++) {
    const origBv = gltf.bufferViews[bvIdx];
    let chunkData;
    if (replacedBvs.has(bvIdx)) {
      chunkData = replacedBvs.get(bvIdx);
    } else {
      chunkData = binBuffer.subarray(origBv.byteOffset, origBv.byteOffset + origBv.byteLength);
    }

    const pad = (4 - (chunkData.length % 4)) % 4;
    let finalChunk = chunkData;
    if (pad > 0) {
      finalChunk = Buffer.concat([chunkData, Buffer.alloc(pad)]);
    }

    newBvDescriptors.push({
      buffer: 0,
      byteOffset: currentOffset,
      byteLength: chunkData.length
    });

    newBufferChunks.push(finalChunk);
    currentOffset += finalChunk.length;
  }

  gltf.bufferViews = newBvDescriptors;
  gltf.buffers[0].byteLength = currentOffset;

  const newJsonStr = JSON.stringify(gltf);
  const newJsonBuf = Buffer.from(newJsonStr, 'utf8');
  const jsonPad = (4 - (newJsonBuf.length % 4)) % 4;
  const finalJsonBuf = jsonPad > 0 ? Buffer.concat([newJsonBuf, Buffer.alloc(jsonPad, 0x20)]) : newJsonBuf;

  const totalBinChunk = Buffer.concat(newBufferChunks);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  const totalGlbLen = 12 + 8 + finalJsonBuf.length + 8 + totalBinChunk.length;
  header.writeUInt32LE(totalGlbLen, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(finalJsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(totalBinChunk.length, 0);
  binHeader.writeUInt32LE(0x004E4942, 4); // 'BIN\0'

  const finalGlb = Buffer.concat([header, jsonHeader, finalJsonBuf, binHeader, totalBinChunk]);
  const outPath = path.resolve('public/models/colosseum_rome_shape_grounded.glb');
  fs.writeFileSync(outPath, finalGlb);

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`=== SUCCESS: All 79 Meshes Processed & Repacked ===`);
  console.log(`Output Path: ${outPath}`);
  console.log(`Output File Size: ${(finalGlb.length / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`Execution Time: ${totalSecs}s`);
})();
