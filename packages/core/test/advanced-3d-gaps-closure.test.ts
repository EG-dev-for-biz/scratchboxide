/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { DynamicDagPlanner } from '../src/node/deep-write/dynamic-dag-planner';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('3D Engine Gaps 2, 3, 4 Closure: Half-Edge/QEM, MikkTSpace/Harmonic UVs, IBL/ACES', () => {
    const compiler = new NativeCppCompilerService();

    // ========================================================================
    // Native C++20 Verification (Clang++ compilation and execution)
    // ========================================================================
    it('should compile and verify Gap 2 (Half-Edge DCEL, QEM Decimation, Laplace-Beltrami Curvature)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    // 1. Generate indexed manifold sphere
    auto sphereMesh = geometry::GeometryBuilder::createSphere(1.0f, 12, 16);

    size_t origTriCount = sphereMesh.indices.size() / 3;
    assert(origTriCount > 50);

    // 2. Test Half-Edge DCEL conversion
    auto heMesh = halfedge::HalfEdgeMesh::fromMesh(sphereMesh);
    assert(heMesh.vertices.size() == sphereMesh.vertices.size());
    assert(heMesh.faces.size() == origTriCount);
    assert(heMesh.halfEdges.size() == origTriCount * 3);

    // Verify closed 2-manifold twin connectivity (sphere has no boundaries)
    for (const auto& he : heMesh.halfEdges) {
        assert(he.twin >= 0);
        assert(he.next >= 0);
        assert(he.prev >= 0);
        assert(heMesh.halfEdges[he.twin].twin == he.id);
    }

    // Convert back and verify fidelity
    auto reconstructed = heMesh.toScratchboxMesh("reconstructed_sphere");
    assert(reconstructed.vertices.size() == sphereMesh.vertices.size());
    assert(reconstructed.indices.size() == sphereMesh.indices.size());

    // 3. Test QEM Mesh Decimation
    uint32_t targetTriangles = static_cast<uint32_t>(origTriCount * 0.45);
    auto lodMesh = halfedge::decimateMeshQEM(sphereMesh, targetTriangles);
    size_t lodTriCount = lodMesh.indices.size() / 3;
    assert(lodTriCount <= origTriCount);
    assert(lodTriCount > 0);
    assert(lodMesh.vertices.size() > 0);

    // 4. Test Laplace-Beltrami Curvature
    auto curvature = halfedge::computeLaplaceBeltramiCurvature(sphereMesh);
    assert(curvature.meanCurvature.size() == sphereMesh.vertices.size());
    assert(curvature.gaussianCurvature.size() == sphereMesh.vertices.size());

    // On a unit sphere, Gaussian curvature K should be approximately positive
    float avgK = 0.0f;
    for (float k : curvature.gaussianCurvature) {
        avgK += k;
    }
    avgK /= curvature.gaussianCurvature.size();
    assert(avgK > 0.1f);

    std::cout << "GAP_2_OK: OrigTri=" << origTriCount << " LodTri=" << lodTriCount << " AvgK=" << avgK << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_gap2_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('GAP_2_OK');

            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    it('should compile and verify Gap 3 (MikkTSpace Tangents, Conformal Harmonic UVs, glTF Tangent Streaming)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    // 1. Generate a test plane mesh with boundary
    auto plane = geometry::GeometryBuilder::createPlane(3.0f, 3.0f, 6, 6);
    size_t vertCount = plane.vertices.size();

    // 2. Generate MikkTSpace orthonormal tangents
    uv::generateMikkTSpaceTangents(plane);

    for (const auto& v : plane.vertices) {
        // Tangent should have unit length (x, y, z)
        math::Vec3 t(v.tangent.x, v.tangent.y, v.tangent.z);
        float len = t.length();
        assert(std::abs(len - 1.0f) < 1e-3f);

        // Handedness w should be +1 or -1
        assert(std::abs(std::abs(v.tangent.w) - 1.0f) < 1e-4f);

        // Tangent must be orthogonal to normal
        float dotNT = v.normal.dot(t);
        assert(std::abs(dotNT) < 1e-3f);
    }

    // 3. Test Tangent-Space TBN Normal Perturbation
    math::Vec3 geomNormal(0, 1, 0);
    math::Vec4 tangent(1, 0, 0, 1);
    // Unperturbed tangent-space normal (0, 0, 1) should yield geometric normal
    math::Vec3 p0 = uv::perturbNormalTBN(geomNormal, tangent, math::Vec3(0, 0, 1));
    assert(std::abs(p0.y - 1.0f) < 1e-3f);

    // Perturbed tangent-space normal (1, 0, 0) should yield tangent vector
    math::Vec3 p1 = uv::perturbNormalTBN(geomNormal, tangent, math::Vec3(1, 0, 0));
    assert(std::abs(p1.x - 1.0f) < 1e-3f);

    // 4. Test Harmonic Conformal UV Parameterization (Tutte's spring embedding)
    uv::parameterizeHarmonicUV(plane, 50);
    for (const auto& v : plane.vertices) {
        // Bijective interior relaxation inside (0, 1)
        assert(v.uv.x >= 0.0f && v.uv.x <= 1.0f);
        assert(v.uv.y >= 0.0f && v.uv.y <= 1.0f);
    }

    // 5. Verify glTF 2.0 streaming with 4-component TANGENT attribute
    io::GlbWriter::streamChunk(plane, "test_plane_tangents");

    std::cout << "GAP_3_OK: Verts=" << vertCount << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_gap3_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('GAP_3_OK');
            expect(execRes.chunks.length).toBe(1);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('test_plane_tangents');
            // Decode glTF JSON chunk to verify TANGENT accessor and bufferView
            const glbBuffer = Buffer.from(chunk.glbBase64, 'base64');
            const jsonLen = glbBuffer.readUInt32LE(12);
            const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLen);
            const gltf = JSON.parse(jsonStr);

            expect(gltf.meshes[0].primitives[0].attributes.TANGENT).toBeDefined();
            expect(gltf.accessors[gltf.meshes[0].primitives[0].attributes.TANGENT].type).toBe('VEC4');

            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    it('should compile and verify Gap 4 (Spherical Harmonics Diffuse, Split-Sum Specular, ACES Filmic Tonemapping)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    // 1. Order-3 Spherical Harmonics Diffuse Irradiance
    auto goldenSH = ibl::SphericalHarmonics9::goldenHour();
    math::Vec3 upNormal(0, 1, 0);
    math::Vec3 irradianceUp = goldenSH.evaluateIrradiance(upNormal);
    assert(irradianceUp.x > 0.0f);
    assert(irradianceUp.y > 0.0f);
    assert(irradianceUp.z > 0.0f);

    auto daylightSH = ibl::SphericalHarmonics9::clearDaylight();
    math::Vec3 irradianceDay = daylightSH.evaluateIrradiance(upNormal);
    // Daylight sky dome should have higher blue irradiance than red
    assert(irradianceDay.z >= irradianceDay.x);

    // 2. Karis / Epic Games Split-Sum Specular BRDF Integration
    math::Vec2 brdf0 = ibl::integrateBRDF(1.0f, 0.1f);
    assert(brdf0.x >= 0.0f && brdf0.x <= 1.0f);
    assert(brdf0.y >= 0.0f && brdf0.y <= 1.0f);

    math::Vec3 V(0, 0.707f, 0.707f);
    math::Vec3 F0(0.04f, 0.04f, 0.04f); // Dielectric plastic
    math::Vec3 spec = ibl::evaluateSplitSumSpecular(upNormal, V, 0.25f, F0, daylightSH);
    assert(spec.x >= 0.0f && spec.y >= 0.0f && spec.z >= 0.0f);

    // 3. ACES Filmic Tonemapping Curve
    math::Vec3 hdrLight(15.0f, 35.0f, 80.0f);
    math::Vec3 ldrTonemapped = ibl::acesFilmic(hdrLight, 1.0f);
    assert(ldrTonemapped.x >= 0.0f && ldrTonemapped.x <= 1.0f);
    assert(ldrTonemapped.y >= 0.0f && ldrTonemapped.y <= 1.0f);
    assert(ldrTonemapped.z >= 0.0f && ldrTonemapped.z <= 1.0f);

    // 4. Optical Lens Vignette
    math::Vec3 centerColor(1, 1, 1);
    math::Vec3 vigCorner = ibl::applyVignette(centerColor, math::Vec2(0.0f, 0.0f), 0.40f);
    assert(vigCorner.x < centerColor.x); // Corner must be darkened

    std::cout << "GAP_4_OK: LdrX=" << ldrTonemapped.x << " VigCorner=" << vigCorner.x << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_gap4_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('GAP_4_OK');

            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // TypeScript DirectDispatchOperatorEngine Operator Registry Verification
    // ========================================================================
    it('should register and execute new operators in DirectDispatchOperatorEngine', () => {
        const initialScene: Scene3DData = {
            title: 'Advanced 3D Scene',
            customMeshes: [
                {
                    id: 'mesh_test_hero',
                    name: 'Hero Mesh',
                    type: 'custom',
                    material: {
                        color: 0x4488ff,
                        roughness: 0.35,
                        metalness: 0.8
                    }
                }
            ],
            environment: {}
        };

        const engine = createOperatorEngine(initialScene);

        // 1. QEM Decimation operator
        const decimateRes = engine.dispatch('sb_decimate_mesh_qem', {
            targetId: 'mesh_test_hero',
            ratio: 0.40,
            targetTriangles: 1200
        });
        expect(decimateRes.success).toBe(true);
        const scene1 = engine.getSceneData();
        expect(scene1.customMeshes![0].decimation?.enabled).toBe(true);
        expect(scene1.customMeshes![0].decimation?.ratio).toBe(0.40);

        // 2. Laplace-Beltrami Curvature operator
        const curvRes = engine.dispatch('sb_compute_halfedge_curvature', {
            targetId: 'mesh_test_hero'
        });
        expect(curvRes.success).toBe(true);
        const scene2 = engine.getSceneData();
        expect((scene2.customMeshes![0].material as any).laplaceBeltramiCurvature?.enabled).toBe(true);

        // 3. MikkTSpace Tangents operator
        const tanRes = engine.dispatch('sb_generate_mikktspace_tangents', {
            targetId: 'mesh_test_hero'
        });
        expect(tanRes.success).toBe(true);
        const scene3 = engine.getSceneData();
        expect(scene3.customMeshes![0].tangents?.standard).toBe('mikktspace');

        // 4. Harmonic UV Unwrap operator
        const uvRes = engine.dispatch('sb_unwrap_mesh_uvs', {
            targetId: 'mesh_test_hero',
            method: 'harmonic',
            maxIterations: 60
        });
        expect(uvRes.success).toBe(true);
        const scene4 = engine.getSceneData();
        expect(scene4.customMeshes![0].uvUnwrap?.method).toBe('harmonic');

        // 5. IBL Setup operator
        const iblRes = engine.dispatch('sb_setup_image_based_lighting', {
            preset: 'golden_hour',
            intensity: 1.25
        });
        expect(iblRes.success).toBe(true);
        const scene5 = engine.getSceneData();
        expect(scene5.environment?.ibl?.enabled).toBe(true);
        expect(scene5.environment?.ibl?.preset).toBe('golden_hour');

        // 6. ACES Tonemapping operator
        const toneRes = engine.dispatch('sb_apply_aces_tonemapping', {
            curve: 'aces',
            exposure: 1.15,
            vignette: 0.28
        });
        expect(toneRes.success).toBe(true);
        const scene6 = engine.getSceneData();
        expect(scene6.environment?.tonemapping?.curve).toBe('aces');
        expect(scene6.environment?.tonemapping?.vignette).toBe(0.28);
    });

    it('should generate DAG stages embedding MikkTSpace tangents, IBL, and ACES Tonemapping', () => {
        const planner = new DynamicDagPlanner();
        const dag = planner.generate3DPlanDAG('Create a high-fidelity nature mountain landscape with atmospheric lighting');

        // Verify stage sequence
        expect(dag.stages.length).toBeGreaterThan(4);

        // Stage 4 (Materials & Shading) should contain MikkTSpace tangent operators
        const matStage = dag.stages.find(s => s.id === 'stage_04_materials_and_shading');
        expect(matStage).toBeDefined();
        const hasTangents = matStage!.operators.some(op => op.operator === 'sb_generate_mikktspace_tangents');
        expect(hasTangents).toBe(true);

        // Stage 5 (Lighting & Atmosphere) should contain IBL and ACES tonemapping
        const lightStage = dag.stages.find(s => s.id === 'stage_05_lighting_and_atmosphere');
        expect(lightStage).toBeDefined();
        const hasIBL = lightStage!.operators.some(op => op.operator === 'sb_setup_image_based_lighting');
        const hasACES = lightStage!.operators.some(op => op.operator === 'sb_apply_aces_tonemapping');
        expect(hasIBL).toBe(true);
        expect(hasACES).toBe(true);
    });
});
