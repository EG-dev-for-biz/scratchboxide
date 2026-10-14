/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Automated Test Suite: Google Maps-Informed Vector Mapping Service
 * Verifies geodetic anchoring, ENU tangent plane projection, Manhattan 29°
 * grid rotation, and zero OSM contamination.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  GoogleVectorMappingService,
  ESB_GOOGLE_GEODETIC_ANCHOR,
  GOOGLE_VECTOR_MAP_PATH_B_CONFIG
} from '../src/browser/generative-canvas/services/google-vector-mapping-service';

describe('GoogleVectorMappingService', () => {
  it('correctly projects WGS84 anchor coordinate to (0, 0) ENU', () => {
    const [x, z] = GoogleVectorMappingService.projectWgs84ToEnu(
      ESB_GOOGLE_GEODETIC_ANCHOR.lng,
      ESB_GOOGLE_GEODETIC_ANCHOR.lat
    );
    expect(Math.abs(x)).toBeLessThan(0.001);
    expect(Math.abs(z)).toBeLessThan(0.001);
  });

  it('performs accurate roundtrip projection between WGS84 and ENU', () => {
    const testLng = -73.9850;
    const testLat = 40.7490;

    const [x, z] = GoogleVectorMappingService.projectWgs84ToEnu(testLng, testLat);
    const [invLng, invLat] = GoogleVectorMappingService.projectEnuToWgs84(x, z);

    expect(invLng).toBeCloseTo(testLng, 6);
    expect(invLat).toBeCloseTo(testLat, 6);
  });

  it('generates canonical Midtown vector mapping adhering to Google Maps schema', () => {
    const mapping = GoogleVectorMappingService.generateCanonicalMidtownMapping();

    expect(mapping.version).toContain('google-reference');
    expect(mapping.source).toBe('google_maps_platform_reference');
    expect(mapping.gridBearingDegrees).toBe(29.0);
    expect(mapping.styling.variant).toBe('light');

    // Labels must be hidden across all 4 Google cloud styling categories
    for (const style of mapping.styling.styles) {
      expect(style.label.visible).toBe(false);
    }

    // Verify key road corridors
    const roadNames = mapping.roads.map(r => r.name);
    expect(roadNames).toContain('5th Avenue');
    expect(roadNames).toContain('West 34th Street');
    expect(roadNames).toContain('Avenue of the Americas (6th Ave)');
    expect(roadNames).toContain('Broadway');

    // Verify ESB landmark parcel presence and exact 443.2m height
    const esb = mapping.parcels.find(p => p.id === 'google_parcel_esb_core');
    expect(esb).toBeDefined();
    expect(esb?.isLandmark).toBe(true);
    expect(esb?.heightMeters).toBe(443.2);
    expect(esb?.blockNumber).toBe(835);
    expect(esb?.levels).toBe(102);

    // Verify surrounding contextual blocks
    const parcelIds = mapping.parcels.map(p => p.id);
    expect(parcelIds).toContain('google_parcel_macys_herald_sq');
    expect(parcelIds).toContain('google_parcel_cuny_b_altman');
    expect(parcelIds).toContain('google_parcel_block_834_martinique');

    // Verify zero OSM references in entire serialized mapping
    const jsonStr = JSON.stringify(mapping);
    expect(jsonStr.toLowerCase()).not.toContain('osm');
    expect(jsonStr.toLowerCase()).not.toContain('overpass');
  });

  it('generates calibrated COLMAP/GLOMAP camera survey poses along 5th Ave and 34th St', () => {
    const mapping = GoogleVectorMappingService.generateCanonicalMidtownMapping();
    expect(mapping.colmapCameraPoses).toBeDefined();
    expect(mapping.colmapCameraPoses!.length).toBeGreaterThanOrEqual(15);

    // Verify 5th Ave cameras
    const fifthAveCams = mapping.colmapCameraPoses!.filter(c => c.name.includes('5TH_AVE'));
    expect(fifthAveCams.length).toBe(7);
    for (const cam of fifthAveCams) {
      expect(cam.rotationYDegrees).toBe(29.0);
      expect(cam.focalLengthMm).toBe(35.0);
      expect(cam.fovDegrees).toBeCloseTo(54.4, 1);
      expect(cam.positionLocalENU[1]).toBe(2.8); // eye/vehicle height
    }

    // Verify 34th St cameras
    const streetCams = mapping.colmapCameraPoses!.filter(c => c.name.includes('34TH_ST'));
    expect(streetCams.length).toBe(8);
    for (const cam of streetCams) {
      expect(cam.rotationYDegrees).toBe(119.0);
      expect(cam.positionLocalENU[1]).toBe(2.8);
    }
  });

  it('guarantees 100% geometric parallelism between road grid and all parcel lot lines', () => {
    const mapping = GoogleVectorMappingService.generateCanonicalMidtownMapping();

    for (const parcel of mapping.parcels) {
      const poly = parcel.polygonLocalENU;
      expect(poly.length).toBeGreaterThanOrEqual(4);

      for (let i = 0; i < poly.length - 1; i++) {
        const dx = poly[i + 1][0] - poly[i][0];
        const dz = poly[i + 1][1] - poly[i][1];
        const len = Math.hypot(dx, dz);
        if (len < 0.1) continue;

        // Angle in degrees from North (-Z)
        // In Three.js: dx is East (+X), dz is South (+Z). Angle from North (-Z) is atan2(dx, -dz)
        let angleDeg = (Math.atan2(dx, -dz) * 180.0) / Math.PI;
        if (angleDeg < 0) angleDeg += 360.0;

        // Check if edge is parallel to avenues (29° or 209°) or cross streets (119° or 299°)
        const isAvenueEdge = Math.abs(angleDeg - 29.0) < 0.1 || Math.abs(angleDeg - 209.0) < 0.1;
        const isStreetEdge = Math.abs(angleDeg - 119.0) < 0.1 || Math.abs(angleDeg - 299.0) < 0.1;

        expect(isAvenueEdge || isStreetEdge).toBe(true);
      }
    }
  });

  it('serializes the canonical vector mapping dataset (google_midtown_vector_mapping.json) to disk', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const mapping = GoogleVectorMappingService.generateCanonicalMidtownMapping();
    // Temp dir: public/data/google_midtown_vector_mapping.json is tracked and must not be rewritten by tests.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vector-mapping-'));
    const targetPath = path.join(outDir, 'google_midtown_vector_mapping.json');

    try {
      fs.writeFileSync(targetPath, JSON.stringify(mapping, null, 2), 'utf8');
      expect(fs.existsSync(targetPath)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('provides valid Path B Google Maps JavaScript Vector Map configuration and COLMAP GeoJSON', () => {
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG).toBeDefined();
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.mapId).toBe('ad80a8568eeae7445909ba9f');
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.styleId).toBe('171afbfed80e6143e663574d');
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.styleName).toBe('Vector1');
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.mapType).toBe('vector');
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.gridBearingDegrees).toBe(29.0);
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.colmapSurveyCount).toBe(15);
    expect(GOOGLE_VECTOR_MAP_PATH_B_CONFIG.internalUsageAttributionIds).toContain('gmp_git_agentskills_v1');

    // Test getColmapReferenceStationsWGS84()
    const stations = GoogleVectorMappingService.getColmapReferenceStationsWGS84();
    expect(stations.length).toBe(15);
    for (const station of stations) {
      expect(station.coordinatesWGS84.lat).toBeGreaterThan(40.7);
      expect(station.coordinatesWGS84.lng).toBeLessThan(-73.9);
      expect(station.focalLengthMm).toBe(35.0);
      expect(station.fovDegrees).toBeCloseTo(54.4, 1);
    }

    // Test getColmapStationGeoJSON()
    const geoJson = GoogleVectorMappingService.getColmapStationGeoJSON();
    expect(geoJson.type).toBe('FeatureCollection');
    expect(geoJson.features.length).toBe(15);
    expect(geoJson.features[0].geometry.type).toBe('Point');
    expect(geoJson.features[0].properties.name).toContain('COLMAP');
  });
});

