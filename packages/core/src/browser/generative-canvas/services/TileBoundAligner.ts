/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LocalTangentPlane, LatLngAlt, Vec3 } from '../../../common/coordinate/LocalTangentPlane';

export interface TileBounds {
  nw: LatLngAlt;
  se: LatLngAlt;
  center: LatLngAlt;
}

export interface LocalTileBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
}

export interface SlippyTileXYZ {
  x: number;
  y: number;
  z: number;
}

/**
 * Utility for converting standard XYZ Slippy Map tile coordinates to
 * Geodetic (Lat/Lng) bounds and local Three.js coordinate bounds
 * relative to an active LocalTangentPlane origin.
 */
export class TileBoundAligner {
  /**
   * Converts slippy map XYZ coordinates to Geodetic bounds (NW and SE corners).
   */
  static xyzToLatLngBounds(x: number, y: number, z: number): TileBounds {
    const n = Math.pow(2, z);

    // Calculate Northwest (top-left) corner
    const lonNW = (x / n) * 360 - 180;
    const latRadNW = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const latNW = (latRadNW * 180) / Math.PI;

    // Calculate Southeast (bottom-right) corner
    const lonSE = ((x + 1) / n) * 360 - 180;
    const latRadSE = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
    const latSE = (latRadSE * 180) / Math.PI;

    // Calculate center coordinates
    const lonCenter = ((x + 0.5) / n) * 360 - 180;
    const latRadCenter = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
    const latCenter = (latRadCenter * 180) / Math.PI;

    return {
      nw: { lat: latNW, lng: lonNW, alt: 0 },
      se: { lat: latSE, lng: lonSE, alt: 0 },
      center: { lat: latCenter, lng: lonCenter, alt: 0 },
    };
  }

  /**
   * Converts standard Lat/Lng and Zoom level to Slippy Map X and Y coordinates.
   */
  static latLngToXYZ(lat: number, lng: number, z: number): SlippyTileXYZ {
    const n = Math.pow(2, z);
    const r = lat * (Math.PI / 180);
    const lts = Math.log(Math.tan(r) + 1 / Math.cos(r));

    const x = Math.floor(n * ((lng + 180) / 360));
    const y = Math.floor((n * (1 - lts / Math.PI)) / 2);

    return { x, y, z };
  }

  /**
   * Projects an XYZ tile's geodetic bounding box into the local Three.js space
   * relative to a LocalTangentPlane.
   */
  static xyzToLocalBounds(
    x: number,
    y: number,
    z: number,
    ltp: LocalTangentPlane,
    minHeight: number = -200,
    maxHeight: number = 2000
  ): LocalTileBounds {
    const bounds = this.xyzToLatLngBounds(x, y, z);

    // Project corners into local ENU tangent plane
    const nwLocal = ltp.toLocal({ ...bounds.nw, alt: minHeight });
    const seLocal = ltp.toLocal({ ...bounds.se, alt: maxHeight });
    const centerLocal = ltp.toLocal({ ...bounds.center, alt: (minHeight + maxHeight) / 2 });

    // In Three.js space:
    // X = East (positive right)
    // Y = Up (positive up)
    // Z = -North (negative forward)
    const xMin = Math.min(nwLocal[0], seLocal[0]);
    const xMax = Math.max(nwLocal[0], seLocal[0]);
    const yMin = Math.min(nwLocal[1], seLocal[1]);
    const yMax = Math.max(nwLocal[1], seLocal[1]);
    const zMin = Math.min(nwLocal[2], seLocal[2]);
    const zMax = Math.max(nwLocal[2], seLocal[2]);

    return {
      min: [xMin, yMin, zMin],
      max: [xMax, yMax, zMax],
      center: centerLocal,
    };
  }

  /**
   * Computes a local bounding box in meters around a center geodetic coordinate.
   */
  static latLngRadiusToLocalBounds(
    centerLat: number,
    centerLng: number,
    radiusMeters: number,
    ltp: LocalTangentPlane,
    minHeight: number = -10,
    maxHeight: number = 250
  ): LocalTileBounds {
    const centerLocal = ltp.toLocal({ lat: centerLat, lng: centerLng, alt: (minHeight + maxHeight) / 2 });

    return {
      min: [centerLocal[0] - radiusMeters, minHeight, centerLocal[2] - radiusMeters],
      max: [centerLocal[0] + radiusMeters, maxHeight, centerLocal[2] + radiusMeters],
      center: centerLocal
    };
  }
}
