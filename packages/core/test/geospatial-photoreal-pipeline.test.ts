import { test, expect } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
  GeospatialPhotorealPipeline,
  PhotorealReconstructionOptions
} from '../src/browser/generative-canvas/services/GeospatialPhotorealPipeline';
import {
  Google3DTileService,
  generatePhotorealProceduralCppSource
} from '../src/browser/generative-canvas/services/Google3DTileService';
import { LocationUnresolvedError } from '../src/common/errors/pipeline-errors';

test('GeospatialPhotorealPipeline: Location-agnostic C++20 code generation', () => {
  const pipeline = GeospatialPhotorealPipeline.getInstance();

  // A place name is not resolved offline (no landmark table): it must come with coordinates.
  expect(() => pipeline.generatePhotorealCppSource({ query: 'Empire State Building' })).toThrow(LocationUnresolvedError);

  // Test 1: Empire State Building NYC (explicit coordinates)
  const esbOptions: PhotorealReconstructionOptions = {
    lat: 40.7484405,
    lng: -73.9856644,
    elevation: 15.0,
    landmarkName: 'Empire State Building',
    footprintWidth: 65.0,
    footprintDepth: 55.0,
    towerHeight: 380.0,
    spireHeight: 443.2
  };

  const esbCpp = pipeline.generatePhotorealCppSource(esbOptions);
  expect(esbCpp).toContain('#include "scratchbox_engine.hpp"');
  expect(esbCpp).toContain('UniversalPhotorealSynthesizer::synthesizeLandmark');
  expect(esbCpp).toContain('.towerTotalHeightMeters = 380.0f');
  expect(esbCpp).toContain('.spireTotalHeightMeters = 443.2f');
  expect(esbCpp).toContain('GlbWriter::streamChunk');

  // Test 2: San Francisco Ferry Building
  const sfOptions: PhotorealReconstructionOptions = {
    lat: 37.7955,
    lng: -122.3937,
    elevation: 2.4,
    landmarkName: 'San Francisco Ferry Building',
    footprintWidth: 45.0,
    footprintDepth: 35.0,
    towerHeight: 75.0,
    spireHeight: 75.0
  };

  const sfCpp = pipeline.generatePhotorealCppSource(sfOptions);
  expect(sfCpp).toContain('#include "scratchbox_engine.hpp"');
  expect(sfCpp).toContain('.towerTotalHeightMeters = 75.0f');
  expect(sfCpp).toContain('.spireTotalHeightMeters = 75.0f');

  // Test 3: Arbitrary Coordinates (Tokyo Tower lat 35.6586, lng 139.7454)
  const tokyoOptions: PhotorealReconstructionOptions = {
    lat: 35.6586,
    lng: 139.7454,
    elevation: 25.0,
    landmarkName: 'Tokyo Tower',
    towerHeight: 332.9,
    spireHeight: 332.9
  };

  const tokyoCpp = generatePhotorealProceduralCppSource(tokyoOptions);
  expect(tokyoCpp).toContain('Tokyo Tower');
  expect(tokyoCpp).toContain('.latDeg = 35.6586');
  expect(tokyoCpp).toContain('.lngDeg = 139.7454');
  expect(tokyoCpp).toContain('.towerTotalHeightMeters = 332.9f');
});

test('GeospatialPhotorealPipeline: Scene synthesis with PBR materials and ground details', () => {
  // Google3DTileService.synthesizePhotorealLandmark was a thin delegate to
  // GeospatialPhotorealPipeline.synthesizePhotorealScene; commit 025cfe0 removed the delegate,
  // so exercise the pipeline method it forwarded to.
  // Free-text queries are no longer resolved offline: deb84c7 removed the
  // OFFLINE_TEST_FIXTURE_COORDINATES landmark table (zero presets; AGENTS.md "queries must supply
  // explicit geodetic coordinates or an active Google Maps API key"), so pass the anchor explicitly.
  const pipeline = GeospatialPhotorealPipeline.getInstance();

  const result = pipeline.synthesizePhotorealScene({
    lat: 40.7644,
    lng: -73.9744,
    elevation: 18.0,
    landmarkName: 'The Plaza Hotel NYC',
    footprintWidth: 70.0,
    footprintDepth: 60.0,
    towerHeight: 75.0,
    spireHeight: 75.0
  });

  expect(result.success).toBe(true);
  expect(result.landmarkName).toBe('The Plaza Hotel NYC');
  expect(result.mesh).toBeDefined();
  expect(result.media4DObject).toBeDefined();
  expect(result.media4DObject.content.type).toBe('map-3d');
  expect(result.media4DObject.space.geoAnchor.lat).toBeCloseTo(40.7644, 2);
  expect(result.media4DObject.space.geoAnchor.lng).toBeCloseTo(-73.9744, 2);

  // Check stats and materials
  expect(result.stats.materialsUsed).toContain('PBR_IndianaLimestone');
  expect(result.stats.materialsUsed).toContain('PBR_CharcoalGranitePlinth');
  expect(result.stats.materialsUsed).toContain('PBR_ConcreteSidewalk');
  expect(result.stats.materialsUsed).toContain('PBR_SolarWindowGlass');
  expect(result.stats.materialsUsed).toContain('PBR_StainlessSteel');
  expect(result.stats.vertexCount).toBeGreaterThan(10000);
});

test('GoogleMapsService: Multi-source geospatial endpoints (Aerial View, Solar, Street View)', async () => {
  const { GoogleMapsService } = await import('../src/browser/generative-canvas/services/google-maps-service');
  const service = GoogleMapsService.getInstance();

  // Test Street View Static URL generation
  const svUrl = service.getStreetViewStaticUrl({
    location: { lat: 40.7484, lng: -73.9857 },
    size: { width: 1024, height: 768 },
    heading: 90,
    pitch: 15,
    fov: 100
  });
  expect(svUrl).toContain('maps.googleapis.com/maps/api/streetview');
  expect(svUrl).toContain('location=40.7484%2C-73.9857');
  expect(svUrl).toContain('size=1024x768');
  expect(svUrl).toContain('heading=90');

  // Aerial View: the API's own answer, never a demo URL. No key throws; 404 is the API's NOT_FOUND.
  const savedKeys = { state: service.getApiKey(), g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
  service.setApiKey('');
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.MAP_TILES_API_KEY;
  try {
    await expect(service.fetchAerialViewVideo({ lat: 40.7484, lng: -73.9857 })).rejects.toThrow(/No Google Maps API key/);
    await expect(service.fetchBuildingSolarInsights({ lat: 40.7484, lng: -73.9857 })).rejects.toThrow(/No Google Maps API key/);
  } finally {
    service.setApiKey(savedKeys.state);
    if (savedKeys.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = savedKeys.g;
    if (savedKeys.m !== undefined) process.env.MAP_TILES_API_KEY = savedKeys.m;
  }
  const aerialFetch = (async (url: any) => new Response(JSON.stringify({
    state: 'ACTIVE',
    uris: { MP4_HIGH: { landscapeUri: 'https://example.test/high.mp4' } },
    metadata: { videoId: 'vid-1' }
  }), { status: 200 })) as typeof fetch;
  const aerial = await service.fetchAerialViewVideo({ lat: 40.7484, lng: -73.9857 }, { apiKey: 'test-key', fetchImpl: aerialFetch });
  expect(aerial.state).toBe('ACTIVE');
  expect(aerial.uris?.mp4High).toBe('https://example.test/high.mp4');
  const notFound = await service.fetchAerialViewVideo('nowhere', { apiKey: 'test-key', fetchImpl: (async () => new Response('{}', { status: 404 })) as typeof fetch });
  expect(notFound.state).toBe('NOT_FOUND');

  // Solar API building insights: returned as the API gave them; a failed call throws instead of inventing a roof.
  const solarBody = {
    name: 'buildings/ChIJ123',
    center: { latitude: 40.7484, longitude: -73.9857 },
    solarPotential: { maxArrayPanelsCount: 412, panelCapacityWatts: 400, roofSegmentStats: [] }
  };
  const solar = await service.fetchBuildingSolarInsights({ lat: 40.7484, lng: -73.9857 }, {
    apiKey: 'test-key',
    fetchImpl: (async () => new Response(JSON.stringify(solarBody), { status: 200 })) as typeof fetch
  });
  expect(solar.solarPotential?.maxArrayPanelsCount).toBe(412);
  await expect(service.fetchBuildingSolarInsights({ lat: 40.7484, lng: -73.9857 }, {
    apiKey: 'test-key',
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'Requested entity was not found.' } }), { status: 404 })) as typeof fetch
  })).rejects.toThrow(/Solar API gave no building insights.*not found/);
});

test('Google3DTileService: improveTileExtrusion converts raw tile block into photoreal mesh', () => {
  const service = Google3DTileService.getInstance();

  const rawExtrusion = {
    width: 129.2,
    depth: 59.7,
    height: 381.0,
    landmarkName: 'Empire State Building'
  };

  const result = service.improveTileExtrusion(rawExtrusion, {
    recessDepthMeters: 0.28,
    entranceArchHeightMeters: 12.4,
    generateSpire: true
  });

  expect(result.rawGeometry).toBeDefined();
  expect(result.improvedGeometry).toBeDefined();

  // Verify dramatic geometric density and architectural improvements
  expect(result.metrics.rawVertexCount).toBeLessThan(100);
  expect(result.metrics.improvedVertexCount).toBeGreaterThan(100);
  expect(result.metrics.carvedWindowBays).toBe(6400);
  expect(result.metrics.facadeRecessDepthMeters).toBe(0.28);
  expect(result.metrics.plinthHeightMeters).toBe(1.8);
  expect(result.metrics.entranceArchHeightMeters).toBe(12.4);
  expect(result.metrics.pbrMaterialSetsAssigned).toBe(8);
  expect(result.metrics.spireApexElevMeters).toBeGreaterThan(381.0);
});

test('Google3DTileService: cleanTileMeshAndApplyPbrTextures eliminates artifacts and applies 2K PBR', async () => {
  const service = Google3DTileService.getInstance();
  const THREE = await import('three');

  // Create a simulated raw photogrammetric tile mesh with sensor noise
  const rawGeom = new THREE.BoxGeometry(129.2, 381.0, 57.0, 10, 20, 10);
  const pos = rawGeom.getAttribute('position') as THREE.BufferAttribute;

  // Add simulated sensor rippling (+/- 0.22m)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const ripple = Math.sin(y * 0.3) * 0.22;
    pos.setX(i, pos.getX(i) + ripple);
  }
  pos.needsUpdate = true;
  rawGeom.computeVertexNormals();

  const cleanupResult = service.cleanTileMeshAndApplyPbrTextures(rawGeom, {
    groundDatumY: 0.0,
    plinthHeightMeters: 1.8,
    facadeUvScale: 1.0
  });

  expect(cleanupResult.cleanedGeometry).toBeDefined();
  expect(cleanupResult.pbrTexturedGeometry).toBeDefined();

  // Verify metric and cleanup results
  expect(cleanupResult.metrics.groundLeveled).toBe(true);
  expect(cleanupResult.metrics.cornersSharpened).toBe(true);
  expect(cleanupResult.metrics.facadesPlanarized).toBe(true);
  expect(cleanupResult.metrics.initialPlanarDeviationMeters).toBeCloseTo(0.22, 2);
  expect(cleanupResult.metrics.finalPlanarDeviationMeters).toBeLessThan(0.01);
  expect(cleanupResult.metrics.initialCornerAngleDeg).toBeCloseTo(114.6, 1);
  expect(cleanupResult.metrics.finalCornerAngleDeg).toBe(90.0);
  expect(cleanupResult.metrics.plinthHeightMeters).toBe(1.8);

  // Verify metric UV unwrapping
  const uvs = cleanupResult.pbrTexturedGeometry.getAttribute('uv');
  expect(uvs).toBeDefined();
  expect(uvs.count).toBe(rawGeom.getAttribute('position').count);
});

