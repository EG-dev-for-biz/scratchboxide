/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A model file the server answered about (404) is a failure the viewport reports and recovers; a load that never
 * reached the server (the dev server restarting under the page: `TypeError: Failed to fetch`) is retried on its own
 * with growing delays and shown as a quiet "Waiting for the server" status, never as "N models failed to load", until
 * the retries are spent (load-failure.ts, ViewportNotice.tsx).
 */

import { describe, expect, it } from 'vitest';
import { isNetworkLoadFailure, networkRetryDelayMs, NETWORK_RETRY_DELAYS_MS } from '../src/browser/generative-canvas/primitives/scene3d/load-failure';
import { resolveViewportNotice } from '../src/browser/generative-canvas/primitives/scene3d/ViewportNotice';

describe('model loads that could not reach the server', () => {
    it('tells a connection failure from an answer about the file', () => {
        expect(isNetworkLoadFailure(new TypeError('Failed to fetch'))).toBe(true);
        expect(isNetworkLoadFailure(new TypeError('Load failed'))).toBe(true);                                  // WebKit
        expect(isNetworkLoadFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true); // Firefox
        expect(isNetworkLoadFailure(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(true);
        expect(isNetworkLoadFailure(new Error('fetch for "http://127.0.0.1:3101/models/x.glb" responded with 404: Not Found'))).toBe(false);
        expect(isNetworkLoadFailure(new Error('fetch for "http://127.0.0.1:3101/models/x.glb" responded with 500: Internal Server Error'))).toBe(false);
        expect(isNetworkLoadFailure(new Error('Unexpected token < in JSON'))).toBe(false);
        expect(isNetworkLoadFailure(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))).toBe(false);
        expect(isNetworkLoadFailure(undefined)).toBe(false);
    });

    it('retries with growing delays, about 30 s in all, then gives up', () => {
        expect(NETWORK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(25_000);
        expect(networkRetryDelayMs(1)).toBe(1_000);
        expect(networkRetryDelayMs(NETWORK_RETRY_DELAYS_MS.length)).toBe(15_000);
        expect(networkRetryDelayMs(NETWORK_RETRY_DELAYS_MS.length + 1)).toBeUndefined();
        expect(networkRetryDelayMs(0)).toBeUndefined();
    });

    it('shows a quiet status while retrying, and the alert only for files the server answered about', () => {
        const base = { webglError: null, generatorError: null, tilesError: null, contentKind: 'objects' as const };
        const waiting = resolveViewportNotice({ ...base, reconnecting: 5 });
        expect(waiting).toEqual([{ kind: 'reconnecting', title: 'Waiting for the server', detail: '5 model files could not be fetched; trying again (the server may be restarting).' }]);
        const one = resolveViewportNotice({ ...base, reconnecting: 1 });
        expect(one[0].detail).toMatch(/^A model file could not be fetched/);
        const both = resolveViewportNotice({ ...base, reconnecting: 2, objectLoadErrors: [{ id: 'hero', error: 'fetch for "/models/hero.glb" responded with 404: Not Found' }] });
        expect(both.map(n => n.kind)).toEqual(['object-load-error', 'reconnecting']);
        expect(resolveViewportNotice({ ...base, reconnecting: 0 })).toEqual([]);
    });
});
