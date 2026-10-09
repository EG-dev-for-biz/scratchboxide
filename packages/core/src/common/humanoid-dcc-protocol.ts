/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Standard 52 Facial Action Coding System (FACS) Action Units
 * Conforms to standard ARKit-compatible facial blend shapes.
 */
export const FACS_52_ACTION_UNITS = [
    // Eyebrows & Forehead
    'browDownLeft',
    'browDownRight',
    'browInnerUp',
    'browOuterUpLeft',
    'browOuterUpRight',

    // Eyes & Eyelids
    'eyeBlinkLeft',
    'eyeBlinkRight',
    'eyeLookDownLeft',
    'eyeLookDownRight',
    'eyeLookInLeft',
    'eyeLookInRight',
    'eyeLookOutLeft',
    'eyeLookOutRight',
    'eyeLookUpLeft',
    'eyeLookUpRight',
    'eyeSquintLeft',
    'eyeSquintRight',
    'eyeWideLeft',
    'eyeWideRight',

    // Cheeks & Nose
    'cheekPuff',
    'cheekSquintLeft',
    'cheekSquintRight',
    'noseSneerLeft',
    'noseSneerRight',

    // Jaw
    'jawForward',
    'jawLeft',
    'jawOpen',
    'jawRight',

    // Mouth & Lips
    'mouthClose',
    'mouthDimpleLeft',
    'mouthDimpleRight',
    'mouthFrownLeft',
    'mouthFrownRight',
    'mouthFunnel',
    'mouthLeft',
    'mouthLowerDownLeft',
    'mouthLowerDownRight',
    'mouthPressLeft',
    'mouthPressRight',
    'mouthPucker',
    'mouthRight',
    'mouthRollLower',
    'mouthRollUpper',
    'mouthShrugLower',
    'mouthShrugUpper',
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthStretchLeft',
    'mouthStretchRight',
    'mouthUpperUpLeft',
    'mouthUpperUpRight',

    // Tongue
    'tongueOut'
] as const;

export type FacsActionUnitName = typeof FACS_52_ACTION_UNITS[number] | (string & {});

/**
 * DCC Bone Representation
 */
export interface IDccPoseBone {
    name: string;
    rotation_euler: [number, number, number];
    rotation_quaternion: [number, number, number, number];
    location: [number, number, number];
    scale: [number, number, number];
}

/**
 * DCC Shape Key (Morph Target) Representation
 */
export interface IDccShapeKeyBlock {
    name: string;
    value: number; // 0.0 to 1.0
    deltaPositions?: Float32Array;
}

/**
 * Biophysical Principled BSDF Material Representation
 * Grounded in physical optics (melanin absorption, hemoglobin diffusion, dual-lobe specular).
 */
export interface IDccPrincipledBsdf {
    baseColor: [number, number, number, number];
    melaninFraction: number;    // 0.0 (pale) to 1.0 (deep dark complexion)
    pheomelaninRatio: number;   // 0.0 (eumelanin/neutral) to 1.0 (pheomelanin/warm reddish)
    subsurface: number;         // 0.0 (opaque) to 1.0 (full dermal scatter)
    subsurfaceRadius: [number, number, number]; // Mean free path in mm [R, G, B]
    subsurfaceColor: [number, number, number];  // Deep tissue transmission tint
    roughness: number;          // Primary surface micro-roughness
    specular: number;           // Dielectric specular reflectance
    clearcoat: number;          // Oily lipid layer weight [0, 1]
    clearcoatRoughness: number; // Lipid layer micro-roughness
    metallic: number;
    ior: number;                // Epidermal index of refraction (~1.40 - 1.44)
}

/**
 * 6-Gaussian Separable Screen-Space Subsurface Scattering (SSSS) Kernel Profile
 * Calibrated directly against real human tissue spectral measurements.
 */
export interface SsssDiffusionKernel {
    weights: [number, number, number][]; // 6 RGB weight vectors
    variances: number[];                 // 6 radial Gaussian variances (mm^2)
}

export const HUMAN_DERMAL_SSSS_KERNEL: SsssDiffusionKernel = {
    weights: [
        [0.233, 0.455, 0.649],  // Shallow epidermal scatter (neutral)
        [0.100, 0.336, 0.344],  // Mid-epidermal scatter
        [0.118, 0.198, 0.000],  // Deep dermal scatter (yellow/amber)
        [0.113, 0.007, 0.007],  // Deep subcutaneous hemoglobin (pure blood red)
        [0.358, 0.004, 0.000],  // Deepest vascular scatter (pure deep crimson)
        [0.078, 0.000, 0.000]   // Subdermal venous transmission
    ],
    variances: [0.0064, 0.0484, 0.187, 0.567, 1.99, 7.41]
};

/**
 * Dual-Layer Anatomical Eye Configuration
 */
export interface IDccEyeConfig {
    corneaIor: number;         // 1.376 (human cornea refractive index)
    corneaCurvatureRadius: number; // ~7.8 mm
    limbusDarkeningWidth: number;  // 0.05 - 0.15
    irisDiameterMm: number;    // ~12.0 mm
    pupilDilation: number;     // 0.0 (constricted) to 1.0 (dilated)
}
