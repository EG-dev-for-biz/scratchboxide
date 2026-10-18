/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { type OperatorDefinition, OperatorUnavailableError } from './types';
import {
    getPresetLightingState,
    isTimeOfDayPreset,
    computeDiurnalLightingProfile,
    getSunVectorFromAngles
} from '../atmosphere';
import { sunAtLocalSolarTime } from './nature-atmosphere-operators';


/** Local bounds of the unit shape the viewport draws for a customMesh of `type` (syncCustomMeshes createGeometry). */
function customMeshUnitBounds(type: string | undefined): THREE.Box3 {
    if (type === 'sphere' || type === 'cylinder' || type === 'cone') return new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    if (type === 'plane') return new THREE.Box3(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 0));
    if (type === 'torus') return new THREE.Box3(new THREE.Vector3(-1.4, -1.4, -0.4), new THREE.Vector3(1.4, 1.4, 0.4));
    return new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
}

/** World matrix of a customMesh from its own transform and its parentId chain. */
function customMeshWorldMatrix(def: any, byId: Map<string, any>, depth = 0): THREE.Matrix4 {
    const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...((def.position || [0, 0, 0]) as [number, number, number])),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...((def.rotation || [0, 0, 0]) as [number, number, number]))),
        new THREE.Vector3(...((def.scale || [1, 1, 1]) as [number, number, number]))
    );
    const parent = def.parentId && def.parentId !== def.id ? byId.get(def.parentId) : undefined;
    return parent && depth < 64 ? customMeshWorldMatrix(parent, byId, depth + 1).multiply(local) : local;
}

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
            skybox?: string;
            ambientIntensity?: number;
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
            cloudShadowsEnabled?: boolean;
            cloudShadowIntensity?: number;
            cloudShadowScale?: number;
            atmosphereShadowLength?: number;
            windVector?: [number, number];
            godRays?: boolean;
            enableGodRays?: boolean;
            godRaysIntensity?: number;
        }) => {
            const scene = ctx.getSceneData();
            // Validate before writing anything: a time of day only fixes the sun at a place.
            const latitude: number | undefined = params.timeOfDay !== undefined ? (params.latitude ?? scene.geoAnchor?.lat) : undefined;
            const longitude: number | undefined = params.timeOfDay !== undefined ? (params.longitude ?? scene.geoAnchor?.lng) : undefined;
            if (params.timeOfDay !== undefined && (latitude === undefined || longitude === undefined)) {
                throw new Error('sb_setup_lighting: timeOfDay needs latitude/longitude (or a scene geoAnchor) to place the sun; or give sunElevation/sunAzimuth. Nothing was changed.');
            }
            if (!scene.environment) scene.environment = {};
            if (!scene.features) scene.features = {};

            const preset = params.preset || scene.environment.lighting || 'studio';
            scene.environment.lighting = preset;

            let diurnalState: any = null;
            let sunElevation: number | undefined;
            let sunAzimuth: number | undefined;
            if (params.timeOfDay !== undefined && latitude !== undefined && longitude !== undefined) {
                const sun = sunAtLocalSolarTime(latitude, longitude, params.timeOfDay);
                sunElevation = sun.elevationDeg;
                sunAzimuth = sun.azimuthDeg;
                diurnalState = { ...computeDiurnalLightingProfile(sunElevation), sunElevation, sunAzimuth };
            } else if (params.sunElevation !== undefined || params.sunAzimuth !== undefined) {
                sunElevation = params.sunElevation ?? 45.0;
                sunAzimuth = params.sunAzimuth ?? 180.0;
                diurnalState = { ...computeDiurnalLightingProfile(sunElevation), sunElevation, sunAzimuth };
            } else if (isTimeOfDayPreset(preset)) {
                diurnalState = getPresetLightingState(preset);
                sunElevation = diurnalState.elevationDeg;
                sunAzimuth = diurnalState.azimuthDeg;
                const isDiurnalPreset = ['dawn', 'golden_hour', 'golden', 'morning', 'midday', 'afternoon', 'sunset', 'dusk', 'twilight', 'blue_hour', 'night', 'deep_night', 'overcast'].includes(preset.toLowerCase());
                if (isDiurnalPreset && !params.skybox) {
                    scene.environment.skybox = diurnalState.skyboxName;
                }
            }
            // Any other lighting name (a renderer rig such as 'neon') places no sun.

            if (params.skybox) {
                scene.environment.skybox = params.skybox;
            } else if (!scene.environment.skybox) {
                scene.environment.skybox = params.preset || 'studio';
            }

            if (params.kelvinTemperature) {
                scene.environment.lightingKelvin = params.kelvinTemperature;
            }
            if (params.ambientIntensity !== undefined) {
                scene.environment.ambientIntensity = params.ambientIntensity;
            }

            // Connect to atmospheric scattering features.
            // Atmosphere is an explicit part of the headless build and is NOT enabled by preset heuristics.
            const isAtmosphereExplicit = params.enableAtmosphere === true || params.atmosphericScattering === true || params.rayleigh !== undefined || (typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null && (scene.features.atmosphericScattering as any).enabled !== false);
            if (isAtmosphereExplicit) {
                if (sunElevation === undefined || sunAzimuth === undefined) {
                    throw new Error(`sb_setup_lighting: atmospheric scattering needs a sun, and lighting '${preset}' is not a time-of-day preset; give a time-of-day preset, timeOfDay with a location, or sunElevation/sunAzimuth.`);
                }
                const existingAtmo = (typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null) ? scene.features.atmosphericScattering : {};
                const sunVec = getSunVectorFromAngles(sunElevation, sunAzimuth);

                scene.features.atmosphericScattering = {
                    enabled: true,
                    rayleigh: params.rayleigh ?? existingAtmo.rayleigh ?? 0.5,
                    mie: params.mie ?? existingAtmo.mie ?? 0.002,
                    turbidity: params.turbidity ?? existingAtmo.turbidity ?? 1.5,
                    mieDirectionalG: params.mieDirectionalG ?? existingAtmo.mieDirectionalG ?? 0.82,
                    sunPosition: [sunVec.x * 60, sunVec.y * 60, sunVec.z * 60],
                    sunElevation,
                    sunAzimuth,
                    timeOfDay: params.timeOfDay ?? existingAtmo.timeOfDay,
                    latitude: latitude ?? existingAtmo.latitude,
                    longitude: longitude ?? existingAtmo.longitude,
                    cloudCoverage: params.cloudCoverage ?? existingAtmo.cloudCoverage ?? 0.0,
                    cloudDensity: params.cloudDensity ?? existingAtmo.cloudDensity ?? 0.0,
                    cloudAltitude: params.cloudAltitude ?? existingAtmo.cloudAltitude ?? 1200.0,
                    volumetricClouds: params.volumetricClouds ?? existingAtmo.volumetricClouds ?? false,
                    kelvinTemperature: params.kelvinTemperature ?? existingAtmo.kelvinTemperature ?? (diurnalState?.kelvin || 6500),

                    // Aerial perspective parameters (Strictly opt-in: zero default haze/fog)
                    aerialPerspectiveEnabled: params.inscatteringIntensity !== undefined ? true : (existingAtmo.aerialPerspectiveEnabled ?? false),
                    inscatteringIntensity: params.inscatteringIntensity ?? existingAtmo.inscatteringIntensity ?? 0.0,
                    aerialPerspectiveRange: params.aerialPerspectiveRange ?? existingAtmo.aerialPerspectiveRange ?? 220.0,
                    albedoScale: params.albedoScale ?? existingAtmo.albedoScale ?? (diurnalState?.aerialAlbedoBoost || 1.1),
                    fogDensity: params.fogDensity ?? existingAtmo.fogDensity,

                    // Terrain cloud shadows parameters (Strictly opt-in with volumetric clouds)
                    cloudShadowsEnabled: params.cloudShadowsEnabled ?? existingAtmo.cloudShadowsEnabled ?? false,
                    cloudShadowIntensity: params.cloudShadowIntensity ?? existingAtmo.cloudShadowIntensity ?? 0.0,
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

            return {
                success: true,
                preset: scene.environment.lighting,
                skybox: scene.environment.skybox,
                sunElevation,
                sunAzimuth,
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

            const box = new THREE.Box3();
            const threeScene = ctx.getThreeScene();
            if (threeScene) {
                // The live viewport: the bounds of the real geometry.
                const root = params.targetId ? ctx.getThreeObject(params.targetId) : threeScene;
                if (!root) throw new Error(`Target object '${params.targetId}' not found.`);
                root.updateWorldMatrix(true, true);
                box.setFromObject(root, true);
            } else {
                // Scene data only: customMeshes are drawn as unit shapes (customMeshUnitBounds) under their transforms.
                const meshes = scene.customMeshes || [];
                const byId = new Map(meshes.map(m => [m.id, m]));
                const targets = params.targetId ? meshes.filter(m => m.id === params.targetId || m.name === params.targetId) : meshes;
                if (params.targetId && targets.length === 0) {
                    if (ctx.findObject(params.targetId)) throw new OperatorUnavailableError(`sb_frame_bounds: '${params.targetId}' has no customMesh shape to measure here; its bounds are only known in the live 3D viewport.`);
                    throw new Error(`Target object '${params.targetId}' not found.`);
                }
                if (targets.length === 0) {
                    throw new OperatorUnavailableError('sb_frame_bounds: the scene has no customMeshes to measure, and other content (generated models, tiles, media) is only measurable in the live 3D viewport.');
                }
                for (const m of targets) box.union(customMeshUnitBounds(m.type).applyMatrix4(customMeshWorldMatrix(m, byId)));
            }
            if (box.isEmpty()) throw new Error('sb_frame_bounds: the target has no geometry to frame.');
            const min = box.min;
            const max = box.max;

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
