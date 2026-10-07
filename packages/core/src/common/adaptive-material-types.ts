/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Core type definitions for the Zero-Preset Adaptive Material PBR Architecture.
 *
 * Under the Adaptive Domain Architecture Directive, material properties are
 * NEVER partitioned into closed enum taxonomies or static landmark classifiers.
 * Instead, physical light-matter interactions are modeled as continuous biophysical
 * fields derived intrinsically from photometric signals and 3D geometric curvature.
 */

export interface AdaptiveMaterialSchema {
    /** Target base roughness baseline range [min, max] between 0.04 and 1.0. */
    roughnessRange?: [number, number];
    /** Conduction / metallicity scale factor [0.0..1.0]. */
    conductionBias?: number;
    /** Normal relief scale factor (default 1.0). */
    reliefScale?: number;
    /** Image-space horizon ambient occlusion intensity [0.0..1.5]. */
    cavityOcclusionStrength?: number;
    /** Gradient bandwidth damping to eliminate specular bevel artifacts on high-contrast edges. */
    edgeDampingFactor?: number;
    /** Directional anisotropy reinforcement factor [-1.0..1.0]. */
    anisotropyStrength?: number;
}

export interface IntrinsicSignalMetrics {
    /** High-frequency spatial variance (\sigma^2_HF) representing micro-surface tooth / porosity. */
    microPorosityEnergy: number;
    /** Ratio of dominant eigenvalues (\lambda_1 / \lambda_2) of the gradient structure tensor. */
    gradientAnisotropy: number;
    /** Dominant gradient orientation angle in radians. */
    principalOrientationRad: number;
    /** Conduction metric in [0, 1] estimating metallic specular reflection vs dielectric diffuse albedo. */
    conductionIndex: number;
    /** Estimated specular F0 reflectance index. */
    specularF0: number;
    /** Cavity depth metric derived from multi-scale horizon slope integration. */
    averageCavityDepth: number;
    /** Mean luminance in linear space. */
    meanLinearLuminance: number;
    /** Dynamic range contrast ratio. */
    contrastRatio: number;
}

export interface ContinuousBiophysicalFields {
    width: number;
    height: number;
    /** Albedo RGBA (de-lighted base color). */
    albedoRgba: Uint8Array;
    /** Tangent-space Normal RGB (encoded as [0..255] around [128, 128, 255]). */
    normalRgb: Uint8Array;
    /** Biophysical Roughness (single channel [0..255]). */
    roughness: Uint8Array;
    /** Conduction / Metallicity (single channel [0..255]). */
    metallic: Uint8Array;
    /** Image-space Horizon Ambient Occlusion (single channel [0..255]). */
    ambientOcclusion: Uint8Array;
    /** Packed glTF ORM (Red: AO, Green: Roughness, Blue: Metallic). */
    ormRgb: Uint8Array;
    /** Normalized surface virtual heightfield [0.0..1.0]. */
    virtualHeight?: Float32Array;
}

export interface AdaptivePbrOptions {
    /** Target atlas resolution width and height (default 1024 or source dimension). */
    targetResolution?: number;
    /** Relief bump strength multiplier (default 1.0). */
    reliefMultiplier?: number;
    /** Edge damping factor to prevent specular bevel lines (default 0.45). */
    edgeDampingFactor?: number;
    /** Ambient occlusion search radius in texels (default 10). */
    aoRadiusTexels?: number;
    /** Optional continuous schema overrides. */
    schemaOverride?: AdaptiveMaterialSchema;
    /** Destination file path for generated binary glTF 2.0 (.glb). */
    outputGlbPath?: string;
    /** Save standalone diagnostic PNGs alongside the GLB. */
    saveDiagnosticMaps?: boolean;
}

export interface AdaptiveAtlasTelemetry {
    atlasIndex: number;
    sourceResolution: [number, number];
    targetResolution: [number, number];
    metrics: IntrinsicSignalMetrics;
    texelsProcessed: number;
}

export interface AdaptivePbrResult {
    success: boolean;
    outputGlbPath?: string;
    glbBuffer?: Buffer;
    atlases: AdaptiveAtlasTelemetry[];
    totalTexelsProcessed: number;
    processingTimeMs: number;
}

/**
 * Continuous Biophysical Material Descriptor.
 * Conforms to Adaptive Domain Architecture (ADA Pillar 1, 2, 3, 8).
 * Represents any earthly or alien material as a continuous dimensional coordinate in \mathbb{R}^k.
 */
export interface ContinuousMaterialDescriptor {
    /** Spectral base albedo [R, G, B] in linear radiometric space [0..1]. */
    albedoLinear: [number, number, number];
    /** Secondary vein / grain / inclusion color. */
    secondaryAlbedo?: [number, number, number];
    /** Blend weight of secondary component [0..1]. */
    secondaryWeight?: number;
    /** Conduction metric [0..1]: 0.0 = pure dielectric, 1.0 = metallic conductor. */
    conduction: number;
    /** Baseline surface roughness [0.02..0.98]. */
    roughnessBaseline: number;
    /** High-frequency surface tooth / micro-roughness [0..1]. */
    microPorosity?: number;
    /** Tangent relief normal multiplier [0.1..5.0]. */
    normalStrength?: number;
    /** Spatial frequency of fissures / veins / pores [1..64]. */
    fissureScale?: number;
    /** Relief displacement depth of fissures [0..1]. */
    fissureDepth?: number;
    /** Octaves of fractional Brownian motion [1..8]. */
    fbmOctaves?: number;
    /** Fractal persistence gain [0.1..0.9]. */
    fbmGain?: number;
    /** Voronoi / crystal / aggregate grain weight [0..1]. */
    cellularWeight?: number;
    /** High-frequency mineral speckling [0..1]. */
    graininess?: number;
    /** Directional elongation [0..1] (0 = isotropic). */
    anisotropyStrength?: number;
    /** Angle of grain in radians [-\pi..\pi]. */
    anisotropyAngleRad?: number;
    /** Ambient occlusion intensity multiplier [0..2]. */
    aoStrength?: number;
}

/**
 * Continuous Differential Geometry Mesh Partition.
 * Replaces closed architectural zone taxonomies with continuous differential geometric fields.
 */
export interface DifferentialGeometryPartition {
    /** Continuous normal dot gravity (ny) [-1..1]. */
    zenithCos: number[];
    /** Continuous normalized relative elevation [0..1]. */
    relativeElevation: number[];
    /** Continuous verticality (1 - |ny|) [0..1]. */
    verticality: number[];
    /** Metric UV repeat along U derived from continuous geometry. */
    metricUvRepeatsU: number[];
    /** Metric UV repeat along V derived from continuous geometry. */
    metricUvRepeatsV: number[];
    /** Normal scale multiplier derived from continuous geometry. */
    normalScaleMultipliers: number[];
    /** Backward-compatible discrete face zones. */
    faceZones?: number[];
    groundPlinthFaces?: number;
    mainShaftFaces?: number;
    slopedRoofFaces?: number;
    horizontalDeckFaces?: number;
    corniceFaces?: number;
}

