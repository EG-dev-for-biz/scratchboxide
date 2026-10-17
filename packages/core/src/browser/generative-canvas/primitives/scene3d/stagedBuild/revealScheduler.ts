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
    /** Pace the first PACED_REVEAL_COUNT reveals (live viewport presentation). Off = every reveal plays at its own duration. */
    pace?: boolean;
    /**
     * Layers that still animate when the run is settled: a change the viewer asked for now (a material swap between a
     * clay layer and its textured twin) is not part of the recorded build, so it plays even over a finished run.
     */
    exemptFromSettled?: (layer: StagedLayer) => boolean;
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
    /** One of the first PACED_REVEAL_COUNT reveals: held on screen for at least the pacing dwell. */
    paced?: boolean;
    /** The run finished while this paced reveal was still running: its remaining time was cut to its flush share. */
    flushed?: boolean;
}

export interface RevealSchedule {
    runId: string;
    epoch: number;
    /** Clock time the scheduler first saw the run no longer running (every stage committed), for the flush bound. */
    finishedAtMs?: number;
    /** Each remaining paced reveal's share of the flush budget, fixed when the run finished. */
    flushShareMs?: number;
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
    /** The layer's file did not load (a download or parse error): it is not drawn, and nothing waits for it. */
    loadFailed?: boolean;
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

/**
 * Presentation pacing (viewport only; data commits and the overlay status are never delayed): the first reveals, by
 * order of starting, play for at least this long, one after another, so fast early stages read as deliberate steps.
 */
export const PACED_REVEAL_COUNT = 5;
export const PACED_REVEAL_DWELL_MS = 2000;
/** Once the run has finished, all paced reveals still to play share at most this much time. */
export const PACED_FLUSH_BUDGET_MS = 1500;

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
 * A revealAfter dependency is met when that layer finished revealing, or when it will never come: it was retired,
 * its file failed to load, its stage ended without committing it (degraded, failed, skipped or stopped), or the run
 * itself ended without it.
 */
function dependencyMet(id: string, state: StagedBuildState, revealed: (id: string) => boolean, loadFailed: (id: string) => boolean): boolean {
    const layer = state.layers.find(l => l.objectId === id);
    // A layer whose file did not load never reveals; the real layers that waited for it are shown, not held for good.
    if (layer) return !!layer.retired || revealed(id) || loadFailed(id);
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

    const pace = !!input.pace;
    const finished = state.runState !== 'running';
    const finishedAtMs = fresh ? undefined : prev!.finishedAtMs;
    const finishedAt = finished ? (finishedAtMs ?? nowMs) : undefined;
    let flushShareMs = fresh ? undefined : prev!.flushShareMs;
    const isPaced = (id: string) => !!timelines[id]?.paced;
    const unstartedPaced = () => Math.max(0, PACED_REVEAL_COUNT - Object.keys(timelines).length);
    const pacedLeft = () => layers.filter(l => timelines[l.objectId]?.paced && timelines[l.objectId].endedAtMs === undefined).length
        + Math.min(unstartedPaced(), layers.filter(l => !timelines[l.objectId] && !l.retired).length);
    // The run is done: the paced reveals still to play share the flush budget, so the queue never delays the result by more.
    if (pace && finished && !input.settled && !input.reducedMotion && !input.skipReason) {
        const share = flushShareMs ??= PACED_FLUSH_BUDGET_MS / Math.max(1, pacedLeft());
        for (const layer of layers) {
            const t = timelines[layer.objectId];
            if (!t || !t.paced || t.flushed || t.endedAtMs !== undefined) continue;
            timelines[layer.objectId] = { ...t, flushed: true, durationMs: Math.min(t.durationMs, Math.max(0, nowMs - t.startedAtMs) + share) };
        }
    }

    const revealing = () => layers.filter(l => timelines[l.objectId] && timelines[l.objectId].endedAtMs === undefined).length;
    const loadFailed = (id: string) => !!loads[id]?.failed;
    const heldByOf = (layer: StagedLayer) => layer.revealAfter.filter(id => !dependencyMet(id, state, revealedNow, loadFailed));

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
        const settledHere = input.settled && !input.exemptFromSettled?.(layer);
        const endState = settledHere || input.reducedMotion || !!input.skipReason || !!layerSkip;
        const pacedStart = pace && !endState && Object.keys(timelines).length < PACED_REVEAL_COUNT;
        if (!endState) {
            // A paced reveal never jumps the queue: it waits for the earlier paced ones, however long they take.
            if (earlierRevealing.length > 0 && (!waitedLong || (pacedStart && earlierRevealing.some(o => isPaced(o.objectId))))) continue;
            if (revealing() >= MAX_CONCURRENT_REVEALS) continue;
        }
        const notYet = earlier.find(o => !revealedNow(o.objectId) && !timelines[o.objectId] && !loadFailed(o.objectId));
        const skipped = settledHere ? undefined : input.reducedMotion ? 'reduced motion' : input.skipReason ?? layerSkip;
        const dwell = flushShareMs !== undefined ? Math.min(PACED_REVEAL_DWELL_MS, flushShareMs) : PACED_REVEAL_DWELL_MS;
        const durationMs = endState ? 0 : pacedStart ? Math.max(effectiveDurationMs(layer), dwell) : effectiveDurationMs(layer);
        timelines[id] = {
            startedAtMs: nowMs,
            durationMs,
            ...(pacedStart ? { paced: true } : {}),
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
            if (input.settled && !input.reducedMotion && !input.skipReason && input.exemptFromSettled?.(layer)) continue;
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
            ...(t?.cutShort ? { cutShort: true } : {}),
            ...(!t && !layer.retired && loadFailed(id) ? { loadFailed: true } : {})
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
    return { schedule: { runId: state.runId, epoch: input.replayEpoch, layers: timelines, ...(finishedAt !== undefined ? { finishedAtMs: finishedAt } : {}), ...(flushShareMs !== undefined ? { flushShareMs } : {}) }, frame: { layers: out, animating, pending } };
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

