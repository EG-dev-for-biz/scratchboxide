/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
