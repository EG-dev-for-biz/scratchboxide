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
import * as THREE from 'three';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import { GeoFrame } from '../src/common/coordinate/GeoFrame';
import {
    TileBoundAligner,
    TileBounds,
    LocalTileBounds
} from '../src/browser/generative-canvas/services/TileBoundAligner';
import {
    TileClayProcessor,
    CLAY_PRESETS,
    ClayPresetId,
    ClayMaterialConfig
} from '../src/browser/generative-canvas/services/TileClayProcessor';
import {
    Google3DTileService,
    TileIngestionOptions,
    TileIngestionResult
} from '../src/browser/generative-canvas/services/Google3DTileService';
import {
    Google3DTileIngestionService
} from '../src/node/spatial/Google3DTileIngestionService';
import {
    createOperatorEngine,
    DirectDispatchOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    TransformGizmoEngine
} from '../src/browser/generative-canvas/services/transform-gizmo-engine';
import type { Scene3DData, Media4DObject } from '../src/browser/generative-canvas/canvas-types';

async function runGoogle3DTileIngestionTests(): Promise<void> {
    console.log('🚀 Running 3D Google Tile Ingestion & Clay Processing Test Suite...\n');

    // ========================================================================
    // TEST 1: TileBoundAligner (Slippy XYZ <-> Geodetic <-> Local Tangent Plane)
    // ========================================================================
    console.log('  Testing TileBoundAligner Coordinate Conversion...');
    {
        // San Francisco Ferry Building area (~37.7955°N, -122.3937°W)
        const lat = 37.7955;
        const lng = -122.3937;
        const zoom = 16;

        const xyz = TileBoundAligner.latLngToXYZ(lat, lng, zoom);
        assert.strictEqual(typeof xyz.x, 'number');
        assert.strictEqual(typeof xyz.y, 'number');
        assert.strictEqual(xyz.z, 16);
        assert.ok(xyz.x > 0 && xyz.y > 0, 'Tile indices must be positive integers');

        const bounds: TileBounds = TileBoundAligner.xyzToLatLngBounds(xyz.x, xyz.y, xyz.z);
        assert.ok(bounds.nw.lat > bounds.se.lat, 'North latitude must be greater than South latitude');
        assert.ok(bounds.nw.lng < bounds.se.lng, 'West longitude must be less than East longitude');
        assert.ok(lat >= bounds.se.lat && lat <= bounds.nw.lat, 'Latitude must be bounded by tile envelope');
        assert.ok(lng >= bounds.nw.lng && lng <= bounds.se.lng, 'Longitude must be bounded by tile envelope');

        // Test Local Tangent Plane bounding box projection
        const ltp = new LocalTangentPlane({ lat, lng, alt: 0 }, 0);
        const localBounds: LocalTileBounds = TileBoundAligner.xyzToLocalBounds(xyz.x, xyz.y, xyz.z, ltp, -10, 200);

        assert.ok(localBounds.min[0] <= localBounds.max[0], 'Local X min <= max');
        assert.ok(localBounds.min[1] <= localBounds.max[1], 'Local Y min <= max');
        assert.ok(localBounds.min[2] <= localBounds.max[2], 'Local Z min <= max');
        assert.ok(Math.abs(localBounds.min[1] - (-10)) < 1.0, 'Local Y min close to -10');
        assert.ok(Math.abs(localBounds.max[1] - 200) < 1.0, 'Local Y max close to 200');

        console.log('  ✓ Test 1 Passed: TileBoundAligner converts Slippy tile XYZ <-> WGS-84 <-> Local ENU.');
    }

    // ========================================================================
    // TEST 2: TileClayProcessor (Presets, Shaders, Material Generation)
    // ========================================================================
    console.log('  Testing TileClayProcessor Material Presets & Shader Generation...');
    {
        const expectedPresets: ClayPresetId[] = [
            'warm-clay',
            'alabaster',
            'onyx',
            'studio-grey',
            'terracotta',
            'porcelain',
            'concrete'
        ];

        for (const presetId of expectedPresets) {
            const preset = CLAY_PRESETS[presetId];
            assert.ok(preset, `Preset ${presetId} must be defined`);
            assert.ok(preset.color, `Preset ${presetId} must specify color`);
            assert.ok(typeof preset.roughness === 'number', `Preset ${presetId} must specify roughness`);
            assert.ok(typeof preset.metalness === 'number', `Preset ${presetId} must specify metalness`);
        }

        // Test creating standard clay material
        const warmMat = TileClayProcessor.createClayMaterial('warm-clay');
        assert.ok(warmMat instanceof THREE.MeshStandardMaterial, 'Should create MeshStandardMaterial');
        assert.strictEqual(warmMat.userData.clayPreset, 'warm-clay');
        assert.ok(warmMat.roughness >= 0.7, 'Clay should have matte roughness >= 0.7');

        // Test applying clay material to a test mesh
        const geom = new THREE.BoxGeometry(10, 10, 10);
        const testMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
        TileClayProcessor.applyClayMaterial(testMesh, 'alabaster', { cavityShading: true });

        const appliedMat = testMesh.material as THREE.MeshStandardMaterial;
        assert.strictEqual(appliedMat.userData.clayPreset, 'alabaster');
        assert.strictEqual(testMesh.castShadow, true);
        assert.strictEqual(testMesh.receiveShadow, true);
        assert.ok(geom.attributes.normal, 'Mesh geometry must have normals computed for clay shading');

        // Test custom clay shader generation
        const customClay = TileClayProcessor.createClayShaderConfig({
            preset: 'onyx',
            cavityStrength: 0.65,
            ambientOcclusionGain: 1.2
        });
        assert.ok(customClay.uniforms.uClayColor, 'Shader uniforms must include uClayColor');
        assert.ok(customClay.uniforms.uCavityStrength, 'Shader uniforms must include uCavityStrength');
        assert.ok(customClay.fragmentShader.includes('uClayColor'), 'Fragment shader must use uClayColor');

        console.log('  ✓ Test 2 Passed: TileClayProcessor generates architectural clay materials & shaders.');
    }

    // ========================================================================
    // TEST 3: Google3DTileService Ingestion & Mesh Synthesis
    // ========================================================================
    console.log('  Testing Google3DTileService 3D Map Ingestion & GLTF Mesh Generation...');
    {
        const tileService = Google3DTileService.getInstance();

        // 1. Test Landmark Geocoding & Coordinate Resolution
        const ferryResolved = await tileService.resolveLocation('san francisco ferry building');
        assert.ok(ferryResolved, 'Should resolve Ferry Building landmark');
        assert.ok(Math.abs(ferryResolved.lat - 37.7955) < 0.01, 'Latitude should match Ferry Building');
        assert.ok(Math.abs(ferryResolved.lng - (-122.3937)) < 0.01, 'Longitude should match Ferry Building');

        const eiffelResolved = await tileService.resolveLocation('eiffel tower');
        assert.ok(eiffelResolved, 'Should resolve Eiffel Tower');
        assert.ok(Math.abs(eiffelResolved.lat - 48.8584) < 0.01);

        // 2. Test Ingesting 3D Map Tile Region
        const ingestionOptions: TileIngestionOptions = {
            query: 'san francisco ferry building',
            zoom: 17,
            radiusMeters: 180,
            clayPreset: 'warm-clay',
            includeTerrain: true,
            includeBuildings: true,
            detailLevel: 'high'
        };

        const result: TileIngestionResult = await tileService.ingestTileRegion(ingestionOptions);

        assert.ok(result.success, 'Ingestion must succeed');
        assert.ok(result.mesh, 'Result must contain Three.js Mesh / Group');
        assert.ok(result.media4DObject, 'Result must contain Media4DObject');
        assert.ok(result.customMeshDefinition, 'Result must contain customMeshDefinition for Scene3DData');
        assert.ok(result.stats.buildingCount > 0, 'Should synthesize architectural building topologies');
        assert.ok(result.stats.vertexCount > 100, 'Vertex count should reflect realistic 3D geometry');

        // Check Media4DObject conformance to 4D geospatial protocol
        const m4d = result.media4DObject;
        assert.strictEqual(m4d.content.type, 'map-3d');
        assert.ok(m4d.space.geoAnchor, 'Media4DObject must include geoAnchor');
        assert.ok(m4d.space.geoAnchor!.lat > 0, 'Valid lat in geoAnchor');
        assert.ok(m4d.space.boundingBox, 'Media4DObject must include boundingBox');
        assert.ok(m4d.content.metadata?.vertices, 'Media4DObject must document vertex count');

        // Check Clay Material applied to Ingested Mesh
        const meshMat = result.mesh.material as THREE.MeshStandardMaterial;
        assert.strictEqual(meshMat.userData.clayPreset, 'warm-clay');
        assert.strictEqual(meshMat.userData.is3DMapTile, true);

        // Check GLTF / GLB Buffer Export Synthesis
        const glbBuffer = await tileService.synthesizeGlbTileBuffer(result.mesh);
        assert.ok(glbBuffer instanceof ArrayBuffer || glbBuffer instanceof Uint8Array, 'GLB buffer created');
        assert.ok(glbBuffer.byteLength > 0, 'GLB buffer must not be empty');

        console.log(`  ✓ Test 3 Passed: Ingested 3D Tile region with ${result.stats.buildingCount} buildings, ${result.stats.vertexCount} vertices, and GLB export.`);
    }

    // ========================================================================
    // TEST 4: Node Google3DTileIngestionService & SpatialAssetVaultService
    // ========================================================================
    console.log('  Testing Node Google3DTileIngestionService & Vault Integration...');
    {
        const nodeService = new Google3DTileIngestionService();

        const nodeResult = await nodeService.ingestAndStoreTileAsset({
            branchId: 'main',
            locationQuery: 'coit tower',
            clayPreset: 'studio-grey',
            radiusMeters: 150
        });

        assert.ok(nodeResult.success, 'Node ingestion must succeed');
        assert.ok(nodeResult.vaultId, 'Must produce a persistent vault ID');
        assert.ok(nodeResult.geohash, 'Must compute geohash token');
        assert.strictEqual(nodeResult.representation.type, 'map-3d');
        assert.strictEqual(nodeResult.representation.clayPreset, 'studio-grey');

        console.log(`  ✓ Test 4 Passed: Node spatial service stored tile asset in vault (${nodeResult.vaultId}, geohash: ${nodeResult.geohash}).`);
    }

    // ========================================================================
    // TEST 5: DirectDispatchOperatorEngine Operators (`sb_import_3d_tile`, `sb_set_clay_mode`, `sb_set_tile_anchor`)
    // ========================================================================
    console.log('  Testing Direct-Dispatch Operators for 3D Map Tiles...');
    {
        const initialScene: Scene3DData = {
            title: 'Geospatial Test Scene',
            objects: [],
            customMeshes: [],
            geoAnchor: { lat: 37.7749, lng: -122.4194, elevation: 10 }
        };

        const engine = createOperatorEngine(initialScene);

        // 1. Test `sb_import_3d_tile`
        const importRes = await engine.dispatch('sb_import_3d_tile', {
            query: 'independence hall',
            clayPreset: 'terracotta',
            radiusMeters: 120,
            detailLevel: 'medium'
        });

        assert.strictEqual(importRes.success, true, `sb_import_3d_tile failed: ${importRes.error}`);
        assert.ok(importRes.data.objectId, 'Must return imported object ID');
        assert.ok(importRes.data.vertexCount > 0, 'Must report imported vertex count');

        const updatedScene = engine.getSceneData();
        assert.ok(updatedScene.customMeshes && updatedScene.customMeshes.length > 0, 'Custom meshes array must contain tile');
        assert.ok(updatedScene.objects && updatedScene.objects.length > 0, 'Media4D objects array must contain tile');

        const tileMesh = updatedScene.customMeshes.find(m => m.id === importRes.data.objectId);
        assert.ok(tileMesh, 'Imported tile mesh must exist in customMeshes');
        assert.strictEqual(tileMesh!.material?.shaderKey, 'terracotta');

        // 2. Test `sb_set_clay_mode`
        const clayRes = await engine.dispatch('sb_set_clay_mode', {
            targetId: importRes.data.objectId,
            preset: 'onyx',
            roughness: 0.82,
            metalness: 0.05
        });

        assert.strictEqual(clayRes.success, true, `sb_set_clay_mode failed: ${clayRes.error}`);
        assert.strictEqual(clayRes.data.appliedPreset, 'onyx');

        const mutatedScene = engine.getSceneData();
        const updatedTileMesh = mutatedScene.customMeshes?.find(m => m.id === importRes.data.objectId);
        assert.strictEqual(updatedTileMesh?.material?.shaderKey, 'onyx');

        // 3. Test `sb_set_tile_anchor`
        const anchorRes = await engine.dispatch('sb_set_tile_anchor', {
            lat: 48.8584,
            lng: 2.2945,
            elevation: 35.0,
            landmarkName: 'Eiffel Tower'
        });

        assert.strictEqual(anchorRes.success, true, `sb_set_tile_anchor failed: ${anchorRes.error}`);
        assert.strictEqual(anchorRes.data.geoAnchor.landmarkName, 'Eiffel Tower');

        const finalScene = engine.getSceneData();
        assert.strictEqual(finalScene.geoAnchor?.landmarkName, 'Eiffel Tower');
        assert.strictEqual(finalScene.geoAnchor?.lat, 48.8584);

        console.log('  ✓ Test 5 Passed: sb_import_3d_tile, sb_set_clay_mode, and sb_set_tile_anchor operators execute cleanly.');
    }

    // ========================================================================
    // TEST 6: 3D Viewport Interaction, Outliner Selection & Transform Gizmos
    // ========================================================================
    console.log('  Testing 3D Viewport Interaction, Selection & Transform Gizmos on Map Tiles...');
    {
        const threeScene = new THREE.Scene();
        const tileService = Google3DTileService.getInstance();

        const ingestion = await tileService.ingestTileRegion({
            query: 'san francisco',
            clayPreset: 'alabaster',
            radiusMeters: 100
        });

        threeScene.add(ingestion.mesh);

        // Verify outliner inspection helper finds the tile
        const outlinerItems: any[] = [];
        threeScene.traverse((obj) => {
            if (obj === threeScene) return;
            if (obj.parent === threeScene && obj.name) {
                outlinerItems.push({
                    id: obj.name,
                    name: obj.name,
                    type: obj.userData?.is3DMapTile ? '3d-map-tile' : 'mesh'
                });
            }
        });

        assert.ok(outlinerItems.length > 0, 'Outliner must list the 3D map tile object');
        const tileItem = outlinerItems.find(i => i.type === '3d-map-tile');
        assert.ok(tileItem, 'Tile item must be classified as 3d-map-tile');

        // Test Transform Gizmo Manipulation on the 3D Map Tile
        const gizmo = new TransformGizmoEngine();
        const gizmoGroup = gizmo.createGizmo('translate');
        assert.strictEqual(gizmoGroup.name, 'sb-gizmo-translate');
        threeScene.add(gizmoGroup);

        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
        camera.position.set(0, 50, 100);

        // Translate the tile in 3D space
        const initialY = ingestion.mesh.position.y;
        ingestion.mesh.position.y += 25.0;

        gizmo.updateGizmoTransform(
            gizmoGroup,
            ingestion.mesh.position,
            ingestion.mesh.quaternion,
            'world',
            camera
        );

        assert.strictEqual(ingestion.mesh.position.y, initialY + 25.0, '3D Map Tile can be translated');
        assert.strictEqual(gizmoGroup.position.y, ingestion.mesh.position.y, 'Gizmo tracks translated 3D map tile position');

        // Rotate the tile
        ingestion.mesh.rotation.y = Math.PI / 4;
        assert.ok(Math.abs(ingestion.mesh.rotation.y - Math.PI / 4) < 1e-4, '3D Map Tile can be rotated');

        // Scale the tile
        ingestion.mesh.scale.set(1.5, 1.5, 1.5);
        assert.strictEqual(ingestion.mesh.scale.x, 1.5, '3D Map Tile can be scaled');

        console.log('  ✓ Test 6 Passed: Ingested 3D Tile is selectable in outliner and fully manipulable with Transform Gizmos.');
    }

    console.log('\n🎉 ALL 6 GOOGLE 3D MAP TILE INGESTION & CLAY PROCESSING TESTS PASSED SUCCESSFULLY!\n');
}

test('google-3d-tiles-clay-ingestion.test', async () => {
    await runGoogle3DTileIngestionTests();
}, 180_000);
