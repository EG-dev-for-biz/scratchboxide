/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GeodeticAnchor } from './colmap-vector-reference-types';
import { MetricBoundingBox, UniversalCollisionHull } from './universal-3d-structure-types';

export type Vector2Tuple = [number, number];
export type Vector3Tuple = [number, number, number];
export type Vector4Tuple = [number, number, number, number];

/**
 * Universal substrate material classification for terrain and bedrock.
 */
export type SubstrateClass =
  | 'crystalline_granite'
  | 'sedimentary_sandstone'
  | 'glacial_till'
  | 'talus_scree'
  | 'alluvial_soil'
  | 'engineered_fill'
  | 'bitumen_asphalt'
  | 'concrete_plinth'
  | 'open_water';

/**
 * Relational edge types connecting entities within the Living World Graph.
 */
export type LivingGraphEdgeType =
  | 'GROUNDED_ON'   // Structure plinth or tree root embedded into terrain bedrock
  | 'ENCLOSES'      // District encloses parcel, building encloses floor
  | 'ADJACENT_TO'   // Parcel adjacent to road corridor, building adjacent to alley
  | 'SUPPORTS'      // Foundation supports building, bridge pier supports deck
  | 'OCCUPIES'      // Asset occupies a 3D bounding volume, excluding other entities
  | 'SHADOWS';      // Structure casts solar/wind shadow over adjacent ground/canopy

/**
 * Directional relational edge between two graph nodes.
 */
export interface LivingGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: LivingGraphEdgeType;
  metadata?: Record<string, unknown>;
}

/**
 * Continuous Elevation Oracle and Bedrock Datum for a geographic district.
 */
export interface LivingGraphTerrain {
  id: string;
  districtId: string;
  elevationDatumMeters: number; // Base WGS-84 ellipsoid or geoid datum
  heightfieldResolutionMeters: number;
  dimensions: Vector2Tuple; // [widthMeters, depthMeters]
  gridOrigin: Vector2Tuple; // [minX, minZ]
  bedrockSubstrate: SubstrateClass;
  /**
   * Continuous analytical elevation evaluator parameters.
   */
  oracleParams: {
    peakPosition: Vector2Tuple;
    peakHeight: number;
    valleyFloorElevation: number;
    ridgeCount: number;
    sharpnessExponent: number;
    screeNoiseAmplitude: number;
    snowLineElevation?: number;
  };
}

/**
 * Transit and street corridor extracted from tiles or cartographic networks.
 */
export interface LivingGraphCorridor {
  id: string;
  name?: string;
  districtId: string;
  centerline: Vector3Tuple[];
  roadWidthMeters: number;
  sidewalkWidthMeters: number;
  pavementSubstrate: SubstrateClass;
  isBridgeOrOverpass: boolean;
  underpassClearanceMeters?: number;
}

/**
 * Fenestration bay specification for a rectified architectural facade plane.
 */
export interface LivingGraphFenestrationBay {
  bayIndex: number;
  floorIndex: number;
  widthMeters: number;
  heightMeters: number;
  sillHeightMeters: number;
  recessDepthMeters: number; // Inward normal reveal depth (e.g. 0.30m)
  drainageSillTiltDeg: number; // Downward angle for rain/snow runoff (e.g. 12°)
  mullionProfile: 'minimal' | 'industrial' | 'curtain_wall' | 'divided_lite';
  glazingColor: Vector4Tuple;
  emissiveGlow: Vector4Tuple;
}

/**
 * Rectified planar facade plane extracted from photogrammetric vertical walls.
 */
export interface LivingGraphFacadePlane {
  id: string;
  structureId: string;
  normal: Vector3Tuple; // Outward unit normal
  origin: Vector3Tuple;
  widthMeters: number;
  heightMeters: number;
  fenestrationBays: LivingGraphFenestrationBay[];
  baseColor: Vector4Tuple;
  roughness: number;
  metalness: number;
}

/**
 * Rooftop mechanical unit (HVAC condenser, fan intake, communications spire).
 */
export interface LivingGraphRooftopUnit {
  id: string;
  type: 'hvac_condenser' | 'fan_intake_grille' | 'exhaust_duct_manifold' | 'communications_spire' | 'parabolic_dish';
  relativePosition: Vector3Tuple; // Relative to roof center
  dimensions: Vector3Tuple; // [width, height, depth]
  rotationYDeg: number;
}

/**
 * Architectural roof assembly crowning a structure.
 */
export interface LivingGraphRoofAssembly {
  id: string;
  structureId: string;
  roofType: 'flat_parapet' | 'pitched_gable' | 'sawtooth' | 'crown_spire' | 'stepped_terrace';
  elevationY: number;
  parapetHeightMeters: number;
  parapetCopingWidthMeters: number;
  mechanicalUnits: LivingGraphRooftopUnit[];
  snowRetentionFactor: number; // 0.0 (sheds completely) to 1.0 (holds snowdrifts)
}

/**
 * Atomic Architectural Structure within the Living World Graph.
 */
export interface LivingGraphStructure {
  id: string;
  name: string;
  districtId: string;
  geodeticAnchor?: GeodeticAnchor;
  orientedBoundingBox: {
    center: Vector3Tuple;
    extents: Vector3Tuple; // Half-dimensions [extentX, extentY, extentZ]
    yawDegrees: number;
  };
  footprintPolygon: Vector2Tuple[];
  floorCount: number;
  floorHeightMeters: number;
  foundationPlinth: {
    topElevationY: number;
    skirtBottomElevationY: number; // Sunk into excavated bedrock datum
    embedDepthMeters: number;
    material: SubstrateClass;
  };
  facades: LivingGraphFacadePlane[];
  roof: LivingGraphRoofAssembly;
  collisionHull: UniversalCollisionHull;
}

/**
 * Botanical canopy stand or individual specimen.
 */
export interface LivingGraphVegetationStand {
  id: string;
  districtId: string;
  archetype: 'conifer_excurrent' | 'deciduous_decurrent' | 'columnar_poplar' | 'alpine_dwarf_shrub';
  canopyTier: 0 | 1 | 2; // 0 = Dominant Canopy (70%), 1 = Understory (20%), 2 = Groundcover (10%)
  position: Vector3Tuple;
  scale: number;
  yawDegrees: number;
  rootCollarEmbedDepthMeters: number; // Sink into terrain to eliminate root levitation
  envelopeNormalFactor: number; // Soft leaf envelope vs per-needle normals
  exclusionRadiusMeters: number;
}

/**
 * Geographic District containing the relational living spatial graph.
 */
export interface LivingGraphDistrict {
  id: string;
  name: string;
  wgs84Anchor: GeodeticAnchor;
  metricAABB: MetricBoundingBox;
  dominantDomain: string; // e.g. 'UrbanHighRiseCore', 'MountainAlpineCanyon', etc.
  terrain: LivingGraphTerrain;
  corridors: LivingGraphCorridor[];
  structures: LivingGraphStructure[];
  vegetation: LivingGraphVegetationStand[];
  edges: LivingGraphEdge[];
  metadata: {
    source: 'google_3d_tiles' | 'procedural_synthesizer' | 'hybrid';
    leafLodErrorTarget?: number;
    createdAtTimestamp: number;
    version: number;
  };
}

/**
 * The Root Living World Graph container.
 */
export interface LivingWorldGraph {
  districts: Record<string, LivingGraphDistrict>;
  activeDistrictId: string;
}
