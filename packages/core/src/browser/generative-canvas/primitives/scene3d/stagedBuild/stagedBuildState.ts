/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged location builds on the renderer side: reading the build state off a scene, applying the StageEvents that
 * stream during a run, and marking a run stopped or interrupted when its chat turn ends early (design §6.4, §7.6).
 *
 * The scene artifact arrives only on commit, degrade and finish events; the running and progress events between them
 * carry a StageEvent alone. `publishStageEvent` (called by the chat stream) hands those to the viewport showing that
 * run, which merges them into the state it shows (`mergeStageEvent`), so the overlay names the running stage, its
 * source and its progress as they happen.
 */

import type { CanvasArtifact, ChatSession, Scene3DData } from '../../../canvas-types';
import type { StageEvent, StageStatus, StagedBuildState, StagedLayer } from '../../../../../common/spatial/staged-location-contracts';
import { compareLayers, isStageTerminal } from './revealScheduler';

/**
 * Scene3DData.stagedBuild. The contracts commit was to add this field to Scene3DData (canvas-types.ts); until it does,
 * the viewport reads it through this view of the scene data.
 */
export type StagedSceneData = Scene3DData & { stagedBuild?: StagedBuildState };

export function readStagedBuild(data: Scene3DData | undefined | null): StagedBuildState | undefined {
    const staged = (data as StagedSceneData | undefined)?.stagedBuild;
    return staged && staged.schema === 'scratchbox.staged-build/2' && Array.isArray(staged.layers) ? staged : undefined;
}

/** Layers in canonical display order. */
export function layerOrder(state: StagedBuildState): StagedLayer[] {
    return [...state.layers].sort(compareLayers);
}

/**
 * Whether a run should be shown as interrupted rather than running. Two signals, neither a timer:
 *  1. the chat turn ended while the run was running (useSendMessage's `finally` marks it `interrupted`);
 *  2. the state says `running` but was emitted before this page loaded: no stream survives a page load, so a saved
 *     session reopened after a crash or a restart is not still running.
 */
export function isInterrupted(state: StagedBuildState, pageLoadedAtMs: number): boolean {
    if (state.runState === 'interrupted') return true;
    return state.runState === 'running' && state.updatedAtMs < pageLoadedAtMs;
}

/** The run is over (finished, stopped, failed or interrupted): committed layers show their end state. */
export function isRunSettled(state: StagedBuildState, pageLoadedAtMs: number): boolean {
    return state.runState === 'stopped' || state.runState === 'failed' || isInterrupted(state, pageLoadedAtMs);
}

const STATUS_RANK: Record<StageStatus, number> = { pending: 0, running: 1, committed: 2, degraded: 2, skipped: 2, failed: 2, stopped: 2 };

/**
 * Merges one streamed StageEvent into the state the viewport shows. A stage runs once per run, so its lifecycle only
 * moves forward: an event applies to its stage when its status is at least as far along as the state's (a running
 * event refreshes progress; a stale running event never undoes a commit). Layers and degradations are upserted by
 * id; the scene objects themselves arrive with the artifact on commit.
 */
export function mergeStageEvent(state: StagedBuildState, event: StageEvent): StagedBuildState {
    if (event.runId !== state.runId) return state;
    const existing = state.stages.find(s => s.stage === event.stage);
    if (existing && STATUS_RANK[event.status] < STATUS_RANK[existing.status]) return state;
    const degradationIds = [...new Set([...(existing?.degradationIds ?? []), ...event.degradations.map(d => d.id)])];
    const layerIds = [...new Set([...(existing?.layerIds ?? []), ...(event.layers ?? []).map(l => l.objectId), ...(event.patch?.upsertObjects ?? [])])];
    const summary = {
        stage: event.stage,
        order: event.order,
        title: event.title,
        source: event.source,
        status: event.status,
        ...(existing?.reason ? { reason: existing.reason } : {}),
        layerIds,
        timings: event.timings,
        degradationIds
    };
    const reason = event.message && event.status !== 'running' ? { reason: event.message } : {};
    const stages = existing
        ? state.stages.map(s => (s.stage === event.stage ? { ...summary, ...reason } : s))
        : [...state.stages, { ...summary, ...reason }];
    const layers = [...state.layers];
    for (const l of event.layers ?? []) {
        const i = layers.findIndex(x => x.objectId === l.objectId);
        if (i >= 0) layers[i] = l; else layers.push(l);
    }
    const removed = new Set(event.patch?.removeObjects ?? []);
    const degradations = [...state.degradations];
    for (const d of event.degradations) {
        const i = degradations.findIndex(x => x.id === d.id);
        if (i >= 0) degradations[i] = d; else degradations.push(d);
    }
    return {
        ...state,
        stages,
        layers: layers.filter(l => !removed.has(l.objectId)),
        degradations,
        ...(event.model ? { visionModel: event.model } : {})
    };
}

/** Live progress of one running stage, from the latest running StageEvent (never stored in the scene). */
export interface StageProgress { stage: string; progress?: number; message?: string; seq: number }

type StageEventListener = (event: StageEvent) => void;
const listeners = new Set<StageEventListener>();
const latestByRun = new Map<string, StageEvent[]>();
const MAX_RUNS_KEPT = 8;

/**
 * Called by the chat stream for every event that carries a StageEvent. Events are kept per run (the last run's, a
 * few runs back) so a viewport that mounts mid-run catches up on what streamed before it, then listeners are told.
 */
export function publishStageEvent(event: StageEvent | undefined): void {
    if (!event || event.schema !== 'scratchbox.stage-event/2' || typeof event.runId !== 'string') return;
    const list = latestByRun.get(event.runId) ?? [];
    // seq is strictly increasing per run: a repeated seq is the same event delivered twice.
    if (list.some(e => e.seq === event.seq)) return;
    list.push(event);
    list.sort((a, b) => a.seq - b.seq);
    latestByRun.delete(event.runId);
    latestByRun.set(event.runId, list);
    while (latestByRun.size > MAX_RUNS_KEPT) latestByRun.delete(latestByRun.keys().next().value as string);
    listeners.forEach(l => l(event));
}

export function subscribeStageEvents(listener: StageEventListener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The StageEvents seen so far for a run, in seq order. */
export function stageEventsFor(runId: string): readonly StageEvent[] {
    return latestByRun.get(runId) ?? [];
}

/** Applies every streamed event of the run to the state (the artifact's state, then what streamed after it). */
export function withStreamedEvents(state: StagedBuildState, events: readonly StageEvent[]): StagedBuildState {
    return events.reduce((acc, e) => mergeStageEvent(acc, e), state);
}

/** The latest progress line per running stage, from the streamed events. */
export function streamedProgress(events: readonly StageEvent[]): Map<string, StageProgress> {
    const out = new Map<string, StageProgress>();
    for (const e of events) {
        if (e.status === 'running') out.set(e.stage, { stage: e.stage, progress: e.progress, message: e.message, seq: e.seq });
        else out.delete(e.stage);
    }
    return out;
}

function markState(state: StagedBuildState, runState: 'stopped' | 'interrupted', nowMs: number): StagedBuildState {
    return {
        ...state,
        runState,
        updatedAtMs: nowMs,
        stages: state.stages.map(s => (isStageTerminal(s.status) ? s : { ...s, status: 'stopped' as const }))
    };
}

/**
 * A copy of the scene artifact with its running staged build marked stopped or interrupted: running and pending
 * stages become `stopped`, `updatedAtMs` is set, and `data.objects` is a shallow copy so even a data-merge condition
 * that only looks at `objects` sees a change. Any other artifact (or a run already over) comes back unchanged.
 */
export function markStagedRun<T extends CanvasArtifact | undefined>(artifact: T, runState: 'stopped' | 'interrupted', nowMs: number = Date.now()): T {
    if (!artifact || artifact.type !== '3d-scene') return artifact;
    const data = artifact.data as StagedSceneData;
    const staged = readStagedBuild(data);
    if (!staged || staged.runState !== 'running') return artifact;
    return {
        ...artifact,
        data: { ...data, objects: [...(data.objects ?? [])], stagedBuild: markState(staged, runState, nowMs) }
    } as T;
}

type Setter<T> = (value: T | ((prev: T) => T)) => void;

export interface StagedRunSetters {
    setSessions: Setter<ChatSession[]>;
    setActiveArtifact: Setter<CanvasArtifact | undefined>;
    setArtifactHistory: Setter<CanvasArtifact[]>;
}

/**
 * When a chat turn ends while a staged run it streamed is still `running` (a newer message aborted it, the stream
 * failed, or the connection dropped), marks that run interrupted wherever the scene is held: the active artifact,
 * the artifact history and every session. Only entries of that run still `running` change, so after a normal finish
 * (the server's artifact is terminal) or after Stop (already marked `stopped`) nothing does.
 */
export function settleStagedRunInSession(setters: StagedRunSetters, lastArtifact: CanvasArtifact | undefined, runState: 'stopped' | 'interrupted' = 'interrupted', nowMs: number = Date.now()): void {
    const staged = lastArtifact ? readStagedBuild(lastArtifact.data as Scene3DData) : undefined;
    if (!lastArtifact || !staged) return;
    const runId = staged.runId;
    const mark = (a: CanvasArtifact | undefined): CanvasArtifact | undefined => {
        if (!a || a.id !== lastArtifact.id) return a;
        const s = readStagedBuild(a.data as Scene3DData);
        return s && s.runId === runId && s.runState === 'running' ? markStagedRun(a, runState, nowMs) : a;
    };
    const markList = (list: CanvasArtifact[] | undefined): CanvasArtifact[] | undefined => {
        if (!list) return list;
        let changed = false;
        const next = list.map(a => { const m = mark(a)!; if (m !== a) changed = true; return m; });
        return changed ? next : list;
    };
    setters.setActiveArtifact(prev => mark(prev));
    setters.setArtifactHistory(prev => markList(prev) ?? prev);
    setters.setSessions(prev => {
        let changed = false;
        const next = prev.map(s => {
            const activeArtifact = mark(s.activeArtifact);
            const artifactHistory = markList(s.artifactHistory) ?? s.artifactHistory;
            const messages = s.messages.map(m => {
                const arts = markList(m.artifacts);
                return arts !== m.artifacts ? { ...m, artifacts: arts } : m;
            });
            const msgChanged = messages.some((m, i) => m !== s.messages[i]);
            if (activeArtifact === s.activeArtifact && artifactHistory === s.artifactHistory && !msgChanged) return s;
            changed = true;
            return { ...s, activeArtifact, artifactHistory, messages };
        });
        return changed ? next : prev;
    });
}
