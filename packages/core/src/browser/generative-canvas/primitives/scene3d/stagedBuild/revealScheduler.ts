/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged location builds: when each committed layer reveals, how far along it is, and what fades out under it
 * (design §7.1). Pure: the hook feeds it the build state, each layer's load status and the time, and keeps the
 * returned schedule for the next frame. It reads only the layer records (order, revealAfter, supersedes,
 * crossfadeFrom, durations, cached) and the stage lifecycle, never a stage, layer or label name.
 */

import type { StagedBuildState, StagedLayer, StageStatus } from '../../../../../common/spatial/staged-location-contracts';

/** A layer's model in the viewport: loaded and attached (`ready`), still loading, or failed to load. */
export interface LayerLoadState {
    ready: boolean;
    /** Clock time the layer became ready (its first frame after the loader attached it). */
    readyAtMs?: number;
    failed?: boolean;
}

export interface RevealInput {
    state: StagedBuildState;
    /** By StagedLayer.objectId. */
    loads: Readonly<Record<string, LayerLoadState>>;
    nowMs: number;
    /** prefers-reduced-motion: every reveal shows its end state at once. */
    reducedMotion: boolean;
    /** The run was stopped or interrupted: committed layers jump to their end state and nothing animates. */
    settled: boolean;
    /** Why reveals are skipped right now (frame time, hidden document, size); undefined = animate. */
    skipReason?: string;
    /** Bumped by "Replay build": every loaded layer reveals again from 0, in canonical order. */
    replayEpoch: number;
    /** A per-layer reason to show the end state at once (a layer too large to animate); undefined = animate. */
    skipLayer?: (layer: StagedLayer) => string | undefined;
}

export interface LayerTimeline {
    startedAtMs: number;
    durationMs: number;
    endedAtMs?: number;
    /** Ids of the crossfade sources that were loaded when this layer started. */
    sourcesAtStart: string[];
    /** "Trees ready before Facade detail": started while an earlier-order layer had not revealed. */
    outOfOrder?: string;
    /** Why this reveal showed its end state at once. */
    skipped?: string;
    /** A crossfade source vanished mid-crossfade, so the crossfade ended at once. */
    cutShort?: boolean;
}

export interface RevealSchedule {
    runId: string;
    epoch: number;
    layers: Record<string, LayerTimeline>;
}

export type LayerPhase = 'loading' | 'held' | 'queued' | 'revealing' | 'revealed' | 'retired';

export interface LayerRevealFrame {
    objectId: string;
    layer: StagedLayer;
    phase: LayerPhase;
    /** 0..1 of the layer's own reveal. */
    progress: number;
    /**
     * 1 = fully present. A crossfade source under a uniform (stagger 0) replacement falls to 0 as that layer reveals,
     * with the dither complementary to the replacement's, so the two never double-draw or leave holes; under a
     * staggered replacement it stays whole until the replacement has revealed.
     */
    presence: number;
    /** Being revealed over a crossfade source that stays drawn: drawn in front of it (polygon offset). */
    overSource: boolean;
    /** Superseded after its replacement finished revealing: its meshes are hidden (the root stays loaded). */
    hidden: boolean;
    /** revealAfter ids this layer still waits for (a real data dependency, never timed out). */
    heldBy: string[];
    outOfOrder?: string;
    skipped?: string;
    cutShort?: boolean;
    /** Effective duration (half when cached, 0 when skipped). */
    durationMs: number;
}

export interface RevealFrame {
    layers: LayerRevealFrame[];
    /** Some layer is mid-reveal or mid-crossfade: keep drawing patched materials. */
    animating: boolean;
    /** Some committed layer has not revealed yet (loading, held or queued). */
    pending: boolean;
}

/** A queued layer may start out of canonical order after waiting this long since it loaded (§7.1 rule 3). */
export const OUT_OF_ORDER_WAIT_MS = 2000;
/** At most this many layers reveal at once: the new layer and one other (§7.7). */
export const MAX_CONCURRENT_REVEALS = 2;

const TERMINAL: ReadonlySet<StageStatus> = new Set<StageStatus>(['committed', 'degraded', 'skipped', 'failed', 'stopped']);

/** Canonical display order: StagedLayer.order, then the layer id within a stage (l3a before l3b). */
export function compareLayers(a: Pick<StagedLayer, 'order' | 'layer' | 'objectId'>, b: Pick<StagedLayer, 'order' | 'layer' | 'objectId'>): number {
    if (a.order !== b.order) return a.order - b.order;
    if (a.layer !== b.layer) return a.layer < b.layer ? -1 : 1;
    return a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0;
}

/** The layer's reveal length: the server's duration, halved for a layer that came from cache. */
export function effectiveDurationMs(layer: StagedLayer): number {
    const base = Math.max(0, layer.reveal.durationMs);
    return layer.cached ? base / 2 : base;
}

/**
 * The time window of one node inside its layer's reveal, as fractions of the layer's progress.
 *  - A node whose vertices carry `_REVEAL` orders its items itself, so it spans its `durationShare` (default all).
 *  - A node without `_REVEAL` fades in as one unit; the layer's stagger spreads the nodes over the reveal:
 *    a share of (1 - stagger) + stagger / n each, capped by the generator's durationShare.
 * Nodes start in `order` (build order, or the recorded download rank), the last one ending at 1.
 */
export function nodeRevealWindow(opts: { order: number; count: number; stagger: number; durationShare?: number; perVertex: boolean }): { start: number; span: number } {
    const n = Math.max(1, Math.floor(opts.count));
    const stagger = Math.min(1, Math.max(0, opts.stagger));
    const generatorShare = opts.durationShare !== undefined && Number.isFinite(opts.durationShare) && opts.durationShare > 0
        ? Math.min(1, opts.durationShare) : 1;
    const span = opts.perVertex ? generatorShare : Math.min(generatorShare, (1 - stagger) + stagger / n);
    const rank = n > 1 ? Math.min(1, Math.max(0, opts.order / (n - 1))) : 0;
    return { start: rank * (1 - span), span };
}

/** A node's own progress (0..1) at the given layer progress. */
export function nodeProgress(layerProgress: number, window: { start: number; span: number }): number {
    if (layerProgress >= 1) return 1;
    if (layerProgress <= 0) return 0;
    if (window.span <= 0) return layerProgress >= window.start ? 1 : 0;
    return Math.min(1, Math.max(0, (layerProgress - window.start) / window.span));
}

/** The stage title used in overlay notes ("Trees ready before Facade detail"). */
function titleOf(state: StagedBuildState, layer: StagedLayer): string {
    return state.stages.find(s => s.stage === layer.stage)?.title || layer.stage;
}

/**
 * A revealAfter dependency is met when that layer finished revealing, or when it will never come: its stage ended
 * without committing it (degraded, failed, skipped or stopped), or the run itself ended without it.
 */
function dependencyMet(id: string, state: StagedBuildState, revealed: (id: string) => boolean): boolean {
    const layer = state.layers.find(l => l.objectId === id);
    if (layer) return !!layer.retired || revealed(id);
    const owner = state.stages.find(s => s.layerIds.includes(id));
    if (owner) return TERMINAL.has(owner.status);
    return state.runState !== 'running';
}

/** One scheduler step. `prev` is the previous step's schedule (undefined on the first frame, or after a new run). */
export function stepRevealSchedule(prev: RevealSchedule | undefined, input: RevealInput): { schedule: RevealSchedule; frame: RevealFrame } {
    const { state, loads, nowMs } = input;
    const fresh = !prev || prev.runId !== state.runId || prev.epoch !== input.replayEpoch;
    const timelines: Record<string, LayerTimeline> = fresh ? {} : { ...prev!.layers };
    const layers = [...state.layers].sort(compareLayers);
    const isReady = (id: string) => !!loads[id]?.ready;

    const progressOf = (id: string): number => {
        const t = timelines[id];
        if (!t) return 0;
        if (t.endedAtMs !== undefined) return 1;
        if (t.durationMs <= 0) return 1;
        return Math.min(1, Math.max(0, (nowMs - t.startedAtMs) / t.durationMs));
    };
    const revealedNow = (id: string) => {
        const t = timelines[id];
        return !!t && (t.endedAtMs !== undefined || progressOf(id) >= 1);
    };

    // Close reveals that reached their end, and end a crossfade whose source vanished mid-way.
    for (const layer of layers) {
        const t = timelines[layer.objectId];
        if (!t || t.endedAtMs !== undefined) continue;
        const vanished = t.sourcesAtStart.some(src => !isReady(src));
        if (vanished) {
            timelines[layer.objectId] = { ...t, endedAtMs: nowMs, cutShort: true };
        } else if (progressOf(layer.objectId) >= 1) {
            timelines[layer.objectId] = { ...t, endedAtMs: t.startedAtMs + t.durationMs };
        }
    }

    const revealing = () => layers.filter(l => timelines[l.objectId] && timelines[l.objectId].endedAtMs === undefined).length;
    const heldByOf = (layer: StagedLayer) => layer.revealAfter.filter(id => !dependencyMet(id, state, revealedNow));

    // Start every layer whose conditions hold, in canonical order.
    for (const layer of layers) {
        const id = layer.objectId;
        if (timelines[id] || layer.retired || !isReady(id)) continue;
        if (heldByOf(layer).length > 0) continue;
        const earlier = layers.filter(o => compareLayers(o, layer) < 0 && !o.retired);
        const earlierRevealing = earlier.filter(o => timelines[o.objectId] && timelines[o.objectId].endedAtMs === undefined
            && !layer.revealAfter.includes(o.objectId));
        const readyAt = loads[id]?.readyAtMs ?? nowMs;
        const waitedLong = nowMs - readyAt >= OUT_OF_ORDER_WAIT_MS;
        const layerSkip = input.skipLayer?.(layer);
        const endState = input.settled || input.reducedMotion || !!input.skipReason || !!layerSkip;
        if (!endState) {
            if (earlierRevealing.length > 0 && !waitedLong) continue;
            if (revealing() >= MAX_CONCURRENT_REVEALS) continue;
        }
        const notYet = earlier.find(o => !revealedNow(o.objectId) && !timelines[o.objectId]);
        const skipped = input.settled ? undefined : input.reducedMotion ? 'reduced motion' : input.skipReason ?? layerSkip;
        const durationMs = endState ? 0 : effectiveDurationMs(layer);
        timelines[id] = {
            startedAtMs: nowMs,
            durationMs,
            ...(durationMs <= 0 ? { endedAtMs: nowMs } : {}),
            sourcesAtStart: layer.reveal.crossfadeFrom.filter(isReady),
            ...(notYet && !endState ? { outOfOrder: `${titleOf(state, layer)} ready before ${titleOf(state, notYet)}` } : {}),
            ...(skipped ? { skipped } : {})
        };
    }

    // A settled run ends every reveal still running.
    if (input.settled || input.reducedMotion || input.skipReason) {
        for (const layer of layers) {
            const t = timelines[layer.objectId];
            if (t && t.endedAtMs === undefined) {
                timelines[layer.objectId] = { ...t, endedAtMs: nowMs, ...(input.settled ? {} : { skipped: input.reducedMotion ? 'reduced motion' : input.skipReason }) };
            }
        }
    }

    // Frames: own progress, then what each reveal does to the layers it replaces.
    const frames = new Map<string, LayerRevealFrame>();
    for (const layer of layers) {
        const id = layer.objectId;
        const t = timelines[id];
        const heldBy = heldByOf(layer);
        const phase: LayerPhase = layer.retired ? 'retired'
            : t ? (revealedNow(id) ? 'revealed' : 'revealing')
            : !isReady(id) ? 'loading'
            : heldBy.length > 0 ? 'held' : 'queued';
        frames.set(id, {
            objectId: id, layer, phase,
            progress: layer.retired ? 1 : progressOf(id),
            presence: 1, hidden: false, heldBy,
            overSource: phase === 'revealing' && layer.reveal.crossfadeFrom.length > 0 && layer.reveal.stagger > 0,
            durationMs: t ? t.durationMs : effectiveDurationMs(layer),
            ...(t?.outOfOrder ? { outOfOrder: t.outOfOrder } : {}),
            ...(t?.skipped ? { skipped: t.skipped } : {}),
            ...(t?.cutShort ? { cutShort: true } : {})
        });
    }
    for (const layer of layers) {
        const f = frames.get(layer.objectId)!;
        if (f.phase !== 'revealing' && f.phase !== 'revealed' && f.phase !== 'retired') continue;
        const replaced = new Set([...layer.reveal.crossfadeFrom, ...layer.supersedes]);
        for (const srcId of replaced) {
            const src = frames.get(srcId);
            if (!src) continue;
            if (f.phase === 'revealed' || f.phase === 'retired') {
                src.hidden = true;
                src.presence = 0;
            } else if (layer.reveal.crossfadeFrom.includes(srcId) && layer.reveal.stagger <= 0) {
                // One uniform fade: the source takes exactly the pixels the replacing layer has not taken yet.
                src.presence = Math.min(src.presence, 1 - f.progress);
            }
            // A staggered replacement fades in part by part: its source stays whole underneath (the replacement is
            // drawn in front of it) until the replacement has revealed, so no part ever shows a hole.
        }
    }

    const out = layers.map(l => frames.get(l.objectId)!);
    const animating = out.some(f => f.phase === 'revealing');
    const pending = out.some(f => (f.phase === 'loading' && !loads[f.objectId]?.failed) || f.phase === 'held' || f.phase === 'queued');
    return { schedule: { runId: state.runId, epoch: input.replayEpoch, layers: timelines }, frame: { layers: out, animating, pending } };
}

/** The stage the overlay names: the most recently started running stage, else the last stage that ended. */
export function currentStage(state: StagedBuildState): StagedBuildState['stages'][number] | undefined {
    const running = state.stages.filter(s => s.status === 'running').sort((a, b) => b.timings.startedAtMs - a.timings.startedAtMs);
    if (running.length > 0) return running[0];
    const ended = state.stages.filter(s => TERMINAL.has(s.status) && s.status !== 'skipped')
        .sort((a, b) => (b.timings.endedAtMs ?? b.timings.startedAtMs) - (a.timings.endedAtMs ?? a.timings.startedAtMs));
    return ended[0];
}

/** Whether a stage's lifecycle has ended (anything but pending or running). */
export function isStageTerminal(status: StageStatus): boolean {
    return TERMINAL.has(status);
}

