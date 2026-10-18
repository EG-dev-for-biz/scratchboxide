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
import * as THREE from 'three';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
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
    it('no longer registers the flag-only decimation / tangent / UV / IBL / tonemapping operators', () => {
        const engine = createOperatorEngine({ title: 'Advanced 3D Scene', customMeshes: [], environment: {} } as Scene3DData);
        for (const name of [
            'sb_decimate_mesh_qem',
            'sb_generate_mikktspace_tangents',
            'sb_unwrap_mesh_uvs',
            'sb_setup_image_based_lighting',
            'sb_apply_aces_tonemapping'
        ]) {
            expect(engine.getOperator(name)).toBeUndefined();
            const res = engine.dispatch(name, {});
            expect(res.success).toBe(false);
        }
    });

    it('sb_compute_halfedge_curvature measures the curvature of a live sphere mesh, and fails without one', () => {
        const initialScene: Scene3DData = {
            title: 'Advanced 3D Scene',
            customMeshes: [{ id: 'mesh_test_hero', name: 'Hero Mesh', type: 'custom' } as any],
            environment: {}
        };
        const engine = createOperatorEngine(initialScene);

        // No live viewport: the operator cannot measure anything.
        const unavailable = engine.dispatch('sb_compute_halfedge_curvature', { targetId: 'mesh_test_hero' });
        expect(unavailable.success).toBe(false);
        expect(unavailable.errorCode).toBe('not_available_here');

        const radius = 2;
        const scene = new THREE.Scene();
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), new THREE.MeshStandardMaterial());
        sphere.name = 'mesh_test_hero';
        scene.add(sphere);
        engine.attachThreeScene(scene);

        const curvRes = engine.dispatch('sb_compute_halfedge_curvature', { targetId: 'mesh_test_hero' });
        expect(curvRes.success).toBe(true);
        const d = curvRes.data as any;
        expect(d.vertexCount).toBe(sphere.geometry.getAttribute('position').count);
        // A sphere of radius R has |H| = 1/R and K = 1/R^2 everywhere.
        expect(Math.abs(d.meanCurvature.mean)).toBeGreaterThan(0.6 / radius);
        expect(Math.abs(d.meanCurvature.mean)).toBeLessThan(1.4 / radius);
        expect(d.gaussianCurvature.mean).toBeGreaterThan(0);
        // Curvature results are measurements only: no flag is written into the scene record.
        expect((engine.getSceneData().customMeshes![0] as any).material?.laplaceBeltramiCurvature).toBeUndefined();

        // A flat plane has zero curvature.
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 8, 8), new THREE.MeshStandardMaterial());
        plane.name = 'flat_plane';
        scene.add(plane);
        const flat = engine.dispatch('sb_compute_halfedge_curvature', { targetId: 'flat_plane' });
        expect(flat.success).toBe(true);
        expect(Math.abs((flat.data as any).meanCurvature.mean)).toBeLessThan(1e-6);
        expect(Math.abs((flat.data as any).gaussianCurvature.mean)).toBeLessThan(1e-6);
    });
});
