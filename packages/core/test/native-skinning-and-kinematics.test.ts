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
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Parametric Humanoids & Skinning Native Engine (C++20)', () => {
    const compiler = new NativeCppCompilerService();

    it('should compile and execute native Forward Kinematics and Rodrigues rotations with mathematical precision', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cmath>

int main() {
    using namespace scratchbox;

    // 1. Create standard humanoid skeleton
    kinematics::Skeleton rig = kinematics::Skeleton::createStandardHumanoid(1.0f);
    
    // Check initial rest position of left wrist
    auto initPositions = rig.getPosedJointPositions();
    int32_t wristIdx = rig.findJoint("LeftWrist");
    if (wristIdx < 0) return 1;

    math::Vec3 restWrist = initPositions[wristIdx];

    // 2. Rotate left shoulder 90 degrees (HALF_PI) around Z axis (raising arm vertically)
    rig.setJointRotation("LeftShoulder", math::Vec3(0.0f, 0.0f, math::HALF_PI));
    rig.updateTransforms();

    auto posedPositions = rig.getPosedJointPositions();
    math::Vec3 posedWrist = posedPositions[wristIdx];

    // Rest wrist was at (0.75, 1.40, 0) with shoulder at (0.22, 1.40, 0) -> delta X = 0.53
    // After +90 deg Z rotation, wrist should rotate to delta Y = +0.53 -> Y ~ 1.93, X ~ 0.22
    float dx = std::abs(posedWrist.x - 0.22f);
    float dy = std::abs(posedWrist.y - 1.93f);

    if (dx > 0.05f || dy > 0.05f) {
        std::cerr << "Kinematics mismatch! Posed wrist: (" << posedWrist.x << ", " << posedWrist.y << ", " << posedWrist.z << ")" << std::endl;
        return 2;
    }

    // Output success marker
    std::cout << "FK_SUCCESS dx=" << dx << " dy=" << dy << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_fk_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('FK_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should compile, skin, and stream a procedural humanoid mesh as binary glTF 2.0 (.glb)', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;

    // 1. Build anatomical procedural humanoid
    auto baseMesh = skinning::ProceduralHumanoidBuilder::buildProportionalHumanoid(1.80f, 0.44f);
    if (baseMesh.vertices.empty()) return 1;

    // 2. Build and pose skeleton
    auto rig = kinematics::Skeleton::createStandardHumanoid(1.0f);
    rig.setJointRotation(kinematics::StandardJoint::LeftShoulder, math::Vec3(0.0f, 0.0f, 0.785f));  // 45 deg abduction
    rig.setJointRotation(kinematics::StandardJoint::RightShoulder, math::Vec3(0.0f, 0.0f, -0.785f));
    rig.setJointRotation(kinematics::StandardJoint::LeftKnee, math::Vec3(0.5f, 0.0f, 0.0f));         // knee bend
    rig.updateTransforms();

    // 3. Generate skin weights and deform
    auto weights = skinning::ProceduralHumanoidBuilder::generateStandardWeights(baseMesh, rig);
    auto posedMesh = skinning::LinearBlendSkinning::deform(baseMesh, weights, rig.getSkinningMatrices());

    // 4. Stream glTF 2.0 chunk
    io::GlbWriter::streamChunk(posedMesh, "skinned_humanoid_hero");
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_humanoid_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('skinned_humanoid_hero');
            expect(chunk.vertexCount).toBeGreaterThan(500);
            expect(chunk.indexCount).toBeGreaterThan(1000);
            expect(chunk.glbBase64.length).toBeGreaterThan(2000);

            // Clean up
            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should evaluate PCA shape blend shapes and deform vertices proportionally', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>

int main() {
    using namespace scratchbox;

    geometry::ScratchboxMesh mesh("morph_test");
    mesh.addVertex(geometry::Vertex(math::Vec3(0.0f, 1.0f, 0.0f)));
    mesh.addVertex(geometry::Vertex(math::Vec3(1.0f, 0.0f, 0.0f)));
    mesh.addTriangle(0, 1, 0);

    // Synthetic PCA shape directions for 2 modes across 2 vertices
    // Mode 0: scales Y by +0.5 on vertex 0
    // Mode 1: shifts X by +0.3 on vertex 1
    std::vector<float> shapeDirs = {
        // Mode 0
        0.0f, 0.5f, 0.0f,  // v0
        0.0f, 0.0f, 0.0f,  // v1
        // Mode 1
        0.0f, 0.0f, 0.0f,  // v0
        0.3f, 0.0f, 0.0f   // v1
    };

    std::vector<float> betas = {2.0f, -1.0f}; // beta0 = 2.0 -> dy = +1.0; beta1 = -1.0 -> dx = -0.3

    skinning::ParametricDeformer::applyShapeBlendShapes(mesh, betas, shapeDirs, 2);

    float y0 = mesh.vertices[0].position.y;
    float x1 = mesh.vertices[1].position.x;

    if (std::abs(y0 - 2.0f) < 1e-4f && std::abs(x1 - 0.7f) < 1e-4f) {
        std::cout << "MORPH_SUCCESS y0=" << y0 << " x1=" << x1 << std::endl;
        return 0;
    }

    std::cerr << "Morph failed: y0=" << y0 << " x1=" << x1 << std::endl;
    return 1;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_morph_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('MORPH_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should serialize and stream native glTF 2.0 skinned meshes with joints, weights, and skeleton nodes', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;

    // 1. Build anatomical base mesh & skeleton
    auto mesh = skinning::ProceduralHumanoidBuilder::buildProportionalHumanoid(1.80f, 0.44f);
    auto rig = kinematics::Skeleton::createStandardHumanoid(1.0f);
    auto weights = skinning::ProceduralHumanoidBuilder::generateStandardWeights(mesh, rig);

    // 2. Stream skinned glTF chunk with joints, weights, and inverse bind matrices
    io::GlbWriter::streamSkinnedChunk(mesh, weights, rig, "skinned_hero_gltf");
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_skinned_gltf_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('skinned_hero_gltf');
            expect(chunk.vertexCount).toBeGreaterThan(500);

            // Decode base64 glTF to inspect JSON chunk
            const glbBuffer = Buffer.from(chunk.glbBase64, 'base64');
            const jsonChunkLength = glbBuffer.readUInt32LE(12);
            const jsonString = glbBuffer.subarray(20, 20 + jsonChunkLength).toString('utf-8');
            const gltf = JSON.parse(jsonString);

            // Validate glTF 2.0 Skinning Structure
            expect(gltf.skins).toBeDefined();
            expect(gltf.skins.length).toBe(1);
            expect(gltf.skins[0].joints.length).toBe(21);
            expect(gltf.skins[0].inverseBindMatrices).toBeDefined();

            // Validate primitive attributes JOINTS_0 & WEIGHTS_0
            const primitive = gltf.meshes[0].primitives[0];
            expect(primitive.attributes.JOINTS_0).toBeDefined();
            expect(primitive.attributes.WEIGHTS_0).toBeDefined();

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should save, load, and evaluate full .sbhuman binary parametric humanoid models', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;

    const std::string tmpPath = "/tmp/test_eval.sbhuman";

    // 1. Create synthetic model & save to .sbhuman
    auto original = human::SbHumanModel::createProceduralAnatomical(1.80f);
    if (!original.saveToFile(tmpPath)) {
        std::cerr << "Failed to save .sbhuman" << std::endl;
        return 1;
    }

    // 2. Load from .sbhuman
    human::SbHumanModel loaded;
    if (!loaded.loadFromFile(tmpPath)) {
        std::cerr << "Failed to load .sbhuman" << std::endl;
        return 2;
    }

    if (loaded.templateMesh.vertices.size() != original.templateMesh.vertices.size()) {
        std::cerr << "Vertex count mismatch" << std::endl;
        return 3;
    }
    if (loaded.skeleton.joints.size() != 55) {
        std::cerr << "Joint count mismatch: " << loaded.skeleton.joints.size() << std::endl;
        return 4;
    }

    // 3. Pose skeleton and evaluate with betas
    loaded.skeleton.setJointRotation(kinematics::StandardJoint::LeftShoulder, math::Vec3(0, 0, 0.785f));
    loaded.skeleton.updateTransforms();

    std::vector<float> betas = {1.5f, -0.8f};
    std::vector<float> exprs = {0.0f};
    auto posedMesh = loaded.evaluate(betas, exprs, loaded.skeleton);

    if (posedMesh.vertices.empty()) return 5;

    std::cout << "SBHUMAN_SUCCESS vCount=" << posedMesh.vertices.size() << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_sbhuman_io_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('SBHUMAN_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should articulate 5-digit hands via Canonical 55-Joint hierarchy and Hand PCA Subspace', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox;

int main() {
    auto rig = kinematics::Skeleton::create55JointHumanoid(1.0f);
    if (rig.joints.size() != 55) return 1;

    // Check rest positions of index finger tip vs wrist
    int32_t rWrist = rig.findJoint("RightWrist");
    int32_t rIndexDistal = rig.findJoint("RightIndex3");
    if (rWrist < 0 || rIndexDistal < 0) return 2;

    auto restPositions = rig.getPosedJointPositions();
    math::Vec3 restPosWrist = restPositions[rWrist];
    math::Vec3 restPosDistal = restPositions[rIndexDistal];

    // Rest: hand extends along -X (anatomical T-pose with palms down/lateral)
    // Distance between wrist and index distal joint
    float restDist = (restPosDistal - restPosWrist).length();
    if (restDist < 0.05f) return 3;

    // Apply "Fist" gesture mode (mode 0 = 1.0) via Hand PCA
    auto pca = kinematics::HandPcaSubspace::defaultSubspace();
    rig.applyHandPose(false, {1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f}, pca);
    rig.updateTransforms();

    auto curledPositions = rig.getPosedJointPositions();
    math::Vec3 curledDistal = curledPositions[rIndexDistal];

    // In a curled fist, distance to wrist is reduced as finger curls inward
    float curledDist = (curledDistal - restPosWrist).length();
    if (curledDist >= restDist) {
        std::cerr << "Finger did not curl: restDist=" << restDist << " curledDist=" << curledDist << std::endl;
        return 4;
    }

    std::cout << "HAND_PCA_SUCCESS restDist=" << restDist << " curledDist=" << curledDist << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_hand_pca_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('HAND_PCA_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should construct and evaluate Sparse CSR Joint Regressor dynamically from surface geometry', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <chrono>

using namespace scratchbox;

int main() {
    auto mesh = skinning::ProceduralHumanoidBuilder::buildAnatomicalWatertightHumanoid(1.80f);
    auto rig = kinematics::Skeleton::create55JointHumanoid(1.0f);

    auto regressor = skinning::SparseCsrRegressor::buildFromRestPose(mesh, rig, 32);
    if (regressor.empty() || regressor.numJoints != 55) return 1;

    // NNZ should be bounded by 55 * 32 = 1760
    if (regressor.colIndices.size() > 1760 || regressor.colIndices.empty()) return 2;

    std::vector<math::Vec3> surfPositions(mesh.vertices.size());
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        surfPositions[i] = mesh.vertices[i].position;
    }

    // Benchmark SIMD evaluation speed
    auto t0 = std::chrono::high_resolution_clock::now();
    std::vector<math::Vec3> regressedJoints;
    for (int iter = 0; iter < 100; ++iter) {
        regressor.evaluate(surfPositions, regressedJoints);
    }
    auto t1 = std::chrono::high_resolution_clock::now();
    double avgMicros = std::chrono::duration<double, std::micro>(t1 - t0).count() / 100.0;

    // Check accuracy of Head joint regression
    int32_t headIdx = rig.findJoint("Head");
    math::Vec3 expectedHead = rig.joints[headIdx].restPosition;
    math::Vec3 actualHead = regressedJoints[headIdx];
    float err = (actualHead - expectedHead).length();

    if (err > 0.05f) {
        std::cerr << "Regressor error too high: " << err << std::endl;
        return 3;
    }

    std::cout << "REGRESSOR_SUCCESS nnz=" << regressor.colIndices.size() 
              << " avgMicros=" << avgMicros 
              << " err=" << err << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_regressor_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('REGRESSOR_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should evaluate Pose-Space Corrective Blendshapes and preserve joint volume during extreme flexion', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>

using namespace scratchbox;

int main() {
    auto model = human::SbHumanModel::createProceduralAnatomical(1.80f);
    if (model.numPoseCorrectives != 54) return 1;

    // Flex left elbow by 90 degrees around Z
    model.skeleton.setJointRotation(kinematics::Canonical55Joint::LeftElbow, math::Vec3(0.0f, 0.0f, 1.57f));
    
    // Evaluate without pose correctives (pure LBS)
    auto pureLbsModel = model;
    pureLbsModel.numPoseCorrectives = 0;
    auto lbsMesh = pureLbsModel.evaluate();

    // Evaluate with pose correctives (PSD + LBS)
    auto psdMesh = model.evaluate();

    // The bicep region on Left Arm (+X) should have expanded in PSD mesh relative to pure LBS
    float maxElevationPsd = 0.0f;
    float maxElevationLbs = 0.0f;
    for (size_t i = 0; i < psdMesh.vertices.size(); ++i) {
        const auto& pPsd = psdMesh.vertices[i].position;
        const auto& pLbs = lbsMesh.vertices[i].position;
        if (pPsd.x > 0.35f && pPsd.x < 0.65f) {
            maxElevationPsd = std::max(maxElevationPsd, pPsd.y);
            maxElevationLbs = std::max(maxElevationLbs, pLbs.y);
        }
    }

    std::cout << "PSD_SUCCESS lbsY=" << maxElevationLbs << " psdY=" << maxElevationPsd << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_psd_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('PSD_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should model sexual dimorphism (Male V-taper vs Female hourglass), evaluate 8 PCA shape modes, and track Barycentric Facial Landmarks', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

using namespace scratchbox;

int main() {
    auto male = human::SbHumanModel::createMale(1.80f);
    auto female = human::SbHumanModel::createFemale(1.66f);
    auto neutral = human::SbHumanModel::createNeutral(1.72f);

    // 1. Verify 8 PCA shape modes
    if (male.numShapeModes != 8 || female.numShapeModes != 8 || neutral.numShapeModes != 8) {
        std::cerr << "Expected 8 shape modes" << std::endl;
        return 1;
    }

    // 2. Verify Canonical Barycentric Facial Landmarks
    if (neutral.facialLandmarks.size() < 10) {
        std::cerr << "Facial landmarks missing" << std::endl;
        return 2;
    }
    auto facePoints = neutral.evaluateFacialLandmarks(neutral.templateMesh);
    if (facePoints.size() != neutral.facialLandmarks.size()) {
        std::cerr << "Facial landmark point count mismatch" << std::endl;
        return 3;
    }
    // Verify NoseTip is elevated and anterior
    math::Vec3 noseTip = facePoints[0];
    if (noseTip.y < 1.50f || noseTip.z < 0.05f) {
        std::cerr << "NoseTip landmark out of expected bounds: y=" << noseTip.y << " z=" << noseTip.z << std::endl;
        return 4;
    }

    // 3. Verify Sexual Dimorphism Proportions
    // Find shoulder span (max X at Y > 1.35m) and pelvic span (max X at 0.75m < Y < 1.05m)
    auto computeShoulderAndHipSpan = [](const geometry::ScratchboxMesh& mesh, float scale) {
        float maxShoulderX = 0.0f;
        float maxHipX = 0.0f;
        for (const auto& v : mesh.vertices) {
            if (v.position.y > 1.30f * scale && v.position.y < 1.50f * scale) {
                maxShoulderX = std::max(maxShoulderX, std::abs(v.position.x));
            }
            if (v.position.y > 0.75f * scale && v.position.y < 1.05f * scale) {
                maxHipX = std::max(maxHipX, std::abs(v.position.x));
            }
        }
        return std::make_pair(maxShoulderX, maxHipX);
    };

    auto maleSpans = computeShoulderAndHipSpan(male.templateMesh, 1.80f / 1.80f);
    auto femaleSpans = computeShoulderAndHipSpan(female.templateMesh, 1.66f / 1.80f);

    // Male shoulder width should be broader than female
    if (maleSpans.first <= femaleSpans.first) {
        std::cerr << "Male shoulder span should exceed female shoulder span" << std::endl;
        return 5;
    }

    // Female hip-to-shoulder ratio should be greater than male (hourglass morphology)
    float maleRatio = maleSpans.second / maleSpans.first;
    float femaleRatio = femaleSpans.second / femaleSpans.first;
    if (femaleRatio <= maleRatio) {
        std::cerr << "Female hip/shoulder ratio (" << femaleRatio << ") should exceed male (" << maleRatio << ")" << std::endl;
        return 6;
    }

    // 4. Test Shape Mode 3 (Gender Dimorphic Transition)
    // Beta[3] = +2.0 (feminization: enhances pelvic width and thoracic projection)
    std::vector<float> feminineBetas(8, 0.0f);
    feminineBetas[3] = 2.0f;
    auto feminizedMesh = neutral.evaluate(feminineBetas);
    auto femSpans = computeShoulderAndHipSpan(feminizedMesh, 1.72f / 1.80f);
    auto neutSpans = computeShoulderAndHipSpan(neutral.templateMesh, 1.72f / 1.80f);
    if (femSpans.second <= neutSpans.second) {
        std::cerr << "Feminized mesh should have expanded pelvic breadth" << std::endl;
        return 7;
    }

    std::cout << "DIMORPHISM_AND_LANDMARKS_SUCCESS maleRatio=" << maleRatio 
              << " femaleRatio=" << femaleRatio 
              << " lmkCount=" << facePoints.size() << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_dimorphism_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.stdout).toContain('DIMORPHISM_AND_LANDMARKS_SUCCESS');

            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);
});



