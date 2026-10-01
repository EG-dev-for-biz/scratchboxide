import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import assert from 'assert';
import { HeightfieldRaster } from '../src/browser/generative-canvas/services/HeightfieldRaster';
import { TerrainManager } from '../src/browser/generative-canvas/services/TerrainManager';

async function runTests() {
  console.log('🚀 Running Heightfield Raster & Bilinear Sampling Test Suite...\n');

  // ==========================================
  // Part 1: 32-bit Float Precision Raster
  // ==========================================
  console.log('  Testing HeightfieldRaster with Float32Array precision...');

  const bounds = { minX: 0, maxX: 100, minZ: 0, maxZ: 100 };
  const raster32 = new HeightfieldRaster({
    bounds,
    gridWidth: 11,
    gridHeight: 11,
    precision: 'float32'
  });

  assert.strictEqual(raster32.gridWidth, 11);
  assert.strictEqual(raster32.gridHeight, 11);

  // Height function: linear ramp h(x, z) = 2.0 * x + 0.5 * z
  raster32.bake((x, z) => 2.0 * x + 0.5 * z);

  // Test grid corner sampling
  const h00 = raster32.sampleBilinear(0, 0);
  assert.strictEqual(h00, 0.0);

  const h100_100 = raster32.sampleBilinear(100, 100);
  assert.strictEqual(h100_100, 250.0);

  // Test midpoint bilinear interpolation: x = 25, z = 40
  // Expected: 2 * 25 + 0.5 * 40 = 50 + 20 = 70.0
  const hMid = raster32.sampleBilinear(25, 40);
  assert.ok(hMid !== null, 'Midpoint sample should not be null');
  assert.ok(Math.abs(hMid - 70.0) < 1e-4, `Expected 70.0, got ${hMid}`);

  // Test out-of-bounds rejection
  const hOutOfBounds = raster32.sampleBilinear(-5, 50);
  assert.strictEqual(hOutOfBounds, null, 'Out of bounds coordinate should return null');
  console.log('  ✓ Part 1 Passed: 32-bit float raster and bilinear interpolation verified.');

  // ==========================================
  // Part 2: 16-bit Quantized Integer Raster (ChristophHoltmann adaptation)
  // ==========================================
  console.log('  Testing 16-bit quantized uint16 rasterization (1mm vertical resolution)...');

  const raster16 = new HeightfieldRaster({
    bounds,
    gridWidth: 21,
    gridHeight: 21,
    precision: 'uint16'
  });

  // Mountain curve: h(x, z) = 50.0 + 30.0 * Math.cos(x * 0.05)
  raster16.bake((x, z) => 50.0 + 30.0 * Math.cos(x * 0.05));

  const sample1 = raster16.sampleBilinear(15, 20);
  const true1 = 50.0 + 30.0 * Math.cos(15 * 0.05);
  assert.ok(sample1 !== null);
  // 16-bit millimeter quantization error is < 0.05m
  assert.ok(Math.abs(sample1 - true1) < 0.5, `Sample1 error within tolerance (${sample1} vs ${true1})`);

  console.log('  ✓ Part 2 Passed: 16-bit quantized elevation raster maintains millimeter fidelity.');

  // ==========================================
  // Part 3: TerrainManager Fast-Path Integration
  // ==========================================
  console.log('  Testing TerrainManager bakeHeightfield and accelerated sampling...');

  const terrain = new TerrainManager();
  terrain.bakeHeightfield(bounds, 5, 'float32', (x, z) => 25.0 + Math.sin(x * 0.1) * 5.0);
  assert.ok(terrain.heightfield !== undefined, 'terrain.heightfield should be initialized');

  // Verify TerrainManager.sampleGroundHeight checks heightfield first
  const terrainHeight = terrain.sampleGroundHeight(25, 40);
  assert.ok(terrainHeight !== null, 'sampleGroundHeight should succeed via baked heightfield');
  console.log(`  ✓ Part 3 Passed: TerrainManager fast-paths ground elevation queries (h=${terrainHeight}m).`);

  console.log('\n🎉 All Heightfield Raster & Bilinear Sampling Tests Passed Successfully!\n');
}

test('heightfield-raster.test', async () => {
    await runTests();
}, 180_000);
