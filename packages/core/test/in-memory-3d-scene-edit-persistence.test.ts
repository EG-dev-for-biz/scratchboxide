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
    parseOrSynthesizeArtifact
} from '../src/node/gemini/artifact-synthesis';
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

    // The engine edits vertices only on a live viewport mesh: with none attached the dispatch fails and records nothing.
    const sculptDispatch = engine.dispatch('sb_deform_vertices', {
        objectId: 'building-alpha',
        strokePoint: [0, 4, 0],
        radius: 2.5,
        strength: 0.8
    });
    assert.strictEqual(sculptDispatch.success, false);
    assert.strictEqual(sculptDispatch.errorCode, 'not_available_here');
    assert.ok(!engine.getSceneData().operatorStack?.some(op => op.operator === 'sb_deform_vertices'), 'a failed edit must not be recorded as done');

    // With a live mesh the same dispatch moves the real vertices.
    const liveEngine = createOperatorEngine(initialScene);
    const liveScene = new THREE.Scene();
    const liveGeo = createSculptableGeometry('sphere', { radius: 4, segments: 32 });
    const liveMesh = new THREE.Mesh(liveGeo, new THREE.MeshStandardMaterial());
    liveMesh.name = 'building-alpha';
    liveScene.add(liveMesh);
    liveEngine.attachThreeScene(liveScene);
    const livePos = liveGeo.getAttribute('position') as THREE.BufferAttribute;
    let topIndex = 0;
    for (let i = 1; i < livePos.count; i++) if (livePos.getY(i) > livePos.getY(topIndex)) topIndex = i;
    const topYBefore = livePos.getY(topIndex);
    const liveDeform = liveEngine.dispatch('sb_deform_vertices', {
        objectId: 'building-alpha',
        strokePoint: [livePos.getX(topIndex), topYBefore, livePos.getZ(topIndex)],
        radius: 2.5,
        strength: 0.8,
        direction: [0, 1, 0]
    });
    assert.strictEqual(liveDeform.success, true);
    assert.ok(liveDeform.data.affectedVertices > 0);
    assert.ok(Math.abs(livePos.getY(topIndex) - (topYBefore + 0.8)) < 1e-6, 'the vertex at the stroke centre rises by the full strength');
    assert.ok(liveEngine.getSceneData().operatorStack?.some(op => op.operator === 'sb_deform_vertices'));
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
    assert.strictEqual(sceneAfterLighting.environment?.lighting, 'golden_hour');
    assert.strictEqual((sceneAfterLighting.features?.atmosphericScattering as any)?.enabled, true);
    assert.strictEqual((sceneAfterLighting.features?.atmosphericScattering as any)?.sunElevation, 12);
    assert.strictEqual((sceneAfterLighting.features?.atmosphericScattering as any)?.sunAzimuth, 245);
    assert.strictEqual(sceneAfterLighting.features?.godRays, true);
    assert.strictEqual(lightingResult.data.sunElevation, 12);
    console.log('    ✓ Materials, clay presets, and atmospheric lighting mutations verified.');

    // =========================================================================
    // Test 4: Setting a transform never spawns an object
    // =========================================================================
    console.log('  4. Testing that a transform on an unknown id creates nothing...');
    const addMeshResult = engine.dispatch('sb_set_transform', {
        objectId: 'building-gamma',
        position: [20, 8, 10],
        scale: [5, 16, 5]
    });
    assert.strictEqual(addMeshResult.success, false, 'sb_set_transform on an unknown id must fail');
    const sceneAfterAdd = engine.getSceneData();
    assert.strictEqual(sceneAfterAdd.customMeshes?.length, 2);
    assert.strictEqual(sceneAfterAdd.customMeshes?.find(m => m.id === 'building-gamma'), undefined);
    console.log('    ✓ Unknown-id transform failed without adding a mesh.');

    // =========================================================================
    // Test 5: Lens Unprojection & Reprojection State Retention
    // =========================================================================
    console.log('  5. Testing Scene3DWorldLens Unprojection & Reprojection...');
    const lens = new Scene3DWorldLens();
    const activeEditedScene = engine.getSceneData();
    const unproj = lens.unproject(activeEditedScene, 'campus.scene.json');

    assert.ok(unproj.files['campus.scene.json'], 'Unprojector must emit primary scene file');
    const parsedFile = JSON.parse(unproj.files['campus.scene.json']);
    assert.strictEqual(parsedFile.customMeshes.length, 2, 'Both custom meshes must be serialized to disk JSON');
    assert.deepStrictEqual(parsedFile.customMeshes.find((m: any) => m.id === 'building-alpha').position, [5, 7, -3]);
    assert.strictEqual(parsedFile.environment.lighting, 'golden_hour');
    assert.ok(parsedFile.operatorStack.length >= 4, 'Operator stack must persist in unprojected JSON');

    // Reproject back from JSON
    const reproj = lens.project(unproj.files);
    assert.strictEqual(reproj.data.customMeshes?.length, 2);
    assert.deepStrictEqual(reproj.data.customMeshes?.find(m => m.id === 'building-alpha')?.position, [5, 7, -3]);
    assert.strictEqual(reproj.data.environment?.lighting, 'golden_hour');
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

    // =========================================================================
    // Test 7: Lossless In-Memory Undo/Redo & Version History
    // =========================================================================
    console.log('  7. Testing Lossless Undo/Redo & Version Navigation...');
    // Initial state -> Translate -> Scale -> Clay -> Lighting (failed dispatches add no history step)
    const canUndo1 = engine.undo();
    assert.strictEqual(canUndo1, true, 'Engine must undo last step');
    const sceneAfterUndo = engine.getSceneData();
    assert.strictEqual(sceneAfterUndo.environment?.lighting, 'daylight', 'Undo must restore the lighting before sb_setup_lighting');
    assert.strictEqual(sceneAfterUndo.features?.atmosphericScattering, undefined);
    assert.strictEqual(sceneAfterUndo.customMeshes![0].material?.shaderKey, 'terracotta', 'The earlier clay edit stays');

    const canRedo1 = engine.redo();
    assert.strictEqual(canRedo1, true, 'Engine must redo step');
    const sceneAfterRedo = engine.getSceneData();
    assert.strictEqual(sceneAfterRedo.environment?.lighting, 'golden_hour', 'Redo must reapply the lighting');
    assert.strictEqual((sceneAfterRedo.features?.atmosphericScattering as any)?.sunElevation, 12);
    // =========================================================================
    // Test 8: Guarded Conversational Delta-Editing (Anti-Wipe Scene Protection)
    // =========================================================================
    console.log('  8. Testing Guarded Conversational Delta-Editing...');
    const activeArtifactForDelta: CanvasArtifact = {
        id: 'art-campus-delta-01',
        title: 'Architectural Campus Workspace',
        type: '3d-scene',
        summary: 'Active 3D campus layout.',
        version: 1,
        data: {
            title: 'Architectural Campus Workspace',
            sceneType: 'adaptive',
            customMeshes: [
                {
                    id: 'building-alpha',
                    name: 'Alpha Tower',
                    type: 'box',
                    position: [5, 7, -3],
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
                    scale: [9, 12, 9],
                    material: { color: 0xf59e0b, roughness: 0.5, metalness: 0.2 }
                }
            ],
            operatorStack: [
                { operator: 'sb_translate', timestamp: Date.now(), payload: { objectId: 'building-alpha', delta: [5, 2, -3] } }
            ],
            actionLog: ['sb_translate: building-alpha by [5, 2, -3]']
        }
    };

    // 8a. User gives refinement prompt: "make the alpha tower gold and add a torus ring"
    // Model returns delta JSON that updates alpha tower's material and adds a torus ring.
    const deltaModelResponse = `
Here is the updated 3D scene with the gold material and torus ring:
\`\`\`json
{
  "type": "3d-scene",
  "data": {
    "title": "Architectural Campus Workspace",
    "customMeshes": [
      {
        "id": "building-alpha",
        "name": "Alpha Tower",
        "type": "box",
        "material": { "color": 16766720, "roughness": 0.2, "metalness": 0.95, "preset": "polished_gold_24k" }
      },
      {
        "id": "ring-mesh-1",
        "name": "Energy Torus Ring",
        "type": "torus",
        "position": [5, 12, -3],
        "scale": [3, 3, 3],
        "material": { "color": 3847928, "roughness": 0.1, "metalness": 0.9 }
      }
    ]
  }
}
\`\`\`
    `;

    const deltaResult = parseOrSynthesizeArtifact(
        'make the alpha tower gold and add a torus ring',
        deltaModelResponse,
        {
            prompt: 'make the alpha tower gold and add a torus ring',
            activeArtifact: activeArtifactForDelta
        } as any,
        []
    );

    assert.strictEqual(deltaResult.type, '3d-scene');
    const deltaSceneData = deltaResult.data as Scene3DData;
    // Verify beta pavilion was NOT wiped out!
    const preservedBeta = deltaSceneData.customMeshes?.find(m => m.id === 'building-beta');
    assert.ok(preservedBeta, 'Beta Pavilion must be preserved during conversational delta-edit');
    assert.deepStrictEqual(preservedBeta.position, [12, 3, -6], 'Beta Pavilion position must remain intact');
    assert.deepStrictEqual(preservedBeta.scale, [9, 12, 9], 'Beta Pavilion scale must remain intact');

    // Verify alpha tower merged material but preserved manual transform
    const updatedAlpha = deltaSceneData.customMeshes?.find(m => m.id === 'building-alpha');
    assert.ok(updatedAlpha, 'Alpha Tower must exist');
    assert.strictEqual(updatedAlpha.material?.preset, 'polished_gold_24k');
    assert.deepStrictEqual(updatedAlpha.position, [5, 7, -3], 'Alpha Tower manual transform must be preserved');

    // Verify new ring was added
    const newRing = deltaSceneData.customMeshes?.find(m => m.id === 'ring-mesh-1');
    assert.ok(newRing, 'Energy Torus Ring must be added');

    // Verify operatorStack was preserved
    assert.ok(deltaSceneData.operatorStack?.some(op => op.operator === 'sb_translate'), 'Operator stack must be preserved during delta edit');

    // 8b. "Clear scene and start over": the model clears the scene by sending empty lists. The prompt's wording
    // decides nothing (the "clear scene" keyword regex is gone); what the model sends does.
    const destructionResponse = `
\`\`\`json
{
  "type": "3d-scene",
  "data": {
    "title": "Fresh Blank Scene",
    "customMeshes": [],
    "operatorStack": []
  }
}
\`\`\`
    `;
    const destructionResult = parseOrSynthesizeArtifact(
        'clear scene and start over from scratch',
        destructionResponse,
        {
            prompt: 'clear scene and start over from scratch',
            activeArtifact: deltaResult
        } as any,
        []
    );
    const destructionData = destructionResult.data as Scene3DData;
    assert.strictEqual(destructionData.operatorStack?.length, 0, 'Operator stack must be cleared when the model sends an empty one');
    assert.strictEqual(destructionData.customMeshes?.length, 0, 'Meshes must be cleared when the model sends an empty list');
    // The same words with an envelope that clears nothing keep the scene: wording alone wipes nothing.
    const wordsOnly = parseOrSynthesizeArtifact(
        'clear scene and start over from scratch',
        '```json\n{"type": "3d-scene", "data": {"title": "Fresh Blank Scene"}}\n```',
        { prompt: 'clear scene and start over from scratch', activeArtifact: deltaResult } as any,
        []
    );
    const wordsOnlyData = wordsOnly!.data as Scene3DData;
    assert.ok(wordsOnlyData.customMeshes?.some(m => m.id === 'building-beta'), 'Prompt wording alone must not wipe the meshes');
    assert.ok(wordsOnlyData.operatorStack?.some(op => op.operator === 'sb_translate'), 'Prompt wording alone must not wipe the operator stack');
    console.log('    ✓ Guarded conversational delta-editing verified (anti-wipe scene protection).');

    console.log('\n🎉 ALL IN-MEMORY 3D SCENE EDIT PERSISTENCE TESTS PASSED SUCCESSFULLY!');
}

test('in-memory-3d-scene-edit-persistence.test', async () => {
    await runInMemory3DSceneEditPersistenceTests();
}, 180_000);
