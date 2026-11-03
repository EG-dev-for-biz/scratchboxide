/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's one native switch (pipeline-k/native/native-switch.ts): every port native unless SCRATCHBOX_K_NATIVE
 * says otherwise (0 or off: none; a comma list: those), and the retired switches reported with their replacements.
 */

import { describe, expect, it } from 'vitest';
import { K_NATIVE_STAGES, kNative, kNativeSwitchProblems } from '../src/node/3d-engine/staged-location/pipeline-k/native/native-switch';

describe('pipeline K native switch', () => {
    it('runs every port natively by default, none at 0 or off, and the listed ones from a list', () => {
        for (const stage of K_NATIVE_STAGES) {
            expect(kNative(stage, {})).toBe(true);
            for (const v of ['1', 'all', 'on', ' ON ']) expect(kNative(stage, { SCRATCHBOX_K_NATIVE: v })).toBe(true);
            for (const v of ['0', 'off', 'OFF']) expect(kNative(stage, { SCRATCHBOX_K_NATIVE: v })).toBe(false);
        }
        const env = { SCRATCHBOX_K_NATIVE: 'rectify, harmonize' };
        expect(K_NATIVE_STAGES.filter(s => kNative(s, env))).toEqual(['rectify', 'harmonize']);
    });

    it('reports the retired switches with what to set instead', () => {
        expect(kNativeSwitchProblems({ SCRATCHBOX_K_NATIVE: '0' })).toEqual([]);
        const problems = kNativeSwitchProblems({ SCRATCHBOX_K_NATIVE_TWIN: '0', SCRATCHBOX_K_NATIVE_TWIN_THREADS: '4', SCRATCHBOX_K_NATIVE_TWIN_BIN: '/x' });
        expect(problems).toHaveLength(3);
        expect(problems[0]).toMatch(/^SCRATCHBOX_K_NATIVE_TWIN is retired and not read; set SCRATCHBOX_K_NATIVE /);
        expect(problems[1]).toMatch(/SCRATCHBOX_K_NATIVE_THREADS/);
        expect(problems[2]).toMatch(/SCRATCHBOX_TWIN_TEXELS_BIN/);
    });
});
