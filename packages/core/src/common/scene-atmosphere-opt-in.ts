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

/** What a visual audit may not add to a scene that never asked for a sky. */
const FIX_FEATURE_CARRIERS = [...ATMOSPHERE_FEATURE_KEYS, 'terrainBiomes'];
const FIX_ENVIRONMENT_CARRIERS = ['skybox', 'fog', 'aerialPerspective', 'cloudShadows'];
/** `classifyAtmosphere` reads `atmosphere` beside `features.atmosphericScattering`; an `environment` or `features` patch can rewrite the whole block. */
const FIX_SCENE_CARRIERS = ['atmosphere', 'atmosphericScattering', 'worldBranch', 'environment', 'features', 'renderMode'];

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

function withoutKeys<T extends object>(block: T | undefined, keys: string[]): T | undefined {
    if (!block) return block;
    const out = { ...block } as Record<string, unknown>;
    keys.forEach(k => delete out[k]);
    return Object.keys(out).length > 0 ? out as T : undefined;
}

/**
 * Audit fixes minus every atmosphere carrier, unless the scene already opts into a sky (then the
 * audit may tune it). A clay scene keeps its render mode either way: clay is a choice too.
 */
export function withoutUninvitedAtmosphere(fixes: VisualCorrectionFixes, scene: Partial<Scene3DData> | undefined): VisualCorrectionFixes {
    const optedIn = sceneOptsIntoAtmosphere(scene);
    const keepsClay = sceneRendersClay(scene);
    if (optedIn && !keepsClay) return fixes;

    const out: VisualCorrectionFixes = { ...fixes };
    out.scenePatches = withoutKeys(fixes.scenePatches, optedIn ? ['renderMode'] : FIX_SCENE_CARRIERS);
    if (!optedIn) {
        out.features = withoutKeys(fixes.features, FIX_FEATURE_CARRIERS);
        out.environment = withoutKeys(fixes.environment, FIX_ENVIRONMENT_CARRIERS);
    }
    for (const k of Object.keys(out) as Array<keyof VisualCorrectionFixes>) {
        if (out[k] === undefined) delete out[k];
    }
    return out;
}

function atmosphereCarrierValues(scene: Partial<Scene3DData>): string {
    const features: Record<string, unknown> = scene.features || {};
    const environment: Record<string, unknown> = scene.environment || {};
    const loose = scene as Record<string, unknown>;
    return JSON.stringify([
        FIX_FEATURE_CARRIERS.map(k => features[k] ?? null),
        FIX_ENVIRONMENT_CARRIERS.map(k => environment[k] ?? null),
        ['atmosphere', 'atmosphericScattering', 'worldBranch', 'renderMode'].map(k => loose[k] ?? null)
    ]);
}

/** True when `after` (the scene once an audit's operator ran) changes what `withoutUninvitedAtmosphere` protects in `before`. */
export function auditChangesChosenEnvironment(before: Partial<Scene3DData>, after: Partial<Scene3DData>): boolean {
    if (sceneRendersClay(before) && !sceneRendersClay(after)) return true;
    if (sceneOptsIntoAtmosphere(before)) return false;
    return atmosphereCarrierValues(before) !== atmosphereCarrierValues(after);
}
