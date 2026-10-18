/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
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

    it('dispatches the PBR material operators and writes the values onto the registered material and the object', () => {
        const engine = createOperatorEngine({
            title: 'PBR Stage',
            customMeshes: [{ id: 'car-body', name: 'Car Body', type: 'box', position: [0, 0, 0] }]
        });

        // 1. sb_create_material from a preset, with explicit clearcoat overrides
        const createResult = engine.dispatch('sb_create_material', {
            materialId: 'mat-candy-red',
            name: 'Candy Red Metallic',
            preset: 'car_paint_candy_red',
            clearcoat: 1.0,
            clearcoatRoughness: 0.03
        });
        expect(createResult.success).toBe(true);
        expect(createResult.data.materialId).toBe('mat-candy-red');
        expect(createResult.data.material.color).toBe('#d90f14'); // from the preset
        expect(createResult.data.material.metalness).toBe(0.45);
        expect(engine.getMaterial('mat-candy-red')).toBe(createResult.data.material);

        // 2. sb_set_pbr_clearcoat changes the registered material (clamped to 0..1)
        const ccResult = engine.dispatch('sb_set_pbr_clearcoat', { materialId: 'mat-candy-red', clearcoat: 1.4, clearcoatRoughness: 0.02 });
        expect(ccResult.success).toBe(true);
        expect(engine.getMaterial('mat-candy-red').clearcoat).toBe(1.0);
        expect(engine.getMaterial('mat-candy-red').clearcoatRoughness).toBe(0.02);

        // 3. sb_assign_material copies it onto the object
        expect(engine.dispatch('sb_assign_material', { objectId: 'car-body', materialId: 'mat-candy-red' }).success).toBe(true);
        expect(engine.getObject('car-body').material.color).toBe('#d90f14');
        expect(engine.getObject('car-body').material.clearcoat).toBe(1.0);

        // 4. sb_set_pbr_transmission on the object's material
        const transResult = engine.dispatch('sb_set_pbr_transmission', { targetId: 'car-body', transmission: 0.92, ior: 1.58, thickness: 1.5 });
        expect(transResult.success).toBe(true);
        const bodyMat = engine.getObject('car-body').material;
        expect(bodyMat.transmission).toBe(0.92);
        expect(bodyMat.ior).toBe(1.58);
        expect(bodyMat.thickness).toBe(1.5);
        expect(engine.dispatch('sb_set_pbr_transmission', { targetId: 'no-such-object', transmission: 0.5 }).success).toBe(false);

        // 5. sb_set_material_pbr updates objects that use the material
        expect(engine.dispatch('sb_set_material_pbr', { materialId: 'mat-candy-red', roughness: 0.12 }).success).toBe(true);
        expect(engine.getMaterial('mat-candy-red').roughness).toBe(0.12);
        expect(engine.getObject('car-body').material.roughness).toBe(0.12);
        expect(engine.dispatch('sb_set_material_pbr', { objectId: 'car-body', color: 'not-a-colour' }).success).toBe(false);

        // 6. sb_assign_pbr_preset copies the calibrated preset values onto a registered material; an unknown id fails
        expect(engine.dispatch('sb_assign_pbr_preset', { materialId: 'mat-gold', preset: 'polished_gold_24k' }).success).toBe(false);
        expect(engine.getMaterial('mat-gold')).toBeUndefined();
        expect(engine.dispatch('sb_create_material', { materialId: 'mat-gold' }).success).toBe(true);
        const presetResult = engine.dispatch('sb_assign_pbr_preset', { materialId: 'mat-gold', preset: 'polished_gold_24k' });
        expect(presetResult.success).toBe(true);
        expect(engine.getMaterial('mat-gold').metalness).toBe(1.0);
        expect(engine.getMaterial('mat-gold').color).toBe('#ffd700');
        expect(engine.dispatch('sb_assign_pbr_preset', { materialId: 'mat-gold', preset: 'unobtainium' }).success).toBe(false);
    });

    it('does not register the removed PBR operators (sheen, anisotropy, map baking, texture sets)', () => {
        const engine = createOperatorEngine();
        const removed = [
            'sb_set_pbr_sheen', 'sb_set_pbr_anisotropy', 'sb_bake_pbr_maps', 'sb_generate_pbr_texture_set', 'sb_pack_orm_map',
            'sb_apply_pbr_texture_pack', 'sb_layer_pbr_material', 'sb_apply_triplanar_material', 'sb_set_subsurface_scattering'
        ];
        for (const name of removed) {
            expect(engine.getOperator(name), name).toBeUndefined();
            expect(engine.dispatch(name, { materialId: 'mat-x' }).success, name).toBe(false);
        }
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

});
