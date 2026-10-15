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
import {
    Scene3DWorldLens
} from '../src/browser/generative-canvas/lenses/Scene3DWorldLens';
import {
    synthesizeContextual3DScene,
    modifySceneWithOperators
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import type {
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';

async function runSceneWorldLensOperatorTests() {
    console.log('🚀 Running Scene3DWorldLens operator & operator-stack tests...\n');

    const lens = new Scene3DWorldLens();

    // =========================================================================
    // Test 1: Scene3DWorldLens Direct Operator & Batch Execution
    // =========================================================================
    console.log('  Testing Scene3DWorldLens executeOperator & executeOperatorBatch...');
    const initialLensScene: Scene3DData = {
        title: 'Lens Operator Test Scene',
        renderMode: 'pbr',
        customMeshes: [
            {
                id: 'mesh-lens-cube',
                name: 'Lens Cube',
                type: 'box',
                position: [0, 0, 0],
                scale: [1, 1, 1]
            }
        ]
    };

    // 1. executeOperator (sb_translate)
    const singleOpRes = lens.executeOperator(initialLensScene, 'sb_translate', {
        objectId: 'mesh-lens-cube',
        delta: [5, 10, -2]
    });
    assert.strictEqual(singleOpRes.result.success, true);
    const movedCube = singleOpRes.sceneData.customMeshes?.find(m => m.id === 'mesh-lens-cube');
    assert.deepStrictEqual(movedCube?.position, [5, 10, -2]);
    assert.ok(singleOpRes.sceneData.operatorStack && singleOpRes.sceneData.operatorStack.length > 0);
    assert.ok(singleOpRes.sceneData.actionLog && singleOpRes.sceneData.actionLog.length > 0);

    // 2. executeOperatorBatch (material + transform + lighting)
    const batchRes = lens.executeOperatorBatch(singleOpRes.sceneData, [
        { operator: 'sb_create_material', params: { materialId: 'mat-lens-cyan', color: 0x00f3ff, roughness: 0.2, metalness: 0.8 } },
        { operator: 'sb_assign_material', params: { objectId: 'mesh-lens-cube', materialId: 'mat-lens-cyan' } },
        { operator: 'sb_scale', params: { objectId: 'mesh-lens-cube', scale: [2, 2, 2] } },
        { operator: 'sb_setup_lighting', params: { preset: 'cyberpunk' } }
    ]);
    assert.strictEqual(batchRes.result.success, true);
    assert.strictEqual(batchRes.result.results.length, 4);

    const updatedCube = batchRes.sceneData.customMeshes?.find(m => m.id === 'mesh-lens-cube');
    assert.deepStrictEqual(updatedCube?.scale, [2, 2, 2]);
    assert.strictEqual(updatedCube?.material?.color, 0x00f3ff);
    assert.strictEqual(batchRes.sceneData.environment?.lighting, 'cyberpunk');

    // 3. Round-trip unproject and project
    const unproj = lens.unproject(batchRes.sceneData, 'test.scene.json');
    assert.ok(unproj.files['test.scene.json']);
    const proj = lens.project(unproj.files['test.scene.json']);
    assert.strictEqual(proj.data.title, 'Lens Operator Test Scene');
    assert.strictEqual(proj.data.customMeshes?.length, 1);
    assert.strictEqual(proj.data.environment?.lighting, 'cyberpunk');
    assert.ok(proj.data.operatorStack && proj.data.operatorStack.length > 0);

    console.log('  ✓ Test 1 Passed: Scene3DWorldLens operator execution and projection unprojection verified.');

    // =========================================================================
    // Test 2: Scene3DWorldLens Operator Stack Playback & Replay
    // =========================================================================
    console.log('  Testing Scene3DWorldLens Operator Stack Playback...');
    const playbackScene: Scene3DData = {
        title: 'Playback Base',
        customMeshes: [
            { id: 'mesh-bot', name: 'Robot Core', type: 'sphere', position: [0, 0, 0] }
        ]
    };

    const recordedOps = [
        { operator: 'sb_translate', params: { objectId: 'mesh-bot', delta: [0, 5, 0] } },
        { operator: 'sb_scale', params: { objectId: 'mesh-bot', scale: [3, 3, 3] } },
        { operator: 'sb_create_material', params: { materialId: 'mat-gold', color: 0xffd700, metalness: 0.9, roughness: 0.1 } },
        { operator: 'sb_assign_material', params: { objectId: 'mesh-bot', materialId: 'mat-gold' } }
    ];

    const replayRes = lens.playbackOperatorStack(playbackScene, recordedOps);
    assert.strictEqual(replayRes.result.success, true);
    assert.strictEqual(replayRes.result.results.length, 4);

    const replayedBot = replayRes.sceneData.customMeshes?.find(m => m.id === 'mesh-bot');
    assert.deepStrictEqual(replayedBot?.position, [0, 5, 0]);
    assert.deepStrictEqual(replayedBot?.scale, [3, 3, 3]);
    assert.strictEqual(replayedBot?.material?.color, 0xffd700);

    console.log('  ✓ Test 2 Passed: Operator stack playback and recreation verified.');

    // =========================================================================
    // Test 3: Procedural Synthesizer Operator Initialization & Modifications
    // =========================================================================
    console.log('  Testing Procedural Synthesizer Operator Stack & In-Memory Modification...');
    const synthScene = synthesizeContextual3DScene('Historical battlefield at Lexington 1775');
    assert.ok(synthScene.operatorStack, 'Synthesized scene must have operatorStack initialized');
    assert.ok(synthScene.operatorStack.length > 0, 'Synthesized scene must have recorded operator actions');
    assert.ok(synthScene.actionLog && synthScene.actionLog.length > 0);

    // Modify synthesized scene with operators
    const modRes = modifySceneWithOperators(synthScene, [
        { operator: 'sb_translate', params: { objectId: 'mesh-buckman-tavern', delta: [0, 2, 0] } },
        { operator: 'sb_set_material_pbr', params: { objectId: 'mesh-buckman-tavern', roughness: 0.2, metalness: 0.8 } }
    ]);
    assert.strictEqual(modRes.result.success, true);

    const modifiedTavern = modRes.scene.customMeshes?.find(m => m.id === 'mesh-buckman-tavern');
    assert.ok(modifiedTavern);
    assert.strictEqual(modifiedTavern.position?.[1], 6); // 4 + 2
    assert.strictEqual(modifiedTavern.material?.roughness, 0.2);

    console.log('  ✓ Test 3 Passed: Procedural synthesizer initializes and allows direct operator modifications.');

    console.log('\n🎉 Scene3DWorldLens operator and operator-stack tests passed.');
}

test('scene3d-world-lens-operators.test', async () => {
    await runSceneWorldLensOperatorTests();
}, 180_000);
