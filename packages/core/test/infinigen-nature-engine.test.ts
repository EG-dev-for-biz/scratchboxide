/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Infinigen Nature & Procedural Engine Integration', () => {
    const compiler = new NativeCppCompilerService();

    it('should compile and validate DomainWarpedTerrain, SoilMachineSedimentTracker, and KeypointClusterScatterEngine', async () => {
        const testCpp = `
#include "scratchbox_infinigen.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox::infinigen;
using namespace scratchbox::math;

int main() {
    std::cout << "Testing Infinigen Procedural Logic in C++20..." << std::endl;

    // 1. Test Domain-Warped Terrain Generator
    WarpedTerrainConfig tCfg;
    tCfg.warpScale = 2.0f;
    tCfg.contentScale = 0.8f;
    float h1 = DomainWarpedTerrain::sampleHeight(5.0f, -8.0f, tCfg);
    float h2 = DomainWarpedTerrain::sampleHeight(-12.0f, 15.0f, tCfg);
    assert(h1 != h2);

    Vec3 norm = DomainWarpedTerrain::sampleNormal(5.0f, -8.0f, tCfg);
    assert(std::abs(norm.length() - 1.0f) < 0.05f);
    assert(norm.y > 0.0f); // Upward facing terrain normal

    // 2. Test Soil Machine Sediment & Moisture Tracker
    int cols = 32, rows = 32;
    float step = 1.0f;
    auto heightFn = [&](float x, float z) {
        return DomainWarpedTerrain::sampleHeight(x, z, tCfg);
    };

    SoilSimulationConfig sCfg;
    sCfg.numParticles = 500;
    sCfg.maxSteps = 25;
    auto soilResult = SoilMachineSedimentTracker::runSimulation(
        cols, rows, -16.0f, -16.0f, step, heightFn, sCfg
    );
    assert(soilResult.waterTrackMap.size() == static_cast<size_t>(cols * rows));
    assert(soilResult.sedimentMap.size() == static_cast<size_t>(cols * rows));

    float moisture = soilResult.sampleMoisture(0.0f, 0.0f, -16.0f, -16.0f, step, cols, rows);
    assert(moisture >= 0.0f);

    // 3. Test Keypoint Cluster Scatter Engine
    ClusterScatterConfig cCfg;
    cCfg.numKeypoints = 6;
    cCfg.clusterRadius = 3.0f;
    cCfg.instancesPerCluster = 8;
    cCfg.minInstanceDistance = 0.2f;

    auto normalFn = [&](float x, float z) {
        return DomainWarpedTerrain::sampleNormal(x, z, tCfg);
    };

    auto points = KeypointClusterScatterEngine::generateClusters(
        -15.0f, 15.0f, -15.0f, 15.0f,
        heightFn, normalFn, cCfg
    );
    assert(!points.empty());
    assert(points.size() <= 6 * 8);

    for (const auto& pt : points) {
        assert(pt.position.x >= -16.0f && pt.position.x <= 16.0f);
        assert(pt.scale > 0.0f);
        assert(pt.clusterDistance <= cCfg.clusterRadius + 0.1f);
    }

    // 4. Test 4-Sided Volumetric Micro-Cone Needle Generator
    auto needleMesh = InfinigenNeedleConeGenerator::generateVolumetricNeedle(
        Vec3(0, 0, 0), Vec3(0, 1, 0), 0.045f, 0.0032f, 0.0006f
    );
    assert(!needleMesh.vertices.empty());
    assert(needleMesh.indices.size() >= 12); // At least 4-sided pyramid/cone

    // 5. Test Fern Pinnae Generator with Gravity Curvature
    auto pinnaeMesh = InfinigenFernPinnaeGenerator::generateCurvedPinna(
        Vec3(0, 0, 0), Vec3(1, 0, 0), Vec3(0, 1, 0), 0.35f, 0.08f
    );
    assert(!pinnaeMesh.vertices.empty());
    assert(!pinnaeMesh.indices.empty());

    // 6. Test Procedural Dual-Tone Rhytidome Shader Kernel
    auto barkResult = ProceduralRhytidomeShaderKernel::evaluate(
        Vec3(0.5f, 2.3f, 0.5f), Vec3(1, 0, 0)
    );
    assert(barkResult.albedo.x > 0.0f);
    assert(barkResult.roughness >= 0.0f && barkResult.roughness <= 1.0f);

    std::cout << "SUCCESS: All Infinigen Procedural Systems Verified!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_infinigen_engine',
            optimization: '-O3'
        });

        if (!result.success) {
            console.error('Compiler diagnostics:', result.diagnostics);
            console.error('Compiler output:', result.compilerOutput);
        }

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_infinigen_engine');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All Infinigen Procedural Systems Verified!');
    }, 60000);
});
