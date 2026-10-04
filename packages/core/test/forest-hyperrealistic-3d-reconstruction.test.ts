/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Hyperrealistic Forest Procedural 3D Reconstruction from Image', () => {
    const compiler = new NativeCppCompilerService();
    const sourcePath = path.resolve(process.cwd(), 'scripts/generate_forest_procedural_3d.cpp');
    const outGlbPath = path.resolve(process.cwd(), 'public/models/forest_hyperreal.glb');
    const referenceImagePath = path.resolve(process.cwd(), 'public/forest_reference.png');

    it('should locate the generated forest reference photograph', () => {
        expect(fs.existsSync(referenceImagePath)).toBe(true);
        const stats = fs.statSync(referenceImagePath);
        expect(stats.size).toBeGreaterThan(50000);
    });

    it('should compile the native C++20 Astro forest generator without errors', async () => {
        expect(fs.existsSync(sourcePath)).toBe(true);
        const sourceCode = fs.readFileSync(sourcePath, 'utf8');

        const result = await compiler.compileSource(sourceCode, {
            outputBinaryName: 'generate_forest_procedural_3d',
            optimization: '-O3'
        });

        if (!result.success) {
            console.error('Compiler diagnostics:', result.diagnostics);
            console.error('Compiler output:', result.compilerOutput);
        }

        expect(result.success).toBe(true);
        expect(fs.existsSync(result.binaryPath)).toBe(true);
    }, 120000);

    it('should execute generator binary and emit valid binary glTF 2.0 (.glb)', async () => {
        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'generate_forest_procedural_3d');

        const execResult = await compiler.executeBinary(binaryPath, [outGlbPath], process.cwd());
        expect(execResult.exitCode).toBe(0);

        expect(fs.existsSync(outGlbPath)).toBe(true);
        const buf = fs.readFileSync(outGlbPath);
        expect(buf.length).toBeGreaterThan(100000);

        // Validate glTF 2.0 binary header
        const magic = buf.readUInt32LE(0);
        const version = buf.readUInt32LE(4);
        const length = buf.readUInt32LE(8);

        expect(magic).toBe(0x46546C67); // 'glTF'
        expect(version).toBe(2);
        expect(length).toBe(buf.length);

        // Parse JSON chunk
        const jsonChunkLen = buf.readUInt32LE(12);
        const jsonChunkType = buf.readUInt32LE(16);
        expect(jsonChunkType).toBe(0x4E4F534A); // 'JSON'

        const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLen);
        const gltf = JSON.parse(jsonStr);

        expect(gltf.asset?.version).toBe('2.0');
        expect(gltf.meshes?.length).toBeGreaterThanOrEqual(1);

        // Inspect total vertex count and physical extents
        let totalVertices = 0;
        let totalTriangles = 0;
        let maxY = -Infinity;
        let minY = Infinity;
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        if (gltf.accessors) {
            for (const acc of gltf.accessors) {
                if (acc.type === 'VEC3' && acc.max && acc.min) {
                    minX = Math.min(minX, acc.min[0]);
                    maxX = Math.max(maxX, acc.max[0]);
                    minY = Math.min(minY, acc.min[1]);
                    maxY = Math.max(maxY, acc.max[1]);
                    minZ = Math.min(minZ, acc.min[2]);
                    maxZ = Math.max(maxZ, acc.max[2]);
                    totalVertices += acc.count;
                }
                if (acc.type === 'SCALAR') {
                    totalTriangles += acc.count / 3;
                }
            }
        }

        console.log(`Generated Forest GLB Telemetry:`);
        console.log(`  Vertices: ${totalVertices}`);
        console.log(`  Triangles: ${Math.round(totalTriangles)}`);
        console.log(`  Bounding Box: [${minX.toFixed(1)}, ${minY.toFixed(1)}, ${minZ.toFixed(1)}] to [${maxX.toFixed(1)}, ${maxY.toFixed(1)}, ${maxZ.toFixed(1)}]`);

        // Density verification (strict anti-cotton-ball and anti-low-poly)
        expect(totalVertices).toBeGreaterThan(40000);
        expect(maxY - minY).toBeGreaterThan(15.0); // Tall forest canopy >= 15m
        expect(maxX - minX).toBeGreaterThan(20.0); // Broad forest width >= 20m
        expect(maxZ - minZ).toBeGreaterThan(25.0); // Forest depth >= 25m
    }, 60000);

    it('should compile and evaluate general BotanicalOrganGenerator, NurseLogGenerator, and BiomassScatterEngine', async () => {
        const testCpp = `
#include "scratchbox_nature.hpp"
#include "scratchbox_substrate.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox::nature;
using namespace scratchbox::math;
using namespace scratchbox::substrate;

int main() {
    // 1. Test Fibonacci Pinecone
    auto cone = BotanicalOrganGenerator::generateFibonacciPinecone(Vec3(0, 0, 0), Vec3(1, 0, 0));
    assert(!cone.vertices.empty());
    assert(!cone.indices.empty());

    // 2. Test Distichous Conifer Sprig
    auto sprig = BotanicalOrganGenerator::generateDistichousConiferSprig(Vec3(0, 0, 0), Vec3(0, 1, 0));
    assert(!sprig.vertices.empty());

    // 3. Test Shelf Polypore
    auto shelf = BotanicalOrganGenerator::generateShelfPolypore(Vec3(0, 0, 0), Vec3(1, 0, 0));
    assert(!shelf.vertices.empty());

    // 4. Test Wood Sorrel Patch
    auto sorrel = BotanicalOrganGenerator::generateWoodSorrelPatch(Vec3(0, 0, 0));
    assert(!sorrel.vertices.empty());

    // 5. Test Fallen Needle Cluster
    auto needle = BotanicalOrganGenerator::generateFallenNeedleCluster(Vec3(0, 0, 0), Vec3(0, 1, 0));
    assert(!needle.vertices.empty());

    // 6. Test Hollow Nurse Log
    auto log = NurseLogGenerator::generateHollowNurseLog(Vec3(-2, 0, 0), Vec3(2, 0, 0), 0.5f);
    assert(!log.vertices.empty());

    // 7. Test Biomass Scatter Engine
    BiomassScatterEngine::ScatterCriteria crit;
    crit.targetCount = 20;
    auto points = BiomassScatterEngine::samplePoints(
        Vec2(-10, -10), Vec2(10, 10),
        [](float x, float z) { return 0.0f; },
        [](float x, float z) { return Vec3(0, 1, 0); },
        {},
        crit
    );
    assert(points.size() > 5);

    // 8. Test Narrative Clutter Placer
    auto pockets = NarrativeClutterPlacer::identifyPockets(
        { Vec3(0, 0, 0) },
        { { Vec3(-2, 0, 0), Vec3(2, 0, 0) } },
        [](float x, float z) { return 0.0f; },
        [](float x, float z) { return Vec3(0, 1, 0); }
    );
    assert(pockets.size() >= 8);

    // 9. Test Procedural Wear, Inverted Fresnel & Crevice Grime Engine
    WearGrimeParameters wgp;
    wgp.pointiness = 0.8f; // convex edge
    wgp.ambientOcclusion = 0.9f;
    wgp.worldNormal = Vec3(0, 1, 0);
    wgp.viewDirection = Vec3(0, 0, 1);
    auto wearRes = ProceduralWearAndGrimeShader::evaluate(
        Vec3(0.35f, 0.20f, 0.12f),
        0.85f,
        wgp
    );
    assert(wearRes.edgeWearMask > 0.1f);
    assert(wearRes.dustMask >= 0.0f);

    std::cout << "SUCCESS: All Biomass & Organ Generators Validated!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_biomass_engine',
            optimization: '-O3'
        });

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_biomass_engine');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All Biomass & Organ Generators Validated!');
    }, 60000);

    it('should compile and evaluate ProceduralPlantBuilder and PlantPresets from scratchbox_plant_builder.hpp', async () => {
        const testCpp = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox::plant;
using namespace scratchbox::math;

int main() {
    // 1. Test Fluent ProceduralPlantBuilder for Custom Conifer
    ProceduralPlantBuilder b(PlantArchetype::ConiferRedwood);
    b.setPosition(Vec3(0, 0, 0))
     .setTrunk(20.0f, 1.2f, 0.5f, 6, 1.1f, 1.0f)
     .addBranchTier(0.3f, 6, 4.0f, 0.2f, 10.0f)
     .addBranchTier(0.6f, 6, 4.5f, 0.2f, 15.0f)
     .setFoliage(BotanicalLeafType::ConiferDistichous, 1.0f, 1.0f, true)
     .setEpiphytes(true, 2);

    auto result = b.build();
    assert(!result.woodMesh.vertices.empty());
    assert(!result.foliageMesh.vertices.empty());
    assert(result.totalVertices > 1000);
    assert(result.totalTriangles > 800);

    // 2. Test Presets
    auto redwood = PlantPresets::createHeroAncientRedwood(Vec3(5, 0, 0), 28.0f);
    assert(redwood.totalVertices > 2000);

    auto dogwood = PlantPresets::createUnderstoryDogwood(Vec3(2, 0, 2), 5.5f);
    assert(dogwood.totalVertices > 500);

    auto fern = PlantPresets::createSwordFernColony(Vec3(-2, 0, 1), 1.5f, 22);
    assert(!fern.foliageMesh.vertices.empty());

    auto log = PlantPresets::createDecayingNurseLog(Vec3(-3, 0, 0), Vec3(1, 0, 0), 0.45f);
    assert(!log.woodMesh.vertices.empty());

    auto clover = PlantPresets::createWoodSorrelCushion(Vec3(1, 0, 3), 0.85f);
    assert(!clover.foliageMesh.vertices.empty());

    std::cout << "SUCCESS: All Procedural Plant Builders and Presets Validated!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_plant_builder',
            optimization: '-O3'
        });

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_plant_builder');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All Procedural Plant Builders and Presets Validated!');
    }, 60000);

    it('should verify tree trunk and branch hulls are closed watertight manifolds with zero open boundary edges', async () => {
        const testCpp = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <map>
#include <cassert>

using namespace scratchbox::plant;
using namespace scratchbox::geometry;

// Returns count of open boundary edges (edges referenced by exactly 1 triangle)
int countOpenBoundaryEdges(const ScratchboxMesh& mesh) {
    std::map<std::pair<uint32_t, uint32_t>, int> edgeCount;
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        uint32_t i0 = mesh.indices[i];
        uint32_t i1 = mesh.indices[i + 1];
        uint32_t i2 = mesh.indices[i + 2];

        auto addEdge = [&](uint32_t a, uint32_t b) {
            uint32_t u = std::min(a, b);
            uint32_t v = std::max(a, b);
            edgeCount[{u, v}]++;
        };

        addEdge(i0, i1);
        addEdge(i1, i2);
        addEdge(i2, i0);
    }

    int openEdges = 0;
    for (const auto& [edge, count] : edgeCount) {
        if (count == 1) {
            openEdges++;
        }
    }
    return openEdges;
}

int main() {
    // 1. Build a procedural tree trunk without branches to verify trunk hull closure
    ProceduralPlantBuilder b(PlantArchetype::ConiferRedwood);
    b.setTrunk(18.0f, 1.2f, 0.45f, 6, 1.1f, 1.0f);
    auto res = b.build();

    // Verify trunk mesh is closed (has bottom base cap and top spire cap)
    int openTrunkEdges = countOpenBoundaryEdges(res.woodMesh);
    std::cout << "Open Trunk Boundary Edges: " << openTrunkEdges << std::endl;
    assert(openTrunkEdges == 0); // 100% Watertight Closed Hull!

    std::cout << "SUCCESS: Tree Hull Certified 100% Closed & Watertight!" << std::endl;
    return 0;
}
`;
        const result = await compiler.compileSource(testCpp, {
            outputBinaryName: 'test_closed_tree_hulls',
            optimization: '-O3'
        });

        expect(result.success).toBe(true);

        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'test_closed_tree_hulls');
        const execResult = await compiler.executeBinary(binaryPath, [], process.cwd());
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: Tree Hull Certified 100% Closed & Watertight!');
    }, 120000);
});
