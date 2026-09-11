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
import {
    createOperatorEngine,
    DirectDispatchOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    Scene3DWorldLens
} from '../src/browser/generative-canvas/lenses/Scene3DWorldLens';
import {
    GeminiService
} from '../src/node/gemini-service';
import {
    createSculptableGeometry,
    applySculptStroke,
    MeshHistoryStack,
    SculptSettings
} from '../src/browser/generative-canvas/services/mesh-sculpting-engine';
import {
    CLAY_PRESETS,
    ClayPresetId,
    TileClayProcessor
} from '../src/browser/generative-canvas/services/TileClayProcessor';
import type {
    Scene3DData,
    CanvasArtifact,
    CanvasSession
} from '../src/browser/generative-canvas/canvas-types';

async function runInMemory3DSceneEditPersistenceTests() {
    console.log('🚀 Running In-Memory 3D Scene Edit Persistence Test Suite...\n');

    // =========================================================================
    // Test 1: Live In-Memory Object Transforms (Translate, Rotate, Scale) & Operator Logging
    // =========================================================================
    console.log('  1. Testing In-Memory Transform Mutations & Operator/Action Logging...');
    const initialScene: Scene3DData = {
        title: 'Architectural Campus Workspace',
        renderMode: 'pbr',
        camera: { position: [20, 15, 20], target: [0, 0, 0] },
        environment: { skybox: 'cyberpunk', lighting: 'daylight', ground: true },
        customMeshes: [
            {
                id: 'building-alpha',
                name: 'Alpha Tower',
                type: 'box',
                position: [0, 5, 0],
                rotation: [0, 0, 0],
                scale: [4, 10, 4],
                material: { color: 0x38bdf8, roughness: 0.3, metalness: 0.8 }
            },
            {
                id: 'building-beta',
                name: 'Beta Pavilion',
                type: 'box',
                position: [12, 3, -6],
                rotation: [0, Math.PI / 4, 0],
                scale: [6, 6, 6],
                material: { color: 0xf59e0b, roughness: 0.5, metalness: 0.2 }
            }
        ],
        operatorStack: [],
        actionLog: []
    };

    const engine = createOperatorEngine(initialScene);

    // 1a. User drags gizmo to translate Alpha Tower
    const translateResult = engine.dispatch('sb_translate', {
        objectId: 'building-alpha',
        delta: [5, 2, -3]
    });
    assert.strictEqual(translateResult.success, true, 'Translation dispatch must succeed');

    const sceneAfterTranslate = engine.getSceneData();
    const alphaMesh = sceneAfterTranslate.customMeshes?.find(m => m.id === 'building-alpha');
    assert.ok(alphaMesh, 'Alpha Tower must exist in customMeshes');
    assert.deepStrictEqual(alphaMesh.position, [5, 7, -3], 'Alpha Tower position must be updated in-memory');

    // 1b. User scales Beta Pavilion
    const scaleResult = engine.dispatch('sb_scale', {
        objectId: 'building-beta',
        factor: [1.5, 2.0, 1.5]
    });
    assert.strictEqual(scaleResult.success, true, 'Scale dispatch must succeed');

    const sceneAfterScale = engine.getSceneData();
    const betaMesh = sceneAfterScale.customMeshes?.find(m => m.id === 'building-beta');
    assert.ok(betaMesh, 'Beta Pavilion must exist');
    assert.deepStrictEqual(betaMesh.scale, [9, 12, 9], 'Beta Pavilion scale must be updated in-memory');

    // 1c. Verify operatorStack and actionLog are recorded in-memory
    assert.ok(sceneAfterScale.operatorStack && sceneAfterScale.operatorStack.length >= 2, 'operatorStack must record edits');
    assert.ok(sceneAfterScale.actionLog && sceneAfterScale.actionLog.length >= 2, 'actionLog must record execution telemetry');
    assert.strictEqual(sceneAfterScale.operatorStack[0].operator, 'sb_translate');
    assert.strictEqual(sceneAfterScale.operatorStack[1].operator, 'sb_scale');
    assert.strictEqual(sceneAfterScale.actionLog[0].success, true);
    assert.ok(sceneAfterScale.actionLog[0].executionTimeMs !== undefined);
    console.log('    ✓ In-memory transform mutations & telemetry logs verified.');

    // =========================================================================
    // Test 2: In-Memory Mesh Vertex Sculpting & Deformations
    // =========================================================================
    console.log('  2. Testing In-Memory Mesh Vertex Sculpting Mutations...');
    const sculptGeo = createSculptableGeometry('sphere', { radius: 4, segments: 32 });
    const posAttr = sculptGeo.getAttribute('position') as THREE.BufferAttribute;
    const initialVertexY = posAttr.getY(0);

    const strokePoint = new THREE.Vector3(0, 4, 0);
    const strokeNormal = new THREE.Vector3(0, 1, 0);
    const sculptSettings: SculptSettings = {
        brush: 'draw',
        falloff: 'gaussian',
        radius: 2.5,
        strength: 0.8,
        symmetry: { x: false, y: false, z: false },
        wireframeOverlay: false,
        clayOffset: 0.5
    };

    applySculptStroke(sculptGeo, strokePoint, strokeNormal, sculptSettings);
    const newVertexY = posAttr.getY(0);
    assert.notStrictEqual(initialVertexY, newVertexY, 'Vertex Y position must be mutated in memory');

    // Record sculpt operator in engine
    const sculptDispatch = engine.dispatch('sb_deform_vertices', {
        objectId: 'building-alpha',
        deformMode: 'draw',
        strokePoint: [0, 4, 0],
        verticesAffected: 24,
        maxDisplacement: 0.8
    });
    assert.strictEqual(sculptDispatch.success, true);
    assert.ok(engine.getSceneData().operatorStack?.some(op => op.operator === 'sb_deform_vertices'));
    console.log('    ✓ Mesh sculpting vertex deformations verified.');

    // =========================================================================
    // Test 3: Materials, Clay Presets, and Atmosphere / Lighting Mutations
    // =========================================================================
    console.log('  3. Testing In-Memory Materials, Clay Presets & Atmosphere Mutations...');
    // 3a. Clay preset mutation
    const clayPreset: ClayPresetId = 'terracotta';
    const clayResult = engine.dispatch('sb_set_clay_mode', {
        preset: clayPreset,
        roughness: CLAY_PRESETS[clayPreset].roughness,
        metalness: CLAY_PRESETS[clayPreset].metalness
    });
    assert.strictEqual(clayResult.success, true);
    const sceneAfterClay = engine.getSceneData();
    assert.strictEqual(sceneAfterClay.customMeshes![0].material?.shaderKey, 'terracotta');

    // 3b. Atmospheric / Lighting mutation
    const lightingResult = engine.dispatch('sb_setup_lighting', {
        preset: 'golden_hour',
        sunElevation: 12,
        sunAzimuth: 245,
        atmosphericScattering: true,
        godRays: true
    });
    assert.strictEqual(lightingResult.success, true);
    const sceneAfterLighting = engine.getSceneData();
    assert.strictEqual(sceneAfterLighting.environment?.lightingPreset, 'golden_hour');
    assert.strictEqual(sceneAfterLighting.environment?.sunElevation, 12);
    assert.strictEqual(sceneAfterLighting.features?.godRays, true);
    console.log('    ✓ Materials, clay presets, and atmospheric lighting mutations verified.');

    // =========================================================================
    // Test 4: Dynamic Object Spawning (Adding Buildings / Geometries Incrementally)
    // =========================================================================
    console.log('  4. Testing Incremental Object Spawning & Operators...');
    const addMeshResult = engine.dispatch('sb_set_transform', {
        objectId: 'building-gamma',
        name: 'Gamma Observatory',
        type: 'cylinder',
        position: [20, 8, 10],
        rotation: [0, 0, 0],
        scale: [5, 16, 5]
    });
    assert.strictEqual(addMeshResult.success, true);
    const sceneAfterAdd = engine.getSceneData();
    assert.strictEqual(sceneAfterAdd.customMeshes?.length, 3);
    const gammaMesh = sceneAfterAdd.customMeshes?.find(m => m.id === 'building-gamma');
    assert.ok(gammaMesh);
    assert.strictEqual(gammaMesh.name, 'Gamma Observatory');
    assert.deepStrictEqual(gammaMesh.position, [20, 8, 10]);
    console.log('    ✓ Incremental object addition operator verified.');

    // =========================================================================
    // Test 5: Lens Unprojection & Reprojection State Retention
    // =========================================================================
    console.log('  5. Testing Scene3DWorldLens Unprojection & Reprojection...');
    const lens = new Scene3DWorldLens();
    const activeEditedScene = engine.getSceneData();
    const unproj = lens.unproject(activeEditedScene, 'campus.scene.json');

    assert.ok(unproj.files['campus.scene.json'], 'Unprojector must emit primary scene file');
    const parsedFile = JSON.parse(unproj.files['campus.scene.json']);
    assert.strictEqual(parsedFile.customMeshes.length, 3, 'All 3 custom meshes must be serialized to disk JSON');
    assert.deepStrictEqual(parsedFile.customMeshes.find((m: any) => m.id === 'building-alpha').position, [5, 7, -3]);
    assert.strictEqual(parsedFile.environment.lightingPreset, 'golden_hour');
    assert.ok(parsedFile.operatorStack.length >= 4, 'Operator stack must persist in unprojected JSON');

    // Reproject back from JSON
    const reproj = lens.project(unproj.files);
    assert.strictEqual(reproj.data.customMeshes?.length, 3);
    assert.deepStrictEqual(reproj.data.customMeshes?.find(m => m.id === 'building-alpha')?.position, [5, 7, -3]);
    assert.strictEqual(reproj.data.environment?.lightingPreset, 'golden_hour');
    console.log('    ✓ Scene3DWorldLens bidirectional unproject/project verified.');

    // =========================================================================
    // Test 6: Conversational AI Context Extraction for User Edits
    // =========================================================================
    console.log('  6. Testing Conversational AI Context Retention for User Edits...');
    const geminiService = new GeminiService();
    const activeArtifact: CanvasArtifact = {
        id: 'art-3d-campus-01',
        title: 'Architectural Campus Workspace',
        type: '3d-scene',
        summary: 'Interactive 3D campus layout with custom buildings and lighting.',
        version: 3,
        data: activeEditedScene
    };

    const aiContents = (geminiService as any).formatContents({
        prompt: 'now add another building next to it and make the lights dimmer',
        activeArtifact,
        chatHistory: [
            { role: 'user', text: 'create a campus with 2 buildings' },
            { role: 'model', text: 'I have generated the 3D campus workspace.' }
        ]
    });

    assert.ok(aiContents.length >= 2, 'AI contents must include conversation history + user prompt');
    const lastUserPrompt = aiContents[aiContents.length - 1].parts[0].text;
    
    // Verify AI prompt contains the in-memory mutated scene context
    assert.ok(lastUserPrompt.includes('Active 3D Scene In-Memory State') || lastUserPrompt.includes('building-alpha'), 'Prompt must embed 3D scene state');
    assert.ok(lastUserPrompt.includes('Alpha Tower') || lastUserPrompt.includes('building-alpha'), 'Prompt must list active custom meshes');
    assert.ok(lastUserPrompt.includes('golden_hour') || lastUserPrompt.includes('lightingPreset') || lastUserPrompt.includes('environment'), 'Prompt must retain environment lighting');
    console.log('    ✓ AI Prompt Compiler retained in-memory 3D scene mutations.');

    // Test follow-up incremental reasoning
    const followUpPlan = geminiService.generate3DPlanDAG('now add another building next to it', activeEditedScene);
    assert.ok(followUpPlan, 'DAG planner must produce a plan from active scene');
    assert.ok(followUpPlan.stages.length >= 1);
    console.log('    ✓ Follow-up AI planning over in-memory scene verified.');

    // =========================================================================
    // Test 7: Lossless In-Memory Undo/Redo & Version History
    // =========================================================================
    console.log('  7. Testing Lossless Undo/Redo & Version Navigation...');
    // Initial state -> Translate -> Scale -> Clay -> Lighting -> Add Mesh (index at top)
    const canUndo1 = engine.undo();
    assert.strictEqual(canUndo1, true, 'Engine must undo last step');
    const sceneAfterUndo = engine.getSceneData();
    // Building gamma should not be present after undoing sb_set_transform(building-gamma)
    assert.strictEqual(sceneAfterUndo.customMeshes?.find(m => m.id === 'building-gamma'), undefined, 'Undone mesh must be removed from sceneData');

    const canRedo1 = engine.redo();
    assert.strictEqual(canRedo1, true, 'Engine must redo step');
    const sceneAfterRedo = engine.getSceneData();
    assert.ok(sceneAfterRedo.customMeshes?.find(m => m.id === 'building-gamma'), 'Redone mesh must be restored in sceneData');
    console.log('    ✓ Lossless Undo/Redo timeline state preservation verified.');

    console.log('\n🎉 ALL IN-MEMORY 3D SCENE EDIT PERSISTENCE TESTS PASSED SUCCESSFULLY!');
}

runInMemory3DSceneEditPersistenceTests().catch(err => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
