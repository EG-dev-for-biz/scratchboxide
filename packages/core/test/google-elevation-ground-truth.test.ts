/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GoogleMapsService } from '../src/browser/generative-canvas/services/google-maps-service';
import {
    applyCreativeLocationCasting,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { syncVectorRoadmapBlueprint } from '../src/browser/generative-canvas/primitives/scene3d/syncVectorRoadmapBlueprint';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import type { Scene3DData, VectorRoadmapConfig } from '../src/browser/generative-canvas/canvas-types';
import { NoSceneBuiltError } from '../src/browser/generative-canvas/services/adaptive-domain-engine';

/** The scene the template synthesizer builds, or undefined when it builds none (NoSceneBuiltError). */
function sceneUnlessNoneBuilt(prompt: string): Scene3DData | undefined {
    try {
        return synthesizeContextual3DScene(prompt);
    } catch (e) {
        if (e instanceof NoSceneBuiltError) return undefined;
        throw e;
    }
}

describe('Google Elevation Data as Source of Truth for 3D Scenes', () => {
    const mapsService = GoogleMapsService.getInstance();

    describe('1. Google Maps Service elevation comes from the Elevation API only', () => {
        const elevationFetch = (value: number | undefined, status = 200) => {
            const urls: string[] = [];
            const impl = (async (url: any) => {
                urls.push(String(url));
                const body = value === undefined ? { status: 'INVALID_REQUEST', results: [] } : { status: 'OK', results: [{ elevation: value }] };
                return new Response(JSON.stringify(body), { status });
            }) as typeof fetch;
            return { impl, urls };
        };

        it('returns the Elevation API value and memoizes it', async () => {
            const lat = 34.3315;
            const lng = -118.3970;
            const api = elevationFetch(489.861);
            const elev = await mapsService.getElevation(lat, lng, { apiKey: 'test-key', fetchImpl: api.impl });
            expect(elev).toBeCloseTo(489.86, 2);
            expect(api.urls[0]).toContain('maps.googleapis.com/maps/api/elevation/json?locations=34.3315,-118.397');

            const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
            expect((mapsService as any).elevationCache.get(cacheKey)).toBeCloseTo(489.86, 2);
            const again = elevationFetch(1);
            expect(await mapsService.getElevation(lat, lng, { apiKey: 'test-key', fetchImpl: again.impl })).toBeCloseTo(489.86, 2);
            expect(again.urls.length).toBe(0);
        });

        it('throws instead of estimating when the API has no answer or there is no key', async () => {
            await expect(mapsService.getElevation(50.3356, 6.9475, { apiKey: 'test-key', fetchImpl: elevationFetch(undefined).impl }))
                .rejects.toThrow(/Elevation API gave no elevation/);
            const saved = { state: mapsService.getApiKey(), g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
            mapsService.setApiKey('');
            delete process.env.GOOGLE_MAPS_API_KEY;
            delete process.env.MAP_TILES_API_KEY;
            try {
                await expect(mapsService.getElevation(40.7997, -113.8)).rejects.toThrow(/No Google Maps API key/);
            } finally {
                mapsService.setApiKey(saved.state);
                if (saved.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.g;
                if (saved.m !== undefined) process.env.MAP_TILES_API_KEY = saved.m;
            }
            // There is no synchronous "nearest landmark" estimate any more.
            expect((mapsService as any).getElevationSync).toBeUndefined();
        });
    });

    describe('2. Procedural 3D Synthesizer never invents a geospatial anchor', () => {
        it('leaves a scene that names no location unanchored (clay void)', () => {
            const initialScene: Scene3DData = {
                title: 'Shooting Range Proving Ground',
                sceneType: 'environment',
                camera: { position: [0, 5, 10], target: [0, 0, 0] },
                objects: []
            };

            const synthesized = applyCreativeLocationCasting(
                initialScene,
                'tactical target practice shooting range with steel poppers'
            );

            expect(synthesized.geoAnchor).toBeUndefined();
            // No keyword-picked hero script with invented vertex counts is attached.
            expect(synthesized.pythonGenerator?.sourceCode ?? '').not.toContain('AdaptiveHeroObjectSynthesizer');
        });

        it('does not anchor a scene to a place named in the prompt (places come from the location tools)', () => {
            const scene = synthesizeContextual3DScene('architectural glass pavilion cantilever over Fallingwater, Mill Run, Pennsylvania');
            expect(scene.geoAnchor).toBeUndefined();
        });

        it('does not cast a scene onto an archetype location (no place table, no default city)', () => {
            for (const prompt of ['tactical target practice outdoor shooting range with steel targets', 'vast arid badlands depression salt pan basin', 'downtown city skyline waterfront plaza']) {
                // A prompt no template fits builds no scene at all (NoSceneBuiltError); one that does gets no place.
                expect(sceneUnlessNoneBuilt(prompt)?.geoAnchor).toBeUndefined();
            }
        });
    });

    describe('3. Three.js Viewport & Blueprint Local Ground Datum Invariant', () => {
        it('LocalTangentPlane sets Ground Surface strictly at Y = 0.0m', () => {
            expect(LocalTangentPlane.GROUND_SURFACE_LOCAL_Y).toBe(0.0);
            expect(LocalTangentPlane.groundLevel()).toBe(0.0);
        });

        it('syncVectorRoadmapBlueprint grounds mesh at LocalTangentPlane Y=0 and does NOT float at MSL elevation', () => {
            const scene = new THREE.Scene();
            const config: VectorRoadmapConfig = {
                enabled: true,
                groundBlueprint: true,
                groundBlueprintOpacity: 0.8,
                groundBlueprintSize: 500,
                groundElevationOffset: -0.05
            };
            const geoAnchor = {
                lat: 34.3315,
                lng: -118.3970,
                elevation: 489.86, // Angeles Shooting Ranges MSL
                elevationSource: 'google_elevation',
                datum: 'MSL_EGM96',
                landmarkName: 'Angeles Shooting Ranges'
            };

            const handle = syncVectorRoadmapBlueprint(scene, null, { config, geoAnchor });
            expect(handle.blueprintMesh).toBeDefined();

            // The local Y position must be ground level (-0.05m offset), NOT 489.86m up in the air!
            expect(handle.blueprintMesh?.position.y).toBeCloseTo(-0.05, 3);
            expect(handle.blueprintMesh?.position.y).not.toBeGreaterThan(1.0);

            // Real-world MSL elevation is preserved in userData for HUD telemetry
            expect(handle.blueprintMesh?.userData.elevation).toBeCloseTo(489.86, 1);
            expect(handle.blueprintMesh?.userData.elevationSource).toBe('google_elevation');
            expect(handle.blueprintMesh?.userData.datum).toBe('MSL_EGM96');

            handle.dispose();
        });
    });
});
