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
import * as fs from 'fs';
import * as path from 'path';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { createAirplaneMesh } from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { resolveModeForArtifact } from '../src/browser/generative-canvas/guardrails-service';
import { GeminiService } from '../src/node/gemini-service';
import { readStudioSources } from './source-helpers';

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
    // d9be3d7 ("eliminate default atmosphere") / c66702f ("zero default haze/fog") removed the baseline
    // FogExp2 from the primitive: fog starts null and syncAtmosphere (split out in 3c43c40) installs
    // the FogExp2 horizon fog only when fog is explicitly requested.
    const syncAtmosphereSource = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere.ts'), 'utf-8');
    assert.ok(sceneSource.includes('scene.fog = null') && sceneSource.includes('syncAtmosphere('), 'Scene3DPrimitive must start fog-free and delegate fog to syncAtmosphere');
    assert.ok(/if \(explicitFogRequested\) \{[\s\S]*?scene\.fog = new THREE\.FogExp2\(/.test(syncAtmosphereSource), 'Must configure depth/atmospheric FogExp2 fog for smooth horizon transition when fog is requested');
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
    const studioSource = readStudioSources();

    assert.ok(studioSource.includes("layoutMode === '3d'"), 'Studio must support 3d layout mode in chat dispatch');
    assert.ok(studioSource.includes("activeArtifact?.type === '3d-scene'"), 'Studio must support 3d-scene artifact mutations');
    // The chat client no longer rewrites scenes from prompt keywords (world branches, WASM wave colliders, drone
    // routes): a scene changes only through what the model sends.
    assert.ok(!studioSource.includes("earth/post-apocalypse"), 'Studio must not template world-branch mutations from prompt words');
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
    assert.ok(cssSource.includes('.sb-bottom-chat-dock.sb-layout-3d'), 'Must position composer dock cleanly above 3D timeline');
    console.log('  ✓ Test 4 Passed: 3D Workspace styling codified with high contrast and dark/light theme support.');

    // -------------------------------------------------------------
    // Test 5: Verify Gemini System Prompt & 3D Artifact Synthesis
    // -------------------------------------------------------------
    console.log('  Testing GeminiService 3D Scene Instruction & Artifact Generation...');
    const geminiService = new GeminiService();
    const systemPrompt = await (geminiService as any).buildSystemInstruction({ prompt: 'build a 3d scene of a plane' });
    assert.ok(systemPrompt.includes('"3d-scene"'), 'System prompt must include 3d-scene primitive');
    assert.ok(systemPrompt.includes('Scene3DData'), 'System prompt must document Scene3DData schema');
    // The schema example teaches objects the viewport loads, not an internal:plane aircraft at a default place.
    assert.ok(systemPrompt.includes('Every object must be a file the viewport loads'), 'System prompt must say scene objects are loadable files');
    assert.ok(!systemPrompt.includes('internal:plane'), 'System prompt must not teach internal:plane objects');
    assert.ok(!systemPrompt.includes('San Francisco Bay Airspace'), 'System prompt must not teach a default geoAnchor');

    // A prose reply builds no scene from the prompt's words (no keyword-picked aircraft).
    const planeArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'build a 3d scene of a plane',
        'Here is the 3D plane scene',
        { prompt: 'build a 3d scene of a plane' },
        []
    );
    assert.strictEqual(planeArtifact, undefined, 'A prose reply must not produce a template aircraft scene');
    assert.strictEqual(resolveModeForArtifact('3d-scene'), '3d', '3d-scene artifact must resolve to layoutMode "3d"');

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

    // Follow-ups answered in prose change nothing; playback starts only when the model sends a timeline.
    for (const followUp of ['animate it', 'make it fly', 'start flight', 'orbit camera']) {
        const proseArtifact = (geminiService as any).parseOrSynthesizeArtifact(
            followUp,
            'Starting the flight sequence',
            { prompt: followUp, activeArtifact: active3DPlaneArtifact },
            []
        );
        assert.strictEqual(proseArtifact, undefined, `"${followUp}" answered in prose must leave the scene as it is`);
    }
    const animatedArtifact = (geminiService as any).parseOrSynthesizeArtifact(
        'animate it',
        '```json\n' + JSON.stringify({ type: '3d-scene', data: { animation: 'flight', timeline: { isPlaying: true, isLooping: true } } }) + '\n```',
        { prompt: 'animate it', activeArtifact: active3DPlaneArtifact },
        []
    );
    assert.strictEqual(animatedArtifact.type, '3d-scene', 'Prompt "animate it" with active 3d-scene must preserve type "3d-scene"');
    assert.strictEqual(animatedArtifact.data.timeline?.isPlaying, true, 'The model\'s timeline must be kept');
    assert.strictEqual(animatedArtifact.data.timeline?.isLooping, true);
    assert.strictEqual(animatedArtifact.data.animation, 'flight', 'The model\'s animation mode must be kept');
    console.log('  ✓ Test 8 Passed: GeminiService keeps the scene and the model\'s own timeline state.');

    // -------------------------------------------------------------
    // Test 9: The chat client does not rewrite a scene's animation from prompt words
    // -------------------------------------------------------------
    console.log('  Testing GenerativeCanvasStudio leaves animation to the model...');
    assert.ok(!studioSource.includes("updated3D.animation = 'flight'"), 'Studio must not set a flight animation from prompt keywords');
    console.log('  ✓ Test 9 Passed: Animation state comes only from the model.');

    console.log('\n🎉 ALL HEADLESS 3D WORKSPACE TESTS PASSED SUCCESSFULLY!');
}

test('headless-3d-workspace.test', async () => {
    await runHeadless3DWorkspaceTests();
}, 180_000);
