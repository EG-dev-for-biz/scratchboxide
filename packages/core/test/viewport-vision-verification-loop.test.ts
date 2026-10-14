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
    VisualVerificationService,
    type VisionModelClient
} from '../src/node/visual-verification-service';
import {
    DEFAULT_VIEWPORT_ANGLES,
    VisualAudit3DDefect,
    MultiAngleVisualAuditResult,
    VisualSelfCorrection3DOptions,
    computeCameraForViewportAngle,
    isVisualAuditUnavailable
} from '../src/common/visual-verification-protocol';
import {
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';
import {
    GeminiService
} from '../src/node/gemini-service';

/**
 * A stand-in for the vision model (the service no longer scores anything itself): it reads the scene sent with the
 * frame and answers the audit JSON a model would, failing an unlit scene with suggested operators and passing a lit
 * one. The service under test only relays this audit and dispatches the operators it names.
 */
function sceneReadingVisionModel(calls: string[] = []): VisionModelClient {
    return {
        getGenAIClient: async () => ({
            models: {
                generateContent: async (req: any) => {
                    const userText: string = req.contents[0].parts[1].text;
                    const scene = JSON.parse(userText.slice(userText.indexOf('{'), userText.lastIndexOf('}') + 1)).sceneData as Scene3DData;
                    calls.push(scene.environment?.lighting || 'none');
                    const lit = !!scene.environment?.lighting && scene.environment.lighting !== 'none';
                    const audit = lit
                        ? { pass: true, fidelityScore: 88, critique: 'Lit and framed.', issues: [], strengths: ['even key light'], defects3D: [] }
                        : {
                            pass: false,
                            fidelityScore: 42,
                            critique: 'The model is unlit.',
                            issues: ['missing scene lighting'],
                            strengths: [],
                            defects3D: [{ defectType: 'unlit', severity: 'critical', description: 'No key light', suggestedOperator: 'sb_setup_lighting', suggestedParams: { preset: 'three-point', ambientIntensity: 0.5 } }]
                        };
                    return { text: JSON.stringify(audit) };
                }
            }
        } as any)
    };
}

async function runViewportVisionVerificationLoopTests() {
    console.log('👁️ Running Viewport Vision Verification Loop Test Suite (Step 3)...\n');

    const visionCalls: string[] = [];
    const visualService = new VisualVerificationService(sceneReadingVisionModel(visionCalls));
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
        environment: { lighting: 'studio', skybox: 'studio' },
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

    const perspCam = computeCameraForViewportAngle('perspective', testScene);
    assert.ok(perspCam.position, 'Perspective camera must have position');
    assert.ok(perspCam.target, 'Perspective camera must have target');
    assert.strictEqual(perspCam.fov, 45);

    const frontCam = computeCameraForViewportAngle('front', testScene);
    assert.strictEqual(frontCam.position[0], 0, 'Front view X must be centered');
    assert.ok(frontCam.position[2] > 0, 'Front view Z must be in front');

    const topCam = computeCameraForViewportAngle('top', testScene);
    assert.ok(topCam.position[1] > 10, 'Top view Y must be elevated above scene');

    const isoCam = computeCameraForViewportAngle('isometric', testScene);
    assert.ok(isoCam.position[0] > 0 && isoCam.position[1] > 0 && isoCam.position[2] > 0, 'Isometric must be 3-axis offset');

    console.log('  ✓ Test 1 Passed: Viewport camera angles compute appropriate positions and targets.');

    // =========================================================================
    // Test 2: The vision model's defects and suggested operators are relayed as they are
    // =========================================================================
    console.log('  Testing 2: Vision audits relay the model\'s 3D defects and operators...');

    const unlitScene: Scene3DData = {
        title: 'Unlit Void Asset',
        renderMode: 'shaded',
        environment: { lighting: 'none' },
        customMeshes: [{ id: 'mesh-unlit-1', type: 'box', position: [0, 0, 0], scale: [2, 2, 2] }]
    };
    const unlitAudit = await visualService.verifyVisual({
        image: samplePngDataUrl,
        prompt: 'Futuristic sci-fi beacon with vibrant lighting and metallic reflections',
        artifactType: '3d-scene',
        context: { sceneData: unlitScene, angle: 'perspective' }
    });
    assert.ok(!isVisualAuditUnavailable(unlitAudit), 'The vision model answered');
    if (isVisualAuditUnavailable(unlitAudit)) return;
    assert.strictEqual(unlitAudit.pass, false, 'Unlit scene fails the model\'s audit');
    assert.strictEqual(unlitAudit.fidelityScore, 42);
    assert.deepStrictEqual(unlitAudit.operatorDispatches, [{ operator: 'sb_setup_lighting', params: { preset: 'three-point', ambientIntensity: 0.5 } }]);
    console.log('  ✓ Test 2 Passed: The model\'s defects map to the operators it suggested.');

    // =========================================================================
    // Test 3: Automated Translation of Visual Defects into Direct-Dispatch 3D Operators
    // =========================================================================
    console.log('  Testing 3: Mapping of Visual Defects to the Operators the Model Suggested...');

    const sampleDefects: VisualAudit3DDefect[] = [
        { defectType: 'unlit', severity: 'critical', description: 'Scene has no lighting preset or ambient intensity', suggestedOperator: 'sb_setup_lighting', suggestedParams: { preset: 'three-point', ambientIntensity: 0.5 } },
        { defectType: 'off_center_camera', severity: 'warning', description: 'Camera target is displaced from object bounds', suggestedOperator: 'sb_frame_bounds', suggestedParams: { paddingFactor: 1.5 } },
        { defectType: 'missing_pbr', severity: 'warning', description: 'Object mesh-hovercraft lacks PBR metallic roughness properties', targetObjectId: 'mesh-hovercraft', suggestedOperator: 'sb_set_material_pbr', suggestedParams: { objectId: 'mesh-hovercraft', roughness: 0.3, metalness: 0.8, color: 0x00e5ff } },
        { defectType: 'unsubdivided_mesh', severity: 'info', description: 'Low polygon density causes blocky facet artifacts', targetObjectId: 'mesh-hovercraft', suggestedOperator: 'sb_subdivide_mesh', suggestedParams: { objectId: 'mesh-hovercraft', iterations: 1 } },
        // No suggested operator: the service invents none (it used to add a blue PBR material here).
        { defectType: 'missing_material', severity: 'warning', description: 'Plain grey mesh', targetObjectId: 'mesh-hovercraft' }
    ];

    const mappedOperators = visualService.mapDefectsToOperators(sampleDefects);
    assert.deepStrictEqual(mappedOperators.map(o => o.operator), ['sb_setup_lighting', 'sb_frame_bounds', 'sb_set_material_pbr', 'sb_subdivide_mesh']);
    console.log('  ✓ Test 3 Passed: Defects map to the operators the model suggested, and to nothing else.');

    // =========================================================================
    // Test 4: Multi-Angle Viewport Audit (audit3DSceneMultiAngle)
    // =========================================================================
    console.log('  Testing 4: Multi-Angle Viewport Audit across 4 Canonical Projections...');

    const capturedAngles: string[] = [];
    const multiAngleOutcome = await visualService.audit3DSceneMultiAngle({
        sceneData: testScene,
        prompt: 'Futuristic articulated cyberpunk hovercraft with high-tech materials and cinematic lighting',
        angles: ['perspective', 'front', 'top', 'isometric'],
        captureAngleFrame: angle => {
            capturedAngles.push(angle);
            return samplePngDataUrl;
        }
    });
    assert.ok(!isVisualAuditUnavailable(multiAngleOutcome), 'Every angle was audited');
    const multiAngleAudit = multiAngleOutcome as MultiAngleVisualAuditResult;
    assert.deepStrictEqual(capturedAngles, ['perspective', 'front', 'top', 'isometric']);
    for (const angle of capturedAngles) assert.ok(multiAngleAudit.angleResults[angle], `Must have ${angle} audit`);
    assert.strictEqual(multiAngleAudit.averageFidelityScore, 88);
    assert.strictEqual(multiAngleAudit.overallPass, true);

    // Without a capture no angle is rendered, so the audit is unavailable (no stand-in frame is inspected).
    const noCapture = await visualService.audit3DSceneMultiAngle({ sceneData: testScene, prompt: 'hovercraft', angles: ['perspective'] });
    assert.ok(isVisualAuditUnavailable(noCapture), 'No capture, no audit');
    console.log('  ✓ Test 4 Passed: Multi-angle audit inspects every captured viewport, and none without a capture.');

    // =========================================================================
    // Test 5: Multi-Turn Iterative 3D Self-Correction Loop (run3DVisualSelfCorrectionLoop)
    // =========================================================================
    console.log('  Testing 5: Iterative 3D Visual Self-Correction Loop with Direct Operator Engine...');

    const defectiveInitialScene: Scene3DData = {
        title: 'Colonial Lexington Militia Post',
        renderMode: 'shaded',
        environment: { lighting: 'none', skybox: undefined },
        camera: { position: [100, 50, 100], target: [80, 50, 80], fov: 60 },
        customMeshes: [{ id: 'mesh-tavern-post', name: 'Buckman Tavern Post', type: 'box', position: [0, 0, 0], scale: [6, 4, 8] }]
    };

    const loopOptions: VisualSelfCorrection3DOptions = {
        sceneData: defectiveInitialScene,
        targetPrompt: 'Colonial American historical Buckman Tavern at Lexington Green',
        angles: ['perspective', 'front', 'isometric'],
        captureAngleFrame: () => samplePngDataUrl,
        maxIterations: 4,
        minPassingScore: 80,
        autoDispatch: true
    };

    const loopResult = await visualService.run3DVisualSelfCorrectionLoop(loopOptions);
    assert.strictEqual(loopResult.converged, true, 'Visual self-correction loop converges once the model passes the scene');
    assert.strictEqual(loopResult.repaired, true, 'Must report repaired: true');
    assert.strictEqual(loopResult.iterations, 2);
    assert.strictEqual(loopResult.initialFidelityScore, 42);
    assert.strictEqual(loopResult.finalFidelityScore, 88);
    assert.deepStrictEqual(loopResult.executedOperators.map(o => o.operator), ['sb_setup_lighting'], 'Only the operator the model suggested ran');

    const finalScene = loopResult.sceneData;
    assert.ok(finalScene.environment?.lighting && finalScene.environment.lighting !== 'none', 'Lighting must be restored');
    assert.deepStrictEqual((finalScene.operatorStack || []).map(op => op.operator), ['sb_setup_lighting']);
    console.log('  ✓ Test 5 Passed: The loop dispatches the model\'s suggested fixes until the model passes the scene.');

    // =========================================================================
    // Test 6: GeminiService 3D Viewport Vision Verification Integration
    // =========================================================================
    console.log('  Testing 6: GeminiService 3D Vision Verification API Integration...');

    const geminiService = new GeminiService();
    // No capture function is passed, so these return before any vision call (no live request from a test).
    const gMultiAudit = await geminiService.audit3DSceneMultiAngle({ sceneData: testScene, prompt: 'hovercraft', angles: ['perspective', 'front'] });
    assert.ok(isVisualAuditUnavailable(gMultiAudit));
    const gLoopResult = await geminiService.run3DVisualSelfCorrectionLoop({ sceneData: defectiveInitialScene, targetPrompt: 'tavern', angles: ['perspective'], maxIterations: 3 });
    assert.strictEqual(gLoopResult.converged, false);
    assert.ok(gLoopResult.visionUnavailable, 'The loop says why it did not run');
    assert.deepStrictEqual(gLoopResult.executedOperators, []);
    console.log('  ✓ Test 6 Passed: GeminiService exposes the 3D vision verification APIs and reports when they cannot run.');

    console.log('\n🎉 ALL VIEWPORT VISION VERIFICATION LOOP TESTS COMPLETED SUCCESSFULLY!');
}

test('viewport-vision-verification-loop.test', async () => {
    await runViewportVisionVerificationLoopTests();
}, 180_000);
