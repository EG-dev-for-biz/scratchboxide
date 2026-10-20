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
        prompts: [
            'Build a procedural 3D sci-fi exploration environment with terrain and lighting',
            'Build a 3D model of a vintage brass diving helmet with riveted seams and a glass faceplate',
            'Build the Flatiron Building in New York as a 3D scene',
            'Build a 3D model of a 1960s red scooter with chrome trim',
            'Build a procedural 3D desert canyon with layered sandstone cliffs',
            'Build the Colosseum in Rome as a 3D scene',
            'Build a 3D model of a lighthouse on a rocky headland',
            'Build a 3D model of a steam locomotive with brass fittings',
            'Build a 3D model of a bonsai tree in a glazed ceramic pot',
            'Build the Sydney Opera House as a 3D scene',
            'Build a 3D model of a mid-century modern armchair in walnut and leather',
            'Build a 3D model of an alien seed pod with translucent glowing chambers',
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
