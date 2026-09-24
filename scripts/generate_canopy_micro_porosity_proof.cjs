const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function decodeToRgba(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-i', filePath,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1'
    ]);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg decode failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
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

async function generateMicroscopicPorosityProof() {
  const albedoPath = path.resolve(__dirname, '../public/models/colosseum_foliage_texture_hero_1k_albedo.png');
  const W = 1024;
  const H = 1024;
  const heroRgba = await decodeToRgba(albedoPath);
  console.log(`Decoded Hero Foliage Texture: ${heroRgba.length} bytes (1024x1024x4)`);

  // Find center of porosity in hero texture
  let poreCount = 0;
  let minPoreX = W, maxPoreX = 0, minPoreY = H, maxPoreY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const a = heroRgba[idx + 3];
      if (a === 0) {
        poreCount++;
        if (x < minPoreX) minPoreX = x;
        if (x > maxPoreX) maxPoreX = x;
        if (y < minPoreY) minPoreY = y;
        if (y > maxPoreY) maxPoreY = y;
      }
    }
  }
  console.log(`Hero texture has ${poreCount} transparent pore texels. Bounds: [${minPoreX},${minPoreY}] to [${maxPoreX},${maxPoreY}]`);

  // Pick a crop center where foliage and pores are dense
  const cropCenterX = 240;
  const cropCenterY = 620;

  const outW = 1260;
  const outH = 500;
  const outBuf = Buffer.alloc(outW * outH * 4);

  // Fill dark slate background #141721
  for (let i = 0; i < outW * outH * 4; i += 4) {
    outBuf[i] = 20;
    outBuf[i + 1] = 23;
    outBuf[i + 2] = 33;
    outBuf[i + 3] = 255;
  }

  const pSize = 380;
  
  // Panel 1: Checkered Alpha Composite (left: 40, top: 60)
  const p1X = 40;
  const p1Y = 60;
  for (let py = 0; py < pSize; py++) {
    for (let px = 0; px < pSize; px++) {
      const srcX = Math.floor((px / pSize) * W);
      const srcY = Math.floor((py / pSize) * H);
      const sIdx = (srcY * W + srcX) * 4;
      const r = heroRgba[sIdx];
      const g = heroRgba[sIdx + 1];
      const b = heroRgba[sIdx + 2];
      const a = heroRgba[sIdx + 3] / 255.0;

      // Checkerboard background (8x8 px)
      const chk = ((Math.floor(px / 10) + Math.floor(py / 10)) % 2 === 0) ? 225 : 185;
      const dstR = Math.round(r * a + chk * (1.0 - a));
      const dstG = Math.round(g * a + chk * (1.0 - a));
      const dstB = Math.round(b * a + chk * (1.0 - a));

      const dIdx = ((p1Y + py) * outW + (p1X + px)) * 4;
      outBuf[dIdx] = dstR;
      outBuf[dIdx + 1] = dstG;
      outBuf[dIdx + 2] = dstB;
      outBuf[dIdx + 3] = 255;
    }
  }

  // Panel 2: Alpha Channel Mask (White = Solid, Black = Cutout Pore)
  const p2X = 450;
  const p2Y = 60;
  for (let py = 0; py < pSize; py++) {
    for (let px = 0; px < pSize; px++) {
      const srcX = Math.floor((px / pSize) * W);
      const srcY = Math.floor((py / pSize) * H);
      const sIdx = (srcY * W + srcX) * 4;
      const a = heroRgba[sIdx + 3];

      const dIdx = ((p2Y + py) * outW + (p2X + px)) * 4;
      outBuf[dIdx] = a;
      outBuf[dIdx + 1] = a;
      outBuf[dIdx + 2] = a;
      outBuf[dIdx + 3] = 255;
    }
  }

  // Panel 3: High-Zoom of Microscopic Pores (80x80 crop blown up to 380x380)
  const p3X = 840;
  const p3Y = 60;
  const zoomSrcSize = 80;
  const startCropX = Math.max(0, Math.min(W - zoomSrcSize, cropCenterX - Math.floor(zoomSrcSize / 2)));
  const startCropY = Math.max(0, Math.min(H - zoomSrcSize, cropCenterY - Math.floor(zoomSrcSize / 2)));

  for (let py = 0; py < pSize; py++) {
    for (let px = 0; px < pSize; px++) {
      const srcX = startCropX + Math.floor((px / pSize) * zoomSrcSize);
      const srcY = startCropY + Math.floor((py / pSize) * zoomSrcSize);
      const sIdx = (srcY * W + srcX) * 4;
      const r = heroRgba[sIdx];
      const g = heroRgba[sIdx + 1];
      const b = heroRgba[sIdx + 2];
      const a = heroRgba[sIdx + 3] / 255.0;

      // High-contrast turquoise/navy checkerboard to vividly show transparent needle-pores
      const chk = ((Math.floor(px / 12) + Math.floor(py / 12)) % 2 === 0) ? 230 : 170;
      const chkR = (a === 0) ? 35 : chk;
      const chkG = (a === 0) ? 175 : chk;
      const chkB = (a === 0) ? 235 : chk;

      const dstR = Math.round(r * a + chkR * (1.0 - a));
      const dstG = Math.round(g * a + chkG * (1.0 - a));
      const dstB = Math.round(b * a + chkB * (1.0 - a));

      // Draw subtle texel grid lines
      const step = pSize / zoomSrcSize;
      const isTexelEdge = (px % step < 1.0) || (py % step < 1.0);
      const edgeFactor = isTexelEdge ? 0.88 : 1.0;

      const dIdx = ((p3Y + py) * outW + (p3X + px)) * 4;
      outBuf[dIdx] = Math.round(dstR * edgeFactor);
      outBuf[dIdx + 1] = Math.round(dstG * edgeFactor);
      outBuf[dIdx + 2] = Math.round(dstB * edgeFactor);
      outBuf[dIdx + 3] = 255;
    }
  }

  // Draw crop box on Panel 1 & Panel 2
  for (const bx of [p1X, p2X]) {
    const curX1 = bx + Math.floor((startCropX / W) * pSize);
    const curY1 = p1Y + Math.floor((startCropY / H) * pSize);
    const boxW = Math.floor((zoomSrcSize / W) * pSize);
    const boxH = Math.floor((zoomSrcSize / H) * pSize);

    for (let x = curX1; x < curX1 + boxW; x++) {
      const topIdx = (curY1 * outW + x) * 4;
      const botIdx = ((curY1 + boxH) * outW + x) * 4;
      outBuf[topIdx] = 255; outBuf[topIdx+1] = 220; outBuf[topIdx+2] = 0;
      outBuf[botIdx] = 255; outBuf[botIdx+1] = 220; outBuf[botIdx+2] = 0;
    }
    for (let y = curY1; y <= curY1 + boxH; y++) {
      const leftIdx = (y * outW + curX1) * 4;
      const rightIdx = (y * outW + curX1 + boxW) * 4;
      outBuf[leftIdx] = 255; outBuf[leftIdx+1] = 220; outBuf[leftIdx+2] = 0;
      outBuf[rightIdx] = 255; outBuf[rightIdx+1] = 220; outBuf[rightIdx+2] = 0;
    }
  }

  const pngBuffer = await encodePng(outBuf, outW, outH);
  const artifactPath = '/Users/eligreen/.gemini/antigravity/brain/a4b13200-846d-4dd5-a3b8-35762daf824b/canopy_micro_porosity_proof.png';
  fs.writeFileSync(artifactPath, pngBuffer);
  console.log(`Saved Microscopic Porosity Visual Proof Artifact: ${artifactPath} (${(pngBuffer.length / 1024).toFixed(1)} KB)`);
}

generateMicroscopicPorosityProof().catch(console.error);
