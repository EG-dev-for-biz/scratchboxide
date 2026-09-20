const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

async function decodeRgba(buf, w, h) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', () => resolve(Buffer.concat(chunks)));
    proc.stdin.write(buf);
    proc.stdin.end();
  });
}

async function encodeJpeg(rgbaBuf, w, h, qv = 2) {
  return new Promise((resolve) => {
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
    proc.on('close', () => resolve(Buffer.concat(chunks)));
    proc.stdin.write(rgbaBuf);
    proc.stdin.end();
  });
}

(async () => {
  const W = 2048;
  const H = 2048;

  console.log('1. Reading GLB & Extracting Mesh 39 Geometry...');
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

  const prim = gltf.meshes[39].primitives[0];
  const positions = getAccessorData(prim.attributes.POSITION);
  const uvs = getAccessorData(prim.attributes.TEXCOORD_0);
  const indices = getAccessorData(prim.indices);
  const numTris = indices.length / 3;

  // 2. Decode Sharpened High-Contrast Optical Base Texture at 2048x2048
  console.log('2. Decoding High-Contrast Sharpened Base Texture at 2048x2048...');
  execSync('ffmpeg -v error -y -i public/models/colosseum_stone_texture_39_orig.jpg -vf "scale=2048:2048:flags=lanczos,unsharp=5:5:2.5:5:5:0.0" /tmp/mesh39_sharpened_base.png');
  const baseRgba = await decodeRgba(fs.readFileSync('/tmp/mesh39_sharpened_base.png'), W, H);
  const outRgba = Buffer.from(baseRgba);

  // 3. Decode AI-Synthesized High-Resolution Travertine Texture (1024x1024)
  console.log('3. Decoding AI-Synthesized Travertine Texture (1024x1024)...');
  const aiTexPath = 'public/models/ai_travertine_detail.png';
  const aiW = 1024;
  const aiH = 1024;
  const aiRgba = await decodeRgba(fs.readFileSync(aiTexPath), aiW, aiH);

  function sampleAiTexture(u, v) {
    // Wrap UV to [0, 1)
    let uu = u - Math.floor(u);
    let vv = v - Math.floor(v);
    const px = Math.min(aiW - 1, Math.max(0, Math.floor(uu * aiW)));
    const py = Math.min(aiH - 1, Math.max(0, Math.floor(vv * aiH)));
    const idx = (py * aiW + px) * 4;
    return [aiRgba[idx], aiRgba[idx + 1], aiRgba[idx + 2]];
  }

  // 4. True 3D Triplanar Inpainting across 5,026 Triangles
  console.log('4. Projecting AI Travertine Detail via 3D World Space across 5,026 Triangles...');
  
  // Real-world scale: 1 repeating tile = 2.4 meters of Roman Colosseum ashlar blocks
  const worldMetersPerTile = 2.4;
  const invScale = 1.0 / worldMetersPerTile;

  let processedPixels = 0;

  for (let t = 0; t < numTris; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];

    const x0 = positions[i0 * 3], y0 = positions[i0 * 3 + 1], z0 = positions[i0 * 3 + 2];
    const x1 = positions[i1 * 3], y1 = positions[i1 * 3 + 1], z1 = positions[i1 * 3 + 2];
    const x2 = positions[i2 * 3], y2 = positions[i2 * 3 + 1], z2 = positions[i2 * 3 + 2];

    const u0 = uvs[i0 * 2] * (W - 1), v0 = (1.0 - uvs[i0 * 2 + 1]) * (H - 1);
    const u1 = uvs[i1 * 2] * (W - 1), v1 = (1.0 - uvs[i1 * 2 + 1]) * (H - 1);
    const u2 = uvs[i2 * 2] * (W - 1), v2 = (1.0 - uvs[i2 * 2 + 1]) * (H - 1);

    // Compute Face Normal in 3D
    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const nX = nx / len;
    const nY = ny / len;
    const nZ = nz / len;

    // Triplanar Blending Weights (power of 4 for sharp projection boundaries)
    const pWX = Math.pow(Math.abs(nX), 4);
    const pWY = Math.pow(Math.abs(nY), 4);
    const pWZ = Math.pow(Math.abs(nZ), 4);
    const totalW = pWX + pWY + pWZ || 1;
    const wBlendX = pWX / totalW;
    const wBlendY = pWY / totalW;
    const wBlendZ = pWZ / totalW;

    // UV Triangle Area / Determinant
    const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(det) < 1e-6) continue;
    const invDet = 1.0 / det;

    // UV Bounding Box
    const minPx = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
    const maxPx = Math.min(W - 1, Math.ceil(Math.max(u0, u1, u2)));
    const minPy = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
    const maxPy = Math.min(H - 1, Math.ceil(Math.max(v0, v1, v2)));

    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        // Barycentric Coordinates (Continuous in UV space)
        const w0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * invDet;
        if (w0 < -0.001 || w0 > 1.001) continue;
        const w1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * invDet;
        if (w1 < -0.001 || (w0 + w1) > 1.001) continue;
        const w2 = 1.0 - w0 - w1;
        if (w2 < -0.001) continue;

        // EXACT 3D WORLD COORDINATE (in physical meters)
        const wx = w0 * x0 + w1 * x1 + w2 * x2;
        const wy = w0 * y0 + w1 * y1 + w2 * y2;
        const wz = w0 * z0 + w1 * z1 + w2 * z2;

        const idx = (py * W + px) * 4;
        const rOrig = baseRgba[idx];
        const gOrig = baseRgba[idx + 1];
        const bOrig = baseRgba[idx + 2];

        // Sample Triplanar Projections from AI Travertine Texture
        const sampleX = sampleAiTexture(wz * invScale, wy * invScale);
        const sampleY = sampleAiTexture(wx * invScale, wz * invScale);
        const sampleZ = sampleAiTexture(wx * invScale, wy * invScale);

        const aiR = wBlendX * sampleX[0] + wBlendY * sampleY[0] + wBlendZ * sampleZ[0];
        const aiG = wBlendX * sampleX[1] + wBlendY * sampleY[1] + wBlendZ * sampleZ[1];
        const aiB = wBlendX * sampleX[2] + wBlendY * sampleY[2] + wBlendZ * sampleZ[2];

        // Normalize AI texture detail around neutral 1.0 multiplier
        const avgAiLum = (aiR * 0.299 + aiG * 0.587 + aiB * 0.114);
        const lumFactor = (avgAiLum / 185.0);

        // Smooth 3D Ambient Lighting (Recessed undersides vs sunlit ledges)
        let lightFactor = 1.0;
        if (nY < -0.10) {
          // Arch soffits and undercuts: gentle ambient occlusion
          lightFactor -= Math.min(1.0, (-nY - 0.10) / 0.85) * 0.32;
        } else if (nY > 0.25) {
          // Cornice shelves: subtle sunlit highlight
          lightFactor += Math.min(1.0, (nY - 0.25) / 0.70) * 0.16;
        }

        // FUSE AI HIGH-FREQUENCY DETAIL WITH BASE PHOTOGRAMMETRY TONE
        // 45% base color + 55% high-frequency AI travertine porosity & mineral texture
        const blendR = (rOrig * 0.40 + (rOrig * (aiR / 185.0)) * 0.60) * lightFactor;
        const blendG = (gOrig * 0.40 + (gOrig * (aiG / 185.0)) * 0.60) * lightFactor;
        const blendB = (bOrig * 0.40 + (bOrig * (aiB / 185.0)) * 0.60) * lightFactor;

        outRgba[idx] = Math.min(255, Math.max(0, Math.round(blendR)));
        outRgba[idx + 1] = Math.min(255, Math.max(0, Math.round(blendG)));
        outRgba[idx + 2] = Math.min(255, Math.max(0, Math.round(blendB)));

        processedPixels++;
      }
    }
  }

  console.log(`Successfully mapped AI travertine detail across ${processedPixels} pixels in continuous 3D world space.`);

  // 5. Encode to High-Efficiency JPEG (-q:v 2)
  console.log('5. Compressing Shape-Grounded AI Atlas to High-Efficiency JPEG (-q:v 2)...');
  const targetJpegBuf = await encodeJpeg(outRgba, W, H, 2);
  const outJpegPath = 'public/models/colosseum_stone_texture_39_shape_grounded.jpg';
  fs.writeFileSync(outJpegPath, targetJpegBuf);
  console.log(`Saved Shape-Grounded AI Texture: ${outJpegPath} (${(targetJpegBuf.length / 1024).toFixed(1)} KB)`);

  // 6. Repack GLB with updated texture
  console.log('6. Repacking into public/models/colosseum_rome_shape_grounded.glb...');
  const targetImgIdx = 39;
  const targetBvIdx = gltf.images[targetImgIdx].bufferView;
  gltf.images[targetImgIdx].mimeType = 'image/jpeg';

  const processedBvs = [];
  for (let i = 0; i < gltf.bufferViews.length; i++) {
    const bv = gltf.bufferViews[i];
    if (i === targetBvIdx) {
      processedBvs.push(targetJpegBuf);
    } else {
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
  console.log(`Success! Repacked GLB saved to: ${outGlbPath} (${(finalGlb.length / (1024 * 1024)).toFixed(2)} MB)`);

  // Copy to artifacts
  fs.copyFileSync(outJpegPath, path.resolve('/Users/eligreen/.gemini/antigravity/brain/929185bf-320b-4a82-ad89-d9bec255139d/colosseum_shape_grounded_atlas.jpg'));
})();
