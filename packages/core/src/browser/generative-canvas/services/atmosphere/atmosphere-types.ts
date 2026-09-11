/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
