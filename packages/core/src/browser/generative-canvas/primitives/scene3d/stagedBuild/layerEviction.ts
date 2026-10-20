/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which superseded staged layers the viewport frees (pure). A layer another layer replaced (its `supersedes` or
 * `crossfadeFrom`) is hidden once the replacement has revealed, but its model stays loaded: on a dense block that is the
 * remesh (`l2`, 55-88 MB of geometry) under the grammar layer. Such a layer is EVICTED: its model is released (GPU
 * buffers and textures disposed, CPU arrays dropped) and only its scene object (URL and metadata) stays, so it loads
 * again when something needs it: "Show replaced layers" (a ghost), "Replay build", or the replacement going away.
 *
 * Never evicted: a layer that is showing (not hidden), a clay <-> textured swap layer or a layer whose twin is engaged
 * (the clay copy under its twin is the same geometry the toggle brings straight back), a layer replaced only by a swap
 * layer, and anything while an opt-in view that draws replaced layers is on. A layer must stay hidden for
 * `EVICT_AFTER_MS` first, so a quick toggle does not reload it.
 */

import type { StagedBuildState, StagedLayer } from '../../../../../common/spatial/staged-location-contracts';
import type { LayerRevealFrame } from './revealScheduler';
import { isMaterialSwapLayer } from './texturedTwins';

/** How long a superseded layer stays hidden before its model is freed. */
export const EVICT_AFTER_MS = 2000;

export interface EvictionInput {
    /** The scheduler's layers (the build's plus the swap layers of the current switch). */
    state: StagedBuildState;
    frame: { layers: ReadonlyArray<Pick<LayerRevealFrame, 'objectId' | 'phase' | 'hidden' | 'loadFailed'>>; animating: boolean };
    /** Layers whose textured twin is engaged (by layer id). */
    engaged: ReadonlyMap<string, unknown>;
    /** Opt-in views that draw replaced layers: "Show replaced layers" and "Replay build". */
    showReplaced: boolean;
    replaying: boolean;
}

/** The layers that may be evicted now (before the hidden-for-a-while delay). */
export function evictionCandidates(input: EvictionInput): Set<string> {
    const out = new Set<string>();
    if (input.showReplaced || input.replaying || input.frame.animating) return out;
    const phaseOf = new Map(input.frame.layers.map(f => [f.objectId, f.phase] as const));
    /** Revealed (or retired) layers that are not swap layers: what can replace a layer for good. */
    const replacers: StagedLayer[] = input.state.layers.filter(l => !isMaterialSwapLayer(l) && (phaseOf.get(l.objectId) === 'revealed' || phaseOf.get(l.objectId) === 'retired'));
    for (const f of input.frame.layers) {
        if (!f.hidden || f.phase !== 'revealed' || f.loadFailed) continue;
        if (isMaterialSwapLayer(f) || input.engaged.has(f.objectId)) continue;
        if (!replacers.some(r => r.objectId !== f.objectId && (r.supersedes.includes(f.objectId) || r.reveal.crossfadeFrom.includes(f.objectId)))) continue;
        out.add(f.objectId);
    }
    return out;
}

/**
 * Tracks how long each candidate has been one and returns the set to evict: candidates hidden for at least
 * `delayMs`. `since` (object id -> first seen as a candidate) is updated in place; `nextCheckMs` is when the
 * next candidate becomes due (undefined when none is waiting).
 */
export function stepEviction(candidates: ReadonlySet<string>, since: Map<string, number>, nowMs: number, delayMs: number = EVICT_AFTER_MS): { evict: Set<string>; nextCheckMs?: number } {
    for (const id of [...since.keys()]) if (!candidates.has(id)) since.delete(id);
    const evict = new Set<string>();
    let next: number | undefined;
    for (const id of candidates) {
        const t = since.get(id) ?? nowMs;
        since.set(id, t);
        if (nowMs - t >= delayMs) evict.add(id);
        else next = Math.min(next ?? Infinity, t + delayMs);
    }
    return { evict, ...(next !== undefined ? { nextCheckMs: next } : {}) };
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}
