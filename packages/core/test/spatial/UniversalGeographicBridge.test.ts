/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for UniversalGeographicBridge, MetricScaleNormalizer,
 * and GeodeticAnchorValidator.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  MetricScaleNormalizer,
  GeodeticAnchorValidator,
  GeospatialAssertionError,
  UniversalGeographicBridge,
  GeodeticAnchor
} from '../../src/common';

describe('UniversalGeographicBridge & Spatial Invariant Hardening', () => {
  // Test anchor: Times Square, New York City
  const timesSquareAnchor: GeodeticAnchor = {
    lat: 40.758896,
    lng: -73.985130,
    elevationMeters: 15.0, // MSL
    geoidHeightMeters: -31.5, // Geoid undulation N in NYC
    headingDeg: 29.0 // Align with Manhattan grid
  };

  describe('MetricScaleNormalizer (Layer 1 Invariant: 1 unit = 1.0 meter)', () => {
    it('preserves native meters for correctly proportioned assets', () => {
      const human = MetricScaleNormalizer.normalizeDimensions([0.6, 1.8, 0.4], 'humanoid');
      expect(human.scaleFactorToMeters).toBe(1.0);
      expect(human.detectedUnit).toBe('meters');
      expect(human.normalizedDimensionsMeters[1]).toBe(1.8);
      expect(human.wasCorrected).toBe(false);
    });

    it('detects and converts centimeters to meters', () => {
      const humanCm = MetricScaleNormalizer.normalizeDimensions([60.0, 180.0, 40.0], 'humanoid');
      expect(humanCm.scaleFactorToMeters).toBe(0.01);
      expect(humanCm.detectedUnit).toBe('centimeters');
      expect(humanCm.normalizedDimensionsMeters[1]).toBeCloseTo(1.8, 4);
      expect(humanCm.wasCorrected).toBe(true);
    });

    it('detects and converts millimeters to meters', () => {
      const carMm = MetricScaleNormalizer.normalizeDimensions([1900.0, 1400.0, 4800.0], 'vehicle');
      expect(carMm.scaleFactorToMeters).toBe(0.001);
      expect(carMm.detectedUnit).toBe('millimeters');
      expect(carMm.normalizedDimensionsMeters[0]).toBeCloseTo(1.9, 4);
      expect(carMm.normalizedDimensionsMeters[1]).toBeCloseTo(1.4, 4);
      expect(carMm.normalizedDimensionsMeters[2]).toBeCloseTo(4.8, 4);
      expect(carMm.wasCorrected).toBe(true);
    });

    it('detects and converts inches for humanoids', () => {
      const humanIn = MetricScaleNormalizer.normalizeDimensions([24.0, 71.0, 12.0], 'humanoid');
      expect(humanIn.scaleFactorToMeters).toBe(0.0254);
      expect(humanIn.detectedUnit).toBe('inches');
      expect(humanIn.normalizedDimensionsMeters[1]).toBeCloseTo(1.8034, 4);
      expect(humanIn.wasCorrected).toBe(true);
    });

    it('rescales neural unit-box [-1, 1] assets to physically grounded heights', () => {
      const neuralCar = MetricScaleNormalizer.normalizeDimensions([0.4, 0.3, 1.0], 'vehicle');
      expect(neuralCar.detectedUnit).toBe('unit_box');
      expect(neuralCar.wasCorrected).toBe(true);
      // Vehicle midpoint expected height ~ 2.75m, scaled up proportionally
      expect(neuralCar.normalizedDimensionsMeters[1]).toBeGreaterThan(2.0);
    });
  });

  describe('GeodeticAnchorValidator (Layer 2 Hardening & Anti-Poisoning)', () => {
    it('validates a legitimate real-world anchor', () => {
      expect(() => GeodeticAnchorValidator.validate(timesSquareAnchor)).not.toThrow();
      expect(GeodeticAnchorValidator.isValid(timesSquareAnchor)).toBe(true);
    });

    it('strictly catches and blocks ungrounded Null Island (0.0, 0.0) coordinates', () => {
      const nullIsland = { lat: 0.0, lng: 0.0, elevationMeters: 0.0 };
      expect(() => GeodeticAnchorValidator.validate(nullIsland)).toThrow(GeospatialAssertionError);
      expect(() => GeodeticAnchorValidator.validate(nullIsland)).toThrow(/Null Island/);
    });

    it('allows Null Island only when explicitly flagged for synthetic test fixtures', () => {
      const allowedNullIsland = { lat: 0.0, lng: 0.0, elevationMeters: 0.0, allowNullIsland: true };
      expect(() => GeodeticAnchorValidator.validate(allowedNullIsland)).not.toThrow();
    });

    it('rejects out-of-bounds latitudes and longitudes', () => {
      expect(() => GeodeticAnchorValidator.validate({ lat: 95.0, lng: 0.0, elevationMeters: 0.0 })).toThrow(
        /Latitude out of WGS-84 bounds/
      );
      expect(() => GeodeticAnchorValidator.validate({ lat: 0.0, lng: 195.0, elevationMeters: 0.0 })).toThrow(
        /Longitude out of WGS-84 bounds/
      );
    });

    it('rejects non-terrestrial impossible elevations', () => {
      expect(() =>
        GeodeticAnchorValidator.validate({ lat: 40.0, lng: -74.0, elevationMeters: 50000.0 })
      ).toThrow(/Elevation out of terrestrial physical limits/);
    });
  });

  describe('UniversalGeographicBridge (Multi-Source Translation to Local Metric ENU)', () => {
    const bridge = new UniversalGeographicBridge(timesSquareAnchor);

    it('translates real-world WGS-84 lat/lng (e.g. OSM / Overture) with sub-millimeter precision', () => {
      // 100 meters East, 50 meters North of Times Square anchor
      // ~1 deg lat = 111,320m -> 50m / 111320 ≈ 0.00044915 deg
      // ~1 deg lng at 40.758° = 111320 * cos(40.758°) ≈ 84310m -> 100m / 84310 ≈ 0.001186 deg
      const testTarget = {
        lat: 40.759345,
        lng: -73.983944,
        altitude: 15.0,
        crs: 'EPSG:4326' as const,
        verticalDatum: 'EGM96_GEOID_MSL' as const
      };

      const localEnu = bridge.toMetricLocal(testTarget);
      // Three.js: +X = East, +Y = Up, -Z = North
      expect(localEnu[0]).toBeGreaterThan(90.0);
      expect(localEnu[0]).toBeLessThan(110.0);
      expect(localEnu[1]).toBeCloseTo(0.0, 1); // same MSL height
      expect(localEnu[2]).toBeLessThan(-40.0); // -Z is North
      expect(localEnu[2]).toBeGreaterThan(-60.0);

      // Verify round-trip conversion
      const roundTrip = bridge.toGeodetic(localEnu, 'EGM96_GEOID_MSL');
      expect(roundTrip.lat).toBeCloseTo(testTarget.lat, 6);
      expect(roundTrip.lng).toBeCloseTo(testTarget.lng, 6);
      expect(roundTrip.alt).toBeCloseTo(testTarget.altitude, 2);
    });

    it('translates Google Photorealistic 3D Tiles & Cesium ECEF (EPSG:4978) seamlessly', () => {
      // Use the anchor's exact ECEF coordinates
      const originEcef = (bridge as any).ltp.originEcef;
      const originPayload = {
        ecef: [originEcef[0], originEcef[1], originEcef[2]] as [number, number, number],
        crs: 'EPSG:4978' as const
      };
      const originLocal = bridge.toMetricLocal(originPayload);

      // Origin should map exactly to (0, 0, 0) in metric space
      expect(originLocal[0]).toBeCloseTo(0.0, 3);
      expect(originLocal[1]).toBeCloseTo(0.0, 3);
      expect(originLocal[2]).toBeCloseTo(0.0, 3);
    });

    it('translates Web Mercator (EPSG:3857) projected coordinates', () => {
      const [mercX, mercY] = UniversalGeographicBridge.wgs84ToWebMercator(
        timesSquareAnchor.lat,
        timesSquareAnchor.lng
      );

      const mercatorPayload = {
        projectedX: mercX + 50.0, // 50m offset in Web Mercator
        projectedY: mercY,
        altitude: timesSquareAnchor.elevationMeters,
        crs: 'EPSG:3857' as const,
        verticalDatum: 'EGM96_GEOID_MSL' as const
      };

      const local = bridge.toMetricLocal(mercatorPayload);
      // Metric East position should be approximately 50m * cos(lat) due to Mercator scale factor
      expect(local[0]).toBeGreaterThan(30.0);
      expect(local[0]).toBeLessThan(45.0);
    });

    it('translates UTM projection coordinates (e.g. USGS LiDAR / Municipal GIS)', () => {
      // NYC is in UTM Zone 18 North
      // Times Square approx UTM: Easting ~ 585720, Northing ~ 4512400
      const [lat, lng] = UniversalGeographicBridge.utmToWgs84(585720, 4512400, 18, true);

      expect(lat).toBeGreaterThan(40.7);
      expect(lat).toBeLessThan(40.8);
      expect(lng).toBeGreaterThan(-74.05);
      expect(lng).toBeLessThan(-73.9);

      const utmPayload = {
        projectedX: 585720,
        projectedY: 4512400,
        crs: 'UTM' as const,
        utmZone: 18,
        utmIsNorthern: true,
        altitude: 15.0
      };

      const local = bridge.toMetricLocal(utmPayload);
      expect(isFinite(local[0])).toBe(true);
      expect(isFinite(local[1])).toBe(true);
      expect(isFinite(local[2])).toBe(true);
    });

    it('harmonizes vertical datum differences (Ellipsoid vs. Geoid MSL)', () => {
      // In NYC, Geoid undulation N = -31.5m
      // Ellipsoid = MSL + N = 100m + (-31.5m) = 68.5m
      const mslAlt = 100.0;
      const ellipsoidal = UniversalGeographicBridge.harmonizeElevation(
        mslAlt,
        'EGM96_GEOID_MSL',
        'WGS84_ELLIPSOID',
        -31.5
      );
      expect(ellipsoidal).toBeCloseTo(68.5, 4);

      // And round-trip back to MSL
      const roundTripMsl = UniversalGeographicBridge.harmonizeElevation(
        ellipsoidal,
        'WGS84_ELLIPSOID',
        'EGM96_GEOID_MSL',
        -31.5
      );
      expect(roundTripMsl).toBeCloseTo(100.0, 4);
    });

    it('converts batch geographic points to GPU Float32Array directly', () => {
      const points = [
        { lat: 40.758896, lng: -73.985130, altitude: 15.0 },
        { lat: 40.758996, lng: -73.985130, altitude: 20.0 },
        { lat: 40.758896, lng: -73.985030, altitude: 25.0 }
      ];

      const buffer = bridge.translateBatch(points);
      expect(buffer).toBeInstanceOf(Float32Array);
      expect(buffer.length).toBe(9); // 3 vertices * 3 coords (X, Y, Z)
      expect(buffer[0]).toBeCloseTo(0.0, 3); // Point 0 East
      expect(buffer[1]).toBeCloseTo(0.0, 3); // Point 0 Up
      expect(buffer[2]).toBeCloseTo(0.0, 3); // Point 0 North
    });
  });
});
