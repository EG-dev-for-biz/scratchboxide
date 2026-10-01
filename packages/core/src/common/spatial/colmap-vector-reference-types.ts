/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Supported COLMAP / GLOMAP camera intrinsic models.
 */
export type ColmapCameraModel =
  | 'SIMPLE_PINHOLE'
  | 'PINHOLE'
  | 'SIMPLE_RADIAL'
  | 'RADIAL'
  | 'OPENCV'
  | 'OPENCV_FISHEYE'
  | 'FULL_OPENCV'
  | 'FOV'
  | 'SIMPLE_RADIAL_FISHEYE'
  | 'RADIAL_FISHEYE'
  | 'THIN_PRISM_FISHEYE';

/**
 * Universal Geodetic Anchor for anchoring any 3D photogrammetric survey
 * to real-world WGS84 coordinates anywhere on Earth with zero presets.
 */
export interface GeodeticAnchor {
  lat: number;
  lng: number;
  elevationMeters: number;
  headingDeg?: number;
  placeId?: string;
  formattedAddress?: string;
  geoidHeightMeters?: number;
}

/**
 * Calibrated optical camera intrinsics.
 */
export interface ColmapCameraIntrinsics {
  model: ColmapCameraModel;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  params: number[];
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
  focalLengthMm: number;
  sensorWidthMm: number;
}

/**
 * 6-DoF Calibrated COLMAP / GLOMAP Photogrammetry Station Pose
 * seamlessly projected between local 3D ENU tangent plane and WGS84 GPS space.
 */
export interface ColmapCameraPose {
  id: number;
  name: string;
  imageName?: string;
  
  // Local 3D Coordinates (Three.js Convention: X = East, Y = Up, Z = -North)
  positionLocalENU: [number, number, number];
  forwardVector: [number, number, number];
  upVector?: [number, number, number];
  rotationQuaternion?: [number, number, number, number]; // [x, y, z, w]
  
  // Optical angles in degrees
  yawDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
  
  // Lens & Sensor optics
  focalLengthMm: number;
  sensorWidthMm: number;
  fovDegrees: number;
  aspectRatio?: number;
  
  // Real-world WGS84 Geodetic Coordinates
  coordinatesWGS84: {
    lat: number;
    lng: number;
    elevation: number;
  };
  groundElevationASL?: number;
  cameraHeightAboveGround?: number;
  cameraAltitude?: number;
  
  // Optional 4-corner ground projection footprint polygon [lng, lat]
  frustumFootprintWGS84?: [number, number][];

  /**
   * Per-station facts derived from the anchored 3D mesh and the sun ephemeris, used to rank
   * stations and to ground the AI Beautify prompt (standoff, horizon, sun). Filled by
   * SurveyStationEnrichmentService (Node); absent for plain synthesis.
   */
  beautify?: StationBeautifyMetrics;
}

export interface StationBeautifyMetrics {
  /** Metric distance along the optical axis to the first mesh surface (undefined if the ray misses). */
  standoffMeters?: number;
  /** Horizon row as a fraction of image height (0 = top), from pitch and vertical fov. */
  horizonRowFraction?: number;
  /** Fraction of pixels where the mesh depth buffer is empty (sky / beyond tile extent). */
  skyFraction?: number;
  /** Fraction of the frustum ground footprint that lies inside the mesh's ground bounding box. */
  meshCoverageFraction?: number;
  /** Sun at the anchor for the chosen timestamp (degrees; azimuth clockwise from north). */
  solar?: { azimuthDegrees: number; elevationDegrees: number; isoDate: string };
  /** Ranking score assigned by SurveySynthesisEngine.rankForBeautify (higher is better). */
  rankScore?: number;
}

/**
 * Supported photogrammetric survey synthesis patterns.
 */
export type SurveyPatternType =
  | 'orbital-multi-tier'
  | 'foveated-multi-tier'
  | 'amphitheatre-complete'
  | 'facade-lawnmower'
  | 'street-corridor'
  | 'nadir-grid'
  | 'district-complete'
  | 'continuous-flight'
  | 'geographic-3dtiles-survey';

/**
 * Configuration for procedurally generating photogrammetric survey patterns
 * around any arbitrary geodetic anchor.
 */
export interface SurveyPatternConfig {
  type: SurveyPatternType;
  targetRadiusMeters: number;
  cameraCount: number;
  altitudeTiersMeters?: number[];
  focalLengthMm?: number;
  sensorWidthMm?: number;
  lookAtOffsetLocalENU?: [number, number, number];
  /** Optional per-tier look-at offsets in local ENU. If provided, tier t uses lookAtTiersOffsetLocalENU[t]. */
  lookAtTiersOffsetLocalENU?: [number, number, number][];
  /** Optional per-tier radius in meters. If provided, tier t uses tierRadiiMeters[t]. */
  tierRadiiMeters?: number[];
  corridorHeadingDeg?: number;
  corridorLengthMeters?: number;
  /** Camera height above ground for street-corridor stations (default 25 m; use ~1.7 m for eye height). */
  cameraHeightMeters?: number;
  /** Minimum camera height above ground truth elevation (default 2.0 m). Enforces that camera perspectives never fall below ground. */
  minCameraHeightAboveGroundMeters?: number;
  /** Image aspect ratio for the stations (default 16/9). */
  aspectRatio?: number;
  /** Horizontal aspect ratio (X/Z) for elliptical landmark orbits (e.g. 1.15 - 1.25 for elliptical amphitheatres like the Colosseum). */
  aspectRatioXZ?: number;
  /** Optional custom 6-DoF flight waypoints for continuous-flight mode. If omitted, procedural inside-out spline is synthesized. */
  flightWaypoints?: Array<{ position: [number, number, number]; target: [number, number, number]; fov?: number }>;
}

/**
 * Input request for the ColmapVectorPipeline.
 * Strictly enforces zero presets: requires either explicit coordinates or a resolvable query string.
 */
export interface ColmapVectorPipelineRequest {
  // Option A: Explicit WGS84 coordinates
  anchor?: {
    lat: number;
    lng: number;
    elevationMeters?: number;
    headingDeg?: number;
    label?: string;
  };
  
  // Option B: Query string for live Google Geocoding API
  query?: string;
  apiKey?: string;
  
  // Camera Source Option 1: Procedural Survey Synthesis
  surveyConfig?: SurveyPatternConfig;
  
  // Camera Source Option 2: Raw COLMAP / GLOMAP text file contents
  colmapFiles?: {
    camerasText?: string;
    imagesText?: string;
    points3DText?: string;
  };
  
  // Camera Source Option 3: Pre-existing structured poses
  existingPoses?: ColmapCameraPose[];
  
  // Google Maps Vector styling & solution options
  mapId?: string;
  styleId?: string;
  fetchElevation?: boolean;
  fetchSolarRooftops?: boolean;

  // Dedicated Studio Grey Clay 3D Object Options (getGoogle3DTilesClay)
  clayOptions?: ColmapClay3DTilesOptions;
}

/**
 * Options for querying Google Maps Photorealistic 3D Tiles in Studio Grey Clay mode.
 */
export interface ColmapClay3DTilesOptions {
  enabled?: boolean;
  outputGlbPath?: string;
  offlineMock?: boolean;
  lodQuality?: {
    errorTarget?: number;
    virtualSseWidth?: number;
    virtualSseHeight?: number;
  };
}

/**
 * Metadata for the ingested Google Maps Studio Grey Clay 3D Object (.glb).
 */
export interface ColmapClay3DObjectMetadata {
  glbPath: string;
  glbBuffer?: Buffer | Uint8Array;
  meshStats: {
    vertexCount: number;
    triangleCount: number;
    submeshCount: number;
    boundingBox: { min: [number, number, number]; max: [number, number, number] };
    boundingSphere: { center: [number, number, number]; radius: number };
  };
  quality: {
    source?: string;
    errorTarget: number;
    resolution?: string;
    asynchronousSettle: boolean | {
      downloading: number;
      parsing: number;
      tilesLoaded: number;
      stableFrames: number;
    };
    leafLodSettled?: boolean;
  };
}

/**
 * RFC 7946 GeoJSON FeatureCollection containing all photogrammetric stations,
 * camera frustum footprints, and flight path trajectories.
 */
export interface ColmapGeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry:
      | { type: 'Point'; coordinates: [number, number, number] }
      | { type: 'Polygon'; coordinates: number[][][] }
      | { type: 'LineString'; coordinates: number[][] };
    properties: Record<string, any>;
  }>;
}

/**
 * Result bundle emitted by the ColmapVectorPipeline.
 */
export interface ColmapVectorPipelineResult {
  version: string;
  success: boolean;
  anchor: GeodeticAnchor;
  poses: ColmapCameraPose[];
  geoJson: ColmapGeoJsonFeatureCollection;
  colmapExport: {
    camerasText: string;
    imagesText: string;
  };
  /**
   * Primary 3D Spatial Reference: Google Maps Photorealistic 3D Tiles in Studio Grey Clay mode.
   * Standardized binary glTF 2.0 (.glb) mesh with physical bounding volume and leaf LOD settle.
   */
  clayObject?: ColmapClay3DObjectMetadata;

  /**
   * Optional/Legacy: 2D Google Maps Vector Reference Dock configuration (Path B fallback).
   */
  vectorDockConfig?: {
    mapId: string;
    styleId: string;
    center: { lat: number; lng: number };
    zoom: number;
    heading: number;
    tilt: number;
    stationCount: number;
    solutionAttribution: string;
  };

  stats: {
    stationCount: number;
    avgAltitudeASL: number;
    minAltitudeASL: number;
    maxAltitudeASL: number;
    groundDatumASL: number;
    boundingRadiusMeters: number;
  };
}

/**
 * Options for mounting the interactive Google Maps Vector Reference Dock (Path B) in the browser.
 */
export interface VectorDockMountOptions {
  containerId: string;
  dockingMode?: 'floating-pip' | 'split-half' | 'dock-bottom';
  mapId?: string;
  initialZoom?: number;
  initialTilt?: number;
  initialHeading?: number;
  showFrustums?: boolean;
  showTrajectoryLine?: boolean;
  onStationSelect?: (pose: ColmapCameraPose) => void;
  onCameraSync?: (sync: VectorDockSyncEvent) => void;
}

/**
 * Telemetry event dispatched during bidirectional synchronization
 * between the 3D viewport and Google Maps Vector Reference Dock.
 */
export interface VectorDockSyncEvent {
  source: 'map_pin_click' | 'viewport_3d_fly';
  activeStationId?: number;
  cameraPositionLocal: [number, number, number];
  cameraPositionWgs84: {
    lat: number;
    lng: number;
    elevation: number;
  };
  compassHeadingDeg: number;
  pitchDeg: number;
}
