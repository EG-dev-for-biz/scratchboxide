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
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type {
    OperatorCategory
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import type {
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';
import { evaluateFalloff } from '../src/browser/generative-canvas/services/mesh-sculpting-engine';

async function runDirectDispatchOperatorEngineTests() {
    console.log('🚀 Running Direct-Dispatch 3D Operator Engine Test Suite...\n');

    // =========================================================================
    // Test 1: Engine Instantiation & Operator Catalog Registry
    // =========================================================================
    console.log('  Testing Engine Instantiation & Catalog Registry...');
    const engine = createOperatorEngine();

    const categories: OperatorCategory[] = [
        'inspect',
        'transform',
        'mesh_edit',
        'modifiers',
        'materials_pbr',
        'lighting_camera',
        'physics_animation',
        'nature_atmosphere',
        'state_history'
    ];

    for (const cat of categories) {
        const ops = engine.getOperatorsByCategory(cat);
        assert.ok(ops.length > 0, `Category ${cat} must have registered operators`);
    }

    const requiredOperators = [
        // Inspect
        'sb_list_objects',
        'sb_inspect_object',
        'sb_inspect_scene',
        'sb_get_mesh_stats',
        // Transform
        'sb_set_transform',
        'sb_translate',
        'sb_rotate',
        'sb_scale',
        'sb_set_origin',
        // Mesh Edit
        'sb_subdivide_mesh',
        'sb_smooth_mesh',
        'sb_deform_vertices',
        // Materials / PBR
        'sb_create_material',
        'sb_set_material_pbr',
        'sb_assign_material',
        // Lighting & Camera
        'sb_setup_lighting',
        'sb_set_camera',
        'sb_frame_bounds',
        // Physics & Animation
        'sb_add_physics',
        'sb_insert_keyframe',
        // Maintenance / State
        'sb_undo',
        'sb_redo',
        'sb_reset_scene'
    ];

    for (const opName of requiredOperators) {
        const op = engine.getOperator(opName);
        assert.ok(op, `Operator ${opName} must be registered in catalog`);
        assert.strictEqual(op.name, opName);
        assert.ok(op.description && op.description.length > 0, `Operator ${opName} must have description`);
    }

    // Operators that only reported work they never did were removed from the catalog.
    const removedOperators = [
        'sb_apply_transforms', 'sb_extrude_faces', 'sb_boolean_op', 'sb_loft_mesh', 'sb_lathe_mesh', 'sb_add_mesh',
        'sb_add_modifier', 'sb_apply_modifier', 'sb_remove_modifier', 'sb_decimate_mesh_qem', 'sb_unwrap_mesh_uvs',
        'sb_build_mesh_bvh', 'sb_simulate_rigidbody_physics', 'sb_add_light', 'sb_compose_scene_hierarchy'
    ];
    for (const opName of removedOperators) {
        assert.strictEqual(engine.getOperator(opName), undefined, `Removed operator ${opName} must not be registered`);
        const res = engine.dispatch(opName, {});
        assert.strictEqual(res.success, false);
        assert.ok(/Unknown operator/.test(res.error || ''), `${opName} dispatch must fail as unknown`);
    }

    console.log(`  ✓ Test 1 Passed: ${categories.length} categories and ${requiredOperators.length} operators registered; removed operators absent.`);

    // =========================================================================
    // Test 2: In-Memory Zero-String-Parsing Direct Dispatch & Throughput Benchmark
    // =========================================================================
    console.log('  Testing Zero-String-Parsing Direct Dispatch Throughput...');
    const initialScene: Scene3DData = {
        title: 'Benchmark Spatial Scene',
        renderMode: 'pbr',
        customMeshes: [
            {
                id: 'mesh-cube-1',
                name: 'Benchmark Cube',
                type: 'box',
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                material: { color: 0x3388ff, roughness: 0.4, metalness: 0.2 }
            }
        ]
    };

    engine.loadScene(initialScene);

    const startTime = process.hrtime.bigint();
    const ITERATIONS = 10000;

    for (let i = 0; i < ITERATIONS; i++) {
        // Direct dispatch passing in-memory typed parameters without JSON string serialization/regex/eval overhead
        const result = engine.dispatch('sb_translate', {
            objectId: 'mesh-cube-1',
            delta: [0.001, 0.001, 0],
            recordHistory: false
        });
        assert.strictEqual(result.success, true);
    }

    const endTime = process.hrtime.bigint();
    const elapsedMs = Number(endTime - startTime) / 1000000;
    const opsPerSec = Math.round((ITERATIONS / elapsedMs) * 1000);

    console.log(`    → Dispatched ${ITERATIONS} in-memory operators in ${elapsedMs.toFixed(2)}ms (${opsPerSec.toLocaleString()} ops/sec)`);
    // Generous bound: the intent is "in-memory dispatch is fast", but this suite runs in parallel with
    // dozens of other vitest workers so wall-clock time is noisy under load.
    assert.ok(elapsedMs < 1500, `Direct dispatch of 10k ops must be <1500ms (got ${elapsedMs.toFixed(2)}ms)`);

    const finalCube = engine.getSceneData().customMeshes?.find(m => m.id === 'mesh-cube-1');
    assert.ok(finalCube);
    assert.ok(Math.abs((finalCube.position?.[0] || 0) - 10.0) < 0.001, 'Cube position X must be ~10.0');

    console.log('  ✓ Test 2 Passed: Direct-dispatch operates with zero string parsing overhead.');

    // =========================================================================
    // Test 3: Inspect Operators (list, inspect object, inspect scene, mesh stats)
    // =========================================================================
    console.log('  Testing Inspect Category Operators...');
    const sampleScene: Scene3DData = {
        title: 'Cyberpunk Drone Lab',
        renderMode: 'pbr',
        camera: { position: [10, 10, 10], target: [0, 0, 0], fov: 60 },
        environment: { skybox: 'cyberpunk-neon', lighting: 'dramatic', ground: true },
        objects: [
            {
                id: 'obj-drone-body',
                content: {
                    type: '3d-model',
                    durableUri: 'internal:drone-core',
                    mimeType: 'model/gltf-binary',
                    metadata: { dims: { width: 4, height: 1.5, depth: 4 } }
                },
                space: { spatial3d: { x: 0, y: 5, z: 0, pitch: 0, yaw: 45, roll: 0 } },
                time: { startMs: 0, durationMs: 5000 },
                lineage: { version: 1 }
            }
        ],
        customMeshes: [
            {
                id: 'mesh-generator',
                name: 'Fusion Generator',
                type: 'cylinder',
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [2, 6, 2],
                material: { color: 0x00ffff, roughness: 0.1, metalness: 0.9 }
            },
            {
                id: 'mesh-platform',
                name: 'Landing Pad',
                type: 'box',
                position: [0, -0.5, 0],
                rotation: [0, 0, 0],
                scale: [20, 1, 20],
                material: { color: 0x222222, roughness: 0.8, metalness: 0.5 }
            }
        ]
    };

    engine.loadScene(sampleScene);

    // 1. sb_list_objects
    const listRes = engine.dispatch('sb_list_objects', {});
    assert.strictEqual(listRes.success, true);
    assert.strictEqual(listRes.data.objects.length, 3); // 1 Media4DObject + 2 customMeshes

    // Filter by type
    const filterRes = engine.dispatch('sb_list_objects', { type: 'cylinder' });
    assert.strictEqual(filterRes.success, true);
    assert.strictEqual(filterRes.data.objects.length, 1);
    assert.strictEqual(filterRes.data.objects[0].id, 'mesh-generator');

    // 2. sb_inspect_object
    const inspectRes = engine.dispatch('sb_inspect_object', { objectId: 'mesh-generator' });
    assert.strictEqual(inspectRes.success, true);
    assert.strictEqual(inspectRes.data.name, 'Fusion Generator');
    assert.strictEqual(inspectRes.data.type, 'cylinder');
    assert.deepStrictEqual(inspectRes.data.position, [0, 0, 0]);
    assert.deepStrictEqual(inspectRes.data.scale, [2, 6, 2]);
    assert.strictEqual(inspectRes.data.material.color, 0x00ffff);

    // 3. sb_inspect_scene
    const sceneInspectRes = engine.dispatch('sb_inspect_scene', {});
    assert.strictEqual(sceneInspectRes.success, true);
    assert.strictEqual(sceneInspectRes.data.title, 'Cyberpunk Drone Lab');
    assert.strictEqual(sceneInspectRes.data.totalObjects, 3);
    assert.strictEqual(sceneInspectRes.data.renderMode, 'pbr');
    assert.deepStrictEqual(sceneInspectRes.data.camera.position, [10, 10, 10]);

    // 4. sb_get_mesh_stats measures the live viewport mesh; with no viewport attached it cannot run here.
    const noLiveStats = engine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-platform' });
    assert.strictEqual(noLiveStats.success, false);
    assert.strictEqual(noLiveStats.errorCode, 'not_available_here');

    const statsEngine = createOperatorEngine();
    statsEngine.loadScene(sampleScene);
    const statsScene = new THREE.Scene();
    const platformMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    platformMesh.name = 'mesh-platform';
    platformMesh.scale.set(20, 1, 20);
    const sheetMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
    sheetMesh.name = 'mesh-sheet';
    const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial());
    ballMesh.name = 'mesh-ball';
    statsScene.add(platformMesh, sheetMesh, ballMesh);
    statsEngine.attachThreeScene(statsScene);

    const statsRes = statsEngine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-platform' });
    assert.strictEqual(statsRes.success, true);
    assert.strictEqual(statsRes.data.vertexCount, 24, 'BoxGeometry has 24 vertices (4 per face)');
    assert.strictEqual(statsRes.data.faceCount, 12);
    assert.strictEqual(statsRes.data.edgeCount, 18, 'welded closed box: 3F/2 = 18 edges');
    assert.strictEqual(statsRes.data.boundaryEdgeCount, 0);
    assert.strictEqual(statsRes.data.nonManifoldEdgeCount, 0);
    assert.strictEqual(statsRes.data.isWatertight, true);
    assert.deepStrictEqual(statsRes.data.boundingBox.size, [20, 1, 20]);
    assert.ok(Math.abs(statsRes.data.volume - 400) < 1e-3, `20x1x20 box volume must be 400 (got ${statsRes.data.volume})`);
    assert.ok(Math.abs(statsRes.data.surfaceArea - 880) < 1e-3, `20x1x20 box area must be 880 (got ${statsRes.data.surfaceArea})`);

    const sheetStats = statsEngine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-sheet' });
    assert.strictEqual(sheetStats.success, true);
    assert.strictEqual(sheetStats.data.faceCount, 2);
    assert.strictEqual(sheetStats.data.edgeCount, 5);
    assert.strictEqual(sheetStats.data.boundaryEdgeCount, 4);
    assert.strictEqual(sheetStats.data.isWatertight, false, 'an open plane is not watertight');
    assert.strictEqual(sheetStats.data.volume, null, 'an open surface encloses no volume');
    assert.ok(Math.abs(sheetStats.data.surfaceArea - 4) < 1e-6);

    const ballStats = statsEngine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-ball' });
    assert.strictEqual(ballStats.success, true);
    assert.strictEqual(ballStats.data.isWatertight, true, 'an indexed sphere welds into a closed surface');
    assert.strictEqual(ballStats.data.edgeCount, (3 * ballStats.data.faceCount) / 2);
    assert.ok(ballStats.data.volume > 3.5 && ballStats.data.volume < (4 / 3) * Math.PI, 'inscribed sphere polyhedron volume is just under 4/3 pi');

    console.log('  ✓ Test 3 Passed: Inspect operators return comprehensive scene and mesh metrics.');

    // =========================================================================
    // Test 4: Transform Category Operators (set, translate, rotate, scale, apply, origin)
    // =========================================================================
    console.log('  Testing Transform Category Operators...');
    engine.loadScene({
        title: 'Transform Test',
        customMeshes: [
            {
                id: 'mesh-hero',
                name: 'Hero Asset',
                type: 'box',
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1]
            }
        ]
    });

    // 1. sb_set_transform
    const setTRes = engine.dispatch('sb_set_transform', {
        objectId: 'mesh-hero',
        position: [5, 10, -2],
        rotation: [0, Math.PI / 4, 0],
        scale: [2, 2, 2]
    });
    assert.strictEqual(setTRes.success, true);
    let hero = engine.getObject('mesh-hero');
    assert.deepStrictEqual(hero?.position, [5, 10, -2]);
    assert.deepStrictEqual(hero?.scale, [2, 2, 2]);

    // 2. sb_translate
    engine.dispatch('sb_translate', {
        objectId: 'mesh-hero',
        delta: [1, -2, 4]
    });
    hero = engine.getObject('mesh-hero');
    assert.deepStrictEqual(hero?.position, [6, 8, 2]);

    // 3. sb_rotate
    engine.dispatch('sb_rotate', {
        objectId: 'mesh-hero',
        delta: [0, Math.PI / 4, 0]
    });
    hero = engine.getObject('mesh-hero');
    assert.ok(Math.abs((hero?.rotation?.[1] || 0) - Math.PI / 2) < 0.001);

    // 4. sb_scale
    engine.dispatch('sb_scale', {
        objectId: 'mesh-hero',
        scale: [2, 0.5, 3]
    });
    hero = engine.getObject('mesh-hero');
    assert.deepStrictEqual(hero?.scale, [4, 1, 6]);

    // 5. sb_set_origin moves the pivot of the live viewport mesh; without one it cannot run here.
    const noLiveOrigin = engine.dispatch('sb_set_origin', { objectId: 'mesh-hero', originType: 'bottom' });
    assert.strictEqual(noLiveOrigin.success, false);
    assert.strictEqual(noLiveOrigin.errorCode, 'not_available_here');

    const originEngine = createOperatorEngine({
        title: 'Origin Test',
        customMeshes: [{ id: 'mesh-hero', name: 'Hero Asset', type: 'box', position: [6, 8, 2], rotation: [0, Math.PI / 2, 0], scale: [4, 1, 6] }]
    });
    const originScene = new THREE.Scene();
    const heroMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    heroMesh.name = 'mesh-hero';
    heroMesh.position.set(6, 8, 2);
    heroMesh.rotation.set(0, Math.PI / 2, 0);
    heroMesh.scale.set(4, 1, 6);
    originScene.add(heroMesh);
    originEngine.attachThreeScene(originScene);

    const worldVertices = (mesh: THREE.Mesh): THREE.Vector3[] => {
        mesh.updateMatrixWorld(true);
        const pos = mesh.geometry.getAttribute('position');
        const out: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
        return out;
    };
    const assertSameWorld = (a: THREE.Vector3[], b: THREE.Vector3[]) => {
        assert.strictEqual(a.length, b.length);
        for (let i = 0; i < a.length; i++) assert.ok(a[i].distanceTo(b[i]) < 1e-5, `vertex ${i} moved in world space`);
    };

    const worldBefore = worldVertices(heroMesh);
    const originRes = originEngine.dispatch('sb_set_origin', { objectId: 'mesh-hero', originType: 'bottom' });
    assert.strictEqual(originRes.success, true);
    // Local pivot (0,-1,0), scaled by y=1 and rotated about Y: the object moves down by 1.
    assert.deepStrictEqual(originRes.data.localPivot, [0, -1, 0]);
    assert.ok(Math.abs(heroMesh.position.x - 6) < 1e-9 && Math.abs(heroMesh.position.y - 7) < 1e-9 && Math.abs(heroMesh.position.z - 2) < 1e-9);
    assert.deepStrictEqual(originEngine.getObject('mesh-hero').position, [heroMesh.position.x, heroMesh.position.y, heroMesh.position.z]);
    heroMesh.geometry.computeBoundingBox();
    assert.ok(Math.abs(heroMesh.geometry.boundingBox!.min.y) < 1e-9, 'geometry bottom now sits at the local origin');
    assertSameWorld(worldBefore, worldVertices(heroMesh));

    // Custom pivot (1,0,0): scaled to (4,0,0), rotated +90 deg about Y to (0,0,-4).
    const worldBefore2 = worldVertices(heroMesh);
    const customRes = originEngine.dispatch('sb_set_origin', { objectId: 'mesh-hero', originType: 'custom', customOrigin: [1, 0, 0] });
    assert.strictEqual(customRes.success, true);
    assert.ok(Math.abs(heroMesh.position.x - 6) < 1e-9 && Math.abs(heroMesh.position.y - 7) < 1e-9 && Math.abs(heroMesh.position.z - (-2)) < 1e-9);
    assertSameWorld(worldBefore2, worldVertices(heroMesh));

    const badOrigin = originEngine.dispatch('sb_set_origin', { objectId: 'mesh-hero', originType: 'custom' });
    assert.strictEqual(badOrigin.success, false, 'custom origin without customOrigin must fail');

    console.log('  ✓ Test 4 Passed: Transform operators mutate and bake geometry transforms flawlessly.');

    // =========================================================================
    // Test 5: Mesh Edit Operators on a live viewport mesh (subdivide, smooth, deform)
    // =========================================================================
    console.log('  Testing Mesh Edit Operators...');
    const editSceneData: Scene3DData = {
        title: 'Mesh Edit Workspace',
        customMeshes: [{ id: 'mesh-sculpt-target', name: 'Sculpt Cube', type: 'box', position: [0, 0, 0], scale: [4, 4, 4] }]
    };
    engine.loadScene(editSceneData);
    for (const opName of ['sb_subdivide_mesh', 'sb_smooth_mesh', 'sb_deform_vertices']) {
        const res = engine.dispatch(opName, { objectId: 'mesh-sculpt-target', center: [0, 0.5, 0], radius: 0.6 });
        assert.strictEqual(res.success, false, `${opName} must fail without a live mesh`);
        assert.strictEqual(res.errorCode, 'not_available_here');
    }

    const editEngine = createOperatorEngine(editSceneData);
    const editScene = new THREE.Scene();
    const sculptMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    sculptMesh.name = 'mesh-sculpt-target';
    sculptMesh.scale.set(4, 4, 4);
    editScene.add(sculptMesh);
    editEngine.attachThreeScene(editScene);

    // 1. sb_subdivide_mesh (midpoint): 12 triangles -> 48, shape and volume unchanged
    const subdivRes = editEngine.dispatch('sb_subdivide_mesh', { objectId: 'mesh-sculpt-target', iterations: 1 });
    assert.strictEqual(subdivRes.success, true);
    assert.strictEqual(subdivRes.data.faceCount, 48);
    const postSubdivStats = editEngine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-sculpt-target' });
    assert.strictEqual(postSubdivStats.data.faceCount, 48);
    assert.strictEqual(postSubdivStats.data.vertexCount, subdivRes.data.vertexCount);
    assert.strictEqual(postSubdivStats.data.isWatertight, true);
    assert.deepStrictEqual(postSubdivStats.data.boundingBox.size, [4, 4, 4]);
    assert.ok(Math.abs(postSubdivStats.data.volume - 64) < 1e-3, 'midpoint subdivision keeps the 4x4x4 volume');

    const badIterations = editEngine.dispatch('sb_subdivide_mesh', { objectId: 'mesh-sculpt-target', iterations: 9 });
    assert.strictEqual(badIterations.success, false, 'iterations outside 1-4 must fail');

    // 2. sb_smooth_mesh (Laplacian): a closed cube has no fixed boundary, so it shrinks
    const smoothRes = editEngine.dispatch('sb_smooth_mesh', { objectId: 'mesh-sculpt-target', factor: 0.5, iterations: 2 });
    assert.strictEqual(smoothRes.success, true);
    assert.ok(smoothRes.data.movedVertices > 0);
    assert.ok(smoothRes.data.maxDisplacement > 0);
    const postSmoothStats = editEngine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-sculpt-target' });
    assert.ok(postSmoothStats.data.volume < 64, `smoothing a cube shrinks it (volume ${postSmoothStats.data.volume})`);
    assert.strictEqual(editEngine.dispatch('sb_smooth_mesh', { objectId: 'mesh-sculpt-target', factor: 1.5 }).success, false);

    // 3. sb_deform_vertices: each vertex within the radius moves along +Y by strength * gaussian falloff
    const deformCenter = new THREE.Vector3(0, 0.5, 0);
    const deformRadius = 0.6;
    const deformStrength = 0.2;
    const posAttr = sculptMesh.geometry.getAttribute('position');
    const beforePositions: THREE.Vector3[] = [];
    for (let i = 0; i < posAttr.count; i++) beforePositions.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));
    const expectedAffected = beforePositions.filter(p => p.distanceTo(deformCenter) <= deformRadius).length;
    assert.ok(expectedAffected > 0, 'fixture must have vertices inside the brush');

    const deformRes = editEngine.dispatch('sb_deform_vertices', {
        objectId: 'mesh-sculpt-target',
        center: [0, 0.5, 0],
        radius: deformRadius,
        direction: [0, 1, 0],
        strength: deformStrength,
        falloff: 'gaussian'
    });
    assert.strictEqual(deformRes.success, true);
    assert.strictEqual(deformRes.data.affectedVertices, expectedAffected);
    const afterAttr = sculptMesh.geometry.getAttribute('position');
    for (let i = 0; i < afterAttr.count; i++) {
        const b = beforePositions[i];
        const d = b.distanceTo(deformCenter);
        const lift = d <= deformRadius ? deformStrength * evaluateFalloff(d, deformRadius, 'gaussian') : 0;
        assert.ok(Math.abs(afterAttr.getX(i) - b.x) < 1e-6 && Math.abs(afterAttr.getZ(i) - b.z) < 1e-6, `vertex ${i} must move only along Y`);
        assert.ok(Math.abs(afterAttr.getY(i) - (b.y + lift)) < 1e-6, `vertex ${i} Y must rise by ${lift}`);
    }

    console.log('  ✓ Test 5 Passed: Mesh Edit operators subdivide, smooth and deform real geometry.');

    // =========================================================================
    // Test 6: Unknown objects fail instead of being created
    // =========================================================================
    console.log('  Testing unknown-object failures...');
    engine.loadScene({ title: 'Empty', customMeshes: [] });
    const setUnknown = engine.dispatch('sb_set_transform', { objectId: 'ghost-object', position: [1, 2, 3] });
    assert.strictEqual(setUnknown.success, false, 'sb_set_transform must not create an object for an unknown id');
    assert.strictEqual((engine.getSceneData().customMeshes || []).length, 0);
    console.log('  ✓ Test 6 Passed: transforms on unknown ids fail and add nothing.');

    // =========================================================================
    // Test 7: Materials / PBR Operators (create, set, assign)
    // =========================================================================
    console.log('  Testing Materials & PBR Operators...');
    engine.loadScene({
        title: 'Material Studio',
        customMeshes: [
            {
                id: 'mesh-orb',
                name: 'Crystal Orb',
                type: 'sphere',
                position: [0, 0, 0]
            }
        ]
    });

    // 1. sb_create_material
    const createMatRes = engine.dispatch('sb_create_material', {
        materialId: 'mat-hologram-gold',
        name: 'Holographic Gold PBR',
        color: 0xffd700,
        roughness: 0.15,
        metalness: 0.95,
        transmission: 0.8,
        ior: 1.52,
        emissive: 0x332200,
        clearcoat: 0.9
    });
    assert.strictEqual(createMatRes.success, true);
    assert.strictEqual(createMatRes.data.materialId, 'mat-hologram-gold');

    // 2. sb_assign_material
    const assignRes = engine.dispatch('sb_assign_material', {
        objectId: 'mesh-orb',
        materialId: 'mat-hologram-gold'
    });
    assert.strictEqual(assignRes.success, true);
    let orb = engine.getObject('mesh-orb');
    assert.strictEqual(orb?.material?.color, 0xffd700);
    assert.strictEqual(orb?.material?.roughness, 0.15);
    assert.strictEqual(orb?.material?.metalness, 0.95);

    // 3. sb_set_material_pbr
    const updateMatRes = engine.dispatch('sb_set_material_pbr', {
        materialId: 'mat-hologram-gold',
        roughness: 0.05,
        metalness: 1.0,
        wireframe: false
    });
    assert.strictEqual(updateMatRes.success, true);
    orb = engine.getObject('mesh-orb');
    assert.strictEqual(orb?.material?.roughness, 0.05);
    assert.strictEqual(orb?.material?.metalness, 1.0);

    console.log('  ✓ Test 7 Passed: Materials and PBR direct configuration operational.');

    // =========================================================================
    // Test 8: Lighting & Camera Operators (setup lighting, set camera, frame bounds)
    // =========================================================================
    console.log('  Testing Lighting & Camera Operators...');
    engine.loadScene({
        title: 'Cinematic Staging',
        customMeshes: [
            {
                id: 'mesh-statue',
                name: 'Central Monument',
                type: 'box',
                position: [10, 5, 20],
                scale: [4, 10, 4]
            }
        ]
    });

    // 1. sb_setup_lighting (presets or custom rigs)
    const lightRes = engine.dispatch('sb_setup_lighting', {
        preset: 'three-point',
        ambientIntensity: 0.4,
        keyLight: { color: 0xffffff, intensity: 1.2, position: [15, 20, 15] },
        fillLight: { color: 0x88bbff, intensity: 0.6, position: [-15, 10, 10] },
        rimLight: { color: 0xff8844, intensity: 0.9, position: [0, 15, -20] }
    });
    assert.strictEqual(lightRes.success, true);
    const sceneDataLight = engine.getSceneData();
    assert.strictEqual(sceneDataLight.environment?.lighting, 'three-point');
    assert.strictEqual(sceneDataLight.environment?.ambientIntensity, 0.4);

    // 2. sb_set_camera
    const camRes = engine.dispatch('sb_set_camera', {
        position: [25, 15, 30],
        target: [10, 5, 20],
        fov: 45,
        cameraMode: 'orbit'
    });
    assert.strictEqual(camRes.success, true);
    const sceneDataCam = engine.getSceneData();
    assert.deepStrictEqual(sceneDataCam.camera?.position, [25, 15, 30]);
    assert.deepStrictEqual(sceneDataCam.camera?.target, [10, 5, 20]);
    assert.strictEqual(sceneDataCam.camera?.fov, 45);

    // 3. sb_frame_bounds from scene data: a unit box (half 0.5) scaled [4,10,4] at [10,5,20]
    const frameRes = engine.dispatch('sb_frame_bounds', {
        targetId: 'mesh-statue',
        paddingFactor: 1.5
    });
    assert.strictEqual(frameRes.success, true);
    assert.deepStrictEqual(frameRes.data.cameraTarget, [10, 5, 20]);
    assert.deepStrictEqual(frameRes.data.boundingBox.size, [4, 10, 4]);
    // maxDim 10 * padding 1.5 = 15 -> offsets (13.5, 10.5, 13.5)
    assert.deepStrictEqual(frameRes.data.cameraPosition, [23.5, 15.5, 33.5]);
    assert.deepStrictEqual(engine.getSceneData().camera?.position, [23.5, 15.5, 33.5]);

    // With a live viewport the real geometry bounds are used.
    const frameEngine = createOperatorEngine({ title: 'Frame Live' });
    const frameScene = new THREE.Scene();
    const statueMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 10, 4), new THREE.MeshStandardMaterial());
    statueMesh.name = 'mesh-statue';
    statueMesh.position.set(10, 5, 20);
    frameScene.add(statueMesh);
    frameEngine.attachThreeScene(frameScene);
    const liveFrame = frameEngine.dispatch('sb_frame_bounds', { targetId: 'mesh-statue', paddingFactor: 1.5 });
    assert.strictEqual(liveFrame.success, true);
    assert.deepStrictEqual(liveFrame.data.cameraTarget, [10, 5, 20]);
    assert.deepStrictEqual(liveFrame.data.cameraPosition, [23.5, 15.5, 33.5]);

    // No customMeshes and no live viewport: nothing to measure here.
    const emptyFrame = createOperatorEngine({ title: 'Nothing' }).dispatch('sb_frame_bounds', {});
    assert.strictEqual(emptyFrame.success, false);
    assert.strictEqual(emptyFrame.errorCode, 'not_available_here');

    console.log('  ✓ Test 8 Passed: Lighting rigs and camera framing compute correctly.');

    // =========================================================================
    // Test 9: Physics & Animation Operators (add physics, insert keyframe)
    // =========================================================================
    console.log('  Testing Physics & Animation Operators...');
    engine.loadScene({
        title: 'Physics & Anim Playground',
        customMeshes: [
            {
                id: 'mesh-bouncing-ball',
                name: 'Physics Sphere',
                type: 'sphere',
                position: [0, 20, 0]
            }
        ]
    });

    // 1. sb_add_physics
    const physRes = engine.dispatch('sb_add_physics', {
        objectId: 'mesh-bouncing-ball',
        bodyType: 'dynamic',
        mass: 2.5,
        friction: 0.3,
        restitution: 0.85,
        colliderShape: 'sphere'
    });
    assert.strictEqual(physRes.success, true);
    const ballObj = engine.getObject('mesh-bouncing-ball');
    assert.strictEqual((ballObj as any).physics?.bodyType, 'dynamic');
    assert.strictEqual((ballObj as any).physics?.restitution, 0.85);

    // 2. sb_insert_keyframe
    const kf1 = engine.dispatch('sb_insert_keyframe', {
        objectId: 'mesh-bouncing-ball',
        property: 'position',
        timeMs: 0,
        value: [0, 20, 0],
        easing: 'linear'
    });
    assert.strictEqual(kf1.success, true);

    const kf2 = engine.dispatch('sb_insert_keyframe', {
        objectId: 'mesh-bouncing-ball',
        property: 'position',
        timeMs: 1000,
        value: [0, 0, 0],
        easing: 'bounce'
    });
    assert.strictEqual(kf2.success, true);

    const ballWithKeyframes = engine.getObject('mesh-bouncing-ball');
    assert.strictEqual((ballWithKeyframes as any).keyframes?.length, 2);

    console.log('  ✓ Test 9 Passed: Physics properties and timeline keyframes attached cleanly.');

    // =========================================================================
    // Test 10: State History & Undo / Redo / Reset Scene Operators
    // =========================================================================
    console.log('  Testing State History & Undo / Redo / Reset Operators...');
    engine.loadScene({
        title: 'Undo Test Scene',
        customMeshes: [
            {
                id: 'mesh-box-undo',
                position: [0, 0, 0],
                scale: [1, 1, 1]
            }
        ]
    });

    // Mutation 1: Translate
    engine.dispatch('sb_translate', { objectId: 'mesh-box-undo', delta: [10, 0, 0] });
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.position, [10, 0, 0]);

    // Mutation 2: Scale
    engine.dispatch('sb_scale', { objectId: 'mesh-box-undo', scale: [3, 3, 3] });
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.scale, [3, 3, 3]);

    // Undo Mutation 2
    const undo1 = engine.dispatch('sb_undo', {});
    assert.strictEqual(undo1.success, true);
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.scale, [1, 1, 1]);
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.position, [10, 0, 0]);

    // Undo Mutation 1
    const undo2 = engine.dispatch('sb_undo', {});
    assert.strictEqual(undo2.success, true);
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.position, [0, 0, 0]);

    // Redo Mutation 1
    const redo1 = engine.dispatch('sb_redo', {});
    assert.strictEqual(redo1.success, true);
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.position, [10, 0, 0]);

    // Redo Mutation 2
    const redo2 = engine.dispatch('sb_redo', {});
    assert.strictEqual(redo2.success, true);
    assert.deepStrictEqual(engine.getObject('mesh-box-undo')?.scale, [3, 3, 3]);

    // sb_reset_scene
    const resetRes = engine.dispatch('sb_reset_scene', {
        title: 'Fresh Reset Scene'
    });
    assert.strictEqual(resetRes.success, true);
    assert.strictEqual(engine.getSceneData().title, 'Fresh Reset Scene');
    assert.strictEqual((engine.getSceneData().customMeshes || []).length, 0);

    console.log('  ✓ Test 10 Passed: Lossless undo/redo timeline state preservation.');

    // =========================================================================
    // Test 11: Batch Execution & Transactional Atomic Rollback
    // =========================================================================
    console.log('  Testing Batch Execution & Transactional Atomic Rollback...');
    engine.loadScene({
        title: 'Batch Scene',
        customMeshes: [
            {
                id: 'mesh-batch-item',
                position: [0, 0, 0],
                scale: [1, 1, 1]
            }
        ]
    });

    // Successful batch
    const batchRes = engine.executeBatch([
        { operator: 'sb_translate', params: { objectId: 'mesh-batch-item', delta: [5, 0, 0] } },
        { operator: 'sb_scale', params: { objectId: 'mesh-batch-item', scale: [2, 2, 2] } },
        { operator: 'sb_create_material', params: { materialId: 'mat-batch', color: 0xff00ff } },
        { operator: 'sb_assign_material', params: { objectId: 'mesh-batch-item', materialId: 'mat-batch' } }
    ]);

    assert.strictEqual(batchRes.success, true);
    assert.strictEqual(batchRes.results.length, 4);
    assert.deepStrictEqual(engine.getObject('mesh-batch-item')?.position, [5, 0, 0]);
    assert.deepStrictEqual(engine.getObject('mesh-batch-item')?.scale, [2, 2, 2]);

    // Failing batch with atomic: true (must roll back all operations)
    const failedBatchRes = engine.executeBatch([
        { operator: 'sb_translate', params: { objectId: 'mesh-batch-item', delta: [100, 0, 0] } },
        { operator: 'sb_translate', params: { objectId: 'non-existent-mesh-id-xyz', delta: [5, 5, 5] } }
    ], { atomic: true });

    assert.strictEqual(failedBatchRes.success, false);
    // Verified rollback: position remains [5, 0, 0], not [105, 0, 0]
    assert.deepStrictEqual(engine.getObject('mesh-batch-item')?.position, [5, 0, 0]);

    console.log('  ✓ Test 11 Passed: Batch execution and atomic transactional rollback verified.');

    // =========================================================================
    // Test 12: Dual Representation Synchronization (Scene3DData <-> Live THREE.Scene)
    // =========================================================================
    console.log('  Testing Dual Representation Synchronization with Live Three.js...');
    const liveThreeScene = new THREE.Scene();
    const liveThreeMesh = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({ color: 0x44aa88 })
    );
    liveThreeMesh.name = 'mesh-live-sync';
    liveThreeScene.add(liveThreeMesh);

    engine.attachThreeScene(liveThreeScene);

    // Dispatch transform on live scene
    engine.dispatch('sb_translate', {
        objectId: 'mesh-live-sync',
        delta: [3, 7, -5]
    });

    // Verify live Three.js mesh was translated directly in memory
    assert.strictEqual(liveThreeMesh.position.x, 3);
    assert.strictEqual(liveThreeMesh.position.y, 7);
    assert.strictEqual(liveThreeMesh.position.z, -5);

    // Verify Scene3DData is in sync
    const syncedObj = engine.getObject('mesh-live-sync');
    assert.deepStrictEqual(syncedObj?.position, [3, 7, -5]);

    console.log('  ✓ Test 12 Passed: In-memory live Three.js scene and Scene3DData maintain bidirectional sync.');

    console.log('\n🎉 ALL 12 DIRECT-DISPATCH 3D OPERATOR ENGINE TESTS COMPLETED SUCCESSFULLY!');
}

test('direct-dispatch-operator-engine.test', async () => {
    await runDirectDispatchOperatorEngineTests();
}, 180_000);
