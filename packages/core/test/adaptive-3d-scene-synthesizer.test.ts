/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for Adaptive Domain Architecture 3D Scene Synthesizer.
 * Verifies:
 * 1. Zero hardcoded scene .cpp files needed in the repository.
 * 2. Dynamic C++20 code synthesis from a supplied Adaptive3DSceneContract, combining Astro 3D Engine,
 *    Archie Architecture, and SB-Veggie Botany with transferred envelope normals.
 * 3. Compilation via Apple Clang (-std=c++20 -O3) and valid binary .glb generation.
 * The synthesizer no longer infers contracts from prompt keywords, so the contracts are fixtures.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Adaptive3DSceneSynthesizer } from '../src/node/spatial/Adaptive3DSceneSynthesizer';
import type { Adaptive3DSceneContract } from '../src/common/spatial/adaptive-3d-scene-contract';

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/adaptive-3d-scene-contracts.json'), 'utf8')) as {
    outpost: Adaptive3DSceneContract;
    entourage: Adaptive3DSceneContract;
};

describe('Adaptive Domain Architecture: Adaptive3DSceneSynthesizer', () => {
    const synthesizer = new Adaptive3DSceneSynthesizer();

    it('no longer infers scene contracts from prompt keywords', () => {
        expect((synthesizer as any).synthesizeContractFromPrompt).toBeUndefined();
        expect((synthesizer as any).synthesizeWithEphemeralReferenceImage).toBeUndefined();
    });

    it('generates fully compliant C++20 source code with zero hardcoded file dependencies', () => {
        const cppSource = synthesizer.generateCppSource(fixtures.outpost);

        // Validates modern C++20 headers and engines
        expect(cppSource).toContain('#include "scratchbox_engine.hpp"');
        expect(cppSource).toContain('#include "scratchbox_sb_veggie.hpp"');
        expect(cppSource).toContain('#include "scratchbox_architecture.hpp"');
        expect(cppSource).toContain('#include "scratchbox_io.hpp"');

        // Validates procedural algorithms
        expect(cppSource).toContain('ProceduralBuildingGenerator::generateBuilding');
        expect(cppSource).toContain('SbVeggieModelBuilder::buildCanonicalTemplate');
        expect(cppSource).toContain('transferEnvelopeNormals = true');
        expect(cppSource).toContain('GlbWriter::serializeMultiMeshToGlb');
        expect(cppSource).toContain('int main(');
    });

    it('dynamically compiles C++20 source and streams binary .glb on the fly', async () => {
        const outputDir = path.resolve(process.cwd(), 'build/3d-test');
        const outputGlbPath = path.join(outputDir, 'test_adaptive_scene.glb');

        const result = await synthesizer.synthesizeAndCompile(fixtures.outpost, {
            outputDir,
            outputGlbPath
        });
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.glbPath).toBe(outputGlbPath);
        expect(fs.existsSync(outputGlbPath)).toBe(true);

        const stats = fs.statSync(outputGlbPath);
        expect(stats.size).toBeGreaterThan(10000); // GLB must contain significant procedural geometry

        // Verify glTF 2.0 magic header (0x46546C67 -> "glTF")
        const buffer = fs.readFileSync(outputGlbPath);
        const magic = buffer.toString('ascii', 0, 4);
        expect(magic).toBe('glTF');

        // Check vertex and triangle metrics
        expect(result.vertexCount).toBeGreaterThan(5000);
        expect(result.triangleCount).toBeGreaterThan(3000);
    }, 180000); // Allow up to 180s for C++ Clang compilation & execution

    it('emits the scale entourage figure of a contract in clay', () => {
        const cppSource = synthesizer.generateCppSource(fixtures.entourage);
        expect(cppSource).toContain('#include "scratchbox_parametric_human.hpp"');
        expect(cppSource).toContain('#include "scratchbox_kinematics.hpp"');
        expect(cppSource).toContain('#include "scratchbox_skinning.hpp"');
        expect(cppSource).toContain('SbHumanModel::loadStandardModel');
        expect(cppSource).toContain('posedRig.setJointRotation("LeftShoulder"');
        expect(cppSource).toContain('posedRig.setJointRotation("LeftKnee"');
        expect(cppSource).toContain('figureMesh.bounds.min.y');
        expect(cppSource).toContain('Vec4 clayTone(0.55f, 0.57f, 0.60f, 1.0f)');
        expect(cppSource).toContain('multiMeshes.push_back(entourageCompound)');
    });

    it('dynamically compiles C++20 scene with Approach A scale entourage figure into binary .glb', async () => {
        const outputDir = path.resolve(process.cwd(), 'build/3d-test');
        const outputGlbPath = path.join(outputDir, 'test_entourage_scene.glb');

        const result = await synthesizer.synthesizeAndCompile(fixtures.entourage, {
            outputDir,
            outputGlbPath
        });

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.glbPath).toBe(outputGlbPath);
        expect(fs.existsSync(outputGlbPath)).toBe(true);

        const stats = fs.statSync(outputGlbPath);
        expect(stats.size).toBeGreaterThan(20000);

        // Verify glTF 2.0 magic
        const buffer = fs.readFileSync(outputGlbPath);
        expect(buffer.toString('ascii', 0, 4)).toBe('glTF');

        // Entourage mesh increases vertex and triangle counts beyond base scene
        expect(result.vertexCount).toBeGreaterThan(10000);
        expect(result.triangleCount).toBeGreaterThan(5000);
    }, 180000);
});
