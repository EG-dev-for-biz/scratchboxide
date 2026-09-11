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
    VisualVerificationService
} from '../src/node/visual-verification-service';
import {
    DEFAULT_VIEWPORT_ANGLES,
    VisualAudit3DDefect,
    MultiAngleVisualAuditResult,
    VisualSelfCorrection3DOptions,
    computeCameraForViewportAngle
} from '../src/common/visual-verification-protocol';
import {
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';
import {
    GeminiService
} from '../src/node/gemini-service';

async function runViewportVisionVerificationLoopTests() {
    console.log('👁️ Running Viewport Vision Verification Loop Test Suite (Step 3)...\n');

    const visualService = new VisualVerificationService();
    const samplePngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';

    // =========================================================================
    // Test 1: Multi-Angle Viewport Capture Configuration & Angle Calculations
    // =========================================================================
    console.log('  Testing 1: Multi-Angle Viewport Capture Specs & Camera Computations...');

    assert.ok(Array.isArray(DEFAULT_VIEWPORT_ANGLES), 'DEFAULT_VIEWPORT_ANGLES must be an array');
    assert.ok(DEFAULT_VIEWPORT_ANGLES.includes('perspective'), 'Must include perspective angle');
    assert.ok(DEFAULT_VIEWPORT_ANGLES.includes('front'), 'Must include front angle');
    assert.ok(DEFAULT_VIEWPORT_ANGLES.includes('top'), 'Must include top angle');
    assert.ok(DEFAULT_VIEWPORT_ANGLES.includes('isometric'), 'Must include isometric angle');

    const testScene: Scene3DData = {
        title: 'Cyberpunk Hovercraft Studio',
        renderMode: 'pbr',
        camera: { position: [10, 10, 10], target: [0, 0, 0], fov: 45 },
        customMeshes: [
            {
                id: 'mesh-hovercraft',
                name: 'Hovercraft Chassis',
                type: 'box',
                position: [0, 0, 0],
                scale: [4, 1.5, 6]
            }
        ]
    };

    // Calculate camera setup for perspective
    const perspCam = computeCameraForViewportAngle('perspective', testScene);
    assert.ok(perspCam.position, 'Perspective camera must have position');
    assert.ok(perspCam.target, 'Perspective camera must have target');
    assert.strictEqual(perspCam.fov, 45);

    // Calculate camera setup for front view
    const frontCam = computeCameraForViewportAngle('front', testScene);
    assert.strictEqual(frontCam.position[0], 0, 'Front view X must be centered');
    assert.ok(frontCam.position[2] > 0, 'Front view Z must be in front');

    // Calculate camera setup for top view
    const topCam = computeCameraForViewportAngle('top', testScene);
    assert.ok(topCam.position[1] > 10, 'Top view Y must be elevated above scene');

    // Calculate camera setup for isometric view
    const isoCam = computeCameraForViewportAngle('isometric', testScene);
    assert.ok(isoCam.position[0] > 0 && isoCam.position[1] > 0 && isoCam.position[2] > 0, 'Isometric must be 3-axis offset');

    console.log('  ✓ Test 1 Passed: Viewport camera angles compute appropriate positions and targets.');

    // =========================================================================
    // Test 2: 3D Visual Defect Detection & Heuristic Diagnostics
    // =========================================================================
    console.log('  Testing 2: 3D Visual Defect Detection across Scene Modalities...');

    // 2a. Unlit Scene Defect
    const unlitScene: Scene3DData = {
        title: 'Unlit Void Asset',
        renderMode: 'shaded',
        environment: { lighting: 'none' },
        customMeshes: [
            { id: 'mesh-unlit-1', type: 'box', position: [0, 0, 0], scale: [2, 2, 2] }
        ]
    };

    const unlitAudit = await visualService.verifyVisual({
        image: 'data:image/png;base64,AAAAABJRU5ErkJggg==',
        prompt: 'Futuristic sci-fi beacon with vibrant lighting and metallic reflections',
        artifactType: '3d-scene',
        context: {
            sceneData: unlitScene,
            angle: 'perspective'
        }
    });

    assert.strictEqual(unlitAudit.pass, false, 'Unlit scene must fail verification');
    assert.ok(unlitAudit.fidelityScore < 80, 'Unlit fidelity score must be < 80');
    assert.ok(unlitAudit.defects3D && unlitAudit.defects3D.length > 0, 'Must report 3D defects');
    assert.ok(unlitAudit.defects3D?.some(d => d.defectType === 'unlit' || d.defectType === 'missing_lighting' || d.defectType === 'void'), 'Must flag unlit defect');
    assert.ok(unlitAudit.operatorDispatches && unlitAudit.operatorDispatches.length > 0, 'Must output direct-dispatch operators');
    assert.ok(unlitAudit.operatorDispatches?.some(op => op.operator === 'sb_setup_lighting'), 'Must include sb_setup_lighting operator');

    // 2b. Off-Center Camera Defect
    const offCenterScene: Scene3DData = {
        title: 'Off-Center Framing Asset',
        renderMode: 'pbr',
        environment: { lighting: 'studio', skybox: 'studio' },
        camera: { position: [100, 100, 100], target: [50, 50, 50], fov: 45 },
        customMeshes: [
            { id: 'mesh-target-cube', type: 'box', position: [0, 0, 0], scale: [2, 2, 2] }
        ]
    };

    const offCenterAudit = await visualService.verifyVisual({
        image: samplePngDataUrl,
        prompt: 'Close-up inspect of target cube at center stage',
        artifactType: '3d-scene',
        context: {
            sceneData: offCenterScene,
            angle: 'perspective'
        }
    });

    assert.ok(offCenterAudit.defects3D?.some(d => d.defectType === 'off_center_camera' || d.defectType === 'framing_offset'), 'Must detect off-center camera');
    assert.ok(offCenterAudit.operatorDispatches?.some(op => op.operator === 'sb_set_camera' || op.operator === 'sb_frame_bounds'), 'Must suggest camera framing operator');

    // 2c. Missing PBR Material Defect
    const unshadedScene: Scene3DData = {
        title: 'Unshaded Material Mesh',
        renderMode: 'pbr',
        environment: { lighting: 'studio', skybox: 'studio' },
        camera: { position: [10, 10, 10], target: [0, 0, 0], fov: 45 },
        customMeshes: [
            {
                id: 'mesh-raw-box',
                type: 'box',
                position: [0, 0, 0],
                scale: [2, 2, 2]
                // Note: material is undefined / default
            }
        ]
    };

    const unshadedAudit = await visualService.verifyVisual({
        image: samplePngDataUrl,
        prompt: 'Polished gold metallic sphere with reflective finish',
        artifactType: '3d-scene',
        context: {
            sceneData: unshadedScene,
            angle: 'perspective'
        }
    });

    assert.ok(unshadedAudit.defects3D?.some(d => d.defectType === 'missing_material' || d.defectType === 'missing_pbr'), 'Must detect missing PBR material');
    assert.ok(unshadedAudit.operatorDispatches?.some(op => op.operator === 'sb_set_material_pbr' || op.operator === 'sb_create_material' || op.operator === 'sb_assign_material'), 'Must suggest material operators');

    console.log('  ✓ Test 2 Passed: 3D defect detector identifies unlit scenes, off-center camera, and missing materials.');

    // =========================================================================
    // Test 3: Automated Translation of Visual Defects into Direct-Dispatch 3D Operators
    // =========================================================================
    console.log('  Testing 3: Automated Mapping of Visual Defects to Direct-Dispatch Operators...');

    const sampleDefects: VisualAudit3DDefect[] = [
        {
            defectType: 'unlit',
            severity: 'critical',
            description: 'Scene has no lighting preset or ambient intensity',
            suggestedOperator: 'sb_setup_lighting',
            suggestedParams: { preset: 'three-point', ambientIntensity: 0.5 }
        },
        {
            defectType: 'off_center_camera',
            severity: 'warning',
            description: 'Camera target is displaced from object bounds',
            suggestedOperator: 'sb_frame_bounds',
            suggestedParams: { paddingFactor: 1.5 }
        },
        {
            defectType: 'missing_pbr',
            severity: 'warning',
            description: 'Object mesh-hovercraft lacks PBR metallic roughness properties',
            targetObjectId: 'mesh-hovercraft',
            suggestedOperator: 'sb_set_material_pbr',
            suggestedParams: { objectId: 'mesh-hovercraft', roughness: 0.3, metalness: 0.8, color: 0x00e5ff }
        },
        {
            defectType: 'unsubdivided_mesh',
            severity: 'info',
            description: 'Low polygon density causes blocky facet artifacts',
            targetObjectId: 'mesh-hovercraft',
            suggestedOperator: 'sb_subdivide_mesh',
            suggestedParams: { objectId: 'mesh-hovercraft', iterations: 1 }
        }
    ];

    const mappedOperators = visualService.mapDefectsToOperators(sampleDefects, testScene);
    assert.strictEqual(mappedOperators.length, 4, 'Must map all 4 defects to operators');
    assert.strictEqual(mappedOperators[0].operator, 'sb_setup_lighting');
    assert.strictEqual(mappedOperators[1].operator, 'sb_frame_bounds');
    assert.strictEqual(mappedOperators[2].operator, 'sb_set_material_pbr');
    assert.strictEqual(mappedOperators[3].operator, 'sb_subdivide_mesh');

    console.log('  ✓ Test 3 Passed: Defects successfully map to typed direct-dispatch 3D operators.');

    // =========================================================================
    // Test 4: Multi-Angle Viewport Audit (audit3DSceneMultiAngle)
    // =========================================================================
    console.log('  Testing 4: Multi-Angle Viewport Audit across 4 Canonical Projections...');

    const multiAngleAudit: MultiAngleVisualAuditResult = await visualService.audit3DSceneMultiAngle({
        sceneData: testScene,
        prompt: 'Futuristic articulated cyberpunk hovercraft with high-tech materials and cinematic lighting',
        angles: ['perspective', 'front', 'top', 'isometric'],
        captureAngleFrame: (angle, scene) => {
            // Simulated angle frame generator
            return samplePngDataUrl;
        }
    });

    assert.ok(multiAngleAudit.angleResults, 'Must include individual angle results');
    assert.ok(multiAngleAudit.angleResults['perspective'], 'Must have perspective audit');
    assert.ok(multiAngleAudit.angleResults['front'], 'Must have front audit');
    assert.ok(multiAngleAudit.angleResults['top'], 'Must have top audit');
    assert.ok(multiAngleAudit.angleResults['isometric'], 'Must have isometric audit');
    assert.strictEqual(typeof multiAngleAudit.averageFidelityScore, 'number');
    assert.strictEqual(typeof multiAngleAudit.overallPass, 'boolean');
    assert.ok(Array.isArray(multiAngleAudit.combinedOperatorDispatches));
    assert.ok(multiAngleAudit.summaryCritique.length > 0);

    console.log(`    → Multi-angle audit completed. Average score: ${multiAngleAudit.averageFidelityScore}, Pass: ${multiAngleAudit.overallPass}`);
    console.log('  ✓ Test 4 Passed: Multi-angle audit accurately inspects perspective, front, top, and isometric viewports.');

    // =========================================================================
    // Test 5: Multi-Turn Iterative 3D Self-Correction Loop (run3DVisualSelfCorrectionLoop)
    // =========================================================================
    console.log('  Testing 5: Iterative 3D Visual Self-Correction Loop with Direct Operator Engine...');

    // Defective scene needing iterative repairs:
    // Iteration 1: unlit + off-center camera + raw materials (Fidelity ~ 50)
    // Iteration 2: After lighting + framing + PBR materials applied (Fidelity >= 85)
    const defectiveInitialScene: Scene3DData = {
        title: 'Colonial Lexington Militia Post',
        renderMode: 'shaded',
        environment: { lighting: 'none', skybox: undefined },
        camera: { position: [100, 50, 100], target: [80, 50, 80], fov: 60 },
        customMeshes: [
            {
                id: 'mesh-tavern-post',
                name: 'Buckman Tavern Post',
                type: 'box',
                position: [0, 0, 0],
                scale: [6, 4, 8]
            }
        ]
    };

    const loopOptions: VisualSelfCorrection3DOptions = {
        sceneData: defectiveInitialScene,
        targetPrompt: 'Colonial American historical Buckman Tavern at Lexington Green during dawn with atmospheric sky and authentic wood textures',
        angles: ['perspective', 'front', 'isometric'],
        maxIterations: 4,
        minPassingScore: 80,
        autoDispatch: true
    };

    const loopResult = await visualService.run3DVisualSelfCorrectionLoop(loopOptions);

    assert.strictEqual(loopResult.converged, true, 'Visual self-correction loop must converge to pass');
    assert.strictEqual(loopResult.repaired, true, 'Must report repaired: true');
    assert.ok(loopResult.iterations >= 2, `Must run at least 2 iterations for repair (got ${loopResult.iterations})`);
    assert.ok(loopResult.initialFidelityScore < 80, `Initial score must be <80 (got ${loopResult.initialFidelityScore})`);
    assert.ok(loopResult.finalFidelityScore >= 80, `Final score must be >=80 (got ${loopResult.finalFidelityScore})`);
    assert.ok(loopResult.executedOperators.length > 0, 'Must have executed repair operators');

    // Verify final scene state mutations
    const finalScene = loopResult.sceneData;
    assert.ok(finalScene.environment?.lighting && finalScene.environment.lighting !== 'none', 'Lighting must be restored');
    assert.ok(finalScene.camera?.position, 'Camera must be reframed');
    assert.ok(finalScene.operatorStack && finalScene.operatorStack.length > 0, 'Operator stack must record dispatched fixes');

    const tavernMesh = finalScene.customMeshes?.find(m => m.id === 'mesh-tavern-post');
    assert.ok(tavernMesh?.material, 'Tavern mesh must have PBR material assigned');

    console.log(`    → Iterative loop converged in ${loopResult.iterations} turns: Score ${loopResult.initialFidelityScore} → ${loopResult.finalFidelityScore}`);
    console.log(`    → Executed ${loopResult.executedOperators.length} direct-dispatch operators in-memory`);
    console.log('  ✓ Test 5 Passed: Multi-turn self-correction loop reliably repairs 3D scene visual flaws.');

    // =========================================================================
    // Test 6: GeminiService 3D Viewport Vision Verification Integration
    // =========================================================================
    console.log('  Testing 6: GeminiService 3D Vision Verification API Integration...');

    const geminiService = new GeminiService();

    // 6a. Multi-Angle Audit via GeminiService
    const gMultiAudit = await geminiService.audit3DSceneMultiAngle({
        sceneData: testScene,
        prompt: 'Futuristic hovercraft in studio lighting',
        angles: ['perspective', 'front']
    });
    assert.ok(gMultiAudit.angleResults);
    assert.strictEqual(typeof gMultiAudit.averageFidelityScore, 'number');

    // 6b. Self-Correction Loop via GeminiService
    const gLoopResult = await geminiService.run3DVisualSelfCorrectionLoop({
        sceneData: defectiveInitialScene,
        targetPrompt: 'Lexington historical green with dawn illumination and framed tavern',
        angles: ['perspective'],
        maxIterations: 3
    });
    assert.strictEqual(gLoopResult.converged, true);
    assert.ok(gLoopResult.finalFidelityScore >= 80);

    console.log('  ✓ Test 6 Passed: GeminiService exposes high-level 3D vision verification APIs.');

    console.log('\n🎉 ALL VIEWPORT VISION VERIFICATION LOOP TESTS COMPLETED SUCCESSFULLY!');
}

test('viewport-vision-verification-loop.test', async () => {
    await runViewportVisionVerificationLoopTests();
}, 180_000);
