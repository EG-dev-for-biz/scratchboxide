/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { DynamicDagPlanner } from '../src/node/deep-write/dynamic-dag-planner';
import { detect3DSceneTheme, generateDefaultCpp3DSource } from '../src/browser/generative-canvas/procedural-3d-synthesizer';

describe('Photorealistic Physically Based Rendering (PBR) Mastery (C++20 Engine, glTF PBR Next, Operators, & Autonomous DAG)', () => {

    it('compiles and executes native C++20 PBR engine (GGX, Anisotropy, Charlie Sheen, Clearcoat, Beer-Lambert Absorption, Sobel Normals)', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::pbr;

    // 1. Verify PBR presets library
    auto candyRed = presets::carPaintCandyRed();
    auto gold = presets::polishedGold24k();
    auto titanium = presets::titaniumGrade5();
    auto glass = presets::opticalGlass();
    auto velvet = presets::redVelvetCloth();
    auto soapBubble = presets::soapBubbleIridescent();

    if (candyRed.clearcoatFactor < 0.99f || candyRed.clearcoatRoughnessFactor > 0.05f) {
        std::cerr << "Invalid candyRed clearcoat settings" << std::endl;
        return 1;
    }
    if (gold.metallicFactor < 0.99f) {
        std::cerr << "Invalid gold metallic factor" << std::endl;
        return 2;
    }
    if (glass.transmissionFactor < 0.95f || std::abs(glass.ior - 1.52f) > 0.01f) {
        std::cerr << "Invalid optical glass transmission or IOR" << std::endl;
        return 3;
    }
    if (velvet.sheenColorFactor.lengthSq() < 0.1f) {
        std::cerr << "Invalid velvet sheen color" << std::endl;
        return 4;
    }

    // 2. Test Microfacet BRDF Mathematical Formulations & Energy Conservation
    Vec3 N(0.0f, 1.0f, 0.0f);
    Vec3 V = Vec3(0.0f, 0.7071f, 0.7071f).normalized();
    Vec3 L = Vec3(0.577f, 0.577f, 0.577f).normalized();

    // Test Cook-Torrance isotropic GGX
    float ndf = ndfGGX(0.85f, 0.25f);
    if (ndf <= 0.0f) {
        std::cerr << "Invalid GGX NDF value" << std::endl;
        return 5;
    }

    // Test Height-Correlated Smith Joint Visibility
    float vSmith = visSmithJoint(0.707f, 0.577f, 0.25f);
    if (vSmith <= 0.0f) {
        std::cerr << "Invalid Smith joint visibility" << std::endl;
        return 6;
    }

    // Test Schlick Fresnel
    Vec3 f0Dielectric(0.04f, 0.04f, 0.04f);
    Vec3 fresnel = fresnelSchlick(0.5f, f0Dielectric);
    if (fresnel.x < 0.04f || fresnel.x > 1.0f) {
        std::cerr << "Invalid Fresnel value" << std::endl;
        return 7;
    }

    // Test Charlie Sheen Microfacet NDF & Visibility
    float dCharlie = ndfCharlieSheen(0.707f, 0.45f);
    float vCharlie = visCharlieSheen(0.707f, 0.577f);
    if (dCharlie <= 0.0f || vCharlie <= 0.0f) {
        std::cerr << "Invalid Charlie sheen evaluation" << std::endl;
        return 8;
    }

    // Test Beer-Lambert Volumetric Absorption Law: T(d) = exp(-sigma_a * d)
    Vec3 absorbShort = beerLambertAbsorption(Vec3(0.1f, 0.8f, 0.3f), 0.5f, 0.5f);
    Vec3 absorbLong = beerLambertAbsorption(Vec3(0.1f, 0.8f, 0.3f), 0.5f, 4.0f);
    if (absorbLong.y >= absorbShort.y) {
        std::cerr << "Beer-Lambert exponential decay failed: long distance did not absorb more light" << std::endl;
        return 9;
    }

    // Comprehensive BRDF Evaluation on candy red automotive paint
    auto brdfResult = evaluatePbrBRDF(candyRed, N, V, L);
    if (brdfResult.total.length() <= 0.0f) {
        std::cerr << "Total BRDF luminance is zero or negative" << std::endl;
        return 10;
    }
    if (brdfResult.clearcoat.length() <= 0.0f) {
        std::cerr << "Clearcoat layer reflection missing" << std::endl;
        return 11;
    }

    // 3. Test Procedural Map Synthesis (Sobel Heightmap to Tangent-Space Normal)
    std::vector<float> heightmap = {
        0.0f, 0.2f, 0.5f,
        0.1f, 0.6f, 0.8f,
        0.2f, 0.7f, 1.0f
    };
    auto normalMap = generateNormalFromHeightmap(heightmap, 3, 3, 2.0f);
    if (normalMap.size() != 9) {
        std::cerr << "Normal map height/width mismatch" << std::endl;
        return 12;
    }
    // Verify normal is normalized and points upwards in Z (tangent-space)
    if (normalMap[4].z < 0.5f) {
        std::cerr << "Normal map center tangent vector invalid" << std::endl;
        return 13;
    }

    // 4. Build Showcase Mesh and Stream glTF 2.0 Binary Container
    ScratchboxMesh mesh("pbr_test_sphere");
    mesh.material = candyRed;
    mesh.addVertex({Vec3(0, 0, 0), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1, 1, 1, 1)});
    mesh.addVertex({Vec3(1, 0, 0), Vec3(0, 1, 0), Vec2(1, 0), Vec4(1, 1, 1, 1)});
    mesh.addVertex({Vec3(0, 1, 0), Vec3(0, 1, 0), Vec2(0, 1), Vec4(1, 1, 1, 1)});
    mesh.addTriangle(0, 1, 2);

    auto glb = scratchbox::io::GlbWriter::serializeToGlb(mesh);
    if (glb.size() < 100) {
        std::cerr << "GLB binary container too small: " << glb.size() << " bytes" << std::endl;
        return 14;
    }

    std::cout << "[PASS] Native C++20 PBR Engine verified successfully. GLB bytes: " << glb.size() << std::endl;
    return 0;
}`;

        const compileResult = await compiler.compileSource(cppSource, {
            optimization: '-O3',
            outputBinaryName: 'pbr_engine_test'
        });

        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('[PASS] Native C++20 PBR Engine verified successfully');
    });

    it('serializes and streams glTF 2.0 PBR Next extensions (clearcoat, transmission, ior, volume, sheen, anisotropy, iridescence)', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::pbr;

    // Create a multi-attribute PBR Next material
    ScratchboxMesh mesh("pbr_next_test");
    mesh.material = presets::carPaintCandyRed();
    mesh.material.anisotropyStrength = 0.5f;
    mesh.material.anisotropyRotation = 0.25f;
    mesh.material.sheenColorFactor = Vec3(0.9f, 0.4f, 0.5f);
    mesh.material.sheenRoughnessFactor = 0.4f;
    mesh.material.transmissionFactor = 0.85f;
    mesh.material.thicknessFactor = 1.2f;
    mesh.material.attenuationColor = Vec3(0.8f, 0.1f, 0.1f);
    mesh.material.attenuationDistance = 0.5f;
    mesh.material.iridescenceFactor = 0.75f;
    mesh.material.iridescenceIor = 1.33f;
    mesh.material.emissiveStrength = 2.5f;

    mesh.addVertex({Vec3(0, 0, 0), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1, 1, 1, 1)});
    mesh.addVertex({Vec3(1, 0, 0), Vec3(0, 1, 0), Vec2(1, 0), Vec4(1, 1, 1, 1)});
    mesh.addVertex({Vec3(0, 1, 0), Vec3(0, 1, 0), Vec2(0, 1), Vec4(1, 1, 1, 1)});
    mesh.addTriangle(0, 1, 2);

    auto glb = scratchbox::io::GlbWriter::serializeToGlb(mesh);

    // Extract glTF 2.0 JSON chunk from GLB container
    // Header is 12 bytes: magic (4), version (4), length (4)
    // Chunk 0 is JSON: chunkLength (4), chunkType (4), chunkData (chunkLength)
    if (glb.size() < 20) {
        std::cerr << "GLB header truncated" << std::endl;
        return 1;
    }

    uint32_t jsonChunkLen = 0;
    std::memcpy(&jsonChunkLen, glb.data() + 12, 4);

    std::string jsonStr(reinterpret_cast<const char*>(glb.data() + 20), jsonChunkLen);

    // Output JSON for test inspection
    std::cout << "[JSON_START]" << jsonStr << "[JSON_END]" << std::endl;
    return 0;
}`;

        const compileResult = await compiler.compileSource(cppSource, {
            optimization: '-O3',
            outputBinaryName: 'pbr_next_gltf_test'
        });

        expect(compileResult.success).toBe(true);
        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.exitCode).toBe(0);

        const match = execResult.stdout.match(/\[JSON_START\]([\s\S]+?)\[JSON_END\]/);
        expect(match).not.toBeNull();
        const jsonText = match![1].trim();
        const gltf = JSON.parse(jsonText);

        // Verify glTF 2.0 asset and extensions
        expect(gltf.asset.version).toBe('2.0');
        expect(gltf.extensionsUsed).toBeDefined();
        expect(gltf.extensionsUsed).toContain('KHR_materials_clearcoat');
        expect(gltf.extensionsUsed).toContain('KHR_materials_transmission');
        expect(gltf.extensionsUsed).toContain('KHR_materials_ior');
        expect(gltf.extensionsUsed).toContain('KHR_materials_volume');
        expect(gltf.extensionsUsed).toContain('KHR_materials_sheen');
        expect(gltf.extensionsUsed).toContain('KHR_materials_anisotropy');
        expect(gltf.extensionsUsed).toContain('KHR_materials_iridescence');
        expect(gltf.extensionsUsed).toContain('KHR_materials_emissive_strength');

        // Verify material definition
        const mat = gltf.materials[0];
        expect(mat.extensions).toBeDefined();
        expect(mat.extensions.KHR_materials_clearcoat.clearcoatFactor).toBe(1.0);
        expect(mat.extensions.KHR_materials_clearcoat.clearcoatRoughnessFactor).toBe(0.03);
        expect(mat.extensions.KHR_materials_transmission.transmissionFactor).toBe(0.85);
        expect(mat.extensions.KHR_materials_volume.thicknessFactor).toBe(1.2);
        expect(mat.extensions.KHR_materials_anisotropy.anisotropyStrength).toBe(0.5);
        expect(mat.extensions.KHR_materials_iridescence.iridescenceFactor).toBe(0.75);
        expect(mat.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(2.5);
    });

    it('dispatches all PBR Next direct operators (create, clearcoat, transmission, sheen, anisotropy, presets, baking)', () => {
        const engine = createOperatorEngine();

        // 1. Dispatch sb_create_material with PBR Next parameters
        const createResult = engine.dispatch('sb_create_material', {
            materialId: 'mat-candy-red',
            name: 'Candy Red Metallic',
            preset: 'car_paint_candy_red',
            clearcoat: 1.0,
            clearcoatRoughness: 0.03
        });
        expect(createResult.success).toBe(true);
        expect(createResult.data.materialId).toBe('mat-candy-red');
        expect(createResult.data.material.clearcoat).toBe(1.0);
        expect(createResult.data.material.clearcoatRoughness).toBe(0.03);

        // 2. Dispatch sb_set_pbr_clearcoat
        const ccResult = engine.dispatch('sb_set_pbr_clearcoat', {
            materialId: 'mat-candy-red',
            clearcoat: 0.95,
            clearcoatRoughness: 0.02
        });
        expect(ccResult.success).toBe(true);
        expect(ccResult.data.clearcoat).toBe(0.95);
        expect(ccResult.data.clearcoatRoughness).toBe(0.02);

        // 3. Dispatch sb_set_pbr_transmission
        const transResult = engine.dispatch('sb_set_pbr_transmission', {
            materialId: 'mat-crystal',
            transmission: 0.92,
            ior: 1.58,
            thickness: 1.5,
            attenuationColor: '#1fe073',
            attenuationDistance: 1.0
        });
        expect(transResult.success).toBe(true);
        expect(transResult.data.transmission).toBe(0.92);
        expect(transResult.data.ior).toBe(1.58);
        expect(transResult.data.thickness).toBe(1.5);

        // 4. Dispatch sb_set_pbr_sheen
        const sheenResult = engine.dispatch('sb_set_pbr_sheen', {
            materialId: 'mat-velvet',
            sheenColor: '#ff6688',
            sheenRoughness: 0.5
        });
        expect(sheenResult.success).toBe(true);
        expect(sheenResult.data.sheenColor).toBe('#ff6688');
        expect(sheenResult.data.sheenRoughness).toBe(0.5);

        // 5. Dispatch sb_set_pbr_anisotropy
        const anisoResult = engine.dispatch('sb_set_pbr_anisotropy', {
            materialId: 'mat-brushed-metal',
            anisotropy: 0.85,
            rotation: 0.785
        });
        expect(anisoResult.success).toBe(true);
        expect(anisoResult.data.anisotropy).toBe(0.85);
        expect(anisoResult.data.anisotropyRotation).toBe(0.785);

        // 6. Dispatch sb_assign_pbr_preset
        const presetResult = engine.dispatch('sb_assign_pbr_preset', {
            materialId: 'mat-gold',
            preset: 'polished_gold_24k'
        });
        expect(presetResult.success).toBe(true);
        expect(presetResult.data.preset).toBe('polished_gold_24k');
        expect(presetResult.data.material.metalness).toBe(1.0);
        expect(presetResult.data.material.color).toBe('#ffd700');

        // 7. Dispatch sb_bake_pbr_maps
        const bakeResult = engine.dispatch('sb_bake_pbr_maps', {
            materialId: 'mat-gold',
            generateNormal: true,
            generateRoughness: true,
            generateAO: true,
            bumpScale: 1.5
        });
        expect(bakeResult.success).toBe(true);
        expect(bakeResult.data.proceduralMaps.normalMapGenerated).toBe(true);
        expect(bakeResult.data.proceduralMaps.bumpScale).toBe(1.5);
    });

    it('synthesizes procedural 3D scenes with "pbr" theme and compiles default C++ source', async () => {
        // Test semantic theme detector
        const prompt = 'Photorealistic PBR showcase with Cook-Torrance microfacet BRDF, automotive clearcoat, and optical glass';
        const detectedTheme = detect3DSceneTheme(prompt);
        expect(detectedTheme).toBe('pbr');

        // Generate C++ procedural source for 'pbr' theme
        const cppCode = generateDefaultCpp3DSource('pbr', 'PBR_Mastery_Showcase');
        expect(cppCode).toContain('#include "scratchbox_engine.hpp"');
        expect(cppCode).toContain('presets::carPaintCandyRed()');
        expect(cppCode).toContain('evaluatePbrBRDF');
        expect(cppCode).toContain('scratchbox::io::GlbWriter::streamChunk');

        // Compile and execute C++ generator
        const compiler = new NativeCppCompilerService();
        const compileResult = await compiler.compileSource(cppCode, {
            optimization: '-O3',
            outputBinaryName: 'pbr_synthesizer_showcase'
        });

        if (!compileResult.success) {
            console.error('PBR Synthesizer compile failed:', compileResult.stderr);
        }
        expect(compileResult.success).toBe(true);
        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('[Scratchbox PBR Engine] Evaluated BRDF Total Lum:');
    });

    it('plans and executes autonomous DAG with Stage 4 Physically Based Materials', async () => {
        const planner = new DynamicDagPlanner();
        const prompt = 'Construct a photorealistic PBR material gallery with titanium, optical glass, and velvet';

        const dagPlan = planner.generate3DPlanDAG(prompt);
        expect(dagPlan).toBeDefined();
        expect(dagPlan.stages.length).toBeGreaterThanOrEqual(4);

        // Find Phase 4: Materials and Shading stage
        const stage4 = dagPlan.stages.find(s => s.id === 'stage_04_materials_and_shading' || s.type === 'materials_and_shading');
        expect(stage4).toBeDefined();
        expect(stage4!.operators.length).toBeGreaterThan(0);

        // Verify stage 4 depends on prior topological stages
        expect(stage4!.dependencies.length).toBeGreaterThan(0);

        // Verify operators in stage 4 include sb_create_material and sb_assign_material
        const createOps = stage4!.operators.filter(op => op.operator === 'sb_create_material');
        const assignOps = stage4!.operators.filter(op => op.operator === 'sb_assign_material');
        expect(createOps.length).toBeGreaterThan(0);
        expect(assignOps.length).toBeGreaterThan(0);

        // Execute workflow through autonomous DAG
        const executionResult = await planner.executeAutonomous3DWorkflow(prompt);
        expect(executionResult.success).toBe(true);
        expect(executionResult.finalScene).toBeDefined();
        expect(executionResult.executedStages.length).toBe(dagPlan.stages.length);
        expect(executionResult.executedStages.every(s => s.success && s.verification.passed)).toBe(true);
    });

});
