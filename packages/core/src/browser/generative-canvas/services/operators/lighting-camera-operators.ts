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
import type { Scene3DData, SceneCameraLens, SceneLensDistortion, SceneFilmGrain, SceneLensFlare, SceneLensDiffusion } from '../../canvas-types';
import { planViewportOptics, distortionMaxAspect } from '../../primitives/scene3d/viewportOptics';
import { FOCUS_MODES_DRAWN, effectiveFocusMode, isFocusPoint } from '../../primitives/scene3d/viewportFocus';
import { mergeColorHarmony, planColorHarmony, type SetColorHarmonyParams } from '../postprocessing/color-harmony';

type Vec3 = [number, number, number];

/**
 * A focus point for sb_set_camera_lens: `localPosition` in the local frame of `objectId`, or `worldPosition` (the
 * operator converts it with the object's transform: the live viewport object, else the customMesh / objects[] transform
 * in the scene data). Without objectId the point is a fixed world point.
 */
export interface FocusPointParams {
    objectId?: string;
    localPosition?: Vec3;
    worldPosition?: Vec3;
}

/** Parameters of sb_set_camera_lens: a field given replaces it, null removes it, an absent field is kept. */
export interface SetCameraLensParams {
    distortion?: SceneLensDistortion | null;
    focalLengthMm?: number | null;
    sensorWidthMm?: number | null;
    sensorHeightMm?: number | null;
    apertureFStop?: number | null;
    focusDistanceMeters?: number | null;
    focusObjectId?: string | null;
    /** 'manual' | 'auto' | 'track' (see SceneCameraLens.focusMode); null removes it. */
    focusMode?: string | null;
    /** Auto focus area: side of the centred square as a fraction of the frame height, (0, 1]. */
    autoFocusAreaFraction?: number | null;
    /** Focus-pull time constant in seconds, >= 0 (0 snaps). */
    focusPullSeconds?: number | null;
    /** Track this point (implies focusMode 'track' unless a mode is given); null removes it. */
    focusPoint?: FocusPointParams | null;
    anamorphicSqueeze?: number | null;
    depthOfField?: boolean | null;
    /** False turns off temporal anti-aliasing under the lens effects; null restores the default (on). */
    temporalAntiAliasing?: boolean | null;
    /** Film grain (SceneFilmGrain); fields given are merged into the lens's, null removes it. */
    filmGrain?: Partial<SceneFilmGrain> | null;
    /** Lens flare (SceneLensFlare); fields given are merged into the lens's, null removes it. */
    flare?: Partial<SceneLensFlare> | null;
    /** Diffusion filter, e.g. a Black Pro-Mist (SceneLensDiffusion); fields given are merged, null removes it. */
    diffusion?: Partial<SceneLensDiffusion> | null;
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
    // focus targets: one at a time (a point, a whole object, or none)
    const setsTarget = (params.focusObjectId !== undefined && params.focusObjectId !== null && params.focusObjectId !== '')
        || (params.focusPoint !== undefined && params.focusPoint !== null);
    if (params.focusObjectId !== undefined && params.focusPoint !== undefined && params.focusObjectId && params.focusPoint) {
        throw new Error('sb_set_camera_lens: give a focusPoint or a focusObjectId, not both. Nothing was changed.');
    }
    if (params.focusObjectId !== undefined) {
        if (params.focusObjectId === null || params.focusObjectId === '') delete lens.focusObjectId;
        else if (typeof params.focusObjectId !== 'string') throw new Error('sb_set_camera_lens: focusObjectId must be an object id or name. Nothing was changed.');
        else {
            lens.focusObjectId = params.focusObjectId;
            delete lens.focusPoint;
            if (params.focusDistanceMeters === undefined) delete lens.focusDistanceMeters;
        }
    }
    if (params.focusPoint !== undefined) {
        if (params.focusPoint === null) delete lens.focusPoint;
        else {
            const p = params.focusPoint;
            if (p.worldPosition !== undefined && p.localPosition === undefined) throw new Error('sb_set_camera_lens: focusPoint.worldPosition could not be converted to the object\'s local frame. Nothing was changed.');
            const point = { ...(p.objectId ? { objectId: p.objectId } : {}), localPosition: p.localPosition as Vec3 };
            if (!isFocusPoint(point)) throw new Error('sb_set_camera_lens: focusPoint needs localPosition (or worldPosition) as three finite numbers, and objectId (if given) as a non-empty string. Nothing was changed.');
            lens.focusPoint = point;
            delete lens.focusObjectId;
        }
    }
    if (setsTarget && params.focusMode === undefined) lens.focusMode = 'track';
    if (!setsTarget && params.focusMode === undefined && typeof params.focusDistanceMeters === 'number') {
        // a distance given on its own is manual focus: it replaces a tracked point or object and auto focus
        delete lens.focusObjectId;
        delete lens.focusPoint;
        delete lens.focusMode;
    }
    if (params.focusMode !== undefined) {
        if (params.focusMode === null || params.focusMode === '') delete lens.focusMode;
        else if (typeof params.focusMode !== 'string' || !FOCUS_MODES_DRAWN.includes(params.focusMode)) {
            throw new Error(`sb_set_camera_lens: focusMode '${String(params.focusMode)}' is not one the viewport draws (${FOCUS_MODES_DRAWN.join(', ')}). Nothing was changed.`);
        } else {
            lens.focusMode = params.focusMode;
            // manual and auto focus have no target; tracking needs one
            if (params.focusMode !== 'track') { delete lens.focusObjectId; delete lens.focusPoint; }
            else if (!lens.focusObjectId && !isFocusPoint(lens.focusPoint)) {
                throw new Error('sb_set_camera_lens: focusMode \'track\' needs a focusPoint (a point on an object) or a focusObjectId (a whole object). Nothing was changed.');
            }
        }
    }
    if (params.autoFocusAreaFraction !== undefined) {
        const v = params.autoFocusAreaFraction;
        if (v === null) delete lens.autoFocusAreaFraction;
        else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) throw new Error(`sb_set_camera_lens: autoFocusAreaFraction must be in (0, 1], a fraction of the frame height (got ${String(v)}). Nothing was changed.`);
        else lens.autoFocusAreaFraction = v;
    }
    if (params.focusPullSeconds !== undefined) {
        const v = params.focusPullSeconds;
        if (v === null) delete lens.focusPullSeconds;
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`sb_set_camera_lens: focusPullSeconds must be a number of seconds >= 0 (got ${String(v)}). Nothing was changed.`);
        else lens.focusPullSeconds = v;
    }
    // a legacy lens (focusObjectId without a mode) reads as tracking; a stored mode stays consistent with its target
    if (lens.focusMode === 'track' && effectiveFocusMode({ ...lens, focusMode: undefined }) !== 'track') delete lens.focusMode;
    if (params.depthOfField !== undefined) {
        if (params.depthOfField === null) delete lens.depthOfField;
        else lens.depthOfField = !!params.depthOfField;
    }
    if (params.temporalAntiAliasing !== undefined) {
        if (params.temporalAntiAliasing === null) delete lens.temporalAntiAliasing;
        else lens.temporalAntiAliasing = !!params.temporalAntiAliasing;
    }
    if (params.filmGrain !== undefined) {
        if (params.filmGrain === null) delete lens.filmGrain;
        else {
            const g: SceneFilmGrain = { ...(lens.filmGrain || { amount: 0 }), ...params.filmGrain };
            if (typeof g.amount !== 'number' || !Number.isFinite(g.amount) || g.amount < 0 || g.amount > 1) throw new Error(`sb_set_camera_lens: filmGrain.amount must be in [0, 1] (got ${String(g.amount)}). Nothing was changed.`);
            if (g.sizeUm !== undefined && !(typeof g.sizeUm === 'number' && Number.isFinite(g.sizeUm) && g.sizeUm > 0)) throw new Error(`sb_set_camera_lens: filmGrain.sizeUm must be a positive number of micrometres (got ${String(g.sizeUm)}). Nothing was changed.`);
            if (g.chroma !== undefined && !(typeof g.chroma === 'number' && Number.isFinite(g.chroma) && g.chroma >= 0 && g.chroma <= 1)) throw new Error(`sb_set_camera_lens: filmGrain.chroma must be in [0, 1] (got ${String(g.chroma)}). Nothing was changed.`);
            if (g.animate !== undefined) g.animate = !!g.animate;
            lens.filmGrain = g;
        }
    }
    const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (params.flare !== undefined) {
        if (params.flare === null) delete lens.flare;
        else {
            const fl: SceneLensFlare = { ...(lens.flare || { amount: 0 }), ...params.flare };
            if (!inRange(fl.amount, 0, 1)) throw new Error(`sb_set_camera_lens: flare.amount must be in [0, 1] (got ${String(fl.amount)}). Nothing was changed.`);
            if (fl.ghosts !== undefined && !(inRange(fl.ghosts, 0, 8) && Number.isInteger(fl.ghosts))) throw new Error(`sb_set_camera_lens: flare.ghosts must be a whole number from 0 to 8 (got ${String(fl.ghosts)}). Nothing was changed.`);
            for (const k of ['halo', 'streak'] as const) if (fl[k] !== undefined && !inRange(fl[k], 0, 1)) throw new Error(`sb_set_camera_lens: flare.${k} must be in [0, 1] (got ${String(fl[k])}). Nothing was changed.`);
            if (fl.threshold !== undefined && !(typeof fl.threshold === 'number' && Number.isFinite(fl.threshold) && fl.threshold > 0)) throw new Error(`sb_set_camera_lens: flare.threshold must be a positive linear luminance (got ${String(fl.threshold)}). Nothing was changed.`);
            lens.flare = fl;
        }
    }
    if (params.diffusion !== undefined) {
        if (params.diffusion === null) delete lens.diffusion;
        else {
            const df: SceneLensDiffusion = { ...(lens.diffusion || { strength: 0 }), ...params.diffusion };
            if (!inRange(df.strength, 0, 1)) throw new Error(`sb_set_camera_lens: diffusion.strength must be in [0, 1] (got ${String(df.strength)}). Nothing was changed.`);
            if (df.spread !== undefined && !inRange(df.spread, 0.001, 0.5)) throw new Error(`sb_set_camera_lens: diffusion.spread must be a fraction of the frame height in [0.001, 0.5] (got ${String(df.spread)}). Nothing was changed.`);
            lens.diffusion = df;
        }
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

/**
 * A focus point given as worldPosition -> localPosition in its object's frame: through the live viewport object when
 * there is one, else the customMesh (with its parent chain) or objects[] (space.spatial3d, rotation in degrees)
 * transform in the scene data. Throws (nothing written) when the object's transform is not known.
 */
function focusPointToLocal(ctx: { getThreeObject(id: string): THREE.Object3D | undefined }, scene: Pick<Scene3DData, 'customMeshes' | 'objects'>, p: FocusPointParams): FocusPointParams {
    if (!p || p.worldPosition === undefined || p.localPosition !== undefined) return p;
    const w = p.worldPosition;
    if (!Array.isArray(w) || w.length !== 3 || !w.every(v => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error('sb_set_camera_lens: focusPoint.worldPosition must be three finite numbers. Nothing was changed.');
    }
    const world = new THREE.Vector3(w[0], w[1], w[2]);
    if (!p.objectId) return { localPosition: [w[0], w[1], w[2]] };
    let matrix: THREE.Matrix4 | null = null;
    const live = ctx.getThreeObject(p.objectId);
    if (live) {
        live.updateWorldMatrix(true, false);
        matrix = live.matrixWorld.clone();
    } else {
        const meshes: Array<{ id?: string; name?: string }> = scene.customMeshes || [];
        const mesh = meshes.find(m => m.id === p.objectId || m.name === p.objectId);
        const obj = (scene.objects || []).find(o => o.id === p.objectId);
        if (mesh) matrix = customMeshWorldMatrix(mesh, new Map(meshes.map(m => [m.id ?? '', m] as [string, typeof m])));
        else if (obj) {
            const s3: { x?: number; y?: number; z?: number; pitch?: number; yaw?: number; roll?: number } = obj.space?.spatial3d || {};
            const deg = Math.PI / 180;
            matrix = new THREE.Matrix4().compose(
                new THREE.Vector3(s3.x ?? 0, s3.y ?? 0, s3.z ?? 0),
                new THREE.Quaternion().setFromEuler(new THREE.Euler((s3.pitch ?? 0) * deg, (s3.yaw ?? 0) * deg, (s3.roll ?? 0) * deg)),
                new THREE.Vector3(1, 1, 1)
            );
        }
    }
    if (!matrix) throw new Error(`sb_set_camera_lens: '${p.objectId}' is not a customMesh or object in the scene data, so its transform is unknown; give focusPoint.localPosition in its local frame, or a worldPosition without objectId (a fixed world point). Nothing was changed.`);
    const local = world.applyMatrix4(matrix.invert());
    return { objectId: p.objectId, localPosition: [local.x, local.y, local.z] };
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
                    cloudAltitude: params.cloudAltitude ?? existingAtmo.cloudAltitude ?? 2200.0,
                    volumetricClouds: params.volumetricClouds ?? existingAtmo.volumetricClouds ?? false,
                    // Only a chosen colour temperature is stored: without one the viewport colours the sun from its spectral beam.
                    ...((params.kelvinTemperature ?? existingAtmo.kelvinTemperature) !== undefined ? { kelvinTemperature: params.kelvinTemperature ?? existingAtmo.kelvinTemperature } : {}),

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
        description: 'Sets camera position, target, field of view, and camera projection mode. keepPoseOnLoad: true makes loading the scene open on this pose instead of re-framing generated content (false clears it).',
        execute: (ctx, params: { position?: [number, number, number]; target?: [number, number, number]; fov?: number; cameraMode?: 'orbit' | 'fps'; keepPoseOnLoad?: boolean }) => {
            const scene = ctx.getSceneData();
            if (!scene.camera) scene.camera = { position: [10, 10, 10], target: [0, 0, 0], fov: 60 };

            if (params.position) scene.camera.position = [...params.position];
            if (params.target) scene.camera.target = [...params.target];
            if (params.fov) scene.camera.fov = params.fov;
            if (params.cameraMode) scene.cameraMode = params.cameraMode;
            if (params.keepPoseOnLoad === true) scene.camera.keepPoseOnLoad = true;
            else if (params.keepPoseOnLoad === false) delete scene.camera.keepPoseOnLoad;

            return { camera: scene.camera, cameraMode: scene.cameraMode };
        }
    },
    {
        name: 'sb_set_camera_lens',
        category: 'lighting_camera',
        description: 'Puts lens optics on the scene camera, drawn by the viewport: Brown-Conrady distortion (k1, k2, k3, p1, p2 in normalized camera coordinates, k1 < 0 barrel) and thin-lens depth of field (focal length, f-number, anamorphic squeeze) and how it focuses: focusMode \'manual\' (focusDistanceMeters), \'auto\' (continuous autofocus on the centre of the frame: autoFocusAreaFraction of the frame height, focusPullSeconds glide), or \'track\' (a focusPoint locked to an object, given as localPosition or worldPosition, or a whole focusObjectId). A field given replaces it, null removes it; clear removes the lens.',
        execute: (ctx, params: SetCameraLensParams) => {
            const scene = ctx.getSceneData();
            if (!scene.camera) throw new Error('sb_set_camera_lens: the scene has no camera pose to put a lens on (set one with sb_set_camera first). Nothing was changed.');
            const fov = typeof scene.camera.fov === 'number' && scene.camera.fov > 0 && scene.camera.fov < 180 ? scene.camera.fov : 45;
            const warnings: string[] = [];
            const given = params || {};
            const merged = given.focusPoint ? { ...given, focusPoint: focusPointToLocal(ctx, scene, given.focusPoint) } : given;
            const lens = mergeCameraLens(scene.camera.lens, merged, fov, warnings);
            const camera = { ...scene.camera };
            if (lens) camera.lens = lens;
            else delete camera.lens;
            scene.camera = camera;
            const plan = planViewportOptics(lens);
            return { lens: lens ?? null, passes: plan.passes, issues: [...plan.issues, ...warnings] };
        }
    },
    {
        name: 'sb_set_color_harmony',
        category: 'lighting_camera',
        description: 'Puts a colour harmony grade on the viewport: every hue on the scene\'s objects moves toward the nearest sector of a hue template turned to hueDeg (degrees on the OKLCH hue circle: about 30 red, 110 yellow, 145 green, 265 blue), keeping lightness so shading and texture stay. sectors: 1-8 { offsetDeg, widthDeg } relative to hueDeg (default one 94 degree sector; e.g. two 18 degree sectors at 0 and 180 for complementary colours). strength 0-1 (default 1), chroma 0-2 saturation scale (default 1), tint 0-1 colour added at hueDeg so neutral surfaces such as clay take the colour too (default 0; a harmony alone cannot move a grey, which has no hue). Only the scene\'s objects are graded, never the sky or background. A field given replaces it, null resets it; clear removes the grade. A viewport grade: materials are unchanged.',
        execute: (ctx, params: SetColorHarmonyParams) => {
            const scene = ctx.getSceneData();
            const harmony = mergeColorHarmony(scene.colorHarmony, params || {});
            if (harmony) scene.colorHarmony = harmony;
            else delete scene.colorHarmony;
            const plan = planColorHarmony(harmony);
            return { colorHarmony: harmony ?? null, drawn: !!plan.harmony, issues: plan.issues };
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
                const byId = new Map(meshes.map(m => [m.id ?? '', m] as [string, typeof m]));
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
