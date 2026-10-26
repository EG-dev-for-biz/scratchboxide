/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    generateDefaultCpp3DSource,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import {
    createOperatorEngine
} from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    NativeCppCompilerService
} from '../src/node/3d-engine/native-compiler-service';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Universal Nature, Atmosphere, SSS & Triplanar 3D Systems', () => {

    it('1. no longer registers the record-only triplanar / SSS / fog / vegetation / terrain / foliage operators', () => {
        const initialScene: Scene3DData = {
            title: 'Nature Scene',
            renderMode: 'pbr',
            customMeshes: [{ id: 'mesh-hero', name: 'Hero Boulder', type: 'custom', position: [0, 0, 0] }]
        };
        const engine = createOperatorEngine(initialScene);
        for (const name of [
            'sb_apply_triplanar_material',
            'sb_set_subsurface_scattering',
            'sb_add_volumetric_fog',
            'sb_generate_l_system_vegetation',
            'sb_generate_biome_terrain',
            'sb_generate_detailed_foliage',
            'sb_transfer_foliage_normals'
        ]) {
            expect(engine.getOperator(name)).toBeUndefined();
            expect(engine.dispatch(name, { targetMeshId: 'mesh-hero' }).success).toBe(false);
        }
        const updatedScene = engine.getSceneData();
        expect(updatedScene.customMeshes?.length).toBe(1);
        expect((updatedScene.environment as any)?.volumetricFog).toBeUndefined();
    });

    it('3. should generate nature_atmosphere C++20 source code utilizing all 4 new engine modules', () => {
        const cppCode = generateDefaultCpp3DSource('nature_atmosphere', 'Ancient Monolith Forest');
        expect(cppCode).toContain('#include "scratchbox_engine.hpp"');
        expect(cppCode).toContain('using namespace scratchbox::triplanar;');
        expect(cppCode).toContain('using namespace scratchbox::sss;');
        expect(cppCode).toContain('using namespace scratchbox::volumetrics;');
        expect(cppCode).toContain('using namespace scratchbox::nature;');
        expect(cppCode).toContain('generateBiomeTerrain');
        expect(cppCode).toContain('applyTriplanarToMesh');
        // trees are SB-Veggie trees (sb.create_tree), never grown in a C++ generator (sb-veggie-lockdown.ts)
        expect(cppCode).not.toContain('generateProceduralTree');
        expect(cppCode).toContain('getSkyGoldenHourSH');
        expect(cppCode).toContain('scene.streamSceneGlb');
    });

    it('4. should compile and stream glTF 2.0 binary chunks from C++20 nature_atmosphere program with NativeCppCompilerService', async () => {
        const compiler = new NativeCppCompilerService();
        const natureCpp = generateDefaultCpp3DSource('nature_atmosphere', 'Verdant Forest Plateau');

        const compileRes = await compiler.compileSource(natureCpp, 'verdant_forest.cpp');
        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBeGreaterThan(0);

            // Verify binary glTF 2.0 magic 'glTF' (0x46546C67)
            const chunk = execRes.chunks[0];
            expect(chunk.vertexCount).toBeGreaterThan(100);
            const glbBuffer = Buffer.from(chunk.glbBase64, 'base64');
            const magic = glbBuffer.toString('ascii', 0, 4);
            expect(magic).toBe('glTF');
        }
    });

    it('5. should compile and verify unit math across Triplanar, SSS, Volumetrics, and L-System Nature', async () => {
        const compiler = new NativeCppCompilerService();

        // Direct C++ unit test validating mathematical correctness of all 4 modules
        const unitTestCpp = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::math;
    using namespace scratchbox::triplanar;
    using namespace scratchbox::sss;
    using namespace scratchbox::volumetrics;
    using namespace scratchbox::nature;

    // --- 1. Triplanar Weight Normalization ---
    Vec3 normal(0.57735f, 0.57735f, 0.57735f); // equal diagonal
    Vec3 weights = computeTriplanarWeights(normal, 4.0f);
    float sumW = weights.x + weights.y + weights.z;
    assert(std::fabs(sumW - 1.0f) < 0.001f);
    assert(std::fabs(weights.x - weights.y) < 0.001f);

    // --- 2. SSS Burley Dipole Evaluation ---
    SSSProfile leafProfile = PROFILE_GREEN_LEAF;
    Vec3 sssNear = evaluateBurleyDiffusion(0.1f, leafProfile.scatterRadius, leafProfile.surfaceAlbedo);
    Vec3 sssFar = evaluateBurleyDiffusion(10.0f, leafProfile.scatterRadius, leafProfile.surfaceAlbedo);
    assert(sssNear.x > sssFar.x);
    assert(sssNear.y > 0.0f && sssFar.y >= 0.0f);

    // --- 3. Atmospheric Scattering Phase Function ---
    float phaseForward = henyeyGreensteinPhase(1.0f, 0.75f);  // cosTheta = 1 (forward)
    float phaseBackward = henyeyGreensteinPhase(-1.0f, 0.75f); // cosTheta = -1 (back)
    assert(phaseForward > phaseBackward); // Forward Mie peak

    // Spherical Harmonics Irradiance test
    SphericalHarmonics9 skySH = getSkyGoldenHourSH();
    Vec3 skyUp = skySH.evaluateIrradiance(Vec3(0, 1, 0));
    Vec3 skyDown = skySH.evaluateIrradiance(Vec3(0, -1, 0));
    assert(skyUp.y > skyDown.y); // Sky irradiance greater upward than into ground

    // --- 4. Nature & L-System Generation ---
    LSystemTreeParams treeParams;
    treeParams.maxDepth = 3;
    treeParams.initialLength = 2.0f;
    treeParams.generateLeaves = true;
    scratchbox::geometry::Mesh treeMesh = generateProceduralTree(Vec3(0, 0, 0), treeParams);
    assert(!treeMesh.vertices.empty());
    assert(!treeMesh.indices.empty());
    assert(!treeMesh.normals.empty());

    // --- 5. Biome Terrain Generation ---
    BiomeTerrainParams terrainParams;
    terrainParams.width = 10.0f;
    terrainParams.depth = 10.0f;
    terrainParams.resolution = 16;
    scratchbox::geometry::Mesh terrainMesh = generateBiomeTerrain(terrainParams);
    assert(terrainMesh.vertices.size() == 16 * 16);
    assert(terrainMesh.indices.size() == 15 * 15 * 6);
    assert(!terrainMesh.vertexColors.empty());

    // Stream a minimal verification chunk
    scratchbox::io::GlbWriter::streamChunk(treeMesh, "nature_verification");
    return 0;
}`;

        const compileRes = await compiler.compileSource(unitTestCpp, 'nature_unit_test.cpp');
        expect(compileRes.success).toBe(true);

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);
            expect(execRes.chunks[0].name).toBe('nature_verification');
        }
    });

    it('6. should verify envelope normal transfer, detailed foliage cards, and thin-wall SSS mathematics in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const foliageMathTestCpp = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::math;
    using namespace scratchbox::sss;
    using namespace scratchbox::nature;
    using namespace scratchbox::geometry;

    // --- 1. Envelope Normal Transfer Math Verification ---
    // Create card with flat normals pointing along +Z
    Mesh cardMesh;
    cardMesh.vertices = {
        Vec3(0.5f, 0.5f, 0.0f),
        Vec3(-0.5f, 0.5f, 0.0f),
        Vec3(-0.5f, -0.5f, 0.0f),
        Vec3(0.5f, -0.5f, 0.0f)
    };
    cardMesh.normals = {
        Vec3(0.0f, 0.0f, 1.0f),
        Vec3(0.0f, 0.0f, 1.0f),
        Vec3(0.0f, 0.0f, 1.0f),
        Vec3(0.0f, 0.0f, 1.0f)
    };
    cardMesh.indices = { 0, 1, 2, 0, 2, 3 };

    // Define clump envelope sphere centered at origin
    std::vector<FoliageClumpHelper> helpers = {
        { Vec3(0, 0, 0), 1.0f, Vec3(1, 1, 1), 1 }
    };

    // Transfer normals with 100% mix factor and 0 upward bias
    transferFoliageNormals(cardMesh, helpers, 1.0f, 0.0f);

    // Verify each vertex normal now points radially outward from (0,0,0)
    for (size_t i = 0; i < cardMesh.vertices.size(); ++i) {
        Vec3 expected = cardMesh.vertices[i].normalized();
        float dotVal = cardMesh.normals[i].dot(expected);
        assert(std::fabs(dotVal - 1.0f) < 0.01f);
    }

    // --- 2. Thin-Wall Subsurface Scattering Transmission Verification ---
    Vec3 sunDir(0.0f, 0.0f, 1.0f);
    Vec3 viewDir(0.0f, 0.0f, -1.0f);
    Vec3 normal(0.0f, 0.0f, 1.0f); // Facing sun directly
    Vec3 lightRadiance(1.0f, 1.0f, 1.0f);
    SSSProfile leafProfile = PROFILE_GREEN_LEAF;

    // Front-lit case: normal faces sun
    Vec3 frontLit = evaluateThinWallTransmission(sunDir, viewDir, normal, lightRadiance, leafProfile, 0.35f, 1.0f);
    assert(frontLit.x > 0.0f && frontLit.y > 0.0f);

    // Back-lit case: normal faces away from sun (sun penetrates through leaf card)
    Vec3 backNormal(0.0f, 0.0f, -1.0f);
    Vec3 sideView(1.0f, 0.0f, 0.0f);
    Vec3 backLitSide = evaluateThinWallTransmission(sunDir, sideView, backNormal, lightRadiance, leafProfile, 0.35f, 1.0f);
    // Green chlorophyll transmission should dominate in transmitted light
    assert(backLitSide.y > backLitSide.x && backLitSide.y > backLitSide.z);

    // Forward solar rim peak: looking directly towards sun through leaf
    Vec3 headOnBacklitView(0.0f, 0.0f, -1.0f);
    Vec3 rimLit = evaluateThinWallTransmission(sunDir, headOnBacklitView, backNormal, lightRadiance, leafProfile, 0.35f, 1.0f);
    assert(rimLit.y >= backLitSide.y); // View-dependent forward solar peak enhances backlight

    // --- 3. Detailed Foliage Cards Synthesis ---
    Mesh canopyMesh;
    FoliageClumpHelper helper{ Vec3(0, 1.5f, 0), 1.0f, Vec3(1, 1, 1), 1 };
    uint32_t seed = 42;
    appendDetailedFoliageCards(canopyMesh, Vec3(0, 1.5f, 0), Vec3(0, 1, 0), 0.40f, helper, seed, 4);
    assert(!canopyMesh.vertices.empty());
    assert(!canopyMesh.normals.empty());
    assert(!canopyMesh.vertexColors.empty());
    assert(canopyMesh.indices.size() > 12);

    // --- 4. Procedural Tree with Detailed Cards & Transferred Normals ---
    LSystemTreeParams treeParams;
    treeParams.maxDepth = 3;
    treeParams.generateLeaves = true;
    treeParams.useDetailedFoliageCards = true;
    treeParams.transferSmoothNormals = true;
    Mesh treeWithSoftFoliage = generateProceduralTree(Vec3(0, 0, 0), treeParams);
    assert(treeWithSoftFoliage.vertices.size() > 50);

    scratchbox::io::GlbWriter::streamChunk(treeWithSoftFoliage, "detailed_foliage_verification");
    return 0;
}`;

        const compileRes = await compiler.compileSource(foliageMathTestCpp, { outputBinaryName: 'foliage_math_test' });
        expect(compileRes.success).toBe(true);

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);
            expect(execRes.chunks[0].name).toBe('detailed_foliage_verification');
        }
    });
});
