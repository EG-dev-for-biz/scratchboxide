/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    calculateNOAASolarPosition,
    classifyDiurnalPhase,
    computeDiurnalLightingProfile,
    getPresetLightingState,
    anglesToDirection,
    AtmosphereImageEstimationService,
    angstromBeta,
    directSunTransmittance,
    fitPlanckianKelvinTemperature
} from '../../../browser/generative-canvas/services/atmosphere';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

/** The date a tool was given; no current time is assumed for an ephemeris. */
function requireDate(tool: string, val: unknown): Date {
    const iso = asString(val);
    if (!iso) throw new MissingInputError(tool, 'isoDate', 'the sun position depends on the date and time, and none is assumed');
    const date = new Date(iso);
    if (isNaN(date.getTime())) throw new MissingInputError(tool, 'a valid isoDate', `'${iso}' is not an ISO 8601 date-time`);
    return date;
}

export const ATMOSPHERE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'atmosphere_calculate_solar_position',
        description: 'Calculate NOAA solar ephemeris (solar elevation, azimuth, distance AU, Julian day, and diurnal phase) for geographic coordinates at a given date/time.',
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
                    description: 'ISO 8601 date-time (e.g. "2026-06-21T18:30:00Z"). Required: the sun position depends on it, and no time is assumed.'
                }
            },
            required: ['latitude', 'longitude', 'isoDate']
        }
    },
    {
        name: 'atmosphere_get_diurnal_profile',
        description: 'Compute the diurnal lighting profile (phase, sun/ambient intensity, colour temperature) for a sun elevation. With turbidity, the direct-sun colour and its CCT come from the Preetham transmittance (Rayleigh + Angstrom aerosol) at that turbidity and air mass.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elevationDeg: {
                    type: 'NUMBER',
                    description: 'Sun elevation angle above the horizon in degrees (-90 to +90).'
                },
                turbidity: {
                    type: 'NUMBER',
                    description: 'Optional Preetham turbidity (about 1.7 clear to 12 hazy). Without it no turbidity is reported.'
                }
            },
            required: ['elevationDeg']
        }
    },
    {
        name: 'atmosphere_configure_scene',
        description: 'Builds an atmospheric scattering config for a 3D scene. The sun comes from sunElevationDeg/sunAzimuthDeg, a time-of-day preset, or NOAA ephemeris at latitude/longitude/isoDate. Clouds, cloud shadows, aerial perspective and god rays are included only when asked for; unspecified scattering parameters are left to the renderer.',
        parameters: {
            type: 'OBJECT',
            properties: {
                sunElevationDeg: { type: 'NUMBER', description: 'Sun elevation above the horizon in degrees (with sunAzimuthDeg).' },
                sunAzimuthDeg: { type: 'NUMBER', description: 'Sun azimuth in degrees clockwise from north (with sunElevationDeg).' },
                preset: {
                    type: 'STRING',
                    description: 'Diurnal preset: "dawn", "golden_hour", "midday", "afternoon", "sunset", "twilight", "blue_hour", "night", or "overcast".'
                },
                latitude: {
                    type: 'NUMBER',
                    description: 'Geographic latitude (with longitude and isoDate, the sun comes from NOAA ephemeris).'
                },
                longitude: {
                    type: 'NUMBER',
                    description: 'Geographic longitude.'
                },
                isoDate: {
                    type: 'STRING',
                    description: 'ISO 8601 date-time for the ephemeris. Required with latitude/longitude.'
                },
                turbidity: {
                    type: 'NUMBER',
                    description: 'Optional Preetham turbidity. Omitted means the renderer keeps its own.'
                },
                enableAerialPerspective: {
                    type: 'BOOLEAN',
                    description: 'Enable depth inscattering aerial perspective (off unless true).'
                },
                enableGodRays: {
                    type: 'BOOLEAN',
                    description: 'Enable volumetric sunbeams/god rays (off unless true).'
                },
                godRayIntensity: {
                    type: 'NUMBER',
                    description: 'Optional god-ray intensity when enableGodRays is true.'
                },
                cloudCoverage: {
                    type: 'NUMBER',
                    description: 'Cloud coverage fraction (0.0 to 1.0). Clouds are added only when this is given.'
                },
                cloudDensity: {
                    type: 'NUMBER',
                    description: 'Optional cloud density when cloudCoverage is given.'
                },
                cloudAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Optional cloud layer altitude in metres when cloudCoverage is given.'
                },
                enableCloudShadows: {
                    type: 'BOOLEAN',
                    description: 'Cast terrain cloud shadows (only with cloudCoverage, and only when true).'
                }
            }
        }
    },
    {
        name: 'atmosphere_estimate_from_image',
        description: 'Measures the atmosphere in a photograph: the sun (NOAA ephemeris when latitude, longitude and isoDate are given; otherwise a visible sun disc, otherwise a Preetham analytic sky fitted to the segmented sky pixels, else a sun_not_found error), Preetham turbidity with the derived Angstrom beta, direct-sun colour temperature and Koschmieder visibility, and the cloud fraction of the visible sky. Quantities the pixels do not determine are listed in unmeasured.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path or filename of the reference image.'
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
                    description: 'Camera pitch above the horizon in degrees. If omitted, a level camera is assumed and reported.'
                },
                hfovDeg: {
                    type: 'NUMBER',
                    description: 'Horizontal field of view in degrees. If omitted, 60 is assumed and reported.'
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

        const date = requireDate('atmosphere_calculate_solar_position', args.isoDate);
        const ephemeris = calculateNOAASolarPosition(date, lat, lng);
        const phase = classifyDiurnalPhase(ephemeris.elevationDeg);

        return {
            resultPayload: {
                success: true,
                latitude: lat,
                longitude: lng,
                isoDate: date.toISOString(),
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

        const profile = computeDiurnalLightingProfile(elevation);
        const turbidity = typeof args.turbidity === 'number' && Number.isFinite(args.turbidity) ? args.turbidity : undefined;
        if (turbidity !== undefined && (turbidity < 1 || turbidity > 64)) throw new Error(`atmosphere_get_diurnal_profile: turbidity ${turbidity} is outside the physical range (1 = pure Rayleigh).`);

        // With a turbidity, the direct sun is attenuated through that atmosphere (Preetham 1999 transmittance).
        let sunLinearRgb = profile.sunLinearRgb;
        let kelvinTemperature = profile.kelvinTemperature;
        let transmittance: [number, number, number] | undefined;
        if (turbidity !== undefined && elevation > 0) {
            transmittance = directSunTransmittance(turbidity, elevation);
            const m = Math.max(...transmittance);
            sunLinearRgb = [transmittance[0] / m, transmittance[1] / m, transmittance[2] / m];
            kelvinTemperature = fitPlanckianKelvinTemperature(transmittance[0], transmittance[1], transmittance[2]);
        }

        return {
            resultPayload: {
                success: true,
                elevationDeg: elevation,
                phase: profile.phase,
                kelvinTemperature,
                kelvinSource: transmittance ? 'preetham-transmittance' : 'diurnal-profile',
                sunIntensity: profile.sunIntensity,
                ambientIntensity: profile.ambientIntensity,
                shadowSoftness: profile.shadowSoftness,
                ...(turbidity !== undefined ? { turbidity, angstromBeta: angstromBeta(turbidity) } : {}),
                ...(transmittance ? { directSunTransmittance: transmittance } : {}),
                sunLinearRgb,
                ambientLinearRgb: profile.ambientLinearRgb,
                skyColorLinear: profile.skyColorLinear,
                groundAlbedoLinear: profile.groundAlbedoLinear
            },
            summaryResult: `Computed diurnal lighting profile for elevation ${elevation.toFixed(1)}° (${profile.phase}, ${kelvinTemperature}K${transmittance ? ` direct sun through turbidity ${turbidity}` : ''}, sun intensity ${profile.sunIntensity.toFixed(2)}).`
        };
    },

    atmosphere_configure_scene: (args, _ctx) => {
        const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        let elevation: number, azimuth: number, sunSource: string;
        const preset = asString(args.preset);
        const lat = num(args.latitude), lng = num(args.longitude);
        if (num(args.sunElevationDeg) !== undefined && num(args.sunAzimuthDeg) !== undefined) {
            elevation = num(args.sunElevationDeg)!;
            azimuth = num(args.sunAzimuthDeg)!;
            sunSource = 'given';
        } else if (lat !== undefined && lng !== undefined) {
            const date = requireDate('atmosphere_configure_scene', args.isoDate);
            const ephemeris = calculateNOAASolarPosition(date, lat, lng);
            elevation = ephemeris.elevationDeg;
            azimuth = ephemeris.azimuthDeg;
            sunSource = `NOAA ephemeris at ${date.toISOString()}`;
        } else if (preset) {
            const presetState = getPresetLightingState(preset);
            elevation = presetState.elevationDeg;
            azimuth = presetState.azimuthDeg;
            sunSource = `preset ${preset}`;
        } else {
            throw new MissingInputError('atmosphere_configure_scene', 'the sun', 'give sunElevationDeg and sunAzimuthDeg, a preset, or latitude, longitude and isoDate');
        }

        const profile = computeDiurnalLightingProfile(elevation);
        const sunDir = anglesToDirection(elevation, azimuth);

        // Opt-in layers only: clouds when a coverage is given, shadows/aerial perspective/god rays when asked for.
        const cloudCoverage = num(args.cloudCoverage);
        const clouds = cloudCoverage !== undefined && cloudCoverage > 0;
        const config: Record<string, unknown> = {
            enabled: true,
            sunElevation: elevation,
            sunAzimuth: azimuth,
            sunPosition: [sunDir[0] * 100, sunDir[1] * 100, sunDir[2] * 100],
            kelvinTemperature: profile.kelvinTemperature,
            volumetricClouds: clouds,
            cloudShadowsEnabled: clouds && args.enableCloudShadows === true,
            aerialPerspectiveEnabled: args.enableAerialPerspective === true
        };
        if (num(args.turbidity) !== undefined) config.turbidity = num(args.turbidity);
        if (lat !== undefined && lng !== undefined) { config.latitude = lat; config.longitude = lng; }
        if (clouds) {
            config.cloudCoverage = cloudCoverage;
            if (num(args.cloudDensity) !== undefined) config.cloudDensity = num(args.cloudDensity);
            if (num(args.cloudAltitudeMeters) !== undefined) config.cloudAltitude = num(args.cloudAltitudeMeters);
        }
        if (args.enableGodRays === true) {
            config.godRays = num(args.godRayIntensity) !== undefined ? { enabled: true, intensity: num(args.godRayIntensity) } : { enabled: true };
        }

        const layers = [clouds ? `clouds ${cloudCoverage}` : undefined, config.cloudShadowsEnabled ? 'cloud shadows' : undefined, config.aerialPerspectiveEnabled ? 'aerial perspective' : undefined, config.godRays ? 'god rays' : undefined].filter(Boolean);
        return {
            resultPayload: {
                success: true,
                config,
                sunSource,
                phase: profile.phase,
                kelvinTemperature: profile.kelvinTemperature
            },
            summaryResult: `Synthesized atmospheric scene configuration: Phase ${profile.phase}, ${profile.kelvinTemperature}K, Sun Elevation ${elevation.toFixed(1)}° (${sunSource})${layers.length ? `, with ${layers.join(', ')}` : ', no optional layers'}.`
        };
    },

    atmosphere_estimate_from_image: async (args, _ctx) => {
        const imagePath = asString(args.imagePath);
        const lat = typeof args.latitude === 'number' ? args.latitude : (args.latitude ? parseFloat(String(args.latitude)) : undefined);
        const lng = typeof args.longitude === 'number' ? args.longitude : (args.longitude ? parseFloat(String(args.longitude)) : undefined);
        const isoDate = asString(args.isoDate);
        const cameraHeadingDeg = typeof args.cameraHeadingDeg === 'number' ? args.cameraHeadingDeg : undefined;
        const cameraPitchDeg = typeof args.cameraPitchDeg === 'number' ? args.cameraPitchDeg : undefined;
        const hfovDeg = typeof args.hfovDeg === 'number' ? args.hfovDeg : undefined;

        // The photo's own pixels: decoded here (a missing or undecodable file is an error, never a guessed sky).
        if (!imagePath) throw new MissingInputError('atmosphere_estimate_from_image', 'imagePath', 'give the photograph to estimate the atmosphere from');
        const fsMod = await import('fs-extra');
        if (!(await fsMod.pathExists(imagePath))) throw new MissingInputError('atmosphere_estimate_from_image', 'imagePath', `${imagePath} does not exist`);
        const { decodeImageToRgba } = await import('../../image-codec-ffmpeg');
        const { downsampleRgba } = await import('../../spatial/InverseLightingEstimatorService');
        const decoded = await decodeImageToRgba(await fsMod.readFile(imagePath));
        const sampled = downsampleRgba(decoded.rgba, decoded.width, decoded.height, 512);
        const result = await AtmosphereImageEstimationService.estimateFromImage({
            imagePath,
            pixels: sampled.pixels,
            width: sampled.width,
            height: sampled.height,
            knownCoords: (lat !== undefined && lng !== undefined) ? { lat, lng } : undefined,
            timestampIso: isoDate || undefined,
            cameraHeadingDeg,
            cameraPitchDeg,
            hfovDeg
        });

        const parts = [
            `Sun Elevation ${result.sunElevation}°, Azimuth ${result.sunAzimuth}° (${result.azimuthReference}, from ${result.sunSource}${result.confidence !== undefined ? `, confidence ${result.confidence}` : ''}), ${result.diurnalPhase}`,
            result.kelvinTemperature !== undefined ? `direct sun ${result.kelvinTemperature}K` : undefined,
            result.turbidity !== undefined ? `Turbidity ${result.turbidity}` : undefined,
            result.aerialPerspectiveRange !== undefined ? `visibility ${result.aerialPerspectiveRange}m` : undefined,
            result.cloudCoverage !== undefined ? `cloud fraction ${result.cloudCoverage}` : undefined
        ].filter(Boolean);
        const notMeasured = Object.keys(result.unmeasured);
        return {
            resultPayload: result as unknown as Record<string, unknown>,
            summaryResult: `Estimated physical atmosphere matching image: ${parts.join(', ')}.${notMeasured.length ? ` Not measured: ${notMeasured.join(', ')}.` : ''}${result.assumptions.length ? ` Assumed: ${result.assumptions.join('; ')}.` : ''}`
        };
    },

    atmosphere_harmonize_location_3d: async (args, ctx) => {
        // Handled by geobox precision location lighting
        const { geoboxPrecisionHandlers } = await import('../tool-registry');
        return geoboxPrecisionHandlers.geobox_harmonize_location_lighting(args, ctx);
    }
};
