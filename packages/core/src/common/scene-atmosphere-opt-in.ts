/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { Scene3DData } from '../browser/generative-canvas/canvas-types';
import type { VisualCorrectionFixes } from './visual-verification-protocol';

/** Feature flags whose presence on a scene means it already asked for a sky or weather. */
const SKY_FEATURE_KEYS = [
    'atmosphericScattering', 'diurnalLighting', 'volumetricClouds', 'clouds',
    'terrainCloudShadows', 'aerialPerspective'
];

/**
 * AGENTS.md opt-in gate: feature flags that put sky, weather, light shafts or glow into a scene.
 * God rays and bloom are carried here too, but neither opts a scene into a sky on its own.
 */
export const ATMOSPHERE_FEATURE_KEYS: readonly string[] = [...SKY_FEATURE_KEYS, 'godRays', 'bloomPass'];

/**
 * A scene's chosen environment, which a visual audit and its operators never change in either
 * direction (switching a sky on or off, swapping the skybox, leaving or entering clay, moving the
 * world or the ground). Repairs keep to lighting and camera framing.
 */
const ENVIRONMENT_FEATURE_KEYS = [...ATMOSPHERE_FEATURE_KEYS, 'terrainBiomes'];
const ENVIRONMENT_BLOCK_KEYS = ['skybox', 'fog', 'aerialPerspective', 'cloudShadows', 'timeOfDay', 'ground', 'groundTileMode'];
/** `classifyAtmosphere` reads `atmosphere` beside `features.atmosphericScattering`. */
const ENVIRONMENT_SCENE_KEYS = ['atmosphere', 'atmosphericScattering', 'worldBranch', 'renderMode', 'groundTileMode'];

function isSwitchedOn(value: unknown): boolean {
    return value === true || (typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled !== false);
}

/** True when the scene's own fields already ask for a sky: an enabled atmosphere carrier or a `sky` skybox. */
export function sceneOptsIntoAtmosphere(scene: Partial<Scene3DData> | undefined): boolean {
    if (!scene) return false;
    const features: Record<string, unknown> = scene.features || {};
    const loose = scene as { atmosphere?: unknown; atmosphericScattering?: unknown };
    return SKY_FEATURE_KEYS.some(k => isSwitchedOn(features[k]))
        || isSwitchedOn(loose.atmosphere)
        || isSwitchedOn(loose.atmosphericScattering)
        || scene.environment?.skybox === 'sky';
}

/** Scene3DPrimitive renders clay unless the scene names another mode. */
export function sceneRendersClay(scene: Partial<Scene3DData> | undefined): boolean {
    return (scene?.renderMode ?? 'clay') === 'clay';
}

/**
 * An atmosphere config that places the sun explicitly (an enabled object with a finite sunElevation and sunAzimuth, as
 * sb_set_diurnal_time_of_day and atmosphere_configure_scene write): the user asked for that sun, so a clay scene draws
 * it, its shadows and its sky too.
 */
export function hasExplicitSun(atmosphere: unknown): boolean {
    if (typeof atmosphere !== 'object' || atmosphere === null) return false;
    const a = atmosphere as { enabled?: unknown; sunElevation?: unknown; sunAzimuth?: unknown };
    return a.enabled !== false && typeof a.sunElevation === 'number' && Number.isFinite(a.sunElevation) && typeof a.sunAzimuth === 'number' && Number.isFinite(a.sunAzimuth);
}

/**
 * True when the renderer draws a sky for this scene: it opts into one and either does not render clay or places the sun
 * explicitly (`classifyAtmosphere` suppresses the sky in clay otherwise, even when the scene keeps atmosphere settings).
 */
export function sceneShowsSky(scene: Partial<Scene3DData> | undefined): boolean {
    const loose = scene as { atmosphere?: unknown } | undefined;
    return sceneOptsIntoAtmosphere(scene) && (!sceneRendersClay(scene) || hasExplicitSun(scene?.features?.atmosphericScattering) || hasExplicitSun(loose?.atmosphere));
}

function withoutKeys<T extends object>(block: T | undefined, keys: string[]): T | undefined {
    if (!block) return block;
    const out = { ...block } as Record<string, unknown>;
    keys.forEach(k => delete out[k]);
    return Object.keys(out).length > 0 ? out as T : undefined;
}

function withoutUndefined<T extends object>(block: T): T {
    const out = { ...block } as Record<string, unknown>;
    Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
    return out as T;
}

/** Audit fixes minus everything that would change the scene's chosen environment, for any scene. */
export function withoutEnvironmentChanges(fixes: VisualCorrectionFixes): VisualCorrectionFixes {
    const out: VisualCorrectionFixes = {
        ...fixes,
        features: withoutKeys(fixes.features, ENVIRONMENT_FEATURE_KEYS),
        environment: withoutKeys(fixes.environment, ENVIRONMENT_BLOCK_KEYS)
    };
    if (fixes.scenePatches) {
        // Patched environment / features blocks keep their other keys (a lighting rig, PBR flags).
        const patches = withoutUndefined({
            ...fixes.scenePatches,
            environment: withoutKeys(fixes.scenePatches.environment, ENVIRONMENT_BLOCK_KEYS),
            features: withoutKeys(fixes.scenePatches.features, ENVIRONMENT_FEATURE_KEYS)
        });
        out.scenePatches = withoutKeys(patches, ENVIRONMENT_SCENE_KEYS);
    }
    return withoutUndefined(out);
}

function copyKeys(target: Record<string, unknown>, source: Record<string, unknown> | undefined, keys: string[]): void {
    for (const k of keys) {
        if (source?.[k] !== undefined) target[k] = JSON.parse(JSON.stringify(source[k]));
        else delete target[k];
    }
}

function restoreBlock(after: Record<string, unknown>, before: Record<string, unknown>, block: string, keys: string[]): void {
    const source = before[block] as Record<string, unknown> | undefined;
    const target = { ...((after[block] as Record<string, unknown> | undefined) || {}) };
    copyKeys(target, source, keys);
    if (source === undefined && Object.keys(target).length === 0) delete after[block];
    else after[block] = target;
}

/**
 * Puts `before`'s chosen environment back onto `after` (the scene once an audit's operator ran),
 * keeping the operator's other effects, such as a lighting preset, its rig and sun angles.
 */
export function restoreChosenEnvironment(after: Scene3DData, before: Scene3DData): void {
    const target = after as unknown as Record<string, unknown>;
    const source = before as unknown as Record<string, unknown>;
    copyKeys(target, source, ENVIRONMENT_SCENE_KEYS);
    restoreBlock(target, source, 'features', ENVIRONMENT_FEATURE_KEYS);
    restoreBlock(target, source, 'environment', ENVIRONMENT_BLOCK_KEYS);
}
