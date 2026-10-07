/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** AGENTS.md opt-in gate: atmosphere only when the user's words ask for it. */
const ATMOSPHERE_OPT_IN = /\b(?:sky|skies|atmospher\w*|clouds?|cloudy|sunset|sunrise|dusk|dawn|twilight|golden\s*hour|weather|fog\w*|mist\w*|haze|god\s*rays?|scattering)\b/i;
const MATERIAL_OPT_IN = /\b(?:materials?|textur(?:e|es|ed|ing)|pbr|shaders?|paint(?:ed)?|finish(?:es)?|photoreal\w*|albedo)\b/i;

const ATMOSPHERE_FEATURE_KEYS = [
    'atmosphericScattering', 'godRays', 'diurnalLighting', 'volumetricClouds', 'clouds',
    'terrainCloudShadows', 'aerialPerspective', 'bloomPass'
];
const MATERIAL_FEATURE_KEYS = ['pbrMaterials', 'multiLayerWeathering', 'proceduralTextures', 'pbrTextures'];

/**
 * First-pass 3D scenes are grey clay massing in a neutral studio. Sky, atmosphere and surface
 * materials the model authored on its own are dropped unless the prompt explicitly asks for them;
 * geometry, camera and geodetic anchoring pass through unchanged.
 */
export function applyClayFirstPassBaseline<T extends Record<string, any>>(data: T, prompt: string): T {
    const wantsAtmosphere = ATMOSPHERE_OPT_IN.test(prompt);
    const wantsMaterials = MATERIAL_OPT_IN.test(prompt);
    const out: Record<string, any> = { ...data };
    const features: Record<string, any> = { ...(data.features || {}) };

    if (!wantsAtmosphere) {
        ATMOSPHERE_FEATURE_KEYS.forEach(k => delete features[k]);
        delete out.atmosphere;
        delete out.atmosphericScattering;
        out.environment = { lighting: 'studio', skybox: 'studio', ground: data.environment?.ground ?? true };
    }
    if (!wantsMaterials) {
        MATERIAL_FEATURE_KEYS.forEach(k => delete features[k]);
        out.renderMode = 'clay';
    }
    out.features = features;
    return out as T;
}

/** Follow-up turns on a clay scene leave clay only when the user's words ask for surface materials. */
export function releaseClayOnMaterialRequest<T extends Record<string, any>>(data: T, prompt: string, activeRenderMode: string | undefined): T {
    if (activeRenderMode !== 'clay') return data;
    if (!MATERIAL_OPT_IN.test(prompt)) return { ...data, renderMode: 'clay' };
    const mode = data.renderMode;
    return { ...data, renderMode: mode && mode !== 'clay' ? mode : 'pbr' };
}
