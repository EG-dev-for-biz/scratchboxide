/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Discrete classification categories for real-world foliage and urban ground cover.
 */
export enum FoliageClass {
  UNKNOWN = 0,
  TURF_GRASS = 1,
  BUSH_SHRUB = 2,
  TREE_CANOPY = 3,
  ARCHITECTURE_BUILDING = 4,
  HARDSCAPE_PAVEMENT = 5
}

/**
 * Human-readable string representations of foliage classes.
 */
export type FoliageClassName =
  | 'unknown'
  | 'turf_grass'
  | 'bush_shrub'
  | 'tree_canopy'
  | 'architecture_building'
  | 'hardscape_pavement';

export const FOLIAGE_CLASS_NAMES: Record<FoliageClass, FoliageClassName> = {
  [FoliageClass.UNKNOWN]: 'unknown',
  [FoliageClass.TURF_GRASS]: 'turf_grass',
  [FoliageClass.BUSH_SHRUB]: 'bush_shrub',
  [FoliageClass.TREE_CANOPY]: 'tree_canopy',
  [FoliageClass.ARCHITECTURE_BUILDING]: 'architecture_building',
  [FoliageClass.HARDSCAPE_PAVEMENT]: 'hardscape_pavement'
};

/**
 * RGB display colors for semantic mask visualization.
 */
export const FOLIAGE_CLASS_COLORS: Record<FoliageClass, [number, number, number]> = {
  [FoliageClass.UNKNOWN]: [40, 40, 40],             // Charcoal Grey
  [FoliageClass.TURF_GRASS]: [134, 194, 50],         // Bright Yellow-Green Lawn
  [FoliageClass.BUSH_SHRUB]: [46, 139, 87],          // Medium Sea Green / Shrub
  [FoliageClass.TREE_CANOPY]: [18, 92, 38],          // Deep Forest / Overstory Emerald
  [FoliageClass.ARCHITECTURE_BUILDING]: [170, 160, 150], // Architectural Stone / Roof
  [FoliageClass.HARDSCAPE_PAVEMENT]: [100, 105, 115] // Cool Grey Asphalt / Pavement
};

/**
 * Bounding coordinate box in standard geodetic lat/lng (WGS-84).
 */
export interface GeodeticBoundingBox {
  sw: { latitude: number; longitude: number };
  ne: { latitude: number; longitude: number };
}

/**
 * GeoTIFF spatial metadata extracted from model tags.
 */
export interface GeoTiffRasterMetadata {
  width: number;
  height: number;
  pixelScale: {
    scaleX: number; // meters or degrees per pixel
    scaleY: number;
    scaleZ?: number;
  };
  tiePoint: {
    i: number;
    j: number;
    k: number;
    x: number; // Easting / Longitude
    y: number; // Northing / Latitude
    z: number;
  };
  boundingBox: GeodeticBoundingBox;
  noDataValue?: number;
}

/**
 * Decoded rasters bundle from Google Solar API dataLayers endpoint.
 */
export interface SolarDataLayersBundle {
  /** 32-bit floating point Digital Surface Model (meters above sea level) */
  dsm: Float32Array;
  /** True-color RGB aerial orthophoto */
  rgb: {
    r: Uint8Array;
    g: Uint8Array;
    b: Uint8Array;
  };
  /** Building rooftop mask (1 = rooftop, 0 = non-building) */
  mask: Uint8Array;
  /** Spatial metadata for raster georeferencing */
  metadata: GeoTiffRasterMetadata;
}

/**
 * Configuration options for foliage classification and height thresholds.
 */
export interface SolarFoliageClassifierOptions {
  /** Maximum height in meters for ground turf / lawn grass (default: 0.35m) */
  grassMaxHeightMeters?: number;
  /** Maximum height in meters for bushes, hedges, and shrubs (default: 2.50m) */
  shrubMaxHeightMeters?: number;
  /** Minimum Excess Green (2G - R - B) threshold to qualify as vegetation (default: 10) */
  minVegetationExG?: number;
  /** Minimum Green Leaf Index (2G - R - B)/(2G + R + B) (default: 0.04) */
  minVegetationGLI?: number;
  /** Local kernel radius (in meters) for morphological DTM ground plane filter (default: 2.5m) */
  dtmFilterRadiusMeters?: number;
}

/**
 * Quantitative metrics and land cover statistics resulting from foliage segmentation.
 */
export interface FoliageSegmentationStats {
  totalAreaM2: number;
  pixelResolutionMeters: number;
  vegetationAreaM2: number;
  treeCanopyAreaM2: number;
  shrubBushAreaM2: number;
  turfGrassAreaM2: number;
  buildingAreaM2: number;
  hardscapeAreaM2: number;
  canopyCoveragePercent: number;
  shrubCoveragePercent: number;
  grassCoveragePercent: number;
  meanTreeHeightMeters: number;
  maxTreeHeightMeters: number;
  meanShrubHeightMeters: number;
  totalTreeCountEstimate: number;
}

/**
 * Comprehensive result of multi-class foliage segmentation.
 */
export interface FoliageSegmentationResult {
  /** 2D classification grid indexed as `y * width + x` with FoliageClass values */
  classificationMap: Uint8Array;
  /** Normalized Digital Surface Model (height above ground in meters) */
  ndsm: Float32Array;
  /** Extracted bare-earth Digital Terrain Model (ground elevation in meters ASL) */
  dtm: Float32Array;
  /** Excess Green index grid */
  exgMap: Float32Array;
  width: number;
  height: number;
  metadata: GeoTiffRasterMetadata;
  stats: FoliageSegmentationStats;

  /**
   * Classify a 3D local coordinate relative to the geodetic anchor.
   */
  classifyPoint3D(
    worldPos: { x: number; y: number; z: number },
    anchorGeo: { latitude: number; longitude: number }
  ): FoliageClass;

  /**
   * Classify a geodetic lat/lng location.
   */
  classifyLatLng(latitude: number, longitude: number): FoliageClass;

  /**
   * Query the exact height above ground (nDSM in meters) at a geodetic lat/lng.
   */
  getHeightAboveGround(latitude: number, longitude: number): number;
}
