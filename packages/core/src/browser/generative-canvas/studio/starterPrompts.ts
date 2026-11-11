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
     * /api/worlds (its newest saved version, else the Scene3DData beside it, `scenePath`: a splat world's from
     * location_generate_3dgs, a district's from scripts/publish_district_world.ts; its files fetched from the world cache
     * when not on this machine). When neither is there it sends its prompt, which builds one.
     */
    world?: { slug: string; scenePath: string; title: string };
}

/** The splat world on 7th Avenue's west sidewalk at the Penn Station / Madison Square Garden entrance (built 2026-10-29). */
export const PENN_STATION_WORLD_SLUG = '7th_avenue_west_32nd_street_new_york_40.74974_-73.99163';
export const PENN_STATION_WORLD_DIR = `/tilesets/${PENN_STATION_WORLD_SLUG}`;

/**
 * A district already massed: the Penn Station district around 2 Penn Plaza (pipeline K-D, run 8e3a912b with its centre on
 * Cloud Run, 250 m, built 2026-11-03), kept as a world (scripts/publish_district_world.ts). No starter button opens it since 2026-11-11: the 3D Scene
 * button asks where.
 */
export const PENN_DISTRICT_WORLD_SLUG = 'penn_station_district_2_penn_plaza';
export const PENN_DISTRICT_WORLD_DIR = `/tilesets/${PENN_DISTRICT_WORLD_SLUG}`;

export const STARTER_BUTTONS: readonly StarterButton[] = [
    { icon: '✨', label: 'Interactive App', makes: 'live-code-sandbox', prompts: ['Make an interactive app'] },
    // 3D Scene and 3D Building send a plain request that names no place, so the chat asks where (SPATIAL_INTENT_POLICY,
    // prompt-builder.ts) before anything is built. Neither opens a prebuilt place (user decision, 2026-11-11: the
    // 3D Scene button opened the massed Penn district, or did nothing on a machine without it).
    { icon: '🪐', label: '3D Scene', makes: '3d-scene', prompts: ['Make a 3D scene'] },
    {
        icon: '🏛️',
        label: '3D Building',
        makes: '3d-scene',
        // The Empire State Building, the building-generator benchmark (2026-10-26), straightened by pipeline K
        // (google_3d_tiles_get_clay with isolate; pipeline-k/, the default for one building since 2026-10-26, user decision):
        // the remeshed scan's walls flat on their fitted planes, each facade photo's pier and storey lines traced and warped
        // straight, its holes and smears filled and levelled from the facade's own repeats, the facades rebuilt on those
        // photos with no tear left. One prompt, so the button always sends it (user decision 2026-10-26: no randomizer).
        prompts: ['Make a 3D building'],
    },
    {
        icon: '🧩',
        label: '3D Object',
        makes: '3d-scene',
        // One object with no real place (user ask, 2026-11-03): the request routes to build_3d_object_from_reference
        // (prompt-builder.ts, "One specific object or an abstract form"), which draws an internal reference, reads it into
        // a build spec and builds that one object natively from the engine's operators. Examples only, picked at random
        // per click, chosen to show different kinds of form (turned, swept, repeated, hard-surface, soft); any object can
        // still be asked for in chat.
        prompts: ['Make a 3D object'],
    },
    {
        icon: '🌐',
        label: '3D World',
        makes: '3d-scene',
        // A walkable Gaussian splat world (user ask, 2026-10-29): standing on 7th Avenue's west sidewalk at the Penn Station /
        // Madison Square Garden entrance, looking east across the avenue, built from registered Street View and the 3D
        // tiles (location_generate_3dgs with a street vantage). Opens the world already built; without it, builds it.
        prompts: ['Make a walkable 3D world'],
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
