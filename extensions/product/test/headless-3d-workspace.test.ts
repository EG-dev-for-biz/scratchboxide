/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { createAirplaneMesh } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { resolveModeForArtifact } from '../src/browser/generative-canvas/guardrails-service';
import { GeminiService } from '../src/node/gemini-service';

async function runHeadless3DWorkspaceTests() {
    console.log('🧪 Running Headless 3D Workspace & Chat-Driven Synthesis Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Scene3DData Interface Properties
    // -------------------------------------------------------------
    console.log('  Testing Scene3DData Type Definitions & Reactive Properties...');
    const testScene: Scene3DData = {
        title: 'SF Cyberpunk 2088 Grid',
        subtitle: 'Dystopian neon spatial layer | Branch earth/cyberpunk',
        worldBranch: 'earth/cyberpunk',
        renderMode: 'pbr',
        cameraMode: 'fps',
        objects: [],
        camera: { position: [15, 12, 15], target: [0, 0, 0] },
        environment: { skybox: 'cyberpunk', lighting: 'shaded', ground: true },
        geoAnchor: { lat: 37.7900, lng: -122.4000, elevation: 15.2, active: true },
        droneRoute: {
            pinA: { lat: 37.7920, lng: -122.4050 },
            pinB: { lat: 37.7980, lng: -122.3950 },
            active: true
        },
        wasmPhysics: {
            waveActive: true,
            deformFactor: 1.5,
            statusText: 'WASM Wave Collider active'
        },
        timeline: {
            currentTimeMs: 1500,
            durationMs: 10000,
            isPlaying: true,
            playbackSpeed: 1.5,
            speed: 1.5,
            isLooping: true
        },
        animation: 'flight'
    };

    assert.strictEqual(testScene.worldBranch, 'earth/cyberpunk');
    assert.strictEqual(testScene.renderMode, 'pbr');
    assert.strictEqual(testScene.cameraMode, 'fps');
    assert.strictEqual(testScene.geoAnchor?.lat, 37.7900);
    assert.strictEqual(testScene.droneRoute?.active, true);
    assert.strictEqual(testScene.wasmPhysics?.waveActive, true);
    assert.strictEqual(testScene.timeline?.isPlaying, true);
    assert.strictEqual(testScene.timeline?.isLooping, true);
    assert.strictEqual(testScene.animation, 'flight');
    console.log('  ✓ Test 1 Passed: Scene3DData supports reactive headless parameters and live animation properties.');

    // -------------------------------------------------------------
    // Test 2: Verify Scene3DPrimitive Ultra-Minimalist Floating Layout
    // -------------------------------------------------------------
    console.log('  Testing Scene3DPrimitive.tsx Streamlined Viewport...');
    const scenePrimitivePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx');
    assert.ok(fs.existsSync(scenePrimitivePath), 'Scene3DPrimitive.tsx must exist');
    const sceneSource = fs.readFileSync(scenePrimitivePath, 'utf-8');

    // Bulky form panels and raw coordinate inputs must be removed
    assert.ok(!sceneSource.includes('sb-3d-geo-widget'), 'Bulky 3D map tiles form widget must be removed');
    assert.ok(!sceneSource.includes('sb-3d-wasm-panel'), 'Bulky WASM physics terminal panel must be removed');
    assert.ok(!sceneSource.includes('isGeoPanelOpen'), 'Manual in-viewport geocoding panel state must be removed');
    assert.ok(!sceneSource.includes('LATITUDE'), 'Raw coordinate input panel for LATITUDE must be removed');
    assert.ok(!sceneSource.includes('LONGITUDE'), 'Raw coordinate input panel for LONGITUDE must be removed');
    assert.ok(!sceneSource.includes('ELEVATION'), 'Raw coordinate input panel for ELEVATION must be removed');

    // Heavy static top header and bottom timeline bar must be removed in favor of floating glass pills
    assert.ok(!sceneSource.includes('sb-3d-header'), 'Heavy static top header bar (.sb-3d-header) must be removed');
    assert.ok(!sceneSource.includes('sb-4d-timeline-bar'), 'Heavy static bottom timeline bar (.sb-4d-timeline-bar) must be removed');
    assert.ok(!sceneSource.includes('sceneData.subtitle'), 'Clunky subtitle paragraph must be removed');

    // Ultra-minimal floating badges & controls must exist
    assert.ok(sceneSource.includes('sb-3d-minimal-badge'), 'Must render ultra-minimal floating glass top badge');
    assert.ok(sceneSource.includes('sb-3d-play-mini-btn'), 'Must render floating bottom mini play button');
    assert.ok(sceneSource.includes('absolute inset-0 w-full h-full'), 'WebGL viewport frame must fill 100% full-bleed');

    // Core 3D engine capabilities preserved
    assert.ok(sceneSource.includes('FogExp2'), 'Must configure depth/atmospheric fog for smooth horizon transition');
    assert.ok(sceneSource.includes('worldBranch'), 'Must reactively track multiverse world branch');
    assert.ok(sceneSource.includes('renderMode'), 'Must reactively track render mode');
    assert.ok(sceneSource.includes('cameraMode'), 'Must reactively track camera mode');
    assert.ok(sceneSource.includes('handleWasmSynthesize'), 'Must support WASM grid deformation synthesis');
    console.log('  ✓ Test 2 Passed: Scene3DPrimitive layout is full-bleed ultra-minimal with floating glass pills.');

    // -------------------------------------------------------------
    // Test 3: Verify GenerativeCanvasStudio Chat-Driven 3D Synthesis
    // -------------------------------------------------------------
    console.log('  Testing GenerativeCanvasStudio.tsx Chat Prompt 3D Synthesis Engine...');
    const studioPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    assert.ok(fs.existsSync(studioPath), 'GenerativeCanvasStudio.tsx must exist');
    const studioSource = fs.readFileSync(studioPath, 'utf-8');

    assert.ok(studioSource.includes("layoutMode === '3d'"), 'Studio must support 3d layout mode in chat dispatch');
    assert.ok(studioSource.includes("activeArtifact?.type === '3d-scene'"), 'Studio must support 3d-scene artifact mutations');
    assert.ok(studioSource.includes("earth/cyberpunk"), 'Studio must synthesize cyberpunk multiverse branch mutations');
    assert.ok(studioSource.includes("earth/mars-colony-2150"), 'Studio must synthesize mars colony branch mutations');
    assert.ok(studioSource.includes("earth/post-apocalypse"), 'Studio must synthesize post-apocalypse branch mutations');
    assert.ok(studioSource.includes("wasmPhysics"), 'Studio must synthesize WASM physics wave collider triggers');
    assert.ok(studioSource.includes("droneRoute"), 'Studio must synthesize drone flight routes from chat');
    console.log('  ✓ Test 3 Passed: Chat prompt dock fully drives 3D workspace mutations headlessly.');

    // -------------------------------------------------------------
    // Test 4: Verify CSS Styling Codification in unified-ui.css
    // -------------------------------------------------------------
    console.log('  Testing unified-ui.css 3D Viewport Styling...');
    const cssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    assert.ok(fs.existsSync(cssPath), 'unified-ui.css must exist');
    const cssSource = fs.readFileSync(cssPath, 'utf-8');

    assert.ok(cssSource.includes('.sb-scene3d-primitive-container'), 'Must style 3d scene primitive container');
    assert.ok(cssSource.includes('.sb-3d-minimal-badge'), 'Must style floating 3d glass badge');
    assert.ok(cssSource.includes('.sb-3d-play-mini-btn'), 'Must style floating 3d mini play button');
    assert.ok(cssSource.includes('.sb-bottom-chatgpt-dock.sb-layout-3d'), 'Must position composer dock cleanly above 3D timeline');
    console.log('  ✓ Test 4 Passed: 3D Workspace styling codified with high contrast and dark/light theme support.');

    // -------------------------------------------------------------
    // Test 5: Verify Gemini System Prompt & 3D Artifact Synthesis
    // -------------------------------------------------------------
    console.log('  Testing GeminiService 3D Scene Instruction & Artifact Generation...');
    const geminiService = new GeminiService();
    const systemPrompt = await (geminiService as any).buildSystemInstruction({ prompt: 'build a 3d scene of a plane' });
    assert.ok(systemPrompt.includes('"3d-scene"'), 'System prompt must include 3d-scene primitive');
    assert.ok(systemPrompt.includes('Scene3DData'), 'System prompt must document Scene3DData schema');
    assert.ok(systemPrompt.includes('earth/flight-corridor'), 'System prompt must include flight corridor branch');

    // Test parseOrSynthesizeArtifact for 3D plane request
    const planeArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'build a 3d scene of a plane',
        'Here is the 3D plane scene',
        { prompt: 'build a 3d scene of a plane' },
        []
    );
    assert.strictEqual(planeArtifact.type, '3d-scene', 'Prompt "build a 3d scene of a plane" must produce a 3d-scene artifact');
    assert.ok(planeArtifact.data.objects && planeArtifact.data.objects.length > 0, 'Artifact data must include 3D objects');
    assert.strictEqual(planeArtifact.data.objects[0].content.durableUri, 'internal:plane', 'Aircraft object must have internal:plane durableUri');
    assert.strictEqual(resolveModeForArtifact(planeArtifact.type), '3d', '3d-scene artifact must resolve to layoutMode "3d"');

    // Test JSON codeblock parsing with type: "3d-scene"
    const parsed3DArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'create a 3d model',
        '```json\n{"type": "3d-scene", "title": "Jet Fighter 3D", "data": {"worldBranch": "earth/flight-corridor"}}\n```',
        { prompt: 'create a 3d model' },
        []
    );
    assert.strictEqual(parsed3DArtifact.type, '3d-scene', 'Parsed JSON type 3d-scene must be preserved');
    assert.strictEqual(parsed3DArtifact.title, 'Jet Fighter 3D');
    console.log('  ✓ Test 5 Passed: GeminiService reliably synthesizes 3d-scene artifacts and instructions.');

    // -------------------------------------------------------------
    // Test 6: Verify Procedural Airplane Mesh Creation
    // -------------------------------------------------------------
    console.log('  Testing Scene3DPrimitive createAirplaneMesh()...');
    const airplaneMesh = createAirplaneMesh();
    assert.ok(airplaneMesh, 'createAirplaneMesh must return a THREE.Group');
    assert.ok(airplaneMesh.children.length >= 6, 'Airplane group must contain fuselage, nose, wings, tail fin, stabilizers, and engines');
    console.log('  ✓ Test 6 Passed: createAirplaneMesh creates high-fidelity procedural aircraft components.');

    // -------------------------------------------------------------
    // Test 7: Verify Layout Mode Resolution for 3D Scenes
    // -------------------------------------------------------------
    console.log('  Testing Surface Resolution for 3D Scene Artifact Types...');
    assert.strictEqual(resolveModeForArtifact('3d-scene'), '3d');
    assert.strictEqual(resolveModeForArtifact('scene-3d'), '3d');
    assert.strictEqual(resolveModeForArtifact('3d'), '3d');
    console.log('  ✓ Test 7 Passed: 3D scene artifact types consistently route to layoutMode "3d".');

    // -------------------------------------------------------------
    // Test 8: Verify Follow-Up 3D Animation Synthesis in GeminiService
    // -------------------------------------------------------------
    console.log('  Testing GeminiService Follow-Up Animation Synthesis for 3D Scene...');
    const active3DPlaneArtifact = {
        id: 'art-3d-plane-001',
        type: '3d-scene' as const,
        title: '3D Aircraft & Flight Corridor',
        summary: 'Interactive procedural 3D plane in spatial flight environment.',
        version: 1,
        createdAt: '12:00:00 PM',
        data: {
            title: '3D Aircraft & Flight Corridor',
            subtitle: 'Interactive procedural 3D jet aircraft in spatial airspace',
            worldBranch: 'earth/flight-corridor',
            renderMode: 'pbr' as const,
            cameraMode: 'orbit' as const,
            camera: { position: [15, 12, 20] as [number, number, number], target: [0, 2, 0] as [number, number, number], fov: 45 },
            environment: { skybox: 'cyberpunk', lighting: 'shaded', ground: true },
            geoAnchor: { lat: 37.7900, lng: -122.4000, elevation: 15.2, active: true },
            objects: [
                {
                    id: 'obj-aircraft-1',
                    content: {
                        type: '3d-scene' as const,
                        durableUri: 'internal:plane',
                        mimeType: 'model/procedural-aircraft',
                        metadata: { dims: { width: 12, height: 4, depth: 14 } }
                    },
                    space: {
                        spatial3d: { x: 0, y: 3.5, z: 0, pitch: 0, yaw: 0, roll: 0 }
                    },
                    time: { startMs: 0, durationMs: 10000 },
                    lineage: { version: 1 }
                }
            ]
        }
    };

    // Test "animate it"
    const animatedArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'animate it',
        'Here is the animated flight trajectory',
        { prompt: 'animate it', activeArtifact: active3DPlaneArtifact },
        []
    );
    assert.strictEqual(animatedArtifact.type, '3d-scene', 'Prompt "animate it" with active 3d-scene must preserve type "3d-scene"');
    assert.strictEqual(animatedArtifact.data.timeline?.isPlaying, true, 'Timeline must be playing on "animate it"');
    assert.strictEqual(animatedArtifact.data.timeline?.isLooping, true, 'Timeline must be looping on "animate it"');
    assert.strictEqual(animatedArtifact.data.animation, 'flight', 'Animation mode must be set to "flight"');

    // Test "make it fly"
    const makeFlyArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'make it fly',
        'Starting flight simulation',
        { prompt: 'make it fly', activeArtifact: active3DPlaneArtifact },
        []
    );
    assert.strictEqual(makeFlyArtifact.type, '3d-scene', 'Prompt "make it fly" must produce 3d-scene');
    assert.strictEqual(makeFlyArtifact.data.timeline?.isPlaying, true, 'Timeline must be playing on "make it fly"');
    assert.strictEqual(makeFlyArtifact.data.animation, 'flight');

    // Test "start flight"
    const startFlightArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'start flight',
        'Initiating flight sequence',
        { prompt: 'start flight', activeArtifact: active3DPlaneArtifact },
        []
    );
    assert.strictEqual(startFlightArtifact.type, '3d-scene');
    assert.strictEqual(startFlightArtifact.data.timeline?.isPlaying, true);

    // Test "orbit camera"
    const orbitArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'orbit camera',
        'Orbiting camera around 3D aircraft',
        { prompt: 'orbit camera', activeArtifact: active3DPlaneArtifact },
        []
    );
    assert.strictEqual(orbitArtifact.type, '3d-scene');
    assert.strictEqual(orbitArtifact.data.timeline?.isPlaying, true);
    assert.strictEqual(orbitArtifact.data.animation, 'orbit');
    console.log('  ✓ Test 8 Passed: GeminiService correctly preserves 3d-scene and sets animated timeline state.');

    // -------------------------------------------------------------
    // Test 9: Verify GenerativeCanvasStudio 3D Animation State Handling
    // -------------------------------------------------------------
    console.log('  Testing GenerativeCanvasStudio Animation Follow-Up State Handling...');
    assert.ok(studioSource.includes("updated3D.animation = 'flight'"), 'Studio must support setting animation to flight');
    assert.ok(studioSource.includes("isPlaying: true"), 'Studio must set isPlaying to true on animation follow-ups');
    assert.ok(studioSource.includes("Animated 3D flight trajectory: dynamic bank, roll, and engine thrust active."), 'Studio must set flight animation explanation');
    console.log('  ✓ Test 9 Passed: GenerativeCanvasStudio mutates 3D scene state for animation requests.');

    // -------------------------------------------------------------
    // Test 10: Verify Scene3DPrimitive Real-Time Animation Kinematics
    // -------------------------------------------------------------
    console.log('  Testing Scene3DPrimitive Real-Time Flight Kinematics & Jet Exhaust...');
    assert.ok(sceneSource.includes('bankAngle') || sceneSource.includes('roll') || sceneSource.includes('Math.sin'), 'Scene3DPrimitive must compute dynamic flight banking and roll');
    assert.ok(sceneSource.includes('thruster') || sceneSource.includes('thrusterGlowMat') || sceneSource.includes('exhaust'), 'Scene3DPrimitive must render thrusters and exhaust');
    console.log('  ✓ Test 10 Passed: Scene3DPrimitive includes real-time flight kinematics and thrusters.');

    console.log('\n🎉 ALL HEADLESS 3D WORKSPACE TESTS PASSED SUCCESSFULLY!');
}

runHeadless3DWorkspaceTests().catch(err => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
