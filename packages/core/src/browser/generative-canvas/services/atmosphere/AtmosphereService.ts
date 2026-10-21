/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    AtmosphericScatteringConfig,
    AtmosphereServiceAttachOptions,
    AtmosphereHandle,
    DiurnalPhase,
    DiurnalLightingProfile,
    TimeOfDayPreset,
    SolarCoordinates,
    VolumetricMedium,
    VolumetricResult,
    VolumetricGodRaysConfig,
    AtmosphericSkyDomeModule,
    ImageAtmospherePixelOptions,
    ImageAtmosphereRequest,
    AtmosphericEstimationResult
} from './atmosphere-types';
import { AtmosphereImageEstimationService } from './AtmosphereImageEstimationService';
import { createAtmosphericSkyDome, layerCoverageForSkyCover, requireLocation } from './AtmosphericSkyDome';
import {
    createAerialPerspectiveEffect,
    AerialPerspectiveEffect,
    computeBeerLambertTransmittance,
    computeInscatteringRadiance,
    evaluateAerialPerspective
} from './AerialPerspectiveEffect';
import { createTerrainCloudShadows, TerrainCloudShadows } from './TerrainCloudShadows';
import { createVolumetricGodRays, VolumetricGodRays } from './VolumetricGodRays';
import {
    calculateNOAASolarPosition,
    calculateENUSunVector,
    getSunVectorFromAngles,
    calculateJulianDay
} from './solar-position';
import {
    classifyDiurnalPhase,
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    getPresetLightingState
} from './diurnal-lighting';
import { kelvinToRGB, blackbodyKelvinToLinearRgb } from './kelvin';
import {
    marchVolumetrics,
    SphericalHarmonics9,
    henyeyGreensteinPhase,
    rayleighPhase,
    dualLobePhase
} from './volumetric-participating-media';

/**
 * Unified Atmosphere Service.
 * Central production facade for managing the full atmospheric stack:
 * - Rayleigh/Mie analytic sky dome and sun disk
 * - 3D raymarched volumetric cloud layers
 * - Full-screen aerial perspective depth inscattering post-processing
 * - Dynamic moving terrain cloud shadows
 * - Volumetric god rays and sunbeam shafts
 * - NOAA solar ephemeris and 9-phase diurnal lighting profiles
 * - Planckian blackbody Kelvin radiometry
 * - Participating media raymarching and Spherical Harmonics 9 irradiance
 */
export class AtmosphereService {
    public scene?: THREE.Scene;
    public skyDomeModule?: AtmosphericSkyDomeModule;
    public aerialPerspective?: AerialPerspectiveEffect;
    public cloudShadows?: TerrainCloudShadows;
    public godRays?: VolumetricGodRays;
    public config: AtmosphericScatteringConfig;

    constructor(initialConfig: AtmosphericScatteringConfig = {}) {
        this.config = { ...initialConfig };
    }

    /**
     * Attaches the atmospheric system to a live Three.js scene.
     */
    public attach(
        scene: THREE.Scene,
        config?: AtmosphericScatteringConfig,
        options: AtmosphereServiceAttachOptions = {}
    ): AtmosphereHandle {
        if (config) {
            this.config = { ...this.config, ...config };
        }
        this.scene = scene;

        const isSunset = options.isSunset ?? (this.config.sunElevation !== undefined && this.config.sunElevation < 15.0);

        // 1. Sky Dome & Volumetric Clouds
        if (options.enableSkyDome !== false) {
            this.skyDomeModule = createAtmosphericSkyDome(scene, isSunset, this.config);
        }

        // 2. Aerial Perspective Post-Processing Pass
        if (options.enableAerialPerspective === true || this.config.aerialPerspectiveEnabled) {
            const width = options.renderWidth ?? 1920;
            const height = options.renderHeight ?? 1080;
            this.aerialPerspective = createAerialPerspectiveEffect(
                {
                    inscatteringIntensity: this.config.inscatteringIntensity,
                    aerialPerspectiveRange: this.config.aerialPerspectiveRange,
                    rayleigh: this.config.rayleigh,
                    mie: this.config.mie,
                    turbidity: this.config.turbidity,
                    fogDensity: this.config.fogDensity,
                    fogBaseAltitude: this.config.fogBaseAltitude,
                    fogHeight: this.config.fogHeight,
                    albedoScale: this.config.albedoScale
                },
                width,
                height
            );
        }

        // 3. Terrain Cloud Shadows
        if (options.enableCloudShadows === true || this.config.cloudShadowsEnabled) {
            this.cloudShadows = createTerrainCloudShadows({
                cloudShadowsEnabled: true,
                cloudShadowIntensity: this.config.cloudShadowIntensity,
                cloudShadowScale: this.config.cloudShadowScale,
                atmosphereShadowLength: this.config.atmosphereShadowLength,
                cloudAltitude: this.config.cloudAltitude,
                cloudCoverage: this.config.cloudCoverage,
                cloudDensity: this.config.cloudDensity,
                windVector: this.config.windVector
            });
        }

        // 4. Volumetric God Rays
        if (options.enableGodRays === true) {
            const sunPos = this.skyDomeModule?.sunLight?.position
                ? this.skyDomeModule.sunLight.position.clone()
                : (this.config.sunPosition
                      ? new THREE.Vector3(...this.config.sunPosition)
                      : new THREE.Vector3(40, 60, 40));

            this.godRays = new VolumetricGodRays(scene, sunPos, isSunset, {
                intensity: 0.28,
                spreadRadius: 5.0
            });
        }

        return {
            skyDomeModule: this.skyDomeModule,
            aerialPerspective: this.aerialPerspective,
            cloudShadows: this.cloudShadows,
            godRays: this.godRays,
            update: (timeSec: number, deltaSec: number) => this.update(timeSec, deltaSec),
            render: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => this.render(renderer, camera),
            dispose: () => this.dispose()
        };
    }

    /**
     * Advances all dynamic atmospheric animation systems: cloud drift, god ray shimmer, and shadow propagation.
     */
    public update(timeSec: number, deltaSec: number = 0.016): void {
        if (this.skyDomeModule) {
            this.skyDomeModule.update(timeSec, deltaSec);
        }

        if (this.cloudShadows) {
            const sunDir = this.skyDomeModule?.sunDirection ?? new THREE.Vector3(0.5, 0.7, 0.4).normalize();
            this.cloudShadows.update(timeSec, sunDir);
        }

        if (this.godRays) {
            this.godRays.update(timeSec, deltaSec);
            if (this.skyDomeModule?.sunLight?.position) {
                this.godRays.setSunPosition(this.skyDomeModule.sunLight.position);
            }
        }
    }

    /**
     * Renders scene with full-screen aerial perspective pass if enabled, or falls back to standard rendering.
     */
    public render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
        if (!this.scene) return;

        if (this.aerialPerspective) {
            this.aerialPerspective.render(renderer, this.scene, camera as THREE.PerspectiveCamera);
        } else {
            renderer.render(this.scene, camera);
        }
    }

    /**
     * Updates solar diurnal time of day (0.0 - 24.0 hours) with optional NOAA geographic coordinates.
     */
    public setDiurnalTimeOfDay(timeHours: number, lat?: number, lng?: number): void {
        // The location is the one given, else the one configured; a time alone cannot place the sun.
        const [latitude, longitude] = requireLocation('setDiurnalTimeOfDay', lat ?? this.config.latitude, lng ?? this.config.longitude);
        this.config.timeOfDay = timeHours;
        this.config.latitude = latitude;
        this.config.longitude = longitude;

        if (this.skyDomeModule) {
            this.skyDomeModule.setTimeOfDay(timeHours, latitude, longitude);
        }
    }

    /**
     * Computes real-world solar ephemeris for given coordinates and updates scene lighting.
     */
    public setGeoCoordinates(lat: number, lng: number, date: Date = new Date()): void {
        this.config.latitude = lat;
        this.config.longitude = lng;

        const ephemeris = calculateNOAASolarPosition(date, lat, lng);
        this.config.sunElevation = ephemeris.elevationDeg;
        this.config.sunAzimuth = ephemeris.azimuthDeg;

        if (this.skyDomeModule) {
            this.skyDomeModule.setSunCoordinates(ephemeris.elevationDeg, ephemeris.azimuthDeg);
        }
    }

    /**
     * Applies a standardized diurnal lighting preset (e.g. golden_hour, sunset, midday, blue_hour, night).
     */
    public setDiurnalPreset(preset: TimeOfDayPreset): void {
        if (this.skyDomeModule) {
            this.skyDomeModule.setPreset(preset);
        }
    }

    /**
     * Adjusts cloud layer parameters dynamically.
     */
    public setClouds(coverage?: number, density?: number, altitude?: number): void {
        if (coverage !== undefined) this.config.cloudCoverage = coverage;
        if (density !== undefined) this.config.cloudDensity = density;
        if (altitude !== undefined) this.config.cloudAltitude = altitude;

        if (this.skyDomeModule) {
            const uniforms = this.skyDomeModule.skyMaterial.uniforms;
            // coverage is the sky cover seen from the ground; the shader takes the layer's plan coverage
            if (coverage !== undefined && uniforms.uCloudCoverage) uniforms.uCloudCoverage.value = layerCoverageForSkyCover(coverage);
            if (density !== undefined && uniforms.uCloudDensity) uniforms.uCloudDensity.value = density;
            if (altitude !== undefined && uniforms.uCloudAltitude) uniforms.uCloudAltitude.value = altitude;
        }

        if (this.cloudShadows) {
            this.cloudShadows.updateConfig({
                cloudCoverage: coverage,
                cloudDensity: density,
                cloudAltitude: altitude
            });
        }
    }

    /**
     * Enables or disables full-screen depth inscattering aerial perspective.
     */
    public setAerialPerspective(enabled: boolean, range?: number, intensity?: number): void {
        this.config.aerialPerspectiveEnabled = enabled;
        if (range !== undefined) this.config.aerialPerspectiveRange = range;
        if (intensity !== undefined) this.config.inscatteringIntensity = intensity;

        if (enabled && !this.aerialPerspective && this.scene) {
            this.aerialPerspective = createAerialPerspectiveEffect(
                {
                    inscatteringIntensity: this.config.inscatteringIntensity,
                    aerialPerspectiveRange: this.config.aerialPerspectiveRange
                },
                1920,
                1080
            );
        } else if (!enabled && this.aerialPerspective) {
            this.aerialPerspective.dispose();
            this.aerialPerspective = undefined;
        }
    }

    /**
     * Enables, disables, or configures volumetric god rays light shafts.
     */
    public setGodRays(enabled: boolean, intensity?: number, color?: string | number): void {
        if (enabled) {
            if (!this.godRays && this.scene) {
                const sunPos = this.skyDomeModule?.sunLight?.position
                    ? this.skyDomeModule.sunLight.position.clone()
                    : new THREE.Vector3(40, 60, 40);
                this.godRays = new VolumetricGodRays(this.scene, sunPos, false, { intensity, color });
            } else if (this.godRays) {
                if (intensity !== undefined) this.godRays.setIntensity(intensity);
                if (color !== undefined) this.godRays.setColor(color);
            }
        } else if (this.godRays) {
            this.godRays.dispose();
            this.godRays = undefined;
        }
    }

    /**
     * Updates full atmospheric scattering configuration dynamically.
     */
    public updateConfig(newConfig: Partial<AtmosphericScatteringConfig>): void {
        Object.assign(this.config, newConfig);

        if (newConfig.sunElevation !== undefined && newConfig.sunAzimuth !== undefined && this.skyDomeModule) {
            this.skyDomeModule.setSunCoordinates(newConfig.sunElevation, newConfig.sunAzimuth);
        }

        if (newConfig.cloudCoverage !== undefined || newConfig.cloudDensity !== undefined || newConfig.cloudAltitude !== undefined) {
            this.setClouds(newConfig.cloudCoverage, newConfig.cloudDensity, newConfig.cloudAltitude);
        }

        if (newConfig.aerialPerspectiveEnabled !== undefined || newConfig.aerialPerspectiveRange !== undefined || newConfig.aerialPerspectiveExtinctionRange !== undefined || newConfig.inscatteringIntensity !== undefined) {
            const range = newConfig.aerialPerspectiveRange ?? newConfig.aerialPerspectiveExtinctionRange ?? this.config.aerialPerspectiveRange;
            this.setAerialPerspective(
                newConfig.aerialPerspectiveEnabled ?? !!this.config.aerialPerspectiveEnabled,
                range,
                newConfig.inscatteringIntensity ?? this.config.inscatteringIntensity
            );
        }
    }

    /**
     * Applies inverse photometric estimation results from an image directly to the atmosphere stack.
     */
    public applyEstimationResult(result: AtmosphericEstimationResult): void {
        this.updateConfig(result.suggestedAtmosphereConfig);
    }

    /**
     * Gets a copy of the active atmospheric scattering configuration.
     */
    public getConfig(): AtmosphericScatteringConfig {
        return { ...this.config };
    }

    /**
     * Disposes of all atmospheric resources, geometries, materials, and passes cleanly.
     */
    public dispose(): void {
        if (this.skyDomeModule) {
            this.skyDomeModule.dispose();
            this.skyDomeModule = undefined;
        }
        if (this.aerialPerspective) {
            this.aerialPerspective.dispose();
            this.aerialPerspective = undefined;
        }
        if (this.cloudShadows) {
            this.cloudShadows.dispose();
            this.cloudShadows = undefined;
        }
        if (this.godRays) {
            this.godRays.dispose();
            this.godRays = undefined;
        }
        this.scene = undefined;
    }

    // =========================================================================
    // Static Scientific, Radiometric, and Ephemeris Math APIs
    // =========================================================================

    public static calculateSolarPosition(date: Date, lat: number, lng: number): SolarCoordinates {
        return calculateNOAASolarPosition(date, lat, lng);
    }

    public static calculateENUSunVector(altitudeRad: number, azimuthRad: number): THREE.Vector3 {
        return calculateENUSunVector(altitudeRad, azimuthRad);
    }

    public static getSunVectorFromAngles(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
        return getSunVectorFromAngles(elevationDeg, azimuthDeg);
    }

    public static calculateJulianDay(date: Date): number {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
        return calculateJulianDay(year, month, day, utcHours);
    }

    public static classifyDiurnalPhase(elevationDeg: number): DiurnalPhase {
        return classifyDiurnalPhase(elevationDeg);
    }

    public static computeDiurnalProfile(elevationDeg: number): DiurnalLightingProfile {
        return computeDiurnalLightingProfile(elevationDeg);
    }

    public static getDiurnalLightingState(latitude: number, longitude: number, timeOfDay: number) {
        return getDiurnalLightingState(latitude, longitude, timeOfDay);
    }

    public static getPresetLightingState(preset: TimeOfDayPreset) {
        return getPresetLightingState(preset);
    }

    public static kelvinToRGB(kelvin: number): THREE.Color {
        return kelvinToRGB(kelvin);
    }

    public static blackbodyKelvinToLinearRgb(kelvin: number): [number, number, number] {
        return blackbodyKelvinToLinearRgb(kelvin);
    }

    public static computeBeerLambertTransmittance(
        distance: number,
        rayleigh?: number,
        mie?: number,
        turbidity?: number,
        maxRange?: number
    ): THREE.Color {
        return computeBeerLambertTransmittance(distance, rayleigh, mie, turbidity, maxRange);
    }

    public static computeInscatteringRadiance(
        distance: number,
        viewDir: THREE.Vector3 = new THREE.Vector3(0, 0, -1),
        sunDir: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
        sunColor: THREE.Color = new THREE.Color(1, 1, 1),
        sunIntensity: number = 1.0,
        horizonColor: THREE.Color = new THREE.Color(0.7, 0.8, 0.9),
        zenithColor: THREE.Color = new THREE.Color(0.2, 0.4, 0.8),
        rayleigh: number = 0.5,
        mie: number = 0.002,
        mieG: number = 0.82,
        inscatteringIntensity: number = 1.0,
        diurnalProfile?: DiurnalLightingProfile,
        maxRange: number = 250.0
    ): THREE.Color {
        return computeInscatteringRadiance(
            distance,
            viewDir,
            sunDir,
            sunColor,
            sunIntensity,
            horizonColor,
            zenithColor,
            rayleigh,
            mie,
            mieG,
            inscatteringIntensity,
            diurnalProfile,
            maxRange
        );
    }

    public static evaluateAerialPerspective(
        surfaceColor: THREE.Color,
        distance: number,
        viewDir: THREE.Vector3 = new THREE.Vector3(0, 0, -1),
        sunDir: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
        sunColor: THREE.Color = new THREE.Color(1, 1, 1),
        sunIntensity: number = 1.0,
        horizonColor: THREE.Color = new THREE.Color(0.7, 0.8, 0.9),
        zenithColor: THREE.Color = new THREE.Color(0.2, 0.4, 0.8),
        config: { rayleigh?: number; mie?: number; turbidity?: number; inscatteringIntensity?: number; aerialPerspectiveRange?: number } = {},
        diurnalProfile?: DiurnalLightingProfile
    ): THREE.Color {
        return evaluateAerialPerspective(
            surfaceColor,
            distance,
            viewDir,
            sunDir,
            sunColor,
            sunIntensity,
            horizonColor,
            zenithColor,
            config,
            diurnalProfile
        );
    }

    public static henyeyGreensteinPhase(cosTheta: number, g: number): number {
        return henyeyGreensteinPhase(cosTheta, g);
    }

    public static rayleighPhase(cosTheta: number): number {
        return rayleighPhase(cosTheta);
    }

    public static dualLobePhase(
        cosTheta: number,
        gForward: number = 0.75,
        gBackward: number = -0.25,
        blendWeight: number = 0.85
    ): number {
        return dualLobePhase(cosTheta, gForward, gBackward, blendWeight);
    }

    public static marchVolumetrics(
        ro: [number, number, number],
        rd: [number, number, number],
        maxDist: number,
        lightPos: [number, number, number],
        lightColor: [number, number, number],
        lightIntensity: number,
        medium: VolumetricMedium = {},
        numSteps: number = 24
    ): VolumetricResult {
        return marchVolumetrics(ro, rd, maxDist, lightPos, lightColor, lightIntensity, medium, numSteps);
    }

    public static evaluateSphericalHarmonics(
        normal: [number, number, number] | { x: number; y: number; z: number },
        coeffs?: [number, number, number][]
    ): [number, number, number] {
        const sh = new SphericalHarmonics9(coeffs);
        return sh.evaluateIrradiance(normal);
    }

    public static getSkyGoldenHourSH(): SphericalHarmonics9 {
        return SphericalHarmonics9.getSkyGoldenHourSH();
    }

    public static getSkyForestCanopySH(): SphericalHarmonics9 {
        return SphericalHarmonics9.getSkyForestCanopySH();
    }

    /**
     * Filament cmgen-style projection:
     * Projects any equirectangular HDR/linear RGB radiance map into 9 Spherical Harmonic coefficients.
     */
    public static projectEquirectangularToSH(
        rgbData: Float32Array | number[] | Uint8ClampedArray | Uint8Array,
        width: number,
        height: number,
        channels: number = 3
    ): SphericalHarmonics9 {
        return SphericalHarmonics9.projectEquirectangular(rgbData, width, height, channels);
    }

    public static estimateFromImage(request: ImageAtmosphereRequest): Promise<AtmosphericEstimationResult> {
        return AtmosphereImageEstimationService.estimateFromImage(request);
    }

    public static estimateFromPixels(options: ImageAtmospherePixelOptions): AtmosphericEstimationResult {
        return AtmosphereImageEstimationService.estimateFromPixels(options);
    }
}
