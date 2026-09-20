/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    calculateNOAASolarPosition,
    classifyDiurnalPhase,
    computeDiurnalLightingProfile,
    getPresetLightingState,
    getSunVectorFromAngles,
    AtmosphereImageEstimationService
} from '../../../browser/generative-canvas/services/atmosphere';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

export const ATMOSPHERE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'atmosphere_calculate_solar_position',
        description: 'Calculate NOAA solar ephemeris (solar elevation, azimuth, distance AU, Julian day, and diurnal phase) for any geographic coordinates and date/time.',
        parameters: {
            type: 'OBJECT',
            properties: {
                latitude: {
                    type: 'NUMBER',
                    description: 'Geographic latitude in degrees (-90 to +90).'
                },
                longitude: {
                    type: 'NUMBER',
                    description: 'Geographic longitude in degrees (-180 to +180).'
                },
                isoDate: {
                    type: 'STRING',
                    description: 'Optional ISO 8601 date-time string (e.g. "2026-06-21T18:30:00Z"). Defaults to now.'
                }
            },
            required: ['latitude', 'longitude']
        }
    },
    {
        name: 'atmosphere_get_diurnal_profile',
        description: 'Compute physical diurnal lighting profile (Kelvin color temperature, direct/ambient/sky/ground irradiance, and diurnal phase) from sun elevation angle.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elevationDeg: {
                    type: 'NUMBER',
                    description: 'Sun elevation angle above the horizon in degrees (-90 to +90).'
                },
                turbidity: {
                    type: 'NUMBER',
                    description: 'Optional atmospheric turbidity factor (default: 2.5).'
                }
            },
            required: ['elevationDeg']
        }
    },
    {
        name: 'atmosphere_configure_scene',
        description: 'Synthesizes complete physical atmospheric configuration for a 3D scene (Rayleigh, Mie, cloud layers, aerial perspective, and god rays) given a time of day preset or coordinates.',
        parameters: {
            type: 'OBJECT',
            properties: {
                preset: {
                    type: 'STRING',
                    description: 'Diurnal preset: "dawn", "golden_hour", "midday", "afternoon", "sunset", "twilight", "blue_hour", "night", or "overcast".'
                },
                latitude: {
                    type: 'NUMBER',
                    description: 'Optional geographic latitude.'
                },
                longitude: {
                    type: 'NUMBER',
                    description: 'Optional geographic longitude.'
                },
                timeOfDay: {
                    type: 'NUMBER',
                    description: 'Optional time of day in decimal hours (0.0 - 24.0).'
                },
                enableAerialPerspective: {
                    type: 'BOOLEAN',
                    description: 'Whether to enable full-screen depth inscattering aerial perspective.'
                },
                enableGodRays: {
                    type: 'BOOLEAN',
                    description: 'Whether to enable volumetric sunbeams/god rays.'
                },
                cloudCoverage: {
                    type: 'NUMBER',
                    description: 'Cloud coverage fraction (0.0 to 1.0).'
                }
            }
        }
    },
    {
        name: 'atmosphere_estimate_from_image',
        description: 'Inverse photometric and ephemeris analysis that extracts matching physical lighting and atmosphere (solar elevation/azimuth vector, Planckian Kelvin color temperature, Rayleigh/Mie scattering, turbidity, cloud layers, and aerial perspective haze) from an input photograph or plate.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path or filename of the reference image.'
                },
                promptHint: {
                    type: 'STRING',
                    description: 'Optional descriptive prompt or landmark hint (e.g. "Colosseum Rome afternoon", "Eiffel tower sunset").'
                },
                latitude: {
                    type: 'NUMBER',
                    description: 'Optional known geographic latitude of the photograph.'
                },
                longitude: {
                    type: 'NUMBER',
                    description: 'Optional known geographic longitude of the photograph.'
                },
                isoDate: {
                    type: 'STRING',
                    description: 'Optional ISO 8601 date-time string when the photo was captured.'
                },
                cameraHeadingDeg: {
                    type: 'NUMBER',
                    description: 'Optional camera heading in degrees clockwise from North (0-360).'
                },
                cameraPitchDeg: {
                    type: 'NUMBER',
                    description: 'Optional camera pitch angle in degrees.'
                }
            }
        }
    },
    {
        name: 'atmosphere_harmonize_location_3d',
        description: 'Calculates and synthesizes photogrammetric de-lighting shader uniforms (shadow lift, highlight compression, stone albedo, sky irradiance, ground bounce, terrain de-wash), atmospheric scene lighting, sky gradient, and interior architectural portal window backlighting for a 3D location mesh.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: { type: 'STRING', description: 'Optional reference image or plate' },
                landmarkName: { type: 'STRING', description: 'Optional landmark name (e.g. "Colosseum, Rome", "Eiffel Tower")' },
                preset: {
                    type: 'STRING',
                    description: 'Lighting preset: "civil_twilight_dusk", "golden_hour", "midday_clear", "blue_hour", "night_monumental"'
                },
                latitude: { type: 'NUMBER', description: 'Geographic latitude' },
                longitude: { type: 'NUMBER', description: 'Geographic longitude' },
                isoDate: { type: 'STRING', description: 'ISO 8601 capture timestamp' },
                stoneType: {
                    type: 'STRING',
                    description: 'Stone albedo profile: "travertine", "limestone", "sandstone", "granite", "terracotta", "marble", "concrete"'
                },
                enableArchitecturalBacklighting: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize interior architectural portal window fixtures (default: true)'
                },
                customDelightParams: {
                    type: 'OBJECT',
                    description: 'Custom override parameters for de-lighting uniforms'
                }
            }
        }
    }
];

export const atmosphereHandlers: Record<string, ToolHandler> = {
    atmosphere_calculate_solar_position: (args, _ctx) => {
        const lat = typeof args.latitude === 'number' ? args.latitude : parseFloat(String(args.latitude));
        const lng = typeof args.longitude === 'number' ? args.longitude : parseFloat(String(args.longitude));
        if (isNaN(lat) || isNaN(lng)) throw new Error('atmosphere_calculate_solar_position: valid latitude and longitude are required.');

        const date = args.isoDate ? new Date(asString(args.isoDate)) : new Date();
        const ephemeris = calculateNOAASolarPosition(date, lat, lng);
        const phase = classifyDiurnalPhase(ephemeris.elevationDeg);

        return {
            resultPayload: {
                success: true,
                latitude: lat,
                longitude: lng,
                elevationDeg: ephemeris.elevationDeg,
                azimuthDeg: ephemeris.azimuthDeg,
                distanceAU: ephemeris.distanceAU,
                julianDay: ephemeris.julianDay,
                phase
            },
            summaryResult: `Calculated NOAA solar ephemeris: Elevation ${ephemeris.elevationDeg.toFixed(2)}°, Azimuth ${ephemeris.azimuthDeg.toFixed(2)}°, Phase: ${phase}.`
        };
    },

    atmosphere_get_diurnal_profile: (args, _ctx) => {
        const elevation = typeof args.elevationDeg === 'number' ? args.elevationDeg : parseFloat(String(args.elevationDeg));
        if (isNaN(elevation)) throw new Error('atmosphere_get_diurnal_profile: valid elevationDeg is required.');

        const turbidity = typeof args.turbidity === 'number' ? args.turbidity : 2.5;
        const profile = computeDiurnalLightingProfile(elevation);

        return {
            resultPayload: {
                success: true,
                elevationDeg: elevation,
                phase: profile.phase,
                kelvinTemperature: profile.kelvinTemperature,
                sunIntensity: profile.sunIntensity,
                ambientIntensity: profile.ambientIntensity,
                shadowSoftness: profile.shadowSoftness,
                turbidity: profile.turbidity ?? turbidity,
                sunLinearRgb: profile.sunLinearRgb,
                ambientLinearRgb: profile.ambientLinearRgb,
                skyColorLinear: profile.skyColorLinear,
                groundAlbedoLinear: profile.groundAlbedoLinear
            },
            summaryResult: `Computed diurnal lighting profile for elevation ${elevation.toFixed(1)}° (${profile.phase}, ${profile.kelvinTemperature}K, sun intensity ${profile.sunIntensity.toFixed(2)}).`
        };
    },

    atmosphere_configure_scene: (args, _ctx) => {
        let elevation = 45.0;
        let azimuth = 180.0;
        let timeOfDay = typeof args.timeOfDay === 'number' ? args.timeOfDay : 12.0;

        const preset = asString(args.preset);
        if (preset) {
            const presetState = getPresetLightingState(preset as any);
            if (presetState) {
                elevation = presetState.elevationDeg;
                azimuth = presetState.azimuthDeg;
            }
        } else if (typeof args.latitude === 'number' && typeof args.longitude === 'number') {
            const ephemeris = calculateNOAASolarPosition(new Date(), args.latitude, args.longitude);
            elevation = ephemeris.elevationDeg;
            azimuth = ephemeris.azimuthDeg;
        }

        const profile = computeDiurnalLightingProfile(elevation);
        const sunDir = getSunVectorFromAngles(elevation, azimuth);

        const config = {
            enabled: true,
            rayleigh: 2.0,
            mie: 0.005,
            turbidity: profile.turbidity,
            timeOfDay,
            sunElevation: elevation,
            sunAzimuth: azimuth,
            sunPosition: [sunDir.x * 100, sunDir.y * 100, sunDir.z * 100],
            kelvinTemperature: profile.kelvinTemperature,
            cloudCoverage: typeof args.cloudCoverage === 'number' ? args.cloudCoverage : 0.45,
            cloudDensity: 0.8,
            cloudAltitude: 120.0,
            volumetricClouds: true,
            aerialPerspectiveEnabled: args.enableAerialPerspective ?? true,
            inscatteringIntensity: 0.65,
            cloudShadowsEnabled: true,
            godRays: args.enableGodRays ? { enabled: true, intensity: 0.28 } : undefined
        };

        return {
            resultPayload: {
                success: true,
                config,
                phase: profile.phase,
                kelvinTemperature: profile.kelvinTemperature
            },
            summaryResult: `Synthesized atmospheric scene configuration: Phase ${profile.phase}, ${profile.kelvinTemperature}K, Sun Elevation ${elevation.toFixed(1)}°.`
        };
    },

    atmosphere_estimate_from_image: async (args, _ctx) => {
        const imagePath = asString(args.imagePath);
        const promptHint = asString(args.promptHint);
        const lat = typeof args.latitude === 'number' ? args.latitude : (args.latitude ? parseFloat(String(args.latitude)) : undefined);
        const lng = typeof args.longitude === 'number' ? args.longitude : (args.longitude ? parseFloat(String(args.longitude)) : undefined);
        const isoDate = asString(args.isoDate);
        const cameraHeadingDeg = typeof args.cameraHeadingDeg === 'number' ? args.cameraHeadingDeg : undefined;
        const cameraPitchDeg = typeof args.cameraPitchDeg === 'number' ? args.cameraPitchDeg : undefined;

        const result = await AtmosphereImageEstimationService.estimateFromImage({
            imagePath,
            promptHint,
            knownCoords: (lat !== undefined && lng !== undefined) ? { lat, lng } : undefined,
            timestampIso: isoDate,
            cameraHeadingDeg,
            cameraPitchDeg
        });

        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Estimated physical atmosphere matching image: Sun Elevation ${result.sunElevation}°, Azimuth ${result.sunAzimuth}°, ${result.kelvinTemperature}K (${result.diurnalPhase}), Turbidity ${result.turbidity}, Aerial Perspective Range ${result.aerialPerspectiveRange}m.`
        };
    },

    atmosphere_harmonize_location_3d: async (args, ctx) => {
        // Handled by geobox precision location lighting
        const { geoboxPrecisionHandlers } = await import('../tool-registry');
        return geoboxPrecisionHandlers.geobox_harmonize_location_lighting(args, ctx);
    }
};
