/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    resolveApiUrl,
    isApiUrl,
    getApiBase,
    API_PATH_PREFIXES,
    withApiTokenQuery
} from '../src/common/api-client-config';
import { Endpoint } from '../src/browser/generative-canvas/endpoint';

describe('API Client Configuration & URL Resolution', () => {
    const originalGlobalScratchbox = (globalThis as any).scratchbox;

    beforeEach(() => {
        (globalThis as any).scratchbox = {
            apiBase: 'http://127.0.0.1:3001',
            launchToken: 'test-token-12345'
        };
    });

    afterEach(() => {
        (globalThis as any).scratchbox = originalGlobalScratchbox;
    });

    it('returns configured apiBase', () => {
        expect(getApiBase()).toBe('http://127.0.0.1:3001');
    });

    it('identifies API routes accurately', () => {
        expect(isApiUrl('/gemini/generate-stream')).toBe(true);
        expect(isApiUrl('/workspace/files')).toBe(true);
        expect(isApiUrl('/api/models')).toBe(true);
        expect(isApiUrl('/3d/python/run')).toBe(true);
        expect(isApiUrl('/static/bundle.js')).toBe(false);
    });

    it('resolves relative API routes to target apiBase', () => {
        expect(resolveApiUrl('/gemini/generate-stream')).toBe('http://127.0.0.1:3001/gemini/generate-stream');
        expect(resolveApiUrl('/workspace/files?path=test')).toBe('http://127.0.0.1:3001/workspace/files?path=test');
        expect(resolveApiUrl('/api/models')).toBe('http://127.0.0.1:3001/api/models');
        expect(resolveApiUrl('/3d/compile')).toBe('http://127.0.0.1:3001/3d/compile');
        // Non-API routes are preserved as-is
        expect(resolveApiUrl('/styles.css')).toBe('/styles.css');
        // Already resolved absolute URLs are preserved
        expect(resolveApiUrl('http://127.0.0.1:3001/gemini/stream')).toBe('http://127.0.0.1:3001/gemini/stream');
    });

    it('updates Endpoint.getRestUrl() to incorporate apiBase', () => {
        const geminiEndpoint = new Endpoint({ path: 'gemini' });
        expect(geminiEndpoint.getRestUrl().toString()).toBe('http://127.0.0.1:3001/gemini');

        const slashEndpoint = new Endpoint({ path: '/gemini' });
        expect(slashEndpoint.getRestUrl().toString()).toBe('http://127.0.0.1:3001/gemini');
    });

    it('appends token query param for EventSource connections', () => {
        const esUrl = withApiTokenQuery('http://127.0.0.1:3001/workspace/events/file-change');
        expect(esUrl).toBe('http://127.0.0.1:3001/workspace/events/file-change?token=test-token-12345');
    });
});
