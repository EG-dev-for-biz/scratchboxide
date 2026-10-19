/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { OperatorDefinition } from './types';
import {
    getPresetLightingState,
    calculateNOAASolarPosition,
    computeDiurnalLightingProfile,
    getSunVectorFromAngles
} from '../atmosphere';
import {
    SbTerrainGroundEngine,
    type SlopeMaterialStop
} from '../spatial/SbTerrainGroundEngine';
import { findViewportMeshes } from './mesh-edit-operators';
import { instantAtLocalMeanSolarTime } from '../../../../common/coordinate/solarPosition';
import { measureGlbBase64MeshCounts } from '../../../../common/glb-mesh-counts';

/**
 * NOAA sun position at `timeOfDay` hours of local mean solar time (UTC + longitude / 15) on the UTC day of
 * `isoDate` (today when omitted) at the given location.
 */
export function sunAtLocalSolarTime(latitude: number, longitude: number, timeOfDay: number, isoDate?: string): { elevationDeg: number; azimuthDeg: number } {
    const day = isoDate ? new Date(isoDate) : new Date();
    const instant = instantAtLocalMeanSolarTime(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), timeOfDay, longitude);
    const sol = calculateNOAASolarPosition(instant, latitude, longitude);
    return { elevationDeg: sol.elevationDeg, azimuthDeg: sol.azimuthDeg };
}

export const NATURE_ATMOSPHERE_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_configure_atmospheric_scattering',
        category: 'nature_atmosphere',
        description: 'Configures Rayleigh/Mie physical atmospheric scattering, turbidity, and 3D volumetric raymarched cloud layers.',
        execute: (ctx, params: {
            enabled?: boolean;
            rayleigh?: number;
            mie?: number;
            turbidity?: number;
            mieDirectionalG?: number;
            cloudCoverage?: number;
            cloudDensity?: number;
            cloudAltitude?: number;
            volumetricClouds?: boolean;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            const updatedAtm: any = {
                ...currentAtm,
                enabled: params.enabled !== undefined ? params.enabled : (currentAtm.enabled ?? true)
            };

            if (params.rayleigh !== undefined) updatedAtm.rayleigh = params.rayleigh;
            if (params.mie !== undefined) updatedAtm.mie = params.mie;
            if (params.turbidity !== undefined) updatedAtm.turbidity = params.turbidity;
            if (params.mieDirectionalG !== undefined) updatedAtm.mieDirectionalG = params.mieDirectionalG;
            if (params.cloudCoverage !== undefined) updatedAtm.cloudCoverage = params.cloudCoverage;
            if (params.cloudDensity !== undefined) updatedAtm.cloudDensity = params.cloudDensity;
            if (params.cloudAltitude !== undefined) updatedAtm.cloudAltitude = params.cloudAltitude;
            if (params.volumetricClouds !== undefined) updatedAtm.volumetricClouds = params.volumetricClouds;

            scene.features.atmosphericScattering = updatedAtm;


            return {
                success: true,
                atmosphericScattering: updatedAtm
            };
        }
    },
    {
        name: 'sb_set_diurnal_time_of_day',
        category: 'nature_atmosphere',
        description: 'Sets diurnal time of day (0.0-24.0h), NOAA geographic coordinates, or diurnal presets (golden_hour, sunset, midday, blue_hour, night), automatically recomputing sun elevation and photometric profile.',
        execute: (ctx, params: {
            timeOfDay?: number;
            preset?: string;
            latitude?: number;
            longitude?: number;
            isoDate?: string;
            sunElevation?: number;
            sunAzimuth?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            let elevation: number | undefined = params.sunElevation;
            let azimuth: number | undefined = params.sunAzimuth;
            const latitude = params.latitude ?? currentAtm.latitude ?? scene.geoAnchor?.lat;
            const longitude = params.longitude ?? currentAtm.longitude ?? scene.geoAnchor?.lng;
            const timeOfDay: number | undefined = params.timeOfDay;
            if (timeOfDay !== undefined && (params.preset || params.sunElevation !== undefined)) {
                throw new Error(`sb_set_diurnal_time_of_day: timeOfDay ${timeOfDay} and ${params.preset ? `preset '${params.preset}'` : 'sunElevation'} are two different suns; give one.`);
            }

            if (params.preset) {
                const presetState = getPresetLightingState(params.preset); // InvalidInputError for an unknown preset
                elevation = presetState.elevationDeg;
                azimuth = presetState.azimuthDeg;
            } else if (elevation === undefined && latitude !== undefined && longitude !== undefined && (params.isoDate || timeOfDay !== undefined)) {
                // isoDate alone is an instant; with timeOfDay it names the day and timeOfDay is local mean solar time.
                const ephemeris = timeOfDay !== undefined
                    ? sunAtLocalSolarTime(latitude, longitude, timeOfDay, params.isoDate)
                    : calculateNOAASolarPosition(new Date(params.isoDate!), latitude, longitude);
                elevation = ephemeris.elevationDeg;
                azimuth = ephemeris.azimuthDeg;
            }
            if (elevation === undefined) {
                throw new Error('sb_set_diurnal_time_of_day needs sunElevation, a preset, or a location (latitude/longitude, or the scene geoAnchor) with isoDate or timeOfDay: the sun position cannot be derived from a time alone.');
            }
            if (azimuth === undefined) azimuth = currentAtm.sunAzimuth ?? 180.0;

            const diurnalProfile = computeDiurnalLightingProfile(elevation, { turbidity: currentAtm.turbidity });
            const sunDir = getSunVectorFromAngles(elevation, azimuth);

            const updatedAtm: any = {
                ...currentAtm,
                enabled: currentAtm.enabled ?? true,
                // Only a time that placed this sun is recorded; an earlier one would now be stale.
                timeOfDay,
                sunElevation: elevation,
                sunAzimuth: azimuth,
                sunPosition: [sunDir.x * 100, sunDir.y * 100, sunDir.z * 100],
                latitude,
                longitude
            };

            scene.features.atmosphericScattering = updatedAtm;


            return {
                success: true,
                timeOfDay,
                elevation,
                azimuth,
                phase: diurnalProfile.phase,
                diurnalProfile,
                sunPosition: updatedAtm.sunPosition
            };
        }
    },
    {
        name: 'sb_configure_aerial_perspective',
        category: 'nature_atmosphere',
        description: 'Configures full-screen aerial perspective depth inscattering and Beer-Lambert extinction post-processing.',
        execute: (ctx, params: {
            enabled?: boolean;
            inscatteringIntensity?: number;
            aerialPerspectiveRange?: number;
            fogDensity?: number;
            albedoScale?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            // Only the values given are written; the viewport's own defaults fill the rest.
            const updatedAtm: any = { ...currentAtm, aerialPerspectiveEnabled: params.enabled !== false };
            if (params.inscatteringIntensity !== undefined) updatedAtm.inscatteringIntensity = params.inscatteringIntensity;
            if (params.aerialPerspectiveRange !== undefined) updatedAtm.aerialPerspectiveRange = params.aerialPerspectiveRange;
            if (params.fogDensity !== undefined) updatedAtm.fogDensity = params.fogDensity;
            if (params.albedoScale !== undefined) updatedAtm.albedoScale = params.albedoScale;

            scene.features.atmosphericScattering = updatedAtm;


            return {
                success: true,
                aerialPerspective: {
                    enabled: updatedAtm.aerialPerspectiveEnabled,
                    inscatteringIntensity: updatedAtm.inscatteringIntensity,
                    aerialPerspectiveRange: updatedAtm.aerialPerspectiveRange,
                    fogDensity: updatedAtm.fogDensity
                }
            };
        }
    },
    {
        name: 'sb_configure_terrain_cloud_shadows',
        category: 'nature_atmosphere',
        description: 'Configures moving procedural fBm terrain cloud shadow projections and atmospheric attenuation.',
        execute: (ctx, params: {
            enabled?: boolean;
            cloudShadowIntensity?: number;
            cloudShadowScale?: number;
            atmosphereShadowLength?: number;
            windVector?: [number, number];
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            // Only the values given are written; the viewport's own defaults fill the rest.
            const updatedAtm: any = { ...currentAtm, cloudShadowsEnabled: params.enabled !== false };
            if (params.cloudShadowIntensity !== undefined) updatedAtm.cloudShadowIntensity = params.cloudShadowIntensity;
            if (params.cloudShadowScale !== undefined) updatedAtm.cloudShadowScale = params.cloudShadowScale;
            if (params.atmosphereShadowLength !== undefined) updatedAtm.atmosphereShadowLength = params.atmosphereShadowLength;
            if (params.windVector !== undefined) updatedAtm.windVector = params.windVector;

            scene.features.atmosphericScattering = updatedAtm;


            return {
                success: true,
                cloudShadows: {
                    enabled: updatedAtm.cloudShadowsEnabled,
                    cloudShadowIntensity: updatedAtm.cloudShadowIntensity,
                    cloudShadowScale: updatedAtm.cloudShadowScale,
                    windVector: updatedAtm.windVector
                }
            };
        }
    },
    {
        name: 'sb_add_volumetric_god_rays',
        category: 'nature_atmosphere',
        description: 'Deploys view-dependent volumetric sunbeams and god ray light shafts with atmospheric shimmer.',
        execute: (ctx, params: {
            enabled?: boolean;
            intensity?: number;
            color?: string | number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const enabled = params.enabled !== false;
            const intensity = params.intensity ?? 0.28;
            const color = params.color ?? '#fffae0';

            scene.features.godRays = {
                enabled,
                intensity,
                color
            };



            return {
                success: true,
                godRays: scene.features.godRays
            };
        }
    },
    {
        name: 'sb_apply_slope_materials',
        category: 'materials_pbr',
        description: 'Gives the terrain mesh(es) named by targetMeshId in the live viewport a PBR material by their slope, measured in scene space (+Y up) through each mesh\'s whole parent chain: stops is a ramp of { slopeDeg, color: [r, g, b] sRGB 0..1, roughness 0..1, metalness 0..1 } that you choose for this ground, interpolated linearly between stops. Each mesh keeps its place, geometry and transform; the result reports its measured slope and the material it got. Fails when the mesh is not in the scene or the ramp is invalid; it never picks meshes by name keywords or builds demo terrain.',
        execute: (ctx, params: {
            targetMeshId?: string;
            stops?: SlopeMaterialStop[];
        }) => {
            // The terrain is the mesh(es) the caller names in the live viewport; nothing is picked by name keywords
            // and no demo planes are built when none is found.
            const meshes = findViewportMeshes(ctx.getThreeScene(), params.targetMeshId, 'sb_apply_slope_materials');
            const result = new SbTerrainGroundEngine().applySlopeMaterials(meshes, { stops: params.stops as SlopeMaterialStop[] });


            return {
                success: true,
                targetMeshId: params.targetMeshId,
                meshes: result.meshes
            };
        }
    },
    {
        name: 'sb_set_cpp_generator',
        category: 'state_history',
        description: 'Sets or updates the native C++20 procedural generator module for the 3D scene (C/C++ first directive).',
        execute: (ctx, params: { sourceCode: string; filename?: string; enabled?: boolean; glbBase64?: string; glbPath?: string }) => {
            if (!params.sourceCode) throw new Error("Parameter 'sourceCode' is required.");
            const scene = ctx.getSceneData();
            // Vertex/triangle counts are measured from the GLB bytes when they are here; caller-supplied counts are
            // not stored, and with no GLB (or bytes that are not one) there are none.
            const counts = params.glbBase64 ? measureGlbBase64MeshCounts(params.glbBase64) : undefined;
            scene.cppGenerator = {
                enabled: params.enabled !== false,
                sourceCode: params.sourceCode,
                filename: params.filename || 'world_generator.cpp',
                ...(counts ? { vertexCount: counts.vertexCount, triangleCount: counts.triangleCount } : {}),
                glbBase64: params.glbBase64,
                ...(params.glbPath ? { glbPath: params.glbPath } : {}),
                lastCompiledTimeMs: Date.now()
            };
            return { success: true, cppGenerator: scene.cppGenerator };
        }
    }
];
