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
import { evaluateFalloff } from '../src/browser/generative-canvas/services/mesh-sculpting-engine';
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

    describe('direct-dispatch mesh shaping operators on a live viewport mesh', () => {
        /** Engine with an attached Three.js scene holding one mesh named `name` built on `geometry`. */
        const liveEngine = (name: string, geometry: THREE.BufferGeometry) => {
            const engine = createOperatorEngine();
            const scene = new THREE.Scene();
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            mesh.name = name;
            scene.add(mesh);
            engine.attachThreeScene(scene);
            return { engine, mesh };
        };
        const positionsOf = (geometry: THREE.BufferGeometry) => {
            const pos = geometry.getAttribute('position');
            const out: THREE.Vector3[] = [];
            for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
            return out;
        };

        it('fails with not_available_here when no live mesh is attached', () => {
            const engine = createOperatorEngine({
                title: 'Data only',
                customMeshes: [{ id: 'hero-mesh', name: 'Hero Mesh', type: 'box', position: [0, 0, 0], scale: [2, 4, 2] }]
            });
            const calls: Array<[string, any]> = [
                ['sb_taper_mesh', { objectId: 'hero-mesh', factor: 0.4 }],
                ['sb_twist_mesh', { objectId: 'hero-mesh', angle: 1 }],
                ['sb_bend_mesh', { objectId: 'hero-mesh', angle: 1, radius: 5 }],
                ['sb_lattice_deform', { objectId: 'hero-mesh', controlOffsets: [{ index: [2, 2, 2], delta: [1, 0, 0] }] }],
                ['sb_sculpt_stroke', { objectId: 'hero-mesh', brush: 'grab', center: [0, 0, 0], radius: 1, strength: 1 }],
                ['sb_loop_subdivide', { objectId: 'hero-mesh', iterations: 1 }],
                ['sb_repair_mesh', { objectId: 'hero-mesh' }],
                ['sb_reshape_mesh', { objectId: 'hero-mesh', operations: [{ type: 'taper', factor: 0.5 }] }]
            ];
            for (const [op, params] of calls) {
                const res = engine.dispatch(op, params);
                expect(res.success, op).toBe(false);
                expect(res.errorCode, op).toBe('not_available_here');
            }
        });

        it('sb_taper_mesh scales cross-sections linearly along the axis', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(2, 4, 2, 4, 4, 4));
            const before = positionsOf(mesh.geometry);
            const res = engine.dispatch('sb_taper_mesh', { objectId: 'hero-mesh', axis: 'y', factor: 0.4, power: 1 });
            expect(res.success).toBe(true);
            expect(res.data.affectedVertices).toBe(before.length);
            const after = positionsOf(mesh.geometry);
            for (let i = 0; i < before.length; i++) {
                const s = 1 + (0.4 - 1) * ((before[i].y + 2) / 4);
                expect(after[i].x).toBeCloseTo(before[i].x * s, 6);
                expect(after[i].y).toBeCloseTo(before[i].y, 6);
                expect(after[i].z).toBeCloseTo(before[i].z * s, 6);
            }
            mesh.geometry.computeBoundingBox();
            expect(mesh.geometry.boundingBox!.max.x).toBeCloseTo(1, 6); // bottom ring keeps full width
        });

        it('sb_twist_mesh rotates each slice by angle * t about the axis', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(2, 4, 2, 2, 4, 2));
            const before = positionsOf(mesh.geometry);
            const res = engine.dispatch('sb_twist_mesh', { objectId: 'hero-mesh', axis: 'y', angle: Math.PI / 2 });
            expect(res.success).toBe(true);
            const after = positionsOf(mesh.geometry);
            for (let i = 0; i < before.length; i++) {
                const theta = (Math.PI / 2) * ((before[i].y + 2) / 4);
                expect(after[i].x).toBeCloseTo(Math.cos(theta) * before[i].x + Math.sin(theta) * before[i].z, 6);
                expect(after[i].z).toBeCloseTo(-Math.sin(theta) * before[i].x + Math.cos(theta) * before[i].z, 6);
                expect(after[i].y).toBeCloseTo(before[i].y, 6);
                // a rotation keeps the distance from the axis
                expect(Math.hypot(after[i].x, after[i].z)).toBeCloseTo(Math.hypot(before[i].x, before[i].z), 6);
            }
        });

        it('sb_bend_mesh maps vertices onto the bend arc', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(4, 1, 1, 8, 1, 1));
            const before = positionsOf(mesh.geometry);
            const angle = Math.PI / 4;
            const radius = 5;
            const res = engine.dispatch('sb_bend_mesh', { objectId: 'hero-mesh', mainAxis: 'x', bendAxis: 'y', angle, radius });
            expect(res.success).toBe(true);
            const after = positionsOf(mesh.geometry);
            for (let i = 0; i < before.length; i++) {
                const theta = (before[i].x / radius) * (angle / Math.PI);
                const r = radius + before[i].y;
                expect(after[i].x).toBeCloseTo(r * Math.sin(theta), 6);
                expect(after[i].y).toBeCloseTo(r * Math.cos(theta) - radius, 6);
                expect(after[i].z).toBeCloseTo(before[i].z, 6);
            }
        });

        it('sb_lattice_deform moves vertices by Bernstein-weighted control offsets', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(2, 2, 2));
            const before = positionsOf(mesh.geometry);
            const res = engine.dispatch('sb_lattice_deform', {
                objectId: 'hero-mesh',
                dimensions: [3, 3, 3],
                controlOffsets: [{ index: [2, 2, 2], delta: [1, 0, 0] }]
            });
            expect(res.success).toBe(true);
            expect(res.data.affectedVertices).toBe(before.length);
            const after = positionsOf(mesh.geometry);
            for (let i = 0; i < before.length; i++) {
                // corner control point (2,2,2) of a 3x3x3 lattice has weight u^2 v^2 w^2
                const u = (before[i].x + 1) / 2, v = (before[i].y + 1) / 2, w = (before[i].z + 1) / 2;
                expect(after[i].x).toBeCloseTo(before[i].x + u * u * v * v * w * w, 6);
                expect(after[i].y).toBeCloseTo(before[i].y, 6);
            }
            // the max corner moves a full unit, the min corner not at all
            const maxCorner = before.findIndex(p => p.x === 1 && p.y === 1 && p.z === 1);
            const minCorner = before.findIndex(p => p.x === -1 && p.y === -1 && p.z === -1);
            expect(after[maxCorner].x).toBeCloseTo(2, 6);
            expect(after[minCorner].x).toBeCloseTo(-1, 6);
        });

        it('sb_sculpt_stroke grab moves only vertices inside the brush, by strength * falloff', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(2, 4, 2, 4, 4, 4));
            const before = positionsOf(mesh.geometry);
            const center = new THREE.Vector3(0, 2, 0);
            const radius = 1.0;
            const strength = 0.5;
            const inside = before.filter(p => p.distanceTo(center) <= radius).length;
            const res = engine.dispatch('sb_sculpt_stroke', {
                objectId: 'hero-mesh', brush: 'grab', center: [0, 2, 0], radius, strength, direction: [0, 1, 0], falloff: 'smoothstep'
            });
            expect(res.success).toBe(true);
            expect(res.data.affectedVertices).toBe(inside);
            expect(inside).toBeGreaterThan(0);
            const after = positionsOf(mesh.geometry);
            for (let i = 0; i < before.length; i++) {
                const d = before[i].distanceTo(center);
                const lift = d <= radius ? strength * evaluateFalloff(d, radius, 'smoothstep') : 0;
                expect(after[i].y).toBeCloseTo(before[i].y + lift, 6);
                expect(after[i].x).toBeCloseTo(before[i].x, 6);
            }
            // the top-centre vertex sits at the brush centre and rises the full strength
            const top = before.findIndex(p => p.distanceTo(center) < 1e-9);
            expect(after[top].y).toBeCloseTo(2.5, 6);
        });

        it('sb_loop_subdivide quadruples the faces and keeps the surface closed', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(2, 4, 2));
            const oldGeometry = mesh.geometry;
            const res = engine.dispatch('sb_loop_subdivide', { objectId: 'hero-mesh', iterations: 1 });
            expect(res.success).toBe(true);
            expect(res.data.faceCount).toBe(48);
            expect(res.data.vertexCountBefore).toBe(24);
            expect(mesh.geometry).not.toBe(oldGeometry);
            const stats = engine.dispatch('sb_get_mesh_stats', { objectId: 'hero-mesh' });
            expect(stats.data.faceCount).toBe(48);
            expect(stats.data.isWatertight).toBe(true);
            expect(stats.data.edgeCount).toBe(72);
            // Loop smoothing pulls the corners in (unlike midpoint subdivision): volume drops below 2*4*2
            expect(stats.data.volume).toBeLessThan(16);
            const maxRadius = Math.max(...positionsOf(mesh.geometry).map(p => p.length()));
            expect(maxRadius).toBeLessThan(Math.sqrt(6) - 1e-3);
        });

        it('sb_repair_mesh removes degenerate and duplicate faces and fixes a flipped face', () => {
            const geometry = new THREE.BoxGeometry(2, 2, 2);
            const index = Array.from(geometry.index!.array);
            // flip the winding of face 1, append a copy of face 5 and a degenerate face
            [index[4], index[5]] = [index[5], index[4]];
            index.push(index[15], index[16], index[17]);
            index.push(index[0], index[0], index[1]);
            geometry.setIndex(index);
            const { engine } = liveEngine('broken-mesh', geometry);

            const before = engine.dispatch('sb_get_mesh_stats', { objectId: 'broken-mesh' });
            expect(before.data.faceCount).toBe(14);
            expect(before.data.isWatertight).toBe(false);

            const res = engine.dispatch('sb_repair_mesh', { objectId: 'broken-mesh', weldEpsilon: 1e-4, removeDegenerates: true });
            expect(res.success).toBe(true);
            expect(res.data.degenerateFacesRemoved).toBe(1);
            expect(res.data.duplicateFacesRemoved).toBe(1);
            expect(res.data.facesFlipped).toBe(1);
            expect(res.data.before.isWatertight).toBe(false);
            expect(res.data.after.faceCount).toBe(12);
            expect(res.data.after.isWatertight).toBe(true);

            const after = engine.dispatch('sb_get_mesh_stats', { objectId: 'broken-mesh' });
            expect(after.data.volume).toBeCloseTo(8, 3);
        });

        it('sb_reshape_mesh applies the given taper and rejects operations without values', () => {
            const { engine, mesh } = liveEngine('hero-mesh', new THREE.BoxGeometry(2, 4, 2));
            const before = positionsOf(mesh.geometry);
            const res = engine.dispatch('sb_reshape_mesh', { objectId: 'hero-mesh', operations: [{ type: 'taper', factor: 0.5 }] });
            expect(res.success).toBe(true);
            expect(res.data.vertexCount).toBe(before.length);
            const after = positionsOf(mesh.geometry);
            for (let i = 0; i < before.length; i++) {
                const s = 1 + (0.5 - 1) * ((before[i].y + 2) / 4);
                expect(after[i].x).toBeCloseTo(before[i].x * s, 6);
            }
            expect(engine.dispatch('sb_reshape_mesh', { objectId: 'hero-mesh', operations: [{ type: 'taper' }] }).success).toBe(false);
            expect(engine.dispatch('sb_reshape_mesh', { objectId: 'hero-mesh', prompt: 'make it thinner' }).success).toBe(false);
        });

        it('removed generator operators are not registered', () => {
            const engine = createOperatorEngine();
            for (const name of ['sb_loft_mesh', 'sb_lathe_mesh', 'sb_add_mesh', 'sb_extrude_faces', 'sb_boolean_op']) {
                expect(engine.getOperator(name), name).toBeUndefined();
            }
        });
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

});
