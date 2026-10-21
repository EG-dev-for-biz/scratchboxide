/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { Scene3DData } from '../../browser/generative-canvas/canvas-types';
import { ATMOSPHERE_FEATURE_KEYS, DEFAULT_SCENE_RENDER_MODE } from '../../common/scene-atmosphere-opt-in';

type RenderMode = NonNullable<Scene3DData['renderMode']>;

/** AGENTS.md opt-in gate: atmosphere only when the user's words ask for it. */
const ATMOSPHERE_OPT_IN = /\b(?:sky|skies|atmospher\w*|clouds?|cloudy|sunset|sunrise|dusk|dawn|twilight|golden\s*hour|weather|fog\w*|mist\w*|haze|god\s*rays?|scattering)\b/i;

/**
 * The user's own words asking for the untextured look (AGENTS.md: textured by default, clay on request). Like the
 * atmosphere gate it reads only an explicit request for a render look, never what the scene is of.
 */
const CLAY_REQUEST = /\b(?:clay|untextured|un-textured|no\s+(?:textures?|materials?)|gr[ae]y\s*-?box\w*|white\s*-?box\w*|massing\s+(?:model|only|study))\b/i;

/** Whether the prompt asks for the scene in clay (or untextured). */
export function userAsksForClay(prompt: string | undefined): boolean {
    return !!prompt && CLAY_REQUEST.test(prompt);
}

/**
 * The render mode a first-pass scene opens in: clay when the user asked for it, else the mode the model authored, else
 * the textured default ('pbr': each surface's own material).
 */
export function firstPassRenderMode(prompt: string | undefined, authored?: unknown): RenderMode {
    if (userAsksForClay(prompt)) return 'clay';
    return typeof authored === 'string' && authored.trim() ? authored as RenderMode : DEFAULT_SCENE_RENDER_MODE;
}

/**
 * First-pass cameras come with physical lens optics on (user decision 2026-10-21): continuous autofocus (no upfront
 * focus distance to get wrong, no "lens optics not fully drawn" notice from a manual focus with nothing to focus on)
 * and a narrow, shallow depth of field.
 *
 * The circle-of-confusion math (viewportOptics.ts) reads `focalLengthMm` on its own terms: it does not change the
 * scene's actual field of view (that stays whatever the camera authored), it only emulates the sensor-relative optics
 * of a lens that happens to produce that FOV at this focal length - exactly how real lens-equivalence emulation
 * works. Leaving it unset (as this did before 2026-10-21) derives one FROM the scene's field of view on an assumed
 * 36 x 24 mm sensor: at the usual ~45 deg FOV that is only about a 29 mm wide-normal lens, which stays close to deep
 * focus at any f-stop - a typical staged shot (an 8 m foreground subject, a 30+ m background) blurred to under a
 * pixel radius at f/2.8, reading as not shallow at all. 135 mm at f/2 (a classic portrait/product focal length) gives
 * the same shot a several-pixel blur radius, clearly soft without ever approaching the renderer's own blur-radius
 * cap (MAX_BLUR_RADIUS_FRAME_FRACTION), since the underlying physics stays honest either way.
 *
 * A model that authors its own `camera.lens` (including just its own focalLengthMm or apertureFStop) keeps it
 * unchanged, same precedence as renderMode.
 */
const DEFAULT_CAMERA_LENS = { depthOfField: true, focusMode: 'auto' as const, apertureFStop: 2, focalLengthMm: 135 };

/**
 * First-pass 3D scenes open textured (user decision 2026-10-19: textured by default, clay on request): the materials
 * the model or the engine authored are kept and the render mode is firstPassRenderMode. Sky and atmosphere the model
 * authored on its own are dropped unless the prompt explicitly asks for them (the AGENTS.md opt-in gate); geometry,
 * materials, camera and geodetic anchoring pass through unchanged except for the camera lens default above.
 */
export function applyFirstPassBaseline<T extends Record<string, any>>(data: T, prompt: string): T {
    const wantsAtmosphere = ATMOSPHERE_OPT_IN.test(prompt);
    const out: Record<string, any> = { ...data };
    const features: Record<string, any> = { ...(data.features || {}) };

    if (!wantsAtmosphere) {
        ATMOSPHERE_FEATURE_KEYS.forEach(k => delete features[k]);
        delete out.atmosphere;
        delete out.atmosphericScattering;
        out.environment = { lighting: 'studio', skybox: 'studio', ground: data.environment?.ground ?? true };
    }
    out.renderMode = firstPassRenderMode(prompt, data.renderMode);
    out.features = features;
    if (data.camera && !data.camera.lens) out.camera = { ...data.camera, lens: { ...DEFAULT_CAMERA_LENS } };
    return out as T;
}

/**
 * A scene mounted while another is open keeps the open scene's render mode unless the model's data sets one, so a
 * user's explicit clay (or textured) choice persists across follow-ups. Changing it is the model's decision (it sends
 * renderMode), never a colour word in the prompt.
 */
export function keepOpenSceneRenderMode<T extends Record<string, any>>(data: T, openRenderMode: string | undefined): T {
    if (data.renderMode !== undefined || openRenderMode === undefined) return data;
    return { ...data, renderMode: openRenderMode };
}
