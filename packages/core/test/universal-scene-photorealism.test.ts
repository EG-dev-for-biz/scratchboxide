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
    DynamicDagPlanner
} from '../src/node/deep-write/dynamic-dag-planner';
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
    // Test 1: Direct Dispatch Engine Scene Assembly Operators
    // =========================================================================
    console.log('  Testing Direct Dispatch Operators: Scene Assembly, Curvature AO, Weathering, Props...');
    
    // Scaffolding scene
    const initialScene: Scene3DData = {
        title: 'Universal Photorealistic Scene Test',
        renderMode: 'pbr',
        environment: {
            lighting: 'studio'
        },
        customMeshes: [
            {
                id: 'mesh-quantum-reactor',
                name: 'Quantum Reactor Hero',
                type: 'cylinder',
                position: [0, 1.2, 0],
                scale: [1, 2.5, 1],
                material: {
                    color: 0x90a4ae,
                    metalness: 0.9,
                    roughness: 0.3
                }
            }
        ]
    };
    engine.setSceneData(initialScene);

    // 1a. sb_compose_scene_hierarchy
    const composeRes = engine.dispatch('sb_compose_scene_hierarchy', {
        rootName: 'QuantumCoreAssembly',
        nodes: [
            {
                id: 'containment-ring-top',
                name: 'Magnetic Torus Ring Upper',
                type: 'torus',
                tier: 'secondary',
                position: [0, 1.6, 0],
                scale: [1.4, 0.22, 1.4]
            }
        ],
        includeStudioPedestal: true,
        pedestalRadius: 3.5
    });
    assert.strictEqual(composeRes.success, true);
    assert.strictEqual(composeRes.data.nodeCount, 2);
    assert.strictEqual(composeRes.data.nodes[0].tier, 'secondary');
    assert.strictEqual(composeRes.data.nodes[1].name, 'Studio_Pedestal');

    // 1b. sb_bake_curvature_ao
    const bakeRes = engine.dispatch('sb_bake_curvature_ao', {
        targetMeshId: 'mesh-quantum-reactor',
        pointinessContrast: 3.5,
        cavityContrast: 4.0,
        ambientOcclusionStrength: 0.8
    });
    assert.strictEqual(bakeRes.success, true);
    const bakedMesh = engine.getObject('mesh-quantum-reactor') as any;
    assert.strictEqual(bakedMesh.vertexColorMasks.pointinessBaked, true);
    assert.strictEqual(bakedMesh.vertexColorMasks.cavityAoBaked, true);

    // 1c. sb_apply_multi_layer_weathering
    const weatherRes = engine.dispatch('sb_apply_multi_layer_weathering', {
        targetMeshId: 'mesh-quantum-reactor',
        baseColor: '#263238',
        baseMetallic: 0.1,
        baseRoughness: 0.5,
        wornEdgeColor: '#ffd700',
        wornEdgeMetallic: 0.98,
        wornEdgeRoughness: 0.12,
        creviceDirtColor: '#0a0806',
        creviceDirtRoughness: 0.95
    });
    assert.strictEqual(weatherRes.success, true);
    assert.ok(weatherRes.data.weathering);
    const weatheredMesh = engine.getObject('mesh-quantum-reactor') as any;
    assert.ok(weatheredMesh.weathering);
    assert.strictEqual(weatheredMesh.weathering.base.color, '#263238');
    assert.strictEqual(weatheredMesh.weathering.wornEdge.color, '#ffd700');

    // 1d. sb_scatter_props
    const scatterRes = engine.dispatch('sb_scatter_props', {
        targetMeshId: 'containment-ring-top',
        count: 16,
        propType: 'box',
        minScale: 0.05,
        maxScale: 0.15,
        spreadRadius: 3.0
    });
    assert.strictEqual(scatterRes.success, true);
    assert.strictEqual(scatterRes.data.scatterCount, 16);
    const scatteredObj = engine.getSceneData().customMeshes?.find(m => m.name?.startsWith('Prop_box_'));
    assert.ok(scatteredObj);

    // 1e. sb_setup_cinematic_lighting
    const lightRes = engine.dispatch('sb_setup_cinematic_lighting', {
        rigScale: 5.5,
        targetCenter: [0, 1.2, 0],
        keyKelvin: 5600,
        fillRatio: 0.35,
        rimIntensity: 2.4
    });
    assert.strictEqual(lightRes.success, true);
    const currentScene = engine.getSceneData();
    assert.strictEqual(currentScene.environment?.lighting, 'cinematic_3point_studio');
    assert.strictEqual(currentScene.environment?.cinematicRig?.keyLight?.kelvin, 5600);

    // =========================================================================
    // Test 2: Dynamic DAG Planner Universal Scene Stage & Verification
    // =========================================================================
    console.log('  Testing Dynamic DAG Planner Universal Scene stage orchestration & invariant verification...');
    const planner = new DynamicDagPlanner();
    const plan = await planner.generate3DPlanDAG(
        'Assemble a universal photorealistic entire scene with quantum reactor core, procedural clutter debris, and cinematic 3-point studio lighting.',
        { isIncremental: false }
    );

    assert.ok(plan.stages.length >= 5);
    const sceneAssemblyStage = plan.stages.find(s => s.type === 'scene_assembly');
    assert.ok(sceneAssemblyStage, 'DAG should contain scene_assembly stage');
    assert.strictEqual(sceneAssemblyStage?.expectedStateChecks?.sceneAssemblyVerified, true);

    // Execute the planned DAG through the engine and verify each stage passes
    const execEngine = new DirectDispatchOperatorEngine();
    for (const stage of plan.stages) {
        if (stage.type === 'reasoning_inspect' || stage.type === 'cpp_native_generation') continue;
        for (const op of stage.operators) {
            execEngine.dispatch(op.operator, op.params);
        }
        const verifyResult = (planner as any).verifyStageInvariants(stage, execEngine);
        assert.strictEqual(verifyResult.passed, true, `Stage ${stage.name} verification failed: ${verifyResult.details}`);
    }

    // =========================================================================
    // Test 3: Procedural 3D Theme Detection & Synthesizer
    // =========================================================================
    console.log('  Testing Procedural 3D Synthesizer intent detection & theme generation...');
    const detectedTheme = detect3DSceneTheme(
        'Assemble a universal photorealistic entire scene with quantum reactor core, micro clutter, and cinematic 3-point studio lighting.'
    );
    assert.strictEqual(detectedTheme, 'universal_scene');

    // The prompt names a hero object ("reactor"), so synthesis goes to the ADA hero synthesizer rather than
    // the closed 'universal_scene' preset (013d47c): a Python 70-20-10 generator in the 18% clay studio void,
    // with no client-side toy meshes while a native generator is active (8ce8cca Tier-0 ban).
    const synthesizedScene = synthesizeContextual3DScene(
        'Assemble a universal photorealistic entire scene with quantum reactor core, micro clutter, and cinematic 3-point studio lighting.'
    );
    assert.strictEqual(synthesizedScene.renderMode, 'clay');
    assert.strictEqual(synthesizedScene.environment?.skybox, 'studio');
    assert.strictEqual(synthesizedScene.features?.curvatureAO, true);
    assert.strictEqual(synthesizedScene.features?.cinematic3PointLighting, true);
    assert.strictEqual(synthesizedScene.pythonGenerator?.enabled, true);
    assert.ok(synthesizedScene.pythonGenerator?.sourceCode?.includes('import scratchbox as sb'));
    assert.ok(synthesizedScene.pythonGenerator?.sourceCode?.includes('70-20-10 Geometric Form Hierarchy'));
    assert.strictEqual(synthesizedScene.customMeshes?.length ?? 0, 0);

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
