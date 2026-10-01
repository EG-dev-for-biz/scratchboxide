/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  FoliageClass,
  FOLIAGE_CLASS_NAMES,
  FOLIAGE_CLASS_COLORS,
  SolarDataLayersBundle,
  GeoTiffRasterMetadata
} from '../src/common/spatial/GoogleSolarDataLayersTypes';
import {
  GeoTiffRasterParser,
  TIFF_TAGS,
  TIFF_TYPES
} from '../src/node/spatial/GeoTiffRasterParser';
import { GoogleSolarFoliageClassifier } from '../src/node/spatial/GoogleSolarFoliageClassifier';

describe('GeoTiffRasterParser', () => {
  it('encodes and decodes a 32-bit floating point DSM GeoTIFF correctly', () => {
    const width = 16;
    const height = 16;
    const dsmData = new Float32Array(width * height);

    // Flat ground at 20.0m with a 10m tall tree mound in the center
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - 8;
        const dy = y - 8;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 4) {
          dsmData[y * width + x] = 20.0 + (4 - dist) * 2.5; // up to 30.0m
        } else {
          dsmData[y * width + x] = 20.0;
        }
      }
    }

    const tiffBuffer = GeoTiffRasterParser.encodeGeoTiff({
      width,
      height,
      data: dsmData,
      channels: 1,
      bitsPerSample: 32,
      sampleFormat: 3,
      pixelScale: [0.1, 0.1, 0.0],
      tiePoint: [0, 0, 0, 12.4923, 41.8902, 0.0]
    });

    expect(tiffBuffer).toBeInstanceOf(Buffer);
    expect(tiffBuffer.length).toBeGreaterThan(width * height * 4);

    // Decode back
    const decoded = GeoTiffRasterParser.decodeFloat32Dsm(tiffBuffer);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.metadata.pixelScale.scaleX).toBeCloseTo(0.1, 5);
    expect(decoded.metadata.pixelScale.scaleY).toBeCloseTo(0.1, 5);
    expect(decoded.metadata.tiePoint.x).toBeCloseTo(12.4923, 5);
    expect(decoded.metadata.tiePoint.y).toBeCloseTo(41.8902, 5);

    // Check center pixel elevation
    expect(decoded.data[8 * width + 8]).toBeCloseTo(30.0, 2);
    // Check corner pixel elevation
    expect(decoded.data[0]).toBeCloseTo(20.0, 2);
  });

  it('encodes and decodes an 8-bit true color RGB orthophoto GeoTIFF', () => {
    const width = 8;
    const height = 8;
    const numPixels = width * height;
    const rgbData = new Uint8Array(numPixels * 3);

    // Set green vegetation in center, grey pavement elsewhere
    for (let i = 0; i < numPixels; i++) {
      if (i >= 20 && i <= 44) {
        // Lush foliage: R=35, G=140, B=45
        rgbData[i * 3] = 35;
        rgbData[i * 3 + 1] = 140;
        rgbData[i * 3 + 2] = 45;
      } else {
        // Asphalt pavement: R=110, G=110, B=115
        rgbData[i * 3] = 110;
        rgbData[i * 3 + 1] = 110;
        rgbData[i * 3 + 2] = 115;
      }
    }

    const tiffBuffer = GeoTiffRasterParser.encodeGeoTiff({
      width,
      height,
      data: rgbData,
      channels: 3,
      bitsPerSample: 8,
      sampleFormat: 1,
      pixelScale: [0.1, 0.1, 0.0],
      tiePoint: [0, 0, 0, 12.4923, 41.8902, 0.0],
      compressDeflate: true
    });

    const decoded = GeoTiffRasterParser.decodeRgbOrthophoto(tiffBuffer);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.r[0]).toBe(110);
    expect(decoded.g[0]).toBe(110);
    expect(decoded.b[0]).toBe(115);
    expect(decoded.r[25]).toBe(35);
    expect(decoded.g[25]).toBe(140);
    expect(decoded.b[25]).toBe(45);
  });

  it('encodes and decodes a building mask GeoTIFF', () => {
    const width = 10;
    const height = 10;
    const maskData = new Uint8Array(width * height);

    // Building rooftop occupying top-left 4x4
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        maskData[y * width + x] = 1;
      }
    }

    const tiffBuffer = GeoTiffRasterParser.encodeGeoTiff({
      width,
      height,
      data: maskData,
      channels: 1,
      bitsPerSample: 8,
      sampleFormat: 1
    });

    const decoded = GeoTiffRasterParser.decodeBuildingMask(tiffBuffer);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.mask[0]).toBe(1);
    expect(decoded.mask[3 * width + 3]).toBe(1);
    expect(decoded.mask[5 * width + 5]).toBe(0);
  });
});

describe('GoogleSolarFoliageClassifier', () => {
  const width = 40;
  const height = 40;
  const numPixels = width * height;
  const pixelScaleMeters = 0.1; // 10 cm per pixel

  const originLat = 41.8902;
  const originLng = 12.4923;

  function createTestSyntheticBundle(): SolarDataLayersBundle {
    const dsm = new Float32Array(numPixels);
    const mask = new Uint8Array(numPixels);
    const r = new Uint8Array(numPixels);
    const g = new Uint8Array(numPixels);
    const b = new Uint8Array(numPixels);

    const groundElevation = 20.0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;

        // Default: flat asphalt ground
        dsm[idx] = groundElevation;
        mask[idx] = 0;
        r[idx] = 115;
        g[idx] = 115;
        b[idx] = 120; // Pavement ExG = 2*115 - 115 - 120 = -5

        // Region 1: Architectural Building (x: 2..12, y: 2..12)
        if (x >= 2 && x <= 12 && y >= 2 && y <= 12) {
          mask[idx] = 1; // Rooftop mask
          dsm[idx] = groundElevation + 12.0; // 12m tall building
          r[idx] = 160;
          g[idx] = 150;
          b[idx] = 140; // Travertine roof tile
        }

        // Region 2: Overstory Tree Canopy (x: 18..28, y: 4..14)
        const treeCenterDist = Math.hypot(x - 23, y - 9);
        if (treeCenterDist <= 5) {
          mask[idx] = 0;
          // Crown height peaking at 7.5m above ground
          dsm[idx] = groundElevation + 7.5 - treeCenterDist * 0.4;
          r[idx] = 30;
          g[idx] = 135;
          b[idx] = 38; // Lush green ExG = 270 - 30 - 38 = 202
        }

        // Region 3: Bush / Shrub Hedge (x: 18..28, y: 20..26)
        if (x >= 18 && x <= 28 && y >= 20 && y <= 26) {
          mask[idx] = 0;
          dsm[idx] = groundElevation + 1.2; // 1.2m tall shrub
          r[idx] = 45;
          g[idx] = 145;
          b[idx] = 50; // Dense shrub green ExG = 290 - 45 - 50 = 195
        }

        // Region 4: Lawn / Turf Grass (x: 4..14, y: 22..36)
        if (x >= 4 && x <= 14 && y >= 22 && y <= 36) {
          mask[idx] = 0;
          dsm[idx] = groundElevation + 0.08; // 8 cm tall lawn grass
          r[idx] = 75;
          g[idx] = 165;
          b[idx] = 60; // Bright grass ExG = 330 - 75 - 60 = 195
        }
      }
    }

    const metadata: GeoTiffRasterMetadata = {
      width,
      height,
      pixelScale: { scaleX: pixelScaleMeters, scaleY: pixelScaleMeters, scaleZ: 1.0 },
      tiePoint: { i: 0, j: 0, k: 0, x: originLng, y: originLat, z: 0.0 },
      boundingBox: {
        sw: { latitude: originLat - height * (pixelScaleMeters / 111000.0), longitude: originLng },
        ne: { latitude: originLat, longitude: originLng + width * (pixelScaleMeters / (111000.0 * Math.cos(originLat * Math.PI / 180))) }
      },
      noDataValue: -9999
    };

    return {
      dsm,
      rgb: { r, g, b },
      mask,
      metadata
    };
  }

  it('correctly classifies Turf Grass, Bushes/Shrubs, and Trees by nDSM elevation and ExG', () => {
    const bundle = createTestSyntheticBundle();
    const classifier = new GoogleSolarFoliageClassifier({
      grassMaxHeightMeters: 0.25,
      shrubMaxHeightMeters: 2.50,
      minVegetationExG: 10.0
    });

    const result = classifier.segmentFoliage(bundle);

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);

    // 1. Check Building Rooftop pixel (x: 5, y: 5)
    expect(result.classificationMap[5 * width + 5]).toBe(FoliageClass.ARCHITECTURE_BUILDING);

    // 2. Check Overstory Tree Canopy pixel at tree center (x: 23, y: 9)
    expect(result.classificationMap[9 * width + 23]).toBe(FoliageClass.TREE_CANOPY);
    expect(result.ndsm[9 * width + 23]).toBeGreaterThanOrEqual(2.50);

    // 3. Check Bush / Shrub Hedge pixel (x: 22, y: 23)
    expect(result.classificationMap[23 * width + 22]).toBe(FoliageClass.BUSH_SHRUB);
    expect(result.ndsm[23 * width + 22]).toBeGreaterThanOrEqual(0.25);
    expect(result.ndsm[23 * width + 22]).toBeLessThan(2.50);

    // 4. Check Lawn / Turf Grass pixel (x: 8, y: 28)
    expect(result.classificationMap[28 * width + 8]).toBe(FoliageClass.TURF_GRASS);
    expect(result.ndsm[28 * width + 8]).toBeLessThan(0.25);

    // 5. Check Pavement / Hardscape pixel (x: 35, y: 35)
    expect(result.classificationMap[35 * width + 35]).toBe(FoliageClass.HARDSCAPE_PAVEMENT);

    // Validate statistics telemetry
    expect(result.stats.treeCanopyAreaM2).toBeGreaterThan(0);
    expect(result.stats.shrubBushAreaM2).toBeGreaterThan(0);
    expect(result.stats.turfGrassAreaM2).toBeGreaterThan(0);
    expect(result.stats.buildingAreaM2).toBeGreaterThan(0);
    expect(result.stats.hardscapeAreaM2).toBeGreaterThan(0);
    expect(result.stats.meanTreeHeightMeters).toBeGreaterThan(4.0);
    expect(result.stats.meanShrubHeightMeters).toBeCloseTo(1.2, 1);
    expect(result.stats.totalTreeCountEstimate).toBeGreaterThanOrEqual(1);
  });

  it('correctly maps 3D metric coordinates into foliage classes', () => {
    const bundle = createTestSyntheticBundle();
    const classifier = new GoogleSolarFoliageClassifier();
    const result = classifier.segmentFoliage(bundle);

    // Tree center is at pixel (23, 9)
    // Pixel scale = 0.1m, top-left is (0, 0)
    // World coordinates relative to anchor:
    // x = +2.3m (East)
    // y = 0
    // z = -0.9m (North in Three.js is -Z, so 9 * 0.1m South is z = +0.9m, -Z is North)
    const treeWorldPos = { x: 2.3, y: 0.0, z: -0.9 };
    const anchorGeo = { latitude: originLat, longitude: originLng };

    // Notice: tiePoint is at top-left (y: originLat, x: originLng).
    // In our raster, row 0 is top (North), row height-1 is bottom (South).
    // Moving south corresponds to decreasing latitude.
    // In classifyPoint3D: dNorth = -worldPos.z. If worldPos.z = 0.9, dNorth = -0.9 (South).
    const queriedClass = result.classifyPoint3D({ x: 2.3, y: 0.0, z: 0.9 }, anchorGeo);
    expect(queriedClass).toBe(FoliageClass.TREE_CANOPY);
  });

  it('generates a semantic RGB visualization buffer matching FOLIAGE_CLASS_COLORS', () => {
    const bundle = createTestSyntheticBundle();
    const classifier = new GoogleSolarFoliageClassifier();
    const result = classifier.segmentFoliage(bundle);

    const rgb = classifier.generateSemanticRgbBuffer(result);
    expect(rgb.length).toBe(width * height * 3);

    // Check tree center pixel color
    const treeIdx = 9 * width + 23;
    const treeColor = FOLIAGE_CLASS_COLORS[FoliageClass.TREE_CANOPY];
    expect(rgb[treeIdx * 3]).toBe(treeColor[0]);
    expect(rgb[treeIdx * 3 + 1]).toBe(treeColor[1]);
    expect(rgb[treeIdx * 3 + 2]).toBe(treeColor[2]);

    // Check grass pixel color
    const grassIdx = 28 * width + 8;
    const grassColor = FOLIAGE_CLASS_COLORS[FoliageClass.TURF_GRASS];
    expect(rgb[grassIdx * 3]).toBe(grassColor[0]);
    expect(rgb[grassIdx * 3 + 1]).toBe(grassColor[1]);
    expect(rgb[grassIdx * 3 + 2]).toBe(grassColor[2]);
  });

  it('handles end-to-end GeoTIFF buffer pipeline seamlessly', () => {
    const bundle = createTestSyntheticBundle();

    // Encode all 3 rasters to real GeoTIFF byte buffers
    const dsmTiff = GeoTiffRasterParser.encodeGeoTiff({
      width,
      height,
      data: bundle.dsm,
      channels: 1,
      bitsPerSample: 32,
      sampleFormat: 3,
      pixelScale: [0.1, 0.1, 0.0],
      tiePoint: [0, 0, 0, originLng, originLat, 0.0]
    });

    const rgbData = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgbData[i * 3] = bundle.rgb.r[i];
      rgbData[i * 3 + 1] = bundle.rgb.g[i];
      rgbData[i * 3 + 2] = bundle.rgb.b[i];
    }

    const rgbTiff = GeoTiffRasterParser.encodeGeoTiff({
      width,
      height,
      data: rgbData,
      channels: 3,
      bitsPerSample: 8,
      sampleFormat: 1,
      pixelScale: [0.1, 0.1, 0.0],
      tiePoint: [0, 0, 0, originLng, originLat, 0.0]
    });

    const maskTiff = GeoTiffRasterParser.encodeGeoTiff({
      width,
      height,
      data: bundle.mask,
      channels: 1,
      bitsPerSample: 8,
      sampleFormat: 1,
      pixelScale: [0.1, 0.1, 0.0],
      tiePoint: [0, 0, 0, originLng, originLat, 0.0]
    });

    // Ingest directly from raw buffers
    const classifier = new GoogleSolarFoliageClassifier();
    const result = classifier.segmentFromBuffers(dsmTiff, rgbTiff, maskTiff);

    expect(result.classificationMap[9 * width + 23]).toBe(FoliageClass.TREE_CANOPY);
    expect(result.classificationMap[23 * width + 22]).toBe(FoliageClass.BUSH_SHRUB);
    expect(result.classificationMap[28 * width + 8]).toBe(FoliageClass.TURF_GRASS);
    expect(result.classificationMap[5 * width + 5]).toBe(FoliageClass.ARCHITECTURE_BUILDING);
  });
});
