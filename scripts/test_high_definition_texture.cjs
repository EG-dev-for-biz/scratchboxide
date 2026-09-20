const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function scaleAndSharpenHighDef(inBuf, targetW, targetH) {
  return new Promise((resolve, reject) => {
    // Multi-stage high-definition filtering:
    // 1. High-precision Lanczos scaling with accurate rounding
    // 2. High-pass edge sharpening with wide radius and edge protection
    // 3. Sub-pixel micro-contrast boost
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

async function encodeJpeg(rgbaBuf, w, h, qv = 2) {
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

// Fast 3D hash
function hash3D(x, y, z) {
  let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

// 3D Cellular / Worley noise for cavitation pits and mineral grains
function worley3D(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let minDist = 1.0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const px = cx + hash3D(cx, cy, cz);
        const py = cy + hash3D(cx + 17, cy + 31, cz + 43);
        const pz = cz + hash3D(cx + 59, cy + 71, cz + 89);
        const dist = Math.hypot(x - px, y - py, z - pz);
        if (dist < minDist) minDist = dist;
      }
    }
  }
  return minDist;
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

function fbm3D(x, y, z, octaves = 4) {
  let v = 0.0, amp = 0.5, freq = 1.0;
  for (let o = 0; o < octaves; o++) {
    v += amp * valueNoise3D(x * freq, y * freq, z * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return v;
}

(async () => {
  console.log('Testing Ultra-High-Definition Texture Synthesis on Mesh 39...');
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
      return new Float32Array(binBuffer.buffer.slice(byteStart, byteStart + byteLen));
    } else if (acc.componentType === 5123) {
      return new Uint16Array(binBuffer.buffer.slice(byteStart, byteStart + count * 2));
    } else if (acc.componentType === 5125) {
      return new Uint32Array(binBuffer.buffer.slice(byteStart, byteStart + count * 4));
    }
    return null;
  }

  const mesh39 = gltf.meshes[39];
  const prim = mesh39.primitives[0];
  const positions = getAccessorData(prim.attributes.POSITION);
  const uvs = getAccessorData(prim.attributes.TEXCOORD_0);
  const indices = getAccessorData(prim.indices);
  const numTris = indices.length / 3;

  const matIdx = prim.material;
  const texIdx = gltf.materials[matIdx]?.pbrMetallicRoughness?.baseColorTexture?.index;
  const imgIdx = texIdx !== undefined ? gltf.textures[texIdx].source : 39;
  const img = gltf.images[imgIdx];
  const origBv = gltf.bufferViews[img.bufferView];
  const origImgBuf = binBuffer.subarray(origBv.byteOffset, origBv.byteOffset + origBv.byteLength);

  const W = 2048, H = 2048;
  const baseRgba = await scaleAndSharpenHighDef(origImgBuf, W, H);
  const outRgba = Buffer.from(baseRgba);

  // Precompute luminance map for gradient analysis
  const lumMap = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    lumMap[i] = 0.299 * baseRgba[idx] + 0.587 * baseRgba[idx + 1] + 0.114 * baseRgba[idx + 2];
  }

  // Precompute 2D gradient magnitude map (Sobel operator)
  const gradMagMap = new Float32Array(W * H);
  for (let py = 1; py < H - 1; py++) {
    for (let px = 1; px < W - 1; px++) {
      const idx = py * W + px;
      const gx = (lumMap[idx + 1] - lumMap[idx - 1]);
      const gy = (lumMap[idx + W] - lumMap[idx - W]);
      gradMagMap[idx] = Math.hypot(gx, gy);
    }
  }

  const interiorMask = new Uint8Array(W * H);

  for (let t = 0; t < numTris; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];

    const x0 = positions[i0 * 3], y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
    const x1 = positions[i1 * 3], y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];
    const x2 = positions[i2 * 3], y2 = positions[i2 * 3 + 1], z2 = positions[i2 * 3 + 2];

    const u0 = uvs[i0 * 2] * (W - 1), v0 = (1.0 - uvs[i0 * 2 + 1]) * (H - 1);
    const u1 = uvs[i1 * 2] * (W - 1), v1 = (1.0 - uvs[i1 * 2 + 1]) * (H - 1);
    const u2 = uvs[i2 * 2] * (W - 1), v2 = (1.0 - uvs[i2 * 2 + 1]) * (H - 1);

    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const nY = ny / len;

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

        const wx = w0 * x0 + w1 * x1 + w2 * x2;
        const wy = w0 * y0 + w1 * y1 + w2 * y2;
        const wz = w0 * z0 + w1 * z1 + w2 * z2;

        const idx = pIdx * 4;
        const r = baseRgba[idx];
        const g = baseRgba[idx + 1];
        const b = baseRgba[idx + 2];
        const lum = lumMap[pIdx];
        const grad = gradMagMap[pIdx];

        // Semantic discrimination
        const isFoliage = (g > r + 3) && (g > b + 3) && (g > 45);
        const isGround = (wy < 73.5) || (absNy > 0.70 && wy < 80.0);
        // All vertical/slanted architecture above ground is Roman stone masonry!
        const isStone = !isGround && !isFoliage && (wy >= 73.5);

        let deltaR = 0, deltaG = 0, deltaB = 0;

        if (isFoliage) {
          const leafW = worley3D(wx * 14.0, wy * 14.0, wz * 14.0);
          const leafFbm = fbm3D(wx * 8.0, wy * 8.0, wz * 8.0, 3);
          const dL = ((1.0 - leafW) * 0.65 + leafFbm * 0.35 - 0.5) * 26.0;
          deltaR = dL * 0.5;
          deltaG = dL * 1.30;
          deltaB = dL * 0.4;
        } else if (isGround) {
          // Asphalt road: dual-frequency mineral aggregate tooth
          const aggCell = worley3D(wx * 40.0, wy * 40.0, wz * 40.0);
          const aggFine = hash3D(wx * 80.0, wy * 80.0, wz * 80.0);
          const aggTooth = ((aggCell - 0.5) * 16.0) + ((aggFine - 0.5) * 8.0);
          deltaR = aggTooth;
          deltaG = aggTooth;
          deltaB = aggTooth;
        } else if (isStone) {
          // ULTRA-HIGH-DEFINITION ROMAN TRAVERTINE:
          // 1. Natural photographic architectural joint deepening (sharpens real stone block joints)
          let jointCrevice = 0;
          if (grad > 6.0) {
            jointCrevice = Math.min(26.0, (grad - 6.0) * 0.90);
          }

          // 2. Travertine cavitation micro-pores (Worley cavity pits)
          const cavW = worley3D(wx * 20.0, wy * 20.0, wz * 20.0);
          let poreDepression = 0;
          if (cavW < 0.26) {
            poreDepression = (0.26 - cavW) * 55.0; // rich, crisp micro-pore pit
          }

          // 3. Calcite crystalline facet tooth & horizontal sedimentary strata
          const calciteFbm = (fbm3D(wx * 28.0, wy * 28.0, wz * 28.0, 4) - 0.5) * 22.0;

          // 4. Directional ambient occlusion (archway soffits and under-cornices)
          let aoMult = 1.0;
          if (nY < -0.15) {
            aoMult = 0.70; // deep rich shadow in arch ceilings
          } else if (nY > 0.65) {
            aoMult = 1.08; // bright sky-facing ledge
          }

          const totalStoneDelta = (calciteFbm - poreDepression - jointCrevice);

          // Calibrate color response based on warm travertine vs weathered stone
          const isWarm = (r > g) && (g >= b) && (r - b >= 12);
          const rMult = isWarm ? 1.08 : 1.0;
          const gMult = isWarm ? 0.94 : 1.0;
          const bMult = isWarm ? 0.76 : 1.0;

          deltaR = (r * (aoMult - 1.0)) + totalStoneDelta * rMult;
          deltaG = (g * (aoMult - 1.0)) + totalStoneDelta * gMult;
          deltaB = (b * (aoMult - 1.0)) + totalStoneDelta * bMult;
        } else {
          const tooth = (fbm3D(wx * 16.0, wy * 16.0, wz * 16.0, 3) - 0.5) * 10.0;
          deltaR = tooth;
          deltaG = tooth;
          deltaB = tooth;
        }

        outRgba[idx] = Math.max(0, Math.min(255, Math.round(r + deltaR)));
        outRgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g + deltaG)));
        outRgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b + deltaB)));
      }
    }
  }

  // 3-pixel morphological dilation
  for (let step = 0; step < 3; step++) {
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const pIdx = py * W + px;
        if (interiorMask[pIdx] === 1) continue;
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= W) continue;
            const nIdx = ny * W + nx;
            if (interiorMask[nIdx] === 1) {
              const dstIdx = pIdx * 4;
              const srcIdx = nIdx * 4;
              outRgba[dstIdx] = outRgba[srcIdx];
              outRgba[dstIdx + 1] = outRgba[srcIdx + 1];
              outRgba[dstIdx + 2] = outRgba[srcIdx + 2];
              outRgba[dstIdx + 3] = 255;
              found = true;
              break;
            }
          }
        }
      }
    }
  }

  const newJpeg = await encodeJpeg(outRgba, W, H, 2);
  fs.writeFileSync('public/models/colosseum_stone_texture_39_shape_grounded.jpg', newJpeg);
  console.log(`Success! Written public/models/colosseum_stone_texture_39_shape_grounded.jpg (${(newJpeg.length / 1024).toFixed(1)} KB)`);
})();
