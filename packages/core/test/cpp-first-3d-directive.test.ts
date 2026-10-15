/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as assert from 'assert';
import {
    generateDefaultCpp3DSource,
    synthesizeContextual3DScene,
    initializeSceneOperatorStack
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    NativeCppCompilerService
} from '../src/node/3d-engine/native-compiler-service';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('C/C++ First 3D Engine Architecture Directive', () => {

    it('1. should generate valid C++20 engine source code across flight, worldbuilder, architecture, and general themes', () => {
        const flightCpp = generateDefaultCpp3DSource('flight', 'F16 Viper Fighter');
        expect(flightCpp).toContain('#include "scratchbox_engine.hpp"');
        expect(flightCpp).toContain('PbrMaterial::titanium()');
        expect(flightCpp).toContain('scratchbox::io::GlbWriter::streamChunk');
        expect(flightCpp).toContain('f16_viper_fighter');

        const terrainCpp = generateDefaultCpp3DSource('worldbuilder', 'Alpine Valley');
        expect(terrainCpp).toContain('#include "scratchbox_engine.hpp"');
        expect(terrainCpp).toContain('PbrMaterial::basaltRock()');
        expect(terrainCpp).toContain('FastNoise3D');
        expect(terrainCpp).toContain('alpine_valley');

        const archCpp = generateDefaultCpp3DSource('architecture', 'Metropolis Spire');
        expect(archCpp).toContain('#include "scratchbox_engine.hpp"');
        expect(archCpp).toContain('PbrMaterial::carbonComposite()');
        expect(archCpp).toContain('metropolis_spire');

        const generalCpp = generateDefaultCpp3DSource('general', 'Quantum Monolith');
        expect(generalCpp).toContain('#include "scratchbox_engine.hpp"');
        expect(generalCpp).toContain('monolith.computeCurvatureAO');
        expect(generalCpp).toContain('quantum_monolith');
    });

    it('2. should synthesize a native generator for a hero-object prompt and record attached C++20 generators in the operator stack', () => {
        // Hero-object prompts ("build ... jet fighter") no longer route to the closed 'flight' preset:
        // 013d47c sends them to the ADA hero synthesizer (Python adaptive_object.py, 70-20-10 form
        // hierarchy, 18% clay void), and f6f522f lists jet/aircraft among hero objects.
        const scene = synthesizeContextual3DScene('Build a supersonic tactical jet fighter');
        expect(scene.pythonGenerator).toBeDefined();
        expect(scene.pythonGenerator?.enabled).toBe(true);
        expect(scene.pythonGenerator?.sourceCode).toContain('import scratchbox as sb');
        expect(scene.pythonGenerator?.sourceCode).toContain('70-20-10 Geometric Form Hierarchy');
        expect(scene.renderMode).toBe('clay');

        // A scene that carries a C++20 generator gets it registered as sb_set_cpp_generator.
        const flightScene = initializeSceneOperatorStack({
            title: 'Supersonic Tactical Jet Fighter',
            cppGenerator: {
                enabled: true,
                filename: 'world_generator.cpp',
                sourceCode: generateDefaultCpp3DSource('flight', 'Supersonic Tactical Jet Fighter')
            }
        } as Scene3DData);
        expect(flightScene.cppGenerator?.sourceCode).toContain('ScratchboxMesh aircraft');
        const setCppOp = flightScene.operatorStack?.find(cmd => cmd.operator === 'sb_set_cpp_generator');
        expect(setCppOp).toBeDefined();
        expect(setCppOp?.params?.sourceCode).toContain('#include "scratchbox_engine.hpp"');
        expect(setCppOp?.params?.sourceCode).toContain('ScratchboxMesh aircraft');
    });

    it('3. should execute sb_set_cpp_generator operator in DirectDispatchOperatorEngine', () => {
        const initialScene: Scene3DData = {
            title: 'Empty Scene',
            renderMode: 'pbr'
        };
        const engine = createOperatorEngine(initialScene);

        const testSource = `#include "scratchbox_engine.hpp"
int main() {
    scratchbox::geometry::ScratchboxMesh mesh("test");
    scratchbox::io::GlbWriter::streamChunk(mesh, "test");
    return 0;
}`;

        const res = engine.dispatch('sb_set_cpp_generator', {
            sourceCode: testSource,
            filename: 'custom_procedural.cpp',
            enabled: true,
            vertexCount: 1024,
            triangleCount: 2048
        });

        expect(res.success).toBe(true);
        const updated = engine.getSceneData();
        expect(updated.cppGenerator).toBeDefined();
        expect(updated.cppGenerator?.sourceCode).toBe(testSource);
        expect(updated.cppGenerator?.filename).toBe('custom_procedural.cpp');
        expect(updated.cppGenerator?.vertexCount).toBe(1024);
        expect(updated.cppGenerator?.triangleCount).toBe(2048);
    });

    it('5. should compile and stream glTF 2.0 binary using NativeCppCompilerService for synthesized flight C++ source', async () => {
        const compiler = new NativeCppCompilerService();
        const flightCpp = generateDefaultCpp3DSource('flight', 'Interceptor X');

        const compileRes = await compiler.compileSource(flightCpp, 'interceptor_x.cpp');
        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBeGreaterThan(0);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('interceptor_x');
            expect(chunk.vertexCount).toBeGreaterThan(500);
            expect(chunk.indexCount).toBeGreaterThan(1500);
            expect(chunk.glbBase64.length).toBeGreaterThan(100);

            // Verify binary glTF 2.0 magic 'glTF' (0x46546C67)
            const glbBuffer = Buffer.from(chunk.glbBase64, 'base64');
            const magic = glbBuffer.toString('ascii', 0, 4);
            expect(magic).toBe('glTF');
        }
    });
});
