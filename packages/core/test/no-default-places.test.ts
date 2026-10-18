/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * No caller on the location path substitutes a place it was not given: no place tables, no substring matches, no
 * default coordinates (Colosseum, Empire State Building, San Francisco, Lexington, latitude 45) and no invented
 * elevations. Each case below once returned one of those. Places API calls are injected; nothing here is billed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { GoogleMapsService } from '../src/browser/generative-canvas/services/google-maps-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { LocationObjectLightingService } from '../src/browser/generative-canvas/services/atmosphere/LocationObjectLightingService';
import { SurveyApi, resolveSurveyPreset } from '../src/node/spatial/survey-router';
import { AdaptiveSurveyRigService } from '../src/node/spatial/AdaptiveSurveyRigService';
import { Universal3DStructureFoundation } from '../src/node/spatial/Universal3DStructureFoundation';
import { GoogleElevationService } from '../src/browser/generative-canvas/services/google-elevation-service';
import { ColmapVectorPipeline } from '../src/browser/generative-canvas/services/colmap-vector-pipeline';
import { buildBlockoutNanoBananaPrompt } from '../src/browser/generative-canvas/services/video/omniVideoPromptService';
import { matchImageAndLightingToLocation } from '../src/node/spatial/PhotometricUsdBridgeService';
import { InverseLightingEstimatorService } from '../src/node/spatial/InverseLightingEstimatorService';
import { WebXRGeospatialAnchorBridge } from '../src/browser/generative-canvas/services/xr/WebXRGeospatialAnchorBridge';
import { HeadlessSpatialAiBridge } from '../src/node/spatial/HeadlessSpatialAiBridge';
import { ChronoSpatialDeductionEngine } from '../src/node/spatial/ChronoSpatialDeductionEngine';
import { SpatialAssetVaultService } from '../src/node/spatial/SpatialAssetVaultService';
import { GoogleSolarService } from '../src/browser/generative-canvas/services/google-solar-service';
import { Scene3DWorldLens } from '../src/browser/generative-canvas/lenses/Scene3DWorldLens';
import { GeoCameraMatchmovePipelineService } from '../src/node/spatial/GeoCameraMatchmovePipelineService';
import { mapsKeyStatus, preferSavedMapsKey, saveMapsKeySetting, MAPS_KEY_STORE_ACCOUNT, MAPS_KEY_STORE_SERVICE } from '../src/node/spatial/maps-key-settings';
import { syncSavedMapsKeyToServer } from '../src/browser/generative-canvas/settings/maps-key-sync';
import { encodePng } from '../src/node/texture-processing';

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
    vi.unstubAllGlobals();
    GoogleMapsService.getInstance().setApiKey(savedStateKey);
    if (savedEnv.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = savedEnv.g; else delete process.env.GOOGLE_MAPS_API_KEY;
    if (savedEnv.m !== undefined) process.env.MAP_TILES_API_KEY = savedEnv.m; else delete process.env.MAP_TILES_API_KEY;
});

/** Answers Places Text Search with `place` for every query (global fetch stub) and records the queries. */
function stubPlaces(place: { name: string; address: string; lat: number; lng: number }) {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
        if (String(url).includes('places:searchText')) {
            queries.push(JSON.parse(init.body).textQuery);
            return new Response(JSON.stringify({ places: [{ displayName: { text: place.name }, formattedAddress: place.address, location: { latitude: place.lat, longitude: place.lng } }] }), { status: 200 });
        }
        return new Response('not stubbed', { status: 404 });
    }));
    GoogleMapsService.getInstance().setApiKey('test-maps-key');
    return queries;
}

/** A small RGBA PNG on disk (a sky band over ground). */
function writePng(dir: string, name: string): string {
    const w = 48, h = 32;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // Sky over sunlit ground with a cast shadow on its right half.
        const c = y < h * 0.4 ? [120, 180, 240] : x < w / 2 ? [170, 150, 110] : [70, 66, 62];
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
    const p = path.join(dir, name);
    fs.writeFileSync(p, encodePng(w, h, rgba));
    return p;
}

describe('location lighting: the sun is computed where the place is', () => {
    const registry = createDefaultToolRegistry();

    it('a landmark name is resolved with Google Places, not a substring table ("Opera" used to mean Sydney)', async () => {
        const queries = stubPlaces({ name: 'Metropolitan Opera House', address: '30 Lincoln Center Plaza, New York, NY 10023, USA', lat: 40.7725, lng: -73.9840 });
        const outcome = await registry.dispatch('geobox_harmonize_location_lighting', { landmarkName: 'Metropolitan Opera, New York', isoDate: '2026-06-21T23:00:00Z' }, {} as any);
        expect(outcome.exec.status).toBe('completed');
        expect(queries).toEqual(['Metropolitan Opera, New York']);
        const ctx = (outcome.resultPayload as any).landmarkContext;
        expect(ctx.coordinates.lat).toBeCloseTo(40.7725, 4); // not -33.8568 (Sydney Opera House)
        expect(ctx.name).toBe('Metropolitan Opera House, 30 Lincoln Center Plaza, New York, NY 10023, USA');
        expect(outcome.exec.summaryResult).toContain('(40.772500, -73.984000; sun at 2026-06-21T23:00:00Z)');
    });

    it('without coordinates or a resolvable name it fails: no (45, 0) and no regex over the name', async () => {
        expect(() => LocationObjectLightingService.harmonizeLocationObjectAtmosphere({ landmarkName: 'Paris, Texas' })).toThrow(MissingInputError);
        expect(() => LocationObjectLightingService.harmonizeLocationObjectAtmosphere({ landmarkName: '41.89, 12.49 Rome' })).toThrow(MissingInputError);
        const outcome = await registry.dispatch('atmosphere_harmonize_location_3d', { landmarkName: 'Flatiron Building, New York' }, {} as any);
        expect(outcome.exec.status).toBe('failed');
        expect(String((outcome.resultPayload as any).error)).toMatch(/no Google Maps API key/);
    });

    it('reports when the instant the sun was computed for was assumed', () => {
        const result = LocationObjectLightingService.harmonizeLocationObjectAtmosphere({ latitude: 40.7411, longitude: -73.9897 });
        expect(result.landmarkContext?.isoDateAssumed).toBe(true);
        expect(result.landmarkContext?.name).toBe('40.741100, -73.989700');
    });
});

describe('vector world and survey tools need the place: no Empire State Building or 0 m defaults', () => {
    const registry = createDefaultToolRegistry();

    it('the 3D Tiles tools no longer show a place name mixed with coordinates as a query example', () => {
        // The strict parser looks such text up as a name, so the stated coordinates would be replaced by Places' match.
        for (const tool of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay', 'google_3d_tiles_clay_blockout_runner']) {
            const query = String((registry.get(tool)!.declaration.parameters!.properties as any).query.description);
            expect(query, tool).not.toMatch(/Midtown Manhattan, coordinates/);
            expect(query, tool).toMatch(/When the user gave coordinates, pass just the coordinates/);
        }
    });

    it('stage_3d_vector_world and query_spatial_vector_data fail without coordinates', async () => {
        for (const tool of ['stage_3d_vector_world', 'query_spatial_vector_data']) {
            const missing = await registry.dispatch(tool, {}, {} as any);
            expect(missing.exec.status, tool).toBe('failed');
            expect(String((missing.resultPayload as any).error), tool).toMatch(/needs latitude and longitude/);
            const garbage = await registry.dispatch(tool, { latitude: 'north', longitude: -73.9 }, {} as any);
            expect(garbage.exec.status, tool).toBe('failed');
        }
    });

    it('survey_synthesize_stations without a ground elevation fails instead of using 0 m', async () => {
        const outcome = await registry.dispatch('survey_synthesize_stations', { latitude: 39.7392, longitude: -104.9903, pattern: 'orbital-multi-tier', radiusMeters: 40, cameraCount: 4 }, {} as any);
        expect(outcome.exec.status).toBe('failed');
        expect(String((outcome.resultPayload as any).error)).toMatch(/elevationMeters/);
    });

    it('the adaptive rig needs the model\'s location: its stations are not put at the Colosseum', async () => {
        const verts: number[] = [];
        for (let i = 0; i < 40; i++) verts.push(Math.cos(i) * 10, (i % 5) * 4, Math.sin(i) * 10);
        const mesh = { vertices: new Float32Array(verts), indices: new Uint32Array([0, 1, 2]) };
        expect(() => AdaptiveSurveyRigService.planRig(mesh as any, { cameraBudget: 4 })).toThrow(MissingInputError);

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-plan-adaptive-'));
        try {
            fs.writeFileSync(path.join(root, 'model.glb'), Buffer.from('glTF'));
            await expect(new SurveyApi({ workspaceRoot: root }).planAdaptive({ glbPath: 'model.glb', cameraBudget: 8 })).rejects.toThrow(/anchor/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('POST /clay never reports placeholder (mock) tiles as a success', async () => {
        const fetchClayGlb = vi.fn(async () => ({ glbPath: '/tmp/placeholder.glb', mock: true }));
        const api = new SurveyApi({ workspaceRoot: os.tmpdir(), fetchClayGlb });
        // A client cannot switch the extraction into its offline test mode...
        await expect(api.clay({ query: 'x', options: { offlineMock: true } })).rejects.toThrow(/offlineMock is a test-only extraction mode/);
        expect(fetchClayGlb).not.toHaveBeenCalled();
        // ...and a mock result from the extraction fails instead of returning success with its path.
        await expect(api.clay({ query: 'Flatiron Building, New York' })).rejects.toThrow(/placeholder \(mock\) tiles/);
        const real = new SurveyApi({ workspaceRoot: os.tmpdir(), fetchClayGlb: async () => ({ glbPath: '/tmp/real.glb', mock: false }) });
        await expect(real.clay({ query: 'Flatiron Building, New York' })).resolves.toMatchObject({ success: true, glbPath: '/tmp/real.glb' });
    });

    it('POST /clay passes only extraction options: a client cannot choose where the GLB is written', async () => {
        const fetchClayGlb = vi.fn(async (_q: any, _o?: Record<string, any>) => ({ glbPath: '/tmp/real.glb', mock: false }));
        const api = new SurveyApi({ workspaceRoot: os.tmpdir(), fetchClayGlb });
        await api.clay({
            query: '40.7411, -73.9897',
            options: { radiusMeters: 150, outputGlbPath: '/Users/someone/.zshrc', outputDir: '/etc', apiKey: 'client-key', fetchImpl: 'x' }
        });
        expect(fetchClayGlb).toHaveBeenCalledTimes(1);
        expect(fetchClayGlb.mock.calls[0][1]).toEqual({ radiusMeters: 150 });
    });

    it('the survey plan takes no style or era from words in the place name', async () => {
        const preset = await resolveSurveyPreset({ location: 'Waste Transfer Station, Hartford' }, os.tmpdir(), {
            geocode: async () => ({ lat: 41.7637, lng: -72.6851, elevation: 18, formattedAddress: 'Waste Transfer Station, Hartford, CT, USA' })
        });
        // "sf" inside "Transfer" used to style it as San Francisco; "Philadelphia" became July 1776 as an oil painting.
        expect(preset.beautify.locationName).toBe('Waste Transfer Station, Hartford');
        expect(preset.beautify.architecturalStyle).toBeUndefined();
        expect(preset.beautify.stylePreset).toBeUndefined();
        const styled = await resolveSurveyPreset({ location: 'Philadelphia City Hall', beautify: { stylePreset: 'watercolor' } }, os.tmpdir(), {
            geocode: async () => ({ lat: 39.9526, lng: -75.1635, elevation: 12, formattedAddress: 'Philadelphia City Hall' })
        });
        expect(styled.beautify.stylePreset).toBe('watercolor');
        expect(styled.beautify.architecturalStyle).toBeUndefined();
    });
});

describe('geodata services answer for the place they were given or fail', () => {
    it('structure GeoJSON needs the structure\'s own anchor (no Colosseum default)', () => {
        const struct = Universal3DStructureFoundation.createFromProcedural('box', { scale: 1.0, numViews: 4 });
        expect(struct.toGeoJson()).toBeUndefined();
        const all = struct.exportAll();
        expect(all.geoJson).toBeUndefined();
        expect(all.formatsExported).not.toContain('geojson');
    });

    it('elevation comes from the Elevation API or the call fails (no Midtown Manhattan interpolation)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const service = new GoogleElevationService({ proxyBaseUrl: 'http://127.0.0.1:9/api/elevation', enableCaching: false });
        // Denver: the benchmark table used to answer ~15-25 m for any coordinate on Earth.
        await expect(service.getElevation(39.7392, -104.9903)).rejects.toThrow();
        await expect(service.getElevationProfileAlongPath([{ lat: 39.73, lng: -104.99 }, { lat: 39.74, lng: -104.98 }], 4)).rejects.toThrow();
    });

    it('the COLMAP pipeline does not build on an invented 0 m ground', async () => {
        const pipeline = new ColmapVectorPipeline();
        await expect(pipeline.resolveAnchor({ anchor: { lat: 39.7392, lng: -104.9903 } } as any)).rejects.toThrow(MissingInputError);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
        await expect(pipeline.resolveAnchor({ anchor: { lat: 39.7392, lng: -104.9903 } } as any, { fetchElevation: true })).rejects.toThrow(/ground elevation at 39\.739200, -104\.990300 is unknown/);
    });

    it('a restyle prompt without coordinates says nothing about a location (it used to say the Empire State Building)', () => {
        const prompt = buildBlockoutNanoBananaPrompt({ locationName: 'a clay teapot', aspectRatio: '1:1' });
        expect(prompt).not.toMatch(/40\.7484|-73\.985|earth\.google\.com|real location/);
        expect(prompt).toContain('Transform this 3D clay rendering of a clay teapot into a photorealistic photograph.');
        expect(prompt.endsWith('taken from this exact vantage point.')).toBe(true);
    });

    it('the XR bridge, the 4D prompt bridge and the shadow deduction need a real anchor', () => {
        expect(() => new WebXRGeospatialAnchorBridge({} as any)).toThrow(MissingInputError);
        const doc: any = { schemaVersion: '0.3.0', metadata: { id: 'd', title: 't', totalDurationMs: 0, generator: 'test' }, environment: {}, entities: [{ id: 'e1', space: {}, content: {} }] };
        expect(() => HeadlessSpatialAiBridge.synthesizeGroundedMultimodalPrompt(doc, 'e1', 'a kiosk')).toThrow(MissingInputError);
        expect(() => ChronoSpatialDeductionEngine.generateDeductionReport({ buildingLandmarks: ['Ferry Building'] })).toThrow(MissingInputError);
    });

    it('the 4D prompt bridge states no altitude, sun or weather the scene document does not give', () => {
        const doc: any = {
            schemaVersion: '0.3.0', metadata: { id: 'd', title: 't', totalDurationMs: 0, generator: 'test' }, environment: {},
            entities: [{ id: 'e1', space: { geoAnchor: { lat: 39.7392, lng: -104.9903 } }, content: {}, lineage: { worldBranchId: 'main', version: 1 } }]
        };
        const { structuredPrompt } = HeadlessSpatialAiBridge.synthesizeGroundedMultimodalPrompt(doc, 'e1', 'a kiosk');
        // Denver: an origin with no altitude used to be described as "Alt: 0.0m", and a missing sun as a fixed one.
        expect(structuredPrompt).not.toMatch(/Alt: 0\.0m|Azimuth 183|sunny/);
        expect(structuredPrompt).toContain('altitude not given');
        expect(structuredPrompt).toContain('Astronomical Sun : not given in the scene document');
        expect(structuredPrompt).not.toContain('LIGHTING DIRECTION');
        const withSun = HeadlessSpatialAiBridge.synthesizeGroundedMultimodalPrompt({
            ...doc,
            environment: { solar: { altitude: Math.PI / 6, azimuth: Math.PI }, weather: { conditions: 'overcast', fogDensity: 0.2 } },
            entities: [{ ...doc.entities[0], space: { geoAnchor: { lat: 39.7392, lng: -104.9903, alt: 1609 } } }]
        }, 'e1', 'a kiosk').structuredPrompt;
        expect(withSun).toContain('Alt: 1609.0m');
        expect(withSun).toContain('Altitude 30.0° above horizon, Azimuth 180.0°');
        expect(withSun).toContain('Weather: overcast (Fog Density: 20%)');
        expect(withSun).toContain('1. LIGHTING DIRECTION');
    });

    it('the XR bridge never takes an origin with no altitude to be at 0 m above sea level', () => {
        // Denver: the ground is about 1,609 m above sea level. With no origin altitude a target's sea-level altitude
        // cannot be placed relative to the origin; it used to land about 1.6 km above it.
        const relative = new WebXRGeospatialAnchorBridge({ origin: { lat: 39.7392, lng: -104.9903 } });
        expect(relative.getAlignmentState().originGeoAnchor.alt).toBeUndefined();
        expect(relative.getOriginAnchor().alt).toBeUndefined();
        expect(() => relative.geodeticToWebXR({ lat: 39.7393, lng: -104.9903, alt: 1619 })).toThrow(MissingInputError);
        expect(() => relative.calibrateSensors({ lat: 39.7392, lng: -104.9903, alt: 1611 }, { position: [0, 1.6, 0] })).toThrow(MissingInputError);
        // A target with no altitude is level with the origin, and a WebXR point reports its height above the origin only.
        expect(relative.geodeticToWebXR({ lat: 39.7392, lng: -104.9903 }).y).toBeCloseTo(0, 6);
        const back = relative.webXRToGeodetic(relative.geodeticToWebXR({ lat: 39.7393, lng: -104.9903 }).add({ x: 0, y: 12, z: 0 } as any));
        expect(back.alt).toBeUndefined();
        expect(back.heightAboveOriginMeters).toBeCloseTo(12, 2);

        // With the origin's altitude, sea-level altitudes place as given.
        const absolute = new WebXRGeospatialAnchorBridge({ origin: { lat: 39.7392, lng: -104.9903, alt: 1609 } });
        expect(absolute.geodeticToWebXR({ lat: 39.7392, lng: -104.9903, alt: 1619 }).y).toBeCloseTo(10, 3);
        expect(absolute.webXRToGeodetic(absolute.geodeticToWebXR({ lat: 39.7392, lng: -104.9903, alt: 1619 })).alt).toBeCloseTo(1619, 3);
    });

    it('webxr_geospatial_align_coordinates fails on a target altitude without an origin altitude, and says heights are relative', async () => {
        const registry = createDefaultToolRegistry();
        const mixed = await registry.dispatch('webxr_geospatial_align_coordinates', {
            originAnchor: { latitude: 39.7392, longitude: -104.9903 },
            targetGeodetic: { latitude: 39.7393, longitude: -104.9903, altitudeMsl: 1619 }
        }, {} as any);
        expect(mixed.exec.status).toBe('failed');
        expect(String((mixed.resultPayload as any).error)).toMatch(/origin was given without an altitude/);

        const relative = await registry.dispatch('webxr_geospatial_align_coordinates', {
            originAnchor: { latitude: 39.7392, longitude: -104.9903 },
            webXRPosition: [0, 5, -10]
        }, {} as any);
        expect(relative.exec.status).toBe('completed');
        const converted = (relative.resultPayload as any).convertedGeodetic;
        expect(converted.altitudeMsl).toBeUndefined();
        expect(converted.heightAboveOriginMeters).toBeCloseTo(5, 2);
        expect(relative.exec.summaryResult).toMatch(/no origin altitude was given/);
    });

    it('the asset vault has no seeded San Francisco tile or splat records', () => {
        const vault = new SpatialAssetVaultService();
        expect(vault.queryCachedAsset('earth/main', { lat: 37.7940, lng: -122.4010 })).toBeNull();
        expect(vault.getAllAssets().some(a => /Photorealistic 3D Tiles SF|cyberpunk/i.test(JSON.stringify(a.representation)))).toBe(false);
    });

    it('the solar service no longer makes up building insights for any coordinate', () => {
        const solar = new GoogleSolarService();
        expect((solar as any).getBuildingInsights).toBeUndefined();
        expect((solar as any).getDataLayers).toBeUndefined();
    });

    it('a .scene.json without an anchor is not placed in San Francisco', () => {
        const lens = new Scene3DWorldLens();
        const projected = lens.project({ 'world.scene.json': JSON.stringify({ title: 'Garden', objects: [] }) });
        expect(projected.data.geoAnchor).toBeUndefined();
    });

    it('a matchmove anchor keeps only what was given (no 0 m ground, no "typical" roofline)', () => {
        const anchor = new GeoCameraMatchmovePipelineService().resolveLandmarkAnchor({ lat: 45.4345, lng: 12.3371 } as any);
        expect(anchor.elevation).toBeUndefined();
        expect(anchor.typicalRooflineAltM).toBeUndefined();
        expect(anchor.typicalStreetAltM).toBeUndefined();
    });
});

describe('image lighting reads the photograph and invents no place or pose', () => {
    it('decodes real pixels: a file that is not an image is an error (its bytes used to be read as pixels)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-lighting-'));
        try {
            const notImage = path.join(dir, 'notes.jpg');
            fs.writeFileSync(notImage, 'these are not pixels');
            await expect(InverseLightingEstimatorService.estimateFromImage({ imagePath: notImage })).rejects.toThrow(/unrecognised image format/);
            const photo = writePng(dir, 'plaza.png');
            const est = await InverseLightingEstimatorService.estimateFromImage({ imagePath: photo, knownCoords: { lat: 45.4345, lng: 12.3371 }, timestampIso: '2026-06-21T10:00:00Z' });
            // The sky fraction is measured from the decoded pixels: 13 of 32 rows, less the skyline band.
            expect(est.skyPixelFraction).toBeGreaterThan(0.3);
            expect(est.skyPixelFraction).toBeLessThan(13 / 32 + 1e-9);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('needs a location (no Central Park South default) and reports that the camera was not estimated', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-lighting-'));
        try {
            const photo = writePng(dir, 'plaza.png');
            await expect(matchImageAndLightingToLocation({ imagePath: photo, autoExportUsd: false })).rejects.toThrow(MissingInputError);
            // The photo shows neither the sun nor a sky gradient, so the capture time is required (no default date).
            await expect(matchImageAndLightingToLocation({ imagePath: photo, geodeticCoords: { lat: 45.4345, lng: 12.3371 }, autoExportUsd: false }))
                .rejects.toThrow(/needs timestampIso/);
            const result = await matchImageAndLightingToLocation({ imagePath: photo, geodeticCoords: { lat: 45.4345, lng: 12.3371 }, timestampIso: '2026-06-21T10:00:00Z', autoExportUsd: false });
            expect(result.location.coords.lat).toBe(45.4345);
            expect(result.cameraPose).toBeUndefined();
            expect(result.summary).toMatch(/Camera pose: not estimated/);
            const posed = await matchImageAndLightingToLocation({ imagePath: photo, geodeticCoords: { lat: 45.4345, lng: 12.3371 }, timestampIso: '2026-06-21T10:00:00Z', cameraPosition: [0, 2, 10], cameraTarget: [0, 2, 0], autoExportUsd: false });
            expect(posed.cameraPose!.headingDeg).toBeCloseTo(0, 6); // looking toward -Z (north)
            expect(posed.cameraPose!.standoffMeters).toBeCloseTo(10, 6);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the Maps key saved in Settings reaches the server', () => {
    /** An in-memory key store with the FileKeyStore surface the setting uses. */
    function memoryStore() {
        const data = new Map<string, string>();
        const slot = (s: string, a: string) => `${s}/${a}`;
        return {
            data,
            getPasswordSync: (s: string, a: string) => data.get(slot(s, a)),
            setPassword: async (s: string, a: string, p: string) => { data.set(slot(s, a), p); },
            deletePassword: async (s: string, a: string) => data.delete(slot(s, a))
        };
    }

    it('saving applies the key to this process at once; clearing removes it', async () => {
        const store = memoryStore();
        expect(await saveMapsKeySetting('  settings-maps-key  ', store as any)).toEqual({ configured: true });
        expect(store.data.get(`${MAPS_KEY_STORE_SERVICE}/${MAPS_KEY_STORE_ACCOUNT}`)).toBe('settings-maps-key');
        expect(process.env.GOOGLE_MAPS_API_KEY).toBe('settings-maps-key');
        expect(GoogleMapsService.getInstance().getApiKey()).toBe('settings-maps-key');

        // A server-side place lookup now sends the Settings key.
        const sent: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: any) => {
            sent.push(init.headers['X-Goog-Api-Key']);
            return new Response(JSON.stringify({ places: [{ displayName: { text: 'Flatiron Building' }, formattedAddress: '175 5th Ave, New York, NY 10010, USA', location: { latitude: 40.7411, longitude: -73.9897 } }] }), { status: 200 });
        }));
        await GoogleMapsService.getInstance().geocode('Flatiron Building, 175 Fifth Avenue (settings key test)');
        expect(sent).toEqual(['settings-maps-key']);

        expect(await saveMapsKeySetting('', store as any)).toEqual({ configured: false });
        expect(store.data.size).toBe(0);
        expect(process.env.GOOGLE_MAPS_API_KEY).toBeUndefined();
        expect(GoogleMapsService.getInstance().getApiKey()).toBe('');
    });

    it('at startup a saved key outranks one copied in from a secrets file', () => {
        const store = memoryStore();
        expect(preferSavedMapsKey(store as any)).toBe(false);
        store.data.set(`${MAPS_KEY_STORE_SERVICE}/${MAPS_KEY_STORE_ACCOUNT}`, 'saved-key');
        process.env.GOOGLE_MAPS_API_KEY = 'secrets-file-key';
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(preferSavedMapsKey(store as any)).toBe(true);
        expect(process.env.GOOGLE_MAPS_API_KEY).toBe('saved-key');
        return saveMapsKeySetting('', store as any); // leave no Settings key applied for the next test
    });

    it('clearing the Settings key puts back the key it replaced from the environment or a secrets file', async () => {
        const store = memoryStore();
        process.env.GOOGLE_MAPS_API_KEY = 'secrets-file-key';
        GoogleMapsService.getInstance().setApiKey('secrets-file-key');
        expect(await saveMapsKeySetting('settings-key', store as any)).toEqual({ configured: true });
        expect(process.env.GOOGLE_MAPS_API_KEY).toBe('settings-key');
        expect(await saveMapsKeySetting('another-settings-key', store as any)).toEqual({ configured: true });

        expect(await saveMapsKeySetting('', store as any)).toEqual({ configured: true });
        expect(process.env.GOOGLE_MAPS_API_KEY).toBe('secrets-file-key');
        expect(GoogleMapsService.getInstance().getApiKey()).toBe('secrets-file-key');
        expect(store.data.size).toBe(0);
    });

    it('reports whether a key is saved in Settings, never the key', async () => {
        const store = memoryStore();
        expect(mapsKeyStatus(store as any)).toEqual({ configured: false, savedInSettings: false });
        await saveMapsKeySetting('settings-key', store as any);
        const status = mapsKeyStatus(store as any);
        expect(status).toEqual({ configured: true, savedInSettings: true });
        expect(JSON.stringify(status)).not.toContain('settings-key');
        await saveMapsKeySetting('', store as any);
    });
});

describe('a Maps key Settings kept only in the window reaches the server', () => {
    /** A fake /api/geo/maps-key: GET answers `status`, POST answers `post` (default success); every request is recorded. */
    function server(status: Record<string, unknown> | number, post: number = 200) {
        const calls: Array<{ method: string; body?: any }> = [];
        const impl = (async (url: any, init?: any) => {
            expect(String(url)).toBe('/api/geo/maps-key');
            const method = init?.method || 'GET';
            calls.push({ method, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
            if (method === 'GET') {
                return typeof status === 'number'
                    ? new Response('{}', { status })
                    : new Response(JSON.stringify(status), { status: 200 });
            }
            return new Response(JSON.stringify(post === 200 ? { success: true, configured: true } : { success: false, error: 'key store is read-only' }), { status: post });
        }) as typeof fetch;
        return { impl, calls };
    }

    it('sends the window\'s key when the server has no Settings key (even with a secrets-file key)', async () => {
        const fake = server({ configured: true, savedInSettings: false });
        expect(await syncSavedMapsKeyToServer('  window-key  ', fake.impl)).toBeUndefined();
        expect(fake.calls).toEqual([{ method: 'GET' }, { method: 'POST', body: { apiKey: 'window-key' } }]);
    });

    it('sends nothing when the server already has a Settings key, or the window has none', async () => {
        const saved = server({ configured: true, savedInSettings: true });
        expect(await syncSavedMapsKeyToServer('window-key', saved.impl)).toBeUndefined();
        expect(saved.calls).toEqual([{ method: 'GET' }]);
        const none = server({ configured: false, savedInSettings: false });
        expect(await syncSavedMapsKeyToServer('', none.impl)).toBeUndefined();
        expect(none.calls).toEqual([]);
    });

    it('clearing the Settings key also clears the names older builds saved it under', () => {
        const store = new Map<string, string>([['GOOGLE_MAPS_API_KEY', 'legacy-window-key'], ['sb_google_maps_key', 'older-key']]);
        const localStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => { store.set(k, String(v)); },
            removeItem: (k: string) => { store.delete(k); }
        };
        vi.stubGlobal('window', { localStorage });
        try {
            const maps = GoogleMapsService.getInstance();
            maps.setApiKey('settings-key');
            expect(maps.getStoredSettingsKey()).toBe('settings-key');
            maps.setApiKey('');
            // Nothing is left for the startup sync to send back to the server.
            expect(maps.getStoredSettingsKey()).toBe('');
            expect([...store.keys()]).toEqual([]);
        } finally {
            vi.unstubAllGlobals();
            GoogleMapsService.getInstance().setApiKey('');
        }
    });

    it('says why the key did not reach the server', async () => {
        expect(await syncSavedMapsKeyToServer('window-key', server(503).impl)).toMatch(/could not be sent to the server \(checking the server's key returned HTTP 503\).*Save the key again/);
        expect(await syncSavedMapsKeyToServer('window-key', server({ savedInSettings: false }, 500).impl)).toMatch(/could not be sent to the server \(key store is read-only\)/);
    });
});
