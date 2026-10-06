/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { afterEach, describe, expect, it } from 'vitest';
import { GeminiClient, resolveVertexLocation, vertexHost } from '../src/node/gemini/gemini-client';

describe('Vertex model endpoint', () => {
    const saved = process.env.SCRATCHBOX_VERTEX_LOCATION;
    afterEach(() => {
        if (saved === undefined) delete process.env.SCRATCHBOX_VERTEX_LOCATION;
        else process.env.SCRATCHBOX_VERTEX_LOCATION = saved;
    });

    it('targets the global endpoint by default, where the Gemini 3.x default model is published', () => {
        delete process.env.SCRATCHBOX_VERTEX_LOCATION;
        const url = new GeminiClient().vertexModelUrl('proj', 'gemini-3.7-flash', 'streamGenerateContent');
        expect(url).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/google/models/gemini-3.7-flash:streamGenerateContent?alt=sse');
    });

    it('honours a regional override with the regional host', () => {
        process.env.SCRATCHBOX_VERTEX_LOCATION = 'europe-west4';
        expect(resolveVertexLocation()).toBe('europe-west4');
        expect(vertexHost('europe-west4')).toBe('europe-west4-aiplatform.googleapis.com');
        const url = new GeminiClient().vertexModelUrl('proj', 'gemini-2.5-flash', 'generateContent');
        expect(url).toBe('https://europe-west4-aiplatform.googleapis.com/v1/projects/proj/locations/europe-west4/publishers/google/models/gemini-2.5-flash:generateContent');
    });
});
