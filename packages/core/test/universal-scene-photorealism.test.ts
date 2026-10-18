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
    DirectDispatchOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    detect3DSceneTheme,
    synthesizeContextual3DScene,
    generateDefaultCpp3DSource
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import type {
    Scene3DData
} from '../src/browser/generative-canvas/canvas-types';
import {
    NativeCppCompilerService
} from '../src/node/3d-engine/native-compiler-service';

test('Universal Scene Synthesis & Photorealistic Mastery Integration Suite', async () => {
    console.log('🚀 Running Universal Photorealistic Scene Synthesis Tests...\n');

    const engine = new DirectDispatchOperatorEngine();

    // =========================================================================
    // Test 1: the record-only scene assembly operators are gone
    // =========================================================================
    // sb_compose_scene_hierarchy, sb_scatter_props, sb_bake_curvature_ao, sb_apply_multi_layer_weathering and
    // sb_setup_cinematic_lighting only wrote flag records into the scene; they are no longer registered.
    engine.setSceneData({
        title: 'Universal Photorealistic Scene Test',
        renderMode: 'pbr',
        environment: { lighting: 'studio' },
        customMeshes: [{ id: 'mesh-quantum-reactor', name: 'Quantum Reactor Hero', type: 'cylinder', position: [0, 1.2, 0] }]
    } as Scene3DData);
    for (const name of [
        'sb_compose_scene_hierarchy',
        'sb_scatter_props',
        'sb_bake_curvature_ao',
        'sb_apply_multi_layer_weathering',
        'sb_setup_cinematic_lighting'
    ]) {
        assert.strictEqual(engine.getOperator(name), undefined, name);
        assert.strictEqual(engine.dispatch(name, { targetMeshId: 'mesh-quantum-reactor' }).success, false, name);
    }
    assert.strictEqual(engine.getSceneData().customMeshes?.length, 1);
    assert.strictEqual(engine.getSceneData().environment?.lighting, 'studio');

    // =========================================================================
    // Test 3: Procedural 3D Theme Detection & Synthesizer
    // =========================================================================
    console.log('  Testing Procedural 3D Synthesizer intent detection & theme generation...');
    const detectedTheme = detect3DSceneTheme(
        'Assemble a universal photorealistic entire scene with quantum reactor core, micro clutter, and cinematic 3-point studio lighting.'
    );
    assert.strictEqual(detectedTheme, 'universal_scene');

    // The keyword hero-object template no longer intercepts prompts that mention an object ("reactor"): the
    // template synthesizer answers with its 'universal_scene' scene, and object builds go through
    // build_3d_object_from_reference instead.
    const synthesizedScene = synthesizeContextual3DScene(
        'Assemble a universal photorealistic entire scene with quantum reactor core, micro clutter, and cinematic 3-point studio lighting.'
    );
    assert.strictEqual(synthesizedScene.title, 'Universal Photorealistic 3D Scene Assembly');
    assert.ok(!/ADA Hero Asset/.test(synthesizedScene.title));
    assert.strictEqual(synthesizedScene.environment?.skybox, 'studio');
    assert.strictEqual(synthesizedScene.features?.curvatureAO, true);
    assert.strictEqual(synthesizedScene.features?.cinematic3PointLighting, true);
    assert.strictEqual(synthesizedScene.geoAnchor, undefined);

    // =========================================================================
    // Test 4: Procedural C++20 Generator Source Code Generation
    // =========================================================================
    console.log('  Testing C++20 Source Generator for Universal Scene...');
    const cppSource = generateDefaultCpp3DSource('universal_scene', 'Universal Quantum Reactor Scene');
    assert.ok(cppSource.includes('#include "scratchbox_engine.hpp"'));
    assert.ok(cppSource.includes('UniversalSceneComposer composer'));
    assert.ok(cppSource.includes('createQuantumReactorCore'));
    assert.ok(cppSource.includes('generateStudioPedestal'));
    assert.ok(cppSource.includes('scatterInstancesOnMesh'));
    assert.ok(cppSource.includes('bakeCurvatureToVertexColors'));
    assert.ok(cppSource.includes('createCinematicStudioLighting'));
    assert.ok(cppSource.includes('composer.streamSceneGlb'));

    // =========================================================================
    // Test 5: Native C++20 Apple Clang Compilation & Stream Verification
    // =========================================================================
    console.log('  Testing Native C++20 Compilation & glTF streaming via NativeCppCompilerService...');
    const compiler = new NativeCppCompilerService();
    const compileRes = await compiler.compileSource(cppSource, 'test_universal_scene_generator.cpp');
    assert.strictEqual(compileRes.success, true, `Compilation failed: ${compileRes.compilerOutput}`);
    assert.ok(compileRes.binaryPath);

    if (compileRes.binaryPath) {
        const execRes = await compiler.executeBinary(compileRes.binaryPath);
        assert.strictEqual(execRes.success, true);
        assert.ok(execRes.chunks.length > 0, 'Should have streamed at least one 3D chunk');
        const mainChunk = execRes.chunks[0];
        assert.strictEqual(mainChunk.name, 'universal_quantum_reactor_scene');
        assert.ok(mainChunk.vertexCount > 0, 'Vertex count should be positive');
        assert.ok(mainChunk.indexCount > 0, 'Index count should be positive');
        assert.ok(mainChunk.glbBase64.length > 100, 'Should have valid base64 glTF binary payload');

        // Verify glTF 2.0 binary header magic: 'glTF'
        const glbBuffer = Buffer.from(mainChunk.glbBase64, 'base64');
        const magic = glbBuffer.toString('ascii', 0, 4);
        assert.strictEqual(magic, 'glTF', 'Binary must have valid glTF 2.0 header magic');
    }

    console.log('✅ Universal Photorealistic Scene Synthesis Tests Passed Successfully!\n');
});
