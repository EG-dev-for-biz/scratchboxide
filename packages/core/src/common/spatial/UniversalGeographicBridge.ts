/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LocalTangentPlane, LatLngAlt, Vec3 } from '../coordinate/LocalTangentPlane';
import { GeodeticAnchor } from './colmap-vector-reference-types';
import { GeodeticAnchorValidator } from './GeodeticAnchorValidator';
import { MetricScaleNormalizer, MetricUnitType } from './MetricScaleNormalizer';

/**
 * Supported or extensible Coordinate Reference System (CRS).
 * Open string literal prevents closed taxonomy restrictions (ADA Pillar 1).
 */
export type GeographicCrs =
  | 'EPSG:4326'  // WGS-84 Geodetic (Lat, Lng in degrees, Ellipsoid Height in meters)
  | 'EPSG:3857'  // WGS-84 Spherical Web Mercator (East, North in meters)
  | 'EPSG:4978'  // WGS-84 ECEF 3D Cartesian (X, Y, Z in meters from Earth center)
  | 'UTM'        // Universal Transverse Mercator (requires zone & hemisphere)
  | (string & {});

/**
 * Vertical Datum classification for height harmonization.
 * Open string literal ensures future geoids and tidal datums are supported.
 */
export type VerticalDatum =
  | 'WGS84_ELLIPSOID'   // Pure geometric distance from WGS-84 ellipsoid (GPS, Google 3D Tiles, Cesium)
  | 'EGM96_GEOID_MSL'   // Orthometric height above Mean Sea Level via EGM96 (Vector Roads, OSM, Cadastral)
  | 'EGM2008_GEOID_MSL' // Orthometric height above Mean Sea Level via EGM2008
  | 'NAVD88'            // North American Vertical Datum 1988 (USGS DEMs, state GIS)
  | 'LOCAL_GROUND_REL'  // Height relative to ground contact (e.g. building elevation above local grade)
  | (string & {});

/**
 * Generic point payload representing any incoming geographic data source.
 */
export interface GeographicPointPayload {
  /** Latitude (degrees) if using EPSG:4326 */
  lat?: number;
  /** Longitude (degrees) if using EPSG:4326 */
  lng?: number;
  /** Altitude/Elevation value */
  altitude?: number;

  /** ECEF Cartesian coordinates (meters) if using EPSG:4978 (e.g. Google 3D Tiles, Cesium) */
  ecef?: [number, number, number];

  /** Projected coordinates (meters/feet) if using EPSG:3857 or UTM */
  projectedX?: number;
  projectedY?: number;

  /** Coordinate Reference System (defaults to EPSG:4326 if lat/lng provided, EPSG:4978 if ecef provided) */
  crs?: GeographicCrs;

  /** Vertical datum of altitude (defaults to 'WGS84_ELLIPSOID' for 3D tiles, 'EGM96_GEOID_MSL' for 2D vectors) */
  verticalDatum?: VerticalDatum;

  /** Linear unit of measurement (defaults to 'meters') */
  unit?: MetricUnitType;

  /** UTM zone number (1-60) if crs === 'UTM' */
  utmZone?: number;
  /** UTM hemisphere if crs === 'UTM' */
  utmIsNorthern?: boolean;
}

// Earth constants for WGS-84
const WGS84_A = 6378137.0; // semi-major axis (meters)
const WGS84_F = 1.0 / 298.257223563;
const WGS84_B = WGS84_A * (1.0 - WGS84_F);
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

/**
 * Universal Geographic Data Ingestion & Translation Bridge
 *
 * Implements Layer 2 of the canonical architecture:
 * Bridges ANY geographic data source (Google Photorealistic 3D Tiles, 2D Vector Roads,
 * OpenStreetMap, Overture Maps, Cesium 3D Tiles, USGS GeoTIFF DEMs, LiDAR, and UTM projections)
 * into the unified local metric coordinate space (Layer 1: 1 unit = 1 meter).
 */
export class UniversalGeographicBridge {
  private ltp: LocalTangentPlane;
  public readonly anchor: GeodeticAnchor;

  constructor(anchor: GeodeticAnchor) {
    GeodeticAnchorValidator.validate(anchor);
    this.anchor = { ...anchor };
    this.ltp = new LocalTangentPlane(
      {
        lat: this.anchor.lat,
        lng: this.anchor.lng,
        alt: this.anchor.elevationMeters
      },
      this.anchor.geoidHeightMeters ?? 0
    );
  }

  /**
   * Translates any incoming geographic point payload into local Three.js metric coordinates.
   * Coordinate convention:
   *   +X = East (meters)
   *   +Y = Up (meters)
   *   -Z = North (meters)
   */
  public toMetricLocal(payload: GeographicPointPayload): Vec3 {
    // 1. Resolve unit scaling if not meters
    const unitFactor = payload.unit ? MetricScaleNormalizer.getUnitScaleFactor(payload.unit) : 1.0;

    // 2. Direct ECEF Cartesian branch (Google 3D Tiles, Cesium b3dm, EPSG:4978)
    // Directly transforms via double-precision rotation matrix without intermediate spherical loss
    if (payload.ecef) {
      const ex = payload.ecef[0] * unitFactor;
      const ey = payload.ecef[1] * unitFactor;
      const ez = payload.ecef[2] * unitFactor;

      const dx = ex - this.ltp.originEcef[0];
      const dy = ey - this.ltp.originEcef[1];
      const dz = ez - this.ltp.originEcef[2];

      const east = this.ltp.rotMatrix[0][0] * dx + this.ltp.rotMatrix[0][1] * dy + this.ltp.rotMatrix[0][2] * dz;
      const north = this.ltp.rotMatrix[1][0] * dx + this.ltp.rotMatrix[1][1] * dy + this.ltp.rotMatrix[1][2] * dz;
      const up = this.ltp.rotMatrix[2][0] * dx + this.ltp.rotMatrix[2][1] * dy + this.ltp.rotMatrix[2][2] * dz;

      return [east, up, -north];
    }

    // 3. Resolve CRS and normalize to WGS-84 Geodetic (lat, lng, alt)
    const geodetic = this.normalizePayloadToGeodetic(payload, unitFactor);

    // 4. Reconcile vertical datum to MSL (LocalTangentPlane expects orthometric MSL height)
    const geoidOffset = this.anchor.geoidHeightMeters ?? 0;
    const mslAlt = UniversalGeographicBridge.harmonizeElevation(
      geodetic.alt ?? 0,
      payload.verticalDatum ?? 'EGM96_GEOID_MSL',
      'EGM96_GEOID_MSL',
      geoidOffset
    );

    // 5. Project through LocalTangentPlane in Float64
    return this.ltp.toLocal({
      lat: geodetic.lat,
      lng: geodetic.lng,
      alt: mslAlt
    });
  }

  /**
   * Translates a local metric coordinate back to real-world WGS-84 Geodetic coordinates.
   */
  public toGeodetic(
    localEnu: Vec3,
    targetDatum: VerticalDatum = 'WGS84_ELLIPSOID'
  ): LatLngAlt & { verticalDatum: VerticalDatum } {
    const rawGeo = this.ltp.toLatLng(localEnu);
    const geoidOffset = this.anchor.geoidHeightMeters ?? 0;

    const targetAlt = UniversalGeographicBridge.harmonizeElevation(
      rawGeo.alt ?? 0,
      'EGM96_GEOID_MSL',
      targetDatum,
      geoidOffset
    );

    return {
      lat: rawGeo.lat,
      lng: rawGeo.lng,
      alt: targetAlt,
      verticalDatum: targetDatum
    };
  }

  /**
   * Batch converts an array of geographic payloads directly into a Float32Array
   * suitable for WebGL vertex attributes [X, Y, Z, X, Y, Z, ...].
   */
  public translateBatch(payloads: GeographicPointPayload[]): Float32Array {
    const buffer = new Float32Array(payloads.length * 3);
    for (let i = 0; i < payloads.length; i++) {
      const p = this.toMetricLocal(payloads[i]!);
      buffer[i * 3] = Math.fround(p[0]);
      buffer[i * 3 + 1] = Math.fround(p[1]);
      buffer[i * 3 + 2] = Math.fround(p[2]);
    }
    return buffer;
  }

  /**
   * Reconciles elevation between different vertical datums.
   * Basic relation: h (Ellipsoid) = H (Orthometric / MSL) + N (Geoid Undulation)
   */
  public static harmonizeElevation(
    altitude: number,
    fromDatum: VerticalDatum,
    toDatum: VerticalDatum,
    geoidUndulationM: number = 0
  ): number {
    if (fromDatum === toDatum) return altitude;

    let ellipsoidalHeight: number;

    // Convert input datum to WGS-84 Ellipsoid
    switch (fromDatum) {
      case 'WGS84_ELLIPSOID':
        ellipsoidalHeight = altitude;
        break;
      case 'EGM96_GEOID_MSL':
      case 'EGM2008_GEOID_MSL':
      case 'NAVD88':
      case 'LOCAL_GROUND_REL':
        ellipsoidalHeight = altitude + geoidUndulationM;
        break;
      default:
        ellipsoidalHeight = altitude;
        break;
    }

    // Convert WGS-84 Ellipsoid to target datum
    switch (toDatum) {
      case 'WGS84_ELLIPSOID':
        return ellipsoidalHeight;
      case 'EGM96_GEOID_MSL':
      case 'EGM2008_GEOID_MSL':
      case 'NAVD88':
      case 'LOCAL_GROUND_REL':
        return ellipsoidalHeight - geoidUndulationM;
      default:
        return ellipsoidalHeight;
    }
  }

  /**
   * Converts Web Mercator (EPSG:3857) meters to WGS-84 (EPSG:4326) degrees.
   */
  public static webMercatorToWgs84(x: number, y: number): [number, number] {
    const lng = (x / (WGS84_A * Math.PI)) * 180.0;
    const lat = (Math.atan(Math.exp(y / WGS84_A)) * 2 - Math.PI / 2) * (180.0 / Math.PI);
    return [Math.max(-85.05112878, Math.min(85.05112878, lat)), lng];
  }

  /**
   * Converts WGS-84 (EPSG:4326) degrees to Web Mercator (EPSG:3857) meters.
   */
  public static wgs84ToWebMercator(lat: number, lng: number): [number, number] {
    const x = (lng * Math.PI / 180.0) * WGS84_A;
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const latRad = clampedLat * Math.PI / 180.0;
    const y = WGS84_A * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    return [x, y];
  }

  /**
   * Converts UTM (Universal Transverse Mercator) easting & northing to WGS-84 lat/lng.
   */
  public static utmToWgs84(
    easting: number,
    northing: number,
    zone: number,
    isNorthern: boolean = true
  ): [number, number] {
    const k0 = 0.9996;
    const e2 = WGS84_E2;
    const ePrime2 = e2 / (1.0 - e2);

    const x = easting - 500000.0;
    let y = northing;
    if (!isNorthern) y -= 10000000.0;

    const m = y / k0;
    const mu = m / (WGS84_A * (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0));

    const e1 = (1.0 - Math.sqrt(1.0 - e2)) / (1.0 + Math.sqrt(1.0 - e2));
    const j1 = 3.0 * e1 / 2.0 - 27.0 * e1 * e1 * e1 / 32.0;
    const j2 = 21.0 * e1 * e1 / 16.0 - 55.0 * e1 * e1 * e1 * e1 / 32.0;
    const j3 = 151.0 * e1 * e1 * e1 / 96.0;

    const fp = mu + j1 * Math.sin(2.0 * mu) + j2 * Math.sin(4.0 * mu) + j3 * Math.sin(6.0 * mu);

    const sinFp = Math.sin(fp);
    const cosFp = Math.cos(fp);
    const tanFp = Math.tan(fp);

    const c1 = ePrime2 * cosFp * cosFp;
    const t1 = tanFp * tanFp;
    const r1 = WGS84_A * (1.0 - e2) / Math.pow(1.0 - e2 * sinFp * sinFp, 1.5);
    const n1 = WGS84_A / Math.sqrt(1.0 - e2 * sinFp * sinFp);

    const d = x / (n1 * k0);

    const latRad = fp - (n1 * tanFp / r1) * (
      (d * d) / 2.0 -
      (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 * c1 - 9.0 * ePrime2) * Math.pow(d, 4.0) / 24.0 +
      (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 * t1 - 252.0 * ePrime2 - 3.0 * c1 * c1) * Math.pow(d, 6.0) / 720.0
    );

    const centralLng = (zone - 1) * 6 - 180 + 3;
    const lngRad = (
      d -
      (1.0 + 2.0 * t1 + c1) * Math.pow(d, 3.0) / 6.0 +
      (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * ePrime2 + 24.0 * t1 * t1) * Math.pow(d, 5.0) / 120.0
    ) / cosFp;

    const lat = latRad * (180.0 / Math.PI);
    const lng = centralLng + lngRad * (180.0 / Math.PI);

    return [lat, lng];
  }

  /**
   * Internal helper to normalize any arbitrary payload to standard WGS-84 Geodetic.
   */
  private normalizePayloadToGeodetic(
    payload: GeographicPointPayload,
    unitFactor: number
  ): LatLngAlt {
    // 1. Direct Lat/Lng (EPSG:4326) - e.g. OpenStreetMap, Overture Maps, GeoJSON
    if (payload.lat !== undefined && payload.lng !== undefined) {
      return {
        lat: payload.lat,
        lng: payload.lng,
        alt: (payload.altitude ?? 0) * unitFactor
      };
    }

    // 2. ECEF Cartesian (EPSG:4978) - e.g. Google Photorealistic 3D Tiles, Cesium b3dm
    if (payload.ecef) {
      const [ex, ey, ez] = payload.ecef;
      const scaledEcef: Vec3 = [ex * unitFactor, ey * unitFactor, ez * unitFactor];
      return this.ecefToGeodetic(scaledEcef);
    }

    // 3. Web Mercator (EPSG:3857) - e.g. Google 2D Vector MVT, Mapbox tiles
    if (payload.crs === 'EPSG:3857' && payload.projectedX !== undefined && payload.projectedY !== undefined) {
      const [lat, lng] = UniversalGeographicBridge.webMercatorToWgs84(
        payload.projectedX * unitFactor,
        payload.projectedY * unitFactor
      );
      return {
        lat,
        lng,
        alt: (payload.altitude ?? 0) * unitFactor
      };
    }

    // 4. UTM Projection - e.g. USGS LiDAR, municipal orthophotos
    if (payload.crs === 'UTM' && payload.projectedX !== undefined && payload.projectedY !== undefined && payload.utmZone) {
      const [lat, lng] = UniversalGeographicBridge.utmToWgs84(
        payload.projectedX * unitFactor,
        payload.projectedY * unitFactor,
        payload.utmZone,
        payload.utmIsNorthern ?? true
      );
      return {
        lat,
        lng,
        alt: (payload.altitude ?? 0) * unitFactor
      };
    }

    // Fallback: Default to anchor
    return {
      lat: this.anchor.lat,
      lng: this.anchor.lng,
      alt: (payload.altitude ?? 0) * unitFactor
    };
  }

  /**
   * Converts ECEF Cartesian coordinates (meters) to WGS-84 (Lat, Lng, Alt).
   * Bowring's method for sub-millimeter precision.
   */
  private ecefToGeodetic(ecef: Vec3): LatLngAlt {
    const x = ecef[0], y = ecef[1], z = ecef[2];
    const p = Math.sqrt(x * x + y * y);

    if (p < 1e-6) {
      // Near poles
      const lat = z > 0 ? 90 : -90;
      const alt = Math.abs(z) - WGS84_B;
      return { lat, lng: 0, alt };
    }

    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    const latRad = Math.atan2(
      z + ((WGS84_A * WGS84_A - WGS84_B * WGS84_B) / WGS84_B) * Math.pow(sinTheta, 3),
      p - WGS84_E2 * WGS84_A * Math.pow(cosTheta, 3)
    );

    const lngRad = Math.atan2(y, x);

    const sinLat = Math.sin(latRad);
    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
    const alt = p / Math.cos(latRad) - n;

    return {
      lat: latRad * (180.0 / Math.PI),
      lng: lngRad * (180.0 / Math.PI),
      alt
    };
  }
}
