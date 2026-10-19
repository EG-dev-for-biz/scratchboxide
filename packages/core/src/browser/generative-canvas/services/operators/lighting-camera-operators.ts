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
import type { SceneCameraLens, SceneLensDistortion } from '../../canvas-types';
import { planViewportOptics, distortionMaxAspect } from '../../primitives/scene3d/viewportOptics';

/** Parameters of sb_set_camera_lens: a field given replaces it, null removes it, an absent field is kept. */
export interface SetCameraLensParams {
    distortion?: SceneLensDistortion | null;
    focalLengthMm?: number | null;
    sensorWidthMm?: number | null;
    sensorHeightMm?: number | null;
    apertureFStop?: number | null;
    focusDistanceMeters?: number | null;
    focusObjectId?: string | null;
    anamorphicSqueeze?: number | null;
    depthOfField?: boolean | null;
    /** Removes the whole lens (an ideal pinhole again: no optics passes). */
    clear?: boolean;
}

const LENS_POSITIVE_FIELDS = ['focalLengthMm', 'sensorWidthMm', 'sensorHeightMm', 'apertureFStop', 'focusDistanceMeters', 'anamorphicSqueeze'] as const;
const DISTORTION_FIELDS = ['k1', 'k2', 'k3', 'p1', 'p2', 'chromaticAberration'] as const;
/** Frames up to this wide (width / height) are expected; a lens that folds inside one is reported (not refused). */
const LENS_WIDE_ASPECT = 2.39;

/**
 * Validates and merges sb_set_camera_lens parameters into a lens; throws (nothing written) on a bad value, including
 * distortion that folds back (has no inverse) even inside a square frame. `warnings` gets what is kept but limited.
 */
export function mergeCameraLens(previous: SceneCameraLens | undefined, params: SetCameraLensParams, verticalFovDeg: number, warnings: string[] = []): SceneCameraLens | undefined {
    if (params.clear) return undefined;
    const lens: SceneCameraLens = { ...(previous || {}) };
    if (previous?.distortion) lens.distortion = { ...previous.distortion };
    for (const key of LENS_POSITIVE_FIELDS) {
        const v = params[key];
        if (v === undefined) continue;
        if (v === null) { delete lens[key]; continue; }
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`sb_set_camera_lens: ${key} must be a positive number (got ${String(v)}). Nothing was changed.`);
        lens[key] = v;
    }
    if (params.focusObjectId !== undefined) {
        if (params.focusObjectId === null || params.focusObjectId === '') delete lens.focusObjectId;
        else if (typeof params.focusObjectId !== 'string') throw new Error('sb_set_camera_lens: focusObjectId must be an object id or name. Nothing was changed.');
        else { lens.focusObjectId = params.focusObjectId; if (params.focusDistanceMeters === undefined) delete lens.focusDistanceMeters; }
    } else if (typeof params.focusDistanceMeters === 'number') {
        // a distance given on its own replaces a tracked focus object
        delete lens.focusObjectId;
    }
    if (params.depthOfField !== undefined) {
        if (params.depthOfField === null) delete lens.depthOfField;
        else lens.depthOfField = !!params.depthOfField;
    }
    if (params.distortion !== undefined) {
        if (params.distortion === null) delete lens.distortion;
        else {
            const d: SceneLensDistortion = { ...(lens.distortion || { k1: 0 }) };
            for (const key of DISTORTION_FIELDS) {
                const v = (params.distortion as unknown as Record<string, unknown>)[key];
                if (v === undefined) continue;
                if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`sb_set_camera_lens: distortion.${key} must be a finite number (got ${String(v)}). Nothing was changed.`);
                (d as unknown as Record<string, number>)[key] = v;
            }
            if (d.chromaticAberration !== undefined && d.chromaticAberration < 0) throw new Error('sb_set_camera_lens: distortion.chromaticAberration cannot be negative. Nothing was changed.');
            lens.distortion = d;
        }
    }
    const f = lens.focalLengthMm;
    if (f !== undefined && lens.focusDistanceMeters !== undefined && !(lens.focusDistanceMeters > f / 1000)) {
        throw new Error(`sb_set_camera_lens: the focus distance ${lens.focusDistanceMeters} m is inside the ${f} mm focal length; a lens cannot focus there. Nothing was changed.`);
    }
    const plan = planViewportOptics(lens);
    if (plan.distortion) {
        const maxAspect = distortionMaxAspect(plan.distortion, verticalFovDeg);
        if (maxAspect < 1) {
            throw new Error(`sb_set_camera_lens: these distortion coefficients fold back inside a square ${verticalFovDeg.toFixed(1)}° frame (the model has no inverse at its edge), so the viewport could not draw them${maxAspect > 0 ? ` on frames wider than ${maxAspect.toFixed(2)}:1` : ''}. Nothing was changed.`);
        }
        if (maxAspect < LENS_WIDE_ASPECT) {
            warnings.push(`at this ${verticalFovDeg.toFixed(1)}° field of view the distortion folds back (no inverse) on frames wider than ${maxAspect.toFixed(2)}:1; a wider viewport draws no distortion and shows a notice saying so`);
        }
    }
    return Object.keys(lens).length > 0 ? lens : undefined;
}


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
        name: 'sb_set_camera_lens',
        category: 'lighting_camera',
        description: 'Puts lens optics on the scene camera, drawn by the viewport: Brown-Conrady distortion (k1, k2, k3, p1, p2 in normalized camera coordinates, k1 < 0 barrel) and thin-lens depth of field (focal length, f-number, focus distance or a focus object, anamorphic squeeze). A field given replaces it, null removes it; clear removes the lens.',
        execute: (ctx, params: SetCameraLensParams) => {
            const scene = ctx.getSceneData();
            if (!scene.camera) throw new Error('sb_set_camera_lens: the scene has no camera pose to put a lens on (set one with sb_set_camera first). Nothing was changed.');
            const fov = typeof scene.camera.fov === 'number' && scene.camera.fov > 0 && scene.camera.fov < 180 ? scene.camera.fov : 45;
            const warnings: string[] = [];
            const lens = mergeCameraLens(scene.camera.lens, params || {}, fov, warnings);
            const camera = { ...scene.camera };
            if (lens) camera.lens = lens;
            else delete camera.lens;
            scene.camera = camera;
            const plan = planViewportOptics(lens);
            return { lens: lens ?? null, passes: plan.passes, issues: [...plan.issues, ...warnings] };
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
