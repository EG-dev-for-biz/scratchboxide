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
      if (code !== 0) reject(new Error(`ffmpeg encode jpeg failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(rgbaBuf);
    proc.stdin.end();
  });
}

async function encodePng(rgbaBuf, w, h) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${w}x${h}`,
      '-i', 'pipe:0',
      '-f', 'image2pipe',
      '-c:v', 'png',
      '-compression_level', '4',
      'pipe:1'
    ]);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg encode png failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(rgbaBuf);
    proc.stdin.end();
  });
}

async function encodeWebp(rgbaBuf, w, h, mapType = 'generic', options = {}) {
  return new Promise((resolve, reject) => {
    const pamHeader = Buffer.from(
      `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
      'ascii'
    );
    const fullBuf = Buffer.concat([pamHeader, rgbaBuf]);
    const args = ['-m', '4', '-sharp_yuv', '-metadata', 'none'];
    if (mapType === 'foliage') {
      args.push('-q', '88', '-alpha_q', '100', '-exact');
    } else if (mapType === 'albedo') {
      args.push('-q', '88', '-alpha_q', '100');
    } else if (mapType === 'normal') {
      args.push('-q', '95', '-alpha_q', '100');
    } else if (mapType === 'orm') {
      args.push('-lossless', '-z', '4');
    } else {
      args.push('-q', '88');
    }
    args.push('-o', '-', '--', '-');
    const proc = spawn('cwebp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`cwebp encode webp failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(fullBuf);
    proc.stdin.end();
  });
}


// Procedural 3D noise functions for physical metric scale micro-detail
function hash3D(x, y, z) {
  let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

// Precomputed fast permutation table for sub-millisecond 3D Worley cellular noise
const permTable = new Uint8Array(512);
for (let i = 0; i < 256; i++) permTable[i] = i;
for (let i = 255; i > 0; i--) {
  const j = Math.floor(hash3D(i, 42.1, 17.9) * (i + 1));
  const t = permTable[i]; permTable[i] = permTable[j]; permTable[j] = t;
}
for (let i = 0; i < 256; i++) permTable[256 + i] = permTable[i];

function fastHash3D(ix, iy, iz) {
  const x = ix & 255, y = iy & 255, z = iz & 255;
  return permTable[permTable[permTable[x] + y] + z] / 255.0;
}

function fastWorley3D(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let minDistSq = 99.0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const jx = fastHash3D(cx, cy, cz);
        const jy = fastHash3D(cx + 31, cy + 11, cz + 71);
        const jz = fastHash3D(cx + 93, cy + 47, cz + 19);
        const px = cx + jx - x;
        const py = cy + jy - y;
        const pz = cz + jz - z;
        const dSq = px * px + py * py + pz * pz;
        if (dSq < minDistSq) minDistSq = dSq;
      }
    }
  }
  return Math.sqrt(minDistSq);
}

function fastWorleyF1F2_3D(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let d1Sq = 99.0, d2Sq = 99.0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const jx = fastHash3D(cx, cy, cz);
        const jy = fastHash3D(cx + 31, cy + 11, cz + 71);
        const jz = fastHash3D(cx + 93, cy + 47, cz + 19);
        const px = cx + jx - x;
        const py = cy + jy - y;
        const pz = cz + jz - z;
        const dSq = px * px + py * py + pz * pz;
        if (dSq < d1Sq) {
          d2Sq = d1Sq;
          d1Sq = dSq;
        } else if (dSq < d2Sq) {
          d2Sq = dSq;
        }
      }
    }
  }
  const d1 = Math.sqrt(d1Sq);
  const d2 = Math.sqrt(d2Sq);
  return { d1, d2, diff: d2 - d1 };
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

// Metric 3D point-to-segment distance for 5mm Virtual Specular Bevel
function distToSegment(px, py, pz, p0, p1) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-12) {
    const rx = px - p0[0], ry = py - p0[1], rz = pz - p0[2];
    return Math.sqrt(rx * rx + ry * ry + rz * rz);
  }
  let t = ((px - p0[0]) * dx + (py - p0[1]) * dy + (pz - p0[2]) * dz) / l2;
  t = Math.max(0.0, Math.min(1.0, t));
  const qx = p0[0] + t * dx, qy = p0[1] + t * dy, qz = p0[2] + t * dz;
  const rx = px - qx, ry = py - qy, rz = pz - qz;
  return Math.sqrt(rx * rx + ry * ry + rz * rz);
}

async function runColosseum1kPbrPipeline() {
  const startTime = Date.now();
  console.log('========================================================================');
  console.log('=== ROMAN COLOSSEUM: SCENE-WIDE 1K PBR SUITE SYNTHESIS ENGINE ===');
  console.log('=== 1024x1024 Albedo, Scharr Normals, Curvature Roughness & HBAO ORM ===');
  console.log('========================================================================');

  const glbPath = path.resolve(__dirname, '../public/models/colosseum_rome_textured.glb');
  if (!fs.existsSync(glbPath)) {
    throw new Error(`Input Colosseum GLB not found at ${glbPath}`);
  }

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
  console.log(`Discovered ${numMeshes} submeshes in Colosseum GLB scene.`);

  // Find geometry end offset by inspecting all bufferViews referenced by accessors
  let geomEndOffset = 0;
  let geomBvCount = 0;
  for (const acc of gltf.accessors) {
    const bv = gltf.bufferViews[acc.bufferView];
    const end = (bv.byteOffset || 0) + bv.byteLength;
    if (end > geomEndOffset) geomEndOffset = end;
    if (acc.bufferView >= geomBvCount) geomBvCount = acc.bufferView + 1;
  }
  console.log(`Geometry buffer views: ${geomBvCount}, End offset: ${geomEndOffset} bytes`);

  // Precompute global bare-earth ground elevation grid across the entire 3D model
  // (Derived from non-vegetated road, plaza, and terrain triangles)
  console.log('Precomputing global bare-earth ground elevation grid...');
  const globalGroundGrid = new Map();
  const groundGridCellSize = 6.0;

  for (let mIdx = 0; mIdx < numMeshes; mIdx++) {
    const mMesh = gltf.meshes[mIdx];
    const mPrim = mMesh.primitives[0];
    const mPos = getAccessorData(mPrim.attributes.POSITION);
    const mNorm = getAccessorData(mPrim.attributes.NORMAL);
    const mIndex = mPrim.indices !== undefined ? getAccessorData(mPrim.indices) : null;
    const mNumTriangles = mIndex ? mIndex.length / 3 : mPos.length / 9;

    for (let t = 0; t < mNumTriangles; t++) {
      const i0 = mIndex ? mIndex[t * 3] : t * 3;
      const i1 = mIndex ? mIndex[t * 3 + 1] : t * 3 + 1;
      const i2 = mIndex ? mIndex[t * 3 + 2] : t * 3 + 2;
      const ty0 = mPos[i0 * 3 + 1], ty1 = mPos[i1 * 3 + 1], ty2 = mPos[i2 * 3 + 1];
      const triY = (ty0 + ty1 + ty2) / 3.0;

      // Filter ground range: between 68.0m and 76.0m, predominantly upward facing
      if (triY >= 68.0 && triY <= 76.0) {
        let fny = 0.5;
        if (mNorm) {
          fny = (mNorm[i0 * 3 + 1] + mNorm[i1 * 3 + 1] + mNorm[i2 * 3 + 1]) / 3.0;
        } else {
          const ax = mPos[i1 * 3] - mPos[i0 * 3], ay = ty1 - ty0, az = mPos[i1 * 3 + 2] - mPos[i0 * 3 + 2];
          const bx = mPos[i2 * 3] - mPos[i0 * 3], by = ty2 - ty0, bz = mPos[i2 * 3 + 2] - mPos[i0 * 3 + 2];
          fny = az * bx - ax * bz;
        }
        if (fny > 0.40 || triY <= 73.5) {
          const triX = (mPos[i0 * 3] + mPos[i1 * 3] + mPos[i2 * 3]) / 3.0;
          const triZ = (mPos[i0 * 3 + 2] + mPos[i1 * 3 + 2] + mPos[i2 * 3 + 2]) / 3.0;
          const key = `${Math.floor(triX / groundGridCellSize)},${Math.floor(triZ / groundGridCellSize)}`;
          const cur = globalGroundGrid.get(key);
          if (cur === undefined || triY < cur) {
            globalGroundGrid.set(key, triY);
          }
        }
      }
    }
  }

  function getGlobalGroundY(x, z) {
    const cx = Math.floor(x / groundGridCellSize);
    const cz = Math.floor(z / groundGridCellSize);
    for (let r = 0; r <= 3; r++) {
      let minR = Infinity, found = false;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const val = globalGroundGrid.get(`${cx + dx},${cz + dz}`);
          if (val !== undefined && val < minR) {
            minR = val;
            found = true;
          }
        }
      }
      if (found) return minR;
    }
    return 72.30; // Rome Colosseum datum fallback
  }
  console.log(`Global ground elevation grid initialized: ${globalGroundGrid.size} cells.`);

  const albedoImages = [];
  const albedoIsPng = [];
  const normalJpegs = [];
  const ormJpegs = [];

  let totalTrianglesProcessed = 0;
  let totalTexelsProcessed = 0;
  let foliageCount = 0;
  let turfGrassTexelsCount = 0;
  let shrubBushTexelsCount = 0;
  let treeCanopyTexelsCount = 0;
  let perforatedFoliageCount = 0;
  let roadCount = 0;
  let stoneCount = 0;

  // Step 1 & 2 Morphological Tensor and Weathering Field Telemetry
  let soffitTexelsCount = 0;
  let sillTexelsCount = 0;
  let ridgeTexelsCount = 0;
  let creviceTexelsCount = 0;
  let rainwashTexelsCount = 0;
  let solarOxidationTexelsCount = 0;
  let delightedStoneTexelsCount = 0;
  let volumetricFoliageTexelsCount = 0;
  let foliageUndersideCount = 0;
  let foliageFlutterCount = 0;
  let foliageChlorophyllRimCount = 0;
  let foliageVoidCount = 0;
  let foliageWaxyCuticleCount = 0;
  let gradinaChiselTexelsCount = 0;
  let calcitePitsTexelsCount = 0;
  let toksvigCoupledTexelsCount = 0;
  let mineralFlecksTexelsCount = 0;
  let virtualBevelTexelsCount = 0;
  let antiFacetingTexelsCount = 0;
  let sharpDihedralEdgesCount = 0;
  let smoothCurvatureEdgesCount = 0;
  let exportedFoliageHero = false;

  // Strict 1K resolution across all submeshes
  const W = 1024;
  const H = 1024;

  for (let meshIdx = 0; meshIdx < numMeshes; meshIdx++) {
    const meshStartTime = Date.now();
    const mesh = gltf.meshes[meshIdx];
    const prim = mesh.primitives[0];
    const matIdx = prim.material !== undefined ? prim.material : meshIdx;
    const mat = gltf.materials[matIdx];
    const texIdx = mat?.pbrMetallicRoughness?.baseColorTexture?.index ?? 0;
    const imgIdx = gltf.textures[texIdx]?.source ?? meshIdx;
    const img = gltf.images[imgIdx];
    const bv = gltf.bufferViews[img.bufferView];

    const origJpegBuf = binBuffer.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength);

    // Step 1: 1K Super-Resolution with Lanczos + adaptive unsharp
    const baseRgba = await scaleAndSharpen(origJpegBuf, W, H);
    const outAlbedoRgba = Buffer.from(baseRgba);
    const outNormalRgba = Buffer.alloc(W * H * 4);
    const outOrmRgba = Buffer.alloc(W * H * 4);

    let meshFoliageCount = 0;
    let meshPerforatedCount = 0;

    const interiorMask = new Uint8Array(W * H);
    const normalOffsetMap = new Float32Array(W * H);
    const roughnessMap = new Float32Array(W * H);
    const metalnessMap = new Float32Array(W * H);
    const aoMap = new Float32Array(W * H);
    const bentNormalMapX = new Float32Array(W * H);
    const bentNormalMapY = new Float32Array(W * H);
    const bentNormalMapZ = new Float32Array(W * H);
    bentNormalMapZ.fill(1.0); // Default flat tangent normal: [0, 0, 1]

    // Precompute photographic luminance, Sobel gradient magnitude, and 2D discrete Laplacian
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const idx = i * 4;
      lum[i] = (0.299 * baseRgba[idx] + 0.587 * baseRgba[idx + 1] + 0.114 * baseRgba[idx + 2]) / 255.0;
    }

    const grad = new Float32Array(W * H);
    const laplacian = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const pIdx = y * W + x;
        const p00 = lum[pIdx - W - 1], p01 = lum[pIdx - W], p02 = lum[pIdx - W + 1];
        const p10 = lum[pIdx - 1], p12 = lum[pIdx + 1];
        const p20 = lum[pIdx + W - 1], p21 = lum[pIdx + W], p22 = lum[pIdx + W + 1];
        const gx = -p00 + p02 - 2.0 * p10 + 2.0 * p12 - p20 + p22;
        const gy = -p00 - 2.0 * p01 - p02 + p20 + 2.0 * p21 + p22;
        grad[pIdx] = Math.sqrt(gx * gx + gy * gy) * 255.0;

        // 5-point discrete Laplacian for convex ridge vs concave pit detection
        laplacian[pIdx] = lum[pIdx - W] + lum[pIdx + W] + lum[pIdx - 1] + lum[pIdx + 1] - 4.0 * lum[pIdx];
      }
    }

    // Geometry data
    const posData = getAccessorData(prim.attributes.POSITION);
    const normData = getAccessorData(prim.attributes.NORMAL);
    const uvData = getAccessorData(prim.attributes.TEXCOORD_0);
    const indexData = prim.indices !== undefined ? getAccessorData(prim.indices) : null;

    const numTriangles = indexData ? indexData.length / 3 : posData.length / 9;
    totalTrianglesProcessed += numTriangles;

    // Precompute conifer tree column centroids and canopy radii in metric world space
    const submeshTreeGrid = new Map();
    const treeCellSize = 6.0;
    for (let t = 0; t < numTriangles; t++) {
      let i0 = indexData ? indexData[t * 3] : t * 3;
      let i1 = indexData ? indexData[t * 3 + 1] : t * 3 + 1;
      let i2 = indexData ? indexData[t * 3 + 2] : t * 3 + 2;

      // Sample base texture at triangle UV center to identify true vegetation triangles
      const uMid = (uvData[i0 * 2] + uvData[i1 * 2] + uvData[i2 * 2]) / 3.0;
      const vMid = (uvData[i0 * 2 + 1] + uvData[i1 * 2 + 1] + uvData[i2 * 2 + 1]) / 3.0;
      const px = Math.min(W - 1, Math.max(0, Math.floor(uMid * W)));
      const py = Math.min(H - 1, Math.max(0, Math.floor(vMid * H)));
      const pIdx = (py * W + px) * 4;
      const pr = baseRgba[pIdx], pg = baseRgba[pIdx + 1], pb = baseRgba[pIdx + 2];
      const isTriFoliage = (pg > pr + 3) && (pg > pb + 3) && (pg > 45);
      if (!isTriFoliage) continue;

      const triCx = (posData[i0 * 3] + posData[i1 * 3] + posData[i2 * 3]) / 3.0;
      const triCy = (posData[i0 * 3 + 1] + posData[i1 * 3 + 1] + posData[i2 * 3 + 1]) / 3.0;
      const triCz = (posData[i0 * 3 + 2] + posData[i1 * 3 + 2] + posData[i2 * 3 + 2]) / 3.0;
      const triGroundY = getGlobalGroundY(triCx, triCz);
      // Only elevated canopy triangles (>=1.5m above ground) contribute to overstory tree column clusters
      if (triCy < triGroundY + 1.5) continue;

      const gx = Math.floor(triCx / treeCellSize);
      const gz = Math.floor(triCz / treeCellSize);
      const key = `${gx},${gz}`;
      let cell = submeshTreeGrid.get(key);
      if (!cell) {
        cell = {
          sumX: 0, sumY: 0, sumZ: 0, count: 0,
          minY: triCy, maxY: triCy,
          minX: triCx, maxX: triCx,
          minZ: triCz, maxZ: triCz
        };
        submeshTreeGrid.set(key, cell);
      }
      cell.sumX += triCx; cell.sumY += triCy; cell.sumZ += triCz; cell.count++;
      cell.minY = Math.min(cell.minY, triCy); cell.maxY = Math.max(cell.maxY, triCy);
      cell.minX = Math.min(cell.minX, triCx); cell.maxX = Math.max(cell.maxX, triCx);
      cell.minZ = Math.min(cell.minZ, triCz); cell.maxZ = Math.max(cell.maxZ, triCz);
    }

    // =======================================================================
    // PHASE 3: SUBMESH TOPOLOGY ADJACENCY & DIHEDRAL ANGLE GRAPH
    // Precomputes:
    // 1. Sharp dihedral edges (>45°) for 5mm Virtual Specular Bevel
    // 2. Smooth dihedral edges (<=45°) for Curvature Anti-Faceting Normal Field
    // =======================================================================
    const submeshTriNormals = [];
    const submeshTriFrames = [];
    const triSharpEdges = new Array(numTriangles);
    const triIsCurved = new Uint8Array(numTriangles);
    for (let t = 0; t < numTriangles; t++) triSharpEdges[t] = [];

    // Spatial vertex quantization (1mm grid for welding UV seam vertices)
    function vPosKey(x, y, z) {
      return `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    }

    for (let t = 0; t < numTriangles; t++) {
      let i0 = indexData ? indexData[t * 3] : t * 3;
      let i1 = indexData ? indexData[t * 3 + 1] : t * 3 + 1;
      let i2 = indexData ? indexData[t * 3 + 2] : t * 3 + 2;

      const v0x = posData[i0 * 3], v0y = posData[i0 * 3 + 1], v0z = posData[i0 * 3 + 2];
      const v1x = posData[i1 * 3], v1y = posData[i1 * 3 + 1], v1z = posData[i1 * 3 + 2];
      const v2x = posData[i2 * 3], v2y = posData[i2 * 3 + 1], v2z = posData[i2 * 3 + 2];

      const ax = v1x - v0x, ay = v1y - v0y, az = v1z - v0z;
      const bx = v2x - v0x, by = v2y - v0y, bz = v2z - v0z;
      let fnx = ay * bz - az * by;
      let fny = az * bx - ax * bz;
      let fnz = ax * by - ay * bx;
      const nLen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz) || 1.0;
      fnx /= nLen; fny /= nLen; fnz /= nLen;

      submeshTriNormals.push({ x: fnx, y: fny, z: fnz });

      const k0 = vPosKey(v0x, v0y, v0z);
      const k1 = vPosKey(v1x, v1y, v1z);
      const k2 = vPosKey(v2x, v2y, v2z);

      submeshTriFrames.push({
        v0: [v0x, v0y, v0z], v1: [v1x, v1y, v1z], v2: [v2x, v2y, v2z],
        k0, k1, k2
      });
    }

    const edgeMap = new Map();
    for (let t = 0; t < numTriangles; t++) {
      const tf = submeshTriFrames[t];
      const pairs = [
        [tf.k0, tf.k1, tf.v0, tf.v1],
        [tf.k1, tf.k2, tf.v1, tf.v2],
        [tf.k2, tf.k0, tf.v2, tf.v0]
      ];
      for (let p = 0; p < 3; p++) {
        const [k0, k1, p0, p1] = pairs[p];
        const edgeKey = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
        let list = edgeMap.get(edgeKey);
        if (!list) { list = []; edgeMap.set(edgeKey, list); }
        list.push({ t, p0, p1 });
      }
    }

    const vertexToSmoothFaces = new Map();

    for (const list of edgeMap.values()) {
      if (list.length === 2) {
        const t0 = list[0].t, t1 = list[1].t;
        const n0 = submeshTriNormals[t0], n1 = submeshTriNormals[t1];
        const dot = Math.max(-1.0, Math.min(1.0, n0.x * n1.x + n0.y * n1.y + n0.z * n1.z));
        const dihedralDeg = Math.acos(dot) * (180.0 / Math.PI);

        if (dihedralDeg > 45.0) {
          sharpDihedralEdgesCount++;
          let cx = n0.x + n1.x, cy = n0.y + n1.y, cz = n0.z + n1.z;
          const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1.0;
          const chamfer = { x: cx / cLen, y: cy / cLen, z: cz / cLen };
          const edgeData = { p0: list[0].p0, p1: list[0].p1, chamfer };
          triSharpEdges[t0].push(edgeData);
          triSharpEdges[t1].push(edgeData);
        } else {
          smoothCurvatureEdgesCount++;
          if (dihedralDeg > 4.0) {
            triIsCurved[t0] = 1;
            triIsCurved[t1] = 1;
          }
        }
      }
    }

    for (let t = 0; t < numTriangles; t++) {
      const tf = submeshTriFrames[t];
      const fn = submeshTriNormals[t];
      const a = tf.v0, b = tf.v1, c = tf.v2;

      function angleAt(curr, va, vb) {
        const d1x = va[0] - curr[0], d1y = va[1] - curr[1], d1z = va[2] - curr[2];
        const d2x = vb[0] - curr[0], d2y = vb[1] - curr[1], d2z = vb[2] - curr[2];
        const l1 = Math.sqrt(d1x * d1x + d1y * d1y + d1z * d1z) || 1.0;
        const l2 = Math.sqrt(d2x * d2x + d2y * d2y + d2z * d2z) || 1.0;
        const d = (d1x * d2x + d1y * d2y + d1z * d2z) / (l1 * l2);
        return Math.acos(Math.max(-1.0, Math.min(1.0, d)));
      }

      const keys = [
        [tf.k0, angleAt(a, b, c)],
        [tf.k1, angleAt(b, c, a)],
        [tf.k2, angleAt(c, a, b)]
      ];
      for (const [key, angle] of keys) {
        let list = vertexToSmoothFaces.get(key);
        if (!list) { list = []; vertexToSmoothFaces.set(key, list); }
        list.push({ n: fn, angle });
      }
    }

    const vertexSmoothNormals = new Map();
    for (const [key, list] of vertexToSmoothFaces.entries()) {
      let sx = 0, sy = 0, sz = 0;
      for (const item of list) {
        sx += item.n.x * item.angle;
        sy += item.n.y * item.angle;
        sz += item.n.z * item.angle;
      }
      const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1.0;
      vertexSmoothNormals.set(key, { x: sx / len, y: sy / len, z: sz / len });
    }

    for (let t = 0; t < numTriangles; t++) {
      let i0, i1, i2;
      if (indexData) {
        i0 = indexData[t * 3];
        i1 = indexData[t * 3 + 1];
        i2 = indexData[t * 3 + 2];
      } else {
        i0 = t * 3;
        i1 = t * 3 + 1;
        i2 = t * 3 + 2;
      }

      const v0x = posData[i0 * 3], v0y = posData[i0 * 3 + 1], v0z = posData[i0 * 3 + 2];
      const v1x = posData[i1 * 3], v1y = posData[i1 * 3 + 1], v1z = posData[i1 * 3 + 2];
      const v2x = posData[i2 * 3], v2y = posData[i2 * 3 + 1], v2z = posData[i2 * 3 + 2];

      // Triangle centroid & nearest tree column center for Volumetric Canopy Bent Normals
      const triCx = (v0x + v1x + v2x) / 3.0;
      const triCy = (v0y + v1y + v2y) / 3.0;
      const triCz = (v0z + v1z + v2z) / 3.0;
      const tgx = Math.floor(triCx / treeCellSize);
      const tgz = Math.floor(triCz / treeCellSize);
      let treeCell = submeshTreeGrid.get(`${tgx},${tgz}`);
      if (!treeCell && submeshTreeGrid.size > 0) {
        let bestDistSq = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const nCell = submeshTreeGrid.get(`${tgx + dx},${tgz + dz}`);
            if (nCell) {
              const cx = nCell.sumX / nCell.count;
              const cz = nCell.sumZ / nCell.count;
              const dSq = (triCx - cx) * (triCx - cx) + (triCz - cz) * (triCz - cz);
              if (dSq < bestDistSq) {
                bestDistSq = dSq;
                treeCell = nCell;
              }
            }
          }
        }
      }
      const tCentroidX = treeCell ? treeCell.sumX / treeCell.count : triCx;
      const tCentroidY = treeCell ? treeCell.sumY / treeCell.count : triCy;
      const tCentroidZ = treeCell ? treeCell.sumZ / treeCell.count : triCz;
      const tCanopyRadius = treeCell
        ? Math.max(2.5, Math.max(treeCell.maxX - treeCell.minX, treeCell.maxZ - treeCell.minZ, treeCell.maxY - treeCell.minY) * 0.5)
        : 3.5;

      const u0 = uvData[i0 * 2], v0 = uvData[i0 * 2 + 1];
      const u1 = uvData[i1 * 2], v1 = uvData[i1 * 2 + 1];
      const u2 = uvData[i2 * 2], v2 = uvData[i2 * 2 + 1];

      // Surface normal
      let fnx, fny, fnz;
      if (normData) {
        fnx = (normData[i0 * 3] + normData[i1 * 3] + normData[i2 * 3]) / 3.0;
        fny = (normData[i0 * 3 + 1] + normData[i1 * 3 + 1] + normData[i2 * 3 + 1]) / 3.0;
        fnz = (normData[i0 * 3 + 2] + normData[i1 * 3 + 2] + normData[i2 * 3 + 2]) / 3.0;
      } else {
        const ax = v1x - v0x, ay = v1y - v0y, az = v1z - v0z;
        const bx = v2x - v0x, by = v2y - v0y, bz = v2z - v0z;
        fnx = ay * bz - az * by;
        fny = az * bx - ax * bz;
        fnz = ax * by - ay * bx;
      }
      const nLen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz) || 1.0;
      fnx /= nLen; fny /= nLen; fnz /= nLen;
      const absNy = Math.abs(fny);

      // Tangent coordinate frame for Anisotropic Directional Gabor Needle Sprays
      const dotY = fny;
      let tux = -dotY * fnx;
      let tuy = 1.0 - dotY * fny;
      let tuz = -dotY * fnz;
      const tuLen = Math.sqrt(tux * tux + tuy * tuy + tuz * tuz);
      if (tuLen > 0.001) {
        tux /= tuLen; tuy /= tuLen; tuz /= tuLen;
      } else {
        tux = 0.0; tuy = 1.0; tuz = 0.0;
      }
      // Transverse tangent vector (perpendicular to upward needle growth)
      const ttx = fny * tuz - fnz * tuy;
      const tty = fnz * tux - fnx * tuz;
      const ttz = fnx * tuy - fny * tux;

      // UV-aligned orthonormal tangent frame for glTF 2.0 Normal Mapping
      const du1 = u1 - u0, dv1 = v1 - v0;
      const du2 = u2 - u0, dv2 = v2 - v0;
      const rDet = du1 * dv2 - du2 * dv1;
      let uvTx = 1.0, uvTy = 0.0, uvTz = 0.0;
      let uvBx = 0.0, uvBy = 1.0, uvBz = 0.0;
      if (Math.abs(rDet) > 1e-8) {
        const inv = 1.0 / rDet;
        uvTx = ((v1x - v0x) * dv2 - (v2x - v0x) * dv1) * inv;
        uvTy = ((v1y - v0y) * dv2 - (v2y - v0y) * dv1) * inv;
        uvTz = ((v1z - v0z) * dv2 - (v2z - v0z) * dv1) * inv;
      }
      const dotNT = fnx * uvTx + fny * uvTy + fnz * uvTz;
      uvTx -= fnx * dotNT; uvTy -= fny * dotNT; uvTz -= fnz * dotNT;
      const tLen = Math.sqrt(uvTx * uvTx + uvTy * uvTy + uvTz * uvTz);
      if (tLen > 1e-6) {
        uvTx /= tLen; uvTy /= tLen; uvTz /= tLen;
      } else {
        uvTx = ttx; uvTy = tty; uvTz = ttz;
      }
      uvBx = fny * uvTz - fnz * uvTy;
      uvBy = fnz * uvTx - fnx * uvTz;
      uvBz = fnx * uvTy - fny * uvTx;
      const bLen = Math.sqrt(uvBx * uvBx + uvBy * uvBy + uvBz * uvBz) || 1.0;
      uvBx /= bLen; uvBy /= bLen; uvBz /= bLen;

      const minU = Math.min(u0, u1, u2), maxU = Math.max(u0, u1, u2);
      const minV = Math.min(v0, v1, v2), maxV = Math.max(v0, v1, v2);

      const minPx = Math.max(0, Math.floor(minU * (W - 1)));
      const maxPx = Math.min(W - 1, Math.ceil(maxU * (W - 1)));
      const minPy = Math.max(0, Math.floor(minV * (H - 1)));
      const maxPy = Math.min(H - 1, Math.ceil(maxV * (H - 1)));

      // 2D barycentric coordinate calculation
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(det) < 1e-9) continue;
      const invDet = 1.0 / det;

      for (let py = minPy; py <= maxPy; py++) {
        const v = py / (H - 1);
        for (let px = minPx; px <= maxPx; px++) {
          const u = px / (W - 1);

          const w1 = ((u - u0) * (v2 - v0) - (v - v0) * (u2 - u0)) * invDet;
          const w2 = ((u1 - u0) * (v - v0) - (v1 - v0) * (u - u0)) * invDet;
          const w0 = 1.0 - w1 - w2;

          if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;

          const pIdx = py * W + px;
          interiorMask[pIdx] = 1;
          totalTexelsProcessed++;

          // Continuous 3D world position
          const wx = w0 * v0x + w1 * v1x + w2 * v2x;
          const wy = w0 * v0y + w1 * v1y + w2 * v2y;
          const wz = w0 * v0z + w1 * v1z + w2 * v2z;

          const idx = pIdx * 4;
          const r = baseRgba[idx];
          const g = baseRgba[idx + 1];
          const b = baseRgba[idx + 2];
          const lVal = lum[pIdx];
          const gVal = grad[pIdx];

          const localGroundY = getGlobalGroundY(wx, wz);
          const heightAboveGround = Math.max(0.0, wy - localGroundY);

          // Spectral vegetation indices (Excess Green & Green Leaf Index)
          const exg = 2.0 * g - r - b;
          const gli = exg / (2.0 * g + r + b + 0.0001);
          const isVegetation = (g > r + 3) && (g > b + 3) && (g > 45) && (exg >= 8.0 || gli >= 0.03);

          // Multi-class foliage separation
          const isTurfGrass = isVegetation && (heightAboveGround < 0.35 || (absNy > 0.70 && heightAboveGround < 0.65));
          const isShrubBush = isVegetation && !isTurfGrass && (heightAboveGround < 2.50);
          const isTreeCanopy = isVegetation && !isTurfGrass && !isShrubBush;

          // Non-vegetation separation
          const isGroundRoad = !isVegetation && ((wy < localGroundY + 0.40) || (absNy > 0.75 && wy < localGroundY + 1.20));
          const isArchitecture = !isVegetation && !isGroundRoad;

          let rBase = r, gBase = g, bBase = b;
          let deltaR = 0.0, deltaG = 0.0, deltaB = 0.0;
          let matRoughness = 0.88;
          let matMetalness = 0.0; // Strict zero metalness for dielectrics
          let matAo = 1.0;
          let heightRelief = (lVal - 0.5) * 0.05; // SPLIT THE DIFFERENCE: Gentle macro relief instead of deep corrugated ruts
          let alphaVal = 255;

          if (isTurfGrass) {
            foliageCount++;
            meshFoliageCount++;
            turfGrassTexelsCount++;

            // Ground cover turf grass: strictly solid alpha, authentic photogrammetry color blend
            alphaVal = 255;

            // Pure zero-mean micro-contrast: preserves 100% of authentic photogrammetric green hue
            const grassBlade = (fastHash3D(Math.floor(wx * 90.0), Math.floor(wy * 90.0), Math.floor(wz * 90.0)) - 0.5) * 4.0;
            deltaR = grassBlade * 0.33;
            deltaG = grassBlade * 0.33;
            deltaB = grassBlade * 0.33;

            // Skyward soft normal (+Y world projected into tangent frame)
            const skyTx = ttx * 0 + tty * 1 + ttz * 0;
            const skyTy = tux * 0 + tuy * 1 + tuz * 0;
            const skyTz = fnx * 0 + fny * 1 + fnz * 0;
            let bx = 0.30 * skyTx;
            let by = 0.30 * skyTy;
            let bz = 0.70 + 0.30 * Math.max(0.2, skyTz);
            const bladeRelief = (hash3D(Math.floor(wx * 80.0), Math.floor(wy * 80.0), Math.floor(wz * 80.0)) - 0.5) * 0.4;
            bx += bladeRelief * 0.25;
            by += bladeRelief * 0.25;
            const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1.0;
            bentNormalMapX[pIdx] = bx / bLen;
            bentNormalMapY[pIdx] = by / bLen;
            bentNormalMapZ[pIdx] = bz / bLen;

            heightRelief = (grassBlade / 255.0) * 0.02;
            matRoughness = 0.90 + (hash3D(wx * 40.0, wy * 40.0, wz * 40.0) - 0.5) * 0.06;
            matAo = 0.92;
            matMetalness = 0.0;

          } else if (isShrubBush) {
            foliageCount++;
            meshFoliageCount++;
            shrubBushTexelsCount++;
            volumetricFoliageTexelsCount++;

            // Solid continuous shrub massing to avoid black cutout holes
            alphaVal = 255;
            const bushNoise = valueNoise3D(wx * 18.0, wy * 18.0, wz * 18.0);

            // Pure zero-mean micro-contrast: preserves 100% of authentic photogrammetric green hue
            const leafNoise = (hash3D(Math.floor(wx * 40.0), Math.floor(wy * 40.0), Math.floor(wz * 40.0)) - 0.5) * 4.0;
            deltaR = leafNoise * 0.33;
            deltaG = leafNoise * 0.33;
            deltaB = leafNoise * 0.33;

            // Hemispherical dome bent normal emanating from shrub base
            const bCentroidY = localGroundY;
            const srx = wx - tCentroidX;
            const srz = wz - tCentroidZ;
            const sry = Math.max(0.2, wy - bCentroidY);
            const srLen = Math.sqrt(srx * srx + sry * sry + srz * srz) || 1.0;
            const sbx = srx / srLen, sby = sry / srLen, sbz = srz / srLen;
            const srtx = sbx * ttx + sby * tty + sbz * ttz;
            const srty = sbx * tux + sby * tuy + sbz * tuz;
            const srtz = sbx * fnx + sby * fny + sbz * fnz;
            const wBentShrub = 0.50;
            let sbNormX = wBentShrub * srtx;
            let sbNormY = wBentShrub * srty;
            let sbNormZ = (1.0 - wBentShrub) + wBentShrub * Math.max(0.15, srtz);
            const sbLen = Math.sqrt(sbNormX * sbNormX + sbNormY * sbNormY + sbNormZ * sbNormZ) || 1.0;
            bentNormalMapX[pIdx] = sbNormX / sbLen;
            bentNormalMapY[pIdx] = sbNormY / sbLen;
            bentNormalMapZ[pIdx] = sbNormZ / sbLen;

            heightRelief = (bushNoise - 0.5) * 0.04;
            matRoughness = 0.78;
            const shrubDist = Math.sqrt(srx * srx + sry * sry + srz * srz);
            const shrubRho = Math.min(1.0, shrubDist / 1.8);
            matAo = 0.55 + 0.40 * shrubRho;
            matMetalness = 0.0;

          } else if (isTreeCanopy) {
            foliageCount++;
            meshFoliageCount++;
            treeCanopyTexelsCount++;
            volumetricFoliageTexelsCount++;

            // =======================================================================
            // LIVING FOLIAGE TRICK 2: UNDER-CANOPY BARK & BRANCH INVERSION
            // Downward facets (fny < -0.20): wooden trunks, bare twigs & branches
            // =======================================================================
            const isUnderside = fny < -0.20;
            if (isUnderside) {
              foliageUndersideCount++;
              // Retain authentic photogrammetric foliage tone with zero color bias
              rBase = r; gBase = g; bBase = b;
              deltaR = 0; deltaG = 0; deltaB = 0;

              heightRelief = 0.0;
              matRoughness = 0.90;
              matAo = 0.70;        // Gentle contact cavity shading without pitch black blotches
              matMetalness = 0.0;
              alphaVal = 255;      // Solid branch/trunk geometry under crown

              bentNormalMapX[pIdx] = 0;
              bentNormalMapY[pIdx] = 0;
              bentNormalMapZ[pIdx] = 1;
            } else {
              // Canopy Foliage (Upward and Side facets):

              // =======================================================================
              // PRIORITY 2: VOLUMETRIC CANOPY BENT NORMALS (AAA Foliage Technique)
              // Blend flat facet normal towards spherical/cylindrical vector emanating from tree trunk axis
              // =======================================================================
              const rx = wx - tCentroidX;
              const rz = wz - tCentroidZ;
              const ry = (wy - tCentroidY) * 0.45; // Subtle upward curvature on canopy dome
              const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
              const rCanopyX = rx / rLen;
              const rCanopyY = ry / rLen;
              const rCanopyZ = rz / rLen;

              // Project canopy radial vector into this triangle's orthonormal tangent frame:
              const rtx = rCanopyX * ttx + rCanopyY * tty + rCanopyZ * ttz;
              const rty = rCanopyX * tux + rCanopyY * tuy + rCanopyZ * tuz;
              const rtz = rCanopyX * fnx + rCanopyY * fny + rCanopyZ * fnz;

              // Blend flat normal [0, 0, 1] towards canopy normal with weight w = 0.62
              const wBent = 0.62;
              let bx = wBent * rtx;
              let by = wBent * rty;
              let bz = (1.0 - wBent) + wBent * Math.max(0.12, rtz);

              // =======================================================================
              // LIVING FOLIAGE TRICK 1: LEAF FLUTTER MICRO-NORMAL (5cm Voronoi Scintillation)
              // Randomized planar facets (~5cm scale, +/- 35 deg deviation)
              // Leaves flash & twinkle specular glints dynamically in the breeze as camera/sun moves!
              // =======================================================================
              const cellX = Math.floor(wx * 20.0), cellY = Math.floor(wy * 20.0), cellZ = Math.floor(wz * 20.0);
              const leafTiltX = (hash3D(cellX, cellY, cellZ) - 0.5) * 0.70;
              const leafTiltZ = (hash3D(cellX + 17, cellY + 31, cellZ + 71) - 0.5) * 0.70;
              foliageFlutterCount++;

              bx += leafTiltX * 0.60;
              bz += leafTiltZ * 0.60;
              const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1.0;
              bx /= bLen; by /= bLen; bz /= bLen;

              bentNormalMapX[pIdx] = bx;
              bentNormalMapY[pIdx] = by;
              bentNormalMapZ[pIdx] = bz;

              // ANISOTROPIC DIRECTIONAL GABOR FOLIAGE SYNTHESIZER
              const sParallel = wx * tux + wy * tuy + wz * tuz;
              const sTrans = wx * ttx + wy * tty + wz * ttz;

              // Multi-orientation Gabor filter bank (3 oriented components: 0 deg, +18 deg, -18 deg)
              const u0 = sParallel;
              const v0 = sTrans;
              const env0 = Math.max(0.0, Math.cos(u0 * 47.12)); // Fascicle length ~13 cm (7.5 Hz)
              const car0 = 0.5 + 0.5 * Math.cos(v0 * 314.16);   // Needle spacing ~2 cm (50 Hz)
              const g0 = env0 * env0 * car0;

              const u1 = sParallel * 0.951 - sTrans * 0.309;
              const v1 = sParallel * 0.309 + sTrans * 0.951;
              const env1 = Math.max(0.0, Math.cos(u1 * 47.12 + 1.2));
              const car1 = 0.5 + 0.5 * Math.cos(v1 * 314.16 + 0.8);
              const g1 = env1 * env1 * car1;

              const u2 = sParallel * 0.951 + sTrans * 0.309;
              const v2 = -sParallel * 0.309 + sTrans * 0.951;
              const env2 = Math.max(0.0, Math.cos(u2 * 47.12 + 2.4));
              const car2 = 0.5 + 0.5 * Math.cos(v2 * 314.16 + 1.6);
              const g2 = env2 * env2 * car2;

              const needleSpray = Math.max(g0, g1 * 0.92, g2 * 0.92);
              const needleTip = Math.sin(u0 * 47.12); // Fascicle tip vs base indicator

              // 1. 3D Cylindrical Needle Ridge Normals & Spine Striations
              const needleSpine = Math.cos(2.0 * Math.PI * 150.0 * sTrans);
              heightRelief = Math.pow(needleSpray, 1.35) * 0.15 + needleSpine * 0.018 * needleSpray;

              // =======================================================================
              // LIVING FOLIAGE TRICK 5: DUAL-ROUGHNESS CUTICLE STIPPLING
              // 25% Waxy cuticle blades (0.32) vs 75% Matte stems & crevices (0.88 - 0.92)
              // =======================================================================
              const cuticleNoise = hash3D(wx * 60.0, wy * 60.0, wz * 60.0);
              if (cuticleNoise > 0.72) {
                foliageWaxyCuticleCount++;
                matRoughness = 0.32; // Razor-sharp pin-prick specular glints off individual leaves
              } else {
                matRoughness = 0.88; // Matte stems and petioles
              }
              matMetalness = 0.0; // Strict zero metalness for dielectrics

              // =======================================================================
              // SLEIGHT 4: INVERTED VOLUMETRIC CORE DEPTH GRADIENT (CANOPY AO)
              // Replaces random procedural noise holes with continuous radial depth gradient:
              // rho = ||x_world - c_tree|| / R_canopy
              // Outer Envelope (rho in [0.75, 1.0]): Pure sunlit canopy, AO in [0.88, 1.00]
              // Mid-Canopy (rho in [0.45, 0.75]): Branch scaffolding, AO in [0.50, 0.85]
              // Inner Core (rho < 0.45): Deep, cavernous interior core, AO in [0.15, 0.25]
              // =======================================================================
              const distToTree = Math.sqrt((wx - tCentroidX) * (wx - tCentroidX) + (wy - tCentroidY) * (wy - tCentroidY) + (wz - tCentroidZ) * (wz - tCentroidZ));
              const rho = Math.min(1.0, Math.max(0.0, distToTree / tCanopyRadius));
              let canopyAo;
              if (rho < 0.45) {
                const t = rho / 0.45;
                canopyAo = 0.15 + 0.10 * t;
                matRoughness = Math.max(matRoughness, 0.92);
                foliageVoidCount++;
              } else if (rho < 0.75) {
                const t = (rho - 0.45) / 0.30;
                canopyAo = 0.50 + 0.35 * t;
              } else {
                const t = (rho - 0.75) / 0.25;
                canopyAo = 0.88 + 0.12 * t;
              }
              // Modulate subtly with needle micro-geometry (retaining fine surface relief without coarse polka-dots)
              matAo = Math.max(0.15, Math.min(1.0, canopyAo * 0.92 + 0.08 * needleSpray));

              // =======================================================================
              // AUTHENTIC FOLIAGE COLOR HARMONIZATION (100% Seamless Blend)
              // Zero hue shift, zero neon saturation boost. Preserves the exact photographic
              // Mediterranean green already present in the photogrammetry with subtle micro-contrast.
              // =======================================================================
              const needleContrast = (needleSpray - 0.5) * 4.0; // [-2.0, +2.0] micro-relief
              deltaR = needleContrast * 0.33;
              deltaG = needleContrast * 0.33;
              deltaB = needleContrast * 0.33;

              // =======================================================================
              // MICROSCOPIC CANOPY ALPHA POROSITY (Anisotropic Cellular Needle Slits)
              // 1. Radial Core Envelope Gating:
              //    - Inner core (rho < 0.55): 100% solid dense trunk & boughs (zero holes).
              //    - Outer mantle (rho >= 0.55 -> 1.0): porosity scales smoothly towards crown periphery.
              // 2. Downward Facet Wood Exclusion:
              //    - Under-canopy downward facets (fny < -0.15) remain 100% solid wood.
              // 3. Anisotropic Cellular Voronoi-Worley Lattice (28 Hz parallel x 70 Hz perpendicular):
              //    - Metric coordinates projected onto local branch tangent frame (sParallel, sTrans).
              //    - High-frequency 160 Hz micro-jiggle breaks grid alignment.
              //    - Yields microscopic interstitial air slits (1-3 texels / 1.0-2.5 cm physical scale).
              // 4. Anti-Bleed Green Invariant:
              //    - Perforated texels retain the exact surrounding foliage RGB to prevent dark edge fringing.
              // =======================================================================
              const envelopeGate = Math.max(0.0, Math.min(1.0, (rho - 0.55) / 0.38));
              if (envelopeGate > 0.02 && fny > -0.15) {
                // High-frequency turbulent micro-jiggle (160 Hz, ~6mm physical)
                const jx = Math.sin(wy * 160.0) * 0.003;
                const jy = Math.cos(wx * 160.0) * 0.003;

                // Anisotropic coordinates along local foliage branch tangent frame
                const sPara = sParallel + jx;
                const sPerp = sTrans + jy;

                // Cellular Voronoi lattice: 28 Hz along fascicle (~3.5cm), 70 Hz across needles (~1.4cm)
                const dCell = fastWorley3D(sPara * 28.0, sPerp * 70.0, wz * 42.0);

                // Dynamic threshold: opens up interstitial air gaps at the outer canopy envelope
                const poreThresh = 0.96 - 0.30 * envelopeGate;
                const isPore = (dCell > poreThresh) && (needleSpray < 0.75);

                if (isPore) {
                  alphaVal = 0;
                  meshPerforatedCount++;
                  perforatedFoliageCount++;
                } else {
                  alphaVal = 255;
                }
              } else {
                alphaVal = 255;
              }
            }
          } else if (isGroundRoad) {
            roadCount++;
            // BITUMEN ROAD / PAVEMENT MICRO-DETAIL & PBR
            const bitAgg = (valueNoise3D(wx * 40.0, wy * 40.0, wz * 40.0) - 0.5) * 16.0;
            const bitFine = (hash3D(wx * 110.0, wy * 110.0, wz * 110.0) - 0.5) * 10.0;
            const dL = bitAgg + bitFine;
            deltaR = dL;
            deltaG = dL;
            deltaB = dL;

            matRoughness = 0.48; // Smooth road / twilight wet sheen
            matMetalness = 0.0; // Strict zero metalness for dielectrics
            matAo = 0.94;
            heightRelief = (bitAgg / 255.0) * 0.06;

            bentNormalMapX[pIdx] = 0.0;
            bentNormalMapY[pIdx] = 0.0;
            bentNormalMapZ[pIdx] = 1.0;

          } else if (isArchitecture) {
            stoneCount++;
            const lapVal = laplacian[pIdx];

            // =======================================================================
            // PRIORITY 1: PHOTOGRAMMETRIC DE-LIGHTING & INVERSE SHADOW LIFT (SOTA PBR)
            // Decouple baked aerial cast shadows from diffuse travertine surface reflectance
            // =======================================================================
            // 1. Cast shadow detection via luminance and smoothstep curve
            const shadowT = Math.min(1.0, Math.max(0.0, (0.34 - lVal) / (0.34 - 0.08)));
            const shadowFactor = shadowT * shadowT * (3.0 - 2.0 * shadowT);

            if (shadowFactor > 0.01) {
              delightedStoneTexelsCount++;

              // 2. Inverse Diffuse Curve: multiplicative lift
              const gammaLift = 1.65;
              const liftMult = 1.0 + shadowFactor * gammaLift;
              const targetLum = Math.min(0.70, lVal * liftMult);

              // 3. Spectral Travertine Target Reconstruction
              // Warm Roman Travertine base reflectance ratio (from location-object-lighting skill)
              const rRef = 192.0, gRef = 180.0, bRef = 162.0;
              const lRef = (0.299 * rRef + 0.587 * gRef + 0.114 * bRef) / 255.0;
              const travR = rRef * (targetLum / lRef);
              const travG = gRef * (targetLum / lRef);
              const travB = bRef * (targetLum / lRef);

              const rawLiftR = r * liftMult;
              const rawLiftG = g * liftMult;
              const rawLiftB = b * liftMult;

              // 4. Bilateral blend towards warm travertine albedo
              const blendWeight = Math.min(1.0, shadowFactor * 0.90);
              let outR = (1.0 - blendWeight) * rawLiftR + blendWeight * travR;
              let outG = (1.0 - blendWeight) * rawLiftG + blendWeight * travG;
              let outB = (1.0 - blendWeight) * rawLiftB + blendWeight * travB;

              // 5. Skylight chromatic neutralization: strip cold Rayleigh scatter from deep shadows
              const skySpill = Math.max(0.0, outB - outR) * shadowFactor;
              outB -= skySpill * 0.95;
              outR += skySpill * 0.85;

              rBase = outR;
              gBase = outG;
              bBase = outB;

              // PBR Decoupling: transfer shadow depth into Ambient Occlusion map
              matAo *= (1.0 - shadowFactor * 0.28);
            }

            // 6. Highlight Compression on Overexposed Direct Sunlit Stone
            if (lVal > 0.80) {
              const highT = Math.min(1.0, (lVal - 0.80) / 0.18);
              const compress = highT * highT * 0.14;
              rBase *= (1.0 - compress);
              gBase *= (1.0 - compress * 0.95);
              bBase *= (1.0 - compress * 0.85);
            }

            // =======================================================================
            // STEP 1: 5-WAY MORPHOLOGICAL TENSOR & DIFFERENTIAL GEOMETRY
            // SPLIT THE DIFFERENCE: Moderated intensity for authentic Roman travertine
            // =======================================================================

            // 1. Gravity Dot-Product Alignment (N · g where g = [0, -1, 0] -> -fny)
            const isSoffit = (fny < -0.32); // Archway ceiling vault, arcade underhang
            const isSill = (fny > 0.60);   // Horizontal sill, cornice top shelf, terrace step
            const isVerticalWall = (Math.abs(fny) <= 0.45);

            // 2. In-plane curvature: Convex Ridge vs Concave Crevice
            const isRidge = (!isSoffit && ((lapVal < -0.030 && lVal > 0.46) || (gVal > 6.0 && lapVal < -0.020)));
            const isCrevice = (gVal > 6.0 || lapVal > 0.040);

            // Morphological Modulation (Split the difference):
            if (isSoffit) {
              // DOWNWARD SOFFITS & ARCH VAULTS: Sheltered from rain -> dark atmospheric gypsum soot crust
              soffitTexelsCount++;
              const sootFactor = Math.min(1.0, (-fny - 0.32) / 0.55);
              const sootDarken = 13.0 * sootFactor; // Split the difference (was 26.0)
              deltaR -= sootDarken * 0.95;
              deltaG -= sootDarken * 1.00;
              deltaB -= sootDarken * 1.05; // cool acoustic soot tone
              matAo *= (1.0 - 0.16 * sootFactor); // Split the difference (was 0.32)
              matRoughness = Math.min(0.94, matRoughness + 0.04 * sootFactor);
              heightRelief -= (sootDarken / 255.0) * 0.04;

            } else if (isSill) {
              // UPWARD HORIZONTAL SILLS & CORNICE SHELVES: Rain impact + dust settling + solar bleaching
              sillTexelsCount++;
              const sillFactor = Math.min(1.0, (fny - 0.60) / 0.35);
              deltaR += 7.0 * sillFactor; // Split the difference (was 14.0)
              deltaG += 6.0 * sillFactor; // was 12.0
              deltaB += 4.0 * sillFactor; // was 8.0
              matAo = 1.0;
              matRoughness = 0.82;

            } else if (isRidge) {
              // CONVEX CORNICE MOLDINGS & COLUMN FLUTE RIDGES: Contact polish & wind-scour burnish
              ridgeTexelsCount++;
              matRoughness = Math.max(0.68, matRoughness - 0.12); // Split the difference (was 0.60 / -0.24)
              heightRelief += 0.02; // was 0.04
              matAo = 1.0;

            } else if (isCrevice) {
              // CONCAVE CREVICES, MORTAR JOINTS & ROBBED CLAMP HOLES: Deep grit & shadow
              // SPLIT THE DIFFERENCE: Moderated darkening and relief so stone looks like real ashlar, not tire tread
              creviceTexelsCount++;
              const jointDarken = Math.min(14.0, Math.max(0.0, gVal - 6.0) * 0.45 + Math.max(0.0, lapVal) * 50.0); // was 30.0 / 0.95 / 110.0
              deltaR -= jointDarken;
              deltaG -= jointDarken * 0.95;
              deltaB -= jointDarken * 0.85;
              matAo -= Math.min(0.18, jointDarken / 90.0); // was 0.38 / 60.0
              heightRelief -= (jointDarken / 255.0) * 0.07; // was 0.16
              matRoughness = Math.min(0.92, matRoughness + 0.04);
            }

            // High-Resolution Travertine Cavitation Pores (excluded on polished ridges)
            // SPLIT THE DIFFERENCE: soft subtle pores instead of harsh pits
            if (!isRidge) {
              const poreVal = valueNoise3D(wx * 22.0, wy * 22.0, wz * 22.0);
              if (poreVal < 0.22) {
                const porePits = Math.pow((0.22 - poreVal) / 0.22, 2.0) * 22.0; // was 46.0
                deltaR -= porePits;
                deltaG -= porePits * 0.92;
                deltaB -= porePits * 0.80;
                matRoughness = Math.min(0.92, matRoughness + 0.025);
                heightRelief -= (porePits / 255.0) * 0.05; // was 0.12
              }
            }

            // Calcite Mineral Grain & Bedding Strata
            // SPLIT THE DIFFERENCE: gentle natural mineral variation
            const calciteGrain = (fbm3D(wx * 28.0, wy * 28.0, wz * 28.0, 3) - 0.5) * 12.0; // was 24.0
            const fineGrain = (hash3D(wx * 85.0, wy * 85.0, wz * 85.0) - 0.5) * 5.0; // was 10.0
            const strata = Math.sin(wy * 18.0) * 0.5 + 0.5;
            const strataDarken = strata > 0.65 ? (strata - 0.65) * 6.0 : 0.0; // was 12.0

            const deltaL = calciteGrain + fineGrain - strataDarken;
            deltaR += deltaL;
            deltaG += deltaL * 0.93;
            deltaB += deltaL * 0.82;
            heightRelief += (calciteGrain / 255.0) * 0.03; // was 0.06

            // =======================================================================
            // STEP 1b: TACTILE MICRO-RELIEF, CALCITE PITTING & CHISEL TOOTH MARKS
            // =======================================================================
            // 1. Calcite Crystalline Pitting (F2 - F1 Worley Micro-Noise at 180 Hz)
            const worleyCav = fastWorleyF1F2_3D(wx * 180.0, wy * 180.0, wz * 180.0);
            const cavitationMicro = Math.max(0.0, Math.min(1.0, (worleyCav.diff - 0.15) / 0.35));
            heightRelief -= cavitationMicro * 0.022; // micro-pits indent into stone surface
            if (cavitationMicro > 0.35) calcitePitsTexelsCount++;

            // 2. Roman Chisel Tooth Marks (Gradina Scratches at 85 Hz)
            if (isVerticalWall && !isSoffit) {
              gradinaChiselTexelsCount++;
              const chiselTooth = 0.5 + 0.5 * Math.sin(2.0 * Math.PI * 85.0 * (wx * ttx + wz * ttz)) * (valueNoise3D(wx * 2.0, wy * 12.0, wz * 2.0) * 0.7 + 0.3);
              heightRelief += (chiselTooth - 0.5) * 0.012;
            }

            // 3. Roughness: Micro-Peak Burnish vs Micro-Valley Dust Inversion
            if (heightRelief > 0.015) {
              const peakBurnish = Math.min(1.0, (heightRelief - 0.015) / 0.04);
              matRoughness = Math.max(0.58, matRoughness - 0.12 * peakBurnish);
            }
            if (cavitationMicro > 0.35) {
              matRoughness = Math.min(0.98, Math.max(matRoughness, 0.92 + 0.06 * cavitationMicro));
            }

            // 4. Capillary Salt Efflorescence (3.5 Hz)
            const saltEfflorescence = fastWorley3D(wx * 3.5, wy * 3.5, wz * 3.5);
            if (saltEfflorescence < 0.20 && (isSill || isVerticalWall)) {
              const saltFactor = (0.20 - saltEfflorescence) / 0.20;
              matRoughness = Math.max(matRoughness, 0.90 + 0.04 * saltFactor);
              deltaR += 4.0 * saltFactor;
              deltaG += 4.0 * saltFactor;
              deltaB += 4.0 * saltFactor;
            }

            // 5. Specular Cavity Masking & Mortar Joint Gritty Grain Occlusion
            if (cavitationMicro > 0.18) {
              matAo *= (1.0 - cavitationMicro * 0.60); // Drops AO to 0.25 - 0.40 inside deep cavities
            }
            if (isCrevice || lapVal > 0.040) {
              const sandGrainStipple = hash3D(wx * 120.0, wy * 120.0, wz * 120.0);
              matAo *= (1.0 - (0.16 + 0.14 * sandGrainStipple));
            }

            // 6. Albedo Sub-Pixel Texture Detail:
            // Calcite Mineral Flecks (1 in 400 sub-pixel sparkle inclusions)
            const fleckHash = fastHash3D(Math.floor(wx * 350.0), Math.floor(wy * 350.0), Math.floor(wz * 350.0));
            if (fleckHash > 0.9975) {
              mineralFlecksTexelsCount++;
              deltaR += 18.0;
              deltaG += 16.0;
              deltaB += 12.0;
            }
            // Biogenic Endolithic Micro-Patina (damp sheltered north-facing crevices)
            if (lapVal > 0.045 && matAo < 0.68 && fnz < 0.0) {
              deltaR -= 8.0;
              deltaG += 4.0;
              deltaB -= 12.0;
            }
            // Historical Robber Clamp Holes (Iron Rust Staining)
            if (isVerticalWall && (cavitationMicro > 0.65 || (isCrevice && gVal > 14.0))) {
              const rustBleed = valueNoise3D(wx * 8.0, wy * 8.0, wz * 8.0);
              if (rustBleed > 0.50) {
                const rustT = (rustBleed - 0.50) / 0.50;
                deltaR += 14.0 * rustT;
                deltaG += 4.0 * rustT;
                deltaB -= 10.0 * rustT;
              }
            }

            // =======================================================================
            // STEP 2: PHYSICAL WEATHERING VECTOR FIELD & GRAVITY DRAINAGE
            // =======================================================================

            // 1. Gravity Rainwash Drip Tracing (Vertical wall drainage along -Y)
            if (isVerticalWall && !isSoffit) {
              const rainDrip = valueNoise3D(wx * 20.0, wy * 3.2, wz * 20.0);
              if (rainDrip < 0.24) {
                rainwashTexelsCount++;
                const streakStr = Math.pow((0.24 - rainDrip) / 0.24, 1.6) * 9.0; // was 18.0
                deltaR -= streakStr * 0.90;
                deltaG -= streakStr * 0.95;
                deltaB -= streakStr * 1.05; // cool soot wash tint
                matRoughness = Math.min(0.92, matRoughness + 0.02);
                matAo *= (1.0 - (streakStr / 255.0) * 0.35); // was 0.75
              }
            }

            // 2. Directional Solar Limonite Oxidation vs Shaded Moisture Field
            if (fnz > 0.18) {
              // South/Southwest Sun-Facing Facade: 2,000 years of Mediterranean solar oxidation of trace iron (limonite)
              solarOxidationTexelsCount++;
              const sunOxidation = Math.min(1.0, (fnz - 0.18) / 0.70) * 7.0; // was 14.0
              deltaR += sunOxidation * 1.05;
              deltaG += sunOxidation * 0.75;
              deltaB -= sunOxidation * 0.25; // golden warm limonite shift
            } else if (fnz < -0.18) {
              // North/Northeast Shaded Facades: damp micro-environment with subtle mineral patina
              const northShade = Math.min(1.0, (-fnz - 0.18) / 0.70) * 4.0; // was 8.0
              deltaR -= northShade * 0.35;
              deltaG += northShade * 0.12;
              deltaB += northShade * 0.08;
            }

            matRoughness = Math.min(0.94, Math.max(0.62, matRoughness + (1.0 - matAo) * 0.05));
            matMetalness = 0.0; // Strict zero metalness for dielectrics

            // =======================================================================
            // PHASE 3: 5mm VIRTUAL SPECULAR BEVEL & CURVATURE ANTI-FACETING NORMAL
            // =======================================================================
            let bnx = fnx, bny = fny, bnz = fnz;
            const sharpEdges = triSharpEdges[t];
            let minBevelDist = Infinity;
            let bestChamfer = null;

            if (sharpEdges && sharpEdges.length > 0) {
              for (let e = 0; e < sharpEdges.length; e++) {
                const ed = sharpEdges[e];
                const d = distToSegment(wx, wy, wz, ed.p0, ed.p1);
                if (d < minBevelDist) {
                  minBevelDist = d;
                  bestChamfer = ed.chamfer;
                }
              }
            }

            const maxBevelDist = 0.005; // 5 mm metric bevel zone
            if (minBevelDist <= maxBevelDist && bestChamfer) {
              virtualBevelTexelsCount++;
              const u = minBevelDist / maxBevelDist;
              // Smooth cosine profile: 1.0 at edge down to 0.0 at 5mm
              const wBevel = 0.5 * (1.0 + Math.cos(Math.PI * u));
              bnx = (1.0 - wBevel) * fnx + wBevel * bestChamfer.x;
              bny = (1.0 - wBevel) * fny + wBevel * bestChamfer.y;
              bnz = (1.0 - wBevel) * fnz + wBevel * bestChamfer.z;
              const bLen = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz) || 1.0;
              bnx /= bLen; bny /= bLen; bnz /= bLen;

              // Specular edge burnish: slightly lower roughness along edge to catch sharp specular glints
              matRoughness = Math.max(0.48, matRoughness - 0.08 * wBevel);
              matAo = Math.min(1.0, Math.max(matAo, 0.90 + 0.10 * wBevel));
            } else if (triIsCurved[t]) {
              antiFacetingTexelsCount++;
              const tf = submeshTriFrames[t];
              const sn0 = vertexSmoothNormals.get(tf.k0) || { x: fnx, y: fny, z: fnz };
              const sn1 = vertexSmoothNormals.get(tf.k1) || { x: fnx, y: fny, z: fnz };
              const sn2 = vertexSmoothNormals.get(tf.k2) || { x: fnx, y: fny, z: fnz };

              let sx = w0 * sn0.x + w1 * sn1.x + w2 * sn2.x;
              let sy = w0 * sn0.y + w1 * sn1.y + w2 * sn2.y;
              let sz = w0 * sn0.z + w1 * sn1.z + w2 * sn2.z;
              const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1.0;
              bnx = sx / sLen; bny = sy / sLen; bnz = sz / sLen;
            }

            // Project world normal into the triangle's UV tangent frame
            let tnx = bnx * uvTx + bny * uvTy + bnz * uvTz;
            let tny = bnx * uvBx + bny * uvBy + bnz * uvBz;
            let tnz = bnx * fnx + bny * fny + bnz * fnz;
            const tLen = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz) || 1.0;
            tnx /= tLen; tny /= tLen; tnz /= tLen;

            bentNormalMapX[pIdx] = tnx;
            bentNormalMapY[pIdx] = tny;
            bentNormalMapZ[pIdx] = tnz;
          }

          outAlbedoRgba[idx] = Math.max(0, Math.min(255, Math.round(rBase + deltaR)));
          outAlbedoRgba[idx + 1] = Math.max(0, Math.min(255, Math.round(gBase + deltaG)));
          outAlbedoRgba[idx + 2] = Math.max(0, Math.min(255, Math.round(bBase + deltaB)));
          outAlbedoRgba[idx + 3] = alphaVal;

          normalOffsetMap[pIdx] = heightRelief;
          roughnessMap[pIdx] = matRoughness;
          metalnessMap[pIdx] = matMetalness;
          aoMap[pIdx] = matAo;
        }
      }
    }

    // Step 2: Conservative UV Gutter Dilation (3-pixel border bleed to prevent mipmap seams)
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const pIdx = py * W + px;
        if (interiorMask[pIdx] === 0) {
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
                outAlbedoRgba[dstIdx] = outAlbedoRgba[srcIdx];
                outAlbedoRgba[dstIdx + 1] = outAlbedoRgba[srcIdx + 1];
                outAlbedoRgba[dstIdx + 2] = outAlbedoRgba[srcIdx + 2];
                outAlbedoRgba[dstIdx + 3] = outAlbedoRgba[srcIdx + 3];

                normalOffsetMap[pIdx] = normalOffsetMap[nIdx];
                roughnessMap[pIdx] = roughnessMap[nIdx];
                metalnessMap[pIdx] = metalnessMap[nIdx];
                aoMap[pIdx] = aoMap[nIdx];
                bentNormalMapX[pIdx] = bentNormalMapX[nIdx];
                bentNormalMapY[pIdx] = bentNormalMapY[nIdx];
                bentNormalMapZ[pIdx] = bentNormalMapZ[nIdx];
                found = true;
              }
            }
          }
        }
      }
    }

    // Step 2b: Smooth normal height field (Gaussian 3x3)
    const smoothedOffsetMap = new Float32Array(W * H);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        let sum = 0;
        let wSum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.max(0, Math.min(H - 1, py + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(0, Math.min(W - 1, px + dx));
            const w = (dx === 0 && dy === 0) ? 4 : ((dx === 0 || dy === 0) ? 2 : 1);
            sum += normalOffsetMap[ny * W + nx] * w;
            wSum += w;
          }
        }
        smoothedOffsetMap[py * W + px] = sum / wSum;
      }
    }

    // Step 3: Compute Multi-Frequency Scharr Tangent-Space Normal Map & Reoriented Normal Mapping (RNM)
    const bumpStrength = 0.40; // SPLIT THE DIFFERENCE: Natural, subtle stone bump without harsh corrugation
    const normX = new Float32Array(W * H);
    const normY = new Float32Array(W * H);
    const normZ = new Float32Array(W * H);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const pIdx = py * W + px;
        const xL = Math.max(0, px - 1);
        const xR = Math.min(W - 1, px + 1);
        const yT = Math.max(0, py - 1);
        const yB = Math.min(H - 1, py + 1);

        // 3x3 Scharr filter on smoothed height relief
        const tl = smoothedOffsetMap[yT * W + xL];
        const tc = smoothedOffsetMap[yT * W + px];
        const tr = smoothedOffsetMap[yT * W + xR];
        const cl = smoothedOffsetMap[py * W + xL];
        const cr = smoothedOffsetMap[py * W + xR];
        const bl = smoothedOffsetMap[yB * W + xL];
        const bc = smoothedOffsetMap[yB * W + px];
        const br = smoothedOffsetMap[yB * W + xR];

        const dx = (tr * 3.0 + cr * 10.0 + br * 3.0) - (tl * 3.0 + cl * 10.0 + bl * 3.0);
        const dy = (bl * 3.0 + bc * 10.0 + br * 3.0) - (tl * 3.0 + tc * 10.0 + tr * 3.0);

        // Relief micro-normal from Scharr gradient
        const rx = -dx * bumpStrength;
        const ry = -dy * bumpStrength;
        const rz = 1.0;
        const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
        const n1x = rx / rLen, n1y = ry / rLen, n1z = rz / rLen;

        // Base normal (bentNormalMap for foliage and bevel/anti-faceting stone, [0, 0, 1] fallback)
        let n2x = bentNormalMapX[pIdx];
        let n2y = bentNormalMapY[pIdx];
        let n2z = bentNormalMapZ[pIdx];
        if (n2x === 0.0 && n2y === 0.0 && n2z === 0.0) {
          n2z = 1.0;
        }

        // Reoriented Normal Mapping (RNM) blending:
        // t = n2 + (0, 0, 1)
        // u = (-n1x, -n1y, n1z)
        // n = t * (t . u) / t.z - u
        const tx = n2x, ty = n2y, tz = n2z + 1.0;
        const tDotU = tx * (-n1x) + ty * (-n1y) + tz * n1z;
        let nx = tx * (tDotU / tz) - (-n1x);
        let ny = ty * (tDotU / tz) - (-n1y);
        let nz = tz * (tDotU / tz) - n1z;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
        nx /= len; ny /= len; nz /= len;

        normX[pIdx] = nx;
        normY[pIdx] = ny;
        normZ[pIdx] = nz;

        const dstIdx = pIdx * 4;
        // Normal Map: R, G, B in [0..255]
        outNormalRgba[dstIdx] = Math.round((nx * 0.5 + 0.5) * 255);
        outNormalRgba[dstIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        outNormalRgba[dstIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        outNormalRgba[dstIdx + 3] = 255;
      }
    }

    // =======================================================================
    // STEP 3b: TOKSVIG / LEADR MICRO-NORMAL VARIANCE COUPLING (AAA Specular Anti-Aliasing)
    // σ² = 1.0 - ||n̄||, Roughness_effective = sqrt(Roughness² + κ * σ²)
    // Disperses specular highlights in micro-cavities & needles to kill specular sparkles
    // =======================================================================
    const kappa = 0.40;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const pIdx = py * W + px;
        let sumNx = 0, sumNy = 0, sumNz = 0, wSum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.max(0, Math.min(H - 1, py + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.max(0, Math.min(W - 1, px + dx));
            const nIdx = ny * W + nx;
            const w = (dx === 0 && dy === 0) ? 4 : ((dx === 0 || dy === 0) ? 2 : 1);
            sumNx += normX[nIdx] * w;
            sumNy += normY[nIdx] * w;
            sumNz += normZ[nIdx] * w;
            wSum += w;
          }
        }
        const avgNx = sumNx / wSum;
        const avgNy = sumNy / wSum;
        const avgNz = sumNz / wSum;
        const meanLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy + avgNz * avgNz);
        const variance = Math.max(0.0, 1.0 - meanLen);
        if (variance > 0.005) toksvigCoupledTexelsCount++;

        const baseRough = roughnessMap[pIdx];
        const effectiveRough = Math.min(1.0, Math.sqrt(baseRough * baseRough + kappa * variance));
        roughnessMap[pIdx] = effectiveRough;

        const dstIdx = pIdx * 4;
        // Pack into ORM map: Red = AO, Green = Effective Roughness, Blue = Metalness (Strict 0.0)
        outOrmRgba[dstIdx] = Math.round(aoMap[pIdx] * 255);
        outOrmRgba[dstIdx + 1] = Math.round(effectiveRough * 255);
        outOrmRgba[dstIdx + 2] = 0; // Strict zero metalness for dielectrics
        outOrmRgba[dstIdx + 3] = 255;
      }
    }

    // Step 4: High-efficiency selective compression (PNG for foliage submeshes, JPEG for pure stone)
    const hasFoliage = meshFoliageCount > 200;
    albedoIsPng.push(hasFoliage);
    let albedoImg;
    if (hasFoliage) {
      albedoImg = await encodePng(outAlbedoRgba, W, H);
    } else {
      albedoImg = await encodeJpeg(outAlbedoRgba, W, H, 3);
    }
    const normalJpeg = await encodeJpeg(outNormalRgba, W, H, 3);
    const ormJpeg = await encodeJpeg(outOrmRgba, W, H, 3);

    albedoImages.push(albedoImg);
    normalJpegs.push(normalJpeg);
    ormJpegs.push(ormJpeg);

    // Save hero inspection textures for Mesh 39 (Hero Stone Facade)
    if (meshIdx === 39) {
      console.log(`\nExporting 1K Hero Inspection Suite for Mesh 39...`);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_stone_texture_39_1k_albedo.jpg'), albedoImg);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_stone_texture_39_1k_normal.jpg'), normalJpeg);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_stone_texture_39_1k_orm.jpg'), ormJpeg);

      // Also create dedicated grayscale visualizations for 2D Loupe inspector
      const roughMono = Buffer.alloc(W * H * 4);
      const aoMono = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        const rVal = Math.round(roughnessMap[i] * 255);
        const aVal = Math.round(aoMap[i] * 255);
        const d = i * 4;
        roughMono[d] = rVal; roughMono[d + 1] = rVal; roughMono[d + 2] = rVal; roughMono[d + 3] = 255;
        aoMono[d] = aVal; aoMono[d + 1] = aVal; aoMono[d + 2] = aVal; aoMono[d + 3] = 255;
      }
      const roughJpeg = await encodeJpeg(roughMono, W, H, 3);
      const aoJpeg = await encodeJpeg(aoMono, W, H, 3);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_stone_texture_39_1k_roughness.jpg'), roughJpeg);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_stone_texture_39_1k_ao.jpg'), aoJpeg);
    }

    // Save hero foliage inspection textures for first dense foliage mesh
    if (hasFoliage && !exportedFoliageHero && meshFoliageCount > 3000) {
      exportedFoliageHero = true;
      console.log(`\nExporting 1K Hero Foliage Inspection Suite for Mesh ${meshIdx} (${meshFoliageCount.toLocaleString()} foliage texels, ${meshPerforatedCount.toLocaleString()} micro-pores, color-harmonized)...`);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_foliage_texture_hero_1k_albedo.png'), albedoImg);
      const alphaMono = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        const aVal = outAlbedoRgba[i * 4 + 3];
        const d = i * 4;
        alphaMono[d] = aVal; alphaMono[d + 1] = aVal; alphaMono[d + 2] = aVal; alphaMono[d + 3] = 255;
      }
      const alphaJpeg = await encodeJpeg(alphaMono, W, H, 3);
      fs.writeFileSync(path.resolve(__dirname, '../public/models/colosseum_foliage_texture_hero_1k_alpha.jpg'), alphaJpeg);
    }

    const elapsed = Date.now() - meshStartTime;
    if ((meshIdx + 1) % 10 === 0 || meshIdx === numMeshes - 1) {
      const imgType = hasFoliage ? 'PNG(Alpha)' : 'JPEG';
      console.log(`[Mesh ${meshIdx + 1}/${numMeshes}] 1K PBR synthesized [${imgType}]: Albedo ${(albedoImg.length / 1024).toFixed(1)}KB, Normal ${(normalJpeg.length / 1024).toFixed(1)}KB, ORM ${(ormJpeg.length / 1024).toFixed(1)}KB (${elapsed}ms)`);
    }
  }

  console.log('\n--- Colosseum Material Classification Summary ---');
  console.log(`Total Triangles: ${totalTrianglesProcessed.toLocaleString()}`);
  console.log(`Total Texels Analyzed: ${totalTexelsProcessed.toLocaleString()}`);
  console.log(`Roman Travertine Stone: ${stoneCount.toLocaleString()} (${(stoneCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Vegetation Total: ${foliageCount.toLocaleString()} (${(foliageCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`  ├─ 1. Turf Grass / Meadow: ${turfGrassTexelsCount.toLocaleString()} (${(turfGrassTexelsCount / (foliageCount || 1) * 100).toFixed(1)}% of veg - 100% solid, skyward +Y normal)`);
  console.log(`  ├─ 2. Bushes & Shrubs / Hedges: ${shrubBushTexelsCount.toLocaleString()} (${(shrubBushTexelsCount / (foliageCount || 1) * 100).toFixed(1)}% of veg - hemispherical dome normal)`);
  console.log(`  └─ 3. Overstory Tree Canopy: ${treeCanopyTexelsCount.toLocaleString()} (${(treeCanopyTexelsCount / (foliageCount || 1) * 100).toFixed(1)}% of veg - microscopic cellular pores, volumetric bent normals, harmonized color)`);
  console.log(`Perimeter Bitumen Roads: ${roadCount.toLocaleString()} (${(roadCount / totalTexelsProcessed * 100).toFixed(1)}%)`);

  console.log('\n--- Step 1 & 2: Morphological Tensor & Weathering Telemetry ---');
  console.log(`Downward Arch Soffits / Vaults (Gypsum Soot): ${soffitTexelsCount.toLocaleString()} (${(soffitTexelsCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Upward Sills & Cornice Shelves (Bleached/Dust): ${sillTexelsCount.toLocaleString()} (${(sillTexelsCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Convex Moldings & Burnished Ridges: ${ridgeTexelsCount.toLocaleString()} (${(ridgeTexelsCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Concave Crevices & Mortar Joints: ${creviceTexelsCount.toLocaleString()} (${(creviceTexelsCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`Gravity Rainwash Drip Streaks: ${rainwashTexelsCount.toLocaleString()} (${(rainwashTexelsCount / totalTexelsProcessed * 100).toFixed(1)}%)`);
  console.log(`South-Facing Solar Limonite Oxidation: ${solarOxidationTexelsCount.toLocaleString()} (${(solarOxidationTexelsCount / totalTexelsProcessed * 100).toFixed(1)}%)`);

  // Step 5: Repack into Standard Binary glTF 2.0 (.glb) with Full Lit PBR Shaders
  console.log('\nRepacking all 79 meshes with standard PBR material channels (Albedo + Normal + ORM)...');

  const newBufferViews = gltf.bufferViews.slice(0, geomBvCount);
  const newBufferChunks = [binBuffer.subarray(0, geomEndOffset)];
  let currentOffset = geomEndOffset;

  function appendBufferChunk(chunk) {
    const pad = (4 - (chunk.length % 4)) % 4;
    const finalChunk = pad > 0 ? Buffer.concat([chunk, Buffer.alloc(pad)]) : chunk;
    const bvIdx = newBufferViews.length;
    newBufferViews.push({
      buffer: 0,
      byteOffset: currentOffset,
      byteLength: chunk.length
    });
    newBufferChunks.push(finalChunk);
    currentOffset += finalChunk.length;
    return bvIdx;
  }

  const newImages = [];
  const newTextures = [];

  // Append Albedo textures (image/png with alpha for foliage, image/jpeg for stone)
  const albedoTexIndices = [];
  for (let i = 0; i < numMeshes; i++) {
    const isPng = albedoIsPng[i];
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    const bvIdx = appendBufferChunk(albedoImages[i]);
    const imgIdx = newImages.length;
    newImages.push({ mimeType, bufferView: bvIdx });
    const texIdx = newTextures.length;
    newTextures.push({ source: imgIdx });
    albedoTexIndices.push(texIdx);
  }

  // Append Normal textures
  const normalTexIndices = [];
  for (let i = 0; i < numMeshes; i++) {
    const bvIdx = appendBufferChunk(normalJpegs[i]);
    const imgIdx = newImages.length;
    newImages.push({ mimeType: 'image/jpeg', bufferView: bvIdx });
    const texIdx = newTextures.length;
    newTextures.push({ source: imgIdx });
    normalTexIndices.push(texIdx);
  }

  // Append ORM textures
  const ormTexIndices = [];
  for (let i = 0; i < numMeshes; i++) {
    const bvIdx = appendBufferChunk(ormJpegs[i]);
    const imgIdx = newImages.length;
    newImages.push({ mimeType: 'image/jpeg', bufferView: bvIdx });
    const texIdx = newTextures.length;
    newTextures.push({ source: imgIdx });
    ormTexIndices.push(texIdx);
  }

  // Create Standard PBR Materials (without KHR_materials_unlit!)
  const newMaterials = [];
  for (let i = 0; i < numMeshes; i++) {
    const isFoliage = albedoIsPng[i];
    const matDef = {
      name: `Colosseum_1K_PBR_Material_${i}`,
      pbrMetallicRoughness: {
        baseColorTexture: { index: albedoTexIndices[i] },
        metallicRoughnessTexture: { index: ormTexIndices[i] },
        metallicFactor: 1.0,
        roughnessFactor: 1.0
      },
      normalTexture: {
        index: normalTexIndices[i],
        scale: 1.0
      },
      occlusionTexture: {
        index: ormTexIndices[i],
        strength: 1.0
      },
      doubleSided: true
    };
    if (isFoliage) {
      matDef.alphaMode = 'MASK';
      matDef.alphaCutoff = 0.5;
    }
    newMaterials.push(matDef);
  }

  // Assign materials to meshes
  for (let i = 0; i < numMeshes; i++) {
    gltf.meshes[i].primitives[0].material = i;
  }

  gltf.bufferViews = newBufferViews;
  gltf.images = newImages;
  gltf.textures = newTextures;
  gltf.materials = newMaterials;
  gltf.buffers[0].byteLength = currentOffset;

  // Remove KHR_materials_unlit
  if (gltf.extensionsUsed) {
    gltf.extensionsUsed = gltf.extensionsUsed.filter(e => e !== 'KHR_materials_unlit');
  }
  if (gltf.extensionsRequired) {
    gltf.extensionsRequired = gltf.extensionsRequired.filter(e => e !== 'KHR_materials_unlit');
  }

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
  const outPath = path.resolve(__dirname, '../public/models/colosseum_rome_1k_pbr.glb');
  fs.writeFileSync(outPath, finalGlb);
  const uncompressedSizeMb = (finalGlb.length / (1024 * 1024)).toFixed(2);

  // Step 6: Automated WebP Recompression with EXT_texture_webp
  console.log('\nRunning Automated Texture Compression Engine (WebP + EXT_texture_webp)...');
  let finalFileSizeBytes = finalGlb.length;
  try {
    const compMod = await import('../packages/core/dist/node/texture-compression-service.js');
    const TextureCompressionService = compMod.TextureCompressionService || compMod.default?.TextureCompressionService;
    const { stats: compressStats } = await TextureCompressionService.compressGlbFile(outPath, outPath);
    finalFileSizeBytes = compressStats.compressedGlbBytes;
    console.log(`[WebP Compression Complete] ${compressStats.compressedTextureCount}/${compressStats.totalTexturesProcessed} textures compressed`);
    console.log(`  Uncompressed: ${uncompressedSizeMb} MB -> Compacted WebP: ${(finalFileSizeBytes / (1024 * 1024)).toFixed(2)} MB (${compressStats.spaceSavingsPercent.toFixed(1)}% savings)`);
  } catch (compErr) {
    console.warn('WebP compression warning:', compErr.message);
  }

  const totalSecs = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n========================================================================`);
  console.log(`=== SUCCESS: 1K PBR Suite Synthesized across All ${numMeshes} Submeshes ===`);
  console.log(`Output Path: ${outPath}`);
  console.log(`Output File Size: ${(finalFileSizeBytes / (1024 * 1024)).toFixed(2)} MB (WebP compacted)`);
  console.log(`Total Execution Time: ${totalSecs}s`);
  console.log(`De-Lighted Stone Texels: ${delightedStoneTexelsCount.toLocaleString()}`);
  console.log(`Volumetric Foliage Bent Normal Texels: ${volumetricFoliageTexelsCount.toLocaleString()}`);
  console.log(`Living Foliage - Under-Canopy Bark Inversion: ${foliageUndersideCount.toLocaleString()}`);
  console.log(`Living Foliage - Leaf Flutter Voronoi Normal Texels: ${foliageFlutterCount.toLocaleString()}`);
  console.log(`Living Foliage - Backlit Chlorophyll Rim Texels: ${foliageChlorophyllRimCount.toLocaleString()}`);
  console.log(`Living Foliage - Deep Interior Cavity Hollows: ${foliageVoidCount.toLocaleString()}`);
  console.log(`Living Foliage - Waxy Cuticle Stipple Texels: ${foliageWaxyCuticleCount.toLocaleString()}`);
  console.log(`Living Foliage - Microscopic Canopy Pores: ${perforatedFoliageCount.toLocaleString()} (${(perforatedFoliageCount / (treeCanopyTexelsCount || 1) * 100).toFixed(2)}% of overstory canopy)`);
  console.log(`Toksvig Micro-Normal Coupled Texels: ${toksvigCoupledTexelsCount.toLocaleString()}`);
  console.log(`Roman Gradina Chisel Scratch Texels: ${gradinaChiselTexelsCount.toLocaleString()}`);
  console.log(`Calcite Cavitation Micro-Pit Texels: ${calcitePitsTexelsCount.toLocaleString()}`);
  console.log(`Calcite Mineral Fleck Sparkle Texels: ${mineralFlecksTexelsCount.toLocaleString()}`);
  console.log(`Phase 3 - 5mm Virtual Specular Bevel Texels: ${virtualBevelTexelsCount.toLocaleString()} (Edges: ${sharpDihedralEdgesCount.toLocaleString()})`);
  console.log(`Phase 3 - Curvature Anti-Faceting Normal Texels: ${antiFacetingTexelsCount.toLocaleString()} (Smooth Edges: ${smoothCurvatureEdgesCount.toLocaleString()})`);
  console.log(`Total Stone Texels: ${stoneCount.toLocaleString()}`);
  console.log(`Total Foliage Texels: ${foliageCount.toLocaleString()}`);
  console.log(`========================================================================\n`);

  return {
    success: true,
    numMeshes,
    outputGlbPath: outPath,
    fileSizeBytes: finalFileSizeBytes,
    fileSizeMb: (finalFileSizeBytes / (1024 * 1024)).toFixed(2),
    durationSeconds: parseFloat(totalSecs),
    totalTexels: totalTexelsProcessed,
    stoneTexels: stoneCount,
    foliageTexels: foliageCount,
    roadTexels: roadCount,
    morphologicalStats: {
      soffits: soffitTexelsCount,
      sills: sillTexelsCount,
      ridges: ridgeTexelsCount,
      crevices: creviceTexelsCount,
      rainwash: rainwashTexelsCount,
      solarOxidation: solarOxidationTexelsCount,
      delightedStoneTexels: delightedStoneTexelsCount,
      volumetricFoliageTexels: volumetricFoliageTexelsCount,
      foliageUndersideTexels: foliageUndersideCount,
      foliageFlutterTexels: foliageFlutterCount,
      foliageChlorophyllRimTexels: foliageChlorophyllRimCount,
      foliageVoidTexels: foliageVoidCount,
      foliageWaxyCuticleTexels: foliageWaxyCuticleCount,
      toksvigCoupledTexels: toksvigCoupledTexelsCount,
      gradinaChiselTexels: gradinaChiselTexelsCount,
      calcitePitsTexels: calcitePitsTexelsCount,
      mineralFlecksTexels: mineralFlecksTexelsCount,
      virtualBevelTexels: virtualBevelTexelsCount,
      antiFacetingTexels: antiFacetingTexelsCount,
      sharpDihedralEdges: sharpDihedralEdgesCount,
      smoothCurvatureEdges: smoothCurvatureEdgesCount,
      foliageTexels: foliageCount,
      perforatedFoliageTexels: perforatedFoliageCount,
      foliageSubmeshesWithAlpha: albedoIsPng.filter(Boolean).length
    },
    timestamp: new Date().toISOString()
  };
}

if (require.main === module) {
  runColosseum1kPbrPipeline().catch(err => {
    console.error('Fatal error in Colosseum 1K PBR pipeline:', err);
    process.exit(1);
  });
}

module.exports = { runColosseum1kPbrPipeline };
