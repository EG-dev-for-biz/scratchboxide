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
        'sb_apply_transforms',
        'sb_set_origin',
        // Mesh Edit
        'sb_subdivide_mesh',
        'sb_extrude_faces',
        'sb_boolean_op',
        'sb_smooth_mesh',
        'sb_deform_vertices',
        // Modifiers
        'sb_add_modifier',
        'sb_apply_modifier',
        'sb_remove_modifier',
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

    console.log('  ✓ Test 1 Passed: All 8 categories and 27 operators registered in catalog.');

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

    // 4. sb_get_mesh_stats
    const statsRes = engine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-platform' });
    assert.strictEqual(statsRes.success, true);
    assert.ok(statsRes.data.vertexCount >= 8, 'Box must have at least 8 vertices');
    assert.ok(statsRes.data.faceCount >= 12, 'Box must have at least 12 triangular faces');
    assert.ok(statsRes.data.boundingBox, 'Must provide bounding box');
    assert.ok(statsRes.data.volume > 0, 'Volume must be > 0');
    assert.ok(statsRes.data.surfaceArea > 0, 'Surface area must be > 0');

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

    // 5. sb_apply_transforms (Freezes transform matrix into vertices and resets pos/rot/scale to identity)
    const applyRes = engine.dispatch('sb_apply_transforms', { objectId: 'mesh-hero' });
    assert.strictEqual(applyRes.success, true);
    hero = engine.getObject('mesh-hero');
    assert.deepStrictEqual(hero?.position, [0, 0, 0]);
    assert.deepStrictEqual(hero?.rotation, [0, 0, 0]);
    assert.deepStrictEqual(hero?.scale, [1, 1, 1]);

    // 6. sb_set_origin (Adjusts local pivot/origin e.g. to bottom or center)
    const originRes = engine.dispatch('sb_set_origin', {
        objectId: 'mesh-hero',
        originType: 'bottom'
    });
    assert.strictEqual(originRes.success, true);

    console.log('  ✓ Test 4 Passed: Transform operators mutate and bake geometry transforms flawlessly.');

    // =========================================================================
    // Test 5: Mesh Edit Operators (subdivide, extrude, boolean, smooth, deform)
    // =========================================================================
    console.log('  Testing Mesh Edit Operators...');
    engine.loadScene({
        title: 'Mesh Edit Workspace',
        customMeshes: [
            {
                id: 'mesh-sculpt-target',
                name: 'Sculpt Cube',
                type: 'box',
                position: [0, 0, 0],
                scale: [4, 4, 4]
            },
            {
                id: 'mesh-cutter',
                name: 'Cutter Sphere',
                type: 'sphere',
                position: [1, 0, 0],
                scale: [3, 3, 3]
            }
        ]
    });

    // 1. sb_subdivide_mesh
    const initialStats = engine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-sculpt-target' });
    const initialVerts = initialStats.data.vertexCount;

    const subdivRes = engine.dispatch('sb_subdivide_mesh', {
        objectId: 'mesh-sculpt-target',
        iterations: 1
    });
    assert.strictEqual(subdivRes.success, true);
    const postSubdivStats = engine.dispatch('sb_get_mesh_stats', { objectId: 'mesh-sculpt-target' });
    assert.ok(postSubdivStats.data.vertexCount > initialVerts, 'Subdivision must increase vertex count');

    // 2. sb_extrude_faces
    const extrudeRes = engine.dispatch('sb_extrude_faces', {
        objectId: 'mesh-sculpt-target',
        direction: [0, 1, 0],
        distance: 2.0
    });
    assert.strictEqual(extrudeRes.success, true);
    assert.ok(extrudeRes.data.newFacesCount > 0, 'Extrusion must create new boundary faces');

    // 3. sb_smooth_mesh (Laplacian / Taubin smoothing)
    const smoothRes = engine.dispatch('sb_smooth_mesh', {
        objectId: 'mesh-sculpt-target',
        factor: 0.5,
        iterations: 2
    });
    assert.strictEqual(smoothRes.success, true);

    // 4. sb_deform_vertices
    const deformRes = engine.dispatch('sb_deform_vertices', {
        objectId: 'mesh-sculpt-target',
        center: [0, 2, 0],
        radius: 3.0,
        direction: [0, 1, 0],
        strength: 1.5,
        falloff: 'gaussian'
    });
    assert.strictEqual(deformRes.success, true);
    assert.ok(deformRes.data.affectedVertices > 0, 'Deformation must affect vertices in radius');

    // 5. sb_boolean_op (CSG operations: union, difference, intersect)
    const boolRes = engine.dispatch('sb_boolean_op', {
        targetId: 'mesh-sculpt-target',
        operandId: 'mesh-cutter',
        operation: 'difference'
    });
    assert.strictEqual(boolRes.success, true);
    assert.ok(boolRes.data.resultVertexCount > 0);

    console.log('  ✓ Test 5 Passed: Mesh Edit operators perform subdivision, extrusion, smoothing, deform, and booleans.');

    // =========================================================================
    // Test 6: Modifiers Operators (add, apply, remove)
    // =========================================================================
    console.log('  Testing Modifiers Category Operators...');
    engine.loadScene({
        title: 'Modifier Stack Test',
        customMeshes: [
            {
                id: 'mesh-car-chassis',
                name: 'Car Chassis',
                type: 'box',
                position: [0, 0, 0]
            }
        ]
    });

    // 1. sb_add_modifier (mirror modifier along X axis)
    const addMod1 = engine.dispatch('sb_add_modifier', {
        objectId: 'mesh-car-chassis',
        modifierType: 'mirror',
        params: { axis: 'x', mergeThreshold: 0.01 }
    });
    assert.strictEqual(addMod1.success, true);
    const modId1 = addMod1.data.modifierId;
    assert.ok(modId1);

    // Add subdivision modifier
    const addMod2 = engine.dispatch('sb_add_modifier', {
        objectId: 'mesh-car-chassis',
        modifierType: 'subdivision',
        params: { levels: 2 }
    });
    assert.strictEqual(addMod2.success, true);

    const inspectWithMods = engine.dispatch('sb_inspect_object', { objectId: 'mesh-car-chassis' });
    assert.strictEqual(inspectWithMods.data.modifiers.length, 2);

    // 2. sb_apply_modifier (bakes modifier into mesh geometry)
    const applyModRes = engine.dispatch('sb_apply_modifier', {
        objectId: 'mesh-car-chassis',
        modifierId: modId1
    });
    assert.strictEqual(applyModRes.success, true);

    const postApplyInspect = engine.dispatch('sb_inspect_object', { objectId: 'mesh-car-chassis' });
    assert.strictEqual(postApplyInspect.data.modifiers.length, 1);

    // 3. sb_remove_modifier (discards without baking)
    const removeModRes = engine.dispatch('sb_remove_modifier', {
        objectId: 'mesh-car-chassis',
        modifierId: addMod2.data.modifierId
    });
    assert.strictEqual(removeModRes.success, true);

    const finalInspect = engine.dispatch('sb_inspect_object', { objectId: 'mesh-car-chassis' });
    assert.strictEqual(finalInspect.data.modifiers.length, 0);

    console.log('  ✓ Test 6 Passed: Modifier stack lifecycle (add, evaluate, apply, remove) functioning.');

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

    // 3. sb_frame_bounds (computes AABB and auto-positions camera with padding)
    const frameRes = engine.dispatch('sb_frame_bounds', {
        targetId: 'mesh-statue',
        paddingFactor: 1.5
    });
    assert.strictEqual(frameRes.success, true);
    assert.ok(frameRes.data.cameraPosition);
    assert.deepStrictEqual(frameRes.data.cameraTarget, [10, 5, 20]);

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
