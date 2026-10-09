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
import * as THREE from 'three';
import {
    TerrainManager,
    GROUND_SAMPLE_OFFSETS
} from '../src/browser/generative-canvas/services/TerrainManager';
import {
    GooglePhotorealistic3DTilesLayer
} from '../src/browser/generative-canvas/services/GooglePhotorealistic3DTilesLayer';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

async function runTerrainGroundSnappingTests(): Promise<void> {
    console.log('🚀 Running 3D Terrain Ground Snapping & Elevation Test Suite...\n');

    // =========================================================================
    // TEST 1: GROUND_SAMPLE_OFFSETS & Single/Multi-point Raycasting
    // =========================================================================
    console.log('  Testing TerrainManager 9-point ground height sampling...');
    {
        assert.strictEqual(GROUND_SAMPLE_OFFSETS.length, 9, 'Must define 9 sample offset vectors');
        assert.deepStrictEqual(GROUND_SAMPLE_OFFSETS[0], [0, 0]);

        const scene = new THREE.Scene();

        // Create an undulating terrain mesh: y = 5.0 + sin(x)*cos(z)
        const terrainGeo = new THREE.PlaneGeometry(100, 100, 20, 20);
        terrainGeo.rotateX(-Math.PI / 2);
        const posAttr = terrainGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i);
            const y = 5.0 + Math.sin(x * 0.1) * 2.0;
            posAttr.setY(i, y);
        }
        terrainGeo.computeVertexNormals();
        const terrainMesh = new THREE.Mesh(terrainGeo, new THREE.MeshBasicMaterial());
        terrainMesh.name = 'Terrain';
        terrainMesh.updateMatrixWorld(true);
        scene.add(terrainMesh);

        const manager = new TerrainManager({ scene });

        // Sample at origin (x=0, z=0) -> y should be ~5.0
        const h0 = manager.sampleHeight(0, 0);
        assert.ok(h0 !== null, 'sampleHeight must return a number');
        assert.ok(Math.abs(h0 - 5.0) < 0.1, `Expected height near 5.0 at origin, got ${h0}`);

        // 9-point ground sample
        const groundH = manager.sampleGroundHeight(0, 0, 4);
        assert.ok(groundH !== null, 'sampleGroundHeight must return a number');
        assert.ok(groundH >= 4.0 && groundH <= 6.0, `Ground height ${groundH} should be within terrain bounds`);

        console.log('  ✓ Test 1 Passed: 9-point terrain height sampling works.');
    }

    // =========================================================================
    // TEST 2: Object Snapping with Bounding Box Bottom Offset
    // =========================================================================
    console.log('  Testing TerrainManager object snapping with bounding box offset...');
    {
        const scene = new THREE.Scene();

        // Flat ground at y = 12.0
        const groundGeo = new THREE.PlaneGeometry(50, 50);
        groundGeo.rotateX(-Math.PI / 2);
        const groundMesh = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial());
        groundMesh.position.y = 12.0;
        groundMesh.updateMatrixWorld(true);
        scene.add(groundMesh);

        const manager = new TerrainManager({ scene });

        // Box of height 4 (from y = -2 to y = 2 relative to origin), initially at y = 0
        const boxGeo = new THREE.BoxGeometry(2, 4, 2);
        const boxMesh = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial());
        boxMesh.position.set(0, 0, 0);
        boxMesh.updateMatrixWorld(true);
        scene.add(boxMesh);

        // Before snap: position.y is 0, bounding box min.y is -2
        const boxBefore = new THREE.Box3().setFromObject(boxMesh);
        assert.strictEqual(boxBefore.min.y, -2);

        // Snap to ground with offset = 0
        const snappedY = manager.snapObjectToGround(boxMesh, 0);
        assert.ok(snappedY !== null);

        // After snap: bottom of box (min.y) should rest on ground surface (approx 12.0)
        boxMesh.updateMatrixWorld(true);
        const boxAfter = new THREE.Box3().setFromObject(boxMesh);
        assert.ok(Math.abs(boxAfter.min.y - 12.0) < 0.1, `Expected bottom of box at 12.0, got ${boxAfter.min.y}`);
        assert.ok(Math.abs(boxMesh.position.y - 14.0) < 0.1, `Expected center of box at 14.0, got ${boxMesh.position.y}`);

        // Snap with additional offset = 1.5
        manager.snapObjectToGround(boxMesh, 1.5);
        boxMesh.updateMatrixWorld(true);
        const boxOffsetAfter = new THREE.Box3().setFromObject(boxMesh);
        assert.ok(Math.abs(boxOffsetAfter.min.y - 13.5) < 0.1, `Expected bottom of box at 13.5 with offset, got ${boxOffsetAfter.min.y}`);

        console.log('  ✓ Test 2 Passed: Object bounding-box bottom aligns accurately with ground surface.');
    }

    // =========================================================================
    // TEST 3: Multi-object / Hierarchical Group Snapping
    // =========================================================================
    console.log('  Testing hierarchical figure group snapping (e.g. Minuteman soldier)...');
    {
        const scene = new THREE.Scene();

        // Sloped ground: y = 10.0 + x * 0.2
        const slopeGeo = new THREE.PlaneGeometry(100, 100, 10, 10);
        slopeGeo.rotateX(-Math.PI / 2);
        const pos = slopeGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            pos.setY(i, 10.0 + x * 0.2);
        }
        slopeGeo.computeVertexNormals();
        const ground = new THREE.Mesh(slopeGeo, new THREE.MeshBasicMaterial());
        ground.updateMatrixWorld(true);
        scene.add(ground);

        const manager = new TerrainManager({ scene });

        // Create soldier figure group at x = 10, z = 0 (ground should be y = 12.0)
        const soldierGroup = new THREE.Group();
        soldierGroup.name = 'Minuteman Soldier';
        soldierGroup.position.set(10, 0, 0);

        // Body from y=0 to y=1.5
        const bodyGeo = new THREE.BoxGeometry(0.8, 1.5, 0.4);
        bodyGeo.translate(0, 0.75, 0);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshBasicMaterial());
        soldierGroup.add(body);

        // Hat from y=1.5 to y=1.8
        const hatGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.3);
        hatGeo.translate(0, 1.65, 0);
        const hat = new THREE.Mesh(hatGeo, new THREE.MeshBasicMaterial());
        soldierGroup.add(hat);

        scene.add(soldierGroup);
        soldierGroup.updateMatrixWorld(true);

        // Snap with soldier human footprint spread (0.5m)
        manager.snapObjectToGround(soldierGroup, 0, 0.5);
        soldierGroup.updateMatrixWorld(true);

        const soldierBox = new THREE.Box3().setFromObject(soldierGroup);
        const expectedGroundAt10 = 10.0 + 10 * 0.2; // 12.0
        assert.ok(
            Math.abs(soldierBox.min.y - expectedGroundAt10) < 0.2,
            `Expected soldier group base at ${expectedGroundAt10}, got ${soldierBox.min.y}`
        );

        // Snap with full 4m spread to verify 9-point perimeter minimum
        manager.snapObjectToGround(soldierGroup, 0, 4.0);
        soldierGroup.updateMatrixWorld(true);
        const soldierBoxWide = new THREE.Box3().setFromObject(soldierGroup);
        assert.ok(
            Math.abs(soldierBoxWide.min.y - 11.2) < 0.2,
            `Expected wide perimeter minimum on slope to be 11.2, got ${soldierBoxWide.min.y}`
        );

        console.log('  ✓ Test 3 Passed: Hierarchical composite figures snap cleanly to terrain surface.');
    }

    // =========================================================================
    // TEST 4: GooglePhotorealistic3DTilesLayer Raycast & TerrainManager Integration
    // =========================================================================
    console.log('  Testing GooglePhotorealistic3DTilesLayer ground queries...');
    {
        const tilesLayer = new GooglePhotorealistic3DTilesLayer({
            origin: { lat: 42.4494, lng: -71.2313, alt: 60 }
        });

        // Mock a tile mesh inside tilesRenderer group
        const tileMesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial());
        tileMesh.geometry.rotateX(-Math.PI / 2);
        tileMesh.position.set(0, 8.5, 0);
        tileMesh.updateMatrixWorld(true);
        tilesLayer.group.add(tileMesh);

        const scene = new THREE.Scene();
        scene.add(tilesLayer.group);

        const manager = tilesLayer.getTerrainManager(scene);
        const sampled = manager.sampleHeight(0, 0);
        assert.ok(sampled !== null);
        assert.ok(Math.abs(sampled - 8.5) < 0.1, `Expected height 8.5 from tile mesh, got ${sampled}`);

        const layerSampled = tilesLayer.sampleGroundHeight(0, 0);
        assert.ok(layerSampled !== null);
        assert.ok(Math.abs(layerSampled - 8.5) < 0.2);

        tilesLayer.dispose();
        console.log('  ✓ Test 4 Passed: GooglePhotorealistic3DTilesLayer raycast and height sampling verified.');
    }

    // =========================================================================
    // TEST 5: DirectDispatchOperatorEngine `sb_snap_to_terrain` Operator
    // =========================================================================
    console.log('  Testing DirectDispatchOperatorEngine sb_snap_to_terrain operator...');
    {
        const engine = createOperatorEngine({
            title: 'Terrain Snapping Scene',
            customMeshes: [
                {
                    id: 'soldier_line_1',
                    name: 'Soldier Line',
                    type: 'box',
                    position: [5, 0, 5],
                    scale: [1, 2, 1]
                },
                {
                    id: 'soldier_line_2',
                    name: 'Tactical Box',
                    type: 'box',
                    position: [-5, 0, -5],
                    scale: [1, 2, 1]
                }
            ]
        });

        const threeScene = new THREE.Scene();
        // Terrain at y = 7.0
        const terrain = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicMaterial());
        terrain.geometry.rotateX(-Math.PI / 2);
        terrain.position.set(0, 7.0, 0);
        terrain.updateMatrixWorld(true);
        threeScene.add(terrain);

        // Add 3D representation for custom mesh
        const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
        m1.name = 'soldier_line_1';
        m1.position.set(5, 0, 5);
        threeScene.add(m1);

        const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
        m2.name = 'soldier_line_2';
        m2.position.set(-5, 0, -5);
        threeScene.add(m2);

        engine.attachThreeScene(threeScene);

        // Snap specific object
        const res1 = engine.dispatch('sb_snap_to_terrain', { objectId: 'soldier_line_1', offset: 0.1 });
        assert.strictEqual(res1.success, true);
        assert.ok(res1.data.snappedCount >= 1);

        const obj1Data = engine.getObject('soldier_line_1');
        assert.ok(obj1Data.position[1] >= 7.0, `Object 1 y position ${obj1Data.position[1]} should be snapped above 7.0`);

        // Snap all objects
        const resAll = engine.dispatch('sb_snap_to_terrain', { offset: 0 });
        assert.strictEqual(resAll.success, true);
        assert.strictEqual(resAll.data.snappedCount, 2);

        console.log('  ✓ Test 5 Passed: sb_snap_to_terrain operator accurately grounds individual and batch objects.');
    }

    // =========================================================================
    // TEST 6: Optimal Camera LookAt Framing
    // =========================================================================
    console.log('  Testing camera lookAt calculation on elevated terrain...');
    {
        const scene = new THREE.Scene();
        const terrain = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), new THREE.MeshBasicMaterial());
        terrain.geometry.rotateX(-Math.PI / 2);
        terrain.position.set(0, 15.0, 0);
        terrain.updateMatrixWorld(true);
        scene.add(terrain);

        const manager = new TerrainManager({ scene });
        const lookAt = manager.getOptimalCameraLookAt(0, 0, 1.5);
        assert.strictEqual(lookAt[0], 0);
        assert.ok(Math.abs(lookAt[1] - 16.5) < 0.2, `Camera lookAt Y should be ground (15.0) + 1.5 = 16.5, got ${lookAt[1]}`);
        assert.strictEqual(lookAt[2], 0);

        console.log('  ✓ Test 6 Passed: Camera lookAt dynamically adjusts to terrain elevation.');
    }

    // =========================================================================
    // TEST 7: Additive Construction & Ground Logic Between 3D Tile Meshes and Built Objects
    // =========================================================================
    console.log('  Testing additive building and shared metric ground logic on 3D tiles...');
    {
        const scene = new THREE.Scene();

        // 1. Ingest simulated 3D tile district mesh with elevated plaza at Y = 4.5m
        const tileGeometry = new THREE.BoxGeometry(60, 9, 60); // from -4.5 to +4.5
        const tileMesh = new THREE.Mesh(tileGeometry, new THREE.MeshBasicMaterial());
        tileMesh.name = 'external-object-tile-colosseum';
        tileMesh.position.set(0, 0, 0); // top surface is at Y = 4.5m
        tileMesh.updateMatrixWorld(true);
        scene.add(tileMesh);

        const manager = new TerrainManager({ scene });

        // Verify terrain/tile elevation query
        const tileSurfaceY = manager.sampleHeight(0, 0);
        assert.ok(tileSurfaceY !== null, 'Must detect 3D tile mesh surface');
        assert.ok(Math.abs(tileSurfaceY - 4.5) < 0.01, `Tile surface should be at 4.5m, got ${tileSurfaceY}`);

        // 2. Build Object A (Pavilion/Pedestal: 10m x 3m x 10m, centered at origin, height 3m)
        const pedestalGeo = new THREE.BoxGeometry(10, 3, 10);
        const pedestalMesh = new THREE.Mesh(pedestalGeo, new THREE.MeshBasicMaterial());
        pedestalMesh.name = 'pedestal_edifice';
        pedestalMesh.position.set(0, 0, 0); // before snap: center at 0, min.y = -1.5, max.y = +1.5
        scene.add(pedestalMesh);
        pedestalMesh.updateMatrixWorld(true);

        // Snap Object A to the 3D tile surface
        const snappedPavilionY = manager.snapObjectToGround(pedestalMesh, 0);
        assert.ok(snappedPavilionY !== null);
        pedestalMesh.updateMatrixWorld(true);

        const pedestalBox = new THREE.Box3().setFromObject(pedestalMesh);
        // Base of Object A should rest flush at Y = 4.5m, top should reach Y = 7.5m
        assert.ok(Math.abs(pedestalBox.min.y - 4.5) < 0.05, `Object A base must rest on tile surface at 4.5m, got ${pedestalBox.min.y}`);
        assert.ok(Math.abs(pedestalBox.max.y - 7.5) < 0.05, `Object A top must reach 7.5m, got ${pedestalBox.max.y}`);
        console.log(`    ✓ Object A correctly grounded on 3D tile: base=${pedestalBox.min.y.toFixed(2)}m, top=${pedestalBox.max.y.toFixed(2)}m`);

        // 3. Build Object B (Statue/Hero Asset: 2m x 4m x 2m, centered at origin, height 4m)
        // This tests building ON TOP of Object A ("build on top of each other")
        const heroGeo = new THREE.BoxGeometry(2, 4, 2);
        const heroMesh = new THREE.Mesh(heroGeo, new THREE.MeshBasicMaterial());
        heroMesh.name = 'hero_statue';
        heroMesh.position.set(0, 0, 0); // before snap: center at 0, min.y = -2.0, max.y = +2.0
        scene.add(heroMesh);
        heroMesh.updateMatrixWorld(true);

        // Snap Object B on top of Object A
        const snappedHeroY = manager.snapObjectToGround(heroMesh, 0);
        assert.ok(snappedHeroY !== null);
        heroMesh.updateMatrixWorld(true);

        const heroBox = new THREE.Box3().setFromObject(heroMesh);
        // Base of Object B should rest flush at the top of Object A (Y = 7.5m), top should reach Y = 11.5m
        assert.ok(Math.abs(heroBox.min.y - 7.5) < 0.05, `Object B base must rest on top of Object A at 7.5m, got ${heroBox.min.y}`);
        assert.ok(Math.abs(heroBox.max.y - 11.5) < 0.05, `Object B top must reach 11.5m, got ${heroBox.max.y}`);
        console.log(`    ✓ Object B correctly built on top of Object A: base=${heroBox.min.y.toFixed(2)}m, top=${heroBox.max.y.toFixed(2)}m`);

        // 4. Verify metric SI scaling: 1 Three.js unit = 1.0 meter
        const totalHeight = heroBox.max.y - 4.5; // from tile surface to top of Object B
        assert.ok(Math.abs(totalHeight - 7.0) < 0.05, `Total combined height should be 3m + 4m = 7m, got ${totalHeight}`);

        console.log('  ✓ Test 7 Passed: Additive construction and shared metric ground logic between tiles and objects verified.');
    }

    console.log('\n🎉 All Terrain Ground Snapping & Elevation Tests Passed Successfully!\n');
}

test('terrain-ground-snapping.test', async () => {
    await runTerrainGroundSnappingTests();
}, 180_000);
