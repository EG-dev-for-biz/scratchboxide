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
 * - the extraction bridge never returns a cached GLB in place of a fresh extraction;
 * - the Places key comes from the same sources as the rest of the app, and a refused key says what to enable;
 * - template scenes and the location splat service never stand in a place, a canned model or a template.
 * All network calls are injected; nothing here is billed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { Google3DTileBlockoutPipelineService, getGoogle3DTilesClay, runTileClayBlockoutRunner } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { GoogleTileDistrictCrawler } from '../src/node/spatial/GoogleTileDistrictCrawler';
import { GeospatialTileExtractionBridge } from '../src/node/spatial/GeospatialTileExtractionBridge';
import { NativePythonRunnerService, expectedGlbFile, findWrittenGlb, stampGlbFile } from '../src/node/3d-engine/native-python-runner-service';
import { python3DHandlers, PYTHON_3D_TOOL_DECLARATIONS } from '../src/node/gemini/tools/python-3d-tools';
import { LocationUnresolvedError, TileExtractionError } from '../src/common/errors/pipeline-errors';
import { GoogleMapsService, PLACES_TEXT_SEARCH_FIELD_MASK, PLACES_TEXT_SEARCH_URL } from '../src/browser/generative-canvas/services/google-maps-service';
import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Location3DGaussianSplatService } from '../src/node/spatial/Location3DGaussianSplatService';

/** A fetch that answers Places Text Search with `place` (or no result) and records each request. */
function placesFetch(place?: Record<string, unknown>) {
    const calls: Array<{ url: string; init: any }> = [];
    const impl = (async (url: any, init?: any) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(place ? { places: [place] } : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { impl, calls };
}

/** A minimal binary glTF: one triangle (3 vertices), or no meshes at all when `empty`. */
function triangleGlb(empty = false): Buffer {
    const positions = Buffer.alloc(36);
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => positions.writeFloatLE(v, i * 4));
    const gltf = empty
        ? { asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }
        : {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0 } }] }],
            buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }]
        };
    let json = Buffer.from(JSON.stringify(gltf));
    if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
    const bin = empty ? Buffer.alloc(0) : positions;
    const chunks = [Buffer.alloc(8), json, ...(bin.length ? [Buffer.alloc(8), bin] : [])];
    chunks[0].writeUInt32LE(json.length, 0); chunks[0].writeUInt32LE(0x4e4f534a, 4);
    if (bin.length) { chunks[2].writeUInt32LE(bin.length, 0); chunks[2].writeUInt32LE(0x004e4942, 4); }
    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + body.length, 8);
    return Buffer.concat([header, body]);
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

describe('Places key sources and refusals', () => {
    const service = new Google3DTileBlockoutPipelineService();
    const flatiron = { displayName: { text: 'Flatiron Building' }, formattedAddress: '175 5th Ave, New York, NY 10010, USA', location: { latitude: 40.7411, longitude: -73.9897 } };

    it('uses the Maps key saved in Settings when the caller passes none', async () => {
        GoogleMapsService.getInstance().setApiKey('settings-maps-key');
        const fake = placesFetch(flatiron);
        const anchor = await service.resolveAddress('Flatiron Building, New York', undefined, fake.impl);
        expect(anchor.formattedAddress).toBe('Flatiron Building, 175 5th Ave, New York, NY 10010, USA');
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].init.headers['X-Goog-Api-Key']).toBe('settings-maps-key');
    });

    it('otherwise reads GOOGLE_MAPS_API_KEY, then MAP_TILES_API_KEY, at call time', async () => {
        process.env.MAP_TILES_API_KEY = 'tiles-env-key';
        const tiles = placesFetch(flatiron);
        await service.resolveAddress('Flatiron Building, New York', undefined, tiles.impl);
        expect(tiles.calls[0].init.headers['X-Goog-Api-Key']).toBe('tiles-env-key');

        process.env.GOOGLE_MAPS_API_KEY = 'maps-env-key';
        const maps = placesFetch(flatiron);
        await service.resolveAddress('Flatiron Building, New York', undefined, maps.impl);
        expect(maps.calls[0].init.headers['X-Goog-Api-Key']).toBe('maps-env-key');
        delete process.env.GOOGLE_MAPS_API_KEY;
        delete process.env.MAP_TILES_API_KEY;
    });

    it('a 403 PERMISSION_DENIED without a reason lists every cause, Google\'s message included', async () => {
        const refused = (async () => new Response(JSON.stringify({
            error: {
                code: 403,
                message: 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.SearchText are blocked.',
                status: 'PERMISSION_DENIED'
            }
        }), { status: 403 })) as typeof fetch;
        const err = await service.resolveAddress('Flatiron Building, New York', 'restricted-key', refused).catch(e => e);
        expect(err).toBeInstanceOf(LocationUnresolvedError);
        expect(err.message).toMatch(/HTTP 403 PERMISSION_DENIED: Requests to this API places\.googleapis\.com/);
        // No structured reason: every cause is listed, not only the API.
        expect(err.message).toMatch(/"Places API \(New\)" \(places\.googleapis\.com\) is enabled/);
        expect(err.message).toMatch(/billing is enabled/);
        expect(err.message).toMatch(/application restrictions/);
    });

    it('a 403 with Google\'s reason gives that reason\'s fix (a referrer-restricted key is not told to enable the API)', async () => {
        const refusal = (reason: string, message: string) => (async () => new Response(JSON.stringify({
            error: { code: 403, message, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] }
        }), { status: 403 })) as typeof fetch;
        const referrer = await service.resolveAddress('Flatiron Building, New York', 'k', refusal('API_KEY_HTTP_REFERRER_BLOCKED', 'Requests from referer <empty> are blocked.')).catch(e => e);
        expect(referrer.message).toMatch(/Requests from referer <empty> are blocked/);
        expect(referrer.message).toMatch(/API_KEY_HTTP_REFERRER_BLOCKED.*only allows certain websites/);
        expect(referrer.message).not.toMatch(/enable "Places API/);
        const disabled = await service.resolveAddress('Flatiron Building, New York', 'k', refusal('SERVICE_DISABLED', 'Places API (New) has not been used in project 1 before or it is disabled.')).catch(e => e);
        expect(disabled.message).toMatch(/enable "Places API \(New\)" \(places\.googleapis\.com\) in the key's Google Cloud project/);
        const billing = await service.resolveAddress('Flatiron Building, New York', 'k', refusal('BILLING_DISABLED', 'This API method requires billing to be enabled.')).catch(e => e);
        expect(billing.message).toMatch(/enable billing/);
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

    it('two places Google names alike are written to different files (no overwrite by display name)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-same-name-'));
        const savedRoot = process.env.SCRATCHBOX_ROOT;
        process.env.SCRATCHBOX_ROOT = root;
        try {
            vi.spyOn(GoogleTileDistrictCrawler.prototype, 'collectLeafTiles').mockResolvedValue({ leaves: [{ uri: 'leaf', box: [] } as any], session: null, requests: 1, excludedCoarseLeaves: 0 });
            vi.spyOn(GoogleTileDistrictCrawler.prototype, 'downloadLeaves').mockResolvedValue([Buffer.from('leaf')]);
            vi.spyOn(GoogleTileDistrictCrawler, 'parseLeafGlbPrimitives').mockReturnValue([]);
            let call = 0;
            vi.spyOn(GoogleTileDistrictCrawler, 'buildDistrictGlb').mockImplementation(() => ({
                glb: Buffer.from(`glTF-district-${++call}`), originEllipsoidalHeightM: 10, vertexCount: 3, triangleCount: 1,
                boundsLocal: { min: [0, 0, 0], max: [1, 1, 1] }, localToEcef: []
            }) as any);
            const ny = placesFetch({ displayName: { text: 'Park Avenue' }, formattedAddress: 'Park Ave, New York, NY, USA', location: { latitude: 40.743077, longitude: -73.983166 } });
            const fl = placesFetch({ displayName: { text: 'Park Avenue' }, formattedAddress: 'Park Ave, Winter Park, FL 32789, USA', location: { latitude: 28.5975, longitude: -81.3509 } });
            const first = await getGoogle3DTilesClay('Park Avenue, New York', { apiKey: 'k', fetchImpl: ny.impl });
            const second = await getGoogle3DTilesClay('Park Avenue, Winter Park, Florida', { apiKey: 'k', fetchImpl: fl.impl });
            expect(first.glbPath).not.toBe(second.glbPath);
            expect(path.basename(first.glbPath)).toBe('park_avenue_40.74308_-73.98317_r250_clay.glb');
            expect(path.basename(second.glbPath)).toBe('park_avenue_28.59750_-81.35090_r250_clay.glb');
            expect(fs.readFileSync(first.glbPath).toString()).toBe('glTF-district-1');
            expect(fs.readFileSync(second.glbPath).toString()).toBe('glTF-district-2');
        } finally {
            if (savedRoot === undefined) delete process.env.SCRATCHBOX_ROOT; else process.env.SCRATCHBOX_ROOT = savedRoot;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('a crawl reports what it measured: no 4K resolution, settle state or rendered frame it never had', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-crawl-quality-'));
        try {
            vi.spyOn(GoogleTileDistrictCrawler.prototype, 'collectLeafTiles').mockResolvedValue({
                leaves: [{ id: 'a', path: 'a', geometricError: 0.4, box: [] }, { id: 'b', path: 'b', geometricError: 1.2, box: [] }] as any,
                session: null, requests: 1, excludedCoarseLeaves: 0
            });
            vi.spyOn(GoogleTileDistrictCrawler.prototype, 'downloadLeaves').mockResolvedValue([Buffer.from('a'), Buffer.from('b')]);
            vi.spyOn(GoogleTileDistrictCrawler, 'parseLeafGlbPrimitives').mockReturnValue([]);
            vi.spyOn(GoogleTileDistrictCrawler, 'buildDistrictGlb').mockImplementation(() => ({
                glb: Buffer.from('glTF-district'), originEllipsoidalHeightM: 10, vertexCount: 3, triangleCount: 1,
                boundsLocal: { min: [0, 0, 0], max: [1, 1, 1] }, localToEcef: []
            }) as any);
            const result = await getGoogle3DTilesClay({ ...anchor, elevation: 12 }, { apiKey: 'k', outputDir: root });
            expect(path.dirname(result.glbPath)).toBe(root);
            expect(result.quality.errorTarget).toBe(1.2); // the largest geometric error among the tiles in the GLB
            expect(result.quality.resolution).toBeUndefined();
            expect(result.quality.leafLodSettled).toBeUndefined();
            expect(result.render).toBeUndefined(); // it used to claim one rendered frame at 24 fps
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('the blockout runner reports only a WebM this run encoded, not one left by an earlier run', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-blockout-webm-'));
        try {
            const outputVideoPath = path.join(dir, 'blockout.mp4');
            fs.writeFileSync(path.join(dir, 'blockout.webm'), 'an earlier run');
            const mesh = { name: 'm', vertexCount: 3, triangleCount: 1, submeshCount: 1, boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }, boundingSphere: { center: [0, 0, 0], radius: 1 } };
            const runResult = { success: true, videoRef: '<VIDEO_REF_0>', outputVideoPath, glbPath: path.join(dir, 'clay.glb'), mesh, firstFramePath: '', firstFramePngPath: '', storyboardPaths: [], manifestPath: '', frameCount: 72, fps: 24, durationSec: 3, geoAnchor: { ...anchor, elevation: 12 }, tileMetrics: { totalFramesCaptured: 72, averageSettleTimeMs: 0, errorTarget: 0.5, renderMode: 'clay' } };
            vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'run').mockResolvedValue(runResult as any);
            const failedEncode = await runTileClayBlockoutRunner({ query: { ...anchor, elevation: 12 }, outputVideoPath });
            expect(failedEncode.webmVideoPath).toBeUndefined();
            vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'run').mockResolvedValue({ ...runResult, webmVideoPath: path.join(dir, 'blockout.webm') } as any);
            const encoded = await runTileClayBlockoutRunner({ query: { ...anchor, elevation: 12 }, outputVideoPath });
            expect(encoded.webmVideoPath).toBe(path.join(dir, 'blockout.webm'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
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

    it('routes places to google_3d_tiles_get_clay and single objects to build_3d_object_from_reference', () => {
        const decl = PYTHON_3D_TOOL_DECLARATIONS.find(d => d.name === 'execute_3d_python_script')!;
        expect(decl.description).toContain('a real-world place on its own goes to google_3d_tiles_get_clay');
        expect(decl.description).toContain('one specific object, or an abstract form, goes to build_3d_object_from_reference');
        expect(decl.description).toContain('an imagined environment or landscape, a scene made of several objects, or an explicit request for a script comes here');
        expect(decl.description).toContain('nothing is carried over from the scene already on the canvas');
        expect(decl.description).not.toMatch(/for both procedural world synthesis and real-world locations/);
        expect(decl.description).not.toMatch(/mansard|townhouses|space colonization/);
        expect(String((decl.parameters.properties as any).coordinates.description)).toMatch(/Never supply coordinates from memory/);
        expect((decl.parameters.properties as any).stageIntoActiveScene).toBeUndefined();
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
        vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1, glbBase64: triangleGlb().toString('base64') } as any);
        const outcome = await python3DHandlers.execute_3d_python_script(
            { script, description: 'Race car staged in Central Park, New York at 40.7829, -73.9654', stageIntoActiveScene: true },
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

describe('execute_3d_python_script: reports only the model the script actually wrote', () => {
    const script = 'import scratchbox as sb\nprint("done")';

    it('a script that writes no GLB fails with no artifact (it used to report "Successfully generated" with 0 objects)', async () => {
        vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockResolvedValue({ success: true, stdout: 'done', stderr: '', exitCode: 0, executionTimeMs: 5 } as any);
        const outcome = await python3DHandlers.execute_3d_python_script({ script, description: 'A cliff village' });
        expect(outcome.status).toBe('failed');
        const payload = outcome.resultPayload as any;
        expect(payload.artifact).toBeUndefined();
        expect(payload.glbGenerated).toBe(false);
        expect(outcome.summaryResult).toMatch(/wrote no GLB/);
        expect(outcome.summaryResult).not.toMatch(/Successfully generated/);
    });

    it('a GLB with no geometry fails too', async () => {
        vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, executionTimeMs: 5, glbBase64: triangleGlb(true).toString('base64') } as any);
        const outcome = await python3DHandlers.execute_3d_python_script({ script, description: 'Nothing' });
        expect(outcome.status).toBe('failed');
        expect(outcome.summaryResult).toMatch(/has no geometry/);
    });

    it('a GLB with geometry completes and reports its vertex count', async () => {
        vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, executionTimeMs: 5, glbBase64: triangleGlb().toString('base64') } as any);
        const outcome = await python3DHandlers.execute_3d_python_script({ script, description: 'Triangle' });
        expect(outcome.status).toBe('completed');
        expect((outcome.resultPayload as any).vertexCount).toBe(3);
        expect(outcome.summaryResult).toMatch(/3 vertices/);
    });

    it('blank optional coordinates ([], {}, "", [null, null], null) run the script unstaged', async () => {
        const extractSpy = vi.spyOn(GeospatialTileExtractionBridge.prototype, 'ingestAndExtract');
        const runSpy = vi.spyOn(NativePythonRunnerService.prototype, 'runScript').mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0, executionTimeMs: 1, glbBase64: triangleGlb().toString('base64') } as any);
        for (const coordinates of [[], {}, '', '   ', [null, null], null, { lat: null, lng: null }]) {
            const outcome = await python3DHandlers.execute_3d_python_script({ script, coordinates, description: 'Car' });
            expect(outcome.status, JSON.stringify(coordinates)).toBe('completed');
        }
        expect(runSpy).toHaveBeenCalledTimes(7);
        expect(extractSpy).not.toHaveBeenCalled();
    });

    it('an explicitly empty elevation ([lat, lng, null] or [lat, lng, \'\']) is the same as leaving it out', async () => {
        const runSpy = vi.spyOn(NativePythonRunnerService.prototype, 'runScript');
        const extractSpy = vi.spyOn(GeospatialTileExtractionBridge.prototype, 'ingestAndExtract').mockRejectedValue(new TileExtractionError('crawl', 'stop here'));
        for (const coordinates of [[40.7411, -73.9897, null], [40.7411, -73.9897, ''], { lat: 40.7411, lng: -73.9897, elevation: null }]) {
            const outcome = await python3DHandlers.execute_3d_python_script({ script, coordinates, description: 'Kiosk' });
            expect(outcome.summaryResult, JSON.stringify(coordinates)).not.toMatch(/coordinates must be/);
            expect(outcome.summaryResult).toContain('Location "40.7411, -73.9897" could not be staged');
        }
        expect(extractSpy).toHaveBeenCalledTimes(3);
        for (const [target] of extractSpy.mock.calls) {
            expect(target).toEqual({ lat: 40.7411, lng: -73.9897 });
        }
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('partial or malformed coordinates fail with a precise error and the script is not run', async () => {
        const runSpy = vi.spyOn(NativePythonRunnerService.prototype, 'runScript');
        for (const coordinates of [[40.7], ['a', 'b'], [1, 2, 3, 4], { lat: 40.7 }, 'not coordinates']) {
            const outcome = await python3DHandlers.execute_3d_python_script({ script, coordinates, description: 'Car' });
            expect(outcome.status, JSON.stringify(coordinates)).toBe('failed');
            expect(outcome.summaryResult).toMatch(/coordinates must be \[latitude, longitude\]/);
            expect(outcome.summaryResult).not.toMatch(/NaN/);
            // The label is what was sent, as JSON: [40.7] used to read "40.7" and [40.7411,-73.9897,null] "40.7411,-73.9897,"
            expect(outcome.summaryResult).toContain(`Location "${typeof coordinates === 'string' ? coordinates : JSON.stringify(coordinates)}"`);
        }
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('describes sb.geospatial.load_location() as paths only, not as the place\'s geometry', () => {
        const decl = PYTHON_3D_TOOL_DECLARATIONS.find(d => d.name === 'execute_3d_python_script')!;
        expect(decl.description).toMatch(/does not get the tiles' geometry: sb\.geospatial\.load_location\(\) returns only/);
        expect(decl.description).not.toMatch(/reads the real geometry of a place/);
    });

    it('the runner reports only a GLB this run wrote at its expected path, never a shared output.glb', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-stale-glb-'));
        try {
            const script = path.join(dir, 'scene_1.py');
            const expected = expectedGlbFile(undefined, script);
            expect(expected).toBe(path.join(dir, 'scene_1.glb'));
            // output.glb written moments ago (same second) by another run in the shared directory is not this run's.
            fs.writeFileSync(path.join(dir, 'output.glb'), triangleGlb());
            expect(findWrittenGlb(expected, stampGlbFile(expected))).toBeUndefined();
            // A file already at the expected path before the run, unchanged, is not this run's model either.
            fs.writeFileSync(expected, triangleGlb());
            const before = stampGlbFile(expected);
            expect(findWrittenGlb(expected, before)).toBeUndefined();
            fs.writeFileSync(expected, triangleGlb(true)); // rewritten during the run
            expect(findWrittenGlb(expected, before)).toBe(expected);
            // A file that did not exist before the run and does now was written by it.
            const fresh = path.join(dir, 'scene_2.glb');
            const none = stampGlbFile(fresh);
            fs.writeFileSync(fresh, triangleGlb());
            expect(findWrittenGlb(fresh, none)).toBe(fresh);
            expect(expectedGlbFile(fresh, script)).toBe(fresh);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a script that writes nothing gets no model, even with a fresh output.glb in its working directory', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-runner-shared-'));
        try {
            fs.writeFileSync(path.join(dir, 'output.glb'), triangleGlb());
            const runner = NativePythonRunnerService.getInstance();
            const silent = await runner.runScript('print("nothing written")', { outputDir: dir, timeoutMs: 60000 });
            expect(silent.success, silent.stderr).toBe(true);
            expect(silent.glbPath).toBeUndefined();
            expect(silent.glbBase64).toBeUndefined();
            // A script that names no path writes where OUTPUT_GLB_PATH (set in its environment) points.
            const viaEnv = await runner.runScript(
                `import os\nwith open(os.environ["OUTPUT_GLB_PATH"], "wb") as f:\n    f.write(bytes.fromhex("${triangleGlb().toString('hex')}"))\n`,
                { outputDir: dir, timeoutMs: 60000 }
            );
            expect(viaEnv.success, viaEnv.stderr).toBe(true);
            expect(viaEnv.glbPath).toMatch(/scene_[^/\\]+\.glb$/);
            expect(path.dirname(viaEnv.glbPath!)).toBe(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120000);
});

describe('survey rerun CLI: the job names its clay GLB or fails with why', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const runCli = (jobFile: string) => new Promise<{ code: number | null }>((resolve) => {
        execFile(path.join(repoRoot, 'node_modules/.bin/vite-node'), [path.join(repoRoot, 'scripts/run_survey_pipeline_cli.ts'), '--job-file', jobFile],
            { cwd: repoRoot, timeout: 120000 }, (err) => resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0 }));
    });

    it('a job without a glbPath (or with a missing one) ends with a MissingInputError, not a TypeError', async () => {
        // The CLI used to path.resolve(root, preset.glbPath) with no GLB and crash with "paths[1] must be of type string".
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-survey-cli-'));
        try {
            const anchor = { lat: 41.8902, lng: 12.4922, elevationMeters: 22 };
            const cases: Array<[Record<string, unknown>, RegExp]> = [
                [{ anchor, location: 'Colosseum, Rome' }, /survey rerun-pipeline needs glbPath: extract the location first/],
                [{ anchor, location: 'Colosseum, Rome', glbPath: path.join(dir, 'missing.glb') }, /survey rerun-pipeline needs glbPath: .*missing\.glb does not exist/]
            ];
            for (const [request, expected] of cases) {
                const jobFile = path.join(dir, `job_${Math.random().toString(36).slice(2)}.json`);
                fs.writeFileSync(jobFile, JSON.stringify({ id: 'test', status: 'running', request }));
                const { code } = await runCli(jobFile);
                const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
                expect(code).not.toBe(0);
                expect(job.status).toBe('error');
                expect(job.error).toMatch(expected);
                expect(job.error).not.toMatch(/paths\[1\]|TypeError/);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 240000);
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

    it('names its files by the resolved place, radius and mode, never by the query text', async () => {
        // The files used to be named by the first 40 characters of the text, so places described alike (or one place
        // in clay and in full texture) overwrote each other's <slug>_tiles.glb and manifest.
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bridge-names-'));
        try {
            const label = 'The intersection of Fifth Avenue and Broadway';
            const bridge = GeospatialTileExtractionBridge.getInstance();
            const newYork = await bridge.ingestAndExtract({ lat: 40.7411, lng: -73.9897, elevation: 12, landmarkName: label }, { mode: 'clay', mockExecution: true, outputDir });
            const rome = await bridge.ingestAndExtract({ lat: 41.8902, lng: 12.4922, elevation: 22, landmarkName: label }, { mode: 'clay', mockExecution: true, outputDir });
            const newYorkTextured = await bridge.ingestAndExtract({ lat: 40.7411, lng: -73.9897, elevation: 12, landmarkName: label }, { mode: 'full_texture', mockExecution: true, outputDir });
            const glbs = [newYork.glbPath, rome.glbPath, newYorkTextured.glbPath];
            const manifests = [newYork.manifestPath, rome.manifestPath, newYorkTextured.manifestPath];
            expect(new Set(glbs).size).toBe(3);
            expect(new Set(manifests).size).toBe(3);
            expect(path.basename(newYork.glbPath)).toMatch(/40\.74110_-73\.98970_r\d+_clay\.glb$/);
            expect(path.basename(newYorkTextured.glbPath)).toMatch(/40\.74110_-73\.98970_r\d+_textured\.glb$/);
            for (const r of [newYork, rome, newYorkTextured]) {
                expect(path.dirname(r.glbPath)).toBe(outputDir);
                expect(r.manifestPath).toBe(r.glbPath.replace(/\.glb$/, '_manifest.json'));
                expect(JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')).tileGlbPath).toBe(r.glbPath);
            }
        } finally {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
    });
});

describe('template scenes never stand in a place or an object build', () => {
    it('neither the python tool nor the template synthesizer uses the keyword hero-object templates', () => {
        for (const file of ['../src/node/gemini/tools/python-3d-tools.ts', '../src/browser/generative-canvas/procedural-3d-synthesizer.ts']) {
            const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
            expect(source, file).not.toMatch(/adaptive-hero-synthesizer|synthesizeAdaptiveHero/);
            expect(source, file).not.toMatch(/CreativeLocationCastingService|castCreativeLocation/);
        }
    });

    it('object prompts do not become an "ADA Hero Asset" template, and no scene gets a location from prompt words', () => {
        for (const prompt of ['build a 3d drone', 'a robot arm machine', 'race car in Central Park, New York', 'F1 car at the Monaco GP circuit', 'downtown city skyline']) {
            const scene = synthesizeContextual3DScene(prompt);
            expect(scene.title, prompt).not.toMatch(/ADA Hero Asset|Staged in|3D Real-World Clay Model/);
            expect(scene.geoAnchor, prompt).toBeUndefined();
            expect(JSON.stringify(scene.objects || []), prompt).not.toMatch(/google-tiles|Google3DTilesClay/);
        }
    });
});

describe("Location3DGaussianSplatService: the place's own fresh tiles or a failure", () => {
    it('a failed extraction fails the call; stale or canned GLBs on disk are never used', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-splat-no-canned-'));
        try {
            const models = path.join(root, 'public/models');
            fs.mkdirSync(models, { recursive: true });
            for (const name of ['flatiron_clay.glb', 'flatiron_grounded.glb', 'flatiron.glb', 'survey_box_ground.glb', 'colosseum_clay.glb']) {
                fs.writeFileSync(path.join(models, name), Buffer.from('glTF-canned'));
            }
            const generate = vi.fn(async () => { throw new Error('no image generation in this test'); });
            const service = new Location3DGaussianSplatService({ workspaceRoot: root });
            const err = await service.generate({
                location: 'Flatiron',
                lat: 40.7411,
                lng: -73.9897,
                elevation: 12,
                workspaceRoot: root,
                generator: { name: 'refuse', generate } as any
            }).catch(e => e);
            expect(err).toBeInstanceOf(TileExtractionError);
            expect(err.message).toMatch(/no Google Maps API key/);
            expect(generate).not.toHaveBeenCalled();
            expect(fs.readFileSync(path.join(models, 'flatiron_clay.glb')).toString()).toBe('glTF-canned');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
