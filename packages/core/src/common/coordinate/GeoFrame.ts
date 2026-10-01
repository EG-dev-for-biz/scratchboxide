/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LocalTangentPlane, LatLngAlt, Vec3 } from './LocalTangentPlane';
import { GeoAnchor4D } from '../geospatial-4d-protocol';

// Standard spatial scale mapping:
// 51000 scene units per 111,320 meters (approx. 1 degree latitude at equator)
// 1 scene unit = 111320 / 51000 meters ≈ 2.182745 meters
export const DEFAULT_SCENE_SCALE_FACTOR = 51000;
export const METERS_PER_DEGREE_LAT = 111320;
export const DEFAULT_METERS_PER_SCENE_UNIT = METERS_PER_DEGREE_LAT / DEFAULT_SCENE_SCALE_FACTOR;

export class GeoFrame {
  private ltp: LocalTangentPlane;
  public readonly anchor: GeoAnchor4D;
  public readonly scaleFactor: number;
  public readonly metersPerUnit: number;

  constructor(
    anchor: GeoAnchor4D,
    scaleFactor: number = DEFAULT_SCENE_SCALE_FACTOR / METERS_PER_DEGREE_LAT
  ) {
    this.anchor = {
      lat: anchor.lat,
      lng: anchor.lng,
      alt: anchor.alt ?? 0,
      geoidHeight: anchor.geoidHeight ?? 0,
    };
    this.scaleFactor = scaleFactor;
    this.metersPerUnit = 1.0 / scaleFactor;

    this.ltp = new LocalTangentPlane(
      {
        lat: this.anchor.lat,
        lng: this.anchor.lng,
        alt: this.anchor.alt,
      },
      this.anchor.geoidHeight ?? 0
    );
  }

  /**
   * Converts a WGS-84 Geographic Coordinate (lat, lng, alt) to 3D Scene Coordinates [x, y, z].
   * Three.js Scene Convention:
   *   +X = East
   *   +Y = Up
   *   -Z = North
   */
  toScene(geo: LatLngAlt | GeoAnchor4D): Vec3 {
    const metricEnu = this.ltp.toLocal({
      lat: geo.lat,
      lng: geo.lng,
      alt: geo.alt ?? this.anchor.alt ?? 0,
    });

    return [
      metricEnu[0] * this.scaleFactor,
      metricEnu[1] * this.scaleFactor,
      metricEnu[2] * this.scaleFactor,
    ];
  }

  /**
   * Converts 3D Scene Coordinates [x, y, z] back to a WGS-84 Geographic Coordinate.
   */
  toGeo(pos: Vec3 | { x: number; y: number; z: number }): GeoAnchor4D {
    const px = Array.isArray(pos) ? pos[0] : pos.x;
    const py = Array.isArray(pos) ? pos[1] : pos.y;
    const pz = Array.isArray(pos) ? pos[2] : pos.z;

    const metricEnu: Vec3 = [
      px / this.scaleFactor,
      py / this.scaleFactor,
      pz / this.scaleFactor,
    ];

    const result = this.ltp.toLatLng(metricEnu);

    return {
      lat: result.lat,
      lng: result.lng,
      alt: result.alt,
      geoidHeight: this.anchor.geoidHeight ?? 0,
    };
  }
}
