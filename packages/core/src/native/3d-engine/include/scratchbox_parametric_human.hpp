/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_PARAMETRIC_HUMAN_HPP
#define SCRATCHBOX_PARAMETRIC_HUMAN_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include <vector>
#include <string>
#include <fstream>
#include <cstring>
#include <cstdint>
#include <iostream>

namespace scratchbox {
namespace parametric {

/**
 * Scratchbox Human Binary Format (.sbhuman) Header
 */
#pragma pack(push, 1)
struct SbHumanHeader {
    uint32_t magic{0x4E4D4853}; // 'SBHM' in little-endian
    uint32_t version{2};
    uint32_t numVertices{0};
    uint32_t numIndices{0};
    uint32_t numJoints{0};
    uint32_t numShapeModes{0};
    uint32_t numExpressionModes{0};
    uint32_t numPoseCorrectives{0};
    uint32_t numRegressorEntries{0}; // NNZ in sparse joint regressor
    uint32_t flags{0};               // Bit 0: handPca, Bit 1: regressor, Bit 2: poseCorrectives
};

struct SbHumanHeaderV1 {
    uint32_t magic{0x4E4D4853};
    uint32_t version{1};
    uint32_t numVertices{0};
    uint32_t numIndices{0};
    uint32_t numJoints{0};
    uint32_t numShapeModes{0};
    uint32_t numExpressionModes{0};
    uint32_t numPoseCorrectives{0};
};
#pragma pack(pop)

/**
 * Barycentric Surface & Facial Landmark Representation
 * Directly maps to SB-Human lmk_bary_coords / lmk_faces_idx architecture
 * L_k = u * V_0 + v * V_1 + w * V_2
 */
struct BarycentricLandmark {
    std::string name;
    uint32_t triangleIndex{0};
    float u{0.3333f};
    float v{0.3333f};
    float w{0.3334f};

    math::Vec3 evaluate(const geometry::ScratchboxMesh& mesh) const {
        if (triangleIndex * 3 + 2 >= mesh.indices.size()) return math::Vec3(0, 0, 0);
        uint32_t i0 = mesh.indices[triangleIndex * 3 + 0];
        uint32_t i1 = mesh.indices[triangleIndex * 3 + 1];
        uint32_t i2 = mesh.indices[triangleIndex * 3 + 2];
        if (i0 >= mesh.vertices.size() || i1 >= mesh.vertices.size() || i2 >= mesh.vertices.size()) {
            return math::Vec3(0, 0, 0);
        }
        return mesh.vertices[i0].position * u +
               mesh.vertices[i1].position * v +
               mesh.vertices[i2].position * w;
    }
};

/**
 * Parametric Humanoid Model Representation
 */
class SbHumanModel {
public:
    geometry::ScratchboxMesh templateMesh{"sbhuman_template"};
    kinematics::Skeleton skeleton;
    std::vector<skinning::VertexSkinWeight> skinWeights;
    skinning::SparseCsrRegressor jointRegressor;
    kinematics::HandPcaSubspace handPca;
    std::vector<BarycentricLandmark> facialLandmarks;

    // PCA displacement tensors: flattened [mode * numVertices * 3 + vertex * 3 + coord]
    std::vector<float> shapeDirs;
    std::vector<float> exprDirs;
    std::vector<float> poseDirs;
    size_t numShapeModes{0};
    size_t numExpressionModes{0};
    size_t numPoseCorrectives{0};

    SbHumanModel() = default;

    std::vector<math::Vec3> evaluateFacialLandmarks(const geometry::ScratchboxMesh& mesh) const {
        std::vector<math::Vec3> points;
        points.reserve(facialLandmarks.size());
        for (const auto& lmk : facialLandmarks) {
            points.push_back(lmk.evaluate(mesh));
        }
        return points;
    }

    /**
     * Evaluates a posed & shaped parametric humanoid:
     * 1. Displaces template mesh by shape parameters betas (β)
     * 2. Displaces by expression parameters expressions (ψ)
     * 3. Dynamically regresses skeleton joint pivots from shaped surface (J = J_regressor * V)
     * 4. Applies hand gesture PCA coefficients
     * 5. Solves forward kinematics transforms
     * 6. Applies pose-space corrective blendshapes B_p(θ)
     * 7. Deforms posed mesh using Linear Blend Skinning (LBS)
     */
    geometry::ScratchboxMesh evaluate(
        const std::vector<float>& betas,
        const std::vector<float>& expressions,
        const kinematics::Skeleton& posedRig
    ) const {
        kinematics::Skeleton rigCopy = posedRig;
        return evaluatePosed(rigCopy, betas, expressions);
    }

    geometry::ScratchboxMesh evaluate(
        const std::vector<float>& betas = {},
        const std::vector<float>& expressions = {},
        const std::vector<float>& handCoeffsL = {},
        const std::vector<float>& handCoeffsR = {}
    ) const {
        kinematics::Skeleton rigCopy = skeleton;
        return evaluatePosed(rigCopy, betas, expressions, handCoeffsL, handCoeffsR);
    }

    geometry::ScratchboxMesh evaluatePosed(
        kinematics::Skeleton& posedRig,
        const std::vector<float>& betas = {},
        const std::vector<float>& expressions = {},
        const std::vector<float>& handCoeffsL = {},
        const std::vector<float>& handCoeffsR = {}
    ) const {
        geometry::ScratchboxMesh shaped = templateMesh;

        // 1. Shape Blend Shapes
        if (!shapeDirs.empty() && !betas.empty()) {
            skinning::ParametricDeformer::applyShapeBlendShapes(shaped, betas, shapeDirs, numShapeModes);
        }

        // 2. Expression Blend Shapes
        if (!exprDirs.empty() && !expressions.empty()) {
            skinning::ParametricDeformer::applyShapeBlendShapes(shaped, expressions, exprDirs, numExpressionModes);
        }

        // 3. Dynamic Sparse Joint Regression (only when shape/expression morphs are applied)
        if (!jointRegressor.empty() && (!betas.empty() || !expressions.empty())) {
            std::vector<math::Vec3> regressedJoints;
            std::vector<math::Vec3> surfacePositions(shaped.vertices.size());
            for (size_t i = 0; i < shaped.vertices.size(); ++i) {
                surfacePositions[i] = shaped.vertices[i].position;
            }
            jointRegressor.evaluate(surfacePositions, regressedJoints);
            for (size_t j = 0; j < regressedJoints.size() && j < posedRig.joints.size(); ++j) {
                posedRig.joints[j].restPosition = regressedJoints[j];
            }
        }

        // 4. Hand PCA Gestures
        if (!handCoeffsL.empty()) {
            posedRig.applyHandPose(true, handCoeffsL, handPca);
        }
        if (!handCoeffsR.empty()) {
            posedRig.applyHandPose(false, handCoeffsR, handPca);
        }

        // 5. Update Forward Kinematics Transforms
        posedRig.updateTransforms();

        // 6. Pose-Space Corrective Blendshapes
        if (!poseDirs.empty() && numPoseCorrectives > 0) {
            skinning::PoseCorrectiveDeformer::apply(shaped, posedRig, poseDirs, numPoseCorrectives);
        }

        // 7. Linear Blend Skinning
        auto skinMatrices = posedRig.getSkinningMatrices();
        return skinning::LinearBlendSkinning::deform(shaped, skinWeights, skinMatrices);
    }

    /**
     * Serializes model into zero-dependency .sbhuman binary format (v2)
     */
    bool saveToFile(const std::string& path) const {
        std::ofstream file(path, std::ios::binary);
        if (!file.is_open()) return false;

        SbHumanHeader header;
        header.magic = 0x4E4D4853;
        header.version = 2;
        header.numVertices = static_cast<uint32_t>(templateMesh.vertices.size());
        header.numIndices = static_cast<uint32_t>(templateMesh.indices.size());
        header.numJoints = static_cast<uint32_t>(skeleton.joints.size());
        header.numShapeModes = static_cast<uint32_t>(numShapeModes);
        header.numExpressionModes = static_cast<uint32_t>(numExpressionModes);
        header.numPoseCorrectives = static_cast<uint32_t>(numPoseCorrectives);
        header.numRegressorEntries = static_cast<uint32_t>(jointRegressor.colIndices.size());
        header.flags = 1 | 2 | 4;

        file.write(reinterpret_cast<const char*>(&header), sizeof(SbHumanHeader));

        // 1. Vertices (position, normal, uv)
        for (const auto& v : templateMesh.vertices) {
            file.write(reinterpret_cast<const char*>(&v.position), sizeof(math::Vec3));
            file.write(reinterpret_cast<const char*>(&v.normal), sizeof(math::Vec3));
            file.write(reinterpret_cast<const char*>(&v.uv), sizeof(math::Vec2));
        }

        // 2. Indices
        file.write(reinterpret_cast<const char*>(templateMesh.indices.data()),
                   templateMesh.indices.size() * sizeof(uint32_t));

        // 3. Skeleton joints
        for (const auto& j : skeleton.joints) {
            uint32_t nameLen = static_cast<uint32_t>(j.name.size());
            file.write(reinterpret_cast<const char*>(&nameLen), sizeof(uint32_t));
            file.write(j.name.data(), nameLen);
            file.write(reinterpret_cast<const char*>(&j.parentIndex), sizeof(int32_t));
            file.write(reinterpret_cast<const char*>(&j.restPosition), sizeof(math::Vec3));
        }

        // 4. Skin Weights
        file.write(reinterpret_cast<const char*>(skinWeights.data()),
                   skinWeights.size() * sizeof(skinning::VertexSkinWeight));

        // 5. Shape PCA directions
        if (!shapeDirs.empty()) {
            file.write(reinterpret_cast<const char*>(shapeDirs.data()),
                       shapeDirs.size() * sizeof(float));
        }

        // 6. Expression PCA directions
        if (!exprDirs.empty()) {
            file.write(reinterpret_cast<const char*>(exprDirs.data()),
                       exprDirs.size() * sizeof(float));
        }

        // 7. Pose Corrective directions
        if (!poseDirs.empty()) {
            file.write(reinterpret_cast<const char*>(poseDirs.data()),
                       poseDirs.size() * sizeof(float));
        }

        // 8. Joint Regressor
        if (!jointRegressor.empty()) {
            file.write(reinterpret_cast<const char*>(jointRegressor.rowOffsets.data()),
                       jointRegressor.rowOffsets.size() * sizeof(uint32_t));
            file.write(reinterpret_cast<const char*>(jointRegressor.colIndices.data()),
                       jointRegressor.colIndices.size() * sizeof(uint32_t));
            file.write(reinterpret_cast<const char*>(jointRegressor.values.data()),
                       jointRegressor.values.size() * sizeof(float));
        }

        return true;
    }

    /**
     * Loads .sbhuman binary file (supports both v1 and v2 formats)
     */
    bool loadFromFile(const std::string& path) {
        std::ifstream file(path, std::ios::binary);
        if (!file.is_open()) return false;

        uint32_t magic = 0;
        uint32_t version = 0;
        file.read(reinterpret_cast<char*>(&magic), sizeof(uint32_t));
        file.read(reinterpret_cast<char*>(&version), sizeof(uint32_t));

        if (magic != 0x4E4D4853) return false;

        SbHumanHeader header;
        if (version == 1) {
            SbHumanHeaderV1 v1;
            v1.magic = magic;
            v1.version = version;
            file.read(reinterpret_cast<char*>(&v1.numVertices), sizeof(SbHumanHeaderV1) - 8);

            header.magic = v1.magic;
            header.version = 1;
            header.numVertices = v1.numVertices;
            header.numIndices = v1.numIndices;
            header.numJoints = v1.numJoints;
            header.numShapeModes = v1.numShapeModes;
            header.numExpressionModes = v1.numExpressionModes;
            header.numPoseCorrectives = v1.numPoseCorrectives;
            header.numRegressorEntries = 0;
            header.flags = 0;
        } else if (version == 2) {
            header.magic = magic;
            header.version = version;
            file.read(reinterpret_cast<char*>(&header.numVertices), sizeof(SbHumanHeader) - 8);
        } else {
            return false;
        }

        templateMesh = geometry::ScratchboxMesh("sbhuman_loaded");
        templateMesh.vertices.resize(header.numVertices);

        for (uint32_t i = 0; i < header.numVertices; ++i) {
            file.read(reinterpret_cast<char*>(&templateMesh.vertices[i].position), sizeof(math::Vec3));
            file.read(reinterpret_cast<char*>(&templateMesh.vertices[i].normal), sizeof(math::Vec3));
            file.read(reinterpret_cast<char*>(&templateMesh.vertices[i].uv), sizeof(math::Vec2));
            templateMesh.vertices[i].color = math::Vec4(0.82f, 0.64f, 0.52f, 1.0f);
        }

        templateMesh.indices.resize(header.numIndices);
        file.read(reinterpret_cast<char*>(templateMesh.indices.data()),
                  header.numIndices * sizeof(uint32_t));

        skeleton.joints.clear();
        for (uint32_t i = 0; i < header.numJoints; ++i) {
            uint32_t nameLen = 0;
            file.read(reinterpret_cast<char*>(&nameLen), sizeof(uint32_t));
            std::string name(nameLen, '\0');
            file.read(name.data(), nameLen);

            int32_t parent = -1;
            file.read(reinterpret_cast<char*>(&parent), sizeof(int32_t));
            math::Vec3 restPos;
            file.read(reinterpret_cast<char*>(&restPos), sizeof(math::Vec3));

            skeleton.addJoint(name, parent, restPos);
        }
        skeleton.updateTransforms();

        skinWeights.resize(header.numVertices);
        file.read(reinterpret_cast<char*>(skinWeights.data()),
                  header.numVertices * sizeof(skinning::VertexSkinWeight));

        numShapeModes = header.numShapeModes;
        if (numShapeModes > 0) {
            size_t count = numShapeModes * header.numVertices * 3;
            shapeDirs.resize(count);
            file.read(reinterpret_cast<char*>(shapeDirs.data()), count * sizeof(float));
        }

        numExpressionModes = header.numExpressionModes;
        if (numExpressionModes > 0) {
            size_t count = numExpressionModes * header.numVertices * 3;
            exprDirs.resize(count);
            file.read(reinterpret_cast<char*>(exprDirs.data()), count * sizeof(float));
        }

        numPoseCorrectives = header.numPoseCorrectives;
        if (numPoseCorrectives > 0) {
            size_t count = numPoseCorrectives * 9 * header.numVertices * 3;
            poseDirs.resize(count);
            file.read(reinterpret_cast<char*>(poseDirs.data()), count * sizeof(float));
        }

        if (header.numRegressorEntries > 0) {
            jointRegressor.numJoints = header.numJoints;
            jointRegressor.numVertices = header.numVertices;
            jointRegressor.rowOffsets.resize(header.numJoints + 1);
            jointRegressor.colIndices.resize(header.numRegressorEntries);
            jointRegressor.values.resize(header.numRegressorEntries);

            file.read(reinterpret_cast<char*>(jointRegressor.rowOffsets.data()),
                      jointRegressor.rowOffsets.size() * sizeof(uint32_t));
            file.read(reinterpret_cast<char*>(jointRegressor.colIndices.data()),
                      jointRegressor.colIndices.size() * sizeof(uint32_t));
            file.read(reinterpret_cast<char*>(jointRegressor.values.data()),
                      jointRegressor.values.size() * sizeof(float));
        }

        templateMesh.recomputeBounds();
        initializeFacialLandmarks(*this);
        return true;
    }

    /**
     * Initializes canonical anthropometric facial landmarks via barycentric coordinates
     * matching SB-Human / FLAME facial topology.
     */
    static void initializeFacialLandmarks(SbHumanModel& model) {
        const auto& mesh = model.templateMesh;
        if (mesh.indices.empty()) return;
        const size_t numTris = mesh.indices.size() / 3;

        auto findClosestTriangle = [&](const math::Vec3& targetPoint) -> uint32_t {
            uint32_t bestTri = 0;
            float bestDistSq = 1e9f;
            for (size_t t = 0; t < numTris; ++t) {
                uint32_t i0 = mesh.indices[t * 3 + 0];
                uint32_t i1 = mesh.indices[t * 3 + 1];
                uint32_t i2 = mesh.indices[t * 3 + 2];
                math::Vec3 centroid = (mesh.vertices[i0].position + mesh.vertices[i1].position + mesh.vertices[i2].position) * (1.0f / 3.0f);
                float dSq = (centroid - targetPoint).dot(centroid - targetPoint);
                if (dSq < bestDistSq) {
                    bestDistSq = dSq;
                    bestTri = static_cast<uint32_t>(t);
                }
            }
            return bestTri;
        };

        float scale = (mesh.bounds.max.y > 0.1f) ? (mesh.bounds.max.y / 1.80f) : 1.0f;
        std::vector<std::pair<std::string, math::Vec3>> keypoints = {
            { "NoseTip",              math::Vec3(0.000f, 1.656f, 0.115f) * scale },
            { "Subnasale",            math::Vec3(0.000f, 1.634f, 0.096f) * scale },
            { "UpperLipMid",          math::Vec3(0.000f, 1.612f, 0.094f) * scale },
            { "LowerLipMid",          math::Vec3(0.000f, 1.590f, 0.090f) * scale },
            { "ChinPogonion",         math::Vec3(0.000f, 1.568f, 0.085f) * scale },
            { "Glabella",             math::Vec3(0.000f, 1.705f, 0.088f) * scale },
            { "LeftPupil",            math::Vec3(0.034f, 1.680f, 0.082f) * scale },
            { "RightPupil",           math::Vec3(-0.034f, 1.680f, 0.082f) * scale },
            { "LeftOralCommissure",   math::Vec3(0.024f, 1.605f, 0.076f) * scale },
            { "RightOralCommissure",  math::Vec3(-0.024f, 1.605f, 0.076f) * scale }
        };

        model.facialLandmarks.clear();
        model.facialLandmarks.reserve(keypoints.size());
        for (const auto& kp : keypoints) {
            uint32_t tri = findClosestTriangle(kp.second);
            model.facialLandmarks.push_back({ kp.first, tri, 0.3333f, 0.3333f, 0.3334f });
        }
    }

    /**
     * Constructs a synthetic procedural anatomical humanoid with built-in shape modes,
     * sparse CSR joint regressor, and 55-joint kinematic skeleton.
     */
    static SbHumanModel createProceduralAnatomical(
        float height = 1.80f,
        skinning::GenderMorph gender = skinning::GenderMorph::Neutral
    ) {
        SbHumanModel model;
        model.templateMesh = skinning::ProceduralHumanoidBuilder::buildAnatomicalWatertightHumanoid(height, gender);
        
        float shoulderScale = (gender == skinning::GenderMorph::Female) ? 0.88f : ((gender == skinning::GenderMorph::Male) ? 1.00f : 0.94f);
        float hipScale = (gender == skinning::GenderMorph::Female) ? 1.10f : ((gender == skinning::GenderMorph::Male) ? 0.96f : 1.00f);

        model.skeleton = kinematics::Skeleton::create55JointHumanoid(height / 1.80f, shoulderScale, hipScale);
        model.skinWeights = skinning::ProceduralHumanoidBuilder::generateStandardWeights(
            model.templateMesh, model.skeleton
        );
        model.jointRegressor = skinning::SparseCsrRegressor::buildFromRestPose(
            model.templateMesh, model.skeleton, 32
        );
        model.handPca = kinematics::HandPcaSubspace::defaultSubspace();

        // Initialize canonical facial landmarks
        initializeFacialLandmarks(model);

        // Generate synthetic shape PCA modes (8 canonical body shape dimensions)
        const size_t vCount = model.templateMesh.vertices.size();
        model.numShapeModes = 8;
        model.shapeDirs.resize(8 * vCount * 3, 0.0f);

        const float s = height / 1.80f;

        for (size_t i = 0; i < vCount; ++i) {
            const auto& p = model.templateMesh.vertices[i].position;

            // Mode 0: Stature / Overall Height Elongation (PC0)
            size_t m0 = (0 * vCount + i) * 3;
            model.shapeDirs[m0 + 0] = 0.0f;
            model.shapeDirs[m0 + 1] = p.y * 0.05f;
            model.shapeDirs[m0 + 2] = 0.0f;

            // Mode 1: Athletic Muscularity / V-Taper (PC1)
            size_t m1 = (1 * vCount + i) * 3;
            float upperFactor = (p.y > 1.1f * s) ? 1.0f : 0.25f;
            float pecFactor = (p.y > 1.25f * s && p.y < 1.45f * s && p.z > 0.02f * s) ? 0.035f : 0.0f;
            model.shapeDirs[m1 + 0] = p.x * 0.045f * upperFactor;
            model.shapeDirs[m1 + 1] = 0.0f;
            model.shapeDirs[m1 + 2] = (p.z * 0.040f * upperFactor) + pecFactor;

            // Mode 2: BMI / Abdominal & Flank Breadth (PC2)
            size_t m2 = (2 * vCount + i) * 3;
            float torsoFactor = (p.y > 0.8f * s && p.y < 1.4f * s) ? 1.0f : 0.3f;
            model.shapeDirs[m2 + 0] = p.x * 0.05f * torsoFactor;
            model.shapeDirs[m2 + 1] = 0.0f;
            model.shapeDirs[m2 + 2] = p.z * 0.06f * torsoFactor;

            // Mode 3: Gender Dimorphic Transition (PC3: +Female, -Male)
            size_t m3 = (3 * vCount + i) * 3;
            float breastFactor = (p.y > 1.25f * s && p.y < 1.42f * s && p.z > 0.01f * s) ? 0.045f : 0.0f;
            float pelvicFactor = (p.y > 0.75f * s && p.y < 1.02f * s) ? 0.035f : 0.0f;
            float waistNarrow = (p.y > 1.05f * s && p.y < 1.22f * s) ? -0.025f : 0.0f;
            model.shapeDirs[m3 + 0] = p.x * (pelvicFactor + waistNarrow);
            model.shapeDirs[m3 + 1] = 0.0f;
            model.shapeDirs[m3 + 2] = breastFactor;

            // Mode 4: Torso vs Leg Proportion (PC4)
            size_t m4 = (4 * vCount + i) * 3;
            if (p.y < 0.90f * s) {
                model.shapeDirs[m4 + 1] = 0.04f * s; // Leg elongation
            } else {
                model.shapeDirs[m4 + 1] = -0.03f * s; // Torso compression
            }

            // Mode 5: Biacromial Shoulder Width (PC5)
            size_t m5 = (5 * vCount + i) * 3;
            if (p.y > 1.20f * s && std::abs(p.x) > 0.12f * s) {
                model.shapeDirs[m5 + 0] = (p.x > 0 ? 0.035f : -0.035f) * s;
            }

            // Mode 6: Pelvic Breadth & Gluteal Curvature (PC6)
            size_t m6 = (6 * vCount + i) * 3;
            if (p.y > 0.70f * s && p.y < 1.05f * s) {
                model.shapeDirs[m6 + 0] = (p.x > 0 ? 0.030f : -0.030f) * s;
                if (p.z < 0.0f) {
                    model.shapeDirs[m6 + 2] = -0.035f * s; // Gluteal fullness
                }
            }

            // Mode 7: Cranial / Head Scaling (PC7)
            size_t m7 = (7 * vCount + i) * 3;
            if (p.y > 1.55f * s) {
                model.shapeDirs[m7 + 0] = p.x * 0.06f;
                model.shapeDirs[m7 + 1] = (p.y - 1.68f * s) * 0.06f;
                model.shapeDirs[m7 + 2] = (p.z - 0.02f * s) * 0.06f;
            }
        }

        // Generate pose-space corrective blendshapes for elbows and knees to prevent volume loss
        model.numPoseCorrectives = 54;
        model.poseDirs.resize(54 * 9 * vCount * 3, 0.0f);

        int32_t lElb = static_cast<int32_t>(kinematics::Canonical55Joint::LeftElbow);
        int32_t rElb = static_cast<int32_t>(kinematics::Canonical55Joint::RightElbow);
        int32_t lKnee = static_cast<int32_t>(kinematics::Canonical55Joint::LeftKnee);
        int32_t rKnee = static_cast<int32_t>(kinematics::Canonical55Joint::RightKnee);

        for (size_t i = 0; i < vCount; ++i) {
            const auto& p = model.templateMesh.vertices[i].position;
            // Left elbow bicep expansion on flexion
            if (lElb > 0 && (lElb - 1) < 54 && p.x > 0.35f && p.x < 0.60f && p.y > 1.30f && p.y < 1.50f) {
                size_t pIdx = (((lElb - 1) * 9 + 0) * vCount + i) * 3;
                model.poseDirs[pIdx + 1] += 0.025f;
                model.poseDirs[pIdx + 2] += 0.015f;
            }
            // Right elbow bicep expansion
            if (rElb > 0 && (rElb - 1) < 54 && p.x < -0.35f && p.x > -0.60f && p.y > 1.30f && p.y < 1.50f) {
                size_t pIdx = (((rElb - 1) * 9 + 0) * vCount + i) * 3;
                model.poseDirs[pIdx + 1] += 0.025f;
                model.poseDirs[pIdx + 2] += 0.015f;
            }
            // Left knee patella stabilization
            if (lKnee > 0 && (lKnee - 1) < 54 && std::abs(p.x - 0.11f) < 0.08f && std::abs(p.y - 0.50f) < 0.10f) {
                size_t pIdx = (((lKnee - 1) * 9 + 0) * vCount + i) * 3;
                model.poseDirs[pIdx + 2] += 0.020f;
            }
            // Right knee patella stabilization
            if (rKnee > 0 && (rKnee - 1) < 54 && std::abs(p.x + 0.11f) < 0.08f && std::abs(p.y - 0.50f) < 0.10f) {
                size_t pIdx = (((rKnee - 1) * 9 + 0) * vCount + i) * 3;
                model.poseDirs[pIdx + 2] += 0.020f;
            }
        }

        return model;
    }

    /**
     * Loads the canonical scan-grounded standard .sbhuman model (10,475 vertices, 20,908 triangles),
     * scaling to target height if specified. Falls back cleanly to createProceduralAnatomical if binary assets are absent.
     */
    static SbHumanModel loadStandardModel(
        skinning::GenderMorph gender = skinning::GenderMorph::Neutral,
        float targetHeight = 1.72f
    ) {
        std::string filename;
        switch (gender) {
            case skinning::GenderMorph::Male:   filename = "sbhuman_male.sbhuman"; break;
            case skinning::GenderMorph::Female: filename = "sbhuman_female.sbhuman"; break;
            case skinning::GenderMorph::Neutral:
            default:                            filename = "sbhuman_neutral.sbhuman"; break;
        }

        std::vector<std::string> searchPaths;
        const char* envDir = std::getenv("SCRATCHBOX_HUMAN_ASSETS_DIR");
        if (envDir && strlen(envDir) > 0) {
            searchPaths.push_back(std::string(envDir) + "/" + filename);
        }
        searchPaths.push_back("packages/core/assets/models/" + filename);
        searchPaths.push_back("public/models/" + filename);
        searchPaths.push_back("../packages/core/assets/models/" + filename);
        searchPaths.push_back("../../packages/core/assets/models/" + filename);
        searchPaths.push_back("../../../packages/core/assets/models/" + filename);
        searchPaths.push_back("/Users/eligreen/dev/scratchbox-ide-master/packages/core/assets/models/" + filename);

        for (const auto& path : searchPaths) {
            std::ifstream test(path, std::ios::binary);
            if (test.good()) {
                test.close();
                SbHumanModel model;
                if (model.loadFromFile(path)) {
                    // Height adjustment if target differs from template height
                    float curHeight = model.templateMesh.bounds.max.y - model.templateMesh.bounds.min.y;
                    if (targetHeight > 0.1f && curHeight > 0.1f && std::abs(curHeight - targetHeight) > 0.01f) {
                        float scale = targetHeight / curHeight;
                        for (auto& v : model.templateMesh.vertices) {
                            v.position.x *= scale;
                            v.position.y *= scale;
                            v.position.z *= scale;
                        }
                        for (auto& j : model.skeleton.joints) {
                            j.restPosition.x *= scale;
                            j.restPosition.y *= scale;
                            j.restPosition.z *= scale;
                        }
                        model.skeleton.updateTransforms();
                        model.templateMesh.recomputeBounds();
                    }
                    initializeFacialLandmarks(model);
                    return model;
                }
            }
        }

        // Resilient fallback to procedural generator
        return createProceduralAnatomical(targetHeight, gender);
    }

    /**
     * Canonical Scan-Grounded Standards for Male, Female, and Neutral archetypes
     */
    static SbHumanModel createMale(float height = 1.80f) {
        return loadStandardModel(skinning::GenderMorph::Male, height);
    }

    static SbHumanModel createFemale(float height = 1.66f) {
        return loadStandardModel(skinning::GenderMorph::Female, height);
    }

    static SbHumanModel createNeutral(float height = 1.72f) {
        return loadStandardModel(skinning::GenderMorph::Neutral, height);
    }
};

} // namespace parametric
} // namespace scratchbox

#endif // SCRATCHBOX_PARAMETRIC_HUMAN_HPP
