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
  photorealTileCache,
  tileCacheKey,
  PhotorealTileCache
} from '../src/browser/generative-canvas/services/tiles/photorealTileCache';
import {
  PhotorealCachePlugin
} from '../src/browser/generative-canvas/services/tiles/PhotorealCachePlugin';

async function runTests() {
  console.log('🚀 Running Persistent Photoreal Tile Cache & Plugin Test Suite...\n');

  // Test 1: tileCacheKey normalizes session tokens and API keys
  console.log('  Testing tileCacheKey normalization...');
  const rawUrl1 = 'https://tile.googleapis.com/v1/3dtiles/tiles/7/32/45.glb?session=abc123xyz&key=AIzaSyD-TestKey-999';
  const rawUrl2 = 'https://tile.googleapis.com/v1/3dtiles/tiles/7/32/45.glb?key=AIzaSyD-TestKey-999&session=diffSession456';
  const key1 = tileCacheKey(rawUrl1);
  const key2 = tileCacheKey(rawUrl2);

  assert.strictEqual(key1, key2, 'Normalized cache keys should match regardless of session token or param order');
  assert.ok(!key1.includes('session='), 'Cache key should strip session tokens');
  assert.ok(!key1.includes('key='), 'Cache key should strip Google Maps API keys');
  console.log('  ✓ Test 1 Passed: tileCacheKey safely normalizes query parameters.');

  // Test 2: In-memory fallback caching in headless Node environment
  console.log('  Testing in-memory cache storage, compression, and retrieval...');
  const cache = new PhotorealTileCache();

  const dummyData = new Uint8Array(1024);
  for (let i = 0; i < dummyData.length; i++) {
    dummyData[i] = (i * 7) % 256;
  }

  const testKey = 'tile://sf/lod17/123_456';
  await cache.put(testKey, dummyData.buffer, 'model/gltf-binary');

  const retrieved = await cache.get(testKey);
  assert.ok(retrieved !== null, 'Retrieved cache entry should not be null');
  assert.strictEqual(retrieved.byteLength, dummyData.byteLength, 'Retrieved byte length should match original');

  const retrievedBytes = new Uint8Array(retrieved);
  for (let i = 0; i < dummyData.length; i++) {
    assert.strictEqual(retrievedBytes[i], dummyData[i], `Byte at index ${i} should match`);
  }
  console.log('  ✓ Test 2 Passed: Tile data compressed, stored, and retrieved with bit-exact fidelity.');

  // Test 3: Cache stats and entry count
  console.log('  Testing cache stats and metadata...');
  const stats = await cache.getStats();
  assert.ok(stats.entryCount >= 1, 'Stats entryCount should reflect added items');
  assert.ok(stats.totalSizeBytes > 0, 'Stats totalSizeBytes should be positive');
  console.log(`  ✓ Test 3 Passed: Cache stats verified (${stats.entryCount} items, ${stats.totalSizeBytes} bytes).`);

  // Test 4: Delete and clear operations
  console.log('  Testing delete and clear operations...');
  await cache.delete(testKey);
  const afterDelete = await cache.get(testKey);
  assert.strictEqual(afterDelete, null, 'Deleted entry should return null');

  await cache.put('key1', dummyData.buffer);
  await cache.put('key2', dummyData.buffer);
  await cache.clear();
  const afterClear = await cache.get('key1');
  assert.strictEqual(afterClear, null, 'Cleared cache should return null for all keys');
  console.log('  ✓ Test 4 Passed: Tile deletion and cache clearing verified.');

  // Test 5: PhotorealCachePlugin lifecycle and request routing
  console.log('  Testing PhotorealCachePlugin interception and bypassing...');
  const plugin = new PhotorealCachePlugin({ enabled: true });
  assert.strictEqual(plugin.priority, -100, 'Plugin priority should be -100 to precede network fetchers');

  // Root JSON should bypass cache
  const rootResult = await plugin.fetchData('https://tile.googleapis.com/v1/3dtiles/root.json');
  assert.strictEqual(rootResult, null, 'Root tileset JSON should bypass tile cache');

  // Subdirectory JSON should bypass cache
  const subJsonResult = await plugin.fetchData('https://tile.googleapis.com/v1/3dtiles/sub/tree.json');
  assert.strictEqual(subJsonResult, null, 'Subtree JSON should bypass tile cache');

  console.log('  ✓ Test 5 Passed: PhotorealCachePlugin correctly filters and bypasses tileset metadata.');

  console.log('\n🎉 All Persistent Photoreal Tile Cache & Plugin Tests Passed Successfully!\n');
}

test('photoreal-tile-cache.test', async () => {
    await runTests();
}, 180_000);
