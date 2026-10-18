/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'express';
import { createMediaRouter } from '../server/routes/mediaVideoRoutes';
import { isPathError, RouteContext } from '../server/routes/types';

function invoke(router: Router, url: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
        const req: any = { method: 'GET', url, query: {}, body: {}, headers: {} };
        const res: any = {
            statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: any) { resolve({ status: this.statusCode, json: payload }); }
        };
        router(req, res, (err?: any) => resolve({ status: err ? 500 : 404, json: { error: err?.message || 'Not found' } }));
    });
}

const ctx: RouteContext = {
    allowedWorkspaceRoots: [],
    requireWorkspaceRoot: () => { throw new Error('not used'); },
    sendError: (res: any, err: any, status = 500) => res.status(status).json({ error: err?.message }),
    isPathError
};

function makeRouter(): Router {
    // Only detectCapabilities is reached by GET /capabilities; it makes no network call here.
    const mediaGenerator: any = { detectCapabilities: async () => ({ success: true }) };
    return createMediaRouter({ mediaGenerator, mediaJobs: {} as any, mediaAssets: {} as any }, ctx);
}

describe('GET /media/capabilities audio: reports the configured TTS model', () => {
    const saved = process.env.SCRATCHBOX_TTS_MODEL;
    afterEach(() => {
        if (saved === undefined) delete process.env.SCRATCHBOX_TTS_MODEL; else process.env.SCRATCHBOX_TTS_MODEL = saved;
    });

    it('not configured: audio is unsupported, no model is advertised, and the reason names the variable', async () => {
        delete process.env.SCRATCHBOX_TTS_MODEL;
        const { status, json } = await invoke(makeRouter(), '/capabilities');
        expect(status).toBe(200);
        expect(json.audio.supported).toBe(false);
        expect(json.audio.models).toEqual([]);
        expect(json.audio.reason).toMatch(/SCRATCHBOX_TTS_MODEL/);
    });

    it('configured: advertises exactly the configured model', async () => {
        process.env.SCRATCHBOX_TTS_MODEL = '  some-tts-model  ';
        const { json } = await invoke(makeRouter(), '/capabilities');
        expect(json.audio).toEqual({ supported: true, models: ['some-tts-model'], primaryModel: 'some-tts-model' });
    });
});
