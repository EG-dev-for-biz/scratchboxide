import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import {
    GoogleMapsService,
    StaticMapOptions,
    GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE,
    STATIC_MAPS_NO_LABELS_STYLES
} from '../src/browser/generative-canvas/services/google-maps-service';

async function runGoogleMapsServiceTests() {
    console.log('🧪 Running Google Maps Client & Geospatial Intelligence Test Suite...\n');

    const service = GoogleMapsService.getInstance();

    // -------------------------------------------------------------
    // Test 1: API Key Configuration & Resolution
    // -------------------------------------------------------------
    console.log('  Testing API Key Configuration & Resolution...');
    const originalKey = service.getApiKey();
    
    // Test setting and retrieving custom key
    const testKey = 'AIzaSyTestMockKeyForScratchboxMaps2026';
    service.setApiKey(testKey);
    assert.strictEqual(service.getApiKey(), testKey, 'API Key must match set key');
    assert.strictEqual(service.hasApiKey(), true, 'hasApiKey must return true when valid key is set');
    assert.strictEqual(service.getState().status, 'ready', 'State status must be ready when key is set');

    // Test clearing key
    service.setApiKey('');
    assert.strictEqual(service.hasApiKey(), false, 'hasApiKey must return false when cleared');
    assert.strictEqual(service.getState().status, 'missing_key', 'State status must be missing_key when cleared');

    // Restore test key for subsequent test cases
    service.setApiKey(testKey);
    console.log('  ✓ Test 1 Passed: Google Maps API key resolution and reactive state updates work accurately.');

    // -------------------------------------------------------------
    // Test 2: Geocoding & Landmark Spatial Resolution
    // -------------------------------------------------------------
    console.log('  Testing Geocoding & Landmark Spatial Resolution...');
    
    // Landmark 1: San Francisco / Ferry Building
    const sfResult = await service.geocode('San Francisco Ferry Building');
    assert.ok(sfResult, 'Geocode result should not be null');
    assert.ok(typeof sfResult.lat === 'number' && typeof sfResult.lng === 'number', 'Coordinates must be valid numbers');
    assert.ok(sfResult.lat > 37.7 && sfResult.lat < 37.9, `SF latitude should be around 37.79, got ${sfResult.lat}`);
    assert.ok(sfResult.lng < -122.3 && sfResult.lng > -122.5, `SF longitude should be around -122.4, got ${sfResult.lng}`);
    assert.ok(sfResult.formattedAddress.length > 0, 'Formatted address must not be empty');

    // Landmark 2: Independence Hall Philadelphia (1776 theme)
    const phillyResult = await service.geocode('Independence Hall, Philadelphia');
    assert.ok(phillyResult.lat > 39.9 && phillyResult.lat < 40.0, `Philadelphia latitude should be ~39.94, got ${phillyResult.lat}`);
    assert.ok(phillyResult.lng < -75.1 && phillyResult.lng > -75.2, `Philadelphia longitude should be ~-75.15, got ${phillyResult.lng}`);

    // Direct Coordinate String parsing
    const coordStringResult = await service.geocode('37.7749, -122.4194');
    assert.strictEqual(Number(coordStringResult.lat.toFixed(4)), 37.7749, 'Direct lat coordinate string parsed correctly');
    assert.strictEqual(Number(coordStringResult.lng.toFixed(4)), -122.4194, 'Direct lng coordinate string parsed correctly');

    console.log('  ✓ Test 2 Passed: Geocoding accurately resolves landmarks, addresses, and raw coordinate strings.');

    // -------------------------------------------------------------
    // Test 3: Static Maps URL Generation (Pins, Styles, Spline Paths)
    // -------------------------------------------------------------
    console.log('  Testing Static Maps URL Builder...');
    
    const staticOptions: StaticMapOptions = {
        center: { lat: 37.7920, lng: -122.4050 },
        zoom: 16,
        size: { width: 640, height: 400 },
        scale: 2,
        maptype: 'satellite',
        markers: [
            { lat: 37.7920, lng: -122.4050, color: 'green', label: 'A' },
            { lat: 37.7980, lng: -122.3950, color: 'red', label: 'B' }
        ],
        paths: [
            {
                color: '0x00ff88ff',
                weight: 4,
                points: [
                    { lat: 37.7920, lng: -122.4050 },
                    { lat: 37.7950, lng: -122.4000 },
                    { lat: 37.7980, lng: -122.3950 }
                ]
            }
        ]
    };

    const staticUrl = service.getStaticMapUrl(staticOptions);
    assert.ok(staticUrl.startsWith('https://maps.googleapis.com/maps/api/staticmap?'), 'URL must target Google Static Maps API');
    assert.ok(staticUrl.includes('center=37.792'), 'URL must contain center coordinates');
    assert.ok(staticUrl.includes('zoom=16'), 'URL must contain zoom parameter');
    assert.ok(staticUrl.includes('size=640x400'), 'URL must contain size parameter');
    assert.ok(staticUrl.includes('scale=2'), 'URL must contain scale parameter');
    assert.ok(staticUrl.includes('maptype=satellite'), 'URL must specify satellite map type');
    assert.ok(staticUrl.includes('markers=color%3Agreen%7Clabel%3AA%7C37.792'), 'URL must contain Pin A marker');
    assert.ok(staticUrl.includes('markers=color%3Ared%7Clabel%3AB%7C37.798'), 'URL must contain Pin B marker');
    assert.ok(staticUrl.includes('path='), 'URL must contain flight path spline parameter');
    assert.ok(staticUrl.includes(`key=${testKey}`), 'URL must include API key');

    // Test fallback when no API key is provided
    service.setApiKey('');
    const fallbackStaticUrl = service.getStaticMapUrl({ center: { lat: 37.77, lng: -122.41 }, zoom: 14 });
    assert.ok(fallbackStaticUrl.startsWith('data:image/svg+xml') || fallbackStaticUrl.includes('staticmap'), 'Fallback static map returns valid SVG data URI or static map structure');
    service.setApiKey(testKey);

    console.log('  ✓ Test 3 Passed: Google Static Maps URL generator encodes pins, splines, zooms, and map types.');

    // -------------------------------------------------------------
    // Test 4: Interactive Embed Map URL Generation
    // -------------------------------------------------------------
    console.log('  Testing Interactive Embed Map URL Builder...');
    
    // Place Embed
    const placeEmbedUrl = service.getEmbedMapUrl({
        mode: 'place',
        q: 'Independence Hall, Philadelphia, PA',
        zoom: 17,
        maptype: 'satellite'
    });
    assert.ok(placeEmbedUrl.startsWith('https://www.google.com/maps/embed/v1/place?'), 'Embed URL should target place endpoint');
    assert.ok(placeEmbedUrl.includes('q=Independence'), 'Embed URL should contain encoded query');
    assert.ok(placeEmbedUrl.includes('maptype=satellite'), 'Embed URL should contain maptype');
    assert.ok(placeEmbedUrl.includes(`key=${testKey}`), 'Embed URL should include API key');

    // View Embed with coordinates
    const viewEmbedUrl = service.getEmbedMapUrl({
        mode: 'view',
        center: { lat: 37.7900, lng: -122.4000 },
        zoom: 15
    });
    assert.ok(viewEmbedUrl.includes('center=37.79'), 'View Embed should contain center coordinates');

    // Directions Embed (Drone or Ground Routing)
    const directionsEmbedUrl = service.getEmbedMapUrl({
        mode: 'directions',
        origin: { lat: 37.7920, lng: -122.4050 },
        destination: { lat: 37.7980, lng: -122.3950 }
    });
    assert.ok(directionsEmbedUrl.startsWith('https://www.google.com/maps/embed/v1/directions?'), 'Directions Embed must use directions endpoint');
    assert.ok(directionsEmbedUrl.includes('origin=37.792'), 'Directions Embed includes origin coords');
    assert.ok(directionsEmbedUrl.includes('destination=37.798'), 'Directions Embed includes destination coords');

    console.log('  ✓ Test 4 Passed: Google Maps Embed URL generator supports place, view, and directions modes.');

    // -------------------------------------------------------------
    // Test 5: Photorealistic 3D Tiles / 4D Spatial Datums
    // -------------------------------------------------------------
    console.log('  Testing Photorealistic 3D Tiles & 4D Spatial Datums...');
    
    const tilesConfig = service.getPhotorealistic3DTilesConfig({
        lat: 37.7900,
        lng: -122.4000,
        elevation: 15.2
    });
    assert.ok(tilesConfig.rootTilesetUrl.includes('tile.googleapis.com') || tilesConfig.rootTilesetUrl.includes('3dtiles'), '3D Tiles config must point to 3D tiles endpoint');
    assert.strictEqual(tilesConfig.center.lat, 37.7900, '3D Tiles center lat matches input');
    assert.strictEqual(tilesConfig.center.lng, -122.4000, '3D Tiles center lng matches input');
    assert.strictEqual(tilesConfig.center.elevation, 15.2, '3D Tiles center elevation matches input');
    assert.strictEqual(tilesConfig.apiKey, testKey, '3D Tiles apiKey matches configured key');
    assert.ok(tilesConfig.defaultCamera.range > 0, '3D Tiles default camera range is positive');

    console.log('  ✓ Test 5 Passed: Photorealistic 3D Tiles configuration and spatial datum bindings match protocol.');

    // -------------------------------------------------------------
    // Test 6: Observer Pattern & State Subscriptions
    // -------------------------------------------------------------
    console.log('  Testing Reactive State Subscriptions...');
    let notifiedStateKey = '';
    const unsubscribe = service.subscribe(state => {
        notifiedStateKey = state.apiKey || '';
    });

    const newKey = 'AIzaSyUpdatedKeySubscribed2026';
    service.setApiKey(newKey);
    assert.strictEqual(notifiedStateKey, newKey, 'Subscriber must be notified on API key update');

    unsubscribe();
    service.setApiKey('AIzaSyAnotherKey');
    assert.strictEqual(notifiedStateKey, newKey, 'Unsubscribed listener must not receive further events');

    // Restore original key
    service.setApiKey(originalKey);
    console.log('  ✓ Test 6 Passed: Reactive observer subscriptions reliably propagate state changes.');

    // -------------------------------------------------------------
    // Test 7: Vector ROADMAP Reference & Cloud-Based Map Styling
    // -------------------------------------------------------------
    console.log('  Testing Vector ROADMAP Reference & Cloud-Based Map Styling...');

    // 1. Verify Cloud-Based Map Styling JSON Schema
    assert.strictEqual(GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE.variant, 'light', 'Cloud styling must use light variant');
    assert.ok(Array.isArray(GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE.styles), 'styles must be an array');
    const styledIds = GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE.styles.map(s => s.id);
    assert.ok(styledIds.includes('political'), 'Must suppress political labels');
    assert.ok(styledIds.includes('pointOfInterest'), 'Must suppress POI labels');
    assert.ok(styledIds.includes('infrastructure'), 'Must suppress infrastructure labels');
    assert.ok(styledIds.includes('natural'), 'Must suppress natural labels');

    for (const rule of GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE.styles) {
        assert.strictEqual(rule.label.visible, false, `Label visibility for ${rule.id} must be false`);
    }

    assert.deepStrictEqual(service.getCloudMapStylingJson(), GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE, 'Service getCloudMapStylingJson must match constant');

    // 2. Verify Map ID management
    const testMapId = 'map_id_vector_roadmap_light_ref_2026';
    service.setVectorRoadmapMapId(testMapId);
    assert.strictEqual(service.getVectorRoadmapMapId(), testMapId, 'getVectorRoadmapMapId must return configured Map ID');

    // 3. Verify Vector Roadmap Ground Blueprint URL Generation (with Map ID)
    service.setApiKey(testKey);
    const blueprintUrlWithMapId = service.getVectorRoadmapStaticBlueprintUrl({
        center: { lat: 37.7955, lng: -122.3937 },
        zoom: 17,
        size: 1024
    });
    assert.ok(blueprintUrlWithMapId.includes('maptype=roadmap'), 'Blueprint URL must use roadmap maptype');
    assert.ok(blueprintUrlWithMapId.includes('size=1024x1024'), 'Blueprint URL must specify square dimension');
    assert.ok(blueprintUrlWithMapId.includes(`map_id=${testMapId}`), 'Blueprint URL must embed Cloud Map ID');
    assert.ok(blueprintUrlWithMapId.includes('zoom=17'), 'Blueprint URL must embed zoom level');

    // 4. Verify Vector Roadmap Ground Blueprint URL Generation (without Map ID fallback to style)
    service.setVectorRoadmapMapId('');
    const blueprintUrlWithStyleFallback = service.getVectorRoadmapStaticBlueprintUrl({
        center: '37.7955,-122.3937',
        zoom: 16
    });
    assert.ok(blueprintUrlWithStyleFallback.includes('maptype=roadmap'), 'Fallback URL must use roadmap maptype');
    assert.ok(blueprintUrlWithStyleFallback.includes('style='), 'Fallback URL must embed style parameter hiding labels');

    // Restore key
    service.setApiKey(originalKey);
    console.log('  ✓ Test 7 Passed: Vector ROADMAP Reference, Cloud-Based Map Styling JSON, and Map ID pipeline operate flawlessly.');

    console.log('\n🎉 ALL GOOGLE MAPS SERVICE TESTS PASSED SUCCESSFULLY!\n');
}

test('google-maps-service.test', async () => {
    await runGoogleMapsServiceTests();
}, 180_000);
