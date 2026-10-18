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
    it('no longer registers the scatter / BVH / rigid-body / cloth / LOD operators that only echoed configs', () => {
        const engine = createOperatorEngine({ customMeshes: [] } as Scene3DData);
        for (const name of [
            'sb_scatter_props',
            'sb_build_mesh_bvh',
            'sb_simulate_rigidbody_physics',
            'sb_simulate_xpbd_cloth',
            'sb_generate_lod_pyramid'
        ]) {
            expect(engine.getOperator(name)).toBeUndefined();
            expect(engine.dispatch(name, { targetMeshId: 'hero_sphere' }).success).toBe(false);
        }
    });

    it('sb_raycast_mesh intersects the real triangles of a live mesh', () => {
        const initialScene: Scene3DData = {
            customMeshes: [{ id: 'hero_sphere', name: 'HeroSphere', type: 'sphere', position: [0, 5, 0] } as any]
        };
        const engine = createOperatorEngine(initialScene);

        // Without the live viewport there are no triangles to cast against.
        const noScene = engine.dispatch('sb_raycast_mesh', { targetMeshId: 'hero_sphere', origin: [0, 10, 0], direction: [0, -1, 0] });
        expect(noScene.success).toBe(false);
        expect(noScene.errorCode).toBe('not_available_here');
        const noSceneAll = engine.dispatch('sb_raycast_mesh', { origin: [0, 10, 0], direction: [0, -1, 0] });
        expect(noSceneAll.success).toBe(false);
        expect(noSceneAll.errorCode).toBe('not_available_here');

        const scene = new THREE.Scene();
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.MeshStandardMaterial());
        sphere.name = 'hero_sphere';
        sphere.position.set(0, 5, 0);
        scene.add(sphere);
        engine.attachThreeScene(scene);

        // Straight down onto the sphere: hits its top (y = 6) with an upward face normal.
        const rayRes = engine.dispatch('sb_raycast_mesh', {
            targetMeshId: 'hero_sphere',
            origin: [0.01, 10, 0.02],
            direction: [0, -1, 0]
        });
        expect(rayRes.success).toBe(true);
        expect(rayRes.data.hit).toBe(true);
        expect(rayRes.data.meshName).toBe('hero_sphere');
        expect(rayRes.data.position[1]).toBeCloseTo(6, 2);
        expect(rayRes.data.distance).toBeCloseTo(4, 2);
        expect(rayRes.data.normal[1]).toBeGreaterThan(0.99);
        expect(typeof rayRes.data.faceIndex).toBe('number');

        // A ray through the corner of the bounding box misses the sphere itself.
        const corner = engine.dispatch('sb_raycast_mesh', {
            targetMeshId: 'hero_sphere',
            origin: [0.95, 10, 0.95],
            direction: [0, -1, 0]
        });
        expect(corner.success).toBe(true);
        expect(corner.data.hit).toBe(false);

        // Scene-wide cast from the side hits the sphere's flank with an outward (-X) normal.
        const side = engine.dispatch('sb_raycast_mesh', { origin: [-10, 5, 0], direction: [1, 0, 0] });
        expect(side.success).toBe(true);
        expect(side.data.hit).toBe(true);
        expect(side.data.position[0]).toBeCloseTo(-1, 2);
        expect(side.data.normal[0]).toBeLessThan(-0.99);

        // maxDistance shorter than the gap to the surface: no hit.
        const short = engine.dispatch('sb_raycast_mesh', { targetMeshId: 'hero_sphere', origin: [0.01, 10, 0.02], direction: [0, -1, 0], maxDistance: 3 });
        expect(short.data.hit).toBe(false);
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
