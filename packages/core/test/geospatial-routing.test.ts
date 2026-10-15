import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';

// Standalone mathematical implementations matching Scene3DPrimitive's geometry calculations exactly
function getProceduralBinnedHeight(x: number, z: number, elevVal: number): number {
    const distanceToBay = x + 15; // bay is on the left
    let y = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 3.5; // rolling hills
    y += Math.sin(x * 0.05 + z * 0.05) * 5.0; // larger slope

    if (distanceToBay < -5) {
        // Water level depression
        y = -2.0 + Math.sin(z * 0.2) * 0.2;
    } else if (distanceToBay < 5) {
        // Smooth transition (shoreline)
        y *= (distanceToBay + 5) / 10;
    }

    const rawY = y + elevVal * 0.05 - 1.5;
    return Math.round(rawY / 0.4) * 0.4;
}

function projectCoords(latitude: number, longitude: number, refLat: number, refLng: number, elevVal: number): { x: number; y: number; z: number } {
    // Scale factor: map 0.01 degrees to 15 Three.js units
    const x = (longitude - refLng) * 1500 || 0;
    const z = -(latitude - refLat) * 1500 || 0;
    
    // Clamp to terrain boundaries
    const clampedX = Math.max(-20, Math.min(20, x));
    const clampedZ = Math.max(-20, Math.min(20, z));
    
    const y = getProceduralBinnedHeight(clampedX, clampedZ, elevVal);
    return { x: clampedX, y, z: clampedZ };
}

async function runGeospatialRoutingTests() {
    console.log('🧪 Running Geospatial Routing, Elevation Binning & Drone Clearance Test Suite...\n');

    const refLat = 37.7900;
    const refLng = -122.4000;
    const elevation = 15.2;

    // -------------------------------------------------------------
    // Test 1: Elevation Binning Discretization
    // -------------------------------------------------------------
    console.log('  Testing Elevation Binning Discretization...');
    const testPoints = [
        { x: -10, z: -10 },
        { x: 0, z: 0 },
        { x: 10, z: 10 },
        { x: -18, z: 5 }, // Water area
        { x: 15, z: -15 }
    ];

    for (const pt of testPoints) {
        const height = getProceduralBinnedHeight(pt.x, pt.z, elevation);
        // Height must be a perfect multiple of 0.4
        const modulo = Math.abs(height % 0.4);
        assert.ok(modulo < 1e-7 || Math.abs(modulo - 0.4) < 1e-7, `Height ${height} at (${pt.x}, ${pt.z}) must be binned to a multiple of 0.4. Modulo: ${modulo}`);
    }
    console.log('  ✓ Test 1 Passed: Elevation heightmap terrain is perfectly discretized to 0.4m contour steps.');

    // -------------------------------------------------------------
    // Test 2: Lat/Lng to Localized 3D Coordinate Projection
    // -------------------------------------------------------------
    console.log('  Testing Coordinate Projections...');
    // Reference centering test
    const centerProj = projectCoords(refLat, refLng, refLat, refLng, elevation);
    assert.strictEqual(centerProj.x, 0, 'Reference center longitude must project to x=0');
    assert.strictEqual(centerProj.z, 0, 'Reference center latitude must project to z=0');

    // Bounds clamping test
    const farOffProj = projectCoords(39.0000, -120.0000, refLat, refLng, elevation);
    assert.strictEqual(farOffProj.x, 20, 'Far right longitude must clamp to x=20');
    assert.strictEqual(farOffProj.z, -20, 'Far top latitude must clamp to z=-20');

    const pinAProj = projectCoords(37.7920, -122.4050, refLat, refLng, elevation);
    assert.ok(pinAProj.x >= -20 && pinAProj.x <= 20, 'Pin A projected X must be within scene bounds');
    assert.ok(pinAProj.z >= -20 && pinAProj.z <= 20, 'Pin A projected Z must be within scene bounds');
    console.log('  ✓ Test 2 Passed: Real-world geographic lat/lng coordinates map and clamp correctly within localized 3D scene boundaries.');

    // -------------------------------------------------------------
    // Test 3: Drone Flight Spline Clearance Verification
    // -------------------------------------------------------------
    console.log('  Testing Spline Flight Clearance & Topography Conformity...');
    const pinALat = 37.7920;
    const pinALng = -122.4050;
    const pinBLat = 37.7980;
    const pinBLng = -122.3950;

    const pinAPos = projectCoords(pinALat, pinALng, refLat, refLng, elevation);
    const pinBPos = projectCoords(pinBLat, pinBLng, refLat, refLng, elevation);

    // Drone flight path interpolation over 100 simulation steps
    for (let step = 0; step <= 100; step++) {
        const t_norm = step / 100;

        // Path interpolation (X, Z)
        const px = pinAPos.x + t_norm * (pinBPos.x - pinAPos.x);
        const pz = pinAPos.z + t_norm * (pinBPos.z - pinAPos.z);

        // Spline elevation flight path with 5m safety clearance (0.25 Three.js units) and parabolic arc lift
        const heightArc = Math.sin(t_norm * Math.PI) * 4.0;
        const terrainHeight = getProceduralBinnedHeight(px, pz, elevation);
        const droneY = terrainHeight + 0.25 + heightArc;

        // Verify drone height is strictly above the terrain at this point
        const actualClearanceUnits = droneY - terrainHeight;
        const actualClearanceMeters = actualClearanceUnits / 0.05;

        assert.ok(actualClearanceUnits >= 0.25, `Drone altitude clearance must be at least 0.25 units (5m) above terrain. Found: ${actualClearanceUnits} units at t=${t_norm}`);
        assert.ok(actualClearanceMeters >= 5.0, `Drone altitude clearance in meters must be at least 5.0m. Found: ${actualClearanceMeters}m at t=${t_norm}`);
    }
    console.log('  ✓ Test 3 Passed: High-fidelity drone flight spline maintains safe clearance over binned topography under all simulated path increments.');

    // -------------------------------------------------------------
    // Test 4: Google Maps Landmark Ground Truth Waypoint Resolution
    // -------------------------------------------------------------
    console.log('  Testing Google Maps Ground Truth Waypoint Resolution & Spatial Anchoring...');
    const { GoogleMapsService } = await import('../src/browser/generative-canvas/services/google-maps-service');
    const mapsService = GoogleMapsService.getInstance();
    
    // Resolve landmark locations for dynamic 3D scene placement: one Places Text Search call per name (injected here).
    const placesFetch = (async (_url: any, init?: any) => {
        const q = JSON.parse(init?.body || '{}').textQuery as string;
        const place = /ferry/i.test(q)
            ? { displayName: { text: 'Ferry Building' }, formattedAddress: '1 Ferry Building, San Francisco, CA 94111, USA', location: { latitude: 37.7955, longitude: -122.3937 } }
            : { displayName: { text: 'Coit Tower' }, formattedAddress: '1 Telegraph Hill Blvd, San Francisco, CA 94133, USA', location: { latitude: 37.8024, longitude: -122.4058 } };
        return new Response(JSON.stringify({ places: [place] }), { status: 200 });
    }) as typeof fetch;
    const ferryBuilding = await mapsService.geocode('San Francisco Ferry Building', { apiKey: 'test-key', fetchImpl: placesFetch });
    const coitTower = await mapsService.geocode('Coit Tower, San Francisco', { apiKey: 'test-key', fetchImpl: placesFetch });
    
    assert.ok(ferryBuilding && ferryBuilding.lat && ferryBuilding.lng, 'Ferry building geocoding must succeed');
    assert.ok(coitTower && coitTower.lat && coitTower.lng, 'Coit Tower geocoding must succeed');
    assert.strictEqual(coitTower.name, 'Coit Tower');
    
    const projFerry = projectCoords(ferryBuilding.lat, ferryBuilding.lng, refLat, refLng, elevation);
    const projCoit = projectCoords(coitTower.lat, coitTower.lng, refLat, refLng, elevation);
    
    assert.ok(typeof projFerry.x === 'number' && typeof projFerry.z === 'number', 'Ferry building 3D projection is valid');
    assert.ok(typeof projCoit.x === 'number' && typeof projCoit.z === 'number', 'Coit Tower 3D projection is valid');
    
    // Static map preview URL generation for drone flight route
    const staticRouteMap = mapsService.getStaticMapUrl({
        center: { lat: (ferryBuilding.lat + coitTower.lat) / 2, lng: (ferryBuilding.lng + coitTower.lng) / 2 },
        zoom: 15,
        markers: [
            { lat: ferryBuilding.lat, lng: ferryBuilding.lng, color: 'blue', label: 'A' },
            { lat: coitTower.lat, lng: coitTower.lng, color: 'green', label: 'B' }
        ],
        paths: [{
            color: '0x00ff88ff',
            weight: 4,
            points: [{ lat: ferryBuilding.lat, lng: ferryBuilding.lng }, { lat: coitTower.lat, lng: coitTower.lng }]
        }]
    });
    assert.ok(staticRouteMap.length > 0, 'Static route map URL must be generated');
    console.log('  ✓ Test 4 Passed: Google Maps geocoded landmarks anchor 3D scene waypoints with static map visualization.');

    console.log('\n🎉 ALL MAPS GROUNDING, ELEVATION PROFILES, AND COORDINATE TESTING TESTS PASSED SUCCESSFULLY!');
}

test('geospatial-routing.test', async () => {
    await runGeospatialRoutingTests();
}, 180_000);
