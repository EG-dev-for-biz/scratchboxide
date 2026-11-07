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
    /** Direct-normal illuminance of the spectral sun beam (lux at 1 AU); absent once the disc has set. */
    sunIlluminanceLux?: number;
    ambientLinearRgb?: [number, number, number];
    skyColorLinear?: [number, number, number];
    groundAlbedoLinear?: [number, number, number];
}

/**
 * A thin cloud deck drawn as stacked Earth-concentric shells instead of a raymarched volume: cheap for distant, flat
 * decks and correct at the horizon, where a curved shell converges and a flat plane would not. Every field is a physical
 * quantity, so cirrus streaks, an altostratus sheet, a smoke or ash pall, or a methane haze on another world are all
 * points in the same space.
 */
export interface CloudShellLayer {
    /** Diagnostic name only; the renderer never reads it. */
    label?: 'cirrus' | 'cirrostratus' | 'altostratus' | 'cirrocumulus' | (string & {});
    /** Height of the deck's base above the ground, metres. */
    baseAltitudeMeters: number;
    /** Vertical depth the stacked shells span, metres (0 = a single sheet). */
    thicknessMeters: number;
    /** Fraction of the sky the deck covers, 0-1. */
    coverage: number;
    /** Vertical optical depth of a fully covered column (thin cirrus ~0.03-1, altostratus ~2-20). */
    opticalDepth: number;
    /** Horizontal size of the deck's main features (cells, streaks), metres. */
    featureSizeMeters: number;
    /** How much longer features are along `streakHeadingDeg` than across it (1 = round cells). Default 1. */
    streakElongation?: number;
    /** Direction of elongation, degrees clockwise from north. Default 0. */
    streakHeadingDeg?: number;
    /** Henyey-Greenstein asymmetry of the particles (ice ~0.75, water ~0.85, smoke ~0.6). Default 0.75. */
    forwardScattering?: number;
    /** Linear-RGB single-scattering albedo (white water/ice ~[1,1,1]; soot, dust or ash below 1). Default [1, 1, 1]. */
    scatteringAlbedo?: [number, number, number];
    /** Number of stacked shells, 1-8. Default: one per ~400 m of thickness. */
    shellCount?: number;
    /** Drift speed of the deck, m/s along the streak heading. Default 0. */
    windSpeedMetersPerSecond?: number;
}

export interface AtmosphericScatteringConfig {
    enabled?: boolean;
    /**
     * Which clear-sky model the dome draws. 'multiple-scattering': García Liñán's multiple-scattering sky from the native
     * engine (vendored from Blender, MIT; scratchbox_sky_ms.hpp, GET /api/sky/multiple-scattering), what the scene weather
     * sets (scene-weather.ts applySceneWeather). Absent: the TypeScript spectral sky (physical-sky.ts).
     */
    skyModel?: 'multiple-scattering';
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
    /**
     * Veiling glare round the sun (lens/eye): 1 is the average measured on real HDR skies (~2.8% of the sun's light in
     * a halo falling as theta^-2.5), 0 none. Default 1 whenever the atmosphere has a sun.
     */
    sunGlare?: number;
    /** Thin cloud decks drawn as stacked curved shells, behind the volumetric layer. Strictly opt-in: none by default. */
    cloudLayers?: CloudShellLayer[];
    kelvinTemperature?: number;
    /**
     * By day the lights are white-balanced as a camera would be, to the sun and sky together, so the textures keep their
     * own colour (AtmosphericSkyDome.ts daylightWhiteBalance). false keeps the raw sun colour (a low sun's orange cast).
     * Golden hour, twilight, night and a chosen kelvinTemperature are never balanced.
     */
    whiteBalance?: boolean;
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
    /** The visible dome: draws the sky baked from `skyMaterial`. */
    skyDome: THREE.Mesh;
    /** The physical sky and cloud shader the dome is baked from; writing its uniforms re-bakes the sky. */
    skyMaterial: THREE.ShaderMaterial;
    sunMesh: THREE.Mesh;
    hemiLight: THREE.HemisphereLight;
    sunLight: THREE.DirectionalLight;
    sunDirection: THREE.Vector3;
    diurnalProfile: DiurnalLightingProfile;
    /** The camera's metered exposure for this sun and sky (sky-light-rig.ts calibratedExposure); the viewport applies it. */
    readonly exposure: number;
    /** The physical sky's mean radiance at the horizon and the zenith (scene-referred, linear): the haze's colours. */
    hazeColors: () => { horizon: THREE.Color; zenith: THREE.Color };
    /**
     * Keeps the sky around the view: centres the dome and sun disc on the camera and scales them to just inside its far
     * plane, so the dome's edge is never seen however far the camera pulls back (a sky is at infinity). The sun light is
     * not moved: its shadows stay fitted to the content.
     */
    followCamera?: (camera: THREE.Camera) => void;
    update: (time: number, delta: number) => void;
    setSunCoordinates: (elevationDeg: number, azimuthDeg: number) => void;
    setTimeOfDay: (timeHours: number, lat: number, lng: number) => void;
    setPreset: (preset: TimeOfDayPreset) => void;
    /** The sun's veiling glare (visibility through cloud and past geometry, as last measured). */
    sunGlare?: import('./SunGlare').SunGlare;
    /** Replaces the shell cloud decks (an empty list removes them). */
    setCloudLayers: (layers: CloudShellLayer[]) => void;
    /** The sky model the dome draws now: 'multiple-scattering' once the native table is in, else 'spectral' (physical-sky.ts). */
    readonly skyModel?: 'multiple-scattering' | 'spectral';
    /** Why the native multiple-scattering sky could not be drawn (the dome then keeps the spectral sky), when it failed. */
    readonly skyModelError?: string;
    /** Resolves when the sky the config asks for is drawn (at once for the spectral sky); rejects when the native sky failed. */
    whenSkyReady?: () => Promise<void>;
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
    /** Share of the sun a cloud currently leaves visible (0-1); dims and diffuses the rays, same signal as SunGlare. */
    setCloudVisibility: (visibility: number) => void;
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
