/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export type DiurnalPhase =
    | 'Deep Night'
    | 'Astronomical Twilight'
    | 'Nautical Twilight'
    | 'Civil Twilight'
    | 'Blue Hour'
    | 'Golden Hour'
    | 'Morning'
    | 'Afternoon'
    | 'Midday'
    | 'Overcast';

export type TimeOfDayPreset =
    | 'dawn'
    | 'golden_hour'
    | 'morning'
    | 'midday'
    | 'afternoon'
    | 'sunset'
    | 'dusk'
    | 'twilight'
    | 'blue_hour'
    | 'night'
    | 'deep_night'
    | 'overcast'
    | 'studio'
    | 'cinematic';

export interface SolarCoordinates {
    altitudeRad: number;
    azimuthRad: number;
    elevationDeg: number;
    azimuthDeg: number;
    distanceAU?: number;
    julianDay?: number;
}

export interface DiurnalLightingProfile {
    phase: DiurnalPhase;
    sunIntensity: number;
    skyLightIntensity: number;
    castShadows: boolean;
    toneMappingExposure: number;
    bloomIntensityScale: number;
    cloudSkyLightScale: number;
    cloudGroundBounceScale: number;
    aerialAlbedoBoost: number;
    inscatter: boolean;
    isNight: boolean;
    isGoldenHour: boolean;
    isTwilight: boolean;
    sunAltitudeDeg?: number;
    kelvinTemperature?: number;
    turbidity?: number;
    ambientIntensity?: number;
    shadowSoftness?: number;
    sunLinearRgb?: [number, number, number];
    ambientLinearRgb?: [number, number, number];
    skyColorLinear?: [number, number, number];
    groundAlbedoLinear?: [number, number, number];
}

export interface AtmosphericScatteringConfig {
    enabled?: boolean;
    rayleigh?: number;
    mie?: number;
    turbidity?: number;
    mieDirectionalG?: number;
    sunPosition?: [number, number, number];
    sunElevation?: number;
    sunAzimuth?: number;
    timeOfDay?: number; // 0.0 - 24.0 hours
    latitude?: number;
    longitude?: number;
    cloudCoverage?: number;
    cloudDensity?: number;
    cloudAltitude?: number;
    volumetricClouds?: boolean;
    kelvinTemperature?: number;
    wavelengthDispersion?: [number, number, number];

    // Aerial Perspective & Depth Inscattering
    aerialPerspectiveEnabled?: boolean;
    inscatteringIntensity?: number;
    aerialPerspectiveRange?: number;
    aerialPerspectiveExtinctionRange?: number;
    fogDensity?: number;
    fogBaseAltitude?: number;
    fogHeight?: number;
    albedoScale?: number;

    // Terrain Cloud Shadows
    cloudShadowsEnabled?: boolean;
    cloudShadowIntensity?: number;
    cloudShadowScale?: number;
    atmosphereShadowLength?: number;
    windVector?: [number, number];
}

export interface AerialPerspectiveOptions {
    inscatteringIntensity?: number;
    aerialPerspectiveRange?: number;
    rayleigh?: number;
    mie?: number;
    turbidity?: number;
    mieDirectionalG?: number;
    fogDensity?: number;
    fogBaseAltitude?: number;
    fogHeight?: number;
    albedoScale?: number;
    cloudShadowsEnabled?: boolean;
    cloudShadowIntensity?: number;
    cloudShadowScale?: number;
    atmosphereShadowLength?: number;
    cloudAltitude?: number;
    cloudCoverage?: number;
    cloudDensity?: number;
    windVector?: [number, number];
    sunDirection?: THREE.Vector3;
    sunColor?: THREE.Color;
    sunIntensity?: number;
    topColor?: THREE.Color;
    bottomColor?: THREE.Color;
}

export interface CloudShadowConfig {
    cloudShadowsEnabled?: boolean;
    cloudShadowIntensity?: number;
    cloudShadowScale?: number;
    atmosphereShadowLength?: number;
    cloudAltitude?: number;
    cloudCoverage?: number;
    cloudDensity?: number;
    windVector?: [number, number];
}

export interface AtmosphericSkyDomeModule {
    skyDome: THREE.Mesh;
    sunMesh: THREE.Mesh;
    hemiLight: THREE.HemisphereLight;
    sunLight: THREE.DirectionalLight;
    sunDirection: THREE.Vector3;
    diurnalProfile: DiurnalLightingProfile;
    update: (time: number, delta: number) => void;
    setSunCoordinates: (elevationDeg: number, azimuthDeg: number) => void;
    setTimeOfDay: (timeHours: number, lat?: number, lng?: number) => void;
    setPreset: (preset: TimeOfDayPreset) => void;
    dispose: () => void;
}

export interface VolumetricGodRaysConfig {
    intensity?: number;
    color?: number | string;
    spreadRadius?: number;
    rayCount?: number;
    rayLength?: number;
    taperTopRadius?: number;
    taperBottomRadius?: number;
    shimmerSpeed?: number;
    depthTest?: boolean;
}

export interface VolumetricGodRaysModule {
    group: THREE.Group;
    update: (time: number, delta?: number) => void;
    setSunPosition: (pos: THREE.Vector3) => void;
    setColor: (color: number | string) => void;
    setIntensity: (intensity: number) => void;
    dispose: () => void;
}

export interface VolumetricMedium {
    scatteringColor?: [number, number, number];
    density?: number;
    scatteringAlbedo?: number;
    anisotropy?: number;
    groundLevel?: number;
    heightScale?: number;
}

export interface VolumetricResult {
    inscatteredRadiance: [number, number, number];
    transmittance: number;
}

export interface AtmosphereServiceAttachOptions {
    enableSkyDome?: boolean;
    enableAerialPerspective?: boolean;
    enableCloudShadows?: boolean;
    enableGodRays?: boolean;
    renderWidth?: number;
    renderHeight?: number;
    isSunset?: boolean;
}

export interface AtmosphereHandle {
    skyDomeModule?: AtmosphericSkyDomeModule;
    aerialPerspective?: any;
    cloudShadows?: any;
    godRays?: VolumetricGodRaysModule;
    update: (timeSec: number, deltaSec: number) => void;
    render: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void;
    dispose: () => void;
}

export interface ImageAtmospherePixelOptions {
    pixels: Uint8Array | Uint8ClampedArray | Float32Array;
    width: number;
    height: number;
    /** With timestampIso, the sun comes from NOAA ephemeris at these coordinates. */
    knownCoords?: { lat: number; lng: number };
    timestampIso?: string;
    /** Optical-axis heading, degrees clockwise from north. Without it image-derived azimuths are camera-relative. */
    cameraHeadingDeg?: number;
    /** Optical-axis pitch above the horizon. Without it a level camera is assumed (reported in `assumptions`). */
    cameraPitchDeg?: number;
    /** Horizontal field of view. Without it 60 deg is assumed (reported in `assumptions`). */
    hfovDeg?: number;
    /** Vertical field of view; derived from hfov and the aspect ratio when omitted. */
    vfovDeg?: number;
}

export interface ImageAtmosphereRequest {
    imagePath?: string;
    imageBuffer?: Buffer;
    pixels?: Uint8Array | Uint8ClampedArray | Float32Array;
    width?: number;
    height?: number;
    knownCoords?: { lat: number; lng: number };
    timestampIso?: string;
    cameraHeadingDeg?: number;
    cameraPitchDeg?: number;
    hfovDeg?: number;
    vfovDeg?: number;
}

export interface AtmosphericEstimationResult {
    [key: string]: unknown;
    success: boolean;
    landmarkHint?: string;
    sunElevation: number; // degrees
    sunAzimuth: number; // degrees, clockwise from north or from the camera forward axis (see azimuthReference)
    azimuthReference: 'true-north' | 'camera-forward';
    /** How the sun was located: 'noaa-ephemeris', 'sun-disc' or 'preetham-sky-fit' (diagnostic label). */
    sunSource: string;
    solarVector: [number, number, number]; // [x, y, z] in ENU convention, toward the sun
    diurnalPhase: DiurnalPhase;
    /** CCT of the direct sun from the Preetham transmittance at the fitted turbidity and sun elevation. */
    kelvinTemperature?: number;
    sunColorRgb?: [number, number, number]; // normalized [0, 1]
    /** Mean linear colour of the segmented sky pixels. */
    ambientColorRgb?: [number, number, number];
    /** Preetham turbidity fitted to the sky pixels. */
    turbidity?: number;
    /** Angstrom turbidity coefficient beta derived from the fitted turbidity (Preetham 1999). */
    angstromBeta?: number;
    rayleigh?: number;
    rayleighScattering?: number;
    mie?: number;
    /** Fraction of the segmented sky that is bright and achromatic (cloud or haze). */
    cloudCoverage?: number;
    cloudDensity?: number;
    /** Koschmieder visibility (m) from the fitted turbidity, assuming a 1.2 km aerosol scale height. */
    aerialPerspectiveRange?: number;
    aerialPerspectiveExtinctionRange?: number;
    inscatteringIntensity?: number;
    /** Confidence of an image-derived sun (fit R^2 x identifiability, or disc circularity); absent for ephemeris. */
    confidenceScore?: number;
    confidence?: number;
    /** Preetham fit quality where a fit was made. */
    skyFit?: { luminanceR2: number; chromaRms: number; samples: number };
    assumptions: string[];
    unmeasured: Record<string, string>;
    photometricMetrics: {
        skyPixelFraction: number;
        skyMeanLuminance?: number;
        skyChromaticity?: [number, number, number];
        skyGradientRatio?: number;
        groundMeanLuminance?: number;
        contrastRatio?: number;
        estimatedGlareLocus?: [number, number];
    };
    suggestedAtmosphereConfig: AtmosphericScatteringConfig;
}
