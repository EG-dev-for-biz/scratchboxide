/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The location path does what was asked or fails with a typed error:
 * - place names are one Google Places API (New) Text Search call (no dictionary, no substring matching);
 * - coordinates are read only from text that is entirely a coordinate pair, and (0, 0) is rejected;
 * - tile extraction uses the leaf crawler only (no headless-runner fallback);
 * - execute_3d_python_script fails, without running the script, when the requested place cannot be extracted;
 * - the extraction bridge never returns a cached GLB in place of a fresh extraction.
 * All network calls are injected; nothing here is billed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Google3DTileBlockoutPipelineService, getGoogle3DTilesClay } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { GoogleTileDistrictCrawler } from '../src/node/spatial/GoogleTileDistrictCrawler';
import { GeospatialTileExtractionBridge } from '../src/node/spatial/GeospatialTileExtractionBridge';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { python3DHandlers, PYTHON_3D_TOOL_DECLARATIONS } from '../src/node/gemini/tools/python-3d-tools';
import { LocationUnresolvedError, TileExtractionError } from '../src/common/errors/pipeline-errors';
import { GoogleMapsService, PLACES_TEXT_SEARCH_FIELD_MASK, PLACES_TEXT_SEARCH_URL } from '../src/browser/generative-canvas/services/google-maps-service';

/** A fetch that answers Places Text Search with `place` (or no result) and records each request. */
function placesFetch(place?: Record<string, unknown>) {
    const calls: Array<{ url: string; init: any }> = [];
    const impl = (async (url: any, init?: any) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(place ? { places: [place] } : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { impl, calls };
}

const savedEnv = { g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
let savedStateKey = '';
beforeEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.MAP_TILES_API_KEY;
    savedStateKey = GoogleMapsService.getInstance().getApiKey();
    GoogleMapsService.getInstance().setApiKey('');
});
afterEach(() => {
    vi.restoreAllMocks();
    GoogleMapsService.getInstance().setApiKey(savedStateKey);
    if (savedEnv.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = savedEnv.g;
    if (savedEnv.m !== undefined) process.env.MAP_TILES_API_KEY = savedEnv.m;
});

describe('resolveAddress: Google Places Text Search, never a dictionary', () => {
    const service = new Google3DTileBlockoutPipelineService();

    // Each query once resolved to a wrong place from a built-in table or a substring regex.
    const cases: Array<{ query: string; wrong: [number, number]; place: Record<string, unknown>; expect: [number, number]; address: string }> = [
        {
            query: 'Park Avenue, Winter Park, Florida',
            wrong: [40.743077, -73.983166], // Park Avenue, New York
            place: { displayName: { text: 'Park Avenue' }, formattedAddress: 'Park Ave, Winter Park, FL 32789, USA', location: { latitude: 28.5975, longitude: -81.3509 } },
            expect: [28.5975, -81.3509],
            address: 'Park Avenue, Park Ave, Winter Park, FL 32789, USA'
        },
        {
            query: 'gondola in venice',
            wrong: [33.985, -118.4695], // Venice Beach Boardwalk, Los Angeles
            place: { displayName: { text: 'Gondola Service Venice' }, formattedAddress: 'Fondamenta Bacino Orseolo, 30124 Venezia VE, Italy', location: { latitude: 45.4345, longitude: 12.3371 } },
            expect: [45.4345, 12.3371],
            address: 'Gondola Service Venice, Fondamenta Bacino Orseolo, 30124 Venezia VE, Italy'
        },
        {
            query: 'Pier 39, 2 Beach St, San Francisco',
            wrong: [39, 2], // the two numbers in the address read as lat/lng
            place: { displayName: { text: 'PIER 39' }, formattedAddress: 'The Embarcadero, San Francisco, CA 94133, USA', location: { latitude: 37.8087, longitude: -122.4098 } },
            expect: [37.8087, -122.4098],
            address: 'PIER 39, The Embarcadero, San Francisco, CA 94133, USA'
        }
    ];

    it.each(cases)('without a Maps key "$query" throws LocationUnresolvedError instead of a table match', async ({ query }) => {
        const unused = placesFetch(undefined);
        const err = await service.resolveAddress(query, undefined, unused.impl).catch(e => e);
        expect(err).toBeInstanceOf(LocationUnresolvedError);
        expect(err.query).toBe(query);
        expect(err.message).toMatch(/no Google Maps API key/);
        expect(unused.calls).toHaveLength(0);
    });

    it.each(cases)('"$query" resolves to the Places result, with its exact address, from one searchText call', async ({ query, wrong, place, expect: [lat, lng], address }) => {
        const fake = placesFetch(place);
        const anchor = await service.resolveAddress(query, 'test-maps-key', fake.impl);
        expect(anchor.lat).toBeCloseTo(lat, 6);
        expect(anchor.lng).toBeCloseTo(lng, 6);
        expect(Math.abs(anchor.lat - wrong[0]) > 0.5 || Math.abs(anchor.lng - wrong[1]) > 0.5).toBe(true);
        expect(anchor.formattedAddress).toBe(address);
        expect(anchor.elevation).toBeUndefined(); // never a 15 m default

        expect(fake.calls).toHaveLength(1);
        const [{ url, init }] = fake.calls;
        expect(url).toBe(PLACES_TEXT_SEARCH_URL);
        expect(init.method).toBe('POST');
        expect(init.headers['X-Goog-Api-Key']).toBe('test-maps-key');
        expect(init.headers['X-Goog-FieldMask']).toBe(PLACES_TEXT_SEARCH_FIELD_MASK);
        expect(JSON.parse(init.body).textQuery).toBe(query);
    });

    it('a Places answer with no result, or an HTTP error, throws LocationUnresolvedError', async () => {
        await expect(service.resolveAddress('zzqx nowhere', 'test-maps-key', placesFetch(undefined).impl)).rejects.toThrow(/Google Places found no place/);
        const denied = (async () => new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 })) as typeof fetch;
        await expect(service.resolveAddress('Flatiron Building', 'bad-key', denied)).rejects.toThrow(/HTTP 400: API key not valid/);
    });

    it('reads coordinates only from text that is entirely a coordinate pair, and rejects (0, 0)', async () => {
        const fake = placesFetch(undefined);
        const anchor = await service.resolveAddress('40.7411, -73.9897', undefined, fake.impl);
        expect([anchor.lat, anchor.lng]).toEqual([40.7411, -73.9897]);
        expect(anchor.formattedAddress).toBe('40.741100, -73.989700');
        expect(fake.calls).toHaveLength(0);
        await expect(service.resolveAddress('0, 0')).rejects.toBeInstanceOf(LocationUnresolvedError);
        await expect(service.resolveAddress({ lat: 0, lng: 0 })).rejects.toBeInstanceOf(LocationUnresolvedError);
        await expect(service.resolveAddress('91, 10')).rejects.toBeInstanceOf(LocationUnresolvedError);
    });
});

describe('fetch3DObject: the leaf crawler or a typed failure, never the headless runner', () => {
    const anchor = { lat: 40.7411, lng: -73.9897 };

    it('a failing crawler rejects with TileExtractionError("crawl") and never calls run()', async () => {
        const runSpy = vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'run');
        const tileRequests: string[] = [];
        const failingTiles = (async (url: any) => {
            tileRequests.push(String(url));
            return new Response('forbidden', { status: 403 });
        }) as typeof fetch;
        const err = await getGoogle3DTilesClay(anchor, { apiKey: 'test-maps-key', fetchImpl: failingTiles }).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.stage).toBe('crawl');
        expect(err.message).toMatch(/HTTP 403/);
        expect(tileRequests.length).toBeGreaterThan(0);
        expect(tileRequests[0]).toContain('tile.googleapis.com');
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('a place with no tile coverage throws instead of returning something else', async () => {
        const runSpy = vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'run');
        vi.spyOn(GoogleTileDistrictCrawler.prototype, 'collectLeafTiles').mockResolvedValue({ leaves: [], session: null, requests: 1, excludedCoarseLeaves: 0 });
        const err = await getGoogle3DTilesClay(anchor, { apiKey: 'test-maps-key' }).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.message).toMatch(/no Photorealistic 3D Tiles coverage at 40\.741100, -73\.989700/);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('without a Maps key it throws instead of switching to the blockout runner', async () => {
        const runSpy = vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'run');
        const err = await getGoogle3DTilesClay(anchor).catch(e => e);
        expect(err).toBeInstanceOf(TileExtractionError);
        expect(err.message).toMatch(/no Google Maps API key/);
        expect(runSpy).not.toHaveBeenCalled();
    });
});

describe('execute_3d_python_script: a requested place is extracted or the call fails', () => {
    const script = 'import scratchbox as sb\nscene = sb.Scene()\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)';

    it('no longer advertises itself as the way to stage real-world locations', () => {
        const decl = PYTHON_3D_TOOL_DECLARATIONS.find(d => d.name === 'execute_3d_python_script')!;
        expect(decl.description).toContain('for a place use google_3d_tiles_get_clay');
        expect(decl.description).toContain('build_3d_object_from_reference');
        expect(decl.description).not.toMatch(/for both procedural world synthesis and real-world locations/);
        expect(String((decl.parameters.properties as any).coordinates.description)).toMatch(/Never supply coordinates from memory/);
    });

    it('a failing extraction returns failed with no artifact, and the script is not run', async () => {
        const runSpy = vi.spyOn(NativePythonRunnerService.prototype, 'runScript');
        vi.spyOn(GeospatialTileExtractionBridge.prototype, 'ingestAndExtract').mockRejectedValue(new TileExtractionError('crawl', 'Google 3D Tiles request failed (HTTP 403)'));
        const outcome = await python3DHandlers.execute_3d_python_script({ script, location: 'Flatiron Building, New York', description: 'Kiosk' });
        expect(outcome.status).toBe('failed');
        const payload = outcome.resultPayload as any;
        expect(payload.success).toBe(false);
        expect(payload.artifact).toBeUndefined();
        expect(payload.errorCode).toBe('tile_extraction_failed');
        expect(payload.stage).toBe('crawl');
        expect(outcome.summaryResult).toMatch(/could not be staged; the script was not run/);
        expect(outcome.summaryResult).not.toMatch(/Staged in/);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('an unsuccessful or mock extraction result also fails the call', async () => {
        const runSpy = vi.spyOn(NativePythonRunnerService.prototype, 'runScript');
        vi.spyOn(GeospatialTileExtractionBridge.prototype, 'ingestAndExtract').mockResolvedValue({ success: true, mock: true, manifest: {} as any, manifestPath: '/tmp/x.json', glbPath: '/tmp/x.glb' });
        const outcome = await python3DHandlers.execute_3d_python_script({ script, location: 'Flatiron Building, New York' });
        expect(outcome.status).toBe('failed');
        expect((outcome.resultPayload as any).artifact).toBeUndefined();
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('rejects [0, 0] coordinates without extracting or running anything', async () => {
        const runSpy = vi.spyOn(NativePythonRunnerService.prototype, 'runScript');
        const extractSpy = vi.spyOn(GeospatialTileExtractionBridge.prototype, 'ingestAndExtract');
        const outcome = await python3DHandlers.execute_3d_python_script({ script, coordinates: [0, 0], description: 'Car' });
        expect(outcome.status).toBe('failed');
        expect((outcome.resultPayload as any).errorCode).toBe('location_unresolved');
        expect(extractSpy).not.toHaveBeenCalled();
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('never detects a location from the description', async () => {
        const extractSpy = vi.spyOn(GeospatialTileExtractionBridge.prototype, 'ingestAndExtract');
        vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1 } as any);
        const outcome = await python3DHandlers.execute_3d_python_script(
            { script, description: 'Race car staged in Central Park, New York at 40.7829, -73.9654' },
            { request: { canvasState: { activeArtifact: { type: '3d-scene', data: { geoAnchor: { lat: 41.89, lng: 12.49 }, objects: [{ id: 'old-tiles', content: { metadata: { role: 'environment', source: 'google_3d_tiles_clay' } } }] } } } } }
        );
        expect(outcome.status).toBe('completed');
        expect(extractSpy).not.toHaveBeenCalled();
        const data = (outcome.resultPayload as any).artifact.data;
        // Not staged: no "Staged in", no ground, and nothing carried over from the previous scene
        expect(data.title).not.toMatch(/Staged in/);
        expect(data.environment.ground).toBe(false);
        expect(data.geoAnchor).toBeUndefined();
        expect(data.groundTileMode).toBeUndefined();
        expect(data.objects.some((o: any) => o.id === 'old-tiles')).toBe(false);
    });
});

describe('GeospatialTileExtractionBridge: every call extracts fresh tiles', () => {
    it('does not return a GLB and manifest already on disk under the same name', async () => {
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bridge-no-cache-'));
        try {
            const query = { lat: 40.7411, lng: -73.9897, elevation: 12, landmarkName: 'Flatiron' };
            const slug = 'flatiron_40_7411_73_9897';
            const staleGlb = path.join(outputDir, `${slug}_tiles.glb`);
            const staleManifest = path.join(outputDir, `${slug}_manifest.json`);
            fs.writeFileSync(staleGlb, Buffer.from('glTF-stale-previous-run'));
            fs.writeFileSync(staleManifest, JSON.stringify({ totalVertices: 5000, resolvedAddress: 'a previous run' }));

            const result = await GeospatialTileExtractionBridge.getInstance().ingestAndExtract(query, { mode: 'clay', mockExecution: true, outputDir });
            expect(result.mock).toBe(true);
            expect(result.glbPath).not.toBe(staleGlb); // fresh extraction, never the cached file
            expect(fs.readFileSync(staleGlb).toString()).toBe('glTF-stale-previous-run');
            expect(result.manifest.resolvedAddress).not.toBe('a previous run');
            expect(result.manifest.totalVertices).not.toBe(5000);
            expect(fs.readFileSync(result.glbPath).toString('ascii', 0, 4)).toBe('glTF');
        } finally {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
    });
});
