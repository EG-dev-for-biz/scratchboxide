/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The work sweep: while a stage runs, a band sweeps up the showing layers' world-Y range at the shared period, the
 * stage's reported progress is the fill, reduced motion holds the band at the progress, and nothing sweeps once the
 * run is over or interrupted.
 */

import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { workSweepFor } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/useStagedBuild';
import { WORK_SWEEP_PERIOD_MS } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';
import type { StagedBuildState } from '../src/common/spatial/staged-location-contracts';

const NOW = 1_000_000;
function state(runState: StagedBuildState['runState'], stageStatus: 'running' | 'committed'): StagedBuildState {
    return {
        schema: 'scratchbox.staged-build/2', runId: 'abcd1234', requestKey: 'k', artifactId: 'scene-stg-abcd1234',
        place: { query: 'x', resolvedAddress: 'x', lat: 0, lng: 0 }, runState, updatedAtMs: NOW,
        stages: [{ stage: 'remesh', order: 2, title: 'Remeshed scan', source: 'tile_refine', status: stageStatus, layerIds: [], timings: { startedAtMs: NOW - 5000 } as never, degradationIds: [] }],
        layers: [], degradations: [], provenanceLegend: []
    } as unknown as StagedBuildState;
}
const bounds = [new THREE.Box3(new THREE.Vector3(-10, -2, -10), new THREE.Vector3(10, 30, 10)), new THREE.Box3(new THREE.Vector3(0, 5, 0), new THREE.Vector3(1, 48, 1))];

describe('workSweepFor', () => {
    test('sweeps the union of the showing layers at the shared period, with the reported progress as fill', () => {
        const progress = new Map([['remesh', { stage: 'remesh', progress: 0.4, message: 'closing cracks', seq: 3 }]]);
        const at = (ms: number) => workSweepFor(state('running', 'running'), progress, bounds, ms, false, NOW - 60_000);
        expect(at(0)).toMatchObject({ phase: 0, fill: 0.4, minY: -2, maxY: 48 });
        expect(at(WORK_SWEEP_PERIOD_MS * 0.25)?.phase).toBeCloseTo(0.25, 5);
        expect(at(WORK_SWEEP_PERIOD_MS * 1.5)?.phase).toBeCloseTo(0.5, 5);
        // no reported progress: nothing is filled
        expect(workSweepFor(state('running', 'running'), new Map(), bounds, 100, false, NOW - 60_000)?.fill).toBe(0);
    });

    test('reduced motion holds the band at the progress; no sweep once the run is over, interrupted, or has no stage running', () => {
        const progress = new Map([['remesh', { stage: 'remesh', progress: 0.7, seq: 1 }]]);
        expect(workSweepFor(state('running', 'running'), progress, bounds, 777, true, NOW - 60_000)?.phase).toBe(0.7);
        expect(workSweepFor(state('finished', 'committed'), progress, bounds, 777, false, NOW - 60_000)).toBeUndefined();
        expect(workSweepFor(state('running', 'committed'), progress, bounds, 777, false, NOW - 60_000)).toBeUndefined();
        // a saved running state from before this page loaded is interrupted, not live
        expect(workSweepFor(state('running', 'running'), progress, bounds, 777, false, NOW + 60_000)).toBeUndefined();
        // nothing showing yet: nothing to sweep over
        expect(workSweepFor(state('running', 'running'), progress, [undefined], 777, false, NOW - 60_000)).toBeUndefined();
    });
});
