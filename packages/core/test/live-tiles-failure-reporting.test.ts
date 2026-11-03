/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A live Google 3D Tiles failure reaches the viewport and the chat (2026-11-03). A test instance with no Maps key
 * mounted a scene at the Empire State Building: the renderer was started without a key, Google answered 403, the
 * error reached only the console, the viewport was empty and the reply said the tiles were streaming.
 *
 * Nothing here reaches Google: the key is a made-up string and every request goes to a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { syncTilesLayer, tilesLoadFailureMessage } from '../src/browser/generative-canvas/primitives/scene3d/syncTilesLayer';
import { tilesLoadFailure } from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
import { liveTilesUnavailableReason, liveTilesWindowRecorder, NO_MAPS_KEY_MESSAGE, type LiveTilesWindowRecorder } from '../src/browser/generative-canvas/primitives/scene3d/liveTilesStatus';
import { buildContents } from '../src/node/gemini/prompt-builder';

const ESB = { lat: 40.748817, lng: -73.985428, geoidUndulationMeters: -32.7 };
const TEST_KEY = 'test-maps-key-not-real';

const meshesIn = (scene: THREE.Scene) => {
    let n = 0;
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) n++; });
    return n;
};

const recorder = () => {
    const calls: Array<{ failed?: string; apiKey?: string; loaded?: true }> = [];
    const status: LiveTilesWindowRecorder = {
        failed: (apiKey, message) => calls.push({ failed: message, apiKey }),
        loaded: () => calls.push({ loaded: true })
    };
    return { calls, status };
};

afterEach(() => {
    vi.unstubAllGlobals();
    liveTilesWindowRecorder.loaded();
});

describe('a window with no Maps key starts no tiles renderer and says why', () => {
    it('reports one error with the reason and the fix, creates no layer, looks nothing up and draws nothing', async () => {
        const scene = new THREE.Scene();
        const errors: string[] = [];
        let created = 0;
        let geoidLookups = 0;
        const handle = syncTilesLayer({ scene } as any, { has3DTiles: true, geoAnchor: { lat: ESB.lat, lng: ESB.lng }, renderMode: 'pbr' as any, groundTileMode: 'photoreal-textured' },
            { onError: m => errors.push(m), onLayerReady: () => { throw new Error('no layer may be ready'); } },
            { mapsApiKey: () => '', createLayer: () => { created++; return null; }, fetchGeoidUndulation: async () => { geoidLookups++; return 0; } });
        await new Promise(r => setTimeout(r, 0));
        expect(errors).toEqual([NO_MAPS_KEY_MESSAGE]);
        expect(errors[0]).toContain('no Google Maps API key');
        expect(errors[0]).toContain('Settings > MCP Tools > Maps API Key');
        expect(created).toBe(0);
        expect(geoidLookups).toBe(0);
        expect(handle.tilesLayer).toBeNull();
        expect(scene.children).toHaveLength(0);
        expect(meshesIn(scene)).toBe(0);
    });

    it('a key of spaces is no key', () => {
        const errors: string[] = [];
        syncTilesLayer({ scene: new THREE.Scene() } as any, { has3DTiles: true, geoAnchor: ESB, renderMode: 'clay' }, { onError: m => errors.push(m) },
            { mapsApiKey: () => '   ', createLayer: () => { throw new Error('no layer may be created'); } });
        expect(errors).toEqual([NO_MAPS_KEY_MESSAGE]);
    });

    it('an unusable anchor is still reported as the anchor\'s problem, which the mount tool refuses', () => {
        const errors: string[] = [];
        syncTilesLayer({ scene: new THREE.Scene() } as any, { has3DTiles: true, geoAnchor: { lat: 0, lng: 0 }, renderMode: 'clay' }, { onError: m => errors.push(m) },
            { mapsApiKey: () => '' });
        expect(errors).toEqual([expect.stringContaining('0, 0')]);
    });
});

describe('a tileset Google refuses is reported with its status, and nothing is drawn in its place', () => {
    it('the real tiles renderer, answered 403 for the root tileset, gives one onError with the status and the fix', async () => {
        const requested: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input);
            requested.push(url);
            return new Response(JSON.stringify({ error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }),
                { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json' } });
        }));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const scene = new THREE.Scene();
        const errors: string[] = [];
        const { calls, status } = recorder();
        const handle = syncTilesLayer({ scene } as any, { has3DTiles: true, geoAnchor: ESB, renderMode: 'pbr' as any, groundTileMode: 'photoreal-textured' },
            { onError: m => errors.push(m) }, { mapsApiKey: () => TEST_KEY, windowStatus: status });
        const layer = handle.tilesLayer;
        expect(layer?.tilesRenderer).toBeTruthy();

        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e7);
        for (let frame = 0; frame < 20 && errors.length === 0; frame++) {
            layer.update(camera);
            await new Promise(r => setTimeout(r, 5));
        }
        // more frames ask nothing more of Google and report nothing more
        for (let frame = 0; frame < 5; frame++) layer.update(camera);
        await new Promise(r => setTimeout(r, 20));

        expect(requested.length).toBeGreaterThan(0);
        expect(requested.every(u => new URL(u).host === 'tile.googleapis.com')).toBe(true);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe('Google 3D Tiles did not load (HTTP 403 from Google): the Maps key was refused. Check in Settings > MCP Tools > Maps API Key that it is the right key, that the Map Tiles API is enabled for its project and that its restrictions allow this app.');
        expect(errors[0]).not.toContain(TEST_KEY);
        expect(calls).toEqual([{ failed: errors[0], apiKey: TEST_KEY }]);
        expect(meshesIn(scene)).toBe(0);
        handle.dispose();
    });

    it('reads the status from each form the renderer and its auth plugin write, and masks keys and session tokens', () => {
        expect(tilesLoadFailure({ tile: null, error: new Error('TilesRenderer: Failed to load tileset "https://tile.googleapis.com/v1/3dtiles/root.json" with status 403 : Forbidden') }))
            .toEqual({ root: true, status: 403, detail: 'TilesRenderer: Failed to load tileset "https://tile.googleapis.com/v1/3dtiles/root.json" with status 403 : Forbidden' });
        expect(tilesLoadFailure({ tile: null, error: new Error('GoogleCloudAuth: Failed to load data with error code 429') })).toMatchObject({ root: true, status: 429 });
        expect(tilesLoadFailure({ tile: { id: 1 }, error: new Error('Failed to load model with error code 500') })).toMatchObject({ root: false, status: 500 });
        const offline = tilesLoadFailure({ tile: null, error: new TypeError('Failed to fetch https://tile.googleapis.com/v1/3dtiles/root.json?key=AIzaSECRET&session=SESSION1') });
        expect(offline.status).toBeUndefined();
        expect(offline.detail).not.toContain('AIzaSECRET');
        expect(offline.detail).not.toContain('SESSION1');
    });

    it('says what each answer means: refused key, used-up quota, Google\'s failure, no answer, and a part of the place', () => {
        expect(tilesLoadFailureMessage({ root: true, status: 401, detail: '' })).toContain('the Maps key was refused');
        // Google's answer to a key that is not valid (seen live, 2026-11-03: 400 API_KEY_INVALID); a tile's 400 is not the key's
        expect(tilesLoadFailureMessage({ root: true, status: 400, detail: '' })).toMatch(/^Google 3D Tiles did not load \(HTTP 400 from Google\): the Maps key was refused\. /);
        expect(tilesLoadFailureMessage({ root: false, status: 400, detail: '' })).toBe('Some Google 3D Tiles did not load (HTTP 400 from Google), so parts of the place are missing.');
        expect(tilesLoadFailureMessage({ root: true, status: 429, detail: '' })).toBe('Google 3D Tiles did not load (HTTP 429 from Google): the Maps key\'s Map Tiles quota is used up for now.');
        expect(tilesLoadFailureMessage({ root: true, status: 503, detail: '' })).toBe('Google 3D Tiles did not load (HTTP 503 from Google): Google\'s tiles service failed; it may work again later.');
        expect(tilesLoadFailureMessage({ root: true, status: 404, detail: '' })).toBe('Google 3D Tiles did not load (HTTP 404 from Google).');
        expect(tilesLoadFailureMessage({ root: true, detail: 'Failed to fetch' })).toBe('Google 3D Tiles did not load: Google could not be reached (Failed to fetch).');
        expect(tilesLoadFailureMessage({ root: false, status: 403, detail: '' })).toMatch(/^Some Google 3D Tiles did not load \(HTTP 403 from Google\), so parts of the place are missing: the Maps key was refused/);
    });

    it('a failing tile is reported once, does not tell the chat the tiles are unavailable, and no ground report clears it', () => {
        const errors: string[] = [];
        let recovered = 0;
        let groundY: number | null = null;
        const { calls, status } = recorder();
        const layer: any = { group: new THREE.Group(), getTerrainManager: () => ({ sampleGroundHeight: () => groundY }), updateOrigin: () => { groundY = 0; }, dispose: () => {} };
        syncTilesLayer({ scene: new THREE.Scene() } as any, { has3DTiles: true, geoAnchor: { lat: ESB.lat, lng: ESB.lng, geoidUndulationMeters: ESB.geoidUndulationMeters }, renderMode: 'clay' },
            { onError: m => errors.push(m), onRecovered: () => recovered++ }, { mapsApiKey: () => TEST_KEY, windowStatus: status, createLayer: () => layer });
        layer.onTileLoaded();
        layer.onLoadError({ root: false, status: 429, detail: '' });
        layer.onLoadError({ root: false, status: 429, detail: '' });
        for (let i = 0; i < 40; i++) layer.onTileLoaded();
        groundY = 12;
        layer.onTileLoaded();
        expect(errors).toEqual([expect.stringMatching(/^Some Google 3D Tiles did not load \(HTTP 429 from Google\)/)]);
        expect(recovered).toBe(0);
        expect(calls).toEqual([{ loaded: true }]);
    });

    it('nothing is reported after the scene is closed', () => {
        const errors: string[] = [];
        const layer: any = { group: new THREE.Group(), getTerrainManager: () => ({}), dispose: () => {} };
        const handle = syncTilesLayer({ scene: new THREE.Scene() } as any, { has3DTiles: true, geoAnchor: ESB, renderMode: 'clay' },
            { onError: m => errors.push(m) }, { mapsApiKey: () => TEST_KEY, windowStatus: recorder().status, createLayer: () => layer });
        const report = layer.onLoadError;
        handle.dispose();
        expect(layer.onLoadError).toBeUndefined();
        report({ root: true, status: 403, detail: '' });
        expect(errors).toEqual([]);
    });
});

describe('the window tells each chat turn whether live tiles can load', () => {
    it('no key, then a refused key, then a key saved since, then a load that worked', () => {
        expect(liveTilesUnavailableReason('')).toBe(NO_MAPS_KEY_MESSAGE);
        expect(liveTilesUnavailableReason(TEST_KEY)).toBeUndefined();
        liveTilesWindowRecorder.failed(TEST_KEY, 'Google 3D Tiles did not load (HTTP 403 from Google): the Maps key was refused.');
        expect(liveTilesUnavailableReason(TEST_KEY)).toBe('Google 3D Tiles did not load (HTTP 403 from Google): the Maps key was refused.');
        // a different key may work, so it is not judged by the old one's failure
        expect(liveTilesUnavailableReason('another-key-not-real')).toBeUndefined();
        liveTilesWindowRecorder.loaded();
        expect(liveTilesUnavailableReason(TEST_KEY)).toBeUndefined();
    });

    it('the turn\'s prompt carries the window\'s reason, and says nothing when there is none', () => {
        const userText = (request: Parameters<typeof buildContents>[0]) => (buildContents(request).at(-1)!.parts![0] as { text: string }).text;
        const told = userText({ prompt: '3D scene at the Empire State Building with live photorealistic tiles', liveTilesUnavailable: NO_MAPS_KEY_MESSAGE });
        expect(told).toContain(`[LIVE 3D TILES UNAVAILABLE IN THIS WINDOW: ${NO_MAPS_KEY_MESSAGE}`);
        expect(told).toContain('never say the tiles are streaming or visible');
        expect(userText({ prompt: '3D scene at the Empire State Building' })).not.toContain('LIVE 3D TILES');
        expect(userText({ prompt: 'x', liveTilesUnavailable: '  ' })).not.toContain('LIVE 3D TILES');
    });
});
