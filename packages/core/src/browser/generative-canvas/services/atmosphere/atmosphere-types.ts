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
    knownCoords?: { lat: number; lng: number };
    timestampIso?: string;
    promptHint?: string;
    cameraHeadingDeg?: number;
    cameraPitchDeg?: number;
    hfovDeg?: number;
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
    promptHint?: string;
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
    sunAzimuth: number; // degrees from North (0-360)
    solarVector: [number, number, number]; // [x, y, z] in ENU convention
    diurnalPhase: DiurnalPhase;
    kelvinTemperature: number;
    sunColorRgb: [number, number, number]; // normalized [0, 1]
    ambientColorRgb: [number, number, number]; // normalized [0, 1]
    turbidity: number;
    rayleigh: number;
    rayleighScattering?: number;
    mie: number;
    cloudCoverage: number; // 0.0 - 1.0
    cloudDensity: number; // 0.0 - 2.0
    aerialPerspectiveRange: number; // meters
    aerialPerspectiveExtinctionRange?: number;
    inscatteringIntensity: number; // 0.0 - 1.0
    confidenceScore: number; // 0.0 - 1.0
    confidence?: number;
    photometricMetrics: {
        skyMeanLuminance: number;
        skyChromaticity: [number, number, number];
        skyGradientRatio: number;
        groundMeanLuminance: number;
        contrastRatio: number;
        estimatedGlareLocus?: [number, number];
    };
    suggestedAtmosphereConfig: AtmosphericScatteringConfig;
}
