/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import * as fs from 'fs';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { syncCustomMeshes } from '../src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('3D Engine Verification: Hair & Fur, Advanced Fabrics, and Complex Multibody Physics', () => {
    const compiler = new NativeCppCompilerService();

    // ========================================================================
    // 1. Native C++20 Domain 1: Hair Grooming, XPBD Physics & Marschner BSDF
    // ========================================================================
    it('should compile and verify Hair Grooming, XPBD Strand Dynamics, Marschner BSDF, and Ribbon Meshing', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    hair::HairGroomConfig config;
    config.guideCount = 16;
    config.strandCount = 64;
    config.segmentsPerStrand = 10;
    config.length = 0.20f;
    config.clumping = 0.8f;

    // 1. Generate scalp guide curves
    auto guides = hair::HairGroomer::generateScalpGuides(math::Vec3(0, 1.6f, 0), 0.12f, config);
    assert(guides.size() == 16);

    // 2. Synthesize dense strands with Voronoi clumping and curl
    auto strands = hair::HairGroomer::synthesizeDenseStrands(guides, config);
    assert(strands.size() == 64);
    assert(strands[0].vertices.size() == 10);
    assert(strands[0].vertices[0].invMass == 0.0f); // Pinned root

    // 3. XPBD Hair Strand Dynamics
    hair::HairXpbdSimulator::HeadCollider head;
    head.center = math::Vec3(0, 1.6f, 0);
    head.radius = 0.12f;
    hair::HairXpbdSimulator::stepSimulation(strands, 0.016f, 4, head, math::Vec3(1.0f, 0.0f, 0.0f));

    // 4. Marschner Hair BSDF evaluation
    math::Vec3 wi(0.577f, 0.577f, 0.577f);
    math::Vec3 wo(0.0f, 0.0f, 1.0f);
    math::Vec3 tangent(0.0f, 1.0f, 0.0f);
    math::Vec3 bsdf = hair::MarschnerBSDF::evaluate(wi, wo, tangent, strands[0].baseColor);
    assert(bsdf.x > 0.0f && bsdf.y > 0.0f && bsdf.z > 0.0f);

    // 5. Build camera-facing ribbon mesh
    auto ribbonMesh = hair::HairRibbonMeshBuilder::buildRibbonMesh(strands, math::Vec3(0, 1.6f, 3.0f));
    assert(ribbonMesh.vertices.size() == 64 * 10 * 2);
    assert(ribbonMesh.indices.size() == 64 * (10 - 1) * 6);

    std::cout << "HAIR_SYSTEM_OK: Strands=" << strands.size() 
              << " RibbonVerts=" << ribbonMesh.vertices.size() 
              << " RibbonIndices=" << ribbonMesh.indices.size() << std::endl;
    return 0;
}
`;
        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_hair_${Date.now()}`
        });
        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('HAIR_SYSTEM_OK');
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 2. Native C++20 Domain 2: Advanced Fabrics & Orthotropic Mechanics
    // ========================================================================
    it('should compile and verify Fabric Orthotropic XPBD, Shear Locking, Self-Collision, Aerodynamics, and Weave Synthesis', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    fabric::FabricProperties props;
    props.pattern = fabric::WeavePattern::Twill;
    props.warpCompliance = 1e-7f;
    props.weftCompliance = 2e-7f;
    props.shearCompliance = 5e-5f;
    props.shearLockAngle = 0.785f;

    // 1. Setup particles for 4-vertex quad cloth patch
    std::vector<xpbd::XpbdParticle> particles(4);
    particles[0].position = math::Vec3(0, 1, 0);   particles[0].invMass = 0.0f; // Pinned
    particles[1].position = math::Vec3(1, 1, 0);   particles[1].invMass = 0.0f; // Pinned
    particles[2].position = math::Vec3(1, 0, 0);   particles[2].invMass = 1.0f;
    particles[3].position = math::Vec3(0, 0, 0);   particles[3].invMass = 1.0f;

    // 2. Orthotropic Constraints (Warp vs Weft)
    fabric::OrthotropicConstraint warpConstraint{ 0, 3, 1.0f, props.warpCompliance };
    fabric::OrthotropicConstraint weftConstraint{ 1, 2, 1.0f, props.weftCompliance };
    warpConstraint.solve(particles, 0.016f);
    weftConstraint.solve(particles, 0.016f);

    // 3. Non-linear Shear Locking Quad Constraint
    fabric::ShearLockConstraint shearLock{ 0, 1, 2, 3, 1.414f, 1.414f, props.shearCompliance, props.shearLockCompliance, props.shearLockAngle };
    shearLock.solve(particles, 0.016f);

    // 4. Cloth Self-Collision via Spatial Hashing
    fabric::SpatialHashSelfCollision::solveSelfCollision(particles, props.thickness);

    // 5. Aerodynamic Wind Forces
    std::vector<uint32_t> indices = { 0, 1, 2, 0, 2, 3 };
    fabric::AerodynamicCoupler::applyAerodynamics(particles, indices, math::Vec3(0, 0, 10.0f), props, 0.016f);
    assert(particles[2].velocity.z > 0.0f); // Pushed by wind

    // 6. Procedural Yarn Weave Normal Synthesis
    auto twillNormals = fabric::WeaveNormalSynthesizer::generateWeaveNormalMap(64, 64, fabric::WeavePattern::Twill);
    assert(twillNormals.size() == 64 * 64 * 4);

    // 7. Charlie Sheen Fabric PBR Shading
    math::Vec3 wi(0, 1, 1); wi = wi.normalized();
    math::Vec3 wo(0, 0, 1);
    math::Vec3 norm(0, 0, 1);
    math::Vec3 tangent(1, 0, 0);
    math::Vec3 albedo(0.2f, 0.3f, 0.6f); // Indigo denim
    math::Vec3 fabricColor = fabric::FabricShading::evaluateFabricPbr(wi, wo, norm, tangent, albedo, props);
    assert(fabricColor.x > 0.0f && fabricColor.y > 0.0f && fabricColor.z > 0.0f);

    std::cout << "FABRIC_SYSTEM_OK: WindVz=" << particles[2].velocity.z 
              << " TwillNormals=" << twillNormals.size() << std::endl;
    return 0;
}
`;
        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_fabric_${Date.now()}`
        });
        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('FABRIC_SYSTEM_OK');
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 3. Native C++20 Domain 3: Multibody Joint Constraints & Character Ragdoll
    // ========================================================================
    it('should compile and verify Articulated Joint Constraints, Sequential Impulse Solver, and Ragdoll Hierarchy', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;

    rb::RigidBodyWorld world;
    world.gravity = math::Vec3(0, -9.81f, 0);

    // Ground plane
    auto ground = std::make_shared<rb::RigidBody>("Ground");
    ground->collider = rb::Collider::createBox(math::Vec3(40, 1.0f, 40));
    ground->position = math::Vec3(0, -0.5f, 0);
    ground->setStatic(true);
    world.addBody(ground);

    // Create 7-bone Humanoid Ragdoll
    auto ragdoll = rb::Ragdoll::createHumanoid(world, math::Vec3(0, 2.0f, 0), 1.0f);
    assert(ragdoll->bones.size() == 7);
    assert(world.bodies.size() == 8); // 1 ground + 7 ragdoll bones
    assert(world.joints.size() == 6); // Spine, Neck, LeftHip, LeftKnee, RightHip, RightKnee

    // Step world simulation with sequential impulse joint and contact solving
    for (int frame = 0; frame < 60; ++frame) {
        world.step(0.016f, 10, 2);
    }

    // Verify ragdoll has descended under gravity and maintained joint connectivity
    auto pelvis = ragdoll->bones[0].body;
    auto torso = ragdoll->bones[1].body;
    float spineDist = (pelvis->position - torso->position).length();
    // Pelvis to torso distance should stay roughly near rest distance (~0.32m)
    assert(spineDist > 0.15f && spineDist < 0.60f);

    std::cout << "RAGDOLL_SYSTEM_OK: Bones=" << ragdoll->bones.size() 
              << " Joints=" << world.joints.size() 
              << " PelvisY=" << pelvis->position.y 
              << " SpineDist=" << spineDist << std::endl;
    return 0;
}
`;
        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_ragdoll_${Date.now()}`
        });
        expect(compileRes.success).toBe(true);
        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('RAGDOLL_SYSTEM_OK');
            try { fs.unlinkSync(compileRes.binaryPath); } catch {}
        }
    }, 45000);

    // ========================================================================
    // 4. TypeScript Operator Engine Dispatch Verification
    // ========================================================================
    it('should register and execute hair, fabric, and ragdoll direct operators', () => {
        const scene: Scene3DData = {
            customMeshes: [
                {
                    id: 'human_scalp',
                    name: 'Scalp Mesh',
                    type: 'sphere',
                    position: [0, 1.6, 0],
                    scale: [0.2, 0.2, 0.2]
                },
                {
                    id: 'flag_cloth',
                    name: 'Woven Cloth',
                    type: 'plane',
                    position: [0, 2.0, 0],
                    scale: [1.5, 1.0, 1.0]
                }
            ]
        };

        const engine = createOperatorEngine(scene);

        // Operator 1: sb_generate_hair_strands
        const hairRes = engine.dispatch('sb_generate_hair_strands', {
            targetMeshId: 'human_scalp',
            guideCount: 32,
            strandCount: 2048,
            length: 0.22,
            clumping: 0.85,
            eumelanin: 0.7,
            pheomelanin: 0.15
        });
        expect(hairRes.success).toBe(true);
        expect(hairRes.data.hairGroom.strandCount).toBe(2048);

        // Operator 2: sb_simulate_hair_dynamics
        const hairDynRes = engine.dispatch('sb_simulate_hair_dynamics', {
            targetMeshId: 'human_scalp',
            steps: 40,
            wind: [2.0, 0, 0]
        });
        expect(hairDynRes.success).toBe(true);
        expect(hairDynRes.data.stepsExecuted).toBe(40);

        // Operator 3: sb_simulate_fabric_aerodynamics
        const fabricRes = engine.dispatch('sb_simulate_fabric_aerodynamics', {
            targetMeshId: 'flag_cloth',
            pattern: 'twill',
            warpCompliance: 1e-7,
            weftCompliance: 2e-7,
            shearCompliance: 4e-5,
            airDragCoeff: 1.25,
            wind: [0, 0, 5]
        });
        expect(fabricRes.success).toBe(true);
        expect(fabricRes.data.fabricProperties.pattern).toBe('twill');

        // Operator 4: sb_create_ragdoll_simulation
        const ragdollRes = engine.dispatch('sb_create_ragdoll_simulation', {
            rootPosition: [0, 1.5, 0],
            scale: 1.0,
            meshPrefix: 'hero_ragdoll'
        });
        expect(ragdollRes.success).toBe(true);
        expect(ragdollRes.data.bonesCreated).toBe(7);
        expect(engine.getSceneData().customMeshes?.some(m => m.id === 'hero_ragdoll_pelvis')).toBe(true);
        expect(engine.getSceneData().customMeshes?.some(m => m.id === 'hero_ragdoll_head')).toBe(true);
    });

    // ========================================================================
    // 5. Three.js Scene Viewport Synchronization for Hair & Fabric Materials
    // ========================================================================
    it('should synchronize fabric sheen and hair physical materials in Three.js viewport', () => {
        const threeScene = new THREE.Scene();
        const registry = new Map();
        const stack = {
            scene: threeScene,
            renderer: {} as any,
            camera: new THREE.PerspectiveCamera(),
            composer: {} as any
        };

        const sceneDefs = [
            {
                id: 'hair_ribbons_mesh',
                name: 'Hair Ribbons',
                type: 'sphere',
                position: [0, 1.6, 0] as [number, number, number],
                hairGroom: {
                    strandCount: 1024,
                    length: 0.25
                }
            },
            {
                id: 'silk_fabric_cloth',
                name: 'Silk Fabric',
                type: 'plane',
                position: [0, 1.0, 0] as [number, number, number],
                fabricProperties: {
                    pattern: 'satin',
                    sheenIntensity: 0.95
                }
            }
        ];

        const syncRes = syncCustomMeshes(stack as any, sceneDefs as any, registry, {
            terrainManager: null,
            has3DTiles: false
        });

        expect(syncRes.created).toBe(2);
        const hairObj = registry.get('hair_ribbons_mesh')?.mesh as THREE.Mesh;
        expect(hairObj).toBeDefined();
        expect(hairObj.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);

        const fabricObj = registry.get('silk_fabric_cloth')?.mesh as THREE.Mesh;
        expect(fabricObj).toBeDefined();
        expect(fabricObj.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        const fabricMat = fabricObj.material as THREE.MeshPhysicalMaterial;
        expect(fabricMat.sheen).toBe(0.95);
    });
});
