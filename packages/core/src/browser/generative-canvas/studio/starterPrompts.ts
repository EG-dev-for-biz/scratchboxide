/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { PrimitiveType } from '../canvas-types';
import { canCreatePrimitive, isScopedTo3dVfx } from '../../../common/product-scope';

/**
 * Example prompts for the new-chat starter buttons. A button with several examples sends a random one, never the one
 * it sent last, so repeated clicks show different things the app can do. These are only example request texts typed
 * on the user's behalf: nothing routes on them, and the model treats them like any other request.
 */

export interface StarterButton {
    icon: string;
    label: string;
    /** The canvas the request makes; the 3D/VFX build (common/product-scope.ts) hides a button for any other. */
    makes: PrimitiveType;
    /** One or more example requests; one is picked per click. */
    prompts: readonly string[];
    /**
     * A world already built: the button opens it in a 3D Scene straight away, by its folder name `slug` through
     * /api/worlds (its newest saved version, else the Scene3DData location_generate_3dgs wrote beside its tileset,
     * `scenePath`; its files fetched from the world cache when not on this machine). When neither is there it sends its
     * prompt, which builds the world.
     */
    world?: { slug: string; scenePath: string; title: string };
}

/** The splat world on 7th Avenue's west sidewalk at the Penn Station / Madison Square Garden entrance (built 2026-10-29). */
export const PENN_STATION_WORLD_SLUG = '7th_avenue_west_32nd_street_new_york_40.74974_-73.99163';
export const PENN_STATION_WORLD_DIR = `/tilesets/${PENN_STATION_WORLD_SLUG}`;

export const STARTER_BUTTONS: readonly StarterButton[] = [
    // Each button sends a plain request and never a canned example: a request that names no place, subject or app makes the
    // chat ask which one it means before anything is built (SPATIAL_INTENT_POLICY, prompt-builder.ts).
    { icon: '✨', label: 'Interactive App', makes: 'live-code-sandbox', prompts: ['Make an interactive app'] },
    { icon: '🪐', label: '3D Scene', makes: '3d-scene', prompts: ['Make a 3D scene'] },
    { icon: '🏛️', label: '3D Building', makes: '3d-scene', prompts: ['Make a 3D building'] },
    {
        icon: '🌐',
        label: '3D World',
        makes: '3d-scene',
        prompts: ['Make a walkable 3D world'],
        // The one shortcut: a splat world already built (user ask, 2026-10-29) opens straight away; without it the chat asks.
        world: { slug: PENN_STATION_WORLD_SLUG, scenePath: `${PENN_STATION_WORLD_DIR}/scene3d.json`, title: '7th Ave at Penn Station - splat world' },
    },
    { icon: '🎬', label: 'Video NLE', makes: 'video-timeline', prompts: ['Make a video timeline'] },
];

/** The starter buttons this build offers: all of them, or in the 3D/VFX build those that make a 3D scene or a timeline. */
export function visibleStarterButtons(): readonly StarterButton[] {
    return STARTER_BUTTONS.filter(button => canCreatePrimitive(button.makes));
}

/** The home page's headline: in the 3D/VFX build it names only what the build makes. */
export function homeHeadline(): string {
    return isScopedTo3dVfx()
        ? 'A canvas for 3D and VFX work. What scene or shot can I help you build today?'
        : 'A canvas for AI work. What can I help you design, build, or analyze today?';
}

const LAST_KEY = 'sb.starterPrompt.last.';

/**
 * Picks the prompt a starter button sends: a random example, never the one the same button sent last (when it has more
 * than one). `random` returns [0, 1); `storage` remembers the last pick per button and may be absent or throw.
 */
export function pickStarterPrompt(button: StarterButton, random: () => number = Math.random, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeLocalStorage()): string {
    const prompts = button.prompts;
    if (prompts.length === 0) throw new Error(`Starter button "${button.label}" has no prompts.`);
    if (prompts.length === 1) return prompts[0];
    let last: string | null = null;
    try { last = storage?.getItem(LAST_KEY + button.label) ?? null; } catch { last = null; }
    const choices = prompts.filter(p => p !== last);
    const pick = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
    try { storage?.setItem(LAST_KEY + button.label, pick); } catch { /* storage unavailable: repeats are only less unlikely */ }
    return pick;
}

function safeLocalStorage(): Storage | undefined {
    try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}
