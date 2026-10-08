/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for High-Fidelity 3D Geometry Pipeline:
 * - ContinuousEdgeBeveler (edge fillet ribbons & specular highlights)
 * - LaplaceBeltramiCurvatureEngine (discrete Laplace-Beltrami & cavity AO)
 * - HydraulicErosionSimulator (particle droplet & talus scree erosion)
 * - ProceduralWearAndGrimeShader (curvature-driven physical weathering)
 * - Native C++20 streaming compilation & binary glTF 2.0 output
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('High-Fidelity 3D Geometry Pipeline (C++20 Native Engine)', () => {
    let compiler: NativeCppCompilerService;

    beforeAll(() => {
        compiler = NativeCppCompilerService.getInstance();
    });

    it('should compile and run ContinuousEdgeBeveler, LaplaceBeltramiCurvatureEngine, and WearShader', async () => {
        const source = `#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_halfedge.hpp"
#include "scratchbox_substrate.hpp"
#include "scratchbox_io.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox;

int main() {
    // 1. Build a cube with sharp 90-degree edges
    geometry::ScratchboxMesh cube("TestCube");
    cube.addVertex(geometry::Vertex(math::Vec3(-1, -1, -1), math::Vec3(0, 0, -1)));
    cube.addVertex(geometry::Vertex(math::Vec3( 1, -1, -1), math::Vec3(0, 0, -1)));
    cube.addVertex(geometry::Vertex(math::Vec3( 1,  1, -1), math::Vec3(0, 0, -1)));
    cube.addVertex(geometry::Vertex(math::Vec3(-1,  1, -1), math::Vec3(0, 0, -1)));
    cube.addVertex(geometry::Vertex(math::Vec3(-1, -1,  1), math::Vec3(0, 0,  1)));
    cube.addVertex(geometry::Vertex(math::Vec3( 1, -1,  1), math::Vec3(0, 0,  1)));
    cube.addVertex(geometry::Vertex(math::Vec3( 1,  1,  1), math::Vec3(0, 0,  1)));
    cube.addVertex(geometry::Vertex(math::Vec3(-1,  1,  1), math::Vec3(0, 0,  1)));

    auto addQuad = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
        cube.addTriangle(a, b, c);
        cube.addTriangle(a, c, d);
    };
    addQuad(0, 3, 2, 1); // Front
    addQuad(4, 5, 6, 7); // Back
    addQuad(0, 1, 5, 4); // Bottom
    addQuad(2, 3, 7, 6); // Top
    addQuad(0, 4, 7, 3); // Left
    addQuad(1, 2, 6, 5); // Right

    // 2. Bevel sharp edges
    halfedge::BevelConfig bcfg;
    bcfg.bevelRadius = 0.08f;
    bcfg.dihedralThresholdDeg = 45.0f;
    bcfg.segments = 2;
    auto beveled = halfedge::ContinuousEdgeBeveler::bevelSharpEdges(cube, bcfg);

    if (beveled.vertices.size() <= cube.vertices.size() || beveled.indices.size() <= cube.indices.size()) {
        std::cerr << "ContinuousEdgeBeveler failed to subdivide and bevel sharp edges." << std::endl;
        return 1;
    }

    // 3. Compute Laplace-Beltrami discrete curvature and cavity AO
    auto curv = halfedge::LaplaceBeltramiCurvatureEngine::computeAndBake(beveled);
    if (curv.meanCurvature.size() != beveled.vertices.size() || curv.cavityOcclusion.size() != beveled.vertices.size()) {
        std::cerr << "LaplaceBeltramiCurvatureEngine size mismatch." << std::endl;
        return 2;
    }

    // 4. Apply procedural wear and grime
    substrate::ProceduralWearAndGrimeShader::applyWearAndGrimeToMesh(beveled);

    // Stream chunk
    io::GlbWriter::streamChunk(beveled, "beveled-weathered-cube");
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_hifi_geom_${Date.now()}`
        });

        expect(compileRes.diagnostics).toEqual([]);
        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('beveled-weathered-cube');
            expect(chunk.vertexCount).toBeGreaterThan(50);
            expect(chunk.indexCount).toBeGreaterThan(50);
            expect(chunk.glbBase64.length).toBeGreaterThan(500);

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 60000);

    it('should simulate particle hydraulic and thermal erosion on heightfields', async () => {
        const source = `#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_infiniti.hpp"
#include "scratchbox_io.hpp"
#include <iostream>

using namespace scratchbox;

int main() {
    infiniti::WarpedTerrainConfig tcfg;
    tcfg.contentScale = 12.0f;
    infiniti::HydraulicErosionConfig ecfg;
    ecfg.iterations = 2000;
    ecfg.thermalIterations = 3;
    ecfg.talusAngleThresholdDeg = 33.0f;

    auto terrain = infiniti::HydraulicErosionSimulator::generateErodedTerrainMesh(
        48, 48, -20.0f, -20.0f, 0.833f, tcfg, ecfg
    );

    if (terrain.vertices.size() != 48 * 48) {
        std::cerr << "Unexpected vertex count: " << terrain.vertices.size() << std::endl;
        return 1;
    }

    io::GlbWriter::streamChunk(terrain, "eroded-terrain-test");
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_erosion_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('eroded-terrain-test');
            expect(chunk.vertexCount).toBe(48 * 48);
            expect(chunk.indexCount).toBe(47 * 47 * 6);

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 60000);
});
