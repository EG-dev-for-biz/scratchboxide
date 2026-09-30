/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_4DGS_HUMANOID_HPP
#define SCRATCHBOX_4DGS_HUMANOID_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include <vector>
#include <array>
#include <string>
#include <cmath>
#include <algorithm>
#include <fstream>
#include <sstream>
#include <iostream>
#include <cstring>

namespace scratchbox {
namespace four_d_anyone {

/**
 * Single 3D Gaussian Primitive representation.
 */
struct Gaussian {
    math::Vec3 position{0.0f, 0.0f, 0.0f};
    math::Vec3 normal{0.0f, 1.0f, 0.0f};
    math::Vec3 scale{0.01f, 0.01f, 0.01f};
    math::Quat rotation{0.0f, 0.0f, 0.0f, 1.0f}; // (x, y, z, w)
    math::Vec3 color{1.0f, 1.0f, 1.0f};          // RGB [0.0 - 1.0]
    float opacity{1.0f};                         // [0.0 - 1.0]

    // 4-Bone Influence Skin Weights for LBS deformation
    std::array<uint16_t, 4> boneIndices{0, 0, 0, 0};
    std::array<float, 4> boneWeights{1.0f, 0.0f, 0.0f, 0.0f};
};

/**
 * 22 Canonical SMPL-X / SB-Human Joint Hierarchy
 */
inline const std::vector<std::string> CANONICAL_22_JOINT_NAMES = {
    "pelvis",         // 0
    "left_hip",       // 1
    "right_hip",      // 2
    "spine1",         // 3
    "left_knee",      // 4
    "right_knee",     // 5
    "spine2",         // 6
    "left_ankle",     // 7
    "right_ankle",    // 8
    "spine3",         // 9
    "left_foot",      // 10
    "right_foot",     // 11
    "neck",           // 12
    "left_collar",    // 13
    "right_collar",   // 14
    "head",           // 15
    "left_shoulder",  // 16
    "right_shoulder", // 17
    "left_elbow",     // 18
    "right_elbow",    // 19
    "left_wrist",     // 20
    "right_wrist"     // 21
};

inline const std::vector<int32_t> CANONICAL_22_KINTREE_PARENTS = {
    -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19
};

/**
 * 4D Anyone Gaussian Splatting Dynamic Humanoid Avatar.
 */
class FourDHumanoidAvatar {
public:
    std::vector<Gaussian> restGaussians;
    std::vector<math::Vec3> canonicalJoints;
    std::vector<int32_t> kintreeParents;
    std::vector<std::string> jointNames;

    FourDHumanoidAvatar()
        : kintreeParents(CANONICAL_22_KINTREE_PARENTS),
          jointNames(CANONICAL_22_JOINT_NAMES) {
        initDefaultCanonicalJoints();
    }

    /**
     * Initializes standard canonical rest joint positions (metric meters).
     */
    void initDefaultCanonicalJoints() {
        canonicalJoints.resize(22);
        // Pelvis
        canonicalJoints[0] = math::Vec3(0.0031f, 0.9353f, 0.0400f);
        // Left / Right Hip
        canonicalJoints[1] = math::Vec3(0.0613f, 0.8426f, -0.0140f);
        canonicalJoints[2] = math::Vec3(-0.0601f, 0.8415f, -0.0140f);
        // Spine 1
        canonicalJoints[3] = math::Vec3(0.0028f, 1.0253f, 0.0245f);
        // Left / Right Knee
        canonicalJoints[4] = math::Vec3(0.0898f, 0.4682f, -0.0050f);
        canonicalJoints[5] = math::Vec3(-0.0892f, 0.4685f, -0.0050f);
        // Spine 2
        canonicalJoints[6] = math::Vec3(0.0035f, 1.1553f, 0.0125f);
        // Left / Right Ankle
        canonicalJoints[7] = math::Vec3(0.0712f, 0.0782f, -0.0520f);
        canonicalJoints[8] = math::Vec3(-0.0715f, 0.0780f, -0.0520f);
        // Spine 3
        canonicalJoints[9] = math::Vec3(0.0038f, 1.2453f, 0.0045f);
        // Left / Right Foot
        canonicalJoints[10] = math::Vec3(0.0815f, 0.0250f, 0.0980f);
        canonicalJoints[11] = math::Vec3(-0.0812f, 0.0250f, 0.0980f);
        // Neck
        canonicalJoints[12] = math::Vec3(0.0040f, 1.3453f, -0.0247f);
        // Left / Right Collar
        canonicalJoints[13] = math::Vec3(0.0448f, 1.3143f, -0.0003f);
        canonicalJoints[14] = math::Vec3(-0.0492f, 1.3137f, -0.0065f);
        // Head
        canonicalJoints[15] = math::Vec3(0.0111f, 1.5549f, -0.0040f);
        // Left / Right Shoulder
        canonicalJoints[16] = math::Vec3(0.1641f, 1.3720f, -0.0158f);
        canonicalJoints[17] = math::Vec3(-0.1518f, 1.3672f, -0.0191f);
        // Left / Right Elbow
        canonicalJoints[18] = math::Vec3(0.4182f, 1.2998f, -0.0582f);
        canonicalJoints[19] = math::Vec3(-0.4229f, 1.3307f, -0.0456f);
        // Left / Right Wrist
        canonicalJoints[20] = math::Vec3(0.6702f, 1.3231f, -0.0607f);
        canonicalJoints[21] = math::Vec3(-0.6722f, 1.3262f, -0.0609f);
    }

    /**
     * Computes distance from a 3D point to a line segment [a, b].
     */
    static float distanceToSegment(const math::Vec3& p, const math::Vec3& a, const math::Vec3& b) {
        math::Vec3 ab = b - a;
        float lenSq = ab.lengthSquared();
        if (lenSq < 1e-8f) {
            return (p - a).length();
        }
        float t = std::clamp((p - a).dot(ab) / lenSq, 0.0f, 1.0f);
        math::Vec3 projection = a + ab * t;
        return (p - projection).length();
    }

    /**
     * Automatically binds canonical Gaussians to skeletal bones via geodesic/proximity distance.
     */
    void computeSkinWeights(float radiusFalloff = 0.22f) {
        if (canonicalJoints.empty() || restGaussians.empty()) return;

        const size_t numJoints = canonicalJoints.size();
        const float invTwoSigmaSq = 1.0f / (2.0f * radiusFalloff * radiusFalloff);

        for (auto& g : restGaussians) {
            struct JointDist {
                uint16_t index;
                float dist;
                float weight;
            };

            std::vector<JointDist> candidates(numJoints);
            for (uint16_t j = 0; j < numJoints; ++j) {
                candidates[j].index = j;
                int32_t pIdx = (j < kintreeParents.size()) ? kintreeParents[j] : -1;
                if (pIdx >= 0 && pIdx < static_cast<int32_t>(numJoints)) {
                    candidates[j].dist = distanceToSegment(g.position, canonicalJoints[pIdx], canonicalJoints[j]);
                } else {
                    candidates[j].dist = (g.position - canonicalJoints[j]).length();
                }
                candidates[j].weight = std::exp(-candidates[j].dist * candidates[j].dist * invTwoSigmaSq);
            }

            // Sort by descending weight (closest first)
            std::partial_sort(candidates.begin(), candidates.begin() + 4, candidates.end(),
                [](const JointDist& a, const JointDist& b) {
                    return a.dist < b.dist;
                });

            float sumWeight = 0.0f;
            for (int k = 0; k < 4; ++k) {
                g.boneIndices[k] = candidates[k].index;
                g.boneWeights[k] = candidates[k].weight;
                sumWeight += candidates[k].weight;
            }

            if (sumWeight > 1e-6f) {
                float invSum = 1.0f / sumWeight;
                for (int k = 0; k < 4; ++k) {
                    g.boneWeights[k] *= invSum;
                }
            } else {
                g.boneWeights[0] = 1.0f;
                g.boneWeights[1] = g.boneWeights[2] = g.boneWeights[3] = 0.0f;
            }
        }
    }

    /**
     * Computes joint transform matrices given posed 3D joint positions and root transform.
     */
    std::vector<math::Mat4> computeJointTransforms(
        const std::vector<math::Vec3>& posedJoints,
        const math::Vec3& rootTranslation = math::Vec3(0, 0, 0),
        const math::Quat& rootRotation = math::Quat::identity()
    ) const {
        const size_t numJoints = std::min(canonicalJoints.size(), posedJoints.size());
        std::vector<math::Mat4> transforms(numJoints, math::Mat4::identity());

        math::Mat4 rootMat = math::Mat4::translation(rootTranslation);

        for (size_t j = 0; j < numJoints; ++j) {
            math::Vec3 cPos = canonicalJoints[j];
            math::Vec3 pPos = posedJoints[j];

            int32_t pIdx = (j < kintreeParents.size()) ? kintreeParents[j] : -1;
            math::Quat jointRot = rootRotation;

            if (pIdx >= 0 && pIdx < static_cast<int32_t>(numJoints)) {
                math::Vec3 cBone = (canonicalJoints[j] - canonicalJoints[pIdx]);
                math::Vec3 pBone = (posedJoints[j] - posedJoints[pIdx]);
                if (cBone.lengthSquared() > 1e-6f && pBone.lengthSquared() > 1e-6f) {
                    math::Vec3 u = cBone.normalized();
                    math::Vec3 v = pBone.normalized();
                    float dot = std::clamp(u.dot(v), -1.0f, 1.0f);
                    if (dot > 0.9999f) {
                        jointRot = rootRotation;
                    } else if (dot < -0.9999f) {
                        math::Vec3 axis = u.cross(math::Vec3(1, 0, 0));
                        if (axis.lengthSquared() < 1e-4f) axis = u.cross(math::Vec3(0, 1, 0));
                        jointRot = rootRotation * math::Quat::fromAxisAngle(axis.normalized(), math::PI);
                    } else {
                        math::Vec3 axis = u.cross(v);
                        float angle = std::acos(dot);
                        jointRot = rootRotation * math::Quat::fromAxisAngle(axis.normalized(), angle);
                    }
                }
            }

            // T_j = Translation(pPos) * Rotation(jointRot) * Translation(-cPos)
            math::Mat4 rotMat = math::Mat4::identity();
            math::Mat3 r3 = math::Mat3::fromQuat(jointRot);
            rotMat.m[0] = r3.m[0]; rotMat.m[4] = r3.m[1]; rotMat.m[8]  = r3.m[2];
            rotMat.m[1] = r3.m[3]; rotMat.m[5] = r3.m[4]; rotMat.m[9]  = r3.m[5];
            rotMat.m[2] = r3.m[6]; rotMat.m[6] = r3.m[7]; rotMat.m[10] = r3.m[8];

            math::Mat4 toOrigin = math::Mat4::translation(math::Vec3(-cPos.x, -cPos.y, -cPos.z));
            math::Mat4 toPosed  = math::Mat4::translation(pPos);

            transforms[j] = toPosed * rotMat * toOrigin;
        }

        return transforms;
    }

    /**
     * Evaluates Linear Blend Skinning (LBS) on all Gaussians using bone matrices.
     */
    std::vector<Gaussian> deformWithJointTransforms(
        const std::vector<math::Mat4>& skinTransforms
    ) const {
        std::vector<Gaussian> posedGaussians;
        posedGaussians.resize(restGaussians.size());

        const size_t numSplats = restGaussians.size();
        const size_t numTransforms = skinTransforms.size();

        for (size_t i = 0; i < numSplats; ++i) {
            const auto& rg = restGaussians[i];
            auto& pg = posedGaussians[i];

            pg = rg; // Copy base attributes (scale, opacity, color)

            if (numTransforms == 0) continue;

            math::Vec3 posedPos(0.0f, 0.0f, 0.0f);
            math::Vec3 posedNorm(0.0f, 0.0f, 0.0f);
            float qx = 0.0f, qy = 0.0f, qz = 0.0f, qw = 0.0f;

            for (int k = 0; k < 4; ++k) {
                float w = rg.boneWeights[k];
                if (w <= 1e-5f) continue;

                uint16_t bIdx = rg.boneIndices[k];
                if (bIdx < numTransforms) {
                    const auto& G = skinTransforms[bIdx];
                    posedPos += G.transformPoint(rg.position) * w;
                    posedNorm += G.transformDirection(rg.normal) * w;

                    // Deformed rotation quaternion approximation
                    qx += rg.rotation.x * w;
                    qy += rg.rotation.y * w;
                    qz += rg.rotation.z * w;
                    qw += rg.rotation.w * w;
                }
            }

            pg.position = posedPos;
            pg.normal = posedNorm.normalized();

            float qLen = std::sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            if (qLen > 1e-6f) {
                float inv = 1.0f / qLen;
                pg.rotation = math::Quat(qx * inv, qy * inv, qz * inv, qw * inv);
            }
        }

        return posedGaussians;
    }

    /**
     * Deforms Gaussians given posed joints directly.
     */
    std::vector<Gaussian> deform(
        const std::vector<math::Vec3>& posedJoints,
        const math::Vec3& rootTranslation = math::Vec3(0, 0, 0),
        const math::Quat& rootRotation = math::Quat::identity()
    ) const {
        auto transforms = computeJointTransforms(posedJoints, rootTranslation, rootRotation);
        return deformWithJointTransforms(transforms);
    }

    /**
     * Serializes a vector of Gaussian splats into the standard 32-byte .splat binary format.
     */
    static std::vector<uint8_t> serializeSplatBuffer(const std::vector<Gaussian>& splats) {
        constexpr size_t BYTES_PER_SPLAT = 32;
        std::vector<uint8_t> buffer(splats.size() * BYTES_PER_SPLAT);
        uint8_t* ptr = buffer.data();

        for (const auto& s : splats) {
            // Position: 3 x float32 (12 bytes)
            std::memcpy(ptr, &s.position.x, 4); ptr += 4;
            std::memcpy(ptr, &s.position.y, 4); ptr += 4;
            std::memcpy(ptr, &s.position.z, 4); ptr += 4;

            // Scale: 3 x float32 (12 bytes)
            std::memcpy(ptr, &s.scale.x, 4); ptr += 4;
            std::memcpy(ptr, &s.scale.y, 4); ptr += 4;
            std::memcpy(ptr, &s.scale.z, 4); ptr += 4;

            // RGBA: 4 x uint8 (4 bytes)
            uint8_t r = static_cast<uint8_t>(std::clamp(s.color.x * 255.0f, 0.0f, 255.0f));
            uint8_t g = static_cast<uint8_t>(std::clamp(s.color.y * 255.0f, 0.0f, 255.0f));
            uint8_t b = static_cast<uint8_t>(std::clamp(s.color.z * 255.0f, 0.0f, 255.0f));
            uint8_t a = static_cast<uint8_t>(std::clamp(s.opacity * 255.0f, 0.0f, 255.0f));
            *ptr++ = r; *ptr++ = g; *ptr++ = b; *ptr++ = a;

            // Quantized Quaternion: 4 x uint8 (4 bytes) -> (q * 0.5 + 0.5) * 255
            uint8_t qx = static_cast<uint8_t>(std::clamp((s.rotation.x * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            uint8_t qy = static_cast<uint8_t>(std::clamp((s.rotation.y * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            uint8_t qz = static_cast<uint8_t>(std::clamp((s.rotation.z * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            uint8_t qw = static_cast<uint8_t>(std::clamp((s.rotation.w * 0.5f + 0.5f) * 255.0f, 0.0f, 255.0f));
            *ptr++ = qx; *ptr++ = qy; *ptr++ = qz; *ptr++ = qw;
        }

        return buffer;
    }

    /**
     * Parses ASCII 3DGS PLY (e.g. human_4dgs.ply), mirroring common/gaussian-ply-codec.ts: the
     * "scratchbox_encoding" comment selects SH-DC vs RGB colour and w-first vs x-first quaternions;
     * files without it are legacy RGB + w-first, or SH + x-first when they carry a joint_id column.
     */
    bool parsePly(const std::string& plyContent) {
        std::istringstream stream(plyContent);
        std::string line;
        bool inHeader = true;
        size_t vertexCount = 0;
        bool hasEncodingComment = false;
        bool shColor = false;
        bool quatWFirst = true;
        bool hasJointId = false;
        constexpr float kShC0 = 0.28209479177387814f;

        while (std::getline(stream, line)) {
            if (line.empty() || line[0] == '\r') continue;

            if (inHeader) {
                if (line.rfind("comment scratchbox_encoding", 0) == 0) {
                    hasEncodingComment = true;
                    shColor = line.find("color=rgb") == std::string::npos;
                    quatWFirst = line.find("quat=xyzw") == std::string::npos;
                } else if (line.rfind("property", 0) == 0 && line.find(" joint_id") != std::string::npos) {
                    hasJointId = true;
                } else if (line.rfind("element vertex", 0) == 0) {
                    std::istringstream ss(line);
                    std::string elem, vert;
                    ss >> elem >> vert >> vertexCount;
                } else if (line == "end_header" || line == "end_header\r") {
                    inHeader = false;
                    if (!hasEncodingComment && hasJointId) {
                        shColor = true;
                        quatWFirst = false;
                    }
                    restGaussians.reserve(vertexCount > 0 ? vertexCount : 1000);
                }
                continue;
            }

            // Parse vertex line: x y z nx ny nz f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3
            std::istringstream ss(line);
            Gaussian g;
            float opacityLogit = 0.0f;
            float scale0 = 0.0f, scale1 = 0.0f, scale2 = 0.0f;
            float rot0 = 0.0f, rot1 = 0.0f, rot2 = 0.0f, rot3 = 1.0f;

            if (ss >> g.position.x >> g.position.y >> g.position.z >>
                g.normal.x >> g.normal.y >> g.normal.z >>
                g.color.x >> g.color.y >> g.color.z >>
                opacityLogit >>
                scale0 >> scale1 >> scale2 >>
                rot0 >> rot1 >> rot2 >> rot3) {

                if (shColor) {
                    g.color = math::Vec3(
                        std::clamp(0.5f + kShC0 * g.color.x, 0.0f, 1.0f),
                        std::clamp(0.5f + kShC0 * g.color.y, 0.0f, 1.0f),
                        std::clamp(0.5f + kShC0 * g.color.z, 0.0f, 1.0f));
                }

                // Opacity sigmoid
                g.opacity = 1.0f / (1.0f + std::exp(-std::clamp(opacityLogit, -20.0f, 20.0f)));

                // Scale exponential
                g.scale = math::Vec3(std::exp(scale0), std::exp(scale1), std::exp(scale2));

                // Rotation quaternion normalization
                math::Quat q = quatWFirst ? math::Quat(rot1, rot2, rot3, rot0) : math::Quat(rot0, rot1, rot2, rot3);
                g.rotation = q.normalized();

                restGaussians.push_back(g);
            }
        }

        computeSkinWeights();
        return !restGaussians.empty();
    }
};

} // namespace four_d_anyone
} // namespace scratchbox

#endif // SCRATCHBOX_4DGS_HUMANOID_HPP
