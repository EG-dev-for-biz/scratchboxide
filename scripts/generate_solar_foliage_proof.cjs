/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG encoder helper
function computeCrc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = data ? data.length : 0;
  const chunk = Buffer.alloc(8 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  if (data && len > 0) {
    data.copy(chunk, 8);
  }
  const typeAndData = Buffer.alloc(4 + len);
  typeAndData.write(type, 0, 4, 'ascii');
  if (data && len > 0) {
    data.copy(typeAndData, 4);
  }
  chunk.writeUInt32BE(computeCrc32(typeAndData), 8 + len);
  return chunk;
}

function encodePng(width, height, rgba) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const scanlineLen = width * 4;
  const uncompressed = Buffer.alloc(height * (1 + scanlineLen));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    uncompressed[offset++] = 0;
    rgba.copy(uncompressed, offset, y * scanlineLen, (y + 1) * scanlineLen);
    offset += scanlineLen;
  }
  const compressed = zlib.deflateSync(uncompressed);
  const idatChunk = makePngChunk('IDAT', compressed);
  const iendChunk = makePngChunk('IEND');
  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk]);
}

// Foliage classes & colors
const FoliageClass = {
  UNKNOWN: 0,
  TURF_GRASS: 1,
  BUSH_SHRUB: 2,
  TREE_CANOPY: 3,
  ARCHITECTURE_BUILDING: 4,
  HARDSCAPE_PAVEMENT: 5
};

const FOLIAGE_CLASS_COLORS = {
  [FoliageClass.UNKNOWN]: [40, 40, 40],
  [FoliageClass.TURF_GRASS]: [134, 194, 50],         // Bright Yellow-Green Lawn
  [FoliageClass.BUSH_SHRUB]: [46, 139, 87],          // Medium Sea Green / Shrub
  [FoliageClass.TREE_CANOPY]: [18, 92, 38],          // Deep Forest / Overstory Emerald
  [FoliageClass.ARCHITECTURE_BUILDING]: [185, 175, 165], // Architectural Stone / Roof
  [FoliageClass.HARDSCAPE_PAVEMENT]: [95, 100, 110]  // Cool Grey Asphalt / Pavement
};

async function main() {
  console.log('Generating Google Solar API dataLayers Multi-Class Foliage Segmentation Demonstration...');

  const { GoogleSolarFoliageClassifier } = require('../packages/core/dist/node');

  const width = 200;
  const height = 200;
  const numPixels = width * height;
  const pixelScaleMeters = 0.1; // 10 cm / pixel -> 20m x 20m survey sector

  const originLat = 41.89021;
  const originLng = 12.49223;

  const dsm = new Float32Array(numPixels);
  const mask = new Uint8Array(numPixels);
  const r = new Uint8Array(numPixels);
  const g = new Uint8Array(numPixels);
  const b = new Uint8Array(numPixels);

  const baseElevation = 18.5; // meters ASL

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      // Natural sloping ground datum
      const terrainSlope = (x / width) * 1.2 + (y / height) * 0.8;
      const groundElev = baseElevation + terrainSlope;

      dsm[idx] = groundElev;
      mask[idx] = 0;

      // Default: Basalt pavement / hardscape
      r[idx] = 100;
      g[idx] = 105;
      b[idx] = 112; // ExG = 210 - 100 - 112 = -2

      // 1. Classical Building Rooftop (x: 15..80, y: 15..75)
      if (x >= 15 && x <= 80 && y >= 15 && y <= 75) {
        mask[idx] = 1;
        dsm[idx] = groundElev + 11.5 + Math.sin(x * 0.1) * 0.2;
        r[idx] = 175;
        g[idx] = 160;
        b[idx] = 145; // Terracotta / Travertine
      }

      // 2. Lawn / Turf Grass Garden (x: 100..185, y: 15..85)
      else if (x >= 100 && x <= 185 && y >= 15 && y <= 85) {
        mask[idx] = 0;
        dsm[idx] = groundElev + 0.08 + Math.random() * 0.04; // 8-12 cm turf
        r[idx] = 70;
        g[idx] = 170;
        b[idx] = 55; // Lawn grass ExG = 340 - 70 - 55 = 215
      }

      // 3. Shrub & Boxwood Hedge Perimeter (x: 95..190, y: 88..105)
      else if (x >= 95 && x <= 190 && y >= 88 && y <= 105) {
        mask[idx] = 0;
        dsm[idx] = groundElev + 1.35 + Math.sin(x * 0.2) * 0.3; // 1.05m - 1.65m hedge
        r[idx] = 40;
        g[idx] = 145;
        b[idx] = 50; // Dense shrub ExG = 290 - 40 - 50 = 200
      }

      // 4. Overstory Tree Canopy 1: Stone Pine Hero (center: x=50, y=140, radius=32)
      const distTree1 = Math.hypot(x - 50, y - 140);
      if (distTree1 <= 32 && mask[idx] === 0) {
        const domeHeight = Math.sqrt(Math.max(0, 32 * 32 - distTree1 * distTree1)) * 0.28;
        dsm[idx] = groundElev + 8.2 + domeHeight; // 8.2m to 17.1m
        r[idx] = 22;
        g[idx] = 115;
        b[idx] = 32; // Deep conifer emerald ExG = 230 - 22 - 32 = 176
      }

      // 5. Overstory Tree Canopy 2: Cypresses Grove (center: x=145, y=150, radius=24)
      const distTree2 = Math.hypot(x - 145, y - 150);
      if (distTree2 <= 24 && mask[idx] === 0) {
        const domeHeight2 = Math.sqrt(Math.max(0, 24 * 24 - distTree2 * distTree2)) * 0.35;
        dsm[idx] = groundElev + 7.0 + domeHeight2; // 7.0m to 15.4m
        r[idx] = 28;
        g[idx] = 125;
        b[idx] = 36;
      }
    }
  }

  const bundle = {
    dsm,
    rgb: { r, g, b },
    mask,
    metadata: {
      width,
      height,
      pixelScale: { scaleX: pixelScaleMeters, scaleY: pixelScaleMeters, scaleZ: 1.0 },
      tiePoint: { i: 0, j: 0, k: 0, x: originLng, y: originLat, z: 0.0 },
      boundingBox: {
        sw: { latitude: originLat - height * (pixelScaleMeters / 111000.0), longitude: originLng },
        ne: { latitude: originLat, longitude: originLng + width * (pixelScaleMeters / (111000.0 * Math.cos(originLat * Math.PI / 180))) }
      },
      noDataValue: -9999
    }
  };

  const classifier = new GoogleSolarFoliageClassifier({
    grassMaxHeightMeters: 0.25,
    shrubMaxHeightMeters: 2.50,
    minVegetationExG: 10.0
  });

  const result = classifier.segmentFoliage(bundle);

  console.log('\n--- Segmentation Telemetry ---');
  console.log(`Total Survey Area: ${result.stats.totalAreaM2} m² (Resolution: ${result.stats.pixelResolutionMeters}m / 10cm per pixel)`);
  console.log(`Vegetation Area: ${result.stats.vegetationAreaM2} m²`);
  console.log(`  - Tree Canopy: ${result.stats.treeCanopyAreaM2} m² (${result.stats.canopyCoveragePercent}%) [Mean H: ${result.stats.meanTreeHeightMeters}m, Max H: ${result.stats.maxTreeHeightMeters}m]`);
  console.log(`  - Shrub / Bush: ${result.stats.shrubBushAreaM2} m² (${result.stats.shrubCoveragePercent}%) [Mean H: ${result.stats.meanShrubHeightMeters}m]`);
  console.log(`  - Turf Grass: ${result.stats.turfGrassAreaM2} m² (${result.stats.grassCoveragePercent}%)`);
  console.log(`Architecture / Buildings: ${result.stats.buildingAreaM2} m²`);
  console.log(`Hardscape / Pavement: ${result.stats.hardscapeAreaM2} m²`);
  console.log(`Estimated Tree Count: ${result.stats.totalTreeCountEstimate}`);

  // Create composite 3-panel visualization:
  // Panel 1: RGB Orthophoto
  // Panel 2: nDSM Height Above Ground (Heatmap)
  // Panel 3: Multi-Class Foliage Segmentation Map
  const panelW = width;
  const panelH = height;
  const margin = 16;
  const topHeaderH = 64;
  const bottomLegendH = 48;
  const compW = panelW * 3 + margin * 4;
  const compH = panelH + topHeaderH + bottomLegendH;

  const compRgba = Buffer.alloc(compW * compH * 4, 255);

  // Background fill: Deep dark studio slate (#1e222b)
  for (let i = 0; i < compW * compH; i++) {
    compRgba[i * 4] = 30;
    compRgba[i * 4 + 1] = 34;
    compRgba[i * 4 + 2] = 43;
    compRgba[i * 4 + 3] = 255;
  }

  // Helper to blit a pixel to composite
  function setCompPixel(cx, cy, red, green, blue) {
    if (cx < 0 || cx >= compW || cy < 0 || cy >= compH) return;
    const idx = (cy * compW + cx) * 4;
    compRgba[idx] = red;
    compRgba[idx + 1] = green;
    compRgba[idx + 2] = blue;
    compRgba[idx + 3] = 255;
  }

  // Draw Panel 1: RGB Orthophoto
  const p1X = margin;
  const p1Y = topHeaderH;
  for (let py = 0; py < panelH; py++) {
    for (let px = 0; px < panelW; px++) {
      const srcIdx = py * panelW + px;
      setCompPixel(p1X + px, p1Y + py, r[srcIdx], g[srcIdx], b[srcIdx]);
    }
  }

  // Draw Panel 2: nDSM Height Heatmap (Turbo / Viridis style)
  const p2X = margin * 2 + panelW;
  const p2Y = topHeaderH;
  const maxVisHeight = 15.0; // clamp at 15m for heatmap
  for (let py = 0; py < panelH; py++) {
    for (let px = 0; px < panelW; px++) {
      const srcIdx = py * panelW + px;
      const hNorm = Math.min(1.0, Math.max(0.0, result.ndsm[srcIdx] / maxVisHeight));
      // Heatmap color ramp: dark blue -> cyan -> yellow -> orange -> magenta
      let hr, hg, hb;
      if (hNorm < 0.25) {
        const t = hNorm / 0.25;
        hr = Math.round(15 * (1 - t) + 20 * t);
        hg = Math.round(25 * (1 - t) + 140 * t);
        hb = Math.round(80 * (1 - t) + 210 * t);
      } else if (hNorm < 0.5) {
        const t = (hNorm - 0.25) / 0.25;
        hr = Math.round(20 * (1 - t) + 40 * t);
        hg = Math.round(140 * (1 - t) + 220 * t);
        hb = Math.round(210 * (1 - t) + 50 * t);
      } else if (hNorm < 0.75) {
        const t = (hNorm - 0.5) / 0.25;
        hr = Math.round(40 * (1 - t) + 240 * t);
        hg = Math.round(220 * (1 - t) + 180 * t);
        hb = Math.round(50 * (1 - t) + 20 * t);
      } else {
        const t = (hNorm - 0.75) / 0.25;
        hr = Math.round(240 * (1 - t) + 250 * t);
        hg = Math.round(180 * (1 - t) + 50 * t);
        hb = Math.round(20 * (1 - t) + 120 * t);
      }
      setCompPixel(p2X + px, p2Y + py, hr, hg, hb);
    }
  }

  // Draw Panel 3: Multi-Class Foliage Segmentation Map
  const p3X = margin * 3 + panelW * 2;
  const p3Y = topHeaderH;
  for (let py = 0; py < panelH; py++) {
    for (let px = 0; px < panelW; px++) {
      const srcIdx = py * panelW + px;
      const cls = result.classificationMap[srcIdx];
      const color = FOLIAGE_CLASS_COLORS[cls] || FOLIAGE_CLASS_COLORS[FoliageClass.UNKNOWN];
      setCompPixel(p3X + px, p3Y + py, color[0], color[1], color[2]);
    }
  }

  // Draw Legend Swatches at bottom
  const legendItems = [
    { name: 'Tree Canopy (>=2.5m)', color: FOLIAGE_CLASS_COLORS[FoliageClass.TREE_CANOPY] },
    { name: 'Bushes & Shrubs (0.25-2.5m)', color: FOLIAGE_CLASS_COLORS[FoliageClass.BUSH_SHRUB] },
    { name: 'Turf Grass (<0.25m)', color: FOLIAGE_CLASS_COLORS[FoliageClass.TURF_GRASS] },
    { name: 'Architecture (Mask)', color: FOLIAGE_CLASS_COLORS[FoliageClass.ARCHITECTURE_BUILDING] },
    { name: 'Pavement / Asphalt', color: FOLIAGE_CLASS_COLORS[FoliageClass.HARDSCAPE_PAVEMENT] }
  ];

  const swatchY = compH - bottomLegendH + 16;
  const itemW = Math.floor(compW / legendItems.length);

  legendItems.forEach((item, idx) => {
    const swatchX = idx * itemW + 24;
    // Draw 16x16 swatch
    for (let sy = 0; sy < 16; sy++) {
      for (let sx = 0; sx < 16; sx++) {
        setCompPixel(swatchX + sx, swatchY + sy, item.color[0], item.color[1], item.color[2]);
      }
    }
  });

  const finalPng = encodePng(compW, compH, compRgba);
  const outPath = '/Users/eligreen/.gemini/antigravity/brain/a4b13200-846d-4dd5-a3b8-35762daf824b/google_solar_foliage_segmentation_proof.png';
  fs.writeFileSync(outPath, finalPng);

  console.log(`\n=== Visual Proof Artifact Saved ===`);
  console.log(`Path: ${outPath}`);
  console.log(`Dimensions: ${compW} x ${compH} px`);
  console.log(`File Size: ${(finalPng.length / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
