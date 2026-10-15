/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE } from './google-maps-service';

export interface GoogleGeodeticAnchor {
  lat: number;
  lng: number;
  elevation: number;
  placeId: string;
  formattedAddress: string;
}

export interface GoogleRoadCorridor {
  id: string;
  name: string;
  type: 'avenue' | 'cross_street' | 'commercial_corridor' | 'diagonal_corridor';
  widthMeters: number;
  lanes: number;
  pointsLocalENU: [number, number][]; // [X (East), Z (South/North)] in meters
  coordinatesWGS84: [number, number][]; // [lng, lat]
  elevationASL?: number[]; // Elevation in meters ASL along centerline points
}

export interface GoogleLandscapePolygon {
  id: string;
  name: string;
  type: 'park' | 'plaza' | 'pedestrian_mall';
  polygonLocalENU: [number, number][]; // ring in meters [X, Z]
  coordinatesWGS84: [number, number][];
  colorHex?: string;
  elevationASL?: number;
  elevationRelativeMeters?: number;
}

export interface GoogleParcelEnvelope {
  id: string;
  name: string;
  blockNumber: number;
  lotNumber?: number;
  isLandmark?: boolean;
  baseElevation: number;
  heightMeters: number;
  levels?: number;
  polygonLocalENU: [number, number][]; // ring in meters [X, Z]
  coordinatesWGS84: [number, number][];
  elevationASL?: number;
  elevationRelativeMeters?: number;
}

export interface GoogleColmapCameraPose {
  id: number;
  name: string;
  positionLocalENU: [number, number, number]; // [X (East), Y (Elevation), Z (South/North)] in meters
  rotationYDegrees: number; // yaw angle in degrees
  forwardVector: [number, number, number];
  focalLengthMm: number;
  sensorWidthMm: number;
  fovDegrees: number;
  coordinatesWGS84: {
    lat: number;
    lng: number;
    elevation: number;
  };
  groundElevationASL?: number;
  cameraHeightAboveGround?: number;
}

export interface GoogleMidtownVectorMapping {
  version: string;
  source: 'google_maps_platform_reference';
  anchor: GoogleGeodeticAnchor;
  styling: typeof GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE;
  gridBearingDegrees: number; // 29.0 degrees Manhattan grid rotation
  roads: GoogleRoadCorridor[];
  parcels: GoogleParcelEnvelope[];
  landscapes?: GoogleLandscapePolygon[];
  colmapCameraPoses?: GoogleColmapCameraPose[];
}

const EARTH_RADIUS = 6378137.0;

/**
 * Projection helpers and GeoJSON ingestion for Google vector map data. There is no built-in dataset: the canned
 * Midtown Manhattan roads, parcels and survey stations (anchored at the Empire State Building, 15 m ground) and
 * the nearest-parcel lookup built on them are gone, so nothing answers for a place it was not given data for.
 */
export class GoogleVectorMappingService {
  /**
   * Projects WGS84 coordinates to local ENU tangent plane relative to anchor.
   */
  public static projectWgs84ToEnu(
    lng: number,
    lat: number,
    anchor: Pick<GoogleGeodeticAnchor, 'lat' | 'lng'>
  ): [number, number] {
    const dLngRad = ((lng - anchor.lng) * Math.PI) / 180.0;
    const dLatRad = ((lat - anchor.lat) * Math.PI) / 180.0;
    const originLatRad = (anchor.lat * Math.PI) / 180.0;

    const x = dLngRad * EARTH_RADIUS * Math.cos(originLatRad);
    const z = -dLatRad * EARTH_RADIUS; // Three.js North is -Z
    return [x, z];
  }

  /**
   * Inverse projection: Local ENU tangent plane [X, Z] back to WGS84 [lng, lat].
   */
  public static projectEnuToWgs84(
    x: number,
    z: number,
    anchor: Pick<GoogleGeodeticAnchor, 'lat' | 'lng'>
  ): [number, number] {
    const originLatRad = (anchor.lat * Math.PI) / 180.0;
    const dLatRad = -z / EARTH_RADIUS;
    const dLngRad = x / (EARTH_RADIUS * Math.cos(originLatRad));

    const lat = anchor.lat + (dLatRad * 180.0) / Math.PI;
    const lng = anchor.lng + (dLngRad * 180.0) / Math.PI;
    return [lng, lat];
  }

  /**
   * Ingests arbitrary GeoJSON FeatureCollections (polygons, building envelopes,
   * roads, parks/plazas) and converts them into structured GoogleMidtownVectorMapping format.
   * Automatically projects from WGS84 to local ENU tangent plane.
   */
  public static ingestGeoJsonFeatures(
    featureCollection: {
      type: string;
      features: Array<{
        type: string;
        geometry: { type: string; coordinates: any };
        properties?: Record<string, any>;
      }>;
    },
    anchor: GoogleGeodeticAnchor
  ): Partial<GoogleMidtownVectorMapping> & { parcelsWithoutHeight: number } {
    const roads: GoogleRoadCorridor[] = [];
    const parcels: GoogleParcelEnvelope[] = [];
    const landscapes: GoogleLandscapePolygon[] = [];

    let parcelsWithoutHeight = 0;

    if (!featureCollection || !Array.isArray(featureCollection.features)) {
      return { roads, parcels, landscapes, parcelsWithoutHeight };
    }

    featureCollection.features.forEach((feat, idx) => {
      const props = feat.properties || {};
      const geom = feat.geometry;
      if (!geom) return;

      if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
        const rings: number[][][] = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates[0];
        if (!rings || rings.length === 0) return;
        const exteriorRing = rings[0]; // [lng, lat]

        const polygonLocalENU: [number, number][] = exteriorRing.map(([lng, lat]) =>
          this.projectWgs84ToEnu(lng, lat, anchor)
        );
        const coordinatesWGS84: [number, number][] = exteriorRing.map(([lng, lat]) => [lng, lat]);

        const featureClass = props.class || props.type || props.landuse || props.building;
        const isPark = featureClass === 'park' || featureClass === 'garden' || featureClass === 'grass' || props.leisure === 'park';
        const isPlaza = featureClass === 'plaza' || featureClass === 'pedestrian' || props.highway === 'pedestrian';

        if (isPark || isPlaza) {
          landscapes.push({
            id: props.id || `ingested_landscape_${idx}`,
            name: props.name || (isPark ? `Park Area ${idx}` : `Plaza Area ${idx}`),
            type: isPark ? 'park' : isPlaza ? 'plaza' : 'pedestrian_mall',
            polygonLocalENU,
            coordinatesWGS84,
            colorHex: isPark ? '#4ade80' : '#e2e8f0'
          });
        } else {
          // Building parcel envelope: its height is the feature's own (height, or levels at 3.8 m); a building
          // without one is counted and left out rather than given an invented 45 m.
          const levelsProp = parseInt(props.levels, 10);
          const heightMeters = parseFloat(props.height ?? props.heightMeters ?? (Number.isFinite(levelsProp) ? levelsProp * 3.8 : NaN));
          if (!Number.isFinite(heightMeters)) {
            parcelsWithoutHeight++;
            return;
          }

          parcels.push({
            id: props.id || `ingested_parcel_${idx}`,
            name: props.name || `Building Parcel ${idx}`,
            blockNumber: props.blockNumber || 0,
            lotNumber: props.lotNumber || idx,
            isLandmark: !!props.isLandmark,
            baseElevation: anchor.elevation,
            heightMeters,
            ...(Number.isFinite(levelsProp) ? { levels: levelsProp } : {}),
            polygonLocalENU,
            coordinatesWGS84
          });
        }
      } else if (geom.type === 'LineString') {
        const coords: number[][] = geom.coordinates;
        const pointsLocalENU: [number, number][] = coords.map(([lng, lat]) =>
          this.projectWgs84ToEnu(lng, lat, anchor)
        );
        const coordinatesWGS84: [number, number][] = coords.map(([lng, lat]) => [lng, lat]);

        roads.push({
          id: props.id || `ingested_road_${idx}`,
          name: props.name || `Road Corridor ${idx}`,
          type: props.type || 'cross_street',
          widthMeters: parseFloat(props.width || props.widthMeters || 18.0),
          lanes: parseInt(props.lanes || 2, 10),
          pointsLocalENU,
          coordinatesWGS84
        });
      }
    });

    return { roads, parcels, landscapes, parcelsWithoutHeight };
  }
}
