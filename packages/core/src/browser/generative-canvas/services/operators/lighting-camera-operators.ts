/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { OperatorDefinition } from './types';
import {
    getPresetLightingState,
    getDiurnalLightingState,
    computeDiurnalLightingProfile,
    getSunVectorFromAngles
} from '../atmosphere';

export const LIGHTING_CAMERA_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_setup_lighting',
        category: 'lighting_camera',
        description: 'Configures scene lighting presets, atmospheric scattering, diurnal time-of-day, or custom key/fill/rim rigs.',
        execute: (ctx, params: {
            preset?: string;
            timeOfDay?: number;
            latitude?: number;
            longitude?: number;
            sunElevation?: number;
            sunAzimuth?: number;
            ambientIntensity?: number;
            skybox?: string;
            rayleigh?: number;
            mie?: number;
            turbidity?: number;
            mieDirectionalG?: number;
            kelvinTemperature?: number;
            cloudCoverage?: number;
            cloudDensity?: number;
            cloudAltitude?: number;
            volumetricClouds?: boolean;
            enableAtmosphere?: boolean;
            atmosphericScattering?: boolean;
            inscatteringIntensity?: number;
            aerialPerspectiveRange?: number;
            albedoScale?: number;
            fogDensity?: number;
            fogBaseAltitude?: number;
            fogHeight?: number;
            cloudShadowsEnabled?: boolean;
            cloudShadowIntensity?: number;
            cloudShadowScale?: number;
            atmosphereShadowLength?: number;
            windVector?: [number, number];
            godRays?: boolean;
            enableGodRays?: boolean;
            godRaysIntensity?: number;
            keyLight?: any;
            fillLight?: any;
            rimLight?: any;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.environment) scene.environment = {};
            if (!scene.features) scene.features = {};

            const preset = params.preset || scene.environment.lighting || 'studio';
            scene.environment.lighting = preset;
            scene.environment.lightingPreset = preset;

            let diurnalState: any = null;
            if (params.timeOfDay !== undefined) {
                const lat = params.latitude !== undefined ? params.latitude : (scene.environment.latitude || 37.77);
                const lng = params.longitude !== undefined ? params.longitude : (scene.environment.longitude || -122.41);
                diurnalState = getDiurnalLightingState(lat, lng, params.timeOfDay);
                scene.environment.timeOfDay = params.timeOfDay;
                scene.environment.latitude = lat;
                scene.environment.longitude = lng;
                scene.environment.sunElevation = diurnalState.sunElevation;
                scene.environment.sunAzimuth = diurnalState.sunAzimuth;
            } else if (params.sunElevation !== undefined || params.sunAzimuth !== undefined) {
                const elev = params.sunElevation !== undefined ? params.sunElevation : 45.0;
                const azim = params.sunAzimuth !== undefined ? params.sunAzimuth : 180.0;
                diurnalState = { ...computeDiurnalLightingProfile(elev), sunElevation: elev, sunAzimuth: azim };
                scene.environment.sunElevation = elev;
                scene.environment.sunAzimuth = azim;
            } else {
                diurnalState = getPresetLightingState(preset);
                scene.environment.sunElevation = diurnalState.elevationDeg;
                scene.environment.sunAzimuth = diurnalState.azimuthDeg;
                const isDiurnalPreset = ['dawn', 'golden_hour', 'golden', 'morning', 'midday', 'afternoon', 'sunset', 'dusk', 'twilight', 'blue_hour', 'night', 'deep_night', 'overcast'].includes(preset.toLowerCase());
                if (isDiurnalPreset && !params.skybox) {
                    scene.environment.skybox = diurnalState.skyboxName;
                }
            }

            if (params.skybox) {
                scene.environment.skybox = params.skybox;
            } else if (!scene.environment.skybox) {
                scene.environment.skybox = params.preset || 'studio';
            }

            if (scene.environment.ground === undefined) {
                scene.environment.ground = true;
            }

            if (params.kelvinTemperature) {
                scene.environment.kelvinTemperature = params.kelvinTemperature;
            }

            // Connect to atmospheric scattering features.
            // Atmosphere is an explicit part of the headless build and is NOT enabled by preset heuristics.
            const isAtmosphereExplicit = params.enableAtmosphere === true || params.atmosphericScattering === true || params.rayleigh !== undefined || (typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null && (scene.features.atmosphericScattering as any).enabled !== false);
            if (isAtmosphereExplicit) {
                const existingAtmo = (typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null) ? scene.features.atmosphericScattering : {};
                const sunVec = getSunVectorFromAngles(scene.environment.sunElevation || 45.0, scene.environment.sunAzimuth || 180.0);

                scene.features.atmosphericScattering = {
                    enabled: true,
                    rayleigh: params.rayleigh ?? existingAtmo.rayleigh ?? 0.5,
                    mie: params.mie ?? existingAtmo.mie ?? 0.002,
                    turbidity: params.turbidity ?? existingAtmo.turbidity ?? 1.5,
                    mieDirectionalG: params.mieDirectionalG ?? existingAtmo.mieDirectionalG ?? 0.82,
                    sunPosition: [sunVec.x * 60, sunVec.y * 60, sunVec.z * 60],
                    sunElevation: scene.environment.sunElevation,
                    sunAzimuth: scene.environment.sunAzimuth,
                    timeOfDay: scene.environment.timeOfDay,
                    latitude: scene.environment.latitude,
                    longitude: scene.environment.longitude,
                    cloudCoverage: params.cloudCoverage ?? existingAtmo.cloudCoverage ?? (preset.toLowerCase() === 'overcast' ? 0.85 : 0.35),
                    cloudDensity: params.cloudDensity ?? existingAtmo.cloudDensity ?? 0.45,
                    cloudAltitude: params.cloudAltitude ?? existingAtmo.cloudAltitude ?? 1200.0,
                    volumetricClouds: params.volumetricClouds ?? existingAtmo.volumetricClouds ?? true,
                    kelvinTemperature: params.kelvinTemperature ?? existingAtmo.kelvinTemperature ?? (diurnalState?.kelvin || 6500),

                    // Aerial perspective parameters
                    aerialPerspectiveEnabled: true,
                    inscatteringIntensity: params.inscatteringIntensity ?? existingAtmo.inscatteringIntensity ?? 1.0,
                    aerialPerspectiveRange: params.aerialPerspectiveRange ?? existingAtmo.aerialPerspectiveRange ?? 220.0,
                    albedoScale: params.albedoScale ?? existingAtmo.albedoScale ?? (diurnalState?.aerialAlbedoBoost || 1.1),
                    fogDensity: params.fogDensity ?? existingAtmo.fogDensity,
                    fogBaseAltitude: params.fogBaseAltitude ?? existingAtmo.fogBaseAltitude ?? 0.0,
                    fogHeight: params.fogHeight ?? existingAtmo.fogHeight ?? 120.0,

                    // Terrain cloud shadows parameters
                    cloudShadowsEnabled: params.cloudShadowsEnabled ?? existingAtmo.cloudShadowsEnabled ?? true,
                    cloudShadowIntensity: params.cloudShadowIntensity ?? existingAtmo.cloudShadowIntensity ?? 0.65,
                    cloudShadowScale: params.cloudShadowScale ?? existingAtmo.cloudShadowScale ?? 0.015,
                    atmosphereShadowLength: params.atmosphereShadowLength ?? existingAtmo.atmosphereShadowLength ?? 1.0,
                    windVector: params.windVector ?? existingAtmo.windVector ?? [0.05, 0.02]
                };
            }

            if (params.godRays || params.enableGodRays || params.godRaysIntensity !== undefined) {
                const existingGodRays = (typeof scene.features.godRays === 'object' && scene.features.godRays !== null) ? scene.features.godRays : {};
                scene.features.godRays = params.godRays === true ? true : {
                    enabled: params.enableGodRays !== false,
                    intensity: params.godRaysIntensity ?? existingGodRays.intensity ?? (diurnalState?.isGoldenHour ? 0.55 : 0.28)
                };
            }

            (scene.environment as any).lightingRig = {
                preset: params.preset,
                ambientIntensity: params.ambientIntensity ?? diurnalState?.skyLightIntensity,
                diurnalPhase: diurnalState?.phase,
                sunIntensity: diurnalState?.sunIntensity,
                castShadows: diurnalState?.castShadows,
                keyLight: params.keyLight,
                fillLight: params.fillLight,
                rimLight: params.rimLight
            };

            return {
                success: true,
                preset: scene.environment.lighting,
                skybox: scene.environment.skybox,
                sunElevation: scene.environment.sunElevation,
                sunAzimuth: scene.environment.sunAzimuth,
                diurnalPhase: diurnalState?.phase,
                atmosphericScattering: scene.features.atmosphericScattering
            };
        }
    },
    {
        name: 'sb_set_camera',
        category: 'lighting_camera',
        description: 'Sets camera position, target, field of view, and camera projection mode.',
        execute: (ctx, params: { position?: [number, number, number]; target?: [number, number, number]; fov?: number; cameraMode?: 'orbit' | 'fps' }) => {
            const scene = ctx.getSceneData();
            if (!scene.camera) scene.camera = { position: [10, 10, 10], target: [0, 0, 0], fov: 60 };

            if (params.position) scene.camera.position = [...params.position];
            if (params.target) scene.camera.target = [...params.target];
            if (params.fov) scene.camera.fov = params.fov;
            if (params.cameraMode) scene.cameraMode = params.cameraMode;

            return { camera: scene.camera, cameraMode: scene.cameraMode };
        }
    },
    {
        name: 'sb_frame_bounds',
        category: 'lighting_camera',
        description: 'Calculates bounding box of selection/scene and frames camera optimally.',
        execute: (ctx, params: { targetId?: string; paddingFactor?: number }) => {
            const scene = ctx.getSceneData();
            const padding = params.paddingFactor || 1.5;

            const min = new THREE.Vector3(Infinity, Infinity, Infinity);
            const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (!found) throw new Error(`Target object '${params.targetId}' not found.`);
                const pos = found.object.position || [0, 0, 0];
                const scl = found.object.scale || [1, 1, 1];
                min.set(pos[0] - scl[0] / 2, pos[1] - scl[1] / 2, pos[2] - scl[2] / 2);
                max.set(pos[0] + scl[0] / 2, pos[1] + scl[1] / 2, pos[2] + scl[2] / 2);
            } else if (scene.customMeshes && scene.customMeshes.length > 0) {
                for (const m of scene.customMeshes) {
                    const pos = m.position || [0, 0, 0];
                    const scl = m.scale || [1, 1, 1];
                    min.x = Math.min(min.x, pos[0] - scl[0] / 2);
                    min.y = Math.min(min.y, pos[1] - scl[1] / 2);
                    min.z = Math.min(min.z, pos[2] - scl[2] / 2);
                    max.x = Math.max(max.x, pos[0] + scl[0] / 2);
                    max.y = Math.max(max.y, pos[1] + scl[1] / 2);
                    max.z = Math.max(max.z, pos[2] + scl[2] / 2);
                }
            } else {
                min.set(-5, -5, -5);
                max.set(5, 5, 5);
            }

            const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
            const size = new THREE.Vector3().subVectors(max, min);
            const maxDim = Math.max(size.x, size.y, size.z, 2.0);
            const dist = maxDim * padding;

            const camPos: [number, number, number] = [Number((center.x + dist * 0.9).toFixed(2)), Number((center.y + dist * 0.7).toFixed(2)), Number((center.z + dist * 0.9).toFixed(2))];
            const camTarget: [number, number, number] = [Number(center.x.toFixed(2)), Number(center.y.toFixed(2)), Number(center.z.toFixed(2))];

            if (!scene.camera) scene.camera = { position: camPos, target: camTarget, fov: 60 };
            scene.camera.position = camPos;
            scene.camera.target = camTarget;

            return {
                cameraPosition: camPos,
                cameraTarget: camTarget,
                boundingBox: {
                    min: [min.x, min.y, min.z],
                    max: [max.x, max.y, max.z],
                    center: [center.x, center.y, center.z],
                    size: [size.x, size.y, size.z]
                }
            };
        }
    }
];
