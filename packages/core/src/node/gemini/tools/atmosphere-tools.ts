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
    resolveCloudShellLayers
} from '../../../browser/generative-canvas/services/atmosphere';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import type { ToolDeclaration, ToolHandler } from './types';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { DirectDispatchOperatorEngine } from '../../../browser/generative-canvas/services/direct-dispatch-operator-engine';

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

/** How far the sun's shadow camera reaches around the scene's centre when nothing else sizes it: the camera's distance to its target, halved. */
function shadowRadiusFor(data: Scene3DData): number {
    const cam = data.camera as { position?: number[]; target?: number[] } | undefined;
    const p = cam?.position, t = cam?.target ?? [0, 0, 0];
    const d = Array.isArray(p) && p.length === 3 ? Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]) : 0;
    return Math.max(20, Math.min(2000, d > 0 ? d * 0.5 : 60));
}

/**
 * The sun written into a 3D scene through its atmosphere operators (sb_set_diurnal_time_of_day, then the optional layers),
 * with what the viewport needs to draw it: the colour temperature and the shadow extent. The scene keeps its render mode;
 * a clay scene draws the sun and sky because the sun is set explicitly (syncAtmosphere's explicit-sun opt-in).
 */
export function applySunToScene(
    active: CanvasArtifact,
    s: { elevation: number; azimuth: number; lat?: number; lng?: number; isoDate?: string; sunSource: string; config: Record<string, unknown>; clouds: boolean; args: Record<string, unknown> }
): { ok: true; artifact: CanvasArtifact; operators: string[]; shadowRadiusM: number } | { ok: false; error: string } {
    const engine = new DirectDispatchOperatorEngine(JSON.parse(JSON.stringify(active.data)) as Scene3DData);
    const commands: Array<{ operator: string; params: Record<string, unknown> }> = [
        { operator: 'sb_set_diurnal_time_of_day', params: { sunElevation: s.elevation, sunAzimuth: s.azimuth, ...(s.lat !== undefined && s.lng !== undefined ? { latitude: s.lat, longitude: s.lng } : {}) } }
    ];
    const scattering: Record<string, unknown> = { enabled: true, volumetricClouds: s.clouds };
    for (const k of ['turbidity', 'cloudCoverage', 'cloudDensity', 'cloudAltitude', 'cloudLayers'] as const) if (s.config[k] !== undefined) scattering[k] = s.config[k];
    commands.push({ operator: 'sb_configure_atmospheric_scattering', params: scattering });
    if (s.config.aerialPerspectiveEnabled === true) commands.push({ operator: 'sb_configure_aerial_perspective', params: { enabled: true } });
    if (s.config.cloudShadowsEnabled === true) commands.push({ operator: 'sb_configure_terrain_cloud_shadows', params: { enabled: true } });
    if (s.config.godRays) commands.push({ operator: 'sb_add_volumetric_god_rays', params: { enabled: true, ...(typeof (s.config.godRays as { intensity?: number }).intensity === 'number' ? { intensity: (s.config.godRays as { intensity: number }).intensity } : {}) } });
    const batch = engine.executeBatch(commands, { atomic: true });
    if (!batch.success) return { ok: false, error: batch.results.filter(r => !r.success).map(r => r.error).filter(Boolean).join('; ') || 'the atmosphere operators failed' };
    const data = engine.getSceneData();
    const shadowRadiusM = shadowRadiusFor(data);
    const atm = (typeof data.features?.atmosphericScattering === 'object' && data.features.atmosphericScattering) ? data.features.atmosphericScattering as Record<string, unknown> : {};
    data.features = {
        ...(data.features ?? {}),
        atmosphericScattering: {
            ...atm,
            sunSource: s.sunSource,
            ...(s.isoDate ? { isoDate: s.isoDate } : {}),
            sunShadowRadiusMeters: shadowRadiusM
        } as never
    };
    const artifact = {
        ...active,
        data,
        summary: `Sun applied: elevation ${s.elevation.toFixed(1)}°, azimuth ${s.azimuth.toFixed(1)}° (${s.sunSource}).`,
        version: ((active as { version?: number }).version || 1) + 1
    } as CanvasArtifact;
    return { ok: true, artifact, operators: commands.map(c => c.operator), shadowRadiusM };
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
        description: 'Compute the diurnal lighting profile (phase, sun/ambient intensity, colour temperature) for a sun elevation. While the sun is up, the direct-sun colour, its CCT and its illuminance (lux) come from the full visible spectrum: a blackbody sun through Rayleigh, Angstrom aerosol (at the given turbidity, else the diurnal one) and ozone, integrated over the CIE 1931 observer.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elevationDeg: {
                    type: 'NUMBER',
                    description: 'Sun elevation angle above the horizon in degrees (-90 to +90).'
                },
                turbidity: {
                    type: 'NUMBER',
                    description: 'Optional Preetham turbidity (about 1.7 clear to 12 hazy). Without it the diurnal turbidity for that elevation is used.'
                },
                observerAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Optional observer height above sea level in metres; thinner air above a mountain or aircraft gives a whiter, brighter sun.'
                }
            },
            required: ['elevationDeg']
        }
    },
    {
        name: 'atmosphere_configure_scene',
        description: 'Lights the open 3D scene with a real sun: a directional sun at the computed position casting shadows, the physical sky dome and its hemisphere ambient, replacing the studio rig (the result says applied: true and returns the updated scene; with no 3D scene open it says NOT applied and changes nothing). The sun comes from sunElevationDeg/sunAzimuthDeg, a time-of-day preset, or NOAA ephemeris at latitude/longitude/isoDate. Clouds, cloud shadows, aerial perspective and god rays are included only when asked for; unspecified scattering parameters are left to the renderer.',
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
                },
                cloudLayers: {
                    type: 'ARRAY',
                    description: 'Optional thin cloud decks (up to 4) drawn as stacked Earth-curved shells behind the volumetric layer: cheap, and they converge on the horizon. Describe each deck physically: cirrus is high (6-12 km), thin (opticalDepth 0.05-1), streaky (streakElongation 4-12); an altostratus sheet is mid-level (2-6 km), dense (opticalDepth 3-15) and near-complete coverage; smoke or dust uses a scatteringAlbedo below 1. Added only when given.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            label: { type: 'STRING', description: 'Name for reports only.' },
                            baseAltitudeMeters: { type: 'NUMBER', description: 'Deck base above the ground, metres.' },
                            thicknessMeters: { type: 'NUMBER', description: 'Vertical depth of the deck, metres (0 = one sheet).' },
                            coverage: { type: 'NUMBER', description: 'Fraction of sky covered, 0-1.' },
                            opticalDepth: { type: 'NUMBER', description: 'Vertical optical depth of a covered column.' },
                            featureSizeMeters: { type: 'NUMBER', description: 'Horizontal size of cells or streaks, metres.' },
                            streakElongation: { type: 'NUMBER', description: 'Length/width of features along the heading (1 = round).' },
                            streakHeadingDeg: { type: 'NUMBER', description: 'Streak direction, degrees clockwise from north.' },
                            forwardScattering: { type: 'NUMBER', description: 'Henyey-Greenstein g (ice ~0.75, water ~0.85).' },
                            scatteringAlbedo: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Linear [r, g, b] single-scattering albedo, default [1, 1, 1].' },
                            shellCount: { type: 'NUMBER', description: 'Stacked shells 1-8 (default one per ~400 m).' },
                            windSpeedMetersPerSecond: { type: 'NUMBER', description: 'Drift along the heading, m/s.' }
                        },
                        required: ['baseAltitudeMeters', 'thicknessMeters', 'coverage', 'opticalDepth', 'featureSizeMeters']
                    }
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
        description: 'Computes photogrammetric de-lighting shader uniforms (shadow lift, highlight compression, stone albedo, sky irradiance, ground bounce, terrain de-wash), scene lighting with the key light at the NOAA sun for the place and isoDate, and a sky gradient for a 3D location mesh. Window/portal backlighting is added only for portals the caller locates on the model.',
        parameters: {
            type: 'OBJECT',
            properties: {
                landmarkName: { type: 'STRING', description: 'Place name, resolved with Google Places when latitude/longitude are not given (e.g. "Colosseum, Rome")' },
                preset: {
                    type: 'STRING',
                    description: 'Look preset: "civil_twilight_dusk", "golden_hour", "midday_clear", "blue_hour", "night_monumental". Chosen from the computed sun elevation when omitted.'
                },
                latitude: { type: 'NUMBER', description: 'Geographic latitude' },
                longitude: { type: 'NUMBER', description: 'Geographic longitude' },
                isoDate: { type: 'STRING', description: 'ISO 8601 instant the sun is computed for (required; no date is assumed)' },
                stoneType: {
                    type: 'STRING',
                    description: 'Stone albedo profile: "travertine", "limestone", "sandstone", "granite", "terracotta", "marble", "concrete"'
                },
                portals: {
                    type: 'ARRAY',
                    description: 'Window/portal openings located on the model, in scene metres (Y up, -Z north). A backlighting spot is placed behind each one; with none given, no backlighting is added. Unset kelvinTemperature/intensity/distance/decay/angle/penumbra use a 2850 K incandescent fixture and are reported in portalDefaultsApplied.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            position: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Light position [x, y, z] behind the opening' },
                            targetPosition: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Point [x, y, z] outside the opening the light aims at' },
                            name: { type: 'STRING' },
                            kelvinTemperature: { type: 'NUMBER' },
                            intensity: { type: 'NUMBER' },
                            distance: { type: 'NUMBER' },
                            decay: { type: 'NUMBER' },
                            angle: { type: 'NUMBER' },
                            penumbra: { type: 'NUMBER' }
                        },
                        required: ['position', 'targetPosition']
                    }
                },
                customDelightParams: {
                    type: 'OBJECT',
                    description: 'Custom override parameters for de-lighting uniforms'
                }
            },
            required: ['isoDate']
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

        const turbidity = typeof args.turbidity === 'number' && Number.isFinite(args.turbidity) ? args.turbidity : undefined;
        if (turbidity !== undefined && (turbidity < 1 || turbidity > 64)) throw new Error(`atmosphere_get_diurnal_profile: turbidity ${turbidity} is outside the physical range (1 = pure Rayleigh).`);
        const observerAltitudeMeters = typeof args.observerAltitudeMeters === 'number' && Number.isFinite(args.observerAltitudeMeters) ? args.observerAltitudeMeters : undefined;

        // While the disc is up the direct sun is the spectral beam: a blackbody sun through Rayleigh, aerosol (at this
        // turbidity, or the profile's diurnal one) and ozone, integrated over the CIE observer.
        const profile = computeDiurnalLightingProfile(elevation, { turbidity, observerAltitudeMeters });
        const spectral = profile.sunIlluminanceLux !== undefined;
        const sunLinearRgb = profile.sunLinearRgb;
        const kelvinTemperature = profile.kelvinTemperature;
        const transmittance = turbidity !== undefined && elevation > 0 ? directSunTransmittance(turbidity, elevation) : undefined;

        return {
            resultPayload: {
                success: true,
                elevationDeg: elevation,
                phase: profile.phase,
                kelvinTemperature,
                kelvinSource: spectral ? 'spectral-beam' : 'diurnal-profile',
                ...(spectral ? { sunIlluminanceLux: Math.round(profile.sunIlluminanceLux!), turbidityUsed: profile.turbidity } : {}),
                ...(observerAltitudeMeters !== undefined ? { observerAltitudeMeters } : {}),
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
            summaryResult: `Computed diurnal lighting profile for elevation ${elevation.toFixed(1)}° (${profile.phase}, ${kelvinTemperature}K${spectral ? ` spectral direct sun through turbidity ${profile.turbidity}, ${Math.round(profile.sunIlluminanceLux!)} lx` : ''}, sun intensity ${profile.sunIntensity.toFixed(2)}).`
        };
    },

    atmosphere_configure_scene: (args, ctx) => {
        const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        let elevation: number, azimuth: number, sunSource: string;
        let isoDate: string | undefined;
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
            isoDate = date.toISOString();
            sunSource = `NOAA ephemeris at ${isoDate}`;
        } else if (preset) {
            const presetState = getPresetLightingState(preset);
            elevation = presetState.elevationDeg;
            azimuth = presetState.azimuthDeg;
            sunSource = `preset ${preset}`;
        } else {
            throw new MissingInputError('atmosphere_configure_scene', 'the sun', 'give sunElevationDeg and sunAzimuthDeg, a preset, or latitude, longitude and isoDate');
        }

        const profile = computeDiurnalLightingProfile(elevation, { turbidity: num(args.turbidity) });
        const sunDir = anglesToDirection(elevation, azimuth);

        // Opt-in layers only: clouds when a coverage is given, shadows/aerial perspective/god rays when asked for.
        const cloudCoverage = num(args.cloudCoverage);
        const clouds = cloudCoverage !== undefined && cloudCoverage > 0;
        const config: Record<string, unknown> = {
            enabled: true,
            sunElevation: elevation,
            sunAzimuth: azimuth,
            sunPosition: [sunDir[0] * 100, sunDir[1] * 100, sunDir[2] * 100],
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
        if (args.cloudLayers !== undefined) {
            // Checked here so a bad deck fails the call with the field named, before anything is applied.
            resolveCloudShellLayers(args.cloudLayers, 'atmosphere_configure_scene');
            config.cloudLayers = args.cloudLayers;
        }
        if (args.enableGodRays === true) {
            config.godRays = num(args.godRayIntensity) !== undefined ? { enabled: true, intensity: num(args.godRayIntensity) } : { enabled: true };
        }
        const shellDecks = Array.isArray(config.cloudLayers) ? (config.cloudLayers as Array<{ label?: string }>) : [];
        const layers = [clouds ? `clouds ${cloudCoverage}` : undefined, shellDecks.length ? `${shellDecks.length} shell cloud deck${shellDecks.length > 1 ? 's' : ''}${shellDecks.some(d => d.label) ? ` (${shellDecks.map(d => d.label ?? 'unnamed').join(', ')})` : ''}` : undefined, config.cloudShadowsEnabled ? 'cloud shadows' : undefined, config.aerialPerspectiveEnabled ? 'aerial perspective' : undefined, config.godRays ? 'god rays' : undefined].filter(Boolean);
        const sunText = `sun elevation ${elevation.toFixed(1)}°, azimuth ${azimuth.toFixed(1)}° (${sunSource}), ${profile.phase}, ${profile.kelvinTemperature} K`;

        // Applied to the open 3D scene through the scene's own atmosphere operators, so the viewport draws it: a directional
        // sun at the computed position casting shadows, the sky dome and hemisphere ambient of the diurnal profile.
        const active = ctx?.request?.activeArtifact;
        if (!active || active.type !== '3d-scene' || !active.data) {
            const why = 'no 3D scene is open, so nothing was lit';
            return {
                status: 'failed',
                resultPayload: { success: false, applied: false, notApplied: why, config, sunSource, phase: profile.phase, kelvinTemperature: profile.kelvinTemperature },
                summaryResult: `NOT applied: ${why}. Computed only: ${sunText}${layers.length ? `, with ${layers.join(', ')}` : ''}. Nothing in any viewport changed.`
            };
        }
        // No kelvinTemperature is written: the viewport colours the sun from the same spectral beam (a stored Kelvin is an override).
        const applied = applySunToScene(active, { elevation, azimuth, lat, lng, isoDate, sunSource, config, clouds, args });
        if (!applied.ok) {
            return {
                status: 'failed',
                resultPayload: { success: false, applied: false, notApplied: applied.error, config, sunSource, phase: profile.phase, kelvinTemperature: profile.kelvinTemperature },
                summaryResult: `NOT applied to "${active.title || active.id}": ${applied.error}. Computed only: ${sunText}.`
            };
        }
        const shadows = profile.castShadows
            ? `a directional sun casting shadows over ${Math.round(applied.shadowRadiusM)} m around the scene's centre`
            : 'a directional sun without shadows (it is at or below the horizon)';
        return {
            resultPayload: {
                success: true,
                applied: true,
                appliedTo: applied.artifact.id,
                operators: applied.operators,
                config,
                sunSource,
                phase: profile.phase,
                kelvinTemperature: profile.kelvinTemperature,
                castShadows: profile.castShadows,
                shadowRadiusMeters: applied.shadowRadiusM,
                artifact: applied.artifact
            },
            summaryResult: `Applied to the active 3D scene "${active.title || active.id}": ${sunText}; ${shadows}, the physical sky dome and the hemisphere ambient of that sun${layers.length ? `, with ${layers.join(', ')}` : ', no optional layers'}. The studio light rig is replaced by this sun.`
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
