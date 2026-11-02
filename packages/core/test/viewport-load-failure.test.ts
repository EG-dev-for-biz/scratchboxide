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
import { isAppPageAnswer, isMissingFileAnswer, isNetworkLoadFailure, networkRetryDelayMs, NETWORK_RETRY_DELAYS_MS } from '../src/browser/generative-canvas/primitives/scene3d/load-failure';
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

    it('tells the app page served in a model file\'s place from a broken file', () => {
        expect(isAppPageAnswer(new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'))).toBe(true);
        expect(isAppPageAnswer(new Error('Unexpected token < in JSON'))).toBe(true);
        expect(isAppPageAnswer(new Error('<html><body>index</body></html>'))).toBe(true);
        expect(isAppPageAnswer(new Error('THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.'))).toBe(false);
        expect(isAppPageAnswer(new Error('fetch for "/models/x.glb" responded with 404: Not Found'))).toBe(false);
        expect(isAppPageAnswer(undefined)).toBe(false);
    });
});

describe('a saved build whose files are not on this machine', () => {
    const base = { webglError: null, generatorError: null, tilesError: null, contentKind: 'objects' as const };

    it('tells a 404 from other answers', () => {
        expect(isMissingFileAnswer(new Error('fetch for "http://127.0.0.1:4110/models/st_mark_s_church_iso_tiles_52c85820.glb" responded with 404: Not Found'))).toBe(true);
        expect(isMissingFileAnswer(new Error('fetch for "/models/x.glb" responded with 410: Gone'))).toBe(true);
        expect(isMissingFileAnswer(new Error('fetch for "/models/x.glb" responded with 500: Internal Server Error'))).toBe(false);
        expect(isMissingFileAnswer(new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'))).toBe(false);
        expect(isMissingFileAnswer(new TypeError('Failed to fetch'))).toBe(false);
        expect(isMissingFileAnswer(undefined)).toBe(false);
    });

    it('says so in plain words, once for all its files, apart from files that are there but broken', () => {
        const notices = resolveViewportNotice({
            ...base,
            objectLoadErrors: [
                { id: 'stg-52c85820-l1', error: 'fetch for "/models/a_tiles_52c85820.glb" responded with 404: Not Found', missingFile: '/models/a_tiles_52c85820.glb' },
                { id: 'stg-10b42025-l2v', error: 'fetch for "/models/a_remesh_10b42025.glb" responded with 404: Not Found', missingFile: '/models/a_remesh_10b42025.glb' },
                { id: 'stg-10b42025-l2v~tex', error: 'fetch for "/models/a_remesh_10b42025.glb" responded with 404: Not Found', missingFile: '/models/a_remesh_10b42025.glb' },
                { id: 'hero', error: 'THREE.GLTFLoader: Unsupported asset.' }
            ]
        });
        expect(notices.map(n => n.kind)).toEqual(['missing-files', 'object-load-error']);
        expect(notices[0].title).toBe('This build\'s files are not on this machine');
        expect(notices[0].detail).toBe('2 of its model files were not found here: the build ran in another checkout of the app, or its files were deleted.\na_tiles_52c85820.glb\na_remesh_10b42025.glb');
        expect(notices[1]).toEqual({ kind: 'object-load-error', title: 'A model failed to load', detail: 'hero: THREE.GLTFLoader: Unsupported asset.' });

        const one = resolveViewportNotice({ ...base, objectLoadErrors: [{ id: 'm', error: 'responded with 404', missingFile: '/models/m.glb' }] });
        expect(one[0].detail).toMatch(/^Its model file was not found here/);
        expect(one[0].action).toBeUndefined();

        // a scene that knows its place offers the rebuild on this lasting notice (an opened chat never rebuilds on its own)
        let rebuilt = 0;
        const offered = resolveViewportNotice({ ...base, objectLoadErrors: [{ id: 'm', error: 'responded with 404', missingFile: '/models/m.glb' }], onRebuildMissing: () => { rebuilt++; } });
        expect(offered[0].detail).toMatch(/so they can be built again \(a new staged build\)\.$/);
        expect(offered[0].action?.label).toBe('Rebuild this location');
        offered[0].action!.onClick();
        expect(rebuilt).toBe(1);
    });
});
