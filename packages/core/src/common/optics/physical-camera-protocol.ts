/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LatLngAlt } from '../coordinate/LocalTangentPlane';

/**
 * Standard industry sensor and film gate format identifiers.
 */
export type PhysicalSensorFormatId =
    | 'full_frame_35mm'
    | 'super_35'
    | 'imax_70mm'
    | 'medium_format_fuji'
    | 'aps_c'
    | 'micro_four_thirds'
    | 'smartphone_1_inch'
    | 'smartphone_type_1_128'
    | 'custom';

export type SensorFormatPreset = PhysicalSensorFormatId;

/**
 * Physical sensor or film gate specification in metric millimeters.
 */
export interface PhysicalSensorFormat {
    id: PhysicalSensorFormatId;
    name: string;
    widthMm: number;
    heightMm: number;
    diagonalMm: number;
    cropFactor: number; // Relative to standard 35mm full frame (diagonal 43.27mm)
    aspectRatio: number;
    description: string;
}

export type SensorDimensions = PhysicalSensorFormat;

/**
 * Standard reference full-frame 35mm sensor diagonal in mm.
 */
export const FULL_FRAME_DIAGONAL_MM = 43.266615305567875; // sqrt(36^2 + 24^2)

/**
 * Industry-standard camera sensor formats catalog.
 */
export const PHYSICAL_SENSOR_PRESETS: Record<Exclude<PhysicalSensorFormatId, 'custom'>, PhysicalSensorFormat> = {
    full_frame_35mm: {
        id: 'full_frame_35mm',
        name: '35mm Full Frame (36x24mm)',
        widthMm: 36.0,
        heightMm: 24.0,
        diagonalMm: FULL_FRAME_DIAGONAL_MM,
        cropFactor: 1.0,
        aspectRatio: 36.0 / 24.0,
        description: 'Industry reference 35mm full frame sensor (Arri LF, Sony FX9/Venice, Canon R5, RED Monstro).'
    },
    super_35: {
        id: 'super_35',
        name: 'Super 35mm Cinema (24.89x18.66mm)',
        widthMm: 24.89,
        heightMm: 18.66,
        diagonalMm: 31.108,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 31.108,
        aspectRatio: 24.89 / 18.66,
        description: 'Traditional Hollywood motion picture film gate (Arri Alexa 35, Sony FX6, RED Gemini).'
    },
    imax_70mm: {
        id: 'imax_70mm',
        name: 'IMAX 70mm 15-Perf (70.41x52.63mm)',
        widthMm: 70.41,
        heightMm: 52.63,
        diagonalMm: 87.906,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 87.906,
        aspectRatio: 70.41 / 52.63,
        description: 'Ultra-large format IMAX 15/70 film gate for grand scale, shallow depth of field, and immense clarity.'
    },
    medium_format_fuji: {
        id: 'medium_format_fuji',
        name: 'Digital Medium Format (43.8x32.9mm)',
        widthMm: 43.8,
        heightMm: 32.9,
        diagonalMm: 54.78,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 54.78,
        aspectRatio: 43.8 / 32.9,
        description: 'Hasselblad / Fujifilm GFX medium format sensor for ultra-shallow cinematic portraiture.'
    },
    aps_c: {
        id: 'aps_c',
        name: 'APS-C / Super 35 Broadcast (23.6x15.6mm)',
        widthMm: 23.6,
        heightMm: 15.6,
        diagonalMm: 28.29,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 28.29,
        aspectRatio: 23.6 / 15.6,
        description: 'Common mirrorless and documentary format (Sony a6700, Nikon Zfc, Fujifilm X-T5).'
    },
    micro_four_thirds: {
        id: 'micro_four_thirds',
        name: 'Micro Four Thirds (17.3x13.0mm)',
        widthMm: 17.3,
        heightMm: 13.0,
        diagonalMm: 21.64,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 21.64,
        aspectRatio: 17.3 / 13.0,
        description: 'Compact cinema and drone sensor format (Panasonic GH6, DJI Inspire 2 X5S).'
    },
    smartphone_1_inch: {
        id: 'smartphone_1_inch',
        name: '1.0-inch Type Sensor (13.2x8.8mm)',
        widthMm: 13.2,
        heightMm: 8.8,
        diagonalMm: 15.86,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 15.86,
        aspectRatio: 13.2 / 8.8,
        description: 'Premium mobile and drone sensor (DJI Air 2S, Xiaomi 13 Pro, Sony RX100).'
    },
    smartphone_type_1_128: {
        id: 'smartphone_type_1_128',
        name: '1/1.28-inch Mobile Primary (9.8x7.3mm)',
        widthMm: 9.8,
        heightMm: 7.3,
        diagonalMm: 12.22,
        cropFactor: FULL_FRAME_DIAGONAL_MM / 12.22,
        aspectRatio: 9.8 / 7.3,
        description: 'Modern smartphone computational photography primary sensor (iPhone 14/15/16 Pro main camera).'
    }
};

/** Alias for PHYSICAL_SENSOR_PRESETS */
export const SENSOR_FORMAT_DIMENSIONS = PHYSICAL_SENSOR_PRESETS;

/**
 * Dynamic focus tracking target specification.
 */
export interface FocusTargetDefinition {
    /** 3D world space coordinate target [X, Y, Z] in meters */
    targetPosition?: [number, number, number];
    /** Real-world geodetic coordinate target (latitude, longitude, altitude) */
    targetGeodetic?: LatLngAlt;
    /** Exponential smoothing factor for rack focus (0 = instantaneous, 5.0 = standard cinematic rack focus) */
    dampingFactor?: number;
    /** Fixed focus distance in meters override (when target tracking is inactive) */
    manualFocusDistanceMeters?: number;
    /** If true, continuously points the camera attitude toward the focus target (LookAt) in addition to focus tracking */
    lookAtTarget?: boolean;
}

/**
 * Optical parameters configuring a physical camera.
 */
export interface PhysicalCameraConfig {
    /** Selected physical sensor preset or 'custom' */
    sensorFormat?: PhysicalSensorFormatId;
    /** Alias for sensorFormat */
    sensorFormatPreset?: PhysicalSensorFormatId;
    /** Custom sensor dimensions in millimeters (used if sensorFormat === 'custom' or as override) */
    customSensorDimensions?: { widthMm: number; heightMm: number };
    sensorWidthMm?: number;
    sensorHeightMm?: number;
    /** Lens focal length in millimeters (e.g. 24, 35, 50, 85, 135) */
    focalLengthMm?: number;
    /** Lens aperture f-stop / f-number (e.g. 1.2, 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 16.0) */
    apertureFStop?: number;
    /** Dynamic focus target tracking configuration */
    focusTarget?: FocusTargetDefinition;
    /** Explicit focus plane distance in meters (defaults to 5.0m or distance to target) */
    focusDistanceMeters?: number;
    /** Anamorphic squeeze factor (1.0 = spherical, 1.33x = 16:9 anamorphic, 2.0x = cinema anamorphic) */
    anamorphicSqueeze?: number;
    /** Alias for anamorphicSqueeze */
    anamorphicRatio?: number;
    /** Number of physical aperture blades for bokeh polygon shaping (0 = circular disc, 5, 6, 7, 9) */
    bladeCount?: number;
    /** Near clipping plane in meters */
    nearClip?: number;
    /** Far clipping plane in meters */
    farClip?: number;
    /** Whether Depth-of-Field bokeh post-processing pass is active */
    enableDepthOfField?: boolean;
    /** Maximum blur radius scale for the bokeh filter in pixels (default 1.0) */
    bokehScale?: number;
}

/**
 * Computed optical depth-of-field boundaries.
 */
export interface DepthOfFieldCalculation {
    nearFocusLimitMeters: number;
    farFocusLimitMeters: number;
    dofThicknessMeters: number;
    hyperfocalDistanceMeters: number;
    isInfinitelyDeep: boolean;
}

/**
 * Computed optical geometry, field of view angles, and depth of field boundaries.
 */
export interface OpticalFrustumCalculation {
    /** Vertical field of view in degrees (used by Three.js PerspectiveCamera.fov) */
    fovVerticalDeg: number;
    /** Horizontal field of view in degrees */
    fovHorizontalDeg: number;
    /** Diagonal field of view in degrees */
    fovDiagonalDeg: number;
    /** Alias for fovVerticalDeg */
    verticalFovDeg: number;
    /** Alias for fovHorizontalDeg */
    horizontalFovDeg: number;
    /** Alias for fovDiagonalDeg */
    diagonalFovDeg: number;
    /** Aspect ratio (width / height) */
    aspectRatio: number;
    /** Sensor dimensions specification */
    sensorDimensions: PhysicalSensorFormat;
    /** 35mm equivalent focal length in mm */
    equivalentFocalLength35Mm: number;
    /** Standard optical circle of confusion diameter in millimeters (d / 1500) */
    circleOfConfusionMm: number;
    /** Hyperfocal distance in meters (beyond which everything to infinity is acceptably sharp) */
    hyperfocalDistanceMeters: number;
    /** Near limit of acceptable focus sharpness in meters */
    nearFocusLimitMeters: number;
    /** Far limit of acceptable focus sharpness in meters (Infinity if focus is at or beyond hyperfocal) */
    farFocusLimitMeters: number;
    /** Total depth of field thickness in meters */
    depthOfFieldThicknessMeters: number;
    /** Optical focus distance in meters */
    focusDistanceMeters: number;
}

/**
 * Real-time dynamic focus tracking evaluation state.
 */
export interface DynamicFocusTrackingState {
    /** Current camera position [X, Y, Z] */
    cameraPosition: [number, number, number];
    /** Target position [X, Y, Z] */
    targetPosition: [number, number, number];
    /** Exact instantaneous distance to target in meters */
    instantaneousDistanceMeters: number;
    /** Damped / smoothed focus plane distance in meters */
    smoothedFocusDistanceMeters: number;
    /** Whether target is inside the camera frustum */
    isTargetInFrustum?: boolean;
}
