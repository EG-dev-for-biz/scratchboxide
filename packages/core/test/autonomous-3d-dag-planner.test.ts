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
import {
    DynamicDagPlanner
} from '../src/node/deep-write/dynamic-dag-planner';
import {
    GeminiService
} from '../src/node/gemini-service';
import type {
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';

async function runAutonomous3DDagPlannerTests() {
    console.log('🚀 Running Autonomous 3D Multi-Step DAG Planner & Lens Integration Tests...\n');

    const lens = new Scene3DWorldLens();
    const planner = new DynamicDagPlanner();

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

    // =========================================================================
    // Test 4: Autonomous Multi-Step Planning — Scene Reasoning (blender-mcp paradigm)
    // =========================================================================
    console.log('  Testing Scene Reasoning (sb_inspect_scene, sb_list_objects, sb_get_mesh_stats)...');
    const existingScene: Scene3DData = {
        title: 'Cyberpunk Drone Facility',
        renderMode: 'pbr',
        environment: { lighting: 'cyberpunk' },
        camera: { position: [20, 20, 20], target: [0, 0, 0], fov: 50 },
        customMeshes: [
            { id: 'mesh-drone-pad', name: 'Landing Pad', type: 'box', position: [0, 0, 0], scale: [10, 1, 10] },
            { id: 'mesh-generator', name: 'Energy Generator', type: 'cylinder', position: [5, 3, 5], scale: [2, 6, 2] }
        ]
    };

    const reasoning = planner.inspectAndReasonScene(existingScene);
    assert.strictEqual(reasoning.initialObjectCount, 2);
    assert.deepStrictEqual(reasoning.existingMeshIds, ['mesh-drone-pad', 'mesh-generator']);
    assert.strictEqual(reasoning.renderMode, 'pbr');
    assert.strictEqual(reasoning.currentLighting, 'cyberpunk');
    assert.strictEqual(reasoning.topologicalProfile.length, 2);

    console.log('  ✓ Test 4 Passed: Scene reasoning accurately profiles topology and lighting invariants.');

    // =========================================================================
    // Test 5: Autonomous Multi-Step Planning — DAG Generation (PocoLibre/blender-mcp)
    // =========================================================================
    console.log('  Testing Goal Breakdown & DAG Generation...');
    const dag = planner.generate3DPlanDAG('Create a high-tech cyberpunk city skyline with illuminated spires and transit hubs');

    assert.strictEqual(dag.stages.length, 6);
    assert.strictEqual(dag.stages[0].type, 'scaffolding');
    assert.strictEqual(dag.stages[1].type, 'base_geometry');
    assert.strictEqual(dag.stages[2].type, 'modifiers_and_edit');
    assert.strictEqual(dag.stages[3].type, 'materials_and_shading');
    assert.strictEqual(dag.stages[4].type, 'lighting_and_atmosphere');
    assert.strictEqual(dag.stages[5].type, 'camera_framing_and_dynamics');

    // Check dependency chain
    assert.deepStrictEqual(dag.stages[0].dependencies, []);
    assert.deepStrictEqual(dag.stages[1].dependencies, ['stage_01_scaffolding']);
    assert.deepStrictEqual(dag.stages[2].dependencies, ['stage_02_base_geometry']);
    assert.deepStrictEqual(dag.stages[3].dependencies, ['stage_03_modifiers_and_edit']);
    assert.deepStrictEqual(dag.stages[4].dependencies, ['stage_04_materials_and_shading']);
    assert.deepStrictEqual(dag.stages[5].dependencies, ['stage_05_lighting_and_atmosphere']);

    console.log('  ✓ Test 5 Passed: DAG generator constructs 6-phase dependency chain with operator payloads.');

    // =========================================================================
    // Test 6: End-to-End Autonomous 3D Workflow Execution & Invariant Verification
    // =========================================================================
    console.log('  Testing End-to-End Autonomous 3D Workflow Execution...');
    const planResult = await planner.executeAutonomous3DWorkflow('Battle of Lexington 1775 colonial historical scene');

    assert.strictEqual(planResult.success, true);
    assert.strictEqual(planResult.executedStages.length, 6);

    for (const stg of planResult.executedStages) {
        assert.strictEqual(stg.success, true, `Stage ${stg.stageName} must succeed`);
        assert.strictEqual(stg.verification.passed, true, `Stage ${stg.stageName} must pass invariant verification`);
    }

    const finalScene = planResult.finalScene;
    assert.ok(finalScene.customMeshes && finalScene.customMeshes.length >= 5);

    const tavern = finalScene.customMeshes?.find(m => m.id.includes('buckman-tavern'));
    const meetinghouse = finalScene.customMeshes?.find(m => m.id.includes('meetinghouse'));
    const minutemen = finalScene.customMeshes?.find(m => m.id.includes('minutemen-line'));
    const redcoats = finalScene.customMeshes?.find(m => m.id.includes('redcoat-regiment'));
    const wall = finalScene.customMeshes?.find(m => m.id.includes('fieldstone-wall'));

    assert.ok(tavern, 'Tavern mesh must exist');
    assert.ok(meetinghouse, 'Meetinghouse mesh must exist');
    assert.ok(minutemen, 'Minutemen mesh must exist');
    assert.ok(redcoats, 'Redcoats mesh must exist');
    assert.ok(wall, 'Wall mesh must exist');

    assert.strictEqual(finalScene.environment?.lighting, 'dawn');
    assert.ok(finalScene.camera?.position, 'Camera position must be set');
    assert.ok(planResult.actionLog.length >= planResult.totalOperatorsExecuted);

    console.log(`    → Autonomous 3D workflow executed ${planResult.totalOperatorsExecuted} direct operators across 6 stages in ${planResult.totalExecutionTimeMs.toFixed(2)}ms`);
    console.log('  ✓ Test 6 Passed: End-to-end multi-step autonomous planning executes with 100% verification.');

    // =========================================================================
    // Test 7: Incremental Scene Modification via Autonomous Workflow
    // =========================================================================
    console.log('  Testing Incremental Scene Modification Workflow...');
    const baseArchScene: Scene3DData = {
        title: 'Architectural Base Studio',
        renderMode: 'pbr',
        environment: { lighting: 'spotlight' },
        customMeshes: [
            { id: 'mesh-pavilion-floor', name: 'Pavilion Floor', type: 'plane', position: [0, 0, 0], scale: [20, 20, 1] }
        ]
    };

    const incResult = await planner.executeAutonomous3DWorkflow(
        'Add an articulated aerospace jet flight vehicle with delta wings and rigid body physics',
        baseArchScene
    );

    assert.strictEqual(incResult.success, true);
    const incMeshes = incResult.finalScene.customMeshes || [];
    // Existing mesh preserved
    assert.ok(incMeshes.some(m => m.id === 'mesh-pavilion-floor'), 'Existing pavilion floor must be preserved');
    // New meshes added
    assert.ok(incMeshes.some(m => m.id.includes('aircraft-fuselage')), 'Aircraft fuselage must be added');
    assert.ok(incMeshes.some(m => m.id.includes('aircraft-wings')), 'Aircraft wings must be added');

    const fuselage = incMeshes.find(m => m.id.includes('aircraft-fuselage'));
    assert.ok((fuselage as any).physics, 'Fuselage must have physics attached');
    assert.strictEqual((fuselage as any).physics.bodyType, 'kinematic');

    console.log('  ✓ Test 7 Passed: Incremental modification retains pre-existing scene state.');

    // =========================================================================
    // Test 8: Stage Invariant Verification & Failure Handling
    // =========================================================================
    console.log('  Testing Stage Invariant Failure Handling...');
    const failingStage = {
        id: 'stage_failing',
        type: 'base_geometry' as const,
        name: 'Phase Failed Test',
        description: 'Intentionally failing stage',
        dependencies: [],
        operators: [
            { operator: 'sb_translate', params: { objectId: 'non-existent-mesh-999', delta: [1, 1, 1] } }
        ],
        expectedStateChecks: {
            requiredMeshIds: ['non-existent-mesh-999']
        }
    };

    const engine = lens.createEngine({ title: 'Failure Test' });
    const failExec = await planner.execute3DStageWithVerification(failingStage, engine);
    assert.strictEqual(failExec.success, false);
    assert.strictEqual(failExec.verification.passed, false);
    assert.ok(failExec.error);

    console.log('  ✓ Test 8 Passed: Stage invariant failure caught and reported accurately.');

    // =========================================================================
    // Test 9: Cross-Theme DAG Generation (Solar, Molecular, Architecture, Flight)
    // =========================================================================
    console.log('  Testing Cross-Theme DAG Generation...');
    const themes = [
        { prompt: 'Solar system with orbital planets and glowing sun', expectedTheme: 'solar-system' },
        { prompt: 'DNA double helix molecular quantum lattice', expectedTheme: 'molecular' },
        { prompt: 'Architectural blueprint room with polished floor and plinth', expectedTheme: 'architecture' },
        { prompt: 'Aerospace jet fighter flight simulation corridor', expectedTheme: 'flight' }
    ];

    for (const t of themes) {
        const themeDag = planner.generate3DPlanDAG(t.prompt);
        assert.strictEqual(themeDag.theme, t.expectedTheme, `Prompt '${t.prompt}' must resolve to ${t.expectedTheme}`);
        assert.strictEqual(themeDag.stages.length, 6);
        assert.ok(themeDag.stages[1].operators.length > 0, 'Must have geometry operators');
        assert.ok(themeDag.stages[3].operators.length > 0, 'Must have material operators');
    }

    console.log('  ✓ Test 9 Passed: All semantic themes produce specialized DAGs with custom operators.');

    // =========================================================================
    // Test 10: GeminiService Autonomous 3D Planning Integration
    // =========================================================================
    console.log('  Testing GeminiService Autonomous 3D Planning API...');
    const geminiService = new GeminiService();

    const geminiDag = geminiService.generate3DPlanDAG('Procedural futuristic metropolis city');
    assert.strictEqual(geminiDag.theme, 'city');
    assert.strictEqual(geminiDag.stages.length, 6);

    const geminiPlan = await geminiService.plan3DAutonomousWorkflow('Solar system planetary mechanics');
    assert.strictEqual(geminiPlan.success, true);
    assert.ok(geminiPlan.finalScene.customMeshes?.some(m => m.id.includes('sun-core')));
    assert.strictEqual(geminiPlan.finalScene.environment?.lighting, 'deep-space');

    console.log('  ✓ Test 10 Passed: GeminiService autonomous 3D multi-step planning methods operational.');

    console.log('\n🎉 ALL 10 AUTONOMOUS 3D DAG PLANNER & LENS INTEGRATION TESTS COMPLETED SUCCESSFULLY!');
}

test('autonomous-3d-dag-planner.test', async () => {
    await runAutonomous3DDagPlannerTests();
}, 180_000);
