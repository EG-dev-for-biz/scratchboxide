/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface GeoCoordinate {
    lat: number;
    lng: number;
    altitudeMeters?: number;
}

export interface CameraAttitude {
    headingDeg: number; // Azimuth relative to True North (0-360)
    pitchDeg: number;   // Elevation angle (-90 to +90)
    rollDeg: number;    // Bank angle (-180 to +180)
}

export interface CameraGroundTruth extends GeoCoordinate {
    vantagePointName: string;
    headingDeg: number;
    pitchDeg: number;
    standoffDistanceMeters: number;
}

export interface CameraViewFrustum {
    apex: GeoCoordinate; // Camera position
    leftRay: GeoCoordinate;
    rightRay: GeoCoordinate;
    horizontalFovDeg: number;
    reachMeters: number;
    polygonCoords: [number, number][]; // [lat, lng] array for Google Maps Polygon
}

export interface GeoBoxStage1Result {
    lat: number;
    lng: number;
    similarity: number;
    errorKm?: number;
}

export interface GeoBoxStage2Result {
    landmarkName: string;
    lat: number;
    lng: number;
    types: string[];
    errorMeters?: number;
}

export interface GoogleMapTiles3DConfig {
    camera_position: {
        lat: number;
        lng: number;
        altitude: number;
    };
    center: {
        lat: number;
        lng: number;
        altitude: number;
    };
    heading: number;
    tilt: number;
    roll: number;
    range: number;
    fov: number;
    mode: 'satellite' | 'hybrid' | 'roadmap';
    photometric_match_score: number;
    match_confidence: string;
    precision_tolerance_mm: number;
}

export interface VideoMetadata {
    fps: number;
    total_frames: number;
    duration_s: number;
    width: number;
    height: number;
    extracted_keyframes_count: number;
    first_frame_path: string;
}

export interface GeoBoxStage5Result {
    cameraLat: number;
    cameraLng: number;
    cameraAltMeters: number;
    attitude: CameraAttitude;
    standoffDistanceMeters: number;
    vantagePointEstimated: string;
    viewFrustum: CameraViewFrustum;
    inlierCount: number;
    streetViewSnapped: boolean;
    cameraPositionErrorMeters?: number;
    cameraPositionErrorMm?: number;
    cameraResidualMm?: number;
    subpixelFeatureCount?: number;
    reprojectionResidualPx?: number;
    headingErrorDeg?: number;
    googleMapTiles3d?: GoogleMapTiles3DConfig;
}

export interface GeoBoxTrajectoryPoint extends GeoCoordinate {
    frameIndex: number;
    timestampSec: number;
    enuX: number;
    enuY: number;
    enuZ: number;
    headingDeg?: number;
    pitchDeg?: number;
}

export interface GeoBoxPrecisionResult {
    queryImage: string;
    originalInputPath?: string;
    isVideo?: boolean;
    videoMetadata?: VideoMetadata;
    targetLandmark: GeoCoordinate;
    cameraGroundTruth?: CameraGroundTruth;
    stage1: GeoBoxStage1Result;
    stage2: GeoBoxStage2Result;
    stage5: GeoBoxStage5Result;
    trajectory: GeoBoxTrajectoryPoint[];
    photometricSSIM: number;
    cameraPositionErrorMeters?: number;
    cameraPositionErrorMm?: number;
    cameraResidualMm?: number;
    isCertified100Percent: boolean;
    isMillimeterCertified?: boolean;
    googleMapTiles3d?: GoogleMapTiles3DConfig;
}

/**
 * WGS-84 Ellipsoid Constants
 */
export const WGS84_A = 6378137.0; // semi-major axis (meters)
export const WGS84_F = 1.0 / 298.257223563; // flattening
export const WGS84_E2 = WGS84_F * (2.0 - WGS84_F); // first eccentricity squared

/**
 * Calculates Great-Circle distance between two coordinates in kilometers using Haversine formula.
 */
export function haversineDistanceKm(coord1: GeoCoordinate, coord2: GeoCoordinate): number {
    const R = 6371.0; // Earth mean radius in km
    const dLat = (coord2.lat - coord1.lat) * (Math.PI / 180.0);
    const dLng = (coord2.lng - coord1.lng) * (Math.PI / 180.0);

    const a =
        Math.sin(dLat / 2.0) ** 2 +
        Math.cos(coord1.lat * (Math.PI / 180.0)) *
        Math.cos(coord2.lat * (Math.PI / 180.0)) *
        Math.sin(dLng / 2.0) ** 2;

    const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0.0, 1.0 - a)));
    return R * c;
}

/**
 * Calculates Great-Circle distance between two coordinates in meters.
 */
export function haversineDistanceMeters(coord1: GeoCoordinate, coord2: GeoCoordinate): number {
    return haversineDistanceKm(coord1, coord2) * 1000.0;
}

/**
 * Converts Geodetic (WGS-84) latitude, longitude, and height to Earth-Centered, Earth-Fixed (ECEF) coordinates.
 */
export function geodeticToEcef(coord: GeoCoordinate): [number, number, number] {
    const latRad = coord.lat * (Math.PI / 180.0);
    const lngRad = coord.lng * (Math.PI / 180.0);
    const alt = coord.altitudeMeters ?? 0.0;

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    const N = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);

    const x = (N + alt) * cosLat * cosLng;
    const y = (N + alt) * cosLat * sinLng;
    const z = (N * (1.0 - WGS84_E2) + alt) * sinLat;

    return [x, y, z];
}

/**
 * Converts ECEF coordinates to Local Tangent Plane (East-North-Up) relative to an anchor geodetic coordinate.
 */
export function ecefToEnu(
    targetEcef: [number, number, number],
    anchor: GeoCoordinate
): [number, number, number] {
    const anchorEcef = geodeticToEcef(anchor);
    const dx = targetEcef[0] - anchorEcef[0];
    const dy = targetEcef[1] - anchorEcef[1];
    const dz = targetEcef[2] - anchorEcef[2];

    const latRad = anchor.lat * (Math.PI / 180.0);
    const lngRad = anchor.lng * (Math.PI / 180.0);

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    const east = -sinLng * dx + cosLng * dy;
    const north = -sinLat * cosLng * dx - sinLat * sinLng * dy + cosLat * dz;
    const up = cosLat * cosLng * dx + cosLat * sinLng * dy + sinLat * dz;

    return [east, north, up];
}

/**
 * Converts Local Tangent Plane (East-North-Up) displacement back into geodetic coordinates.
 */
export function enuToGeodetic(
    enu: [number, number, number],
    anchor: GeoCoordinate
): GeoCoordinate {
    const [e, n, u] = enu;
    const latRad = anchor.lat * (Math.PI / 180.0);

    const deltaLatDeg = (n / 111132.954);
    const deltaLngDeg = (e / (111412.84 * Math.cos(latRad)));

    return {
        lat: anchor.lat + deltaLatDeg,
        lng: anchor.lng + deltaLngDeg,
        altitudeMeters: (anchor.altitudeMeters ?? 0.0) + u
    };
}

/**
 * Computes a 2D camera view frustum polygon (cone) for map visualization.
 * Given camera coordinate, heading (deg), horizontal FOV (deg), and distance reach (meters).
 */
export function computeCameraFrustum(
    cameraPos: GeoCoordinate,
    headingDeg: number,
    fovDeg: number = 65.0,
    reachMeters: number = 500.0
): CameraViewFrustum {
    const halfFov = fovDeg * 0.5;
    const headingLeftRad = (headingDeg - halfFov) * (Math.PI / 180.0);
    const headingRightRad = (headingDeg + halfFov) * (Math.PI / 180.0);

    const enuLeft: [number, number, number] = [
        reachMeters * Math.sin(headingLeftRad),
        reachMeters * Math.cos(headingLeftRad),
        0.0
    ];

    const enuRight: [number, number, number] = [
        reachMeters * Math.sin(headingRightRad),
        reachMeters * Math.cos(headingRightRad),
        0.0
    ];

    const leftCoord = enuToGeodetic(enuLeft, cameraPos);
    const rightCoord = enuToGeodetic(enuRight, cameraPos);

    return {
        apex: cameraPos,
        leftRay: leftCoord,
        rightRay: rightCoord,
        horizontalFovDeg: fovDeg,
        reachMeters,
        polygonCoords: [
            [cameraPos.lat, cameraPos.lng],
            [leftCoord.lat, leftCoord.lng],
            [rightCoord.lat, rightCoord.lng],
            [cameraPos.lat, cameraPos.lng]
        ]
    };
}

/**
 * Calculates metric standoff distance from pinhole camera projection:
 * d = (fy * landmarkHeightMeters) / (bboxPixelHeight * cos(pitchRad))
 */
export function calculateStandoffDistance(
    fy: number,
    landmarkHeightMeters: number,
    bboxPixelHeight: number,
    pitchDeg: number = 0.0
): number {
    const pitchRad = Math.abs(pitchDeg * (Math.PI / 180.0));
    const cosPitch = Math.max(0.2, Math.cos(pitchRad));
    return (fy * landmarkHeightMeters) / (bboxPixelHeight * cosPitch);
}

export const calculatePinholeStandoffDistance = calculateStandoffDistance;
export const generateFrustumCone = computeCameraFrustum;

