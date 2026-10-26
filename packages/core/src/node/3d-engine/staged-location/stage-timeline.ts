/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged run's wall-clock timeline: every stage event, as it is streamed, appended to
 * `<cache>/runs/<runId>/timeline.jsonl` (epoch ms, ms since the run started, the stage's own timings, the layers it
 * committed with their sizes) and logged as one `[staged-timeline]` line. It only observes: the event is passed on
 * unchanged, and a failed write never reaches the run.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CanvasArtifact } from '../../../browser/generative-canvas/canvas-types';
import type { StageEvent } from '../../../common/spatial/staged-location-contracts';

export type EmitStage = (event: StageEvent, artifact?: CanvasArtifact) => void;

export interface TimelineEntry {
    atMs: number;
    tMs: number;
    seq: number;
    stage: string;
    status: string;
    ms?: number;
    cached: boolean;
    breakdownMs?: Record<string, number>;
    withArtifact: boolean;
    layers?: Array<{ layer: string; objectId: string; triangles: number; bytes: number; textured: boolean }>;
    model?: unknown;
    reason?: string;
}

export function timelineEntry(event: StageEvent, artifact: CanvasArtifact | undefined, startedAt: number, at: number): TimelineEntry {
    return {
        atMs: at, tMs: at - startedAt, seq: event.seq, stage: event.stage, status: event.status,
        ...(event.timings.ms !== undefined ? { ms: event.timings.ms } : {}),
        cached: event.timings.cached,
        ...(event.timings.breakdownMs ? { breakdownMs: event.timings.breakdownMs } : {}),
        withArtifact: !!artifact,
        ...(event.layers?.length ? {
            layers: event.layers.map(l => ({ layer: l.layer, objectId: l.objectId, triangles: l.counts.triangles, bytes: l.bytes, textured: !!l.textured }))
        } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...((event as { reason?: string }).reason ? { reason: (event as { reason?: string }).reason } : {})
    };
}

/** Wraps `emit` so every event is also written to `file` and logged; `emit` still gets each event first and unchanged. */
export function recordStageTimeline(file: string, runId: string, startedAt: number, emit: EmitStage | undefined, now: () => number = Date.now): EmitStage {
    let dirMade = false;
    return (event, artifact) => {
        emit?.(event, artifact);
        try {
            const entry = timelineEntry(event, artifact, startedAt, now());
            if (!dirMade) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirMade = true; }
            fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
            if (entry.status !== 'running' || entry.stage === 'finish') {
                const layers = entry.layers?.map(l => `${l.layer}${l.textured ? '(textured)' : ''} ${l.triangles} tris`).join(', ');
                console.log(`[staged-timeline] ${runId} +${(entry.tMs / 1000).toFixed(1)} s ${entry.stage} ${entry.status}`
                    + `${entry.ms !== undefined ? ` in ${(entry.ms / 1000).toFixed(1)} s` : ''}${entry.cached ? ' (cached)' : ''}${layers ? `: ${layers}` : ''}`
                    + `${entry.status === 'degraded' && event.degradations?.length ? ` - ${event.degradations.map(d => d.reason).join('; ').slice(0, 600)}` : ''}`);
            }
        } catch {
            // the timeline is a record of the run, never a part of it
        }
    };
}
