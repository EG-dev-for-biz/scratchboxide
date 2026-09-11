/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'assert';
import {
  computeFlattenBounds,
  isPointInPolygon,
  bakeFlattenHeightfield,
  buildFlattenRegionFromPolygon,
  FlattenFootprintPoint
} from '../src/browser/generative-canvas/services/mesh/FlattenRegion';
import {
  GooglePhotorealistic3DTilesLayer
} from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';

async function runTests() {
  console.log('🚀 Running Shader Terrain Excavation & Polygon Flattening Test Suite...\n');

  // Test polygon: 20m x 20m square centered at (0, 0)
  const squarePoly: FlattenFootprintPoint[] = [
    { x: -10, z: -10 },
    { x: 10, z: -10 },
    { x: 10, z: 10 },
    { x: -10, z: 10 }
  ];

  // Test 1: computeFlattenBounds
  console.log('  Testing computeFlattenBounds...');
  const unpadded = computeFlattenBounds(squarePoly, 0);
  assert.strictEqual(unpadded.min[0], -10);
  assert.strictEqual(unpadded.min[1], -10);
  assert.strictEqual(unpadded.max[0], 10);
  assert.strictEqual(unpadded.max[1], 10);

  const padded = computeFlattenBounds(squarePoly, 2);
  assert.strictEqual(padded.min[0], -12);
  assert.strictEqual(padded.min[1], -12);
  assert.strictEqual(padded.max[0], 12);
  const bounds = padded;
  console.log('  ✓ Test 1 Passed: computeFlattenBounds correctly computes bounding box with and without padding.');

  // Test 2: isPointInPolygon ray-casting math
  console.log('  Testing isPointInPolygon...');
  assert.strictEqual(isPointInPolygon(0, 0, squarePoly, bounds.min, bounds.max), true, 'Center (0,0) should be inside');
  assert.strictEqual(isPointInPolygon(5, 5, squarePoly, bounds.min, bounds.max), true, '(5,5) should be inside');
  assert.strictEqual(isPointInPolygon(-5, -5, squarePoly, bounds.min, bounds.max), true, '(-5,-5) should be inside');
  assert.strictEqual(isPointInPolygon(15, 0, squarePoly, bounds.min, bounds.max), false, '(15,0) should be outside');
  assert.strictEqual(isPointInPolygon(0, -15, squarePoly, bounds.min, bounds.max), false, '(0,-15) should be outside');
  console.log('  ✓ Test 2 Passed: isPointInPolygon accurately classifies inside and outside coordinates.');

  // Test 3: bakeFlattenHeightfield
  console.log('  Testing bakeFlattenHeightfield rasterization...');
  const sampleGround = (x: number, z: number) => 15.0 + Math.sin(x * 0.1) * 2.0;
  const baked = bakeFlattenHeightfield(sampleGround, bounds.min, bounds.max, 8);
  assert.strictEqual(baked.gridSize, 8);
  assert.strictEqual(baked.heightfield.length, 64);
  assert.ok(baked.avgGroundY > 12 && baked.avgGroundY < 18, 'Average ground height should be within expected range');
  console.log(`  ✓ Test 3 Passed: Heightfield baked across 8x8 grid (avgY=${baked.avgGroundY.toFixed(2)}m).`);

  // Test 4: buildFlattenRegionFromPolygon
  console.log('  Testing buildFlattenRegionFromPolygon region patch builder...');
  const patch = buildFlattenRegionFromPolygon(sampleGround, squarePoly, { margin: 1.2, gridSize: 16 });
  assert.strictEqual(patch.flattenPolygon.length, 4);
  assert.strictEqual(patch.flattenMargin, 1.2);
  assert.strictEqual(patch.flattenGridSize, 16);
  assert.strictEqual(patch.flattenHeightfield.length, 256);
  console.log('  ✓ Test 4 Passed: buildFlattenRegionFromPolygon produces complete terrain patch.');

  // Test 5: GooglePhotorealistic3DTilesLayer shader uniform integration
  console.log('  Testing GooglePhotorealistic3DTilesLayer applyFlattenPolygon and clearFlattenPolygon...');
  const tilesLayer = new GooglePhotorealistic3DTilesLayer();
  const uniforms = (tilesLayer as any).styleUniforms;

  assert.strictEqual(uniforms.uFlattenActive.value, 0.0, 'Flattening should initially be inactive');
  assert.strictEqual(uniforms.uFlattenPolyCount.value, 0);

  // Apply polygon excavation (excavate 2.5m for foundation / basement)
  tilesLayer.applyFlattenPolygon(squarePoly, sampleGround, {
    margin: 0.5,
    gridSize: 16,
    excavateDepth: 2.5
  });

  assert.strictEqual(uniforms.uFlattenActive.value, 1.0, 'uFlattenActive should be 1.0 after apply');
  assert.strictEqual(uniforms.uFlattenPolyCount.value, 4, 'uFlattenPolyCount should be 4');
  assert.strictEqual(uniforms.uFlattenMargin.value, 0.5);
  assert.strictEqual(uniforms.uFlattenExcavateDepth.value, 2.5);
  assert.strictEqual(uniforms.uFlattenBoundsMin.value.x, -12);
  assert.strictEqual(uniforms.uFlattenBoundsMax.value.x, 12);
  assert.ok(uniforms.uFlattenHeightTex.value !== null, 'Height texture should be created');

  // Clear polygon flattening
  tilesLayer.clearFlattenPolygon();
  assert.strictEqual(uniforms.uFlattenActive.value, 0.0, 'uFlattenActive should be reset to 0.0');
  assert.strictEqual(uniforms.uFlattenPolyCount.value, 0, 'uFlattenPolyCount should be reset to 0');
  console.log('  ✓ Test 5 Passed: GooglePhotorealistic3DTilesLayer shader uniforms updated and cleared correctly.');

  console.log('\n🎉 All Shader Terrain Excavation & Polygon Flattening Tests Passed Successfully!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
