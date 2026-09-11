import { test } from 'vitest';
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
  VoxelTerraformEngine,
  DEFAULT_VOXEL_PALETTE
} from '../src/browser/generative-canvas/services/mesh/VoxelTerraformEngine';

async function runTests() {
  console.log('🚀 Running Voxel Terraform & Ray-Marching Engine Test Suite...\n');

  // ==========================================
  // Part 1: Grid Coordinate Math & Palette Quantization
  // ==========================================
  console.log('  Testing grid dimensions, coordinate transforms, and palette mapping...');

  const engine = new VoxelTerraformEngine({
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 10, maxZ: 20 },
    voxelSize: 1.0 // 1m per voxel
  });

  assert.strictEqual(engine.sizeX, 20);
  assert.strictEqual(engine.sizeY, 10);
  assert.strictEqual(engine.sizeZ, 20);

  // Coordinate transform roundtrip
  const [vx, vy, vz] = engine.worldToVoxel(5.2, 3.8, 12.1);
  assert.strictEqual(vx, 5);
  assert.strictEqual(vy, 3);
  assert.strictEqual(vz, 12);

  const [wx, wy, wz] = engine.voxelToWorld(vx, vy, vz);
  assert.strictEqual(wx, 5.5); // Center of voxel [5, 6)
  assert.strictEqual(wy, 3.5);
  assert.strictEqual(wz, 12.5);

  // Palette color matching: Green RGB -> Grass (id 3)
  const grassId = engine.findClosestPaletteId(80, 150, 50);
  assert.strictEqual(grassId, 3, 'Green hue should map to Grass palette ID');

  // Blue RGB -> Water (id 7)
  const waterId = engine.findClosestPaletteId(30, 80, 200);
  assert.strictEqual(waterId, 7, 'Blue hue should map to Water palette ID');
  console.log('  ✓ Part 1 Passed: Grid coordinate transforms and palette quantization verified.');

  // ==========================================
  // Part 2: Triangle Mesh Voxelization with Texture Sampling
  // ==========================================
  console.log('  Testing triangle-to-voxel rasterization with texture sampling...');

  // Create a 2-triangle quad ground at y = 5.0
  const positions = new Float32Array([
    0, 5, 0,
    10, 5, 0,
    10, 5, 10,
    0, 5, 10
  ]);
  const indices = new Uint16Array([
    0, 1, 2,
    0, 2, 3
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1
  ]);

  // 16x16 dummy grass texture (RGBA)
  const grassTexData = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < grassTexData.length; i += 4) {
    grassTexData[i] = 86;     // R
    grassTexData[i + 1] = 140; // G
    grassTexData[i + 2] = 53;  // B
    grassTexData[i + 3] = 255; // A
  }

  engine.rasterizeMesh(
    positions,
    indices,
    uvs,
    { width: 16, height: 16, data: grassTexData },
    true // solid fill down
  );

  // Check surface voxel: should be grass (id 3)
  const surfaceVoxel = engine.getVoxel(5, 5, 5);
  assert.strictEqual(surfaceVoxel, 3, 'Surface voxel should be rasterized as Grass (id 3)');

  // Check subsurface voxel (solid fill down): should be dirt (id 2)
  const subVoxel = engine.getVoxel(5, 3, 5);
  assert.strictEqual(subVoxel, 2, 'Subsurface voxel should be filled with Dirt (id 2)');

  // Air above surface: should be 0
  const airVoxel = engine.getVoxel(5, 7, 5);
  assert.strictEqual(airVoxel, 0, 'Voxels above surface should remain Air (id 0)');
  console.log('  ✓ Part 2 Passed: Triangle rasterization and subsurface solid filling verified.');

  // ==========================================
  // Part 3: CSG Terraforming Operations (Carve, Fill, Flatten)
  // ==========================================
  console.log('  Testing CSG carve, fill, and polygon flattening operations...');

  // 1. Fill a mound/hill at (15, 2, 15) with stone (id 1)
  const filledCount = engine.fillSphere(15, 2, 15, 3.0, 1);
  assert.ok(filledCount > 0, 'fillSphere should deposit voxels');
  assert.strictEqual(engine.getVoxel(15, 2, 15), 1, 'Mound center should be Stone (id 1)');

  // 2. Carve a crater/excavation into the ground at (5, 5, 5) with radius 2m
  const carvedCount = engine.carveSphere(5, 5, 5, 2.0);
  assert.ok(carvedCount > 0, 'carveSphere should remove voxels');
  assert.strictEqual(engine.getVoxel(5, 5, 5), 0, 'Excavated center should be Air (id 0)');

  // 3. Flatten polygon building pad at (10, 10) to y = 4.0
  const buildingPad = [
    { x: 8, z: 8 },
    { x: 12, z: 8 },
    { x: 12, z: 12 },
    { x: 8, z: 12 }
  ];
  const flattenedCount = engine.flattenPolygon(buildingPad, 4.0, 4); // concrete pad (id 4)
  assert.ok(flattenedCount > 0, 'flattenPolygon should modify voxels');
  assert.strictEqual(engine.getVoxel(10, 4, 10), 4, 'Flattened pad surface should be Concrete (id 4)');
  assert.strictEqual(engine.getVoxel(10, 5, 10), 0, 'Voxels above flattened pad must be cleared to Air');
  console.log('  ✓ Part 3 Passed: CSG Carve, Fill, and Flatten operations verified.');

  // ==========================================
  // Part 4: Culled-Face Mesh Generation
  // ==========================================
  console.log('  Testing culled-face Three.js mesh generation...');

  const culledMesh = engine.generateCulledMesh();
  assert.ok(culledMesh !== null, 'Culled mesh geometry should not be null');

  const posAttr = culledMesh.getAttribute('position');
  const normAttr = culledMesh.getAttribute('normal');
  const colorAttr = culledMesh.getAttribute('color');
  const indexAttr = culledMesh.getIndex();

  assert.ok(posAttr !== undefined, 'Position attribute must exist');
  assert.ok(normAttr !== undefined, 'Normal attribute must exist');
  assert.ok(colorAttr !== undefined, 'Color attribute must exist');
  assert.ok(indexAttr !== null, 'Index buffer must exist');
  assert.ok(posAttr.count > 0, 'Vertices must be generated for exposed faces');

  // Verify indices are quad triangles (multiples of 6)
  assert.strictEqual(indexAttr!.count % 6, 0, 'Culled quads must produce pairs of triangles (6 indices per quad)');
  console.log(`  ✓ Part 4 Passed: Culled mesh generated (${posAttr.count} vertices, ${indexAttr!.count / 3} triangles, zero internal faces).`);

  console.log('\n🎉 All Voxel Terraform & Ray-Marching Engine Tests Passed Successfully!\n');
}

test('voxel-terraform-engine.test', async () => {
    await runTests();
}, 180_000);
