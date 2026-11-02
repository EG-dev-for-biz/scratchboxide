/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { StagedLocationHardFailure } from '../src/node/3d-engine/staged-location/orchestrator';
import { runStagedLocationOffThread, stagedWorkerEnabled } from '../src/node/3d-engine/staged-location/staged-location-tool';

describe('the staged build on its own thread', () => {
    it('makes its own services there and hands a failure back as the same typed error, its events as they happen', async () => {
        // no credentials reach the test: the place cannot be resolved, so the build ends at its first stage, a hard failure
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-worker-'));
        const events: string[] = [];
        const err = await runStagedLocationOffThread({ query: '1 Nowhere Street, Atlantis', isolate: false, trees: false, stageIntoActiveScene: false }, root, 'abcd0001', {
            emitStage: e => events.push(`${e.stage}:${e.status}`)
        }).then(() => undefined, e => e as Error);
        expect(err).toBeInstanceOf(StagedLocationHardFailure);
        expect((err as StagedLocationHardFailure).stage).toBe('resolve');
        expect(events).toContain('resolve:running');
    }, 180_000);

    it('is on unless turned off', () => {
        expect(stagedWorkerEnabled({})).toBe(true);
        expect(stagedWorkerEnabled({ SCRATCHBOX_STAGED_WORKER: '0' })).toBe(false);
    });
});
