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
import * as fs from 'fs';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { syncCustomMeshes } from '../src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('3D Engine Gaps 1, 2, 3, 4, 7 Verification: BVH, GPU Instancing, Rigid Body, XPBD Cloth, and LOD', () => {
    const compiler = new NativeCppCompilerService();

    // ========================================================================
    // 1. Native C++20 Gap 1: BVH Tree, Möller-Trumbore Raycasting & RTAO
    // ========================================================================
    it('should compile and verify Gap 1 (BVH Tree, Möller-Trumbore Raycasting & RTAO)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    auto mesh = geo::ScratchboxMesh::createBox(math::Vec3(2.0f, 2.0f, 2.0f));
    bvh::BvhTree tree;
    bool built = tree.build(mesh);
    assert(built);
    assert(tree.getNodeCount() > 0);

    bvh::Ray ray(math::Vec3(0, 0, 5), math::Vec3(0, 0, -1));
    bvh::RayHit hit;
    bool hasHit = tree.raycast(ray, hit);
    assert(hasHit);
    assert(std::abs(hit.t - 4.0f) < 1e-3f);
    assert(std::abs(hit.position.z - 1.0f) < 1e-3f);

    auto rtao = bvh::computeMeshRTAO(mesh, 8, 1.5f);
    assert(rtao.size() == mesh.vertices.size());

    std::cout << "GAP_1_OK: Nodes=" << tree.getNodeCount() << " HitT=" << hit.t << std::endl;
    return 0;
}
`;
        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_gap1_${Date.now()}`
        });
        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('GAP_1_OK');
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 2. Native C++20 Gap 2: GPU Instancing & glTF 2.0 Binary Serialization
    // ========================================================================
    it('should compile and verify Gap 2 (GPU Instancing EXT_mesh_gpu_instancing Serialization)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    auto cube = geo::ScratchboxMesh::createBox(math::Vec3(1.0f, 1.0f, 1.0f));
    std::vector<io::InstanceTransform> instances;
    for (int i = 0; i < 500; ++i) {
        instances.push_back({
            math::Vec3(i * 1.5f, 0, 0),
            math::Vec3(1, 1, 1),
            math::Quat(0, 0, 0, 1)
        });
    }

    auto glb = io::GlbWriter::serializeInstancedGlb(cube, instances);
    assert(!glb.empty());
    assert(glb.size() > 500);

    // Verify glTF 2.0 magic 'glTF' (0x46546C67)
    uint32_t magic = *reinterpret_cast<const uint32_t*>(glb.data());
    assert(magic == 0x46546C67);

    std::cout << "GAP_2_OK: Instances=500 GlbBytes=" << glb.size() << std::endl;
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

    // ========================================================================
    // 3. Native C++20 Gap 3: Rigid Body Dynamics & Contact Manifolds (GJK/EPA)
    // ========================================================================
    it('should compile and verify Gap 3 (Rigid Body Dynamics, GJK/EPA & Sequential Impulse)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    rb::RigidBodyWorld world;

    auto ground = std::make_shared<rb::RigidBody>("ground");
    ground->position = math::Vec3(0, -1, 0);
    ground->collider = rb::Collider::createBox(math::Vec3(10, 2, 10));
    ground->setStatic(true);
    world.addBody(ground);

    auto box = std::make_shared<rb::RigidBody>("box");
    box->position = math::Vec3(0, 3, 0);
    box->collider = rb::Collider::createBox(math::Vec3(1, 1, 1));
    box->setMass(1.0f);
    world.addBody(box);

    for (int step = 0; step < 60; ++step) {
        world.step(1.0f / 60.0f);
    }

    assert(box->position.y >= 0.45f && box->position.y <= 0.65f);
    std::cout << "GAP_3_OK: RestingY=" << box->position.y << std::endl;
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
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 4. Native C++20 Gap 4: XPBD Cloth & Soft Body Simulator
    // ========================================================================
    it('should compile and verify Gap 4 (XPBD Cloth Simulator with Compliance & Bending)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    auto grid = geo::GeometryBuilder::createPlane(2.0f, 2.0f, 8, 8);
    xpbd::XpbdClothSimulator cloth;
    cloth.initFromMesh(grid, 0.05f, 1e-6f, 1e-4f);
    assert(!cloth.particles.empty());
    assert(!cloth.stretchConstraints.empty());

    cloth.pinParticle(0);
    cloth.pinParticle(8);

    for (int step = 0; step < 20; ++step) {
        cloth.step(1.0f / 60.0f);
    }

    cloth.syncToMesh(grid);
    assert(grid.vertices[40].position.y < 0.0f);

    std::cout << "GAP_4_OK: PinnedCenterY=" << grid.vertices[40].position.y << std::endl;
    return 0;
}
`;
        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_gap4_${Date.now()}`
        });
        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            if (!execRes.success) {
                console.error('Gap 4 exec failed:', execRes.stderr, execRes.stdout);
            }
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('GAP_4_OK');
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 5. Native C++20 Gap 7: Multi-Resolution LOD Pyramid & MSFT_lod Serializer
    // ========================================================================
    it('should compile and verify Gap 7 (LOD Pyramid Generation & MSFT_lod glTF Serializer)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    auto sphere = geo::GeometryBuilder::createSphere(1.0f, 24, 16);
    auto pyramid = lod::buildLodPyramid(sphere);
    assert(pyramid.size() == 4);
    assert(pyramid.levels[0].mesh.indices.size() > pyramid.levels[1].mesh.indices.size());
    assert(pyramid.levels[1].mesh.indices.size() > pyramid.levels[2].mesh.indices.size());

    std::vector<geo::ScratchboxMesh> meshes = { pyramid.levels[0].mesh, pyramid.levels[1].mesh };
    auto lodGlb = io::GlbWriter::serializeLodGlb(meshes);
    assert(!lodGlb.empty());
    assert(lodGlb.size() > 100);

    std::cout << "GAP_7_OK: LOD0=" << pyramid.levels[0].mesh.indices.size() / 3
              << " LOD1=" << pyramid.levels[1].mesh.indices.size() / 3
              << " GlbBytes=" << lodGlb.size() << std::endl;
    return 0;
}
`;
        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_gap7_${Date.now()}`
        });
        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('GAP_7_OK');
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 6. Direct Dispatch Operator Engine Verification
    // ========================================================================
    it('should verify operator engine dispatches for Gaps 1, 2, 3, 4, 7', () => {
        const initialScene: Scene3DData = {
            customMeshes: [
                {
                    id: 'hero_cube',
                    name: 'HeroCube',
                    type: 'box',
                    position: [0, 5, 0],
                    scale: [1, 1, 1]
                }
            ]
        };

        const engine = createOperatorEngine(initialScene);

        // 1. Test sb_scatter_props with GPU Instancing (Gap 2)
        const scatterRes = engine.dispatch('sb_scatter_props', {
            count: 350,
            propType: 'box',
            useGpuInstancing: true
        });
        expect(scatterRes.success).toBe(true);
        expect(scatterRes.data.useGpuInstancing).toBe(true);
        expect(scatterRes.data.scatterCount).toBe(350);

        // 2. Test sb_build_mesh_bvh (Gap 1)
        const bvhRes = engine.dispatch('sb_build_mesh_bvh', {
            targetMeshId: 'hero_cube'
        });
        expect(bvhRes.success).toBe(true);
        expect(bvhRes.data.bvhAccelerated).toBe(true);

        // 3. Test sb_raycast_mesh (Gap 1)
        const rayRes = engine.dispatch('sb_raycast_mesh', {
            targetMeshId: 'hero_cube',
            origin: [0, 10, 0],
            direction: [0, -1, 0]
        });
        expect(rayRes.success).toBe(true);
        expect(rayRes.data.hit).toBe(true);
        expect(rayRes.data.distance).toBeGreaterThan(0);

        // 4. Test sb_simulate_rigidbody_physics (Gap 3)
        const rbRes = engine.dispatch('sb_simulate_rigidbody_physics', {
            targetMeshId: 'hero_cube',
            steps: 60
        });
        expect(rbRes.success).toBe(true);
        expect(rbRes.data.stepsExecuted).toBe(60);

        // 5. Test sb_simulate_xpbd_cloth (Gap 4)
        const clothRes = engine.dispatch('sb_simulate_xpbd_cloth', {
            targetMeshId: 'hero_cube',
            steps: 30
        });
        expect(clothRes.success).toBe(true);
        expect(clothRes.data.xpbdConfig).toBeDefined();

        // 6. Test sb_generate_lod_pyramid (Gap 7)
        const lodRes = engine.dispatch('sb_generate_lod_pyramid', {
            targetMeshId: 'hero_cube'
        });
        expect(lodRes.success).toBe(true);
        expect(lodRes.data.levelCount).toBe(4);
    });

    // ========================================================================
    // 7. Three.js Viewport Sync Custom Meshes (InstancedMesh & LOD)
    // ========================================================================
    it('should correctly instantiate THREE.InstancedMesh and THREE.LOD in syncCustomMeshes', () => {
        const scene = new THREE.Scene();
        const stack: any = { scene };
        const registry = new Map();

        const definitions: any[] = [
            {
                id: 'instanced_forest',
                name: 'ForestTrees',
                type: 'cylinder',
                instanceTransforms: [
                    { position: [0, 0, 0], scale: [1, 2, 1] },
                    { position: [5, 0, 2], scale: [1, 2.5, 1] },
                    { position: [-3, 0, 4], scale: [0.8, 1.8, 0.8] }
                ]
            },
            {
                id: 'lod_statue',
                name: 'LODStatue',
                type: 'sphere',
                lodLevels: [
                    { geometryType: 'sphere', distance: 0 },
                    { geometryType: 'box', distance: 20 }
                ]
            }
        ];

        const syncRes = syncCustomMeshes(stack, definitions, registry, { terrainManager: null, has3DTiles: false });
        expect(syncRes.created).toBe(2);

        const instancedEntry = registry.get('instanced_forest');
        expect(instancedEntry).toBeDefined();
        expect(instancedEntry?.mesh).toBeInstanceOf(THREE.InstancedMesh);
        expect((instancedEntry?.mesh as THREE.InstancedMesh).count).toBe(3);

        const lodEntry = registry.get('lod_statue');
        expect(lodEntry).toBeDefined();
        expect(lodEntry?.mesh).toBeInstanceOf(THREE.LOD);
        expect((lodEntry?.mesh as THREE.LOD).levels.length).toBe(2);
    });
});
