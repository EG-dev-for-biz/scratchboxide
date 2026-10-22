/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Example prompts for the new-chat starter buttons. A button with several examples sends a random one, never the one
 * it sent last, so repeated clicks show different things the app can do. These are only example request texts typed
 * on the user's behalf: nothing routes on them, and the model treats them like any other request.
 */

export interface StarterButton {
    icon: string;
    label: string;
    /** One or more example requests; one is picked per click. */
    prompts: readonly string[];
}

export const STARTER_BUTTONS: readonly StarterButton[] = [
    { icon: '✨', label: 'Interactive App', prompts: ['Build an interactive audio visualizer app with responsive controls'] },
    {
        icon: '🪐',
        label: '3D Scene',
        // A real district in a major city: the request routes to the staged Google 3D Tiles build (prompt-builder.ts),
        // which remeshes and resurfaces every building, applies the real textures and regrows the measured trees.
        // Stays in district mode deliberately (not isolate: true) - that is a different build shape (one structure,
        // no surrounding streets/trees), not a "cleaner" version of this one. "textured" and the mood/sun clause are
        // said outright: textures are the default, and the sky dome, scattering and solar ephemeris are opt-in
        // (AGENTS.md §3.6), so the words must be in the request. 2026-10-21 (user ask): raised and cooled from a full
        // golden hour (~20 deg elevation, a gentler warmth) so shadow regions read less crushed/near-black, and the
        // azimuth is asked from the place's own real solar geometry rather than a fixed number - there is no tool
        // that reads the sun direction baked into the tile imagery itself (investigated: the closest prior work,
        // tile-sun/measured-brdf, is archived and unported), so this is the closest honest approximation, not a
        // measured match. This button's own chosen mood, not a general build default elsewhere.
        // 2026-10-21 (user ask): a dozen impressive town centres, skewed toward New York (5 of 12 - the places this
        // session verified build cleanly: stepped/setback massing from the scan's own heightfield, de-lit textures,
        // and working SB-Veggie trees after this session's native crash fix), each with real street trees so the
        // tree stage has something to show - a deliberate curated set for this quickstart button, not a limit on
        // what a user can type in chat: any place can still be asked for directly, this only narrows the button's
        // own examples.
        prompts: [
            'Build a textured 3D scene of Central Park in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of the Flatiron District in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Union Square in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Washington Square Park in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Bryant Park in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Shibuya Crossing in Tokyo with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Trafalgar Square in London with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Potsdamer Platz in Berlin with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Dam Square in Amsterdam with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Marina Bay in Singapore with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Piazza del Duomo in Milan with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Federation Square in Melbourne with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
        ],
    },
    { icon: '🎬', label: 'Video NLE', prompts: ['Assemble a multi-track video timeline with color grading and title graphics'] },
    {
        icon: '📄',
        label: 'System Spec',
        prompts: [
            'Draft a technical architecture specification with interface invariants',
            'Draft a technical specification for an offline-first note-taking app with end-to-end encrypted sync',
            'Draft a technical specification for a real-time multiplayer game server with lag compensation',
            'Draft a technical specification for a payment service with idempotent retries and an audit log',
            'Draft a technical specification for over-the-air firmware updates on a fleet of smart thermostats',
            'Draft a technical specification for a video transcoding pipeline running on cloud workers',
            'Draft a technical specification for a hospital bed-tracking system with role-based access',
            'Draft a technical specification for a drone delivery fleet’s flight-planning service',
            'Draft a technical specification for a search autocomplete service handling 50,000 queries per second',
            'Draft a technical specification for a library book reservation API with waitlists',
        ],
    },
    {
        icon: '📊',
        label: 'KPI Dashboard',
        prompts: [
            'Dashboard for real-time telemetry metrics and system throughput',
            'Dashboard for an online store: daily revenue, conversion rate, cart abandonment and top products',
            'Dashboard for a hospital emergency department: wait times, bed occupancy and triage levels',
            'Dashboard for a solar farm: power output, panel efficiency, inverter health and weather',
            'Dashboard for a SaaS product: monthly recurring revenue, churn, activation and NPS',
            'Dashboard for a city bike-share network: trips per hour, dock availability and rebalancing',
            'Dashboard for a coffee roastery: batches roasted, roast profiles, green bean inventory and wholesale orders',
            'Dashboard for a customer support team: ticket volume, first response time, resolution rate and satisfaction',
            'Dashboard for a warehouse: orders picked per hour, pick accuracy, backlog and late shipments',
            'Dashboard for a podcast network: downloads, listener retention, ad fill rate and top episodes',
        ],
    },
];

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
