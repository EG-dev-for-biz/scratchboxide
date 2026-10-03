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
    CreativeLocationCastingService,
    castCreativeLocation,
    castCreativeLocationAsync
} from '../src/browser/generative-canvas/services/CreativeLocationCastingService';
import {
    applyCreativeLocationCasting,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { syncVectorRoadmapBlueprint } from '../src/browser/generative-canvas/primitives/scene3d/syncVectorRoadmapBlueprint';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import type { Scene3DData, VectorRoadmapConfig } from '../src/browser/generative-canvas/canvas-types';

describe('Google Elevation Data as Source of Truth for 3D Scenes', () => {
    const mapsService = GoogleMapsService.getInstance();
    const castingService = CreativeLocationCastingService.getInstance();

    describe('1. Google Maps Service & Verified Landmark/Archetype Registry', () => {
        it('provides exact authoritative Google elevations for all proving grounds', () => {
            // Angeles Shooting Ranges (Proving ground for outdoor range)
            const angelesElev = mapsService.getElevationSync(34.3315, -118.3970);
            expect(angelesElev).toBeCloseTo(489.86, 1);

            // Nürburgring Nordschleife (Proving ground for race track / stadium)
            const nurburgElev = mapsService.getElevationSync(50.3356, 6.9475);
            expect(nurburgElev).toBeCloseTo(620.76, 1);

            // Bonneville Salt Flats (Proving ground for dry lakebed / flats)
            const bonnevilleElev = mapsService.getElevationSync(40.7997, -113.8000);
            expect(bonnevilleElev).toBeCloseTo(1284.72, 1);

            // Death Valley Badwater Basin (Below sea level archetype)
            const badwaterElev = mapsService.getElevationSync(36.2503, -116.8258);
            expect(badwaterElev).toBeCloseTo(-84.69, 1);

            // Mount Rainier (Alpine volcanic peak archetype)
            const rainierElev = mapsService.getElevationSync(46.8523, -121.7603);
            expect(rainierElev).toBeCloseTo(3818.67, 1);

            // Fallingwater (Architectural cantilever over waterfall archetype)
            const fallingwaterElev = mapsService.getElevationSync(39.9063, -79.4681);
            expect(fallingwaterElev).toBeCloseTo(394.03, 1);

            // Times Square (Urban canyon archetype)
            const timesSquareElev = mapsService.getElevationSync(40.7580, -73.9855);
            expect(timesSquareElev).toBeCloseTo(16.90, 1);
        });

        it('memoizes lookups into elevationCache', async () => {
            const lat = 34.3315;
            const lng = -118.3970;
            const elev = await mapsService.getElevation(lat, lng);
            expect(elev).toBeCloseTo(489.86, 1);

            // Cache check
            const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
            expect(mapsService.elevationCache.has(cacheKey)).toBe(true);
            expect(mapsService.elevationCache.get(cacheKey)).toBeCloseTo(489.86, 1);
        });
    });

    describe('2. Creative Location Casting with Real-World Google Ground Truth', () => {
        it('casts outdoor firing range to Angeles Shooting Ranges with 489.86m MSL elevation', () => {
            const casted = castCreativeLocation('tactical target practice outdoor shooting range with steel targets');
            expect(casted.archetype).toBe('ballistics_proving_ground');
            expect(casted.landmarkName).toBe('Angeles Shooting Ranges & Proving Ground, CA');
            expect(casted.elevation).toBeCloseTo(489.86, 1);
            expect(casted.elevationSource).toBe('google_elevation');
            expect(casted.datum).toBe('MSL_EGM96');
        });

        it('casts arid badlands to Badwater Basin with below-sea-level elevation (-84.69m MSL)', () => {
            const casted = castCreativeLocation('vast arid badlands depression salt pan basin');
            expect(casted.archetype).toBe('arid_desert_wasteland');
            expect(casted.elevation).toBeCloseTo(-84.69, 1);
            expect(casted.elevationSource).toBe('google_elevation');
            expect(casted.datum).toBe('MSL_EGM96');
        });

        it('casts alpine peak to The Matterhorn with 4440.29m MSL elevation', () => {
            const casted = castCreativeLocation('alpine mountain summit ridge');
            expect(casted.archetype).toBe('geological_alpine');
            expect(casted.elevation).toBeCloseTo(4440.29, 1);
            expect(casted.elevationSource).toBe('google_elevation');
        });

        it('supports castLocationAsync with Google elevation resolution', async () => {
            const casted = await castCreativeLocationAsync('topgolf driving range sports complex');
            expect(casted.archetype).toBe('ballistics_proving_ground');
            expect(casted.elevation).toBeCloseTo(634.65, 1);
            expect(casted.elevationSource).toBe('google_elevation');
        });
    });

    describe('3. Procedural 3D Synthesizer Geospatial Anchor & Elevation Propagation', () => {
        it('populates scene geoAnchor with elevationSource, datum, and real-world elevation', () => {
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

            expect(synthesized.geoAnchor).toBeDefined();
            expect(synthesized.geoAnchor?.elevation).toBeCloseTo(489.86, 1);
            expect(synthesized.geoAnchor?.elevationSource).toBe('google_elevation');
            expect(synthesized.geoAnchor?.datum).toBe('MSL_EGM96');
            expect(synthesized.geoAnchor?.landmarkName).toContain('Angeles Shooting Ranges');

            // Verify procedural C++ code generator metadata header includes ground elevation
            expect(synthesized.cppGenerator?.sourceCode).toContain('Ground Elevation: 489.86m MSL [Google Elevation Ground Truth, Datum: EGM96]');
        });

        it('full contextual scene synthesis attaches verified elevation metadata', () => {
            const scene = synthesizeContextual3DScene('architectural glass pavilion cantilever over waterfall');
            expect(scene.geoAnchor).toBeDefined();
            expect(scene.geoAnchor?.elevationSource).toBe('google_elevation');
            expect(scene.geoAnchor?.elevation).toBeCloseTo(394.03, 1); // Fallingwater
            expect(scene.geoAnchor?.datum).toBe('MSL_EGM96');
        });
    });

    describe('4. Three.js Viewport & Blueprint Local Ground Datum Invariant', () => {
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
