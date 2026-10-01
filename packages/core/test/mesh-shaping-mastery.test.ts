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
import { DynamicDagPlanner } from '../src/node/deep-write/dynamic-dag-planner';
import { detect3DSceneTheme, generateDefaultCpp3DSource } from '../src/browser/generative-canvas/procedural-3d-synthesizer';

describe('3D Mesh Shaping Mastery (C++20 Engine, Operators, & Autonomous DAG)', () => {

    it('compiles and executes master C++20 mesh shaping module (Loft, Taper, Twist, FFD Lattice, Sculpt, Loop Subdivide)', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::shaper;

    // 1. Lofted Parametric Surface
    std::vector<std::vector<Vec3>> slices;
    const int numSlices = 8;
    const int ptsPerSlice = 12;
    const float height = 6.0f;

    for (int s = 0; s < numSlices; ++s) {
        float t = static_cast<float>(s) / (numSlices - 1);
        float y = (t - 0.5f) * height;
        float r = 1.0f + 0.4f * std::sin(t * PI);
        std::vector<Vec3> slice;
        for (int p = 0; p < ptsPerSlice; ++p) {
            float angle = (static_cast<float>(p) / ptsPerSlice) * TWO_PI;
            slice.push_back(Vec3(std::cos(angle) * r, y, std::sin(angle) * r * 0.8f));
        }
        slices.push_back(slice);
    }

    ScratchboxMesh mesh = Loft3D::skin(slices, true, Vec4(0.8f, 0.85f, 0.95f, 1.0f));
    mesh.name = "kinetic_sculpture";
    mesh.material = PbrMaterial::titanium();

    // 2. Non-linear Taper and Twist
    Deformer::taper(mesh, Axis::Y, 0.5f, -3.0f, 3.0f, 1.2f);
    Deformer::twist(mesh, Axis::Y, PI * 0.5f, -3.0f, 3.0f);
    Deformer::bulge(mesh, Vec3(0, 0, 0), 2.0f, 0.3f);

    // 3. FFD 3D Lattice Deformation (Trivariate Bernstein tensor)
    AABB bounds = mesh.bounds;
    Lattice3D lattice(3, 3, 3, bounds);
    lattice.offsetControlPoint(0, 1, 1, Vec3(0.3f, 0.0f, 0.0f));
    lattice.offsetControlPoint(2, 1, 1, Vec3(-0.3f, 0.0f, 0.0f));
    lattice.deform(mesh);

    // 4. Multi-Brush Digital Sculpting
    SculptEngine::applyStroke(mesh, SculptBrush::Clay, Vec3(0, 1.0f, 0.5f), 1.5f, 0.25f, Vec3(0, 0, 1));
    SculptEngine::applyStroke(mesh, SculptBrush::Crease, Vec3(0, -1.0f, 0.5f), 1.2f, 0.2f, Vec3(0, 1, 0));
    SculptEngine::applyStroke(mesh, SculptBrush::Smooth, Vec3(0, 0.0f, 0.5f), 1.5f, 0.25f, Vec3(0, 1, 0));

    // 5. Loop Subdivision Refinement
    mesh = LoopSubdivision::subdivide(mesh, 1);
    MeshTopologyCleaner::removeDegenerateFaces(mesh);

    mesh.recomputeSmoothNormals();
    mesh.computeCurvatureAO(0.85f);
    mesh.applyProceduralWeathering(2.5f, 0.04f);

    scratchbox::io::GlbWriter::streamChunk(mesh, "kinetic_sculpture");
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource, {
            optimization: '-O3',
            outputBinaryName: 'test_mesh_shaping'
        });

        expect(compileResult.success, compileResult.compilerOutput).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.success, execResult.error).toBe(true);
        expect(execResult.chunks.length).toBe(1);

        const chunk = execResult.chunks[0];
        expect(chunk.id).toBe('kinetic_sculpture');
        expect(chunk.vertexCount).toBeGreaterThan(100);
        expect(chunk.indexCount).toBeGreaterThan(200);
        expect(chunk.glbBase64.length).toBeGreaterThan(100);

        const glbBuf = Buffer.from(chunk.glbBase64, 'base64');
        expect(glbBuf.readUInt32LE(0)).toBe(0x46546C67); // 'glTF' magic
        expect(glbBuf.readUInt32LE(4)).toBe(2);          // version 2.0
    });

    it('compiles and executes C++20 Lathe3D revolution and manifold repair', async () => {
        const compiler = new NativeCppCompilerService();
        const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::shaper;

    // Lathe a sleek chalice profile
    std::vector<Vec2> profile = {
        {0.2f, -2.0f},
        {1.4f, -2.0f},
        {1.2f, -1.8f},
        {0.3f, -1.5f},
        {0.2f, 0.0f},
        {0.8f, 1.0f},
        {1.5f, 2.0f},
        {1.4f, 2.0f}
    };

    ScratchboxMesh chalice = Lathe3D::revolve(profile, 24, TWO_PI, Vec4(0.95f, 0.80f, 0.40f, 1.0f));
    chalice.material = PbrMaterial::gold();

    // Weld coincident vertices and ensure clean topology
    MeshTopologyCleaner::weldCoincidentVertices(chalice, 1e-4f);
    chalice.recomputeSmoothNormals();
    chalice.computeCurvatureAO(0.90f);

    scratchbox::io::GlbWriter::streamChunk(chalice, "gold_chalice");
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource, {
            optimization: '-O3',
            outputBinaryName: 'test_lathe_shaping'
        });

        expect(compileResult.success, compileResult.compilerOutput).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        expect(execResult.success, execResult.error).toBe(true);
        expect(execResult.chunks.length).toBe(1);

        const chunk = execResult.chunks[0];
        expect(chunk.vertexCount).toBeGreaterThan(50);
        expect(chunk.indexCount).toBeGreaterThan(100);
    });

    it('executes direct-dispatch mesh shaping operators (taper, twist, bend, sculpt, lattice, subdivision)', () => {
        const engine = createOperatorEngine();
        const threeScene = new THREE.Scene();
        engine.attachThreeScene(threeScene);

        // 1. Spawn a box mesh
        const spawnRes = engine.dispatch('sb_add_mesh', {
            objectId: 'hero-mesh',
            name: 'Hero Mesh',
            type: 'box',
            scale: [2, 4, 2]
        });
        expect(spawnRes.success).toBe(true);

        // Attach a Three.js BufferGeometry to simulate live viewport
        const threeMesh = new THREE.Mesh(
            new THREE.BoxGeometry(2, 4, 2, 4, 4, 4),
            new THREE.MeshStandardMaterial()
        );
        threeMesh.name = 'hero-mesh';
        threeScene.add(threeMesh);

        // 2. Taper
        const taperRes = engine.dispatch('sb_taper_mesh', {
            objectId: 'hero-mesh',
            axis: 'y',
            factor: 0.4,
            power: 1.5
        });
        expect(taperRes.success).toBe(true);
        expect((taperRes.data as any).affectedVertices).toBeGreaterThan(0);

        // 3. Twist
        const twistRes = engine.dispatch('sb_twist_mesh', {
            objectId: 'hero-mesh',
            axis: 'y',
            angle: Math.PI * 0.5
        });
        expect(twistRes.success).toBe(true);
        expect((twistRes.data as any).affectedVertices).toBeGreaterThan(0);

        // 4. Bend
        const bendRes = engine.dispatch('sb_bend_mesh', {
            objectId: 'hero-mesh',
            mainAxis: 'y',
            bendAxis: 'x',
            angle: Math.PI * 0.25,
            radius: 5.0
        });
        expect(bendRes.success).toBe(true);
        expect((bendRes.data as any).affectedVertices).toBeGreaterThan(0);

        // 5. FFD Lattice Deform
        const latticeRes = engine.dispatch('sb_lattice_deform', {
            objectId: 'hero-mesh',
            dimensions: [3, 3, 3],
            controlOffsets: [
                { index: [0, 1, 1], delta: [0.5, 0, 0] },
                { index: [2, 1, 1], delta: [-0.5, 0, 0] }
            ]
        });
        expect(latticeRes.success).toBe(true);
        expect((latticeRes.data as any).affectedVertices).toBeGreaterThan(0);

        // 6. Sculpt Stroke
        const sculptRes = engine.dispatch('sb_sculpt_stroke', {
            objectId: 'hero-mesh',
            brush: 'clay',
            center: [0, 2, 0],
            radius: 2.0,
            strength: 0.5
        });
        expect(sculptRes.success).toBe(true);
        expect((sculptRes.data as any).affectedVertices).toBeGreaterThan(0);

        // 7. Loop Subdivide
        const subRes = engine.dispatch('sb_loop_subdivide', {
            objectId: 'hero-mesh',
            iterations: 1
        });
        expect(subRes.success).toBe(true);
        expect((subRes.data as any).vertexCount).toBeGreaterThan(24);

        // 8. Repair Mesh
        const repairRes = engine.dispatch('sb_repair_mesh', {
            objectId: 'hero-mesh',
            weldEpsilon: 1e-4,
            removeDegenerates: true
        });
        expect(repairRes.success).toBe(true);
        expect((repairRes.data as any).repaired).toBe(true);

        // 9. Loft Mesh Operator
        const loftRes = engine.dispatch('sb_loft_mesh', {
            slices: [
                [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
                [[0, 2, 0], [1.5, 2, 0], [1.5, 2, 1.5], [0, 2, 1.5]],
                [[0, 4, 0], [0.5, 4, 0], [0.5, 4, 0.5], [0, 4, 0.5]]
            ]
        });
        expect(loftRes.success).toBe(true);
        expect((loftRes.data as any).totalVertices).toBeGreaterThan(0);

        // 10. Lathe Mesh Operator
        const latheRes = engine.dispatch('sb_lathe_mesh', {
            profilePoints: [[0.5, 0], [1.2, 1], [0.8, 2], [1.5, 3]],
            segments: 16
        });
        expect(latheRes.success).toBe(true);
        expect((latheRes.data as any).totalFaces).toBeGreaterThan(0);
    });

    it('detects mesh-shaping theme and synthesizes complete procedural C++ generator with shaper algorithms', () => {
        const prompt = 'Master 3D mesh shaping and organic clay sculpting for an aerodynamic form';
        const theme = detect3DSceneTheme(prompt);
        expect(theme).toBe('mesh-shaping');

        const cppSource = generateDefaultCpp3DSource(theme, 'AeroShaper');
        expect(cppSource).toContain('#include "scratchbox_engine.hpp"');
        expect(cppSource).toContain('using namespace scratchbox::shaper;');
        expect(cppSource).toContain('Loft3D::skin');
        expect(cppSource).toContain('Deformer::taper');
        expect(cppSource).toContain('Deformer::twist');
        expect(cppSource).toContain('Lattice3D lattice');
        expect(cppSource).toContain('SculptEngine::applyStroke');
        expect(cppSource).toContain('LoopSubdivision::subdivide');
        expect(cppSource).toContain('GlbWriter::streamChunk');
    });

    it('plans and executes autonomous 3D DAG with dedicated mesh_shaping stage and invariant verification', async () => {
        const planner = new DynamicDagPlanner();
        const prompt = 'Design a master 3D mesh shaping kinetic sculpture with taper, twist, and clay sculpting';

        const dag = planner.generate3DPlanDAG(prompt);
        expect(dag.theme).toBe('mesh-shaping');

        // Verify stage_03b_mesh_shaping exists and is placed correctly
        const shapingStage = dag.stages.find(s => s.type === 'mesh_shaping');
        expect(shapingStage).toBeDefined();
        expect(shapingStage?.id).toBe('stage_03b_mesh_shaping');
        expect(shapingStage?.dependencies).toContain('stage_03_modifiers_and_edit');
        expect(shapingStage?.expectedStateChecks?.meshDeformationsApplied).toBe(true);

        // Verify stage_04 depends on shapingStage
        const matStage = dag.stages.find(s => s.type === 'materials_and_shading');
        expect(matStage?.dependencies).toContain('stage_03b_mesh_shaping');

        // Execute autonomous workflow
        const execution = await planner.executeAutonomous3DWorkflow(prompt);
        expect(execution.success).toBe(true);
        expect(execution.executedStages.length).toBe(dag.stages.length);

        const shapingExecution = execution.executedStages.find(r => r.type === 'mesh_shaping');
        expect(shapingExecution?.success).toBe(true);
        expect(shapingExecution?.verification.passed).toBe(true);

        // Verify final scene state
        expect(execution.finalScene.cppGenerator).toBeDefined();
        expect(execution.finalScene.cppGenerator?.sourceCode).toContain('scratchbox::shaper');
    });

});
