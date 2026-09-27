/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LatLngAlt, Vec3 } from './coordinate/LocalTangentPlane';
import { SolarPosition } from './coordinate/solarPosition';

/**
 * Universal 4D ECS Substrate Protocol
 * Coordinates Space, Time, Environment, Form (Content), Behavior, and Lineage
 */

export interface BakedGaussian {
  position: [number, number, number];
  colorRgb: [number, number, number];
  opacity: number;
  scale: [number, number, number];
  quaternion?: [number, number, number, number];
  sh?: number[];
}

export interface BoundingVolume {
  min: Vec3; // local Cartesian meters [x, y, z]
  max: Vec3;
}

export interface GeoAnchor4D extends LatLngAlt {
  heading?: number; // Compass heading/azimuth in degrees (0 = North, 90 = East)
  pitch?: number;   // Horizon pitch in degrees (-90 to +90)
  roll?: number;    // Roll in degrees
  geoidHeight?: number; // MSL Geoid height offset
}

// ==========================================
// 1. Space Dimension (Geodetic & Local ENU)
// ==========================================
export interface SpaceDimension4D {
  geoAnchor?: GeoAnchor4D;
  localTransform?: {
    position: Vec3;            // local Cartesian ENU offset [x, y, z]
    rotationQuaternion?: [number, number, number, number]; // [x, y, z, w]
    scale?: Vec3;
  };
  boundingBox?: BoundingVolume;
  parentEntityId?: string;     // Hierarchical child attachment
  s2CellToken?: string;        // S2 spherical spatial index cell
}

// ==========================================
// 2. Time Dimension (Continuous Timeline & Discrete Events)
// ==========================================
export interface TimeTrack {
  id: string;
  property: string;            // Property to animate, e.g., "space.localTransform.position"
  interpolation: 'linear' | 'cubic-hermite' | 'bezier' | 'step';
  keyframes: Array<{
    timeMs: number;
    value: any;
  }>;
}

export interface EventTrigger {
  id: string;
  timeMs: number;
  type: string;                // Event type: e.g., "collision", "audio_cue", "telemetry_ping"
  parameters?: Record<string, any>;
}

export interface TimeDimension4D {
  startMs: number;
  durationMs: number;          // 0 for static objects, >0 for dynamic timelines
  tracks?: TimeTrack[];
  events?: EventTrigger[];
  isContinuous?: boolean;      // True if continuous looping clock is active
}

// ==========================================
// 3. Environment Dimension (Atmospheric & Solar State)
// ==========================================
export interface WeatherConditions {
  conditions: 'sunny' | 'cloudy' | 'rainy' | 'snowy' | 'stormy';
  fogDensity?: number;         // 0.0 to 1.0 (ambient visual opacity)
  ambientTemperatureC?: number;// Temperature in degrees Celsius
  windVector?: Vec3;           // Wind speed & direction vector [x, y, z] in meters/second
  
  // High-Nuance Weather API Ingestion Parameters
  precipitationMmHr?: number;  // Rainfall/liquid accumulation in mm/hour
  humidityPercent?: number;    // Relative humidity % (0 - 100)
  cloudCoverPercent?: number;  // Sky cloud fraction % (0 - 100)
  visibilityMeters?: number;   // Horizontal visual range in meters
  uvIndex?: number;            // Ultraviolet radiation index (0 - 11+)
  windSpeedKmh?: number;       // Magnitude of wind velocity in km/h
  windDirectionDeg?: number;   // Compass direction of wind source in degrees (0 - 360)
  airPressureHpa?: number;     // Barometric pressure in Hectopascals / millibars
  dewPointC?: number;          // Dew point temperature in Celsius
}

export interface EnvironmentDimension4D {
  solar?: SolarPosition;
  solarTimeOfDayHours?: number; // 0.0 - 24.0 local solar time
  elevationDatumMeters?: number;
  weather?: WeatherConditions;
  airQualityAqi?: number;      // AQI rating
}

// ==========================================
// 4. Form / Content Representation
// ==========================================
export type RepresentationType =
  | 'image'                    // 2D orthographic map, blueprint, overlay, or sprite
  | 'video'                    // 2D video plate,Surveillance stream, dynamic texture
  | 'audio'                    // Spatial audio emitter
  | 'gaussian-splat'           // Volumetric neural radiance field (.splat or .spz)
  | 'mesh-glb'                 // GLTF/GLB polygonal model
  | 'mesh-sculptable'          // Dynamically deformable 3D sculpted mesh
  | 'vector-geojson'           // Procedural vector GIS contours/parcels
  | 'point-cloud'              // LiDAR point clouds or voxel grids
  | 'occupancy-4d'             // 4D spatiotemporal semantic occupancy tensor (S4D World Model)
  | 'map-3d-tile'              // Google Photorealistic 3D Tile set
  | 'map-3d';                  // 3D Map Tile mesh

export enum GeospatialSemanticClass {
  AIRSPACE = 0,
  TERRAIN = 1,
  WATER = 2,
  BUILDING_FACADE = 3,
  BUILDING_INTERIOR = 4,
  VEGETATION = 5,
  TRANSIT_ROAD = 6,
  DYNAMIC_AIR_AGENT = 7,
  DYNAMIC_GROUND_AGENT = 8,
  DYNAMIC_HAZARD = 9
}

export interface OccupancyGrid4DMetadata {
  dimensions: [number, number, number, number]; // [T, X, Y, Z] e.g. [16, 128, 128, 64]
  voxelSizeMeters: [number, number, number];     // [dx, dy, dz] in meters e.g. [1.0, 1.0, 1.0]
  originENU: Vec3;                               // Center/corner offset in ENU meters
  classes: Record<number, string>;
  timeStepMs: number;
}

export interface OccupancyGrid4D {
  metadata: OccupancyGrid4DMetadata;
  denseTensorUri?: string;                       // durable URI to .h5/.zarr/.bin dense voxel tensor
  sparseRleBytes?: string;                       // Base64-encoded run-length encoded byte stream
}

export interface SculptDeformationChannel4D {
  vertexDeltas?: number[];     // Flattened dx, dy, dz displacements
  activeBrush?: string;
  falloffType?: string;
  symmetryMask?: { x?: boolean; y?: boolean; z?: boolean };
  historyRevision?: number;
}

export interface ContentRepresentation4D {
  type: RepresentationType;
  durableUri: string;          // Persistent asset link (GCS, Vault, or Local)
  mimeType?: string;
  lodPyramid?: {
    lowProxyUri?: string;      // Lightweight AI bounding proxy
    mediumUri?: string;
    highPhotorealUri?: string;
  };
  occupancy4D?: OccupancyGrid4D;
  metadata?: Record<string, any>;
}

// ==========================================
// 5. Behavior Dimension (Kinematics & Agency)
// ==========================================
export interface PhysicsRig {
  mass?: number;
  velocity?: Vec3;
  acceleration?: Vec3;
  gravityEnabled?: boolean;
}

export interface TelemetryLog {
  timestampMs: number;
  gps: GeoAnchor4D;
  speedKmh: number;
  status: string;
}

export interface BehaviorDimension4D {
  physics?: PhysicsRig;
  telemetryStream?: TelemetryLog[]; // Real-time execution logs and sensor telemetry
  agentControllerId?: string;      // Backing Gemini or AI Subagent controller ID
  proceduralScript?: string;       // Custom JS/WASM behavioral animation script
}

// ==========================================
// 6. Lineage Dimension (Multiverse State)
// ==========================================
export interface ProvenanceRecord {
  authorAgent: string;         // Author user or specific agent ID
  timestamp: string;
  prompt?: string;             // Generative prompt history
  seed?: number;
  appliedDiffSummary?: string; // Change summary delta
}

export interface LineageDimension4D {
  worldBranchId: string;       // Multiverse branch (e.g., 'earth/main', 'earth/cyberpunk')
  version: number;
  parentCommitHash?: string;
  provenance?: ProvenanceRecord;
}

// ==========================================
// Root Entity 4D Object
// ==========================================
export interface Entity4D {
  id: string;
  name: string;
  space: SpaceDimension4D;
  time: TimeDimension4D;
  environment: EnvironmentDimension4D;
  content: ContentRepresentation4D;
  behavior: BehaviorDimension4D;
  lineage: LineageDimension4D;
}

// ==========================================
// Universal 4D Scene Document
// ==========================================
export interface Universal4DSceneDocument {
  schemaVersion: '0.3.0';
  metadata: {
    id: string;
    title: string;
    description?: string;
    totalDurationMs: number;
    generator: string;
  };
  environment: EnvironmentDimension4D;
  entities: Entity4D[];
}

// ==========================================
// Place & Observation Graph (Paper 3 & 4)
// ==========================================

export interface CameraOptics {
  focalLengthMm?: number;
  sensorMm?: [number, number];
  fov?: number;
  lensPreset?: string;
  focusDistanceM?: number;
  aperture?: number;
}

export interface WorldRelationship {
  subject: string;
  predicate: string;
  object: string;
  metadata?: Record<string, any>;
}

export interface SpatialObservation4D {
  id: string;
  timestamp: string;
  sensorType: 'camera-rgb' | 'camera-rgbd' | 'lidar' | 'satellite' | 'street-view' | 'procedural';
  sourceUri: string;               // Original raw visual/sensor asset
  provenance: ProvenanceRecord;
  estimatedSolar?: SolarPosition;  // Derived via ChronoSpatialDeductionEngine
  estimatedWeather?: WeatherConditions;
  cameraPose?: {
    geoAnchor: GeoAnchor4D;
    extrinsics?: number[];         // 16-element camera-to-world row-major matrix
    optics?: CameraOptics;
  };
  representation?: ContentRepresentation4D; // Derived 3D Representation (Splat, Mesh, etc.)
}

export interface PlaceRecord {
  placeId: string;                 // Canonical Google Place ID or unique hash
  name: string;
  geodeticAnchor: GeoAnchor4D;
  viewportBounds?: {
    northeast: LatLngAlt;
    southwest: LatLngAlt;
  };
  s2CellToken?: string;
  semanticGraph?: WorldRelationship[]; // Semantic relationships (POI type, zoning, etc.)
  observations: SpatialObservation4D[]; // History of physical evidence captures
  activeRepresentations: ContentRepresentation4D[]; // Current rendered views (Tiles, Splats, etc.)
  multiverseBranches: string[];    // Linked branch IDs (earth/main, earth/cyberpunk, etc.)
}

// ==========================================
// 8. Mobile ARCore Geospatial Deployment Contract
// ==========================================
export type AltitudeResolutionMode = 'terrain' | 'rooftop' | 'wgs84' | 'streetscape_facade';

export interface ARPlacementEntity {
  entityId: string;
  entityName: string;

  // Strict 64-bit Geodetic Placement (Float64)
  targetGeodetic: {
    latitude: number;
    longitude: number;
  };

  // Surface Resolution Semantics
  altitudeResolution: {
    mode: AltitudeResolutionMode;
    offsetMeters: number;          // Height offset relative to resolved surface (+0.15m)
    fallbackAltitudeWgs84?: number; // Absolute ellipsoid elevation fallback
  };

  // True North Orientations
  orientation: {
    headingDeg: number;            // Azimuth clockwise from True North (0 to 360)
    pitchDeg?: number;
    rollDeg?: number;
    rotationQuaternion?: [number, number, number, number]; // [x, y, z, w]
  };
  scaleMeters: [number, number, number];

  // Asset Payload (Supports Polygonal Meshes, Gaussian Splats, and Vector Features)
  asset: {
    assetId: string;
    assetType?: 'mesh-glb' | 'gaussian-splat' | 'vector-corridor' | 'vector-parcel';
    durableGlbUri?: string;        // Binary GLB compiled by Astra Engine
    durableSplatUri?: string;      // Standard .splat or super-compressed .spz URI
    splatFormat?: 'splat' | 'spz';
    splatCount?: number;
    byteLength?: number;
    lodProxyGlbUri?: string;
    pbrConfig?: {
      metallicFactor?: number;
      roughnessFactor?: number;
      weatherReactive?: boolean;
    };
    vectorProperties?: {
      layerType: 'road' | 'parcel' | 'landscape' | 'sidewalk';
      widthMeters?: number;
      lanes?: number;
      isLandmark?: boolean;
      baseElevationMeters?: number;
      heightMeters?: number;
    };
  };

  // Physics & Real-World Occlusion
  interaction: {
    occlusionMode: 'streetscape_depth' | 'bounding_box' | 'none';
    enablePhysicalCollisions: boolean;
    massKg?: number;
  };

  multiverseBranchId: string;      // e.g. "earth/main", "earth/historical-1906"
}

export interface GeoAnchorDeploymentContract {
  schemaVersion: '1.2.0';
  frameContract: 'sbox-enu-yup-v1';
  timestamp: string;

  // Spatial Indexing Cluster
  spatialCluster: {
    geoAnchorKey: string;          // Coarse spatial bucket (e.g. "geo:37.7749:-122.4194")
    s2CellToken?: string;          // S2 Cell token for spatial radius queries
    locationName?: string;
    originGeodetic: {
      latitude: number;
      longitude: number;
      altitudeMsl?: number;
    };
  };

  // Synchronized Environmental Parameters
  environment?: {
    sunVector?: {
      azimuthDeg: number;
      elevationDeg: number;
      colorTemperatureK: number;
      normalizedSunRgb: [number, number, number];
      directIntensity: number;
    };
    weather?: {
      conditions: 'sunny' | 'cloudy' | 'rainy' | 'snowy';
      precipitationMmHr: number;
      fogDensity: number;
      wetnessFactor: number;
    };
  };

  // Vector Map Semantic Navigation & Geofence Overlay
  vectorMapContext?: {
    roadCorridors?: Array<{
      id: string;
      name: string;
      type: 'avenue' | 'cross_street' | 'commercial_corridor' | 'diagonal_corridor';
      widthMeters: number;
      lanes: number;
      coordinatesWGS84: [number, number][]; // [lng, lat]
    }>;
    parcels?: Array<{
      id: string;
      name: string;
      isLandmark?: boolean;
      heightMeters: number;
      polygonWGS84: [number, number][];    // [lng, lat]
    }>;
  };

  // Mobile Radiance Field / Splat Execution Settings
  splatRenderingConfig?: {
    maxSplatBudgetMobile?: number;         // e.g. 500,000 splats
    lodDistanceVoxelizeMeters?: number;    // Distance threshold for voxel LOD step
    depthOcclusionEnabled?: boolean;       // Enable Streetscape depth mask test
  };

  // Deployed Placements
  placements: ARPlacementEntity[];
}


