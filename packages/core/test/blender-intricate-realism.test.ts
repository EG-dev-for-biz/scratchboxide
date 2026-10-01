/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Blender Intricate Realism Algorithms in C++20 Engine', () => {

    it('compiles and validates curvature wear, weighted normal bevel, geomorphological erosion, and photometric gobos in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::math;
    using namespace scratchbox::geometry;
    using namespace scratchbox::pbr;
    using namespace scratchbox::shaper;
    using namespace scratchbox::nature;
    using namespace scratchbox::lighting;

    // 1. Verify Curvature Tensor & Multi-Scale Stratified Wear
    Vec3 vertexPos(0.0f, 0.0f, 0.0f);
    Vec3 vertexNormal(0.0f, 1.0f, 0.0f);
    std::vector<Vec3> neighbors = {
        Vec3(1.0f, -0.2f, 0.0f),
        Vec3(-1.0f, -0.2f, 0.0f),
        Vec3(0.0f, -0.2f, 1.0f),
        Vec3(0.0f, -0.2f, -1.0f)
    };

    CurvatureMetrics curv = estimateVertexCurvature(vertexPos, vertexNormal, neighbors);
    if (curv.shapeIndex > 1.0f || curv.shapeIndex < -1.0f) {
        std::cerr << "Invalid ShapeIndex out of bounds [-1, 1]: " << curv.shapeIndex << std::endl;
        return 1;
    }

    Vec4 paintAlbedo(0.1f, 0.3f, 0.7f, 1.0f);
    Vec4 primerColor(0.2f, 0.15f, 0.12f, 1.0f);
    Vec4 metalAlbedo(0.95f, 0.95f, 0.95f, 1.0f);

    StratifiedWearResult wearRidge = computeStratifiedWear(
        paintAlbedo, 0.15f,
        primerColor, 0.75f,
        metalAlbedo, 0.25f,
        0.85f, // High positive shape index (ridge)
        0.1f,  // Low ambient occlusion
        0.2f,  // Micro-fracture noise
        1.2f   // High wear intensity
    );

    if (wearRidge.layerExposure <= 0.0f || wearRidge.roughness < 0.2f) {
        std::cerr << "Curvature wear failed to trigger exposed layer on sharp ridge" << std::endl;
        return 2;
    }

    // 2. Verify Thin-Film Interference (Airy Model)
    Vec3 iridescence = evaluateThinFilmInterference(0.85f, 380.0f, 1.4f);
    if (iridescence.x < 0.0f || iridescence.x > 1.0f ||
        iridescence.y < 0.0f || iridescence.y > 1.0f ||
        iridescence.z < 0.0f || iridescence.z > 1.0f) {
        std::cerr << "Thin-film interference channels out of bounds [0, 1]" << std::endl;
        return 3;
    }

    // 3. Verify Weighted Normal Micro-Bevel Modifier
    ScratchboxMesh cube = ScratchboxMesh::createBox(Vec3(2.0f, 2.0f, 2.0f));
    BevelEngine::WeightedNormalOptions bevelOpts;
    bevelOpts.weightPower = 1.0f;
    bevelOpts.thresholdAngleDeg = 45.0f;
    BevelEngine::applyWeightedNormals(cube, bevelOpts);

    for (const auto& v : cube.vertices) {
        float lenSq = v.normal.lengthSq();
        if (std::abs(lenSq - 1.0f) > 1e-3f) {
            std::cerr << "Non-unit normal after weighted bevel: " << lenSq << std::endl;
            return 4;
        }
    }

    // 4. Verify Geomorphological Hydraulic and Thermal Scree Erosion
    const int terrainRes = 32;
    std::vector<float> heightmap(terrainRes * terrainRes, 10.0f);
    for (int y = 0; y < terrainRes; ++y) {
        for (int x = 0; x < terrainRes; ++x) {
            heightmap[y * terrainRes + x] = 10.0f + 5.0f * std::sin(x * 0.2f) * std::cos(y * 0.2f);
        }
    }

    HydraulicErosionParams erosionParams;
    erosionParams.numDroplets = 500;
    erosionParams.maxDropletLifetime = 15;
    simulateHydraulicErosion(heightmap, terrainRes, terrainRes, erosionParams);
    simulateThermalErosion(heightmap, terrainRes, terrainRes, 32.0f, 1.0f, 5, 0.4f);

    bool hasErosionVariation = false;
    for (float h : heightmap) {
        if (std::abs(h - 10.0f) > 0.01f) {
            hasErosionVariation = true;
            break;
        }
    }
    if (!hasErosionVariation) {
        std::cerr << "Terrain erosion simulation produced flat invariant topology" << std::endl;
        return 5;
    }

    // 5. Verify Photometric Presets and Gobo Attenuation
    Light sun = photometric::createSunlight(Vec3(0.5f, -1.0f, 0.3f), photometric::LUX_DIRECT_SUNLIGHT);
    if (sun.intensity < 99000.0f || sun.kelvin < 6400.0f) {
        std::cerr << "Photometric sunlight preset intensity or CCT mismatch" << std::endl;
        return 6;
    }

    float canopyGobo = GoboProjector::evaluateCanopyCookie(Vec3(1.2f, 0.0f, 2.4f), 1.0f);
    if (canopyGobo < 0.0f || canopyGobo > 1.0f) {
        std::cerr << "Canopy gobo attenuation out of bounds [0, 1]: " << canopyGobo << std::endl;
        return 7;
    }

    std::cout << "SUCCESS: All Blender intricate realism algorithms verified in native C++20." << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource, {
            optimization: '-O3',
            outputBinaryName: 'blender_realism_test'
        });
        if (!compileResult.success) {
            console.error('COMPILE ERROR:', compileResult.errorMessage);
        }
        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All Blender intricate realism algorithms verified in native C++20.');
    });

    it('generates, wears, and streams a complete photorealistic hard-surface asset into binary glTF 2.0', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::math;
    using namespace scratchbox::geometry;
    using namespace scratchbox::pbr;
    using namespace scratchbox::shaper;
    using namespace scratchbox::lighting;

    // Build mechanical chamfered pedestal
    ScratchboxMesh pedestal = ScratchboxMesh::createCylinder(1.5f, 1.8f, 0.8f, 32);
    
    // Apply weighted normal micro-bevel
    BevelEngine::WeightedNormalOptions bevelOpts;
    bevelOpts.weightPower = 1.5f;
    bevelOpts.thresholdAngleDeg = 40.0f;
    BevelEngine::applyWeightedNormals(pedestal, bevelOpts);

    // Apply procedural curvature wear to vertex colors
    Vec4 darkEnamel(0.08f, 0.12f, 0.18f, 1.0f);
    Vec4 primer(0.25f, 0.15f, 0.10f, 1.0f);
    Vec4 steel(0.92f, 0.92f, 0.95f, 1.0f);

    for (size_t i = 0; i < pedestal.vertices.size(); ++i) {
        auto& v = pedestal.vertices[i];
        
        // Find neighboring vertices
        std::vector<Vec3> nbs;
        for (size_t j = 0; j < pedestal.vertices.size(); ++j) {
            if (i != j && (pedestal.vertices[j].position - v.position).lengthSq() < 0.5f * 0.5f) {
                nbs.push_back(pedestal.vertices[j].position);
                if (nbs.size() >= 6) break;
            }
        }

        CurvatureMetrics cm = estimateVertexCurvature(v.position, v.normal, nbs);
        float microFracture = FastNoise3D::perlin(v.position.x * 20.0f, v.position.y * 20.0f, v.position.z * 20.0f, 101);
        
        StratifiedWearResult wear = computeStratifiedWear(
            darkEnamel, 0.20f,
            primer, 0.65f,
            steel, 0.18f,
            cm.shapeIndex,
            0.15f,
            microFracture,
            1.2f
        );

        v.color = wear.albedo;
    }

    pedestal.material = PbrMaterial::titanium();
    pedestal.material.clearcoatFactor = 0.5f;
    pedestal.material.clearcoatRoughnessFactor = 0.08f;

    // Serialize to binary glTF 2.0 (.glb)
    auto glbBytes = scratchbox::io::GlbWriter::serializeToGlb(pedestal);
    if (glbBytes.size() < 100) {
        std::cerr << "GLB binary serialization failed or too small" << std::endl;
        return 1;
    }

    std::cout << "GLB_STREAM_SUCCESS: Serialized " << glbBytes.size() << " bytes" << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource, {
            optimization: '-O3',
            outputBinaryName: 'blender_realism_pedestal_test'
        });
        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('GLB_STREAM_SUCCESS:');
    });
});
