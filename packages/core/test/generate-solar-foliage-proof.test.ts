/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  FoliageClass,
  FOLIAGE_CLASS_COLORS,
  SolarDataLayersBundle
} from '../src/common/spatial/GoogleSolarDataLayersTypes';
import { GoogleSolarFoliageClassifier } from '../src/node/spatial/GoogleSolarFoliageClassifier';
import { encodePng } from '../src/node/texture-processing';

describe('Google Solar API dataLayers Multi-Class Foliage Proof', () => {
  it('generates multi-class foliage segmentation and outputs visual proof artifact', async () => {
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

        // Natural undulating terrain ground
        const terrainSlope = (x / width) * 1.2 + (y / height) * 0.8;
        const groundElev = baseElevation + terrainSlope;

        dsm[idx] = groundElev;
        mask[idx] = 0;

        // Default: Roman basalt pavement / hardscape
        r[idx] = 105;
        g[idx] = 110;
        b[idx] = 118; // ExG = 220 - 105 - 118 = -3

        // 1. Classical Roman Villa Rooftop (x: 15..80, y: 15..75)
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
          dsm[idx] = groundElev + 0.08 + ((x * 7 + y * 13) % 5) * 0.01; // 8-12 cm turf
          r[idx] = 70;
          g[idx] = 170;
          b[idx] = 55; // Lawn grass ExG = 340 - 70 - 55 = 215
        }

        // 3. Shrub & Boxwood Hedge Perimeter (x: 95..190, y: 88..105)
        else if (x >= 95 && x <= 190 && y >= 88 && y <= 105) {
          mask[idx] = 0;
          dsm[idx] = groundElev + 1.35 + Math.sin(x * 0.2) * 0.25; // 1.10m - 1.60m hedge
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

    const bundle: SolarDataLayersBundle = {
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
      grassMaxHeightMeters: 0.35,
      shrubMaxHeightMeters: 2.50,
      minVegetationExG: 10.0,
      dtmFilterRadiusMeters: 2.0
    });

    const result = classifier.segmentFoliage(bundle);

    // Validate classifications
    expect(result.stats.treeCanopyAreaM2).toBeGreaterThan(30.0);
    expect(result.stats.shrubBushAreaM2).toBeGreaterThan(10.0);
    expect(result.stats.turfGrassAreaM2).toBeGreaterThan(40.0);
    expect(result.stats.buildingAreaM2).toBeGreaterThan(30.0);
    expect(result.stats.totalTreeCountEstimate).toBeGreaterThanOrEqual(2);

    // Composite 3-panel visualization:
    // Panel 1: RGB Orthophoto
    // Panel 2: nDSM Height Heatmap
    // Panel 3: Multi-Class Foliage Segmentation Map
    const panelW = width;
    const panelH = height;
    const margin = 16;
    const topHeaderH = 48;
    const bottomLegendH = 40;
    const compW = panelW * 3 + margin * 4;
    const compH = panelH + topHeaderH + bottomLegendH;

    const compRgba = Buffer.alloc(compW * compH * 4, 255);

    // Dark studio background (#1e222b)
    for (let i = 0; i < compW * compH; i++) {
      compRgba[i * 4] = 30;
      compRgba[i * 4 + 1] = 34;
      compRgba[i * 4 + 2] = 43;
      compRgba[i * 4 + 3] = 255;
    }

    function setPixel(cx: number, cy: number, red: number, green: number, blue: number) {
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
        setPixel(p1X + px, p1Y + py, r[srcIdx], g[srcIdx], b[srcIdx]);
      }
    }

    // Draw Panel 2: nDSM Height Heatmap
    const p2X = margin * 2 + panelW;
    const p2Y = topHeaderH;
    const maxVisHeight = 15.0;
    for (let py = 0; py < panelH; py++) {
      for (let px = 0; px < panelW; px++) {
        const srcIdx = py * panelW + px;
        const hNorm = Math.min(1.0, Math.max(0.0, result.ndsm[srcIdx] / maxVisHeight));
        let hr = 0, hg = 0, hb = 0;
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
        setPixel(p2X + px, p2Y + py, hr, hg, hb);
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
        setPixel(p3X + px, p3Y + py, color[0], color[1], color[2]);
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

    const swatchY = compH - bottomLegendH + 12;
    const itemW = Math.floor(compW / legendItems.length);

    legendItems.forEach((item, idx) => {
      const swatchX = idx * itemW + 28;
      for (let sy = 0; sy < 16; sy++) {
        for (let sx = 0; sx < 24; sx++) {
          setPixel(swatchX + sx, swatchY + sy, item.color[0], item.color[1], item.color[2]);
        }
      }
    });

    const finalPng = encodePng(compW, compH, compRgba);
    const outPath = '/Users/eligreen/.gemini/antigravity/brain/a4b13200-846d-4dd5-a3b8-35762daf824b/google_solar_foliage_segmentation_proof.png';
    fs.writeFileSync(outPath, finalPng);

    expect(fs.existsSync(outPath)).toBe(true);
    expect(finalPng.length).toBeGreaterThan(1000);
    console.log(`Saved visual proof artifact: ${outPath} (${(finalPng.length / 1024).toFixed(1)} KB)`);
  });
});
