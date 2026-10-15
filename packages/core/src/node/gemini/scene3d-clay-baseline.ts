/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { ATMOSPHERE_FEATURE_KEYS } from '../../common/scene-atmosphere-opt-in';

/** AGENTS.md opt-in gate: atmosphere only when the user's words ask for it. */
const ATMOSPHERE_OPT_IN = /\b(?:sky|skies|atmospher\w*|clouds?|cloudy|sunset|sunrise|dusk|dawn|twilight|golden\s*hour|weather|fog\w*|mist\w*|haze|god\s*rays?|scattering)\b/i;

const MATERIAL_FEATURE_KEYS = ['pbrMaterials', 'multiLayerWeathering', 'proceduralTextures', 'pbrTextures'];

/**
 * First-pass 3D scenes are grey clay massing in a neutral studio, whatever the prompt says about colour or
 * materials (user decision: everything is built in clay first; materials are a follow-up). Sky and atmosphere the
 * model authored on its own are dropped unless the prompt explicitly asks for them (the AGENTS.md opt-in gate);
 * geometry, camera and geodetic anchoring pass through unchanged.
 */
export function applyClayFirstPassBaseline<T extends Record<string, any>>(data: T, prompt: string): T {
    const wantsAtmosphere = ATMOSPHERE_OPT_IN.test(prompt);
    const out: Record<string, any> = { ...data };
    const features: Record<string, any> = { ...(data.features || {}) };

    if (!wantsAtmosphere) {
        ATMOSPHERE_FEATURE_KEYS.forEach(k => delete features[k]);
        delete out.atmosphere;
        delete out.atmosphericScattering;
        out.environment = { lighting: 'studio', skybox: 'studio', ground: data.environment?.ground ?? true };
    }
    MATERIAL_FEATURE_KEYS.forEach(k => delete features[k]);
    out.renderMode = 'clay';
    out.features = features;
    return out as T;
}

/**
 * A scene mounted while another is open keeps the open scene's render mode unless the model's data sets one.
 * Leaving clay for surface materials is the model's decision (it sends renderMode), never a colour word in the prompt.
 */
export function keepOpenSceneRenderMode<T extends Record<string, any>>(data: T, openRenderMode: string | undefined): T {
    if (data.renderMode !== undefined || openRenderMode === undefined) return data;
    return { ...data, renderMode: openRenderMode };
}
