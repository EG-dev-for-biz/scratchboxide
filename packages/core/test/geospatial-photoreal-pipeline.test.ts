import { test, expect } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Google3DTileService } from '../src/browser/generative-canvas/services/Google3DTileService';
import { TileExtractionError } from '../src/common/errors/pipeline-errors';

test('Google3DTileService never synthesizes a tile: the viewport ingest fails visibly', async () => {
  const service = Google3DTileService.getInstance();
  // It used to build trig-harmonic terrain and box buildings labelled "Google 3D Map Tile (...)".
  await expect(service.ingestTileRegion({ query: 'Flatiron Building', lat: 40.7411, lng: -73.9897, elevation: 12 }))
    .rejects.toThrow(TileExtractionError);
  await expect(service.ingestTileRegion({ lat: 40.7411, lng: -73.9897 })).rejects.toThrow(/google_3d_tiles_get_clay/);
  const tileModule: Record<string, unknown> = await import('../src/browser/generative-canvas/services/Google3DTileService');
  expect(tileModule.generateGeospatialCpp3DSource).toBeUndefined();
  expect(tileModule.GeospatialPhotorealPipeline).toBeUndefined();
  expect((service as any).ingestTileRegionSync).toBeUndefined();
  // They turned any box into a spired setback tower and reported constants as measurements (6400 "carved" window
  // bays, a 0.22 m -> 0.003 m planar deviation, 114.6° -> 90° corners) whatever the input.
  expect((service as any).improveTileExtrusion).toBeUndefined();
  expect((service as any).cleanTileMeshAndApplyPbrTextures).toBeUndefined();
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
