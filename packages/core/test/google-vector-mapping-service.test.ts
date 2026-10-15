/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Automated Test Suite: Google Maps-Informed Vector Mapping Service
 * Verifies ENU tangent plane projection and GeoJSON ingestion, and that the service
 * has no built-in dataset that answers for places it was not given data for.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as vectorMapping from '../src/browser/generative-canvas/services/google-vector-mapping-service';
import { GoogleVectorMappingService } from '../src/browser/generative-canvas/services/google-vector-mapping-service';

const ANCHOR = { lat: 45.4345, lng: 12.3371, elevation: 2.0, placeId: 'test', formattedAddress: 'Venice (test anchor)' };

describe('GoogleVectorMappingService', () => {
  it('projects the anchor itself to (0, 0) ENU', () => {
    const [x, z] = GoogleVectorMappingService.projectWgs84ToEnu(ANCHOR.lng, ANCHOR.lat, ANCHOR);
    expect(Math.abs(x)).toBeLessThan(0.001);
    expect(Math.abs(z)).toBeLessThan(0.001);
  });

  it('performs accurate roundtrip projection between WGS84 and ENU around the given anchor', () => {
    const testLng = ANCHOR.lng + 0.0007;
    const testLat = ANCHOR.lat + 0.0006;
    const [x, z] = GoogleVectorMappingService.projectWgs84ToEnu(testLng, testLat, ANCHOR);
    expect(x).toBeGreaterThan(0); // east
    expect(z).toBeLessThan(0); // north is -Z
    const [invLng, invLat] = GoogleVectorMappingService.projectEnuToWgs84(x, z, ANCHOR);
    expect(invLng).toBeCloseTo(testLng, 6);
    expect(invLat).toBeCloseTo(testLat, 6);
  });

  it('has no built-in Midtown Manhattan dataset, nearest-parcel lookup or Empire State Building anchor', () => {
    const exported: Record<string, unknown> = vectorMapping as any;
    expect(exported.ESB_GOOGLE_GEODETIC_ANCHOR).toBeUndefined();
    expect(exported.GOOGLE_VECTOR_MAP_PATH_B_CONFIG).toBeUndefined();
    const service: Record<string, unknown> = GoogleVectorMappingService as any;
    for (const removed of ['generateCanonicalMidtownMapping', 'getCanonicalMapping', 'findClosestRoadOrParcel', 'getColmapReferenceStationsWGS84', 'getColmapStationGeoJSON']) {
      expect(service[removed], removed).toBeUndefined();
    }
  });

  it('ingests GeoJSON around the given anchor and never invents a building height', () => {
    const at = (dx: number, dy: number): [number, number] => [ANCHOR.lng + dx, ANCHOR.lat + dy];
    const square = (cx: number, cy: number) => [[at(cx - 0.0001, cy - 0.0001), at(cx + 0.0001, cy - 0.0001), at(cx + 0.0001, cy + 0.0001), at(cx - 0.0001, cy + 0.0001), at(cx - 0.0001, cy - 0.0001)]];
    const result = GoogleVectorMappingService.ingestGeoJsonFeatures({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(0, 0) }, properties: { name: 'Measured', height: 32.5 } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(0.001, 0) }, properties: { name: 'By levels', levels: 4 } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(0.002, 0) }, properties: { name: 'No height' } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(0.003, 0) }, properties: { name: 'Campo', leisure: 'park' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [at(0, 0), at(0.002, 0)] }, properties: { name: 'Calle', width: 6 } }
      ]
    }, ANCHOR);

    expect(result.parcels!.map(p => p.name)).toEqual(['Measured', 'By levels']);
    expect(result.parcels![0].heightMeters).toBe(32.5);
    expect(result.parcels![1].heightMeters).toBeCloseTo(15.2, 6);
    expect(result.parcelsWithoutHeight).toBe(1); // used to become a 45 m, 12-level building
    expect(result.parcels!.every(p => p.baseElevation === ANCHOR.elevation)).toBe(true);
    expect(result.landscapes!.map(l => l.name)).toEqual(['Campo']);
    expect(result.roads![0].widthMeters).toBe(6);
    const [x] = result.roads![0].pointsLocalENU[1];
    expect(x).toBeGreaterThan(100); // ~156 m east of the anchor
  });
});
