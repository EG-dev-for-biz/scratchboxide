/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for Adaptive Domain Architecture 3D Scene Synthesizer.
 * Verifies:
 * 1. Zero hardcoded scene .cpp files needed in the repository.
 * 2. Dynamic open schema contract inference from natural language prompts.
 * 3. Dynamic C++20 code synthesis combining Astro 3D Engine, Archie Architecture,
 *    and SB-Veggie Botany with transferred envelope normals.
 * 4. Compilation via Apple Clang (-std=c++20 -O3) and valid binary .glb generation.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Adaptive3DSceneSynthesizer } from '../src/node/spatial/Adaptive3DSceneSynthesizer';

describe('Adaptive Domain Architecture: Adaptive3DSceneSynthesizer', () => {
    const synthesizer = new Adaptive3DSceneSynthesizer();

    it('synthesizes an open-domain schema contract from an arctic outpost prompt', () => {
        const prompt = 'brutalist monolithic arctic outpost in glacial valley with sb-veggie conifer trees';
        const contract = synthesizer.synthesizeContractFromPrompt(prompt);

        expect(contract.id).toBeDefined();
        expect(contract.subject).toBe(prompt);

        // Terrain fields
        expect(contract.terrain.topology).toBe('alpine_massif');
        expect(contract.terrain.peakHeight).toBeGreaterThanOrEqual(60);
        expect(contract.terrain.snowLineElevation).toBeLessThanOrEqual(10);

        // Architecture fields (Archie)
        expect(contract.architecture.structures.length).toBeGreaterThanOrEqual(1);
        const structure = contract.architecture.structures[0];
        expect(structure.dimensions.floorCount).toBe(3);
        expect(structure.fenestration.bayWidth).toBeGreaterThan(0);
        expect(structure.parapet.height).toBeGreaterThan(0);
        expect(structure.features.some(f => f.type === 'plinth')).toBe(true);

        // Botany fields (SB-Veggie)
        expect(contract.botany.forestPatches.length).toBeGreaterThanOrEqual(1);
        const forest = contract.botany.forestPatches[0];
        expect(forest.archetype).toBe('conifer');
        expect(forest.envelopeNormalFactor).toBeGreaterThan(0.5);

        // Zero Default Atmosphere: contract.atmosphere is undefined unless explicitly requested
        expect(contract.atmosphere).toBeUndefined();

        // When atmosphere/sky/sunset is explicitly requested, atmosphere is synthesized with zero default fog
        const atmoContract = synthesizer.synthesizeContractFromPrompt('arctic research station in snowy mountain basin at sunset with atmospheric sky');
        expect(atmoContract.atmosphere).toBeDefined();
        expect(atmoContract.atmosphere!.sunAzimuthDeg).toBeDefined();
        expect(atmoContract.atmosphere!.fogDensity).toBe(0.0);

        // When haze/fog is explicitly requested in prompt, fogDensity is active
        const hazeContract = synthesizer.synthesizeContractFromPrompt('arctic research station in snowy mountain basin at sunset with polar haze and fog');
        expect(hazeContract.atmosphere).toBeDefined();
        expect(hazeContract.atmosphere!.fogDensity).toBeGreaterThan(0);
    });

    it('synthesizes open-domain schema contract for other unconstrained domains (e.g. desert canyon temple)', () => {
        const prompt = 'desert canyon sandstone temple';
        const contract = synthesizer.synthesizeContractFromPrompt(prompt);

        expect(contract.terrain.topology).toBe('canyon');
        expect(contract.terrain.peakHeight).toBeLessThan(40);
        expect(contract.terrain.snowLineElevation).toBeGreaterThan(30);
    });

    it('generates fully compliant C++20 source code with zero hardcoded file dependencies', () => {
        const contract = synthesizer.synthesizeContractFromPrompt('arctic outpost with conifer trees');
        const cppSource = synthesizer.generateCppSource(contract);

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
        const contract = synthesizer.synthesizeContractFromPrompt('brutalist arctic outpost in glacial valley');
        
        const outputDir = path.resolve(process.cwd(), 'build/3d-test');
        const outputGlbPath = path.join(outputDir, 'test_adaptive_scene.glb');

        const result = await synthesizer.synthesizeAndCompile(contract, {
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

    it('builds an authoritative multimodal deconstruction prompt for visual reverse-engineering', () => {
        const prompt = synthesizer.buildMultimodalDeconstructionPrompt('geothermal volcanic monitoring station');
        expect(prompt).toContain('Master Architectural Surveyor');
        expect(prompt).toContain('geothermal volcanic monitoring station');
        expect(prompt).toContain('Adaptive3DSceneContract');
        expect(prompt).toContain('fenestration');
        expect(prompt).toContain('Botany');
    });

    it('executes 4-stage ephemeral reference image pipeline and unlinks temporary image on completion', async () => {
        const scratchDir = path.resolve(process.cwd(), 'build/ephemeral-test');
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir, { recursive: true });
        }
        const tempImagePath = path.join(scratchDir, `test_ephemeral_ref_${Date.now()}.png`);
        fs.writeFileSync(tempImagePath, Buffer.from('mock_png_image_bytes'));
        expect(fs.existsSync(tempImagePath)).toBe(true);

        const mockPrompt = 'brutalist arctic outpost in glacial valley';
        const outputDir = path.resolve(process.cwd(), 'build/3d-test');
        const outputGlbPath = path.join(outputDir, 'test_ephemeral_scene.glb');

        const result = await synthesizer.synthesizeWithEphemeralReferenceImage(mockPrompt, {
            imageGenerator: async () => ({
                imagePath: tempImagePath
            }),
            multimodalExtractor: async (imageInput, extractionPrompt) => {
                expect(imageInput.imagePath).toBe(tempImagePath);
                expect(extractionPrompt).toContain(mockPrompt);
                // Return synthesized contract
                return synthesizer.synthesizeContractFromPrompt(mockPrompt);
            },
            outputDir,
            outputGlbPath
        });

        expect(result.success).toBe(true);
        expect(result.glbPath).toBe(outputGlbPath);
        expect(fs.existsSync(outputGlbPath)).toBe(true);

        // Crucial Invariant: Ephemeral reference image MUST be unlinked / deleted
        expect(fs.existsSync(tempImagePath)).toBe(false);
    }, 180000);
});

