/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordStageTimeline } from '../src/node/3d-engine/staged-location/stage-timeline';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-timeline-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function event(seq: number, stage: string, status: StageEvent['status'], ms?: number): StageEvent {
    return {
        schema: 'scratchbox.stage-event/2', runId: 'abcd1234', seq, stage, order: 1, status, title: stage, source: '', degradations: [],
        timings: { startedAtMs: 1_000, ...(ms !== undefined ? { endedAtMs: 1_000 + ms, ms } : {}), cached: false, ...(ms ? { breakdownMs: { tileRefine: 700 } } : {}) }
    };
}

describe('recordStageTimeline', () => {
    it('passes every event on unchanged and appends one line per event with the time since the run started', () => {
        const file = path.join(dir, 'runs', 'abcd1234', 'timeline.jsonl');
        const seen: StageEvent[] = [];
        let clock = 5_000;
        const emit = recordStageTimeline(file, 'abcd1234', 5_000, e => seen.push(e), () => clock);
        const a = event(1, 'remesh', 'running');
        clock = 5_250; emit(a);
        const b = { ...event(2, 'remesh', 'committed', 77_300), layers: [{ layer: 'l2', objectId: 'stg-1-l2', counts: { vertices: 9, triangles: 7743 }, bytes: 522_688 }] } as unknown as StageEvent;
        clock = 82_550; emit(b, { id: 'scene' } as never);
        expect(seen).toEqual([a, b]);
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ seq: 1, stage: 'remesh', status: 'running', tMs: 250, atMs: 5_250, withArtifact: false });
        expect(lines[1]).toMatchObject({ seq: 2, status: 'committed', tMs: 77_550, ms: 77_300, breakdownMs: { tileRefine: 700 }, withArtifact: true });
        expect(lines[1].layers).toEqual([{ layer: 'l2', objectId: 'stg-1-l2', triangles: 7743, bytes: 522_688, textured: false }]);
    });

    it('never throws into the run when the file cannot be written', () => {
        const blocker = path.join(dir, 'not-a-dir');
        fs.writeFileSync(blocker, 'x');
        const seen: number[] = [];
        const emit = recordStageTimeline(path.join(blocker, 'timeline.jsonl'), 'abcd1234', 0, e => seen.push(e.seq));
        expect(() => emit(event(1, 'tiles', 'committed', 1_900))).not.toThrow();
        expect(seen).toEqual([1]);
    });
});
