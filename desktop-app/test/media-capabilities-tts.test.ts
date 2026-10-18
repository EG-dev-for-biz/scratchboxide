/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, test, vi } from 'vitest';
import { createMediaRouter, MediaRouterServices } from '../server/routes/mediaVideoRoutes';
import { RouteContext } from '../server/routes/types';

// GET /media/capabilities reports the TTS model /gemini/tts will call. The media generator is a stand-in that makes
// no Google call (only its capability probe is used by this route).
describe('/media/capabilities reports the configured TTS model', () => {
    let server: Server;
    let baseUrl = '';

    beforeAll(async () => {
        const services = {
            mediaGenerator: { detectCapabilities: async () => ({ sdk: { generateContent: true, generateVideos: true, getVideosOperation: true, download: true }, models: {} }) },
            mediaJobs: {},
            mediaAssets: {}
        } as unknown as MediaRouterServices;
        const ctx: RouteContext = {
            allowedWorkspaceRoots: [],
            requireWorkspaceRoot: () => { throw new Error('not used'); },
            sendError: (res, err) => { res.status(500).json({ error: String(err) }); },
            isPathError: () => false
        };
        const app = express();
        app.use('/media', createMediaRouter(services, ctx));
        server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => { vi.unstubAllEnvs(); });
    afterAll(() => { server?.close(); });

    test('the default Gemini TTS model when SCRATCHBOX_TTS_MODEL is unset', async () => {
        vi.stubEnv('SCRATCHBOX_TTS_MODEL', '');
        const caps = await (await fetch(`${baseUrl}/media/capabilities`)).json();
        assert.deepStrictEqual(caps.audio, {
            supported: true,
            models: ['gemini-2.5-flash-preview-tts'],
            primaryModel: 'gemini-2.5-flash-preview-tts',
            modelSource: 'default'
        });
        assert.ok(caps.image && caps.video, 'image and video capabilities are still reported');
    });

    test('the SCRATCHBOX_TTS_MODEL override when it is set', async () => {
        vi.stubEnv('SCRATCHBOX_TTS_MODEL', 'gemini-2.5-pro-preview-tts');
        const caps = await (await fetch(`${baseUrl}/media/capabilities`)).json();
        assert.strictEqual(caps.audio.primaryModel, 'gemini-2.5-pro-preview-tts');
        assert.deepStrictEqual(caps.audio.models, ['gemini-2.5-pro-preview-tts']);
        assert.strictEqual(caps.audio.modelSource, 'SCRATCHBOX_TTS_MODEL');
    });
});
