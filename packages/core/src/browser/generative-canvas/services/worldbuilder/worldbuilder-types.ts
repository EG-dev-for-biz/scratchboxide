/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type RegionCategory =
    | 'mountain'
    | 'canyon'
    | 'desert'
    | 'valley'
    | 'coast'
    | 'settlement'
    | 'forest'
    | 'river'
    | 'plain'
    | 'island'
    | 'citadel'
    | 'spaceport'
    | 'ruins';

export type RelativePosition =
    | 'center'
    | 'north'
    | 'south'
    | 'east'
    | 'west'
    | 'northeast'
    | 'northwest'
    | 'southeast'
    | 'southwest';

export type PlacementRule =
    | 'on_ground'
    | 'scattered'
    | 'centered'
    | 'slope_aligned'
    | 'perimeter'
    | 'grid';

export interface RegionSpec {
    id: string;
    name: string;
    category: RegionCategory;
    description: string;
    relativePosition: RelativePosition;
    baseElevation: number; // in meters
    radiusMeters?: number;
    roughness?: number;
    vegetationDensity?: number;
}

export interface TerrainBaseMaterial {
    color: string; // Hex color for ground
    roughness: number;
    metalness: number;
    specularColor?: string;
    wireframe?: boolean;
}

export interface TerrainSpec {
    elevationMin: number;
    elevationMax: number;
    erosionWeight: number; // 0.0 to 1.0
    terracation: number; // 0.0 to 1.0 (stepping / terracing)
    noiseScale: number; // frequency scaling
    baseMaterial: TerrainBaseMaterial;
    waterLevel?: number; // optional sea/river water plane elevation in meters
    ridgeFactor?: number; // 0.0 to 1.0 sharp ridge sharpness
}

export interface ObjectSpec {
    id: string;
    category: string; // e.g., "tree", "rock", "house", "tower", "bridge", "cart", "spacecraft", "beacon"
    regionId: string; // references RegionSpec.id
    density: number; // count or spacing
    scale: number; // base scale factor
    placementRule: PlacementRule;
    tintHex?: string;
    heightOffset?: number;
}

export interface AtmosphericConfig {
    skybox: string;
    lighting: string;
    timeOfDay: number; // 0.0 to 24.0
    sunElevation?: number;
    sunAzimuth?: number;
    lightColor?: string;
    lightTemperature?: number;
    sunIntensity?: number;
    fogDensity?: number;
    fogColor?: string;
}

export interface WorldSpecification {
    name: string;
    theme: string;
    mood: string;
    timeOfDay: number; // 0.0 to 24.0
    regions: RegionSpec[];
    terrain: TerrainSpec;
    objects: ObjectSpec[];
    atmosphere?: AtmosphericConfig;
    seed?: number;
}

export interface TerrainElevationGrid {
    resolution: number; /* e.g. 16x16 or 32x32 or 64x64 grid */
    south: number;
    west: number;
    north: number;
    east: number;
    elevations: Float32Array; /* Height values in meters */
    minElevation: number;
    maxElevation: number;
}

export interface PlacedActor3D {
    id: string;
    name: string;
    category: string;
    type: string; // "StaticMeshActor" | "Cube" | "Cylinder" | "Sphere" | "Cone" | "Plane" | "CustomMesh"
    semanticClass: string;
    folder?: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    geo?: {
        lat: number;
        lng: number;
        alt: number;
    };
    visible: boolean;
    locked?: boolean;
    material?: {
        color?: string | number;
        roughness?: number;
        metalness?: number;
        wireframe?: boolean;
    };
}

export interface SwarmTaskBucket {
    terrainConcept: string;
    materialsToSynthesize: { name: string; prompt: string }[];
    customAssetsToBuild: { id: string; category: string; prompt: string }[];
}

export interface WorldBuilderGenerationOutput {
    spec: WorldSpecification;
    grid: TerrainElevationGrid;
    actors: PlacedActor3D[];
    summary: string;
}
