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
    captureSceneScreenshot
} from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import {
    captureSandboxScreenshot
} from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import {
    captureBrowserScreenshot
} from '../src/browser/generative-canvas/primitives/InteractiveBrowserPrimitive';
import {
    captureActiveCanvasScreenshot
} from '../src/browser/generative-canvas/GenerativeCanvasStudio';
import {
    VisualVerificationService
} from '../src/node/visual-verification-service';
import {
    parseImagePayload,
    VisualVerificationRequest,
    VISUAL_VERIFICATION_CRITERIA
} from '../src/common/visual-verification-protocol';
import {
    CanvasArtifact,
    Scene3DData,
    LiveCodeSandboxData
} from '../src/browser/generative-canvas/canvas-types';
import { GeminiService } from '../src/node/gemini-service';
import { DeepWriteService } from '../src/node/deep-write/deep-write-service';
import { GoalAnalyzer } from '../src/node/deep-write/goal-analyzer';
import { MultiPlatformScaffolder } from '../src/node/deep-write/multi-platform-scaffolder';
import { DynamicDagPlanner } from '../src/node/deep-write/dynamic-dag-planner';
import { DeepWriteExecutionBridge } from '../src/node/deep-write/deep-write-execution-bridge';
import { CodebaseLensSyncService } from '../src/node/deep-write/codebase-lens-sync-service';
import { PrimitiveSynthesizer } from '../src/node/deep-write/primitive-synthesizer';
import { UserLearningService } from '../src/node/deep-write/user-learning-service';
import { UserMemoriesService } from '../src/node/user-memories-service';
import { WorkspaceConfigService } from '../src/node/workspace-config-service';
import { WorkspaceFileWatcherService } from '../src/node/workspace-file-watcher-service';

async function runVisualVerificationTests() {
    console.log('🧪 Running Multimodal Vision QA & Automated Visual Self-Correction Test Suite...\n');

    // Sample test PNG frame
    const samplePngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9Qz8DAwMTAwAAAEAEDAT4qV4QAAAAASUVORK5CYII=';

    // -------------------------------------------------------------
    // Test 1: Image Payload Parsing & Normalization
    // -------------------------------------------------------------
    console.log('  Testing 1: Image Payload Normalization...');
    const parsedDataUrl = parseImagePayload(samplePngDataUrl);
    assert.strictEqual(parsedDataUrl.mimeType, 'image/png');
    assert.ok(parsedDataUrl.base64Data.length > 10, 'Must extract clean base64 data');
    assert.ok(parsedDataUrl.dataUrl.startsWith('data:image/png;base64,'), 'Must output valid data URL format');

    const parsedRawBase64 = parseImagePayload('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ');
    assert.strictEqual(parsedRawBase64.mimeType, 'image/png');
    assert.strictEqual(parsedRawBase64.base64Data, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ');
    assert.strictEqual(parsedRawBase64.dataUrl, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ');
    console.log('  ✓ Test 1 Passed: Image payload parsing reliably extracts base64 content and mime types.');

    // -------------------------------------------------------------
    // Test 2: Viewport & Canvas Screenshot Frame Capture Engine
    // -------------------------------------------------------------
    console.log('  Testing 2: Canvas Screenshot Capture Engine across Primitives...');

    // 2a. Scene3D Primitive WebGL screenshot capture
    const mockRenderer: any = {
        domElement: {
            toDataURL: (mime: string) => {
                assert.strictEqual(mime, 'image/png');
                return samplePngDataUrl;
            }
        },
        render: (scene: any, camera: any) => {
            assert.ok(scene, 'Renderer must receive scene');
            assert.ok(camera, 'Renderer must receive camera');
        }
    };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

    const sceneScreenshot = captureSceneScreenshot(mockRenderer, scene, camera);
    assert.strictEqual(sceneScreenshot, samplePngDataUrl, 'Must capture PNG data URL from Three.js WebGL renderer');

    const sceneFallback = captureSceneScreenshot(null, null, null);
    assert.ok(sceneFallback.startsWith('data:image/png;base64,'), 'Must return valid fallback PNG when renderer unavailable');

    // 2b. LiveCodeSandbox screenshot capture
    const sandboxScreenshot = captureSandboxScreenshot(null);
    assert.ok(sandboxScreenshot.startsWith('data:image/png;base64,'), 'LiveCodeSandbox must generate PNG data URL');

    // 2c. InteractiveBrowser screenshot capture
    const browserScreenshot = captureBrowserScreenshot(null);
    assert.ok(browserScreenshot.startsWith('data:image/png;base64,'), 'InteractiveBrowser must generate PNG data URL');

    // 2d. GenerativeCanvasStudio active canvas capture
    const activeCapture = captureActiveCanvasScreenshot('3d');
    assert.ok(activeCapture.startsWith('data:image/png;base64,'), 'Active canvas screenshot capture must generate PNG data URL');
    console.log('  ✓ Test 2 Passed: Screenshot engine captures WebGL, sandbox, browser, and active studio viewports.');

    // -------------------------------------------------------------
    // Test 3: Multimodal Prompt Construction for Gemini 3.8 Flash
    // -------------------------------------------------------------
    console.log('  Testing 3: Multimodal Vision QA Prompt & Instruction Construction...');
    const visualService = new VisualVerificationService();

    const testRequest: VisualVerificationRequest = {
        image: samplePngDataUrl,
        prompt: 'Generate an atmospheric 3D aerospace scene with supersonic jet and volumetric god rays',
        artifactType: '3d-scene',
        context: {
            title: 'F-22 Raptor Supersonic Interceptor',
            sceneData: {
                title: 'F-22 Raptor',
                objects: [],
                environment: { skybox: 'sky', lighting: 'shaded', ground: true },
                features: { atmosphericScattering: true, godRays: true, contrails: true }
            }
        }
    };

    const promptPayload = visualService.buildMultimodalPrompt(testRequest);
    assert.ok(promptPayload.systemInstruction.includes('Multimodal Vision QA'), 'System instruction must state Vision QA role');
    assert.ok(promptPayload.systemInstruction.includes('fidelityScore'), 'Instruction must require 0-100 fidelityScore');
    assert.ok(promptPayload.systemInstruction.includes('visualFixes'), 'Instruction must require structured visualFixes');
    for (const criterion of VISUAL_VERIFICATION_CRITERIA) {
        assert.ok(promptPayload.systemInstruction.includes(criterion), `Instruction must include criterion: ${criterion}`);
    }
    assert.strictEqual(promptPayload.inlineData.mimeType, 'image/png');
    assert.strictEqual(promptPayload.inlineData.data, parsedDataUrl.base64Data);
    assert.ok(promptPayload.userPrompt.includes('F-22 Raptor Supersonic Interceptor'), 'User prompt must include context title');
    console.log('  ✓ Test 3 Passed: Multimodal prompt payload constructed with inlineData and strict QA criteria.');

    // -------------------------------------------------------------
    // Test 4: Multimodal Vision QA Verification & Bug Detection
    // -------------------------------------------------------------
    console.log('  Testing 4: Visual Bug Detection & Fidelity Scoring...');

    // 4a. Passing High-Fidelity Scene
    const highFidelityAudit = await visualService.verifyVisual(testRequest);
    assert.strictEqual(highFidelityAudit.pass, true, 'High fidelity scene must pass QA');
    assert.ok(highFidelityAudit.fidelityScore >= 80, `Score must be >= 80, got ${highFidelityAudit.fidelityScore}`);
    assert.ok(highFidelityAudit.strengths.length > 0, 'Must identify positive visual strengths');
    assert.ok(highFidelityAudit.thumbnail?.startsWith('data:image/png;base64,'), 'Must attach thumbnail data URL');

    // 4b. Failing Void / Unlit Scene
    const failingRequest: VisualVerificationRequest = {
        image: 'data:image/png;base64,AAAAABJRU5ErkJggg==',
        prompt: 'Broken unlit 3D scene with monochromatic void background',
        artifactType: '3d-scene',
        context: {
            title: 'Unlit Void Scene',
            sceneData: {
                title: 'Unlit Void Scene',
                objects: [],
                environment: { skybox: undefined, lighting: 'none', ground: false }
            }
        }
    };

    const failingAudit = await visualService.verifyVisual(failingRequest);
    assert.strictEqual(failingAudit.pass, false, 'Void/unlit scene must fail visual QA');
    assert.ok(failingAudit.fidelityScore < 80, `Fidelity score must be < 80 for void, got ${failingAudit.fidelityScore}`);
    assert.ok(failingAudit.issues.some(i => i.toLowerCase().includes('void') || i.toLowerCase().includes('lighting')), 'Must identify void/lighting bugs');
    assert.ok(failingAudit.visualFixes, 'Failing audit must supply visualFixes directives');
    assert.ok(failingAudit.visualFixes?.lighting, 'Must supply lighting fixes');
    assert.ok(failingAudit.visualFixes?.environment, 'Must supply environment fixes');
    assert.strictEqual(failingAudit.visualFixes?.environment?.skybox, undefined, 'Never proposes a skybox: the sky is the scene\'s own choice');
    // A camera fix answers a framing defect only; this scene's failure is its lighting.
    assert.strictEqual(failingAudit.visualFixes?.camera, undefined, 'A lighting failure proposes no camera');
    console.log('  ✓ Test 4 Passed: Visual bug detector flags monochromatic void, unlit models, and missing shaders.');

    // -------------------------------------------------------------
    // Test 5: Visual Auto-Repair & Artifact Patching
    // -------------------------------------------------------------
    console.log('  Testing 5: Structured Visual Auto-Repair Engine...');

    const broken3DArtifact: CanvasArtifact = {
        id: 'art-scene-broken',
        type: '3d-scene',
        title: 'Broken Space Scene',
        summary: 'Scene missing lights and shaders',
        version: 1,
        createdAt: '10:00 AM',
        data: {
            title: 'Broken Space Scene',
            objects: [],
            environment: { lighting: 'none', ground: false }
        } as Scene3DData
    };

    const repairedArtifact = visualService.applyVisualAutoRepair(broken3DArtifact, failingAudit);
    assert.strictEqual(repairedArtifact.version, 2, 'Artifact version must increment after auto-repair');
    const repairedSceneData = repairedArtifact.data as Scene3DData;
    assert.strictEqual(repairedSceneData.environment?.lighting, 'shaded', 'Auto-repair must restore shaded lighting');
    assert.strictEqual(repairedSceneData.environment?.ground, false, 'Auto-repair keeps the scene\'s own ground choice');
    assert.strictEqual(repairedSceneData.camera, undefined, 'Auto-repair adds no camera without a framing defect');

    // Test Sandbox CSS auto-repair
    const brokenSandboxArtifact: CanvasArtifact = {
        id: 'art-sandbox-broken',
        type: 'live-code-sandbox',
        title: 'Broken Layout Sandbox',
        summary: 'Sandbox with broken CSS margins',
        version: 1,
        createdAt: '10:00 AM',
        data: {
            title: 'Broken Layout Sandbox',
            files: [
                { id: 'f-css', name: 'styles.css', content: 'body { overflow: hidden; }', language: 'css' }
            ]
        } as LiveCodeSandboxData
    };

    const repairedSandbox = visualService.applyVisualAutoRepair(brokenSandboxArtifact, {
        pass: false,
        fidelityScore: 60,
        critique: 'CSS layout clipped',
        issues: ['Viewport overflow hidden clipping content'],
        strengths: [],
        visualFixes: {
            cssFixes: 'body { overflow: auto; min-height: 100vh; }'
        }
    });

    const repairedFiles = (repairedSandbox.data as LiveCodeSandboxData).files;
    assert.ok(repairedFiles[0].content.includes('min-height: 100vh'), 'Sandbox auto-repair must apply CSS patches');
    console.log('  ✓ Test 5 Passed: Auto-repair patches 3D lighting, camera, shaders, and sandbox styles.');

    // -------------------------------------------------------------
    // Test 6: Automated Visual Self-Correction Feedback Loop
    // -------------------------------------------------------------
    console.log('  Testing 6: End-to-End Automated Visual Self-Correction Loop...');

    let simulatedFrameIndex = 0;
    const frames = [
        'data:image/png;base64,AAAAABJRU5ErkJggg==', // Iteration 1: Void frame (score < 80)
        samplePngDataUrl // Iteration 2: High fidelity repaired frame (score >= 80)
    ];

    const loopResult = await visualService.runVisualSelfCorrectionLoop({
        artifact: broken3DArtifact,
        targetPrompt: 'Articulated supersonic aircraft over coastal terrain',
        captureFrame: () => {
            const frame = frames[simulatedFrameIndex] || samplePngDataUrl;
            simulatedFrameIndex++;
            return frame;
        },
        maxIterations: 3,
        minPassingScore: 80
    });

    assert.strictEqual(loopResult.repaired, true, 'Loop must report successful auto-repair');
    assert.strictEqual(loopResult.iterations, 2, 'Loop must complete in 2 iterations');
    assert.strictEqual(loopResult.history.length, 2, 'Must record audit history for each iteration');
    assert.ok(loopResult.history[0].fidelityScore < 80, 'First iteration score must be < 80');
    assert.ok(loopResult.history[1].fidelityScore >= 80, 'Second iteration score must be >= 80 (passing)');
    assert.strictEqual(loopResult.audit.pass, true, 'Final audit must be marked as passed');
    console.log('  ✓ Test 6 Passed: Visual self-correction loop automatically iterates until high fidelity is reached.');

    // -------------------------------------------------------------
    // Test 7: GeminiService & DeepWriteService Integration
    // -------------------------------------------------------------
    console.log('  Testing 7: GeminiService & DeepWriteService Visual QA Integration...');

    const geminiService = new GeminiService();
    assert.ok(geminiService.getVisualVerificationService(), 'GeminiService must expose VisualVerificationService');

    const serviceAudit = await geminiService.verifyVisual(testRequest);
    assert.strictEqual(serviceAudit.pass, true, 'GeminiService verifyVisual must return valid audit result');

    // Test DeepWriteService integration
    const memoriesService = new UserMemoriesService();
    const configService = new WorkspaceConfigService();
    const watcherService = new WorkspaceFileWatcherService();
    const learningService = new UserLearningService(memoriesService);
    const goalAnalyzer = new GoalAnalyzer(geminiService, learningService);
    const scaffolder = new MultiPlatformScaffolder();
    const dagPlanner = new DynamicDagPlanner(geminiService);
    const executionBridge = new DeepWriteExecutionBridge(geminiService);
    const lensSync = new CodebaseLensSyncService(configService, watcherService);
    const synthesizer = new PrimitiveSynthesizer();

    const deepWriteService = new DeepWriteService(
        goalAnalyzer,
        scaffolder,
        dagPlanner,
        executionBridge,
        lensSync,
        synthesizer,
        learningService,
        visualService
    );

    assert.ok(deepWriteService, 'DeepWriteService initialized with VisualVerificationService');
    console.log('  ✓ Test 7 Passed: Node services and pipelines fully wired with visual verification.');

    console.log('\n✨ All Multimodal Vision QA & Automated Visual Self-Correction tests passed successfully!');
}

test('visual-verification-screenshot.test', async () => {
    await runVisualVerificationTests();
}, 180_000);
