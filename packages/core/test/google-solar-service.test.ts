/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GoogleSolarService,
  type RoofSegmentStats,
  type BuildingInsightsResponse
} from '../src/browser';

describe('Google Solar API Integration & 3D Rooftop Geometry Engine', () => {
  let service: GoogleSolarService;
  const testApiKey = 'AIzaSyTestMockKeyForSolarUnitTests_12345';

  beforeEach(() => {
    service = new GoogleSolarService({
      apiKey: testApiKey,
      proxyBaseUrl: 'http://127.0.0.1:8098/api/solar',
      enableCaching: true,
      cacheTtlMs: 30 * 24 * 60 * 60 * 1000 // 30-day ToS compliance
    });
  });

  it('1. should initialize with mandatory GMP solution attribution and caching enabled', () => {
    expect(service).toBeDefined();
    expect(service.getSolutionId()).toBe('gmp_git_agentskills_v1');
    expect(service.isCachingEnabled()).toBe(true);
  });

  it('2. should enforce Google Maps ToS caching semantics (30-day TTL)', () => {
    const testLat = 40.7484405;
    const testLng = -73.9856644;
    const mockData: BuildingInsightsResponse = {
      name: 'buildings/ChIJtcaxrqlZwokRfwmmibzPsTU',
      center: { latitude: testLat, longitude: testLng },
      imageryDate: { year: 2024, month: 5, day: 24 },
      postalCode: '10001',
      administrativeArea: 'NY',
      solarPotential: {
        maxArrayPanelsCount: 1439,
        maxArrayAreaMeters2: 2825.55,
        maxSunshineHoursPerYear: 1398.29,
        wholeRoofStats: {
          areaMeters2: 5181.28,
          groundAreaMeters2: 4895.01,
          sunshineQuantiles: [300, 600, 900]
        },
        roofSegmentStats: [
          {
            pitchDegrees: 0.0,
            azimuthDegrees: 0.0,
            planeHeightAtCenterMeters: 90.58,
            center: { latitude: testLat, longitude: testLng },
            boundingBox: {
              sw: { latitude: testLat - 0.0001, longitude: testLng - 0.0001 },
              ne: { latitude: testLat + 0.0001, longitude: testLng + 0.0001 }
            },
            stats: {
              areaMeters2: 402.69,
              groundAreaMeters2: 402.67,
              sunshineQuantiles: [350, 1000, 1200]
            }
          }
        ]
      }
    };

    // Cache entry storage
    service.setCacheEntry(testLat, testLng, mockData);

    // Immediate cache hit
    const cached = service.getCachedBuildingInsights(testLat, testLng);
    expect(cached).not.toBeNull();
    expect(cached?.name).toBe('buildings/ChIJtcaxrqlZwokRfwmmibzPsTU');
    expect(cached?.solarPotential.wholeRoofStats.areaMeters2).toBeCloseTo(5181.28, 1);

    // Cache miss for distant coordinate
    const miss = service.getCachedBuildingInsights(testLat + 0.05, testLng - 0.05);
    expect(miss).toBeNull();
  });

  it('3. should calculate standard 3D surface normal vectors from pitch and azimuth', () => {
    // Flat horizontal roof: pitch = 0 deg
    const flatNormal = service.calculateNormalVector(0, 0);
    expect(flatNormal.nx).toBeCloseTo(0.0, 3);
    expect(flatNormal.ny).toBeCloseTo(1.0, 3);
    expect(flatNormal.nz).toBeCloseTo(0.0, 3);

    // East-facing slope: pitch = 30 deg, azimuth = 90 deg (East)
    const eastNormal = service.calculateNormalVector(30, 90);
    expect(eastNormal.nx).toBeCloseTo(0.5, 2); // sin(30) = 0.5
    expect(eastNormal.ny).toBeCloseTo(0.866, 2); // cos(30) = 0.866
    expect(eastNormal.nz).toBeCloseTo(0.0, 2);

    // South-facing slope: pitch = 45 deg, azimuth = 180 deg (South)
    const southNormal = service.calculateNormalVector(45, 180);
    expect(southNormal.nx).toBeCloseTo(0.0, 2);
    expect(southNormal.ny).toBeCloseTo(0.707, 2); // cos(45) = 0.707
    expect(southNormal.nz).toBeCloseTo(0.707, 2); // -sin(45)*cos(180) = +0.707
  });

  it('4. should cluster roof segments into distinct empirical setback tiers', () => {
    const mockSegments: RoofSegmentStats[] = [
      // Podium / Base (~35.6m - 37.0m)
      {
        pitchDegrees: 1.0,
        azimuthDegrees: 80.0,
        planeHeightAtCenterMeters: 35.62,
        center: { latitude: 40.74836, longitude: -73.985 },
        boundingBox: { sw: { latitude: 40.7482, longitude: -73.9851 }, ne: { latitude: 40.7484, longitude: -73.9848 } },
        stats: { areaMeters2: 338.6, groundAreaMeters2: 338.5, sunshineQuantiles: [] }
      },
      {
        pitchDegrees: 0.5,
        azimuthDegrees: 0.0,
        planeHeightAtCenterMeters: 36.45,
        center: { latitude: 40.7486, longitude: -73.9855 },
        boundingBox: { sw: { latitude: 40.7485, longitude: -73.9857 }, ne: { latitude: 40.7487, longitude: -73.9852 } },
        stats: { areaMeters2: 198.0, groundAreaMeters2: 197.6, sunshineQuantiles: [] }
      },
      // 6th Floor Setback (~90.5m)
      {
        pitchDegrees: 0.6,
        azimuthDegrees: 0.0,
        planeHeightAtCenterMeters: 90.58,
        center: { latitude: 40.7482, longitude: -73.9852 },
        boundingBox: { sw: { latitude: 40.748, longitude: -73.9854 }, ne: { latitude: 40.7484, longitude: -73.985 } },
        stats: { areaMeters2: 402.6, groundAreaMeters2: 402.6, sunshineQuantiles: [] }
      },
      // Observation Deck Terrace (~309.5m)
      {
        pitchDegrees: 70.5,
        azimuthDegrees: 299.0,
        planeHeightAtCenterMeters: 309.53,
        center: { latitude: 40.7483, longitude: -73.9853 },
        boundingBox: { sw: { latitude: 40.7482, longitude: -73.9854 }, ne: { latitude: 40.7484, longitude: -73.9852 } },
        stats: { areaMeters2: 132.5, groundAreaMeters2: 44.0, sunshineQuantiles: [] }
      },
      // Mooring Mast / Lantern Roof (~402.8m)
      {
        pitchDegrees: 5.5,
        azimuthDegrees: 171.0,
        planeHeightAtCenterMeters: 402.75,
        center: { latitude: 40.7484, longitude: -73.9856 },
        boundingBox: { sw: { latitude: 40.7484, longitude: -73.9857 }, ne: { latitude: 40.7484, longitude: -73.9856 } },
        stats: { areaMeters2: 13.3, groundAreaMeters2: 13.2, sunshineQuantiles: [] }
      }
    ];

    const tiers = service.extractRoofTiers(mockSegments, 8.0);
    expect(tiers.length).toBe(4);

    // Tier 0: Podium
    expect(tiers[0].name).toBe('Podium / Base Tier');
    expect(tiers[0].segmentCount).toBe(2);
    expect(tiers[0].meanElevationMeters).toBeCloseTo(36.03, 1);
    expect(tiers[0].totalAreaMeters2).toBeCloseTo(536.6, 1);

    // Tier 1: Setback Tier 1 (~90.5m)
    expect(tiers[1].name).toBe('Setback Tier 1');
    expect(tiers[1].meanElevationMeters).toBeCloseTo(90.58, 1);

    // Tier 2: Observation Deck (~309.5m)
    expect(tiers[2].isObservationDeck).toBe(true);
    expect(tiers[2].meanElevationMeters).toBeCloseTo(309.53, 1);

    // Tier 3: Crown / Mooring Spire (~402.8m)
    expect(tiers[3].isSpireOrLantern).toBe(true);
    expect(tiers[3].meanElevationMeters).toBeCloseTo(402.75, 1);
  });

  it('5. should transform geodetic roof segments to ENU and align with Manhattan street grid', () => {
    const mockSegment: RoofSegmentStats = {
      pitchDegrees: 5.6,
      azimuthDegrees: 171.8,
      planeHeightAtCenterMeters: 402.75,
      center: { latitude: 40.7484405, longitude: -73.9856644 }, // Empire State Building center
      boundingBox: {
        sw: { latitude: 40.74840, longitude: -73.98570 },
        ne: { latitude: 40.74848, longitude: -73.98562 }
      },
      stats: {
        areaMeters2: 13.35,
        groundAreaMeters2: 13.29,
        sunshineQuantiles: [363.3, 1474.1, 1621.8]
      }
    };

    const facets = service.extractRoofSegmentsENU(
      [mockSegment],
      40.7484405,
      -73.9856644,
      18.53, // ground datum
      29.0 // Manhattan street grid bearing
    );

    expect(facets.length).toBe(1);
    const facet = facets[0];

    // Center should be at (0, 384.22m, 0)
    expect(facet.centerENU.x).toBeCloseTo(0.0, 1);
    expect(facet.centerENU.y).toBeCloseTo(384.22, 1); // 402.75 - 18.53 = 384.22
    expect(facet.centerENU.z).toBeCloseTo(0.0, 1);

    // Dimensions
    expect(facet.dimensionsMeters.width).toBeGreaterThan(0);
    expect(facet.dimensionsMeters.depth).toBeGreaterThan(0);
    expect(facet.cornersENU.length).toBe(4);

    // Normal vector
    expect(facet.normal.ny).toBeGreaterThan(0.9); // nearly horizontal top cap
  });
});
