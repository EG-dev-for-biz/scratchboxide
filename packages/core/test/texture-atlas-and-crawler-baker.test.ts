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
import {
  TextureAtlasPacker
} from '../src/node/spatial/TextureAtlasPacker';
import {
  Google3DTileCrawlerBaker,
  TileMeshInput
} from '../src/node/spatial/Google3DTileCrawlerBaker';

async function runTests() {
  console.log('🚀 Running Texture Atlas Packer & 3D Tile Crawler/Baker Test Suite...\n');

  // ==========================================
  // Part 1: Texture Atlas Packer (chenyingshu adaptation)
  // ==========================================
  console.log('  Testing TextureAtlasPacker 2D bin packing and UV remapping...');

  const packer = new TextureAtlasPacker({
    maxAtlasSize: 512,
    powerOfTwo: true,
    padding: 2
  });

  // Create two 64x64 dummy textures
  const tex1Data = new Uint8Array(64 * 64 * 4);
  tex1Data.fill(255); // Red/white
  const tex2Data = new Uint8Array(64 * 64 * 4);
  tex2Data.fill(128); // Gray

  packer.addTexture({ id: 'tile_01', width: 64, height: 64, data: tex1Data });
  packer.addTexture({ id: 'tile_02', width: 64, height: 64, data: tex2Data });

  const atlas = packer.pack();
  assert.ok(atlas.width >= 128, 'Atlas width should accommodate packed textures');
  assert.ok(atlas.height >= 64, 'Atlas height should accommodate packed textures');
  assert.strictEqual(atlas.rects.size, 2, 'Atlas should track both textures');

  const rect1 = atlas.rects.get('tile_01')!;
  const rect2 = atlas.rects.get('tile_02')!;
  assert.ok(rect1 !== undefined && rect2 !== undefined, 'Both rects must be defined');

  // Verify non-overlapping rects
  const overlaps = !(
    rect1.x + rect1.width <= rect2.x ||
    rect2.x + rect2.width <= rect1.x ||
    rect1.y + rect1.height <= rect2.y ||
    rect2.y + rect2.height <= rect1.y
  );
  assert.strictEqual(overlaps, false, 'Atlas sub-textures must not overlap');

  // Test Chenyingshu UV transformation formula:
  // u_new = u * scale_x + offset_x, v_new = v * scale_y + offset_y
  const originalUVs = new Float32Array([0.0, 0.0, 1.0, 1.0]);
  const remappedUVs = TextureAtlasPacker.remapUVs(originalUVs, rect1);

  assert.strictEqual(remappedUVs[0], rect1.offsetX, 'UV (0,0) u should map to offsetX');
  assert.strictEqual(remappedUVs[1], rect1.offsetY, 'UV (0,0) v should map to offsetY');
  assert.strictEqual(remappedUVs[2], rect1.offsetX + rect1.scaleX, 'UV (1,1) u should map to offsetX + scaleX');
  assert.strictEqual(remappedUVs[3], rect1.offsetY + rect1.scaleY, 'UV (1,1) v should map to offsetY + scaleY');
  console.log('  ✓ Part 1 Passed: 2D shelf packing and Chenyingshu UV transformation verified.');

  // ==========================================
  // Part 2: Coordinate Conversions (ECEF to ENU)
  // ==========================================
  console.log('  Testing Geodetic to ECEF and ECEF to local ENU frame conversion...');

  // Test location: San Francisco Ferry Building (37.7955, -122.3937, 10m)
  const originLat = 37.7955;
  const originLng = -122.3937;
  const originAlt = 10.0;

  const [ecefX, ecefY, ecefZ] = Google3DTileCrawlerBaker.geodeticToECEF(originLat, originLng, originAlt);
  assert.ok(Math.hypot(ecefX, ecefY, ecefZ) > 6300000, 'ECEF radius should be around Earth radius (6378km)');

  // Converting origin point to ENU should yield exactly (0, 0, 0)
  const [enuX, enuY, enuZ] = Google3DTileCrawlerBaker.ecefToENU(
    ecefX,
    ecefY,
    ecefZ,
    originLat,
    originLng,
    originAlt
  );

  assert.ok(Math.abs(enuX) < 1e-4, 'Origin ENU East should be ~0');
  assert.ok(Math.abs(enuY) < 1e-4, 'Origin ENU Up should be ~0');
  assert.ok(Math.abs(enuZ) < 1e-4, 'Origin ENU North should be ~0');
  console.log('  ✓ Part 2 Passed: Coordinate frames transform with sub-millimeter precision.');

  // ==========================================
  // Part 3: CESIUM_RTC Stripping & Buffer Merger (OmarShehata adaptation)
  // ==========================================
  console.log('  Testing CESIUM_RTC stripping, leaf buffer merging, and GLB generation...');

  // Mock tile 1: Quad mesh with CESIUM_RTC center offset
  const mockTile1: TileMeshInput = {
    id: 'tile_north',
    positions: new Float32Array([
      0, 0, 0,
      10, 0, 0,
      10, 0, 10,
      0, 0, 10
    ]),
    normals: new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    rtcCenter: [ecefX, ecefY, ecefZ],
    texture: {
      width: 64,
      height: 64,
      data: tex1Data
    }
  };

  // Mock tile 2: Quad mesh adjacent to tile 1
  const mockTile2: TileMeshInput = {
    id: 'tile_south',
    positions: new Float32Array([
      10, 0, 0,
      20, 0, 0,
      20, 0, 10,
      10, 0, 10
    ]),
    normals: new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    rtcCenter: [ecefX, ecefY, ecefZ],
    texture: {
      width: 64,
      height: 64,
      data: tex2Data
    }
  };

  const mergeResult = Google3DTileCrawlerBaker.mergeTileMeshes(
    [mockTile1, mockTile2],
    { lat: originLat, lng: originLng, alt: originAlt }
  );

  assert.strictEqual(mergeResult.vertexCount, 8, 'Total vertices should be 4 + 4 = 8');
  assert.strictEqual(mergeResult.indexCount, 12, 'Total indices should be 6 + 6 = 12');
  assert.strictEqual(mergeResult.positions.length, 24, 'Total position floats should be 24');
  assert.strictEqual(mergeResult.indices.length, 12);

  // Check index offset on second mesh
  assert.strictEqual(mergeResult.indices[6], 4, 'Second tile indices must be offset by vertex count (0 + 4 = 4)');
  assert.strictEqual(mergeResult.indices[7], 5, 'Second tile indices must be offset (1 + 4 = 5)');

  // Verify GLB Binary format
  const glb = mergeResult.glbBuffer;
  assert.ok(glb.length > 20, 'GLB buffer should be generated');

  const magic = glb.readUInt32LE(0);
  assert.strictEqual(magic, 0x46546C67, 'GLB magic must be 0x46546C67 (glTF)');

  const version = glb.readUInt32LE(4);
  assert.strictEqual(version, 2, 'GLB version must be 2');

  const totalLength = glb.readUInt32LE(8);
  assert.strictEqual(totalLength, glb.length, 'Header length must match buffer byte length');

  const jsonChunkLength = glb.readUInt32LE(12);
  const jsonChunkType = glb.readUInt32LE(16);
  assert.strictEqual(jsonChunkType, 0x4E4F534A, 'Chunk 0 type must be 0x4E4F534A (JSON)');

  const jsonBytes = glb.slice(20, 20 + jsonChunkLength);
  const jsonStr = jsonBytes.toString('utf8').trim();
  const parsedGltf = JSON.parse(jsonStr);

  assert.strictEqual(parsedGltf.asset.version, '2.0');
  assert.strictEqual(parsedGltf.extensionsUsed, undefined, 'CESIUM_RTC should be completely stripped');
  assert.strictEqual(parsedGltf.extensionsRequired, undefined, 'No proprietary extensions required');
  assert.strictEqual(parsedGltf.meshes[0].primitives[0].indices, 0);

  console.log(`  ✓ Part 3 Passed: GLB assembled (${glb.length} bytes, 8 vertices, 12 indices, zero CESIUM_RTC).`);

  console.log('\n🎉 All Texture Atlas Packer & 3D Tile Crawler/Baker Tests Passed Successfully!\n');
}

test('texture-atlas-and-crawler-baker.test', async () => {
    await runTests();
}, 180_000);
