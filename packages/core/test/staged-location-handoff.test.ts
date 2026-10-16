/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which calls google_3d_tiles_get_clay hands to the staged build: the clay tool when it remeshes (the default). The
 * textured tool and the raw clay tiles (remesh false) keep their own paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../src/node/gemini/tools/types';

const staged = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../src/node/3d-engine/staged-location/staged-location-tool', async orig => ({
    ...(await orig<typeof import('../src/node/3d-engine/staged-location/staged-location-tool')>()),
    runStagedLocationTool: staged.run
}));

import { google3DTilesHandlers } from '../src/node/gemini/tools/spatial-tools';

beforeEach(() => staged.run.mockReset().mockResolvedValue({ resultPayload: { success: true, handedOff: true }, summaryResult: 'staged' }));

describe('google_3d_tiles_get_clay', () => {
    const ctx = { request: {} } as unknown as ToolContext;

    it('hands a remeshing call (the default) to the staged build with its arguments and context', async () => {
        const out = await google3DTilesHandlers.google_3d_tiles_get_clay({ query: 'Flatiron Building', isolate: true }, ctx);
        expect(out.resultPayload).toEqual({ success: true, handedOff: true });
        expect(staged.run).toHaveBeenCalledTimes(1);
        expect(staged.run).toHaveBeenCalledWith('google_3d_tiles_get_clay', { query: 'Flatiron Building', isolate: true }, ctx);
    });

    it('hands a retry (no query) to the staged build too', async () => {
        await google3DTilesHandlers.google_3d_tiles_get_clay({ retryRunId: 'a1b2c3d4', retryStage: 'vision' }, ctx);
        expect(staged.run).toHaveBeenCalledWith('google_3d_tiles_get_clay', { retryRunId: 'a1b2c3d4', retryStage: 'vision' }, ctx);
    });

    it('does not hand over the raw clay tiles (remesh false) or the textured tool', async () => {
        // the old paths run: a raw call that asks for trees is refused by them before any network call
        await expect(google3DTilesHandlers.google_3d_tiles_get_clay({ query: 'q', remesh: false, trees: true }, ctx)).rejects.toThrow(/remesh true to rebuild trees/);
        await expect(google3DTilesHandlers.google_3d_tiles_get_full_texture({ remesh: true }, ctx)).rejects.toThrow(/query/);
        expect(staged.run).not.toHaveBeenCalled();
    });
});
