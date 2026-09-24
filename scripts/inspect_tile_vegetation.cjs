const fs = require('fs');
const { spawnSync } = require('child_process');

function decodeJpg(buf) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: buf });
  return p.stdout;
}

function analyzeGlb(filePath) {
  console.log('=== Analyzing:', filePath, '===');
  const glbBuf = fs.readFileSync(filePath);
  const jsonLen = glbBuf.readUInt32LE(12);
  const gltf = JSON.parse(glbBuf.toString('utf8', 20, 20 + jsonLen));
  const binOffset = 20 + jsonLen + 8;
  const binBuf = glbBuf.subarray(binOffset);

  console.log('Meshes:', gltf.meshes.length, 'Images:', gltf.images ? gltf.images.length : 0);

  let totalVegVerts = 0;
  let totalVerts = 0;
  const highVegMeshes = [];

  for (let mIdx = 0; mIdx < gltf.meshes.length; mIdx++) {
    const mesh = gltf.meshes[mIdx];
    const prim = mesh.primitives[0];
    const mat = prim.material !== undefined ? gltf.materials[prim.material] : null;
    const texIdx = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (texIdx === undefined || !gltf.textures || !gltf.textures[texIdx]) continue;
    const imgIdx = gltf.textures[texIdx].source;
    const img = gltf.images[imgIdx];
    const bv = gltf.bufferViews[img.bufferView];
    const imgBuf = binBuf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    
    // Parse dimensions
    let w = 0, h = 0;
    for (let i = 2; i < imgBuf.length - 8; i++) {
      if (imgBuf[i] === 0xFF && (imgBuf[i+1] === 0xC0 || imgBuf[i+1] === 0xC2)) {
        h = imgBuf.readUInt16BE(i + 5);
        w = imgBuf.readUInt16BE(i + 7);
        break;
      }
    }
    if (w === 0 || h === 0) continue;
    const rgba = decodeJpg(imgBuf);
    if (!rgba || rgba.length !== w * h * 4) continue;

    const posAcc = gltf.accessors[prim.attributes.POSITION];
    const posBv = gltf.bufferViews[posAcc.bufferView];
    const posBytes = binBuf.subarray((posBv.byteOffset || 0) + (posAcc.byteOffset || 0));

    const uvAcc = typeof prim.attributes.TEXCOORD_0 === 'number' ? gltf.accessors[prim.attributes.TEXCOORD_0] : null;
    if (!uvAcc) continue;
    const uvBv = gltf.bufferViews[uvAcc.bufferView];
    const uvBytes = binBuf.subarray((uvBv.byteOffset || 0) + (uvAcc.byteOffset || 0));

    let meshVegCount = 0;
    const vegPoints = [];
    for (let v = 0; v < posAcc.count; v++) {
      totalVerts++;
      const x = posBytes.readFloatLE(v * 12);
      const y = posBytes.readFloatLE(v * 12 + 4);
      const z = posBytes.readFloatLE(v * 12 + 8);

      const u = uvBytes.readFloatLE(v * 8);
      const vCoord = uvBytes.readFloatLE(v * 8 + 4);

      const px = Math.min(w - 1, Math.max(0, Math.floor(((u % 1 + 1) % 1) * w)));
      const py = Math.min(h - 1, Math.max(0, Math.floor(((vCoord % 1 + 1) % 1) * h)));
      const pIdx = (py * w + px) * 4;
      const r = rgba[pIdx];
      const g = rgba[pIdx + 1];
      const b = rgba[pIdx + 2];

      const sum = r + g + b + 0.001;
      const exg = (2.0 * g - r - b) / sum;
      if (exg > 0.08 && g > r * 1.05 && g > b) {
        meshVegCount++;
        totalVegVerts++;
        vegPoints.push([x, y, z]);
      }
    }

    if (meshVegCount >= 50) {
      // Compute bounds of veg points
      let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const p of vegPoints) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
      highVegMeshes.push({
        mIdx,
        vegCount: meshVegCount,
        total: posAcc.count,
        percent: (100 * meshVegCount / posAcc.count).toFixed(1) + '%',
        bounds: {
          x: [min[0].toFixed(1), max[0].toFixed(1)],
          y: [min[1].toFixed(1), max[1].toFixed(1)],
          z: [min[2].toFixed(1), max[2].toFixed(1)],
          size: [(max[0]-min[0]).toFixed(1), (max[1]-min[1]).toFixed(1), (max[2]-min[2]).toFixed(1)]
        }
      });
    }
  }

  console.log(`Summary for ${filePath}: Total Verts = ${totalVerts}, Total Veg Verts = ${totalVegVerts}`);
  console.log('Meshes with >= 50 vegetative vertices:');
  console.log(JSON.stringify(highVegMeshes, null, 2));
}

analyzeGlb('public/models/nyc_grand_army_plaza_raw.glb');
