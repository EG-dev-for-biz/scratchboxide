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
    morphScene3DToSandbox,
    morphSandboxToScene3D,
    morphArtifact
} from '../src/browser/generative-canvas/primitive-transformer-engine';
import {
    CanvasArtifact,
    Scene3DData,
    LiveCodeSandboxData
} from '../src/browser/generative-canvas/canvas-types';

async function runScene3DSandboxTests() {
    console.log('🧪 Running 3D Viewport & Live Code Sandbox Bi-Directional Bridge Tests...');

    const sampleScene: Scene3DData = {
        title: '3D Jet Flight Simulation',
        subtitle: 'High-altitude procedural jet transit with atmospheric dynamics',
        worldBranch: 'earth/flight-corridor',
        renderMode: 'pbr',
        cameraMode: 'orbit',
        camera: { position: [15, 12, 20], target: [0, 2, 0] },
        environment: { skybox: 'realistic-sky', lighting: 'daylight', ground: true },
        objects: [
            {
                id: 'obj-plane',
                content: {
                    type: '3d-scene',
                    durableUri: 'internal:plane',
                    mimeType: 'model/procedural-aircraft'
                },
                space: { spatial3d: { x: 0, y: 3.5, z: 0 } },
                time: { startMs: 0, durationMs: 10000 }
            }
        ],
        timeline: { isPlaying: true, currentTimeMs: 0, durationMs: 10000 }
    };

    // Test 1: Morph 3D Scene into Multi-File Live Code Sandbox
    console.log('  Testing morphScene3DToSandbox...');
    const sandboxData = morphScene3DToSandbox(sampleScene);
    assert.ok(sandboxData, 'Sandbox data must be generated');
    assert.strictEqual(sandboxData.template, 'react');
    assert.ok(sandboxData.files.length >= 3, 'Must contain at least App.tsx, scene.ts, and aircraft.ts');
    
    const appFile = sandboxData.files.find(f => f.name === 'App.tsx');
    const sceneFile = sandboxData.files.find(f => f.name === 'scene.ts');
    const aircraftFile = sandboxData.files.find(f => f.name === 'aircraft.ts');
    const physicsFile = sandboxData.files.find(f => f.name === 'physics.ts');

    assert.ok(appFile && appFile.content.includes('THREE'), 'App.tsx must include Three.js canvas setup');
    assert.ok(sceneFile && sceneFile.content.includes('createAtmosphericScene'), 'scene.ts must contain scene setup');
    assert.ok(aircraftFile && aircraftFile.content.includes('createAirplaneMesh'), 'aircraft.ts must contain procedural airplane generation');
    assert.ok(physicsFile && physicsFile.content.includes('updateFlightPhysics'), 'physics.ts must contain flight aerodynamics');
    console.log('  ✓ Test 1 Passed: 3D Scene successfully morphed into editable multi-file Three.js code sandbox');

    // Test 2: Morph Code Sandbox back into 3D Scene Data
    console.log('  Testing morphSandboxToScene3D...');
    const backToScene = morphSandboxToScene3D(sandboxData);
    assert.ok(backToScene, '3D Scene data must be extracted from sandbox');
    assert.strictEqual(backToScene.renderMode, 'pbr');
    assert.strictEqual(backToScene.environment?.skybox, 'realistic-sky');
    assert.ok(backToScene.title.includes('3D') || backToScene.title.includes('Jet'), 'Title must be preserved or inferred');
    console.log('  ✓ Test 2 Passed: Live Code Sandbox successfully converted back to 3D Scene visual data');

    // Test 3: Universal morphArtifact polymorphic routing
    console.log('  Testing universal morphArtifact dispatcher for 3D <-> Sandbox...');
    const sceneArtifact: CanvasArtifact = {
        id: 'art-3d-test',
        title: sampleScene.title,
        summary: sampleScene.subtitle || '3D Jet Simulation',
        type: '3d-scene',
        version: 1,
        createdAt: new Date().toLocaleTimeString(),
        data: sampleScene
    };

    const morphedToSandbox = morphArtifact(sceneArtifact, 'live-code-sandbox');
    assert.strictEqual(morphedToSandbox.type, 'live-code-sandbox');
    assert.ok((morphedToSandbox.data as LiveCodeSandboxData).files.length >= 3);

    const morphedBackTo3D = morphArtifact(morphedToSandbox, '3d-scene');
    assert.strictEqual(morphedBackTo3D.type, '3d-scene');
    assert.strictEqual((morphedBackTo3D.data as Scene3DData).renderMode, 'pbr');
    console.log('  ✓ Test 3 Passed: Universal morphArtifact successfully bridges 3d-scene and live-code-sandbox');

    console.log('🎉 ALL 3D VIEWPORT & CODE SANDBOX TESTS PASSED SUCCESSFULLY!\n');
}

runScene3DSandboxTests().catch(err => {
    console.error('❌ Tests failed:', err);
    process.exit(1);
});
